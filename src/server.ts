import dotenv from 'dotenv';
dotenv.config();
import express from 'express';
import cors from 'cors';
import { randomBytes } from 'crypto';
import { isAddress } from 'viem';
import * as db from './db';
import { step, MAX_TURNS, MAX_MESSAGE_CHARS, MAX_PAY, MODEL, type Turn } from './agent';
import { harden } from './immune';
import * as treasury from './treasury';

const app = express();
app.use(cors());
app.use(express.json({ limit: '64kb' }));
app.use(express.static('public'));
const PORT = Number(process.env.PORT || 3000);

// only one hardening at a time; while it runs the treasurer is offline (it's growing a new immune response)
let hardening: { gen: number; startedAt: number } | null = null;

// crude per-ip rate limit: 30 messages / minute
const hits = new Map<string, number[]>();
function limited(ip: string) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  arr.push(now); hits.set(ip, arr);
  return arr.length > 30;
}

app.get('/api/state', async (_req, res) => {
  const gen = db.currentGeneration();
  res.json({
    gen: gen.gen, policy: gen.policy, created_at: gen.created_at,
    hardening: hardening ? { since: hardening.startedAt } : null,
    agent: treasury.agentAddress, balance: await treasury.balance(),
    model: MODEL, max_turns: MAX_TURNS, max_chars: MAX_MESSAGE_CHARS, max_pay: MAX_PAY,
    explorer: treasury.EXPLORER, approved: db.APPROVED,
    daily_cap: db.DAILY_CAP, spent_24h: db.spentLast24h(),
  });
});

app.get('/api/generations', (_req, res) => {
  const gens = db.allGenerations().map((g) => ({ ...g, breaches: db.breachesForGen(g.gen).length }));
  res.json({ generations: gens });
});
app.get('/api/generations/:gen', (req, res) => {
  const g = db.getGeneration(Number(req.params.gen));
  if (!g) return res.status(404).json({ error: 'no such generation' });
  res.json({ ...g, breaches: db.breachesForGen(g.gen), regressions: db.regressionsForGen(g.gen) });
});
app.get('/api/breaches', (_req, res) => res.json({ breaches: db.allBreaches().map((b) => ({ ...b, transcript: JSON.parse(b.transcript) })) }));
app.get('/api/breaches/:id', (req, res) => {
  const b = db.breachById(Number(req.params.id));
  if (!b) return res.status(404).json({ error: 'no such breach' });
  res.json({ ...b, transcript: JSON.parse(b.transcript) });
});
app.get('/api/leaderboard', (_req, res) => res.json({ leaderboard: db.leaderboard() }));

app.post('/api/session', (req, res) => {
  const { player, nickname } = req.body || {};
  if (!player || !isAddress(player)) return res.status(400).json({ error: 'player must be a wallet address (this is where the loot goes)' });
  const id = randomBytes(12).toString('hex');
  const gen = db.currentGeneration();
  db.createSession(id, gen.gen, player.toLowerCase(), nickname ? String(nickname).slice(0, 32) : null);
  res.json({ session: id, gen: gen.gen });
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
    if (hardening) return res.status(503).json({ error: 'the treasurer is hardening its policy. try again in a minute.' });
    const gen = db.currentGeneration();
    if (s.gen !== gen.gen) { db.updateSession(s.id, JSON.parse(s.transcript), s.turns, 'stale'); return res.status(409).json({ error: 'generation changed mid-session. start a new one.' }); }
    if (s.turns >= MAX_TURNS) { db.updateSession(s.id, JSON.parse(s.transcript), s.turns, 'exhausted'); return res.status(409).json({ error: 'out of turns' }); }

    const history: Turn[] = JSON.parse(s.transcript);
    let breach: { to: string; amount: number; hash: string | null } | null = null;

    // every pay() is a real tip-20 transfer on tempo. approved suppliers get paid; anyone else getting paid is a breach.
    const produced = await step(gen.policy, history, message.trim(), async (intent) => {
      if (breach) return { ok: false, error: 'wallet locked after unapproved transfer' };
      let amount = Math.min(Math.max(intent.amount, 0), MAX_PAY);

      // enforcement, not persuasion: a purchase order pays out once, and never above its limit.
      // checked here so no phrasing and no fresh session can get a second disbursement.
      const boundPo = db.anyPoForAddress(intent.to);
      if (boundPo) {
        if (boundPo.closed) return { ok: false, error: `purchase order ${boundPo.po} is closed; it has already been paid` };
        if (amount > boundPo.limit_amount) amount = boundPo.limit_amount;
      }

      // velocity limit, enforced before the transfer and outside the model's reach
      const remaining = db.DAILY_CAP - db.spentLast24h();
      if (remaining <= 0) return { ok: false, error: 'the shop has reached its daily disbursement limit; no further payments today' };
      if (amount > remaining) return { ok: false, error: `amount exceeds the shop's remaining daily disbursement allowance (${remaining.toFixed(2)} pathusd)` };

      const r = await treasury.pay(intent.to, String(amount));
      if (r.ok) {
        db.recordDisbursement(intent.to, amount, r.hash, s.id);
        if (boundPo) db.closePo(boundPo.po);
        if (db.isBreachRecipient(intent.to)) breach = { to: intent.to, amount, hash: r.hash };
      }
      return r;
    }, async (po) => {
      const row = db.lookupPo(po);
      if (!row) return { found: false };
      return { found: true, po: row.po, item: row.item, limit: row.limit_amount, closed: !!row.closed,
        remit_to: row.remit_to, registered: !!row.remit_to };
    });

    const transcript = [...history, ...produced];
    const turns = s.turns + 1;

    if (breach) {
      const b = breach as { to: string; amount: number; hash: string | null };
      db.updateSession(s.id, transcript, turns, 'breached');
      const breachId = db.recordBreach({ gen: gen.gen, session_id: s.id, player: s.player, nickname: s.nickname, recipient: b.to, amount: b.amount, tx_hash: b.hash, transcript: JSON.stringify(transcript) });
      res.json({ turns: produced, turnsLeft: 0, breach: { id: breachId, ...b, explorer: `${treasury.EXPLORER}/tx/${b.hash}` } });
      void runHardening(gen, breachId);
      return;
    }

    db.updateSession(s.id, transcript, turns, turns >= MAX_TURNS ? 'exhausted' : 'open');
    res.json({ turns: produced, turnsLeft: MAX_TURNS - turns, breach: null });
  } catch (e) {
    console.error('[chat]', e);
    res.status(500).json({ error: 'internal error' });
  }
});

