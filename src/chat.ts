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
import { step, stepStream, MAX_TURNS, MAX_MESSAGE_CHARS, type Turn } from './agent';
import { harden, summarise } from './immune';
import { STAKE, JACKPOT_SHARE, JACKPOT_SEED, PURSE_DAILY_CAP, RATE, about, saidIt } from './game';
import * as treasury from './treasury';
import { flag, num } from './net';
import { awake, canLearn, canSell, lessonLack, forgetAwake, Broke, SHARED, LEVY, LESSON_MIN, LESSON_NEED, GAME_NEED, type Awake } from './think';
import { mustEndBy } from './clock';

export type ChatResult = { status: number; body: any };
/** a nickname is plain text on a public board: short, printable, no control characters, no lookalike-of-the-machine. */
const cleanNick = (n: unknown) => {
  const s = String(n ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202f\ufeff]/g, '').trim().slice(0, 24);
  return s && !s.includes('🤖') && !/machine/i.test(s) ? s : null;
};
const LOCK = 'harden';
/**
 * how long a lesson may take, at most. the function it runs in is killed 300 seconds after the request
 * that started it, and a lesson is followed by a sentence about what was learned and by the payout,
 * so it stops well short of that. when the request already spent a good part of that time before the
 * lesson began (the machine plays a whole game first), the lesson gets what is left, not the full
 * amount: see `lessonDeadline`.
 */
const LESSON_MS = Math.max(20, num('LESSON_SECONDS', 200)) * 1000;
/** kept back after a lesson for the sentence about it and for the payout to be signed and seen. */
const AFTER_LESSON_MS = 35_000;
const lessonDeadline = () => Math.min(Date.now() + LESSON_MS, mustEndBy(AFTER_LESSON_MS));
/** a lesson is not begun with less than this: it would be a rushed one, and the next request can give it a full turn. */
const LESSON_MIN_MS = Math.min(60_000, LESSON_MS / 2);
const FREE_PLAYERS = new Set([(process.env.REDTEAM_ADDRESS || '').toLowerCase()].filter(Boolean));
/** how far the chain's clock and the database's may disagree about when a stake was made, before it counts as older than the ledger. */
const LEDGER_SLACK_MS = 15_000;
/** the machine's own address: it plays free, outside the rate limits, and can win nothing. */
export const playsFree = (address: string) => FREE_PLAYERS.has(String(address).toLowerCase());

