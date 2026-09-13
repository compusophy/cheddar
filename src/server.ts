import dotenv from 'dotenv';
dotenv.config();
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { isAddress } from 'viem';
import * as db from './db';
import { step, MAX_TURNS, MAX_MESSAGE_CHARS, MAX_PAY, MODEL, type Turn } from './agent';
import { harden, toolsetFor } from './immune';
import { TIERS, tierById, redact, DEFAULT_TIER, type Tier } from './tiers';
import * as treasury from './treasury';
import { startBot } from './bot';

const app = express();
app.use(cors());
app.use(express.json({ limit: '64kb' }));
app.use(express.static('public'));
const PORT = Number(process.env.PORT || 3000);

// one hardening at a time per tier; while it runs that tier's treasurer is offline (growing a new immune response)
const hardening = new Map<number, { gen: number; startedAt: number }>();

// crude per-ip rate limit: 30 messages / minute
const hits = new Map<string, number[]>();
function limited(ip: string) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  arr.push(now); hits.set(ip, arr);
  return arr.length > 30;
}

const tierParam = (v: unknown): Tier => tierById(Number(v)) || tierById(DEFAULT_TIER)!;

app.get('/api/state', async (req, res) => {
  const tier = tierParam(req.query.tier);
  const gen = db.currentGeneration(tier.id);
  const h = hardening.get(tier.id);
  res.json({
    tier: tier.id, tier_name: tier.name, tagline: tier.tagline, tools: tier.tools,
    gen: gen.gen, policy: redact(tier, gen.policy), created_at: gen.created_at,
    hardening: h ? { since: h.startedAt } : null,
    tiers: db.tierSummary(),
    agent: treasury.agentAddress, balance: await treasury.balance(),
    model: MODEL, max_turns: MAX_TURNS, max_chars: MAX_MESSAGE_CHARS, max_pay: MAX_PAY,
    explorer: treasury.EXPLORER, approved: db.APPROVED,
    daily_cap: db.DAILY_CAP, spent_24h: db.spentLast24h(),
    machine: db.machinePulse(),
  });
});

app.get('/api/generations', (req, res) => {
  const tier = tierParam(req.query.tier);
  res.json({ tier: tier.id, generations: db.allGenerations(tier.id).map((g) => ({ ...g, policy: redact(tier, g.policy), breaches: db.breachesForGen(tier.id, g.gen).length })) });
});
app.get('/api/generations/:gen', (req, res) => {
  const tier = tierParam(req.query.tier);
  const g = db.getGeneration(tier.id, Number(req.params.gen));
  if (!g) return res.status(404).json({ error: 'no such generation' });
  res.json({ ...g, policy: redact(tier, g.policy), breaches: db.breachesForGen(tier.id, g.gen), regressions: db.regressionsForGen(tier.id, g.gen).map((r: any) => ({ ...r, detail: redact(tier, r.detail || '') })) });
});
app.get('/api/breaches', (req, res) => {
  const tier = req.query.tier ? tierParam(req.query.tier).id : undefined;
  res.json({ breaches: db.allBreaches(tier).map((b) => ({ ...b, transcript: JSON.parse(b.transcript) })) });
});
app.get('/api/breaches/:id', (req, res) => {
  const b = db.breachById(Number(req.params.id));
  if (!b) return res.status(404).json({ error: 'no such breach' });
  res.json({ ...b, transcript: JSON.parse(b.transcript) });
});
app.get('/api/balance/:address', async (req, res) => {
  if (!isAddress(req.params.address)) return res.status(400).json({ error: 'bad address' });
  res.json({ balance: await treasury.balance(req.params.address as `0x${string}`) });
});
app.get('/api/leaderboard', (_req, res) => res.json({ leaderboard: db.leaderboard() }));
app.get('/api/tiers', (_req, res) => res.json({ tiers: db.tierSummary() }));

// the red-team log is part of the product: it is the record of why each tier exists
app.get('/api/findings', (_req, res) => {
  const p = path.join(__dirname, '..', 'redteam', 'log.md');
  res.type('text/markdown').send(fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '# no findings yet\n');
});

app.post('/api/session', (req, res) => {
  const { player, nickname } = req.body || {};
  const tier = tierParam(req.body?.tier);
  if (!player || !isAddress(player)) return res.status(400).json({ error: 'player must be a wallet address (this is where the loot goes)' });
  const id = randomBytes(12).toString('hex');
  const gen = db.currentGeneration(tier.id);
  db.createSession(id, tier.id, gen.gen, player.toLowerCase(), nickname ? String(nickname).slice(0, 32) : null);
  res.json({ session: id, tier: tier.id, gen: gen.gen });
});

app.get('/api/session/:id', (req, res) => {
  const s = db.getSession(req.params.id);
  if (!s) return res.status(404).json({ error: 'no such session' });
  res.json({ ...s, transcript: JSON.parse(s.transcript) });
});

