/** the http surface. no listen() here: vercel imports this as a function, local dev wraps it in server.ts. */
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { isAddress } from 'viem';
import * as db from './db';
import { MAX_TURNS, MAX_MESSAGE_CHARS, MAX_PAY, MODEL } from './agent';
import { openSession, runChat, adjudicate } from './chat';
import { tierById, redact, DEFAULT_TIER, type Tier } from './tiers';
import * as treasury from './treasury';
import * as bot from './bot';

/** keep a promise alive past the response on vercel; locally node keeps it alive anyway. */
let waitUntil: (p: Promise<unknown>) => void = (p) => { void p; };
try { waitUntil = require('@vercel/functions').waitUntil; } catch { /* not on vercel */ }
const keep = (p: Promise<unknown> | undefined | null) => { if (p) { try { waitUntil(p); } catch { void p; } } };

export const app = express();
app.use(cors());
app.use(express.json({ limit: '64kb' }));
app.use(async (_req, _res, next) => { try { await db.init(); next(); } catch (e) { next(e); } });

// crude per-instance rate limit: 30 messages / minute / ip
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
  const gen = await db.currentGeneration(tier.id);
  const since = await db.lockSince(`harden-${tier.id}`);
  res.json({
    tier: tier.id, tier_name: tier.name, tagline: tier.tagline, tools: tier.tools,
    gen: gen.gen, policy: redact(tier, gen.policy), created_at: gen.created_at,
    hardening: since ? { since } : null,
    tiers: await db.tierSummary(),
    agent: treasury.agentAddress, balance: await treasury.balance(),
    model: MODEL, max_turns: MAX_TURNS, max_chars: MAX_MESSAGE_CHARS, max_pay: MAX_PAY,
    explorer: treasury.EXPLORER, approved: db.APPROVED,
    daily_cap: db.DAILY_CAP, spent_24h: await db.spentLast24h(),
    machine: await db.machinePulse(),
  });
  // the machine wakes when someone looks, if it has been quiet a while
  keep(bot.maybeTick());
});

app.get('/api/generations', async (req, res) => {
  const tier = tierParam(req.query.tier);
  const gens = await db.allGenerations(tier.id);
  res.json({ tier: tier.id, generations: await Promise.all(gens.map(async (g) => ({ ...g, policy: redact(tier, g.policy), breaches: (await db.breachesForGen(tier.id, g.gen)).length }))) });
});
app.get('/api/generations/:gen', async (req, res) => {
  const tier = tierParam(req.query.tier);
  const g = await db.getGeneration(tier.id, Number(req.params.gen));
  if (!g) return res.status(404).json({ error: 'no such generation' });
  res.json({ ...g, policy: redact(tier, g.policy), breaches: await db.breachesForGen(tier.id, g.gen),
    regressions: (await db.regressionsForGen(tier.id, g.gen)).map((r: any) => ({ ...r, detail: redact(tier, r.detail || '') })) });
});
app.get('/api/breaches', async (req, res) => {
  const tier = req.query.tier ? tierParam(req.query.tier).id : undefined;
  res.json({ breaches: (await db.allBreaches(tier)).map((b) => ({ ...b, transcript: JSON.parse(b.transcript) })) });
});
app.get('/api/breaches/:id', async (req, res) => {
  const b = await db.breachById(Number(req.params.id));
  if (!b) return res.status(404).json({ error: 'no such breach' });
  res.json({ ...b, transcript: JSON.parse(b.transcript) });
});
app.get('/api/balance/:address', async (req, res) => {
  if (!isAddress(req.params.address)) return res.status(400).json({ error: 'bad address' });
  res.json({ balance: await treasury.balance(req.params.address as `0x${string}`) });
});
app.get('/api/leaderboard', async (_req, res) => res.json({ leaderboard: await db.leaderboard() }));
app.get('/api/tiers', async (_req, res) => res.json({ tiers: await db.tierSummary() }));

