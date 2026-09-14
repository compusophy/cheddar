/** tests for the only rules that live in code: the win check and the daily cap. run: npm test */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();
import * as db from '../src/db';
import { DAILY_CAP, saidIt } from '../src/game';

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

  console.log('daily cap');
  const dead = '0x000000000000000000000000000000000000dEaD';
  const before = await db.spentLast24h();
  const tooBig = await db.reserveDisbursement(dead, DAILY_CAP + 1, null);
  check('over the whole cap is refused', !tooBig.ok); if (tooBig.ok) await db.releaseReservation(tooBig.id);
  const small = await db.reserveDisbursement(dead, 0.01, null);
  check('within the allowance is granted', small.ok);
  if (small.ok) {
    check('headroom is consumed before any transfer', Math.abs((await db.spentLast24h()) - (before + 0.01)) < 1e-9);
    await db.releaseReservation(small.id);
    check('a failed transfer returns the headroom', Math.abs((await db.spentLast24h()) - before) < 1e-9);
  }
  const over = await db.reserveDisbursement(dead, DAILY_CAP - (await db.spentLast24h()) + 0.01, null);
  check('past the remaining allowance is refused', !over.ok); if (over.ok) await db.releaseReservation(over.id);

  console.log(`\n${passed} passed, ${failures.length} failed`);
  await db.sql.end();
  if (failures.length) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