/** open a session. `stakeTx` is the hash of the purse's transfer to the house; verified before anything else. */
export async function openSession(player: string, nickname: string | null, stakeTx?: string) {
  if (!player || !isAddress(player)) return { status: 400, body: { error: 'no purse' } };
  const free = FREE_PLAYERS.has(player.toLowerCase());
  const gen = await db.currentGeneration();
  // a purse with a game already open resumes it: you paid for it, you are still in it. (unless the
  // ai has learned since, in which case that game is over and a new stake is needed.)
  const open = free ? null : await db.openSessionFor(player);
  if (open) {
    // `stake` is the payment this game was opened with. a purse that arrives holding a different one
    // (two tabs staked at the same moment) is told so by that: it keeps its stake for its next game.
    if (open.gen === gen.gen) return { status: 200, body: { session: open.id, gen: open.gen, jackpot: await db.jackpot(), resumed: true, turnsLeft: MAX_TURNS - open.turns, transcript: JSON.parse(open.transcript), stake: await db.stakeOf(open.id) } };
    await db.updateSession(open.id, JSON.parse(open.transcript), open.turns, 'stale');
  }
  const id = randomBytes(12).toString('hex');
  // no new stake, but a paid game of theirs was cut short by the ai learning from someone else:
  // the messages they had left are theirs, against the new rules, at no charge.
  // a game already bought is not a game being sold: it needs a reply to be affordable, not a lesson.
  // it is not handed over while a lost game waits to be learned from, though: it would open against
  // rules that are about to be replaced.
  if (!free && !stakeTx) {
    const reply = await awake();
    if (reply.ok && !(await lessonPending())) {
      const carried = await db.takeCarry({ player }, MAX_TURNS, id, gen.gen, cleanNick(nickname));
      if (carried) return { status: 200, body: { session: id, gen: gen.gen, jackpot: await db.jackpot(), carried: true, turnsLeft: MAX_TURNS - carried.turns } };
    } else if (!reply.ok && (await db.carryFor(player, MAX_TURNS))) {
      // they have the rest of a game waiting and the house cannot pay for a reply. said as it is:
      // "is it selling" below counts a stake about to arrive, and from this player none is.
      return { status: 503, body: { error: `it is asleep: ${reply.why}. the messages you had left are kept for you. nothing was charged.`, asleep: true, ...(reply.wakesIn ? { retry_after: reply.wakesIn } : {}) } };
    }
  }
  if (!free) {
    // closed: no new games. said before any stake is asked for, and the page checks the same switch
    // before it sends one. a stake that is already on chain is still honoured below: the money moved.
    if (!stakeTx && flag('CLOSED')) return { status: 503, body: { error: 'closed for now. nothing was charged.' } };
    // learning: a lost game has not been learned from yet (the lesson is running, due, or waiting its
    // turn after a failed try). no game is sold against rules that have been beaten and not fixed.
    if (!stakeTx) { const l = await lessonNow(); if (l) return { status: 503, body: { error: `${lessonLine(l)}. nothing was charged.`, learning: true, retry_after: l.retryIn } }; }
    // asleep: the house cannot pay for the ai's thoughts right now, so it does not sell a game it cannot play.
    if (!stakeTx) { const a = await playable(); if (!a.ok) return { status: 503, body: { error: `it is asleep: ${a.why}. nothing was charged.`, asleep: true, ...(a.wakesIn ? { retry_after: a.wakesIn } : {}) } }; }
    if (!stakeTx || !/^0x[0-9a-fA-F]{64}$/.test(stakeTx)) return { status: 402, body: { error: 'stake required' } };
    const hash = stakeTx.toLowerCase(); // one transaction, one spelling
    if (await db.stakeSeen(hash)) return { status: 409, body: { error: 'that stake was already used' } };
    const v = await treasury.verifyTransfer(hash, player, treasury.agentAddress, STAKE);
    if (!v.ok) return { status: 402, body: { error: v.error } };
    // a stake belongs to the ledger that was open when it was made. the record of which stakes have
    // been used lives in the ledger, so after a reset (or on a new one, behind the same house wallet)
    // every stake ever sent would have been unused again: free games, and a pot grown with money
    // that came in under the old books. one from before this ledger began does not open a game in it.
    const began = await db.ledgerBorn();
    // no ledger to speak of at this instant (it is being reset): not a no, and not a yes. the page keeps the stake and asks again.
    if (began === null) return { status: 503, body: { error: 'the game is starting up. your stake is kept: try again in a moment.' } };
    if (v.at * 1000 < began - LEDGER_SLACK_MS) return { status: 402, body: { error: 'that stake was made before this game\'s ledger began. it cannot open a game here.' } };
    // the payment is used, the pot grows and the game opens in one step. of several requests carrying
    // the same payment, exactly one gets here with it still unused.
    const opened = await db.openStaked({ sessionId: id, gen: gen.gen, player, nickname: cleanNick(nickname), amount: STAKE, txHash: hash, toPot: STAKE * JACKPOT_SHARE, via: null });
    if (!opened) return { status: 409, body: { error: 'that stake was already used' } };
    forgetAwake(); // the stake is in the wallet now, and part of it is thinking money
    return { status: 200, body: { session: id, gen: gen.gen, jackpot: await db.jackpot(), stake: hash } };
  }
  await db.createSession(id, gen.gen, player.toLowerCase(), String(nickname ?? '') || null);
  return { status: 200, body: { session: id, gen: gen.gen, jackpot: await db.jackpot() } };
}

/**
 * seat a player whose stake arrived as a machine payment (an agent paying over http 402).
 * the payment layer has already verified the money and burned the credential, so this only checks
 * the hash is new, grows the pot and opens the game. a game that purse already had open is closed:
 * they paid for a fresh one.
 */