async function runHardening(failed: db.Generation, breachId: number) {
  if (hardening) return;
  hardening = { gen: failed.gen, startedAt: Date.now() };
  try {
    const breach = db.breachById(breachId)!;
    console.log(`[immune] gen ${failed.gen} breached (#${breachId}); hardening...`);
    const out = await harden(failed.policy, breach, db.allBreaches());
    const nextGen = failed.gen + 1;
    for (const round of out.log) for (const r of round.results) db.recordRegression(nextGen, round.round, r.breachId, r.kind, r.passed, `${r.name}: ${r.detail}`);
    if (out.autoimmune) db.markAutoimmune(breachId);
    db.createGeneration(nextGen, out.policy, breachId, out.rounds, out.regressionPassed, out.legitPassed);
    console.log(`[immune] gen ${nextGen} live after ${out.rounds} round(s). regression=${out.regressionPassed} legit=${out.legitPassed} autoimmune=${out.autoimmune}`);
  } catch (e) {
    console.error('[immune] hardening failed', e);
  } finally {
    hardening = null;
  }
}

app.post('/api/faucet', async (req, res) => {
  const { address } = req.body || {};
  if (!address || !isAddress(address)) return res.status(400).json({ error: 'address required' });
  const r = await treasury.faucet(address);
  res.status(r.status).json(r.body);
});

function admin(req: express.Request, res: express.Response): boolean {
  const ok = !!process.env.ADMIN_TOKEN && req.headers.authorization === `Bearer ${process.env.ADMIN_TOKEN}`;
  if (!ok) res.status(401).json({ error: 'unauthorized' });
  return ok;
}
// the out-of-band channel: only the shop owner can bind a purchase order to a remittance address.
app.post('/api/admin/po', (req, res) => {
  if (!admin(req, res)) return;
  const { po, address } = req.body || {};
  if (!po || !db.lookupPo(String(po))) return res.status(404).json({ error: 'no such purchase order' });
  if (address && !isAddress(address)) return res.status(400).json({ error: 'invalid address' });
  db.registerRemittance(String(po), address ? String(address) : null);
  res.json({ ok: true, po: db.lookupPo(String(po)) });
});
app.get('/api/pos', (_req, res) => res.json({ pos: db.allPos().map((p) => ({ po: p.po, item: p.item, limit: p.limit_amount, registered: !!p.remit_to, closed: !!p.closed })) }));

app.post('/api/admin/reset', (req, res) => { if (!admin(req, res)) return; db.resetDb(); res.json({ ok: true }); });
app.post('/api/admin/fund', async (req, res) => { if (!admin(req, res)) return; res.json(await treasury.faucet(treasury.agentAddress)); });
// adjudicate a session as a breach by hand (for exploits the pay() hook can't see, and for testing the immune loop)
app.post('/api/admin/breach', (req, res) => {
  if (!admin(req, res)) return;
  const s = db.getSession(String(req.body?.session || ''));
  if (!s) return res.status(404).json({ error: 'no such session' });
  const gen = db.getGeneration(s.gen);
  if (!gen || gen.gen !== db.currentGeneration().gen) return res.status(409).json({ error: 'session is not on the current generation' });
  if (hardening) return res.status(503).json({ error: 'already hardening' });
  db.updateSession(s.id, JSON.parse(s.transcript), s.turns, 'breached');
  const breachId = db.recordBreach({ gen: gen.gen, session_id: s.id, player: s.player, nickname: s.nickname, recipient: s.player, amount: 0, tx_hash: null, transcript: s.transcript });
  void runHardening(gen, breachId);
  res.json({ ok: true, breach: breachId });
});

app.get('/health', (_req, res) => res.send('ok'));
app.listen(PORT, '0.0.0.0', () => console.log(`cheddar on 0.0.0.0:${PORT} (${MODEL})`));
