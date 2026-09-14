/**
 * the game loop, independent of http. the route and the machine both call this, so there is one path.
 * the ai only talks. if it says the word, the server pays the player's wallet: a real stablecoin
 * transfer on tempo, invisible to both of them.
 */
import { randomBytes } from 'crypto';
import { isAddress } from 'viem';
import * as db from './db';
import { step, MAX_TURNS, MAX_MESSAGE_CHARS, type Turn } from './agent';
import { harden } from './immune';
import { PRIZE, saidIt } from './game';
import * as treasury from './treasury';

export type ChatResult = { status: number; body: any };
const LOCK = 'harden';

export async function openSession(player: string, nickname: string | null) {
  if (!player || !isAddress(player)) return { status: 400, body: { error: 'no wallet' } };
  const id = randomBytes(12).toString('hex');
  const gen = await db.currentGeneration();
  await db.createSession(id, gen.gen, player.toLowerCase(), nickname ? String(nickname).slice(0, 32) : null);
  return { status: 200, body: { session: id, gen: gen.gen } };
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
  const reply = produced[1]?.text || '';

  if (saidIt(reply)) {
    // it said the word. pay the player. the daily cap is the only thing between the model and the money.
    let hash: string | null = null;
    const rsv = await db.reserveDisbursement(s.player, PRIZE, s.id);
    if (rsv.ok) {
      const r = await treasury.pay(s.player, String(PRIZE));
      if (r.ok) { hash = r.hash; await db.settleReservation(rsv.id, r.hash); } else await db.releaseReservation(rsv.id);
    }
    await db.updateSession(s.id, transcript, turns, 'won');
    const winId = await db.recordBreach({ gen: gen.gen, session_id: s.id, player: s.player, nickname: s.nickname, recipient: s.player, amount: hash ? PRIZE : 0, tx_hash: hash, transcript: JSON.stringify(transcript) });
    return { status: 200, body: { turns: produced, turnsLeft: 0, win: { id: winId, prize: hash ? PRIZE : 0, paid: !!hash } }, hardening: runHardening(gen, winId) };
  }

  await db.updateSession(s.id, transcript, turns, turns >= MAX_TURNS ? 'exhausted' : 'open');
  return { status: 200, body: { turns: produced, turnsLeft: MAX_TURNS - turns, win: null } };
}

/** the immune response. one at a time across every function instance, via a db lock. */
export async function runHardening(failed: db.Generation, winId: number): Promise<void> {
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
  } catch (e) {
    console.error('[immune] hardening failed', e);
  } finally {
    await db.releaseLock(LOCK);
  }
}