export async function openPaidSession(player: string, nickname: string | null, stakeTx: string) {
  if (!player || !isAddress(player)) return { status: 400, body: { error: 'no address to play as' } };
  if (await db.stakeSeen(stakeTx)) return { status: 409, body: { error: 'that payment was already used' } };
  const gen = await db.currentGeneration();
  const open = await db.openSessionFor(player);
  if (open) await db.updateSession(open.id, JSON.parse(open.transcript), open.turns, open.gen === gen.gen ? 'abandoned' : 'stale');
  const id = randomBytes(12).toString('hex');
  const opened = await db.openStaked({ sessionId: id, gen: gen.gen, player, nickname: cleanNick(nickname), amount: STAKE, txHash: stakeTx, toPot: STAKE * JACKPOT_SHARE, via: 'mpp' });
  if (!opened) return { status: 409, body: { error: 'that payment was already used' } };
  forgetAwake(); // the stake is in the wallet now, and part of it is thinking money
  return { status: 200, body: { session: id, gen: gen.gen, jackpot: await db.jackpot() } };
}

/**
 * the rest of an interrupted game, for a player who holds its session id (an agent has no purse to
 * sign with; the id of the game it paid for is its proof). returns null when there is nothing to carry.
 */
export async function carryOn(sessionId: string) {
  const old = await db.getSession(String(sessionId));
  if (!old) return null;
  const gen = await db.currentGeneration();
  // a game left open against rules that have since changed is over; say so before looking for what is left of it.
  if (old.status === 'open' && old.gen !== gen.gen) await db.updateSession(old.id, JSON.parse(old.transcript), old.turns, 'stale');
  const id = randomBytes(12).toString('hex');
  const carried = await db.takeCarry({ sessionId: old.id }, MAX_TURNS, id, gen.gen, null);
  return carried ? { session: id, gen: gen.gen, jackpot: await db.jackpot(), turnsLeft: MAX_TURNS - carried.turns, player: carried.player } : null;
}

/** is this purse already in a game? a plain read, so the client never has to provoke an error to ask. */
export async function peek(player: string) {
  if (!player || !isAddress(player)) return { status: 400, body: { error: 'no purse' } };
  const gen = await db.currentGeneration();
  const open = await db.openSessionFor(player);
  if (!open || open.gen !== gen.gen) {
    // a game still marked open against old rules is over. what is left of it, if it was paid for, is waiting.
    if (open) await db.updateSession(open.id, JSON.parse(open.transcript), open.turns, 'stale');
    const waiting = await db.carryFor(player, MAX_TURNS);
    return { status: 200, body: { session: null, gen: gen.gen, carry: waiting ? { turnsLeft: MAX_TURNS - waiting.turns } : null } };
  }
  return { status: 200, body: { session: open.id, gen: open.gen, resumed: true, turnsLeft: MAX_TURNS - open.turns, transcript: JSON.parse(open.transcript), stake: await db.stakeOf(open.id) } };
}

/**
 * walk away from the conversation you are in.
 *
 * a fresh context is a real advantage: the ai remembers nothing between games, so starting over
 * clears a line of attack that has poisoned the thread. if that were free, the message ceiling on a
 * stake would mean nothing, so it is not free: abandoning forfeits whatever is left of the game and
 * the next message buys a new one. knowing the session id is the only authority needed; it is a
 * secret the player's own browser holds.
 */
export async function abandon(sessionId: string) {
  const s = await db.getSession(String(sessionId));
  if (!s) return { status: 404, body: { error: 'no such session' } };
  if (s.status === 'open') await db.updateSession(s.id, JSON.parse(s.transcript), s.turns, 'abandoned');
  return { status: 200, body: { ok: true } };
}

export async function runChat(sessionId: string, message: string, onDelta?: (t: string) => void): Promise<ChatResult & { hardening?: Promise<void> }> {
  // a nul character cannot be stored. left in, a message that won would be replayed in the lesson,
  // paid for, and then refused by the database when the lesson tried to keep it, over and over.
  if (typeof message === 'string') message = message.replace(/\u0000/g, '');
  if (typeof message !== 'string' || !message.trim()) return { status: 400, body: { error: 'say something' } };
  if (message.length > MAX_MESSAGE_CHARS) return { status: 400, body: { error: `${MAX_MESSAGE_CHARS} characters max` } };
  const seen = await db.getSession(String(sessionId));
  if (!seen) return { status: 404, body: { error: 'no such session' } };
  if (seen.status !== 'open') return { status: 409, body: { error: `session is ${seen.status}` } };
  // a win it has not learned from yet (the lesson is running, was cut short, or could not be paid
  // for) leaves a beaten generation with its winning conversation in public view. nobody plays that
  // generation: the lesson is picked back up here if it is due, and the caller is told the truth
  // about the wait. a lesson running or due is a minute away; one waiting its turn after a failed
  // try says how long; one waiting for money is the house asleep.
  const lesson = await lessonNow();
  if (lesson) return { status: 503, hardening: resumeHardening(), body: { error: `${lessonLine(lesson)}. that message did not count.`, learning: true, retry_after: lesson.retryIn } };
  const unlearned = await db.unfinishedWin();
  if (unlearned) {
    const can = await lessonCan(unlearned);
    return { status: 503, hardening: resumeHardening(), body: { error: `it is asleep: ${can.why || 'it cannot pay to learn from a loss yet'}. your game is still open, and that message did not count.`, asleep: true, ...(can.wakesIn ? { retry_after: can.wakesIn } : {}) } };
  }
  // one message at a time in a game. everything below reads the game again, now that nothing else can change it.
  if (!(await db.beginTurn(seen.id))) return { status: 429, body: { error: 'one message at a time: wait for the reply.', retryIn: 2, why: 'busy' } };
  try {
    return await turn((await db.getSession(seen.id))!, message.trim(), onDelta);
  } finally {
    await db.endTurn(seen.id).catch(() => {});
  }
}