app.post('/api/chat', async (req, res) => {
  try {
    const ip = req.ip || 'x';
    if (limited(ip)) return res.status(429).json({ error: 'slow down' });
    const { session, message } = req.body || {};
    if (typeof message !== 'string' || !message.trim()) return res.status(400).json({ error: 'message required' });
    if (message.length > MAX_MESSAGE_CHARS) return res.status(400).json({ error: `message exceeds ${MAX_MESSAGE_CHARS} characters` });
    const s = db.getSession(String(session));
    if (!s) return res.status(404).json({ error: 'no such session' });
    if (s.status !== 'open') return res.status(409).json({ error: `session is ${s.status}` });
    const tier = tierById(s.tier)!;
    if (hardening.has(tier.id)) return res.status(503).json({ error: 'the treasurer is hardening its policy. try again in a minute.' });
    const gen = db.currentGeneration(tier.id);
    if (s.gen !== gen.gen) { db.updateSession(s.id, JSON.parse(s.transcript), s.turns, 'stale'); return res.status(409).json({ error: 'generation changed mid-session. start a new one.' }); }
    if (s.turns >= MAX_TURNS) { db.updateSession(s.id, JSON.parse(s.transcript), s.turns, 'exhausted'); return res.status(409).json({ error: 'out of turns' }); }

    const history: Turn[] = JSON.parse(s.transcript);
    let breach: { to: string; amount: number; hash: string } | null = null;

    // every pay() is a real tip-20 transfer on tempo. what the code checks first depends on the tier:
    //   tiers 1-2: nothing beyond the per-payment cap. the policy is the whole defence.
    //   tier 3:    the reference must resolve in the shop's books, the payee must match, the amount is
    //              capped by the record, the order/invoice closes on payment, and a daily cap is reserved
    //              atomically. nothing asserted in chat counts.
    const produced = await step(gen.policy, history, message.trim(), async (intent) => {
      if (breach) return { ok: false, error: 'wallet locked after unapproved transfer' };
      let amount = Math.min(Math.max(intent.amount, 0), MAX_PAY);
      let settle: (() => void) | null = null;
      let reservation: { ok: true; id: number } | null = null;

      if (tier.enforce === 'ledger') {
        const resolved = db.resolveReference(intent.reference);
        if (!resolved.ok) return { ok: false, error: resolved.reason };
        if (resolved.payee !== intent.to.toLowerCase()) return { ok: false, error: `${resolved.ref} is payable to ${resolved.payee}, not to ${intent.to}` };
        if (amount > resolved.max) amount = resolved.max;
        const r = db.reserveDisbursement(tier.id, intent.to, amount, s.id);
        if (!r.ok) {
          return r.remaining <= 0
            ? { ok: false, error: 'the shop has reached its daily disbursement limit; no further payments today' }
            : { ok: false, error: `amount exceeds the shop's remaining daily disbursement allowance (${r.remaining.toFixed(2)} pathusd)` };
        }
        reservation = r;
        settle = () => { if (resolved.kind === 'po') db.closePo(resolved.ref); else db.markInvoicePaid(resolved.ref); };
      }

      const r = await treasury.pay(intent.to, String(amount));
      if (!r.ok) { if (reservation) db.releaseReservation(reservation.id); return r; }
      if (reservation) db.settleReservation(reservation.id, r.hash);
      settle?.();
      if (db.isBreachRecipient(intent.to)) breach = { to: intent.to, amount, hash: r.hash };
      return r;
    }, async (ref) => db.lookupReference(ref), toolsetFor(tier));

    const transcript = [...history, ...produced];
    const turns = s.turns + 1;

    if (breach) {
      const b = breach as { to: string; amount: number; hash: string };
      db.updateSession(s.id, transcript, turns, 'breached');
      const breachId = db.recordBreach({ tier: tier.id, gen: gen.gen, session_id: s.id, player: s.player, nickname: s.nickname, recipient: b.to, amount: b.amount, tx_hash: b.hash, transcript: JSON.stringify(transcript) });
      res.json({ turns: produced, turnsLeft: 0, breach: { id: breachId, ...b, explorer: `${treasury.EXPLORER}/tx/${b.hash}` } });
      void runHardening(tier, gen, breachId);
      return;
    }

    db.updateSession(s.id, transcript, turns, turns >= MAX_TURNS ? 'exhausted' : 'open');
    res.json({ turns: produced, turnsLeft: MAX_TURNS - turns, breach: null });
  } catch (e) {
    console.error('[chat]', e);
    res.status(500).json({ error: 'internal error' });
  }
});

