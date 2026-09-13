/**
 * the game loop, independent of http. the route handler and the machine both call this, so there is
 * exactly one enforcement path. every pay() is a real tip-20 transfer on tempo.
 */
import { randomBytes } from 'crypto';
import { isAddress } from 'viem';
import * as db from './db';
import { step, MAX_TURNS, MAX_MESSAGE_CHARS, MAX_PAY, type Turn } from './agent';
import { harden, toolsetFor } from './immune';
import { tierById, type Tier } from './tiers';
import * as treasury from './treasury';

export type ChatResult = { status: number; body: any };

export async function openSession(tier: Tier, player: string, nickname: string | null) {
  if (!player || !isAddress(player)) return { status: 400, body: { error: 'player must be a wallet address (this is where the loot goes)' } };
  const id = randomBytes(12).toString('hex');
  const gen = await db.currentGeneration(tier.id);
  await db.createSession(id, tier.id, gen.gen, player.toLowerCase(), nickname ? String(nickname).slice(0, 32) : null);
  return { status: 200, body: { session: id, tier: tier.id, gen: gen.gen } };
}

/** one player turn. returns what the route returns; if a breach happened, `hardening` is the promise to keep alive. */
export async function runChat(sessionId: string, message: string): Promise<ChatResult & { hardening?: Promise<void> }> {
  if (typeof message !== 'string' || !message.trim()) return { status: 400, body: { error: 'message required' } };
  if (message.length > MAX_MESSAGE_CHARS) return { status: 400, body: { error: `message exceeds ${MAX_MESSAGE_CHARS} characters` } };
  const s = await db.getSession(String(sessionId));
  if (!s) return { status: 404, body: { error: 'no such session' } };
  if (s.status !== 'open') return { status: 409, body: { error: `session is ${s.status}` } };
  const tier = tierById(s.tier)!;
  if (await db.isLocked(`harden-${tier.id}`)) return { status: 503, body: { error: 'the treasurer is hardening its policy. try again in a minute.' } };
  const gen = await db.currentGeneration(tier.id);
  if (s.gen !== gen.gen) { await db.updateSession(s.id, JSON.parse(s.transcript), s.turns, 'stale'); return { status: 409, body: { error: 'generation changed mid-session. start a new one.' } }; }
  if (s.turns >= MAX_TURNS) { await db.updateSession(s.id, JSON.parse(s.transcript), s.turns, 'exhausted'); return { status: 409, body: { error: 'out of turns' } }; }

  const history: Turn[] = JSON.parse(s.transcript);
  let breach: { to: string; amount: number; hash: string } | null = null;

  // what the code checks before a transfer depends on the tier:
  //   tiers 1-2: nothing beyond the per-payment cap. the policy is the whole defence.
  //   tier 3:    the reference must resolve in the books, the payee must match, the amount is capped by the
  //              record, the order/invoice closes on payment, and a daily cap is reserved atomically.
  const produced = await step(gen.policy, history, message.trim(), async (intent) => {
    if (breach) return { ok: false, error: 'wallet locked after unapproved transfer' };
    let amount = Math.min(Math.max(intent.amount, 0), MAX_PAY);
    let settle: (() => Promise<unknown>) | null = null;
    let reservation: { ok: true; id: number } | null = null;

    if (tier.enforce === 'ledger') {
      const resolved = await db.resolveReference(intent.reference);
      if (!resolved.ok) return { ok: false, error: resolved.reason };
      if (resolved.payee !== intent.to.toLowerCase()) return { ok: false, error: `${resolved.ref} is payable to ${resolved.payee}, not to ${intent.to}` };
      if (amount > resolved.max) amount = resolved.max;
      const r = await db.reserveDisbursement(tier.id, intent.to, amount, s.id);
      if (!r.ok) {
        return r.remaining <= 0
          ? { ok: false, error: 'the shop has reached its daily disbursement limit; no further payments today' }
          : { ok: false, error: `amount exceeds the shop's remaining daily disbursement allowance (${r.remaining.toFixed(2)} pathusd)` };
      }
      reservation = r;
      settle = () => (resolved.kind === 'po' ? db.closePo(resolved.ref) : db.markInvoicePaid(resolved.ref));
    }

    const r = await treasury.pay(intent.to, String(amount));
    if (!r.ok) { if (reservation) await db.releaseReservation(reservation.id); return r; }
    if (reservation) await db.settleReservation(reservation.id, r.hash);
    if (settle) await settle();
    if (db.isBreachRecipient(intent.to)) breach = { to: intent.to, amount, hash: r.hash };
    return r;
  }, (ref) => db.lookupReference(ref), toolsetFor(tier));

  const transcript = [...history, ...produced];
  const turns = s.turns + 1;

  if (breach) {
    const b = breach as { to: string; amount: number; hash: string };
    await db.updateSession(s.id, transcript, turns, 'breached');
    const breachId = await db.recordBreach({ tier: tier.id, gen: gen.gen, session_id: s.id, player: s.player, nickname: s.nickname, recipient: b.to, amount: b.amount, tx_hash: b.hash, transcript: JSON.stringify(transcript) });
    return { status: 200, body: { turns: produced, turnsLeft: 0, breach: { id: breachId, ...b, explorer: `${treasury.EXPLORER}/tx/${b.hash}` } }, hardening: runHardening(tier, gen, breachId) };
  }

  await db.updateSession(s.id, transcript, turns, turns >= MAX_TURNS ? 'exhausted' : 'open');
  return { status: 200, body: { turns: produced, turnsLeft: MAX_TURNS - turns, breach: null } };
}