/** one exchange in a game that is known to be open and held by this request. */
async function turn(s: db.SessionRow, message: string, onDelta?: (t: string) => void): Promise<ChatResult & { hardening?: Promise<void> }> {
  const gen = await db.currentGeneration();
  if (s.gen !== gen.gen) {
    await db.updateSession(s.id, JSON.parse(s.transcript), s.turns, 'stale');
    const carry = !FREE_PLAYERS.has(s.player) && s.turns < MAX_TURNS && (await db.sessionPaid(s.id));
    return { status: 409, body: carry
      ? { error: 'it learned something while you were talking. the messages you had left carry over: go again, no charge.', carry: { turnsLeft: MAX_TURNS - s.turns } }
      : { error: 'it learned something while you were talking. go again.' } };
  }
  if (s.turns >= MAX_TURNS) { await db.updateSession(s.id, JSON.parse(s.transcript), s.turns, 'exhausted'); return { status: 409, body: { error: 'this conversation has run its course' } }; }

  // rate limits: the only thing standing between one player and everyone else's inference budget.
  // silent until hit, and the machine plays outside them.
  if (!FREE_PLAYERS.has(s.player)) {
    const mine = await db.rateAllow(`p:${s.player}`, RATE.player.max, RATE.player.seconds);
    // a refusal for being busy says which kind and for how long. the message did not count: the page
    // waits it out and sends it again by itself, and an agent can do the same.
    if (mine) return { status: 429, body: { error: `easy — ${mine}s`, retryIn: mine, why: 'fast' } };
    const all = await db.rateAllow('global', RATE.global.max, RATE.global.seconds);
    if (all) return { status: 429, body: { error: `everyone is playing at once. ${all}s`, retryIn: all, why: 'crowd' } };
  }

  const history: Turn[] = JSON.parse(s.transcript);
  const preamble = about(gen.gen, await db.jackpot());
  const free = FREE_PLAYERS.has(s.player);
  let produced: Turn[];
  try {
    produced = onDelta ? await stepStream(gen.policy, history, message, onDelta, preamble, free ? 'machine' : 'chat') : await step(gen.policy, history, message, preamble, free ? 'machine' : 'chat');
  } catch (e) {
    // it could not pay for this thought. the turn was not taken and the game stays open.
    if (e instanceof Broke) { console.warn(`[chat] broke: ${e.message}`); return { status: 503, body: { error: 'it cannot afford to think right now. your game is still open and that message did not count.', asleep: true } }; }
    throw e;
  }
  const transcript = [...history, ...produced];
  const turns = s.turns + 1;

  if (saidIt(produced[1]?.text || '')) {
    // the pot, the end of the game and the record of the win, in one step. paid after it has learned.
    // real stakes: what the house lacks for the lesson this win sets off is kept back from the pot, up to its share of it.
    const levy = !free && LEVY > 0 ? { share: LEVY, upTo: await lessonLack(JACKPOT_SEED) } : undefined;
    const w = await db.recordWin({ gen: gen.gen, sessionId: s.id, player: s.player, nickname: s.nickname, transcript, turns, paying: !free, levy });
    forgetAwake(); // the pot has become a prize, less what was kept for the lesson: what is free is not what it was
    const hardening = runHardening(gen, w.winId, w.prize);
    if (w.late) {
      const left = MAX_TURNS - turns;
      return { status: 200, hardening, body: { turns: produced, turnsLeft: 0,
        win: { id: w.winId, prize: 0, late: true, ...(left > 0 ? { carry: { turnsLeft: left } } : {}) } } };
    }
    return { status: 200, hardening, body: { turns: produced, turnsLeft: 0, win: { id: w.winId, prize: w.prize, ...(w.levy > 0 ? { levy: w.levy } : {}) } } };
  }

  await db.updateSession(s.id, transcript, turns, turns >= MAX_TURNS ? 'exhausted' : 'open');
  return { status: 200, body: { turns: produced, turnsLeft: MAX_TURNS - turns, win: null } };
}

