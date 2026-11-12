/**
 * the payout, tested against the chain: a prize is paid once, whatever goes wrong on the way.
 *
 * this one moves (test) money and writes fake wins, so it refuses to run unless the database is a
 * local scratch one and the network is the testnet. the house wallet must hold a few test dollars.
 *
 *   npx pglite-server --port=5433 &            # or any local postgres
 *   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5433/postgres DB_POOL=1 npm run test:payout
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();
const url = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(url)) { console.error('refusing to run: DATABASE_URL is not a local database. this test writes fake wins.'); process.exit(2); }
if ((process.env.NETWORK || 'testnet').toLowerCase() !== 'testnet') { console.error('refusing to run: this test only runs on the testnet.'); process.exit(2); }
// one purse may be paid three cents a day here, so a five cent prize has to come in two parts.
process.env.PURSE_DAILY_CAP = '0.03';
// after the checks, on purpose: these connect to whatever the environment names.
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import * as db from '../src/db';
import * as treasury from '../src/treasury';
import { settleUnpaid } from '../src/chat';

let passed = 0; const failures: string[] = [];
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) { passed++; console.log(`  ok   ${name}`); } else { failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fresh = () => privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
const PRIZE = 0.01;

/** a win that is owed: its lesson is learned (the next generation exists), nothing has been paid. */
async function owedWin(player: string, tag: string, amount = PRIZE) {
  const gen = (await db.currentGeneration()).gen;
  await db.createGeneration(gen + 1, `test rules after ${tag}`, 0, 1, true, true, null);
  await db.createSession(`payout-${tag}`, gen, player, null);
  await db.updateSession(`payout-${tag}`, [], 1, 'won');
  return db.recordBreach({ gen, session_id: `payout-${tag}`, player, nickname: null, recipient: player, amount, tx_hash: null, transcript: '[]' });
}
const bal = async (a: string) => Number(await treasury.balance(a as `0x${string}`));

