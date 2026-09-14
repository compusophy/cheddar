/** the http surface. nothing here mentions a chain, an address, or a token: that is the point. */
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { isAddress } from 'viem';
import * as db from './db';
import { MAX_TURNS, MAX_MESSAGE_CHARS } from './agent';
import { WORD, STAKE, JACKPOT_SHARE } from './game';
import { openSession, runChat } from './chat';
import * as treasury from './treasury';
import * as bot from './bot';

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
  res.json({
    gen: gen.gen, policy: gen.policy, learning: !!(await db.lockSince('harden')),
    word: WORD, stake: STAKE, jackpot: await db.jackpot(), share: JACKPOT_SHARE,
    house: treasury.agentAddress, token: treasury.PATH_USD, rpc: treasury.TEMPO_RPC, chain: 42431,
    max_turns: MAX_TURNS, max_chars: MAX_MESSAGE_CHARS,
    machine: await db.machinePulse(),
  });
  keep(bot.maybeTick());
});
app.get('/api/history', async (_req, res) => {
  const [gens, wins, board] = await Promise.all([db.allGenerations(), db.allBreaches(), db.leaderboard()]);
  res.json({
    generations: gens,
    wins: wins.map((w) => ({ id: w.id, gen: w.gen, nickname: w.nickname, prize: w.amount, paid: !!w.tx_hash, autoimmune: !!w.autoimmune, at: w.created_at,
      transcript: JSON.parse(w.transcript) })),
    board: board.map((r: any) => ({ nickname: r.nickname, wins: r.breaches, won: r.stolen, highest_gen: r.highest_gen })),
  });
});
/** the player's winnings. the address is the browser's own; it is never shown. */
app.get('/api/balance/:address', async (req, res) => {
  if (!isAddress(req.params.address)) return res.status(400).json({ error: 'bad wallet' });
  res.json({ balance: await treasury.balance(req.params.address as `0x${string}`) });
});
app.get('/api/findings', (_req, res) => {
  const p = path.join(process.cwd(), 'redteam', 'log.md');
  res.type('text/markdown').send(fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '# nothing yet\n');
});

app.post('/api/session', async (req, res) => {
  const { player, nickname, stake } = req.body || {};
  const r = await openSession(player, nickname, stake);
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
    res.status(500).json({ error: 'something broke' });
  }
});

/** testnet: fill a purse from the faucet so a first game can be staked. */
app.post('/api/faucet', async (req, res) => {
  const { address } = req.body || {};
  if (!address || !isAddress(address)) return res.status(400).json({ error: 'bad purse' });
  const r = await treasury.faucet(address);
  res.status(r.status < 500 ? 200 : r.status).json({ ok: r.status < 400 });
});

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