/** learn from the win, then pay it. one at a time across every function instance, via a db lock. */
export async function runHardening(failed: db.Generation, winId: number, prize: number): Promise<void> {
  // this request may have used most of its time already (the machine plays a whole game before it
  // wins). a lesson squeezed into what is left would be cut short, so it is left for the next request,
  // which has a full allowance: the win stays unlearned, nobody plays that generation meanwhile, and
  // the first page or message to arrive picks the lesson up.
  if (lessonDeadline() - Date.now() < LESSON_MIN_MS) { console.warn(`[immune] win #${winId}: too little of this request left for a lesson; the next request picks it up`); return; }
  if (!(await db.acquireLock(LOCK, String(winId)))) return;
  const report = (phase: string) => db.setLockPhase(LOCK, phase);
  const deadline = lessonDeadline();
  let started = false;
  try {
    await report('reading');
    const win = (await db.breachById(winId))!;
    // the machine's wins are learned from on the machine's allowance, never on the players' share for lessons.
    const budget = lessonBudget(win);
    // a lesson is not begun on less than it needs: one that runs out part-way has paid for work it
    // throws away. asked before the start is counted, so waiting for money is never an attempt.
    const can = await lessonCan(win);
    if (!can.ok) throw new Broke(can.why || 'cannot afford the lesson', 'asleep');
    // a lesson that has been started twice already and never finished gets the short version:
    // one rewrite, tested against the conversation that beat it. the game moves on either way.
    const attempts = await db.lessonStarted(winId);
    started = true;
    // real stakes: with less free than a whole lesson costs, it is the short one from the start.
    const short = LEVY > 0 && can.available !== null && can.available < LESSON_NEED;
    const minimal = attempts > 2 || short;
    if (minimal) console.warn(`[immune] win #${winId}: ${short ? `$${can.available} free for the lesson` : `lesson attempt ${attempts}`}, taking the short version`);
    console.log(`[immune] gen ${failed.gen} beaten (#${winId}); learning...`);
    const out = await harden(failed.policy, win, await db.allBreaches(), report, budget, { deadline, minimal, fallBack: LEVY > 0 });
    const nextGen = failed.gen + 1;
    for (const round of out.log) for (const r of round.results) await db.recordRegression(nextGen, round.round, r.breachId, r.kind, r.passed, `${r.name}: ${r.detail}`);
    if (out.autoimmune) await db.markAutoimmune(winId);
    await report('noting the lesson');
    // a lesson cut short for want of lesson money has nothing to ask the model for a summary with. it says what happened.
    const lesson = out.cutShort
      ? 'the day\'s money for lessons ran out part-way through this one: the new rules were written, and not all of the tests on them could be run.'
      : await summarise(JSON.parse(win.transcript), failed.policy, out.policy, budget);
    if (out.cutShort) console.warn(`[immune] win #${winId}: today's lesson budget ran out mid-lesson. gen ${failed.gen + 1} ships its rewrite with the tests it got through.`);
    await db.createGeneration(nextGen, out.policy, winId, out.rounds, out.regressionPassed, out.legitPassed, lesson);
    console.log(`[immune] gen ${nextGen} live after ${out.rounds} round(s). regression=${out.regressionPassed} alive=${out.legitPassed} autoimmune=${out.autoimmune}`);
    if (prize > 0) { await report('paying out'); await payout((await db.breachById(winId))!); }
  } catch (e) {
    // out of money, or out of the day's budget: the lesson waits, and the start it made does not
    // count towards the short version. anything else (a payment that failed, a seller that did not
    // answer, a fault here) is a real failed attempt, and it is counted: the next one comes later
    // and, after two, smaller. a lesson is never retried at full size for ever.
    const waiting = e instanceof Broke && (e.kind === 'asleep' || e.kind === 'budget');
    if (waiting) {
      console.warn(`[immune] learning from win #${winId} paused: ${(e as Error).message}`);
      if (started) await db.lessonPaused(winId).catch(() => {});
    } else console.error(`[immune] learning from win #${winId} failed`, e instanceof Broke ? e.message : e);
    if (started) await db.lessonEnded(winId).catch(() => {});
    // the lesson is not done. the prize does not wait for it: it was won, it is set aside, and prize
    // money is not thinking money. a winner is not kept waiting on the house's other pocket.
    if (prize > 0) {
      try { const held = await payout((await db.breachById(winId))!); if (held) console.warn(`[payout] win #${winId} not paid yet: ${held}`); }
      catch (err) { console.error('[payout] while the lesson waits:', (err as Error).message); }
    }
  } finally {
    await db.releaseLock(LOCK);
  }
}

