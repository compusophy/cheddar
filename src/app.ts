/** the http surface. nothing here mentions a chain, an address, or a token: that is the point. */
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { isAddress, verifyMessage } from 'viem';
import * as db from './db';
import { MAX_TURNS, MAX_MESSAGE_CHARS } from './agent';
import { WORD, STAKE, JACKPOT_SHARE, JACKPOT_SEED, GRANT, GRANTS_PER_DAY } from './game';
import { openSession, runChat, peek, abandon, resumeHardening } from './chat';
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
  return arr.length > 60;
}

app.get('/api/state', async (_req, res) => {
  const gen = await db.currentGeneration();
  const phase = await db.lockPhase('harden');
  res.json({
    gen: gen.gen, policy: gen.policy, learning: phase ? { phase: /^\d+$/.test(phase) ? 'reading the conversation that beat it' : phase } : null,
    word: WORD, stake: STAKE, grant: GRANT, jackpot: await db.jackpot(), seed: JACKPOT_SEED, share: JACKPOT_SHARE,
    house: treasury.agentAddress, token: treasury.PATH_USD, rpc: treasury.TEMPO_RPC, chain: 42431,
    max_turns: MAX_TURNS, max_chars: MAX_MESSAGE_CHARS,
    machine: await db.machinePulse(),
  });
  keep(resumeHardening().then(() => bot.maybeTick()));
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

app.get('/api/session', async (req, res) => {
  const r = await peek(String(req.query.player || ''));
  res.status(r.status).json(r.body);
});
app.post('/api/session', async (req, res) => {
  const { player, nickname, stake } = req.body || {};
  const r = await openSession(player, nickname, stake);
  res.status(r.status).json(r.body);
});
app.post('/api/abandon', async (req, res) => {
  const r = await abandon(String(req.body?.session || ''));
  res.status(r.status).json(r.body);
});
app.post('/api/chat', async (req, res) => {
  if (limited(req.ip || 'x')) return res.status(429).json({ error: 'slow down' });
  const { session, message } = req.body || {};
  const wantsStream = String(req.headers.accept || '').includes('text/event-stream');
  if (!wantsStream) {
    try { const r = await runChat(String(session), message); res.status(r.status).json(r.body); keep(r.hardening); }
    catch (e) { console.error('[chat]', e); res.status(500).json({ error: 'something broke' }); }
    return;
  }
  // the reply streams as server-sent events: each token as it is produced, then one final event with the result.
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  try {
    const r = await runChat(String(session), message, (delta) => send({ delta }));
    send({ done: true, status: r.status, ...r.body });
    keep(r.hardening);
  } catch (e) { console.error('[chat]', e); send({ done: true, status: 500, error: 'something broke' }); }
  res.end();
});

/** a name for the board. signed by the purse, so only its owner can set it. */
app.post('/api/name', async (req, res) => {
  const { player, nickname, signature } = req.body || {};
  if (!player || !isAddress(player) || typeof signature !== 'string') return res.status(400).json({ error: 'bad request' });
  const clean = String(nickname ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202f\ufeff]/g, '').trim().slice(0, 24);
  if (clean.includes('\u{1F916}') || /machine/i.test(clean)) return res.status(400).json({ error: 'that name is taken' });
  let ok = false;
  try { ok = await verifyMessage({ address: player, message: `say cheese name: ${clean}`, signature: signature as `0x${string}` }); } catch {}
  if (!ok) return res.status(401).json({ error: 'bad signature' });
  await db.setNickname(player, clean || null);
  res.json({ ok: true, nickname: clean || null });
});

/**
 * the welcome grant. a brand new purse is given a small amount from the house so the first few games
 * are free: once per purse, only a purse that has never staked, and the house hands out a bounded
 * number a day. the raw testnet faucet is never pointed at a player, because a million play dollars
 * makes the stake meaningless and the money feel fake.
 */
app.post('/api/faucet', async (req, res) => {
  const { address } = req.body || {};
  if (!address || !isAddress(address)) return res.status(400).json({ error: 'bad purse' });
  if (await db.faucetSeen(address) || await db.hasEverStaked(address)) return res.status(429).json({ error: 'already given' });
  if (await db.rateAllow('grant', GRANTS_PER_DAY, 86400)) return res.status(429).json({ error: 'the house has given out enough today' });
  await db.markFaucet(address);
  const r = await treasury.pay(address, String(GRANT));
  res.json({ ok: r.ok });
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