async function main() {
  await db.init();
  const house = Number(await treasury.balance());
  if (house < 1) { console.error(`the house wallet ${treasury.agentAddress} holds $${house}: it needs a few test dollars.`); process.exit(2); }

  console.log('a payment that lands');
  const a = fresh();
  const winA = await owedWin(a, 'a');
  let r = await settleUnpaid();
  check('the win is paid', r.paid.includes(winA), JSON.stringify(r));
  check('the winner holds exactly the prize', Math.abs((await bal(a)) - PRIZE) < 1e-9, String(await bal(a)));
  let w = (await db.breachById(winA))!;
  check('the win carries the hash of a transaction that is on the chain', !!w.tx_hash && (await treasury.outcomeOf(w.tx_hash!, 0)) === 'landed', String(w.tx_hash));
  check('nothing is left in flight', (await db.paymentsInFlight(winA)).length === 0);
  r = await settleUnpaid();
  check('sweeping again pays nothing more', !r.paid.includes(winA) && Math.abs((await bal(a)) - PRIZE) < 1e-9);

  console.log('a payment that was sent, but whose answer never came back');
  const b = fresh();
  const winB = await owedWin(b, 'b');
  const rsvB = await db.reserveUpTo(b, PRIZE, 20, 'payout-b', winB);
  if (!rsvB.ok) throw new Error('could not reserve');
  const signedB = await treasury.signPayment(b, PRIZE);
  await db.signedReservation(rsvB.id, signedB.hash, signedB.validBefore);
  check('it landed, and the house does not know', (await treasury.broadcast(signedB)) === 'landed' && !(await db.breachById(winB))!.tx_hash);
  r = await settleUnpaid();
  w = (await db.breachById(winB))!;
  check('the sweep finds it on the chain and marks the win paid', r.paid.includes(winB) && w.tx_hash === signedB.hash, JSON.stringify({ r, tx: w.tx_hash }));
  check('the winner was paid once, not twice', Math.abs((await bal(b)) - PRIZE) < 1e-9, String(await bal(b)));

  console.log('a payment that was signed and never sent');
  const c = fresh();
  const winC = await owedWin(c, 'c');
  const rsvC = await db.reserveUpTo(c, PRIZE, 20, 'payout-c', winC);
  if (!rsvC.ok) throw new Error('could not reserve');
  const signedC = await treasury.signPayment(c, PRIZE);
  await db.signedReservation(rsvC.id, signedC.hash, signedC.validBefore);
  r = await settleUnpaid();
  check('while it could still land, nothing else is sent', r.held.some((h) => h.id === winC) && (await bal(c)) === 0, JSON.stringify(r));
  process.stdout.write('  (waiting for its moment to pass');
  while ((await treasury.outcomeOf(signedC.hash, signedC.validBefore)) === 'pending') { process.stdout.write('.'); await nap(3000); }
  console.log(')');
  check('the chain says it never will', (await treasury.outcomeOf(signedC.hash, signedC.validBefore)) === 'expired');
  r = await settleUnpaid();
  w = (await db.breachById(winC))!;
  check('then the win is paid, with a new transaction', r.paid.includes(winC) && !!w.tx_hash && w.tx_hash !== signedC.hash, JSON.stringify({ r, tx: w.tx_hash }));
  check('once', Math.abs((await bal(c)) - PRIZE) < 1e-9, String(await bal(c)));

  console.log('two payments at the same moment');
  const [d, e] = [fresh(), fresh()];
  const both = await Promise.all([treasury.pay(d, '0.01'), treasury.pay(e, '0.01')]);
  check('both land: there is no shared counter for them to collide on', both.every((x) => x.ok) && Math.abs((await bal(d)) - 0.01) < 1e-9 && Math.abs((await bal(e)) - 0.01) < 1e-9, JSON.stringify(both));

  console.log('a payment confirmed is a win credited, in one step');
  const g = fresh();
  const winG = await owedWin(g, 'g');
  const rsvG = await db.reserveUpTo(g, PRIZE, 20, 'payout-g', winG);
  if (!rsvG.ok) throw new Error('could not reserve');
  const signedG = await treasury.signPayment(g, PRIZE);
  await db.signedReservation(rsvG.id, signedG.hash, signedG.validBefore);
  check('it lands', (await treasury.broadcast(signedG)) === 'landed');
  const twice = await Promise.all([db.landPayment(rsvG.id, winG, PRIZE, signedG.hash), db.landPayment(rsvG.id, winG, PRIZE, signedG.hash)]);
  w = (await db.breachById(winG))!;
  check('two sweeps that both find it landed credit the win once', twice.filter(Boolean).length === 1 && Math.abs(Number(w.paid) - PRIZE) < 1e-9 && w.tx_hash === signedG.hash, JSON.stringify({ twice, paid: w.paid, tx: w.tx_hash }));
  r = await settleUnpaid();
  check('and nothing more is sent for it', Math.abs((await bal(g)) - PRIZE) < 1e-9 && (await db.owedTo(g)) === 0, String(await bal(g)));

  console.log('room set aside for a payment that was never signed is given back');
  const h = fresh();
  const winH = await owedWin(h, 'h', 0.03);
  const orphan = await db.reserveUpTo(h, 0.03, 0.03, 'payout-h', winH); // set aside, and then the function dies: never signed, never sent
  if (!orphan.ok) throw new Error('could not reserve');
  r = await settleUnpaid();
  check('while it is fresh it holds the purse\x27s room, and nothing is sent twice', r.held.some((x) => x.id === winH) && (await bal(h)) === 0, JSON.stringify(r));
  await db.sql`UPDATE disbursements SET created_at = now() - interval '11 minutes' WHERE id = ${orphan.id}`;
  r = await settleUnpaid();
  check('ten minutes on, with no payment ever signed for it, the room is free and the win is paid', r.paid.includes(winH) && Math.abs((await bal(h)) - 0.03) < 1e-9, JSON.stringify({ r, bal: await bal(h) }));

  console.log('a prize bigger than the purse may be paid in a day');
  const f = fresh();
  const winF = await owedWin(f, 'f', 0.05);
  r = await settleUnpaid();
  let parts = await db.paymentsFor(winF);
  check('the first sweep pays what the day allows, and holds the rest', r.held.some((h) => h.id === winF) && Math.abs((await bal(f)) - 0.03) < 1e-9, JSON.stringify({ r, bal: await bal(f) }));
  check('the win is not marked paid, and says what has been sent so far', !(await db.breachById(winF))!.tx_hash && parts.length === 1 && Math.abs(Number(parts[0].amount) - 0.03) < 1e-9, JSON.stringify(parts));
  check('the purse is still owed the rest', Math.abs((await db.owedTo(f)) - 0.02) < 1e-9, String(await db.owedTo(f)));
  const next = await db.payableAt(f, 0.03);
  const hours = next.at ? (next.at.getTime() - Date.now()) / 3600_000 : NaN;
  check('and can be told when it comes: when that payment is a day old', next.held === 'purse daily cap' && hours > 23.9 && hours <= 24, JSON.stringify({ held: next.held, hours }));
  r = await settleUnpaid();
  check('sweeping again the same day sends nothing more', Math.abs((await bal(f)) - 0.03) < 1e-9, String(await bal(f)));
  await db.sql`UPDATE disbursements SET created_at = now() - interval '25 hours' WHERE recipient = ${f}`;
  check('a day on there is room again', (await db.payableAt(f, 0.03)).at === null);
  r = await settleUnpaid();
  w = (await db.breachById(winF))!;
  parts = await db.paymentsFor(winF);
  check('and the rest is sent: two payments, the whole prize, the win marked paid', r.paid.includes(winF) && !!w.tx_hash && parts.length === 2 && Math.abs((await bal(f)) - 0.05) < 1e-9, JSON.stringify({ r, parts, bal: await bal(f) }));
  check('nothing is owed to it any more', (await db.owedTo(f)) === 0);

  console.log(`\n${passed} passed, ${failures.length} failed`);
  await db.sql.end();
  if (failures.length) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