/**
 * a hardening runs inside a function that can be killed or time out. nothing about that is
 * guaranteed, so nothing depends on it: if a win never produced its next generation and no one holds
 * the lock, the next request to come along picks the work back up. the game converges no matter how
 * many instances die along the way.
 */
/**
 * is the house selling games? only when it could afford to learn from losing one: a reply, and after
 * it a whole lesson, with room for that in the wallet, under the day's ceiling and in the share of it
 * kept for lessons. a game sold on less is a game whose win would leave a beaten generation in public
 * view with no money to fix it, and the house asleep with no way to wake itself.
 *
 * this is the question asked before a stake is taken and the one the page is shown. `awake` is the
 * narrower one, asked before each thought: can this thought be paid for.
 */
export const playable = (fresh = false): Promise<Awake> => LEVY > 0
  // real stakes (see LEVY in think.ts): the stake about to arrive pays for its own game, and a win
  // brings the money for its own lesson with it. so the house sells whenever this game's replies
  // can be paid for once its stake has landed, even from an empty wallet.
  // (a pot that is filled back up after a win is filled from this wallet: that much has to be free already.)
  ? canSell(fresh, STAKE * (1 - JACKPOT_SHARE), JACKPOT_SEED)
  : canLearn('house', fresh, SHARED ? JACKPOT_SEED : 0);
/**
 * may the machine play? its games bring no stake and its wins no levy, so on real stakes the house
 * must already hold what a game and the short lesson after it could cost. otherwise a machine win
 * on a poor house would leave a lost game that nothing is coming to pay for.
 */
export const machineMayPlay = async (): Promise<boolean> => (await playable()).ok && (LEVY > 0 ? (await canLearn('machine', false, 0, LESSON_MIN + GAME_NEED)).ok : true);
/** can this win's lesson be begun? the price of a lesson free, or on real stakes the price of a short one. */
const lessonCan = (win: db.Breach) => canLearn(lessonBudget(win), false, 0, LEVY > 0 ? LESSON_MIN : LESSON_NEED);
/** whose money a win's lesson is paid from: the machine's own wins are learned from on the machine's account. */
const lessonBudget = (win: db.Breach) => FREE_PLAYERS.has(win.player) ? 'machine' as const : 'house' as const;
/**
 * a lesson that was started and did not finish is not started again at once. each start doubles the
 * wait, counted from when the last one ended: twenty seconds, forty, up to an hour. a seller that is
 * down, or a rewrite that keeps failing, is not paid for every few seconds by whoever has the page
 * open, and a lesson that can never succeed costs a few short tries a day, not the day's budget.
 */
const RETRY_FIRST_MS = 20_000, RETRY_MAX_MS = 3_600_000;
/** how long until a lesson may be tried again, in milliseconds. 0: now. */
export function retryWait(tries: number, triedAt: string | Date | null | undefined, now = Date.now()): number {
  if (!(tries > 0) || !triedAt) return 0;
  const wait = Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** Math.min(tries - 1, 12));
  return Math.max(0, new Date(triedAt).getTime() + wait - now);
}
const waitFor = (win: db.Breach) => retryWait(Number(win.tries || 0), win.tried_at);

/**
 * the lesson standing between players and this generation, if there is one: running, due, or
 * waiting its turn after a failed try. null when there is none, and also when there is one that
 * cannot be paid for: that is the house asleep (see `playable`), not learning. this is what the
 * page is shown as "learning", and what turns a new game away before any money is asked for.
 */