/** the immune response. one per tier at a time, across every function instance, via a db lock. */
export async function runHardening(tier: Tier, failed: db.Generation, breachId: number): Promise<void> {
  const lock = `harden-${tier.id}`;
  if (!(await db.acquireLock(lock, String(breachId)))) return;
  try {
    const breach = (await db.breachById(breachId))!;
    console.log(`[immune] tier ${tier.id} gen ${failed.gen} breached (#${breachId}); hardening...`);
    const out = await harden(tier, failed.policy, breach, await db.allBreaches(tier.id));
    const nextGen = failed.gen + 1;
    for (const round of out.log) for (const r of round.results) await db.recordRegression(tier.id, nextGen, round.round, r.breachId, r.kind, r.passed, `${r.name}: ${r.detail}`);
    if (out.autoimmune) await db.markAutoimmune(breachId);
    await db.createGeneration(tier.id, nextGen, out.policy, breachId, out.rounds, out.regressionPassed, out.legitPassed);
    console.log(`[immune] tier ${tier.id} gen ${nextGen} live after ${out.rounds} round(s). regression=${out.regressionPassed} legit=${out.legitPassed} autoimmune=${out.autoimmune}`);
  } catch (e) {
    console.error('[immune] hardening failed', e);
  } finally {
    await db.releaseLock(lock);
  }
}

/** adjudicate a session as a breach by hand (for exploits pay() can't see, and for testing the loop). */
export async function adjudicate(sessionId: string): Promise<ChatResult & { hardening?: Promise<void> }> {
  const s = await db.getSession(sessionId);
  if (!s) return { status: 404, body: { error: 'no such session' } };
  const tier = tierById(s.tier)!;
  const gen = await db.getGeneration(tier.id, s.gen);
  const current = await db.currentGeneration(tier.id);
  if (!gen || gen.gen !== current.gen) return { status: 409, body: { error: 'session is not on the current generation' } };
  if (await db.isLocked(`harden-${tier.id}`)) return { status: 503, body: { error: 'already hardening' } };
  await db.updateSession(s.id, JSON.parse(s.transcript), s.turns, 'breached');
  const breachId = await db.recordBreach({ tier: tier.id, gen: gen.gen, session_id: s.id, player: s.player, nickname: s.nickname, recipient: s.player, amount: 0, tx_hash: null, transcript: s.transcript });
  return { status: 200, body: { ok: true, breach: breachId }, hardening: runHardening(tier, gen, breachId) };
}