// the red-team log is part of the product: it is the record of why each tier exists
app.get('/api/findings', (_req, res) => {
  const p = path.join(process.cwd(), 'redteam', 'log.md');
  res.type('text/markdown').send(fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '# no findings yet\n');
});

app.post('/api/session', async (req, res) => {
  const { player, nickname } = req.body || {};
  const r = await openSession(tierParam(req.body?.tier), player, nickname);
  res.status(r.status).json(r.body);
});
app.get('/api/session/:id', async (req, res) => {
  const s = await db.getSession(req.params.id);
  if (!s) return res.status(404).json({ error: 'no such session' });
  res.json({ ...s, transcript: JSON.parse(s.transcript) });
});
app.post('/api/chat', async (req, res) => {
  try {
    if (limited(req.ip || 'x')) return res.status(429).json({ error: 'slow down' });
    const { session, message } = req.body || {};
    const r = await runChat(String(session), message);
    res.status(r.status).json(r.body);
    keep(r.hardening);
  } catch (e) {
    console.error('[chat]', e);
    res.status(500).json({ error: 'internal error' });
  }
});

// the machine's cron tick. vercel sends CRON_SECRET as a bearer if it is set.
app.get('/api/bot/tick', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ error: 'unauthorized' });
  const r = await bot.tick();
  res.json(r ? { tier: r.tier, won: r.won } : { disabled: true });
  keep(r?.hardening);
});

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
app.get('/api/pos', async (_req, res) => res.json({ pos: (await db.allPos()).map((p) => ({ po: p.po, item: p.item, limit: p.limit_amount, registered: !!p.remit_to, closed: !!p.closed })) }));
app.get('/api/invoices', async (_req, res) => res.json({ invoices: (await db.allInvoices()).map((i) => ({ number: i.number, supplier: i.supplier, amount: i.amount, paid: !!i.paid })) }));
app.post('/api/admin/po', async (req, res) => {
  if (!admin(req, res)) return;
  const { po, address } = req.body || {};
  if (!po || !(await db.lookupPo(String(po)))) return res.status(404).json({ error: 'no such purchase order' });
  if (address && !isAddress(address)) return res.status(400).json({ error: 'invalid address' });
  await db.registerRemittance(String(po), address ? String(address) : null);
  if (address) await db.reopenPo(String(po));
  res.json({ ok: true, po: await db.lookupPo(String(po)) });
});
app.post('/api/admin/invoice', async (req, res) => {
  if (!admin(req, res)) return;
  const { number, supplier, amount } = req.body || {};
  const payee = (db.APPROVED as Record<string, string>)[String(supplier || '').toLowerCase()];
  if (!payee) return res.status(400).json({ error: 'supplier must be an approved supplier' });
  if (!number || !Number.isFinite(Number(amount)) || Number(amount) <= 0) return res.status(400).json({ error: 'number and a positive amount are required' });
  await db.registerInvoice(String(number), String(supplier).toLowerCase(), payee, Number(amount));
  res.json({ ok: true, invoice: await db.lookupInvoice(String(number)) });
});
app.post('/api/admin/reset-window', async (req, res) => { if (!admin(req, res)) return; await db.clearDisbursementWindow(); res.json({ ok: true, spent_24h: await db.spentLast24h() }); });
app.post('/api/admin/reset', async (req, res) => { if (!admin(req, res)) return; await db.resetDb(); res.json({ ok: true }); });
app.post('/api/admin/fund', async (req, res) => { if (!admin(req, res)) return; res.json(await treasury.faucet(treasury.agentAddress)); });
app.post('/api/admin/breach', async (req, res) => {
  if (!admin(req, res)) return;
  const r = await adjudicate(String(req.body?.session || ''));
  res.status(r.status).json(r.body);
  keep(r.hardening);
});

app.get('/api/health', (_req, res) => res.send('ok'));
app.get('/health', (_req, res) => res.send('ok'));