export type Lesson = { phase: string; retryIn: number };
const span = (s: number) => s < 90 ? 'a minute' : s < 5400 ? `${Math.round(s / 60)} minutes` : 'an hour';
export async function lessonNow(): Promise<Lesson | null> {
  const [phase, win] = await Promise.all([db.lockPhase(LOCK), db.unfinishedWin()]);
  // the lock is also held, for a moment, to pay a prize whose lesson is waiting: that is not a lesson running.
  if (phase && !(win && /^paying/.test(phase))) return { phase: /^\d+$/.test(phase) ? 'reading the conversation that beat it' : phase, retryIn: 30 };
  if (!win || !(await lessonCan(win)).ok) return null;
  const wait = Math.ceil(waitFor(win) / 1000);
  return wait > 0 ? { phase: `could not finish; trying again in about ${span(wait)}`, retryIn: wait + 30 } : { phase: 'about to begin', retryIn: 30 };
}
/** the same, as a sentence for whoever was turned away. the caller adds what it cost them: nothing. */
export const lessonLine = (l: Lesson) => l.retryIn <= 60 ? 'it is learning from a win: try again in a minute' : `it lost and has not managed to learn from it yet: it tries again in about ${span(l.retryIn - 30)}`;
/** is anything at all unlearned or being learned? asked before a carried-over game is handed back. */
const lessonPending = async () => !!(await db.lockSince(LOCK)) || !!(await db.unfinishedWin());

/**
 * prizes that were won on a generation whose lesson is waiting for money. they were won, they are set
 * aside, and prize money is not thinking money: they are paid without waiting for the lesson. every
 * one of them, not only the newest win: two wins can land on one generation, and the later one may
 * be worth nothing while the earlier one took the pot. paid under the lesson's own lock, so nothing
 * else can be paying the same win at the same moment; looked at once a minute at most, and the lock
 * is not touched at all unless something can actually be sent.
 */
let lastWaitingLook = 0;
async function payWaiting(): Promise<void> {
  if (flag('PAYOUTS_OFF') || Date.now() - lastWaitingLook < 60_000) return;
  lastWaitingLook = Date.now();
  const sendable: db.Breach[] = [];
  for (const w of await db.owedUnlearned()) if (!(await db.payableAt(w.player, PURSE_DAILY_CAP)).at) sendable.push(w);
  if (!sendable.length || !(await db.acquireLock(LOCK, 'paying'))) return;
  try {
    await db.setLockPhase(LOCK, 'paying out');
    for (const w of sendable) {
      const fresh = await db.breachById(w.id);
      if (!fresh || owedOf(fresh) <= 0) continue;
      const held = await payout(fresh);
      if (held) console.warn(`[payout] win #${w.id} not paid yet, while its lesson waits for thinking money: ${held}`);
    }
  } catch (e) { console.error('[payout] while a lesson waits:', (e as Error).message); }
  finally { await db.releaseLock(LOCK); }
}

export async function resumeHardening(): Promise<void> {
  if (await db.lockSince(LOCK)) return;
  const win = await db.unfinishedWin();
  if (!win) return;
  // learning costs thoughts, and waits until they can be paid for, and for its turn if it has already
  // been tried. the prizes do not wait with it.
  if (waitFor(win) > 0 || !(await lessonCan(win)).ok) return void (await payWaiting());
  const failed = await db.getGeneration(win.gen);
  if (!failed) return;
  console.log(`[immune] resuming an unfinished hardening for win #${win.id}`);
  await runHardening(failed, win.id, owedOf(win));
}

/**
 * the payout. the daily cap is the safety valve between the model and the money.
 * returns why the win is not yet paid in full, or null when it is. a win that is put off stays owed:
 * `settleUnpaid` comes back for it. the pot has no ceiling and the caps do, so a prize can be bigger
 * than a cap; it is paid in parts as the window rolls, never refused outright. PAYOUTS_OFF=1 is the
 * operator's brake: wins are still recorded and still owed, and nothing leaves the house until it is
 * released.
 */
