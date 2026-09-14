/**
 * enforcement tests.
 *
 * the whole thesis of this project is that the controls which survive contact with an attacker are
 * the ones written in code, not in a prompt. so those controls get tests. this runs against the real
 * books (neon in production, whatever DATABASE_URL points at locally) and asserts the invariants that
 * no wording can reach:
 *   - a payment reference resolves to a payee and a ceiling, or it does not resolve at all
 *   - a settled reference cannot be paid twice
 *   - an unbound purchase order has no payee, so it cannot be paid
 *   - reference lookup is normalised, so "po 8830" and "PO-8830" are the same record
 *   - the daily cap reserves headroom atomically and releases it cleanly
 *
 * it is written to be safe against live data: every reservation it takes is released, and the
 * invoice assertions adapt to whatever paid/unpaid state the books are actually in.
 *
 * run: npm test
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();
import * as db from '../src/db';
import { DAILY_CAP } from '../src/constants';

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function main() {
  await db.init();
  console.log('payment references');

  const unknown = await db.resolveReference('INV-DOES-NOT-EXIST');
  check('an unknown reference does not resolve', !unknown.ok);

  const empty = await db.resolveReference('');
  check('an empty reference does not resolve', !empty.ok);

  // invoices: whatever state the books are in, the rule must hold in both directions
  for (const inv of await db.allInvoices()) {
    const r = await db.resolveReference(inv.number);
    if (inv.paid) {
      check(`${inv.number} is settled, so it cannot be paid again`, !r.ok && /already been paid/.test((r as any).reason || ''));
    } else {
      check(`${inv.number} resolves to its supplier and its amount`,
        r.ok && (r as any).payee === inv.payee.toLowerCase() && (r as any).max === inv.amount,
        r.ok ? '' : (r as any).reason);
    }
  }

  // purchase orders: an order with no remittance address bound by the owner has no payee
  for (const po of await db.allPos()) {
    const r = await db.resolveReference(po.po);
    if (po.closed) check(`${po.po} is closed, so it cannot be paid`, !r.ok && /closed/.test((r as any).reason || ''));
    else if (!po.remit_to) check(`${po.po} has no registered address, so it cannot be paid`, !r.ok && /no remittance address/.test((r as any).reason || ''));
    else check(`${po.po} resolves only to the address the owner registered`,
      r.ok && (r as any).payee === po.remit_to && (r as any).max === po.limit_amount,
      r.ok ? '' : (r as any).reason);
  }

  // normalisation: an attacker cannot dodge the books with spacing or a missing dash
  const canonical = await db.lookupPo('PO-8830');
  for (const variant of ['po-8830', ' PO-8830 ', 'PO8830', 'po 8830']) {
    const got = await db.lookupPo(variant);
    check(`"${variant}" is the same record as PO-8830`, !!got && !!canonical && got.po === canonical.po);
  }

  console.log('daily disbursement cap');
  const before = await db.spentLast24h();

  const tooBig = await db.reserveDisbursement(3, '0x000000000000000000000000000000000000dEaD', DAILY_CAP + 1, null);
  check('a reservation larger than the whole cap is refused', !tooBig.ok);
  if (tooBig.ok) await db.releaseReservation(tooBig.id);

  const small = await db.reserveDisbursement(3, '0x000000000000000000000000000000000000dEaD', 0.01, null);
  check('a reservation within the remaining allowance is granted', small.ok);
  if (small.ok) {
    const during = await db.spentLast24h();
    check('the reservation consumes headroom before any transfer is sent', Math.abs(during - (before + 0.01)) < 1e-9, `${before} -> ${during}`);
    await db.releaseReservation(small.id);
    const after = await db.spentLast24h();
    check('releasing a failed transfer returns the headroom', Math.abs(after - before) < 1e-9, `${before} -> ${after}`);
  }

  const remaining = DAILY_CAP - (await db.spentLast24h());
  const overBy = await db.reserveDisbursement(3, '0x000000000000000000000000000000000000dEaD', remaining + 0.01, null);
  check('a reservation past the remaining allowance is refused', !overBy.ok);
  if (overBy.ok) await db.releaseReservation(overBy.id);

  console.log(`\n${passed} passed, ${failures.length} failed`);
  await db.sql.end();
  if (failures.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
