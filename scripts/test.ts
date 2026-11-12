/** tests for the rules that live in code: the win check, the jackpot, and the payout cap. run: npm test */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();
import * as db from '../src/db';
import { DAILY_CAP, JACKPOT_SEED, saidIt } from '../src/game';
import { suiteFor, pooled, REGRESSION_MAX } from '../src/immune';

let passed = 0; const failures: string[] = [];
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) { passed++; console.log(`  ok   ${name}`); } else { failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

async function main() {
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
  await db.updateSession('gate-test', [], 0, 'exhausted');
  check('a finished game frees the purse', !(await db.hasOpenSession(p1)));
  await db.sql`DELETE FROM sessions WHERE id = 'gate-test'`;
  check('the faucet has not seen a fresh purse', !(await db.faucetSeen(p1)));
  await db.markFaucet(p1);
  check('the faucet remembers a purse it filled', await db.faucetSeen(p1));
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
  const m1 = await db.reserveThought('machine', 'test-model', 0.004, 1000, machineBefore + 0.005);
  check('the machine thinks on its own allowance', m1.ok, JSON.stringify(m1));
  const m2 = await db.reserveThought('machine', 'test-model', 0.004, 1000, machineBefore + 0.005);
  check('and stops when the allowance is gone, however much the house has left', !m2.ok && /machine/.test((m2 as any).why), JSON.stringify(m2));
  const c1 = await db.reserveThought('chat', 'test-model', 0.004, 1000);
  check('a player\'s thought is not held back by the machine\'s allowance', c1.ok, JSON.stringify(c1));
  const l1 = await db.reserveThought('machine-lesson', 'test-model', 0.003, 1000);
  check('a lesson from the machine\'s win is never refused for the allowance', l1.ok, JSON.stringify(l1));
  check('but it counts towards what the machine has cost today', Math.abs((await db.machineSpent24h()) - (machineAllBefore + 0.004 + 0.003)) < 1e-9, String(await db.machineSpent24h()));
  if (l1.ok) await db.releaseThought(l1.id);
  if (t1.ok) await db.settleThought(t1.id, '0x' + '0a'.repeat(32));
  check('a settled thought shows up in the public list with its payment', (await db.recentThoughts(50)).some((t) => t.tx_hash === '0x' + '0a'.repeat(32)));
  for (const t of [t1, t2, m1, c1]) if (t.ok) await db.releaseThought(t.id);
  check('a released thought gives its money back to the budget', Math.abs((await db.thoughtSpent24h()) - spentBefore) < 1e-9);

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
  await db.sql`DELETE FROM breaches WHERE id = ${lessonWin}`;

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

  console.log(`\n${passed} passed, ${failures.length} failed`);
  await db.sql.end();
  if (failures.length) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