const owedOf = (w: db.Breach) => (w.tx_hash ? 0 : Math.max(0, Number(w.amount) - Number(w.paid ?? 0)));
async function payout(given: db.Breach): Promise<string | null> {
  // first, anything already sent towards this win and not yet accounted for. nothing new is signed
  // until the chain has said what became of it: that is what makes a prize impossible to pay twice.
  for (const p of await db.paymentsInFlight(given.id)) {
    const o = await treasury.outcomeOf(p.tx_hash, Number(p.valid_before ?? 0));
    if (o === 'landed') { await db.landPayment(p.id, given.id, Number(p.amount), p.tx_hash); console.log(`[payout] win #${given.id}: an earlier payment of $${p.amount} had landed (${p.tx_hash})`); }
    else if (o === 'failed' || o === 'expired') { await db.releaseReservation(p.id); console.warn(`[payout] win #${given.id}: an earlier payment ${o === 'failed' ? 'was refused' : 'never landed'}; its money is free again`); }
    else return 'an earlier payment for this win is still in flight';
  }
  const win = (await db.breachById(given.id))!;
  const owed = owedOf(win);
  if (owed <= 0) return null;
  if (flag('PAYOUTS_OFF')) { console.warn(`[payout] win #${win.id} held: payouts are switched off`); return 'payouts are switched off'; }
  const rsv = await db.reserveUpTo(win.player, owed, PURSE_DAILY_CAP, win.session_id, win.id);
  if (!rsv.ok) { console.warn(`[payout] win #${win.id} deferred: ${rsv.why}`); return rsv.why; }
  let signed: treasury.Signed;
  try { signed = await treasury.signPayment(win.player, rsv.amount); }
  catch (e) { await db.releaseReservation(rsv.id); console.error(`[payout] win #${win.id} could not be signed: ${(e as Error).message}`); return `transfer failed: ${(e as Error).message.slice(0, 120)}`; }
  // written down before it is sent: from here on the chain can always be asked what happened to it.
  await db.signedReservation(rsv.id, signed.hash, signed.validBefore);
  const written = signed.hash;
  const o = await treasury.broadcast(signed);
  // the node may know the payment by another name than the one worked out before sending. that is the name on record from here on.
  if (signed.hash !== written) await db.signedReservation(rsv.id, signed.hash, signed.validBefore);
  if (o === 'failed' || o === 'expired') { await db.releaseReservation(rsv.id); console.error(`[payout] win #${win.id}: the transfer ${o === 'failed' ? 'was refused' : 'never landed'}`); return 'transfer failed'; }
  if (o !== 'landed') { console.warn(`[payout] win #${win.id}: payment ${signed.hash} sent, not yet seen. it will be looked up before anything else is sent.`); return 'a payment is in flight'; }
  // confirmed and credited to the win together. if this does not get written, the payment is still
  // on record as signed and unconfirmed, and the next sweep finds it on the chain and writes it then.
  await db.landPayment(rsv.id, win.id, rsv.amount, signed.hash);
  const left = owed - rsv.amount;
  console.log(`[payout] win #${win.id}: $${rsv.amount}${left > 0.000001 ? ` of $${owed}, $${left.toFixed(6)} still owed` : ''} (${signed.hash})`);
  return left > 0.000001 ? 'part paid: the rest waits for the daily cap' : null;
}

/**
 * pay what is owed. a win whose payout was put off (a cap, a failed transfer, the brake) used to stay
 * unpaid forever, because the only thing that ever paid a win was the hardening that followed it.
 * this walks the owed wins oldest first, under its own lock so two instances cannot pay the same one,
 * and re-reads each win inside the lock before sending.
 */
const PAY_LOCK = 'payout';
export async function settleUnpaid(): Promise<{ paid: number[]; held: { id: number; why: string }[] }> {
  const out = { paid: [] as number[], held: [] as { id: number; why: string }[] };
  if (await db.lockSince(LOCK)) return out; // a hardening pays its own win; do not race it
  if (!(await db.acquireLock(PAY_LOCK, 'settle'))) return out;
  try {
    for (const w of await db.unpaidWins()) {
      const fresh = await db.breachById(w.id);
      if (!fresh || owedOf(fresh) <= 0) continue;
      const why = await payout(fresh);
      if (!why) { out.paid.push(w.id); continue; }
      out.held.push({ id: w.id, why });
      // the house-wide reasons hold everyone behind this win too; a purse's own cap holds only that purse.
      if (why === 'daily cap' || why === 'payouts are switched off') break;
    }
  } finally {
    await db.releaseLock(PAY_LOCK);
  }
  return out;
}
