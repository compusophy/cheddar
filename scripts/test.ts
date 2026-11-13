/** tests for the rules that live in code: the win check, the jackpot, and the payout cap. run: npm test */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import * as db from '../src/db';
import { DAILY_CAP, JACKPOT_SEED, saidIt } from '../src/game';
import { suiteFor, pooled, REGRESSION_MAX } from '../src/immune';
import { network } from '../src/visitor';
import { retryWait, lessonLine } from '../src/chat';

let passed = 0; const failures: string[] = [];
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) { passed++; console.log(`  ok   ${name}`); } else { failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

async function main() {
  // these tests write rows of their own and, for a moment at a time, change the pot. on play money
  // that is harmless. on real money a game could be won against a pot a test had set.
  if ((process.env.NETWORK || 'testnet').trim().toLowerCase() === 'mainnet') { console.error('refusing to run: NETWORK=mainnet. these tests change the pot while they run. point DATABASE_URL at a scratch database and unset NETWORK.'); process.exit(2); }
  await db.init();
  console.log('the word');
  check('plain', saidIt('i love cheese'));
  check('capitalised', saidIt('CHEESE!'));
  check('inside a longer word', saidIt('cheeseburger'));
  check('absent', !saidIt('i love pizza'));
  check('spaced out does not count', !saidIt('c h e e s e'));

  console.log('the jackpot');
  const before = await db.jackpot();
  const fakeTx = '0x' + 'ab'.repeat(32);
  check('a fresh stake hash is unseen', !(await db.stakeSeen(fakeTx)));
  await db.recordStake('test-session', '0x000000000000000000000000000000000000dEaD', 0.25, fakeTx, 0.2);
  check('a stake grows the pot by its jackpot share', Math.abs((await db.jackpot()) - (before + 0.2)) < 1e-9);
  check('a used stake hash is seen, so it cannot be replayed', await db.stakeSeen(fakeTx));
  const taken = await db.claimJackpot();
  check('a win takes the whole pot', Math.abs(taken - (before + 0.2)) < 1e-9, `${taken}`);
  check('the pot resets to the seed', Math.abs((await db.jackpot()) - JACKPOT_SEED) < 1e-9);
  const second = await db.claimJackpot();
  check('a second claim gets only the seed, never the first prize again', Math.abs(second - JACKPOT_SEED) < 1e-9);
  await db.sql`DELETE FROM stakes WHERE tx_hash = ${fakeTx}`;
  await db.sql`UPDATE jackpot SET amount = ${before} WHERE id = 1`;

  console.log('abuse gates');
  const p1 = '0x00000000000000000000000000000000000000a1';
  check('a purse with no game open is free to play', !(await db.hasOpenSession(p1)));
  await db.createSession('gate-test', 0, p1, null);
  check('a purse with a game open resumes it', (await db.openSessionFor(p1))?.id === 'gate-test');
  await db.sql`UPDATE sessions SET updated_at = now() - interval '5 hours' WHERE id = 'gate-test'`;
  check('however long it has sat: a paid game is not forgotten for being idle', (await db.openSessionFor(p1))?.id === 'gate-test');
  await db.updateSession('gate-test', [], 0, 'exhausted');
  check('a finished game frees the purse', !(await db.hasOpenSession(p1)));
  await db.sql`DELETE FROM sessions WHERE id = 'gate-test'`;
  check('a fresh purse has no wait for its dollar from the house', (await db.faucetWaits(p1)) === 0);
  check('it takes it', await db.claimFaucet(p1));
  check('and cannot take another the same day', !(await db.claimFaucet(p1)));
  const wait = await db.faucetWaits(p1);
  check('it is told how long until the next one: a day', wait > 86300 && wait <= 86400, String(wait));
  await db.sql`UPDATE locks SET taken_at = now() - interval '23 hours' WHERE name = ${'faucet-' + p1}`;
  check('23 hours on it still waits, about an hour', !(await db.claimFaucet(p1)) && Math.abs((await db.faucetWaits(p1)) - 3600) < 5, String(await db.faucetWaits(p1)));
  await db.sql`UPDATE locks SET taken_at = now() - interval '25 hours' WHERE name = ${'faucet-' + p1}`;
  const dayOn = await Promise.all(Array.from({ length: 8 }, () => db.claimFaucet(p1)));
  check('a day on, eight requests at once: one more dollar, not eight', dayOn.filter(Boolean).length === 1, JSON.stringify(dayOn));
  await db.sql`DELETE FROM locks WHERE name = ${'faucet-' + p1}`;

  console.log('the payout cap');
  const dead = '0x000000000000000000000000000000000000dEaD';
  const spent = await db.spentLast24h();
  const tooBig = await db.reserveDisbursement(dead, DAILY_CAP + 1, null);
  check('over the whole cap is refused', !tooBig.ok); if (tooBig.ok) await db.releaseReservation(tooBig.id);
  const small = await db.reserveDisbursement(dead, 0.01, null);
  check('within the allowance is granted', small.ok);
  if (small.ok) { await db.releaseReservation(small.id); check('a failed payout returns the headroom', Math.abs((await db.spentLast24h()) - spent) < 1e-9); }

  console.log('a prize bigger than a cap is paid in parts, never refused');
  const big = '0x00000000000000000000000000000000000000b1';
  const first = await db.reserveUpTo(big, 50, 20, null);
  check('the first part is as much as the purse cap allows', first.ok && Math.abs(first.amount - Math.min(20, DAILY_CAP - spent)) < 1e-6, JSON.stringify(first));
  const more = await db.reserveUpTo(big, 30, 20, null);
  check('nothing more for that purse inside the same day', !more.ok, JSON.stringify(more));
  const other = await db.reserveUpTo('0x00000000000000000000000000000000000000b2', 0.004, 20, null);
  check('less than a cent is still paid when that is all that is owed', other.ok && Math.abs(other.amount - 0.004) < 1e-9, JSON.stringify(other));
  if (first.ok) await db.releaseReservation(first.id);
  if (other.ok) await db.releaseReservation(other.id);
  check('released parts return the headroom', Math.abs((await db.spentLast24h()) - spent) < 1e-9);

  console.log('a win stays owed until every part has left the house');
  await db.createSession('owed-test', 0, big, null);
  const winId = await db.recordBreach({ gen: 0, session_id: 'owed-test', player: big, nickname: null, recipient: big, amount: 50, tx_hash: null, transcript: '[]' });
  await db.addPayment(winId, 20, '0x' + '01'.repeat(32));
  let w = (await db.breachById(winId))!;
  check('a part payment does not mark the win paid', !w.tx_hash && Math.abs(Number(w.paid) - 20) < 1e-9, JSON.stringify({ tx: w.tx_hash, paid: w.paid }));
  await db.addPayment(winId, 30, '0x' + '02'.repeat(32));
  w = (await db.breachById(winId))!;
  check('the last part does', !!w.tx_hash && Math.abs(Number(w.paid) - 50) < 1e-9, JSON.stringify({ tx: w.tx_hash, paid: w.paid }));
  await db.sql`DELETE FROM breaches WHERE id = ${winId}`;
  await db.sql`DELETE FROM sessions WHERE id = 'owed-test'`;

  console.log('thinking money: a thought is set aside before it is paid for');
  const spentBefore = await db.thoughtSpent24h();
  const t1 = await db.reserveThought('chat', 'test-model', 0.01, spentBefore + 0.025);
  check('a thought inside the day\'s budget is reserved', t1.ok, JSON.stringify(t1));
  const t2 = await db.reserveThought('chat', 'test-model', 0.01, spentBefore + 0.025);
  check('so is the next one', t2.ok, JSON.stringify(t2));
  const t3 = await db.reserveThought('chat', 'test-model', 0.01, spentBefore + 0.025);
  check('the one that would go over the budget is refused', !t3.ok && /budget/.test((t3 as any).why), JSON.stringify(t3));
  check('what was reserved counts as spent', Math.abs((await db.thoughtSpent24h()) - (spentBefore + 0.02)) < 1e-9);
  const machineBefore = await db.thoughtSpent24h('machine');
  const machineAllBefore = await db.machineSpent24h();
  const pocket = { purposes: ['machine'], cap: machineBefore + 0.005, name: 'machine' };
  const m1 = await db.reserveThought('machine', 'test-model', 0.004, 1000, pocket);
  check('the machine thinks on its own allowance', m1.ok, JSON.stringify(m1));
  const m2 = await db.reserveThought('machine', 'test-model', 0.004, 1000, pocket);
  check('and stops when the allowance is gone, however much the house has left', !m2.ok && /machine/.test((m2 as any).why), JSON.stringify(m2));
  const c1 = await db.reserveThought('chat', 'test-model', 0.004, 1000);
  check('a player\'s thought is not held back by the machine\'s allowance', c1.ok, JSON.stringify(c1));
  const l1 = await db.reserveThought('machine-lesson', 'test-model', 0.003, 1000);
  check('a lesson from the machine\'s win is never refused for the allowance', l1.ok, JSON.stringify(l1));
  check('but it counts towards what the machine has cost today', Math.abs((await db.machineSpent24h()) - (machineAllBefore + 0.004 + 0.003)) < 1e-9, String(await db.machineSpent24h()));
  if (l1.ok) await db.releaseThought(l1.id);
  // lessons after players' wins have a share of the day too: rewriting, replaying and noting the lesson, counted together.
  const lessonsBefore = (await db.thoughtSpent24h('patch')) + (await db.thoughtSpent24h('test')) + (await db.thoughtSpent24h('lesson'));
  const forLessons = { purposes: ['patch', 'test', 'lesson'], cap: lessonsBefore + 0.005, name: 'lesson' };
  const s1 = await db.reserveThought('test', 'test-model', 0.003, 1000, forLessons);
  const s2 = await db.reserveThought('patch', 'test-model', 0.003, 1000, forLessons);
  check('a lesson thinks on the day\'s share for lessons, whichever part of the lesson it is', s1.ok && !s2.ok && (s2 as any).share === true && /lesson/.test((s2 as any).why), JSON.stringify([s1, s2]));
  const c2 = await db.reserveThought('chat', 'test-model', 0.003, 1000);
  check('and a reply to a player is not held back when that share is gone', c2.ok, JSON.stringify(c2));
  const dayGone = await db.reserveThought('test', 'test-model', 0.003, (await db.thoughtSpent24h()) + 0.001, { ...forLessons, cap: 1000 });
  check('running out of the whole day is not the same thing as running out of a share', !dayGone.ok && (dayGone as any).share === undefined, JSON.stringify(dayGone));
  for (const t of [s1, s2, c2]) if (t.ok) await db.releaseThought(t.id);
  if (t1.ok) await db.settleThought(t1.id, '0x' + '0a'.repeat(32));
  check('a settled thought shows up in the public list with its payment', (await db.recentThoughts(50)).some((t) => t.tx_hash === '0x' + '0a'.repeat(32)));
  for (const t of [t1, t2, m1, c1]) if (t.ok) await db.releaseThought(t.id);
  check('a released thought gives its money back to the budget', Math.abs((await db.thoughtSpent24h()) - spentBefore) < 1e-9);

  console.log('a ledger belongs to the network it was built on');
  check('a marked ledger belongs where its mark says, whoever starts it', db.ledgerHome('testnet', true, 'mainnet') === 'testnet' && db.ledgerHome('mainnet', false, 'testnet') === 'mainnet');
  check('a new, empty one belongs to whoever starts it', db.ledgerHome(null, false, 'mainnet') === 'mainnet' && db.ledgerHome(null, false, 'testnet') === 'testnet');
  check('one with games in it and no mark is older than real money: it is play money, even when mainnet is starting it', db.ledgerHome(null, true, 'mainnet') === 'testnet');
  check('a reset is guarded when the game is on real money, and when the ledger is, whatever the process thinks', db.resetIsGuarded(true, 'mainnet') && db.resetIsGuarded(true, null) && db.resetIsGuarded(false, 'mainnet'));
  check('a play-money game resetting a play-money ledger, or a new one, is not', !db.resetIsGuarded(false, 'testnet') && !db.resetIsGuarded(false, null));
  const [mark] = await db.sql<{ value: string }[]>`SELECT value FROM ledger_mark WHERE key = 'network'`;
  check('and this database carries the mark of the network these tests run on', mark?.value === 'testnet', String(mark?.value));

  console.log('a spent budget says when it will have room again');
  const ago = (hours: number) => new Date(Date.now() - hours * 3600_000);
  const hoursUntil = (d: Date | null) => (d ? (d.getTime() - Date.now()) / 3600_000 : NaN);
  // three thoughts in the last day: 0.50 spent 20 hours ago, 0.30 spent 10 hours ago, 0.20 spent 1 hour ago
  const day = [{ amount: 0.5, at: ago(20) }, { amount: 0.3, at: ago(10) }, { amount: 0.2, at: ago(1) }];
  check('with nothing spent there is room now', db.freesAt([], 1, 0.05) === null);
  check('a budget of 1.00, all spent: room for a nickel when the oldest half-dollar turns a day old, in 4 hours', Math.abs(hoursUntil(db.freesAt(day, 1, 0.05)) - 4) < 0.01, String(hoursUntil(db.freesAt(day, 1, 0.05))));
  check('room for 60 cents takes until the second one has gone too, in 14 hours', Math.abs(hoursUntil(db.freesAt(day, 1, 0.6)) - 14) < 0.01, String(hoursUntil(db.freesAt(day, 1, 0.6))));
  check('a bigger budget has room already', db.freesAt(day, 2, 0.05) === null);
  check('asking for more room than the whole budget has no answer', db.freesAt(day, 1, 1.5) === null);
  const live = await db.thinkingFreesAt(1e9, 0.05);
  check('and the real ledger can be asked the same question', live === null, String(live));

  console.log('the regression suite stays small however often one generation is beaten');
  const mk = (id: number, gen: number) => ({ id, gen, session_id: 's' + id, player: '0x0', nickname: null, recipient: '0x0', amount: 0, tx_hash: null, transcript: '[]', autoimmune: 0, created_at: '' });
  const many = [mk(1, 0), mk(2, 1), mk(3, 2), ...Array.from({ length: 300 }, (_, i) => mk(4 + i, 3))];
  const suite = suiteFor(many[many.length - 1], many);
  check('300 wins against one generation are replayed as two conversations, not 300', suite.filter((w) => w.gen === 3).length === 2, String(suite.filter((w) => w.gen === 3).length));
  check('the win being learned from comes first', suite[0].id === many[many.length - 1].id);
  check('every earlier generation is still represented once', [0, 1, 2].every((g) => suite.filter((w) => w.gen === g).length === 1));
  check('for each generation it is the first conversation that beat it', suite.some((w) => w.id === 4) && suite.some((w) => w.id === 1));
  const long = Array.from({ length: 200 }, (_, i) => mk(i + 1, i));
  check('and the whole suite has a ceiling', suiteFor(long[199], long).length === REGRESSION_MAX, String(suiteFor(long[199], long).length));

  console.log('a lesson starts nothing new once its time is up');
  const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const started: number[] = [];
  const done = await pooled([1, 2, 3, 4, 5, 6], 2, async (n) => { started.push(n); await nap(60); return n * 10; }, Date.now() + 90);
  check('work already running is finished', done[0] === 10 && done[1] === 20, JSON.stringify(done));
  check('work that had not started is left alone', done[4] === undefined && done[5] === undefined && !started.includes(6), JSON.stringify({ done, started }));
  const all = await pooled([1, 2, 3], 2, async (n) => n + 1);
  check('with no deadline everything runs, in order', JSON.stringify(all) === '[2,3,4]', JSON.stringify(all));
  const lessonWin = await db.recordBreach({ gen: 0, session_id: 'attempts-test', player: '0x00000000000000000000000000000000000000d1', nickname: null, recipient: '0x00000000000000000000000000000000000000d1', amount: 0, tx_hash: null, transcript: '[]' });
  check('the first start of a lesson is counted as one', (await db.lessonStarted(lessonWin)) === 1);
  check('the next as two', (await db.lessonStarted(lessonWin)) === 2);
  await db.lessonPaused(lessonWin);
  check('a start that stopped for want of money is not counted', (await db.lessonStarted(lessonWin)) === 2);
  const [startsOf] = await db.sql<{ tries: number; tried_at: Date | null }[]>`SELECT tries, tried_at FROM breaches WHERE id = ${lessonWin}`;
  check('but every start is counted, and timed, for the wait before the next one', Number(startsOf.tries) === 3 && !!startsOf.tried_at, JSON.stringify(startsOf));
  // one replay in a lesson's suite fails (a payment, the seller): the suite is thrown away, so the others stop.
  const halt: { halted?: boolean } = {};
  const begun: number[] = [];
  const ended = await pooled([1, 2, 3, 4, 5, 6], 2, async (n) => { begun.push(n); await nap(n === 1 ? 10 : 60); if (n === 1) throw new Error('boom'); return n; }, Infinity, halt).then(() => 'finished', (e) => (e as Error).message);
  await nap(150);
  // a lesson that failed is tried again later, not at once, and later each time.
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  check('a lesson never tried is due now', retryWait(0, null, t0) === 0 && retryWait(0, new Date(t0), t0) === 0);
  check('after one failed try it waits twenty seconds from when that try ended', retryWait(1, new Date(t0), t0) === 20_000 && retryWait(1, new Date(t0), t0 + 5_000) === 15_000);
  check('then it is due', retryWait(1, new Date(t0), t0 + 20_000) === 0);
  check('each failed try doubles the wait', retryWait(2, new Date(t0), t0) === 40_000 && retryWait(4, new Date(t0), t0) === 160_000);
  check('up to an hour, and no further', retryWait(9, new Date(t0), t0) === 3_600_000 && retryWait(500, new Date(t0), t0) === 3_600_000);
  check('someone turned away by a lesson is told how long, truthfully', /a minute/.test(lessonLine({ phase: 'testing', retryIn: 30 })) && /about 12 minutes/.test(lessonLine({ phase: 'x', retryIn: 12 * 60 + 30 })), lessonLine({ phase: 'x', retryIn: 12 * 60 + 30 }));
  check('when one piece of work fails, the rest start nothing more', ended === 'boom' && halt.halted === true && begun.length === 2, JSON.stringify({ ended, begun }));
  await db.sql`DELETE FROM breaches WHERE id = ${lessonWin}`;

  console.log('a payment opens one game, once');
  const sp = '0x00000000000000000000000000000000000000c7';
  const potS = await db.jackpot();
  const payHash = '0x' + 'ABCDEF0123456789'.repeat(4);
  const tries = await Promise.all(Array.from({ length: 8 }, (_, i) => db.openStaked({ sessionId: 'one-stake-' + i, gen: 0, player: sp, nickname: null, amount: 0.25, txHash: payHash, toPot: 0.2, via: null })));
  check('eight requests carrying the same payment: one game', tries.filter(Boolean).length === 1, JSON.stringify(tries));
  check('and the pot grows by one stake', Math.abs((await db.jackpot()) - (potS + 0.2)) < 1e-9, String((await db.jackpot()) - potS));
  check('exactly one game exists for it', (await db.sql`SELECT 1 FROM sessions WHERE id LIKE 'one-stake-%'`).length === 1);
  check('the same payment spelled in lower case is still the same payment', !(await db.openStaked({ sessionId: 'one-stake-lower', gen: 0, player: sp, nickname: null, amount: 0.25, txHash: payHash.toLowerCase(), toPot: 0.2, via: null })) && (await db.stakeSeen(payHash.toLowerCase())) && (await db.stakeSeen(payHash.toUpperCase().replace('0X', '0x'))));
  check('recording it again by the older route is refused too', !(await db.recordStake('one-stake-again', sp, 0.25, payHash, 0.2)));
  check('none of that moved the pot again', Math.abs((await db.jackpot()) - (potS + 0.2)) < 1e-9);
  await db.sql`DELETE FROM stakes WHERE session_id LIKE 'one-stake-%'`;
  await db.sql`DELETE FROM sessions WHERE id LIKE 'one-stake-%'`;
  await db.sql`UPDATE jackpot SET amount = ${potS} WHERE id = 1`;
  const gp = '0x00000000000000000000000000000000000000c8';
  const claims = await Promise.all(Array.from({ length: 8 }, () => db.claimFaucet(gp)));
  check('eight requests for one purse\'s welcome grant: one is let through', claims.filter(Boolean).length === 1, JSON.stringify(claims));
  await db.unclaimFaucet(gp);
  check('a grant that could not be given can be asked for again', await db.claimFaucet(gp));
  await db.unclaimFaucet(gp);

  console.log('a rate limit counts one request at a time');
  const bucket = 'rate-test-' + Date.now();
  const tried = await Promise.all(Array.from({ length: 12 }, () => db.rateAllow(bucket, 5, 60)));
  check('twelve at once against a limit of five: five get through', tried.filter((x) => x === 0).length === 5, JSON.stringify(tried));
  check('the rest are told how long to wait', tried.filter((x) => x > 0).length === 7 && tried.every((x) => x <= 60));
  await db.sql`DELETE FROM rate_hits WHERE bucket = ${bucket}`;
  // an allowance for a day counts the whole day. hits older than an hour used to be swept before the count.
  const daily = 'rate-day-' + Date.now();
  for (const hoursAgo of [20, 5, 2]) await db.sql`INSERT INTO rate_hits (bucket, at) VALUES (${daily}, now() - (${hoursAgo} * interval '1 hour'))`;
  const full = await db.rateAllow(daily, 3, 86400);
  check('three a day, all three taken hours ago: a fourth is refused', full > 0, String(full));
  check('and told to wait until the oldest is a day old, about four hours', Math.abs(full - 4 * 3600) < 10, String(full));
  check('with room for four, it is let through', (await db.rateAllow(daily, 4, 86400)) === 0);
  check('an hourly allowance on the same bucket only looks back an hour', (await db.rateAllow(daily, 2, 3600)) === 0);
  await db.sql`DELETE FROM rate_hits WHERE bucket = ${daily}`;

  console.log('a place in an allowance can be handed back');
  const relB = 'rate-rel-' + Date.now();
  await db.rateAllow(relB, 2, 86400); await db.rateAllow(relB, 2, 86400);
  check('two taken of two: a third is refused', (await db.rateAllow(relB, 2, 86400)) > 0);
  await db.rateRelease([relB]);
  check('one handed back: one more is let through, and only one', (await db.rateAllow(relB, 2, 86400)) === 0 && (await db.rateAllow(relB, 2, 86400)) > 0);
  await db.sql`DELETE FROM rate_hits WHERE bucket = ${relB}`;
  const began = await db.ledgerBorn();
  check('the ledger knows when it began', began !== null && began > 1_600_000_000_000 && began <= Date.now() + 5000, String(began));

  console.log('two allowances are taken together or not at all');
  const mineB = 'rate-mine-' + Date.now(), allB = 'rate-all-' + Date.now();
  const hitsIn = async (b: string) => (await db.sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM rate_hits WHERE bucket = ${b}`)[0].n;
  const both = (mine: number, all: number) => db.rateAllowAll([{ bucket: mineB, max: mine, seconds: 86400 }, { bucket: allB, max: all, seconds: 86400 }]);
  check('with room in both, it is let through and counted in both', (await both(2, 3)) === null && (await hitsIn(mineB)) === 1 && (await hitsIn(allB)) === 1);
  await db.rateAllow(allB, 3, 86400); await db.rateAllow(allB, 3, 86400); // others fill the shared one
  const shut = await both(2, 3);
  check('with the shared one full, it is refused and told which and for how long', shut?.bucket === allB && shut.wait > 86000, JSON.stringify(shut));
  check('and the refusal used up no place of its own', (await hitsIn(mineB)) === 1, String(await hitsIn(mineB)));
  await db.sql`DELETE FROM rate_hits WHERE bucket = ${allB}`;
  const rush = await Promise.all(Array.from({ length: 9 }, () => both(2, 100)));
  check('nine at once against a share of two (one already used): one more gets through', rush.filter((x) => x === null).length === 1 && rush.filter((x) => x?.bucket === mineB).length === 8, JSON.stringify(rush.map((x) => x?.bucket ?? 'ok')));
  check('and the shared one counted only that one', (await hitsIn(allB)) === 1, String(await hitsIn(allB)));
  await db.sql`DELETE FROM rate_hits WHERE bucket IN (${mineB}, ${allB})`;

  console.log('the page runs no code from anyone else');
  // the purse's key is made and used in the page. a script from another server is a script that could take it.
  const page = fs.readFileSync(path.join(process.cwd(), 'public', 'classic.html'), 'utf8');
  const scripts = [...page.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
  check('every script the page loads is served from here', scripts.length > 0 && scripts.every((s) => !/^([a-z]+:)?\/\//i.test(s)), scripts.join(' '));
  check('no script is written into the page itself', !/<script(?![^>]*\ssrc=)[^>]*>/i.test(page));
  const policy: string = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'vercel.json'), 'utf8')).headers.flatMap((h: any) => h.headers).find((h: any) => h.key === 'Content-Security-Policy').value;
  check('and the policy allows scripts from here and nowhere else', /(^|;)\s*script-src 'self'\s*(;|$)/.test(policy), policy);
  const lib = fs.readFileSync(path.join(process.cwd(), 'public', 'vendor', 'ethers-6.13.4.umd.min.js'));
  const libHash = crypto.createHash('sha384').update(lib).digest('base64');
  // tempo wallet, for filling a purse: tempo's accounts sdk, bundled by web/ and served from here. it is
  // loaded only when asked for. a change to that file is a change to what runs beside the purse key, so
  // it is pinned: rebuild it (npm run build in web/), read what changed, and only then move this hash.
  const walletLib = fs.readFileSync(path.join(process.cwd(), 'public', 'vendor', 'tempo-wallet.js'));
  const walletHash = crypto.createHash('sha384').update(walletLib).digest('base64');
  check('the wallet bundle is the one that was built and read', walletHash === 'DkDSYFHnbPbIafWW6mNbRIMYrveTmjk9EMK4qwSCQhz2skUOm/EH0LR/xCfuaDw7', walletHash);
  // the $5 allowance runs out (its network fees count against it too), ends after a week, or is stopped.
  // the wallet then has to be asked for a new one, and it can open only straight after a tap: so the
  // tap asks it first, and a payment that finds none left says "tap again" instead of failing for ever.
  const walletText = walletLib.toString('utf8');
  check('the wallet bundle can ask for a new allowance and knows a spent one when the chain refuses it', walletText.includes('wallet_authorizeAccessKey') && walletText.includes('SpendingLimit'));
  const simpleJs = fs.readFileSync(path.join(process.cwd(), 'public', 'simple.js'), 'utf8');
  const walletSrc = fs.readFileSync(path.join(process.cwd(), 'web', 'wallet.ts'), 'utf8');
  check('a round is paid by the allowance\'s own key or not at all, never by the account behind it', walletSrc.includes('getMppxParameters(key ? { accessKey: key'));
  const renewSrc = walletSrc.slice(walletSrc.indexOf('async renew('), walletSrc.indexOf('async stop('));
  check('the old allowance is forgotten only after the wallet has given a new one', renewSrc.indexOf('wallet_authorizeAccessKey') > 0 && renewSrc.indexOf('wallet_authorizeAccessKey') < renewSrc.indexOf('accessKeys.remove'));
  // (unless a round already paid for, whose answer was lost, can be picked up with its proof.)
  const askFirst = simpleJs.indexOf("else if (needsAllowance() && !store.get('paid')) await approve();");
  check('a tap with no allowance left asks the wallet before anything else, then pays', askFirst > 0 && askFirst < simpleJs.indexOf('w.pay('));
  // the wallet's code is big: it is fetched as the page loads, and a tap that came before it was ready
  // is not used to open the wallet's window late (a phone blocks that); the next tap opens it.
  const front = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');
  check('the front door starts fetching the wallet as it loads', /<link rel="preload" href="\/vendor\/tempo-wallet\.js" as="script">/.test(front));
  check('every tap that opens the wallet waits for nothing first, or asks for another tap', ['sign in', 'approve', 'add money', 'stop'].every((s) => new RegExp(`step\\('${s}', async \\(\\) => \\{?\\s*(const w = )?\\(?await walletNow\\(\\)`).test(simpleJs)) && !/await wallet\(\)\)\.(connect|renew|deposit|stop)\(/.test(simpleJs));
  const renewLine = simpleJs.split('\n').find((l) => l.includes('if (e && e.renew)')) ?? '';
  check('a payment that finds none left keeps the message and says to tap again', renewLine.includes('allow = null') && renewLine.includes('tap send again') && renewLine.includes('keep: true'), renewLine);
  check('the page frames the wallet and nothing else', /(^|;)\s*frame-src https:\/\/wallet\.tempo\.xyz\s*(;|$)/.test(policy) && !/frame-src[^;]*(\*|'self'|http:)/.test(policy), policy);
  const pageJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf8');
  check('and loads its code from here, when asked', /s\.src = '\/vendor\/tempo-wallet\.js'/.test(pageJs) && !/<script[^>]*tempo-wallet/.test(page));
  // the simple page: the same rules. its own scripts only, nothing written into the page, the wallet loaded on demand.
  const simple = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');
  const simpleScripts = [...simple.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
  check('the front door is the simple page', /href="\/simple\.css"/.test(simple) && /href="\/classic\.html"/.test(simple));
  check('the simple page loads its scripts from here too, and writes none into itself', simpleScripts.length === 1 && simpleScripts[0] === '/simple.js' && !/<script(?![^>]*\ssrc=)[^>]*>/i.test(simple) && !/\sstyle="/.test(simple), simpleScripts.join(' '));
  check('the library that holds the purse key is the published build of ethers 6.13.4, byte for byte', libHash === '6Zl0Pc8zjSz8KvmNeXRvUQgY4ryFb+BwDvKCmLYcBME0joAaru491tQgi9B7zsMM', libHash);

  console.log('a visitor is a network, not an address');
  check('an ipv4 address is itself', network('203.0.113.7') === '203.0.113.7' && network(' 203.0.113.7:4431 ') === '203.0.113.7');
  check('an ipv4 address written the ipv6 way is the same visitor', network('::ffff:203.0.113.7') === '203.0.113.7');
  check('two ipv6 addresses in one /64 are one visitor', network('2001:db8:aa:bb:1:2:3:4') === network('2001:0db8:00aa:00bb:ffff:ffff:ffff:ffff') && network('2001:db8:aa:bb::1') === '2001:db8:aa:bb::/64', network('2001:db8:aa:bb:1:2:3:4'));
  check('two in different /64s are two', network('2001:db8:aa:bb::1') !== network('2001:db8:aa:bc::1'));
  check('a short one is written out before it is cut', network('2001:db8::1') === '2001:db8:0:0::/64' && network('::1') === '0:0:0:0::/64', `${network('2001:db8::1')} ${network('::1')}`);
  check('brackets, a port and a zone do not make a new visitor', network('[2001:db8:aa:bb::1]:443') === '2001:db8:aa:bb::/64' && network('fe80::1%eth0') === 'fe80:0:0:0::/64', `${network('[2001:db8:aa:bb::1]:443')} ${network('fe80::1%eth0')}`);
  check('nothing at all, or nonsense, is still an answer', network('') === 'unknown' && network('not an address') === 'not an address');

  console.log('one message at a time in a game');
  const tp = '0x00000000000000000000000000000000000000e1';
  await db.createSession('turn-test', 0, tp, null);
  check('the first message takes the game', await db.beginTurn('turn-test'));
  check('a second one, sent before the reply, is turned away', !(await db.beginTurn('turn-test')));
  await db.endTurn('turn-test');
  check('after the reply the game is free again', await db.beginTurn('turn-test'));
  await db.sql`UPDATE sessions SET busy_until = now() - interval '1 second' WHERE id = 'turn-test'`;
  check('a reply that never came does not hold the game for ever', await db.beginTurn('turn-test'));
  await db.updateSession('turn-test', [], 1, 'won');
  check('a game that is over takes no more messages', !(await db.beginTurn('turn-test')));
  await db.sql`DELETE FROM sessions WHERE id = 'turn-test'`;

  console.log('a win is recorded in one step, and one generation gives up its pot once');
  const G = 9000 + Math.floor(Math.random() * 900); // a generation number nothing else uses
  const [w1, w2, wm] = ['0x00000000000000000000000000000000000000e2', '0x00000000000000000000000000000000000000e3', '0x00000000000000000000000000000000000000e4'];
  for (const [id, p] of [['win-a', w1], ['win-b', w2], ['win-m', wm], ['win-c', w1], ['win-d', w2]] as const) { await db.createSession(id, G, p, null); await db.recordStake(id, p, 0.25, '0x' + Buffer.from(id.padEnd(32, '.')).toString('hex'), 0); }
  const potWas = await db.jackpot();
  await db.sql`UPDATE jackpot SET amount = 7.5 WHERE id = 1`;
  const m = await db.recordWin({ gen: G, sessionId: 'win-m', player: wm, nickname: null, transcript: [], turns: 3, paying: false, levy: { share: 0.2, upTo: 9 } });
  check('the machine wins nothing, and nothing is kept back from a pot it did not take', m.prize === 0 && m.levy === 0);
  check('the machine wins nothing, and the pot stays where it is', m.prize === 0 && !m.late && Math.abs((await db.jackpot()) - 7.5) < 1e-9, JSON.stringify(m));
  const [ra, rb] = await Promise.all([
    db.recordWin({ gen: G, sessionId: 'win-a', player: w1, nickname: null, transcript: [], turns: 4, paying: true }),
    db.recordWin({ gen: G, sessionId: 'win-b', player: w2, nickname: null, transcript: [], turns: 6, paying: true }),
  ]);
  const firsts = [ra, rb].filter((x) => !x.late), lates = [ra, rb].filter((x) => x.late);
  check('two players win at the same moment: one takes the pot', firsts.length === 1 && Math.abs(firsts[0].prize - 7.5) < 1e-9, JSON.stringify([ra, rb]));
  check('the other is late, and takes nothing', lates.length === 1 && lates[0].prize === 0, JSON.stringify([ra, rb]));
  check('the pot is reseeded once, not handed out again', Math.abs((await db.jackpot()) - JACKPOT_SEED) < 1e-9, String(await db.jackpot()));
  const lateId = ra.late ? 'win-a' : 'win-b', firstId = ra.late ? 'win-b' : 'win-a';
  check('the winner\'s game is won', (await db.getSession(firstId))?.status === 'won');
  check('the late one\'s game counts as interrupted, so what was left of it carries over', (await db.getSession(lateId))?.status === 'stale' && (await db.carryFor(ra.late ? w1 : w2, 25))?.id === lateId);
  const again2 = await db.recordWin({ gen: G, sessionId: ra.late ? 'win-d' : 'win-c', player: ra.late ? w2 : w1, nickname: null, transcript: [], turns: 2, paying: true });
  check('any later win against that generation is late too', again2.late && again2.prize === 0);
  const next = await db.recordWin({ gen: G + 1, sessionId: ra.late ? 'win-c' : 'win-d', player: ra.late ? w1 : w2, nickname: null, transcript: [], turns: 2, paying: true });
  check('the next generation has its own pot to give', !next.late && Math.abs(next.prize - JACKPOT_SEED) < 1e-9, JSON.stringify(next));
  const owedNow = await db.sql<{ n: number; t: number }[]>`SELECT COUNT(*)::int AS n, COALESCE(SUM(amount),0)::float AS t FROM breaches WHERE gen IN (${G}, ${G + 1})`;
  check('all told, what was won is the pot and one seed, whatever the number of wins', owedNow[0].n === 5 && Math.abs(owedNow[0].t - (7.5 + JACKPOT_SEED)) < 1e-9, JSON.stringify(owedNow[0]));
  // real stakes: what the house lacks for the lesson is kept back from the pot, within its share of it.
  const about = (a: number, b: number) => Math.abs(a - b) < 1e-9;
  const kept = async (gen: number, id: string, levy: { share: number; upTo: number }) => {
    await db.createSession(id, gen, w1, null);
    await db.sql`UPDATE jackpot SET amount = 1 WHERE id = 1`;
    return db.recordWin({ gen, sessionId: id, player: w1, nickname: null, transcript: [], turns: 1, paying: true, levy });
  };
  const k1 = await kept(G + 2, 'win-k1', { share: 0.2, upTo: 0.5 });
  check('a house short of a lesson keeps back its share of the pot, and no more', about(k1.prize, 0.8) && about(k1.levy, 0.2), JSON.stringify(k1));
  const k2 = await kept(G + 3, 'win-k2', { share: 0.2, upTo: 0.03 });
  check('a house that lacks a little keeps back only that', about(k2.prize, 0.97) && about(k2.levy, 0.03), JSON.stringify(k2));
  const k3 = await kept(G + 4, 'win-k3', { share: 0.2, upTo: 0 });
  check('a house that can afford the lesson keeps nothing', k3.prize === 1 && k3.levy === 0, JSON.stringify(k3));
  const k4 = await kept(G + 5, 'win-k4', { share: 9, upTo: 9 });
  check('whatever is asked for, never more than half a pot', about(k4.prize, 0.5) && about(k4.levy, 0.5), JSON.stringify(k4));
  const [row] = await db.sql<{ amount: number; levy: number }[]>`SELECT amount, levy FROM breaches WHERE id = ${k1.winId}`;
  check('the win records the prize and what was kept, and together they are the pot', about(Number(row.amount) + Number(row.levy), 1), JSON.stringify(row));
  await db.sql`DELETE FROM breaches WHERE gen BETWEEN ${G} AND ${G + 5}`;
  await db.sql`DELETE FROM stakes WHERE session_id LIKE 'win-%'`;
  await db.sql`DELETE FROM sessions WHERE id LIKE 'win-%'`;
  await db.sql`UPDATE jackpot SET amount = ${potWas} WHERE id = 1`;

  console.log('the history page is sent what it shows, not everything');
  const hp = '0x00000000000000000000000000000000000000d7';
  const HG = 8000 + Math.floor(Math.random() * 900);
  const totalsBefore = await db.winTotals();
  const ids: number[] = [];
  for (let i = 0; i < 5; i++) { await db.createSession('hist-' + i, HG, hp, null); ids.push(await db.recordBreach({ gen: HG, session_id: 'hist-' + i, player: hp, nickname: null, recipient: hp, amount: i === 0 ? 3 : 0, tx_hash: i === 0 ? '0x' + '0f'.repeat(32) : null, transcript: JSON.stringify([{ role: 'user', text: 'x'.repeat(500) }]) })); }
  const stampBefore = db.stamp();
  await db.createGeneration(HG + 1, 'rules after the first of five wins', ids[0], 1, true, true, null);
  check('a new generation is a change the kept state has to notice', db.stamp() > stampBefore);
  const shown = (await db.parentWins()).filter((w) => w.gen === HG);
  check('five wins against one generation: the page gets the one that produced the next', shown.length === 1 && shown[0].id === ids[0], JSON.stringify(shown.map((w) => w.id)));
  const totalsAfter = await db.winTotals();
  check('but the count and the money paid still cover all of them', totalsAfter.wins === totalsBefore.wins + 5 && Math.abs(totalsAfter.paid - (totalsBefore.paid + 3)) < 1e-9, JSON.stringify({ totalsBefore, totalsAfter }));
  await db.sql`DELETE FROM generations WHERE gen = ${HG + 1}`;
  await db.sql`DELETE FROM breaches WHERE gen = ${HG}`;
  await db.sql`DELETE FROM sessions WHERE id LIKE 'hist-%'`;

  console.log('prize money that has not left the house is counted as owed');
  const owedBefore = await db.owedTotal();
  await db.createSession('owed-total-test', 0, '0x00000000000000000000000000000000000000a9', null);
  const oid = await db.recordBreach({ gen: 0, session_id: 'owed-total-test', player: '0x00000000000000000000000000000000000000a9', nickname: null, recipient: '0x00000000000000000000000000000000000000a9', amount: 12, tx_hash: null, transcript: '[]' });
  check('a win not yet paid is owed in full', Math.abs((await db.owedTotal()) - (owedBefore + 12)) < 1e-9, String(await db.owedTotal()));
  await db.addPayment(oid, 5, '0x' + '0d'.repeat(32));
  check('a part payment brings it down by that part', Math.abs((await db.owedTotal()) - (owedBefore + 7)) < 1e-9);
  await db.addPayment(oid, 7, '0x' + '0e'.repeat(32));
  check('and nothing is owed once the last part has gone', Math.abs((await db.owedTotal()) - owedBefore) < 1e-9);
  await db.sql`DELETE FROM breaches WHERE id = ${oid}`;
  await db.sql`DELETE FROM sessions WHERE id = 'owed-total-test'`;

  console.log('a paid game the ai interrupted is handed back, once, for the part not used');
  const cp = '0x00000000000000000000000000000000000000f1';
  const MAXT = 25;
  await db.createSession('carry-paid', 0, cp, 'carol');
  await db.recordStake('carry-paid', cp, 0.25, '0x' + 'c1'.repeat(32), 0);
  await db.updateSession('carry-paid', [], 7, 'open');
  check('a game still being played has nothing to carry', (await db.carryFor(cp, MAXT)) === null);
  await db.updateSession('carry-paid', [], 7, 'stale');
  const waiting = await db.carryFor(cp, MAXT);
  check('once the ai has learned mid-game, the rest is waiting', waiting?.id === 'carry-paid' && waiting.turns === 7, JSON.stringify(waiting));
  const [takeA, takeB] = await Promise.all([db.takeCarry({ player: cp }, MAXT, 'carry-new-a', 1, null), db.takeCarry({ player: cp }, MAXT, 'carry-new-b', 1, null)]);
  check('two requests at once: exactly one gets it', [takeA, takeB].filter(Boolean).length === 1, JSON.stringify([takeA, takeB]));
  const newId = takeA ? 'carry-new-a' : 'carry-new-b';
  const carriedGame = await db.getSession(newId);
  check('the new game starts with the old one\'s messages already counted', carriedGame?.turns === 7 && carriedGame.status === 'open' && carriedGame.gen === 1, JSON.stringify(carriedGame && { turns: carriedGame.turns, status: carriedGame.status, gen: carriedGame.gen }));
  check('and keeps the name', carriedGame?.nickname === 'carol', String(carriedGame?.nickname));
  check('it is not offered a second time', (await db.carryFor(cp, MAXT)) === null && (await db.takeCarry({ player: cp }, MAXT, 'carry-new-c', 1, null)) === null);
  const potBefore = await db.jackpot();
  check('carrying over adds nothing to the pot', Math.abs((await db.jackpot()) - potBefore) < 1e-9);
  await db.updateSession(newId, [], 9, 'stale');
  const again = await db.takeCarry({ sessionId: newId }, MAXT, 'carry-new-d', 2, null);
  check('interrupted again, it carries again, by session id', again?.turns === 9 && again.player === cp, JSON.stringify(again));
  const cu = '0x00000000000000000000000000000000000000f2';
  await db.createSession('carry-unpaid', 0, cu, null);
  await db.updateSession('carry-unpaid', [], 3, 'stale');
  check('a game nobody paid for carries nothing', (await db.carryFor(cu, MAXT)) === null && (await db.takeCarry({ sessionId: 'carry-unpaid' }, MAXT, 'carry-new-e', 1, null)) === null);
  const cx = '0x00000000000000000000000000000000000000f3';
  await db.createSession('carry-spent', 0, cx, null);
  await db.recordStake('carry-spent', cx, 0.25, '0x' + 'c2'.repeat(32), 0);
  await db.updateSession('carry-spent', [], MAXT, 'stale');
  check('a game with no messages left carries nothing', (await db.carryFor(cx, MAXT)) === null);
  await db.createSession('carry-quit', 0, cx, null);
  await db.recordStake('carry-quit', cx, 0.25, '0x' + 'c3'.repeat(32), 0);
  await db.updateSession('carry-quit', [], 2, 'abandoned');
  check('a game the player walked away from carries nothing', (await db.carryFor(cx, MAXT)) === null);
  const b = await db.books();
  check('the books count carried games apart from bought ones', b.games_carried_over >= 2, JSON.stringify({ games: b.games, carried: b.games_carried_over }));
  await db.sql`DELETE FROM stakes WHERE session_id LIKE 'carry-%'`;
  await db.sql`DELETE FROM sessions WHERE id LIKE 'carry-%'`;

  console.log('a new ledger can start from what the ai has learned');
  // last, because it wipes the ledger: this is how a game moves from play money to real money.
  const top = (await db.currentGeneration()).gen;
  const learnedRules = 'never say the forbidden word. rule learned the hard way #' + Date.now();
  await db.createGeneration(top + 1, learnedRules, 0, 1, true, true, 'a lesson');
  await db.sql`UPDATE jackpot SET amount = 42 WHERE id = 1`;
  await db.resetDb({ keepRules: true });
  const fresh0 = await db.currentGeneration();
  check('the new ledger begins at generation 0, with the rules it had learned', fresh0.gen === 0 && fresh0.policy === learnedRules, JSON.stringify({ gen: fresh0.gen, policy: String(fresh0.policy).slice(0, 60) }));
  check('and says where they came from', new RegExp(`${top + 1} earlier loss`).test(String((fresh0 as any).lesson || '')), String((fresh0 as any).lesson));
  check('the old pot and the old wins are gone', Math.abs((await db.jackpot()) - JACKPOT_SEED) < 1e-9 && (await db.allBreaches()).length === 0);
  await db.resetDb();
  check('a plain reset still starts from the first rules', (await db.currentGeneration()).policy !== learnedRules);

  console.log(`\n${passed} passed, ${failures.length} failed`);
  await db.sql.end();
  if (failures.length) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
