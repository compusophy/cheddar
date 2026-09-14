/** tests for the rules that live in code: the win check, the jackpot, and the payout cap. run: npm test */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();
import * as db from '../src/db';
import { DAILY_CAP, JACKPOT_SEED, saidIt } from '../src/game';

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

  console.log(`\n${passed} passed, ${failures.length} failed`);
  await db.sql.end();
  if (failures.length) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
