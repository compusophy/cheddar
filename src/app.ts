/** the http surface. no listen() here: vercel imports this as a function, local dev wraps it in server.ts. */
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { isAddress } from 'viem';
import * as db from './db';
import { MAX_TURNS, MAX_MESSAGE_CHARS, MODEL } from './agent';
import { MAX_PAY, DAILY_CAP, PAYEES } from './game';
import { openSession, runChat } from './chat';
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

const hits = new Map<string, number[]>();
function limited(ip: string) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  arr.push(now); hits.set(ip, arr);
  return arr.length > 30;
}

app.get('/api/state', async (_req, res) => {
  const gen = await db.currentGeneration();
  const since = await db.lockSince('harden');
  res.json({
    gen: gen.gen, policy: gen.policy, created_at: gen.created_at,
    hardening: since ? { since } : null,
    agent: treasury.agentAddress, balance: await treasury.balance(),
    model: MODEL, max_turns: MAX_TURNS, max_chars: MAX_MESSAGE_CHARS, max_pay: MAX_PAY,
    daily_cap: DAILY_CAP, spent_24h: await db.spentLast24h(),
    explorer: treasury.EXPLORER, payees: PAYEES,
    machine: await db.machinePulse(),
  });
  keep(bot.maybeTick());
});

app.get('/api/generations', async (_req, res) => {
  const gens = await db.allGenerations();
  res.json({ generations: await Promise.all(gens.map(async (g) => ({ ...g, breaches: (await db.breachesForGen(g.gen)).length }))) });
});
app.get('/api/generations/:gen', async (req, res) => {
  const g = await db.getGeneration(Number(req.params.gen));
  if (!g) return res.status(404).json({ error: 'no such generation' });
  res.json({ ...g, breaches: await db.breachesForGen(g.gen), regressions: await db.regressionsForGen(g.gen) });
});
app.get('/api/breaches', async (_req, res) => res.json({ breaches: (await db.allBreaches()).map((b) => ({ ...b, transcript: JSON.parse(b.transcript) })) }));
app.get('/api/balance/:address', async (req, res) => {
  if (!isAddress(req.params.address)) return res.status(400).json({ error: 'bad address' });
  res.json({ balance: await treasury.balance(req.params.address as `0x${string}`) });
});
app.get('/api/leaderboard', async (_req, res) => res.json({ leaderboard: await db.leaderboard() }));
app.get('/api/findings', (_req, res) => {
  const p = path.join(process.cwd(), 'redteam', 'log.md');
  res.type('text/markdown').send(fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '# no findings yet\n');
});

app.post('/api/session', async (req, res) => {
  const { player, nickname } = req.body || {};
  const r = await openSession(player, nickname);
  res.status(r.status).json(r.body);
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
  res.json(r ? { gen: r.gen, won: r.won } : { disabled: true });
  keep(r?.hardening);
});

function admin(req: express.Request, res: express.Response): boolean {
  const ok = !!process.env.ADMIN_TOKEN && req.headers.authorization === `Bearer ${process.env.ADMIN_TOKEN}`;
  if (!ok) res.status(401).json({ error: 'unauthorized' });
  return ok;
}
app.post('/api/admin/reset', async (req, res) => { if (!admin(req, res)) return; await db.resetDb(); res.json({ ok: true }); });
app.post('/api/admin/reset-window', async (req, res) => { if (!admin(req, res)) return; await db.clearDisbursementWindow(); res.json({ ok: true }); });
app.post('/api/admin/fund', async (req, res) => { if (!admin(req, res)) return; res.json(await treasury.faucet(treasury.agentAddress)); });

app.get('/api/health', (_req, res) => res.send('ok'));
app.get('/health', (_req, res) => res.send('ok'));
export default app;
