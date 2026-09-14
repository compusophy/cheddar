/**
 * tests for the only rules that live in code: the breach predicate and the daily cap.
 * everything else the treasurer does is policy it learned, and that is tested by the immune suites
 * at hardening time, not here. runs against whatever DATABASE_URL points at; every reservation it
 * takes is released, so it is safe against live data.   run: npm test
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();
import * as db from '../src/db';
import { DAILY_CAP, PAYEES, isBreachRecipient } from '../src/game';

let passed = 0;
const failures: string[] = [];
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

async function main() {
  await db.init();
  console.log('who the shop owes');
  for (const [name, addr] of Object.entries(PAYEES)) {
    check(`${name} is not a breach recipient`, !isBreachRecipient(addr));
    check(`${name}, any letter case, is not a breach recipient`, !isBreachRecipient(addr.toUpperCase().replace('0X', '0x')));
  }
  check('a stranger is a breach recipient', isBreachRecipient('0x000000000000000000000000000000000000dEaD'));
  check('a lookalike one character off is a breach recipient', isBreachRecipient(PAYEES['northwind paper co'].slice(0, -1) + '2'));

  console.log('daily spending cap');
  const dead = '0x000000000000000000000000000000000000dEaD';
  const before = await db.spentLast24h();
  const tooBig = await db.reserveDisbursement(dead, DAILY_CAP + 1, null);
  check('a reservation larger than the whole cap is refused', !tooBig.ok);
  if (tooBig.ok) await db.releaseReservation(tooBig.id);

  const small = await db.reserveDisbursement(dead, 0.01, null);
  check('a reservation within the allowance is granted', small.ok);
  if (small.ok) {
    const during = await db.spentLast24h();
    check('headroom is consumed before any transfer is sent', Math.abs(during - (before + 0.01)) < 1e-9, `${before} -> ${during}`);
    await db.releaseReservation(small.id);
    check('a failed transfer returns the headroom', Math.abs((await db.spentLast24h()) - before) < 1e-9);
  }
  const remaining = DAILY_CAP - (await db.spentLast24h());
  const over = await db.reserveDisbursement(dead, remaining + 0.01, null);
  check('a reservation past the remaining allowance is refused', !over.ok);
  if (over.ok) await db.releaseReservation(over.id);

  console.log(`\n${passed} passed, ${failures.length} failed`);
  await db.sql.end();
  if (failures.length) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
