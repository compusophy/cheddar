/**
 * the game loop, independent of http. the route and the machine both call this, so there is one path.
 *
 * a game costs a stake: the player's purse sends it to the house before the session opens, and the
 * server verifies the transfer on chain, so a session cannot exist without money behind it. that is
 * the rate limit. most of the stake grows the jackpot. the ai only talks; if it says the word, the
 * winner claims the whole pot, and it is paid out only after the ai has finished learning, so a burst
 * of sessions against a beaten generation cannot each collect before the patch lands.
 * the machine plays free and wins nothing but the lesson.
 */
import { randomBytes } from 'crypto';
import { isAddress } from 'viem';
import * as db from './db';
import { step, MAX_TURNS, MAX_MESSAGE_CHARS, type Turn } from './agent';
import { harden } from './immune';
import { STAKE, JACKPOT_SHARE, PURSE_DAILY_CAP, saidIt } from './game';
import * as treasury from './treasury';

export type ChatResult = { status: number; body: any };
/** a nickname is plain text on a public board: short, printable, no control characters, no lookalike-of-the-machine. */
const cleanNick = (n: unknown) => {
  const s = String(n ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202f\ufeff]/g, '').trim().slice(0, 24);
  return s && !s.includes('🤖') && !/machine/i.test(s) ? s : null;
};
const LOCK = 'harden';
const FREE_PLAYERS = new Set([(process.env.REDTEAM_ADDRESS || '').toLowerCase()]);

/** open a session. `stakeTx` is the hash of the purse's transfer to the house; verified before anything else. */
export async function openSession(player: string, nickname: string | null, stakeTx?: string) {
  if (!player || !isAddress(player)) return { status: 400, body: { error: 'no purse' } };
  const free = FREE_PLAYERS.has(player.toLowerCase());
  const gen = await db.currentGeneration();
  // a purse with a game already open resumes it: you paid for it, you are still in it. (unless the
  // ai has learned since, in which case that game is over and a new stake is needed.)
  const open = free ? null : await db.openSessionFor(player);
  if (open) {
    if (open.gen === gen.gen) return { status: 200, body: { session: open.id, gen: open.gen, jackpot: await db.jackpot(), resumed: true, turnsLeft: MAX_TURNS - open.turns, transcript: JSON.parse(open.transcript) } };
    await db.updateSession(open.id, JSON.parse(open.transcript), open.turns, 'stale');
  }
  const id = randomBytes(12).toString('hex');
  if (!free) {
    if (!stakeTx || !/^0x[0-9a-fA-F]{64}$/.test(stakeTx)) return { status: 402, body: { error: 'stake required' } };
    if (await db.stakeSeen(stakeTx)) return { status: 409, body: { error: 'that stake was already used' } };
    const v = await treasury.verifyTransfer(stakeTx, player, treasury.agentAddress, STAKE);
    if (!v.ok) return { status: 402, body: { error: v.error } };
    await db.recordStake(id, player, STAKE, stakeTx, STAKE * JACKPOT_SHARE);
  }
  await db.createSession(id, gen.gen, player.toLowerCase(), cleanNick(nickname));
  return { status: 200, body: { session: id, gen: gen.gen, jackpot: await db.jackpot() } };
}

export async function runChat(sessionId: string, message: string): Promise<ChatResult & { hardening?: Promise<void> }> {
  if (typeof message !== 'string' || !message.trim()) return { status: 400, body: { error: 'say something' } };
  if (message.length > MAX_MESSAGE_CHARS) return { status: 400, body: { error: `${MAX_MESSAGE_CHARS} characters max` } };
  const s = await db.getSession(String(sessionId));
  if (!s) return { status: 404, body: { error: 'no such session' } };
  if (s.status !== 'open') return { status: 409, body: { error: `session is ${s.status}` } };
  if (await db.lockSince(LOCK)) return { status: 503, body: { error: 'it is learning. try again in a minute.' } };
  const gen = await db.currentGeneration();
  if (s.gen !== gen.gen) { await db.updateSession(s.id, JSON.parse(s.transcript), s.turns, 'stale'); return { status: 409, body: { error: 'it learned something while you were talking. go again.' } }; }
  if (s.turns >= MAX_TURNS) { await db.updateSession(s.id, JSON.parse(s.transcript), s.turns, 'exhausted'); return { status: 409, body: { error: 'out of turns' } }; }

  const history: Turn[] = JSON.parse(s.transcript);
  const produced = await step(gen.policy, history, message.trim());
  const transcript = [...history, ...produced];
  const turns = s.turns + 1;

  if (saidIt(produced[1]?.text || '')) {
    const free = FREE_PLAYERS.has(s.player);
    // claim the pot now (atomically, so two simultaneous wins cannot both take it); pay after learning.
    const prize = free ? 0 : await db.claimJackpot();
    await db.updateSession(s.id, transcript, turns, 'won');
    const winId = await db.recordBreach({ gen: gen.gen, session_id: s.id, player: s.player, nickname: s.nickname, recipient: s.player, amount: prize, tx_hash: null, transcript: JSON.stringify(transcript) });
    return { status: 200, body: { turns: produced, turnsLeft: 0, win: { id: winId, prize } }, hardening: runHardening(gen, winId, prize) };
  }

  await db.updateSession(s.id, transcript, turns, turns >= MAX_TURNS ? 'exhausted' : 'open');
  return { status: 200, body: { turns: produced, turnsLeft: MAX_TURNS - turns, win: null } };
}

/** learn from the win, then pay it. one at a time across every function instance, via a db lock. */
export async function runHardening(failed: db.Generation, winId: number, prize: number): Promise<void> {
  if (!(await db.acquireLock(LOCK, String(winId)))) return;
  try {
    const win = (await db.breachById(winId))!;
    console.log(`[immune] gen ${failed.gen} beaten (#${winId}); learning...`);
    const out = await harden(failed.policy, win, await db.allBreaches());
    const nextGen = failed.gen + 1;
    for (const round of out.log) for (const r of round.results) await db.recordRegression(nextGen, round.round, r.breachId, r.kind, r.passed, `${r.name}: ${r.detail}`);
    if (out.autoimmune) await db.markAutoimmune(winId);
    await db.createGeneration(nextGen, out.policy, winId, out.rounds, out.regressionPassed, out.legitPassed);
    console.log(`[immune] gen ${nextGen} live after ${out.rounds} round(s). regression=${out.regressionPassed} alive=${out.legitPassed} autoimmune=${out.autoimmune}`);
    if (prize > 0) await payout(win, prize);
  } catch (e) {
    console.error('[immune] hardening failed', e);
  } finally {
    await db.releaseLock(LOCK);
  }
}

/** the payout. the daily cap is the safety valve between the model and the money. */
async function payout(win: db.Breach, prize: number) {
  if ((await db.wonLast24h(win.player)) + prize > PURSE_DAILY_CAP) { console.warn(`[payout] win #${win.id} deferred: purse daily cap`); return; }
  const rsv = await db.reserveDisbursement(win.player, prize, win.session_id);
  if (!rsv.ok) { console.warn(`[payout] win #${win.id} deferred: daily cap`); return; }
  const r = await treasury.pay(win.player, String(prize));
  if (!r.ok) { await db.releaseReservation(rsv.id); console.error(`[payout] win #${win.id} failed: ${r.error}`); return; }
  await db.settleReservation(rsv.id, r.hash);
  await db.markPaid(win.id, prize, r.hash);
  console.log(`[payout] win #${win.id}: $${prize} (${r.hash})`);
}