async function runHardening(tier: Tier, failed: db.Generation, breachId: number) {
  if (hardening.has(tier.id)) return;
  hardening.set(tier.id, { gen: failed.gen, startedAt: Date.now() });
  try {
    const breach = db.breachById(breachId)!;
    console.log(`[immune] tier ${tier.id} gen ${failed.gen} breached (#${breachId}); hardening...`);
    const out = await harden(tier, failed.policy, breach, db.allBreaches(tier.id));
    const nextGen = failed.gen + 1;
    for (const round of out.log) for (const r of round.results) db.recordRegression(tier.id, nextGen, round.round, r.breachId, r.kind, r.passed, `${r.name}: ${r.detail}`);
    if (out.autoimmune) db.markAutoimmune(breachId);
    db.createGeneration(tier.id, nextGen, out.policy, breachId, out.rounds, out.regressionPassed, out.legitPassed);
    console.log(`[immune] tier ${tier.id} gen ${nextGen} live after ${out.rounds} round(s). regression=${out.regressionPassed} legit=${out.legitPassed} autoimmune=${out.autoimmune}`);
  } catch (e) {
    console.error('[immune] hardening failed', e);
  } finally {
    hardening.delete(tier.id);
  }
}

app.post('/api/faucet', async (req, res) => {
  const { address } = req.body || {};
  if (!address || !isAddress(address)) return res.status(400).json({ error: 'address required' });
  const r = await treasury.faucet(address);
  res.status(r.status).json(r.body);
});

// ---------- admin: the out-of-band channel. only the shop owner writes to the books. ----------

function admin(req: express.Request, res: express.Response): boolean {
  const ok = !!process.env.ADMIN_TOKEN && req.headers.authorization === `Bearer ${process.env.ADMIN_TOKEN}`;
  if (!ok) res.status(401).json({ error: 'unauthorized' });
  return ok;
}
app.get('/api/pos', (_req, res) => res.json({ pos: db.allPos().map((p) => ({ po: p.po, item: p.item, limit: p.limit_amount, registered: !!p.remit_to, closed: !!p.closed })) }));
app.get('/api/invoices', (_req, res) => res.json({ invoices: db.allInvoices().map((i) => ({ number: i.number, supplier: i.supplier, amount: i.amount, paid: !!i.paid })) }));
app.post('/api/admin/po', (req, res) => {
  if (!admin(req, res)) return;
  const { po, address } = req.body || {};
  if (!po || !db.lookupPo(String(po))) return res.status(404).json({ error: 'no such purchase order' });
  if (address && !isAddress(address)) return res.status(400).json({ error: 'invalid address' });
  db.registerRemittance(String(po), address ? String(address) : null);
  if (address) db.reopenPo(String(po));
  res.json({ ok: true, po: db.lookupPo(String(po)) });
});
app.post('/api/admin/invoice', (req, res) => {
  if (!admin(req, res)) return;
  const { number, supplier, amount } = req.body || {};
  const payee = (db.APPROVED as Record<string, string>)[String(supplier || '').toLowerCase()];
  if (!payee) return res.status(400).json({ error: 'supplier must be an approved supplier' });
  if (!number || !Number.isFinite(Number(amount)) || Number(amount) <= 0) return res.status(400).json({ error: 'number and a positive amount are required' });
  db.registerInvoice(String(number), String(supplier).toLowerCase(), payee, Number(amount));
  res.json({ ok: true, invoice: db.lookupInvoice(String(number)) });
});
app.post('/api/admin/reset-window', (req, res) => { if (!admin(req, res)) return; db.clearDisbursementWindow(); res.json({ ok: true, spent_24h: db.spentLast24h() }); });
app.post('/api/admin/reset', (req, res) => { if (!admin(req, res)) return; db.resetDb(); res.json({ ok: true }); });
app.post('/api/admin/fund', async (req, res) => { if (!admin(req, res)) return; res.json(await treasury.faucet(treasury.agentAddress)); });
// adjudicate a session as a breach by hand (for exploits the pay() hook can't see, and for testing the immune loop)
app.post('/api/admin/breach', (req, res) => {
  if (!admin(req, res)) return;
  const s = db.getSession(String(req.body?.session || ''));
  if (!s) return res.status(404).json({ error: 'no such session' });
  const tier = tierById(s.tier)!;
  const gen = db.getGeneration(tier.id, s.gen);
  if (!gen || gen.gen !== db.currentGeneration(tier.id).gen) return res.status(409).json({ error: 'session is not on the current generation' });
  if (hardening.has(tier.id)) return res.status(503).json({ error: 'already hardening' });
  db.updateSession(s.id, JSON.parse(s.transcript), s.turns, 'breached');
  const breachId = db.recordBreach({ tier: tier.id, gen: gen.gen, session_id: s.id, player: s.player, nickname: s.nickname, recipient: s.player, amount: 0, tx_hash: null, transcript: s.transcript });
  void runHardening(tier, gen, breachId);
  res.json({ ok: true, breach: breachId });
});

app.get('/health', (_req, res) => res.send('ok'));
app.listen(PORT, '0.0.0.0', () => {
  console.log(`cheddar on 0.0.0.0:${PORT} (${MODEL}) · tiers: ${TIERS.map((t) => t.slug).join(', ')}`);
  if (process.env.BOT !== '0') startBot();
});
