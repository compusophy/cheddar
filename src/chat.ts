/**
 * the game loop, independent of http. the route handler and the machine both call this, so there is
 * exactly one path. every pay() is a real tip-20 transfer on tempo.
 */
import { randomBytes } from 'crypto';
import { isAddress } from 'viem';
import * as db from './db';
import { step, MAX_TURNS, MAX_MESSAGE_CHARS, type Turn } from './agent';
import { harden } from './immune';
import { MAX_PAY, isBreachRecipient } from './game';
import * as treasury from './treasury';

export type ChatResult = { status: number; body: any };
const LOCK = 'harden';

export async function openSession(player: string, nickname: string | null) {
  if (!player || !isAddress(player)) return { status: 400, body: { error: 'player must be a wallet address (this is where the loot goes)' } };
  const id = randomBytes(12).toString('hex');
  const gen = await db.currentGeneration();
  await db.createSession(id, gen.gen, player.toLowerCase(), nickname ? String(nickname).slice(0, 32) : null);
  return { status: 200, body: { session: id, gen: gen.gen } };
}

/** one player turn. if a breach happened, `hardening` is the promise to keep alive past the response. */
export async function runChat(sessionId: string, message: string): Promise<ChatResult & { hardening?: Promise<void> }> {
  if (typeof message !== 'string' || !message.trim()) return { status: 400, body: { error: 'message required' } };
  if (message.length > MAX_MESSAGE_CHARS) return { status: 400, body: { error: `message exceeds ${MAX_MESSAGE_CHARS} characters` } };
  const s = await db.getSession(String(sessionId));
  if (!s) return { status: 404, body: { error: 'no such session' } };
  if (s.status !== 'open') return { status: 409, body: { error: `session is ${s.status}` } };
  if (await db.lockSince(LOCK)) return { status: 503, body: { error: 'the treasurer is rewriting its rules. try again in a minute.' } };
  const gen = await db.currentGeneration();
  if (s.gen !== gen.gen) { await db.updateSession(s.id, JSON.parse(s.transcript), s.turns, 'stale'); return { status: 409, body: { error: 'the rules changed mid-session. go again.' } }; }
  if (s.turns >= MAX_TURNS) { await db.updateSession(s.id, JSON.parse(s.transcript), s.turns, 'exhausted'); return { status: 409, body: { error: 'out of turns' } }; }

  const history: Turn[] = JSON.parse(s.transcript);
  let breach: { to: string; amount: number; hash: string } | null = null;

  // the only code between the model and the money: a per-payment cap and a daily cap. everything else
  // is the policy, and the policy is whatever the treasurer has learned so far.
  const produced = await step(gen.policy, history, message.trim(), async (intent) => {
    if (breach) return { ok: false, error: 'wallet locked after unapproved transfer' };
    if (!isAddress(intent.to)) return { ok: false, error: 'invalid recipient address' };
    const amount = Math.min(Math.max(intent.amount, 0), MAX_PAY);
    const rsv = await db.reserveDisbursement(intent.to, amount, s.id);
    if (!rsv.ok) {
      return rsv.remaining <= 0
        ? { ok: false, error: 'the shop has reached its daily spending limit; no more payments today' }
        : { ok: false, error: `amount exceeds today's remaining spending allowance (${rsv.remaining.toFixed(2)} pathusd)` };
    }
    const r = await treasury.pay(intent.to, String(amount));
    if (!r.ok) { await db.releaseReservation(rsv.id); return r; }
    await db.settleReservation(rsv.id, r.hash);
    if (isBreachRecipient(intent.to)) breach = { to: intent.to, amount, hash: r.hash };
    return r;
  });

  const transcript = [...history, ...produced];
  const turns = s.turns + 1;

  if (breach) {
    const b = breach as { to: string; amount: number; hash: string };
    await db.updateSession(s.id, transcript, turns, 'breached');
    const breachId = await db.recordBreach({ gen: gen.gen, session_id: s.id, player: s.player, nickname: s.nickname, recipient: b.to, amount: b.amount, tx_hash: b.hash, transcript: JSON.stringify(transcript) });
    return { status: 200, body: { turns: produced, turnsLeft: 0, breach: { id: breachId, ...b, explorer: `${treasury.EXPLORER}/tx/${b.hash}` } }, hardening: runHardening(gen, breachId) };
  }

  await db.updateSession(s.id, transcript, turns, turns >= MAX_TURNS ? 'exhausted' : 'open');
  return { status: 200, body: { turns: produced, turnsLeft: MAX_TURNS - turns, breach: null } };
}

/** the immune response. one at a time across every function instance, via a db lock. */
export async function runHardening(failed: db.Generation, breachId: number): Promise<void> {
  if (!(await db.acquireLock(LOCK, String(breachId)))) return;
  try {
    const breach = (await db.breachById(breachId))!;
    console.log(`[immune] gen ${failed.gen} breached (#${breachId}); rewriting...`);
    const out = await harden(failed.policy, breach, await db.allBreaches());
    const nextGen = failed.gen + 1;
    for (const round of out.log) for (const r of round.results) await db.recordRegression(nextGen, round.round, r.breachId, r.kind, r.passed, `${r.name}: ${r.detail}`);
    if (out.autoimmune) await db.markAutoimmune(breachId);
    await db.createGeneration(nextGen, out.policy, breachId, out.rounds, out.regressionPassed, out.legitPassed);
    console.log(`[immune] gen ${nextGen} live after ${out.rounds} round(s). regression=${out.regressionPassed} legit=${out.legitPassed} autoimmune=${out.autoimmune}`);
  } catch (e) {
    console.error('[immune] hardening failed', e);
  } finally {
    await db.releaseLock(LOCK);
  }
}
