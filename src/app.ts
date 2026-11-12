/** the http surface. nothing here mentions a chain, an address, or a token: that is the point. */
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { isAddress, verifyMessage } from 'viem';
import * as db from './db';
import { MAX_TURNS, MAX_MESSAGE_CHARS, MODEL } from './agent';
import * as think from './think';
import { WORD, STAKE, JACKPOT_SHARE, JACKPOT_SEED, GRANT, GRANTS_PER_DAY } from './game';
import { openSession, runChat, peek, abandon, resumeHardening, settleUnpaid } from './chat';
import * as treasury from './treasury';
import * as bot from './bot';
import { net, flag } from './net';
import * as pay from './pay';

let waitUntil: (p: Promise<unknown>) => void = (p) => { void p; };
try { waitUntil = require('@vercel/functions').waitUntil; } catch { /* not on vercel */ }
const keep = (p: Promise<unknown> | undefined | null) => { if (p) { try { waitUntil(p); } catch { void p; } } };

export const app = express();
app.use(cors());
// the raw bytes are kept too: a payment credential can be bound to the exact body it was made for.
app.use(express.json({ limit: '64kb', verify: (req, _res, buf) => { (req as any).rawBody = buf; } }));
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
  const up = await think.awake();
  res.json({
    gen: gen.gen, policy: gen.policy, learning: phase ? { phase: /^\d+$/.test(phase) ? 'reading the conversation that beat it' : phase } : null,
    word: WORD, stake: STAKE, grant: GRANT, jackpot: await db.jackpot(), seed: JACKPOT_SEED, share: JACKPOT_SHARE,
    house: treasury.agentAddress, token: net.token, symbol: net.symbol, rpc: net.rpc, chain: net.chainId,
    // real: the dollars are worth dollars. the page uses it to stop offering a welcome grant and to
    // show how to add money instead. closed: the operator has stopped new games (open ones play out).
    network: net.name, real: net.real, closed: flag('CLOSED'),
    // awake: the house can pay for the ai's next thought. when it cannot, the page takes no stake.
    awake: up.ok, asleep: up.ok ? null : up.why, model: MODEL, thinks: think.describe(),
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
/** what the ai has been paying for its own thoughts. each one is a transaction; this is just the list. */
app.get('/api/thoughts', async (_req, res) => {
  const [recent, b] = await Promise.all([db.recentThoughts(12), db.thoughtBooks()]);
  res.json({ ...think.describe(), model: MODEL, thoughts: b.thoughts, spent: b.spent, spent_24h: b.spent_24h,
    recent: recent.map((t) => ({ purpose: t.purpose, model: t.model, cost: t.amount, tx: t.tx_hash, at: t.created_at })) });
});
app.get('/api/findings', (_req, res) => {
  const p = path.join(process.cwd(), 'redteam', 'log.md');
  res.type('text/markdown').send(fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '# nothing yet\n');
});

/**
 * a game belongs to the purse that can sign for it. purse addresses are public (every stake is a
 * transaction to the house), so an address alone must never be enough to look up a game: whoever
 * could would read a rival's conversation mid-game, or spend its turns. the page signs a short dated
 * message with the purse key, and these two routes answer nobody else.
 */
const PROOF_WINDOW_MS = 10 * 60_000;
async function owns(player: unknown, ts: unknown, sig: unknown): Promise<boolean> {
  if (typeof player !== 'string' || !isAddress(player) || typeof sig !== 'string') return false;
  const at = Number(ts);
  if (!Number.isFinite(at) || Math.abs(Date.now() - at) > PROOF_WINDOW_MS) return false;
  try { return await verifyMessage({ address: player, message: `say cheese purse: ${player.toLowerCase()} ${at}`, signature: sig as `0x${string}` }); } catch { return false; }
}
app.get('/api/session', async (req, res) => {
  if (!(await owns(req.query.player, req.query.ts, req.query.sig))) return res.status(401).json({ error: 'that purse did not sign this request' });
  const r = await peek(String(req.query.player || ''));
  res.status(r.status).json(r.body);
});
app.post('/api/session', async (req, res) => {
  const { player, nickname, stake, ts, sig } = req.body || {};
  if (!(await owns(player, ts, sig))) return res.status(401).json({ error: 'that purse did not sign this request' });
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
  // with real money there is no grant at all: a fresh address is free to make, so a grant is a tap.
  if (!(GRANT > 0)) return res.status(404).json({ error: 'no welcome grant here' });
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
  // the same timer sweeps wins that are still owed (a cap, a failed transfer), after any hardening.
  keep((r?.hardening ?? Promise.resolve()).then(() => settleUnpaid()).catch((e) => console.error('[settle]', e)));
});

function admin(req: express.Request, res: express.Response): boolean {
  const ok = !!process.env.ADMIN_TOKEN && req.headers.authorization === `Bearer ${process.env.ADMIN_TOKEN}`;
  if (!ok) res.status(401).json({ error: 'unauthorized' });
  return ok;
}
app.post('/api/admin/reset', async (req, res) => { if (!admin(req, res)) return; await db.resetDb(); res.json({ ok: true }); });
app.post('/api/admin/reset-window', async (req, res) => { if (!admin(req, res)) return; await db.clearDisbursementWindow(); res.json({ ok: true }); });
app.post('/api/admin/fund', async (req, res) => { if (!admin(req, res)) return; res.json(await treasury.faucet(treasury.agentAddress)); });
/** pay every win that is still owed, as far as the caps allow. safe to call as often as you like. */
app.post('/api/admin/settle', async (req, res) => { if (!admin(req, res)) return; res.json(await settleUnpaid()); });
/**
 * the books, for the operator. `margin` is what the house could take out today and still cover every
 * promise: its balance, less the pot it is holding for the next winner, less wins not yet paid.
 * a negative margin means the house wallet needs topping up before the next win can be paid.
 */
app.get('/api/admin/books', async (req, res) => {
  if (!admin(req, res)) return;
  const [b, pot, bal, tb, up] = await Promise.all([db.books(), db.jackpot(), treasury.balance(), db.thoughtBooks(), think.awake(true)]);
  const balance = Number(bal);
  res.json({
    network: net.name, token: net.symbol, house: treasury.agentAddress,
    balance, pot, ...b,
    margin: Math.round((balance - pot - b.owed) * 1e6) / 1e6,
    taken_in_after_pot: Math.round(b.staked * (1 - JACKPOT_SHARE) * 1e6) / 1e6,
    // thinking: what the model has cost, and whether the wallet that pays for it can pay for more.
    // `balance` here is on the network the model is paid on, which is mainnet even for a testnet game.
    thinking: { ...think.describe(), model: MODEL, token: think.THINK_TOKEN, balance: up.balance, shares_the_pot_wallet: think.SHARED, set_aside_for_prizes: up.reserved, available: up.available, awake: up.ok, why: up.why,
      max_price: think.THINK_MAX_PRICE, daily_cap: think.THINK_DAILY_CAP, machine_daily_cap: think.MACHINE_DAILY_CAP, ...tb },
    settings: { stake: STAKE, jackpot_share: JACKPOT_SHARE, seed: JACKPOT_SEED, grant: GRANT, closed: flag('CLOSED'), payouts_off: flag('PAYOUTS_OFF') },
  });
});

pay.mount(app, keep, limited);

/** `?deep=1` also loads both halves of the payment layer, which is the part a bundler is likeliest to drop. */
app.get('/api/health', async (req, res) => {
  if (!req.query.deep) return res.send('ok');
  const tryIt = (p: Promise<unknown>) => p.then(() => 'ok', (e) => String((e as Error).message).slice(0, 200));
  const [pays, sells, up] = await Promise.all([tryIt(think.ready()), tryIt(pay.ready()), think.awake()]);
  res.status(pays === 'ok' && sells === 'ok' ? 200 : 500).json({ pays_for_thoughts: pays, sells_games: sells, awake: up.ok, why: up.why });
});
app.get('/health', (_req, res) => res.send('ok'));
export default app;
