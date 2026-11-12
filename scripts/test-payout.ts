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
async function owedWin(player: string, tag: string) {
  const gen = (await db.currentGeneration()).gen;
  await db.createGeneration(gen + 1, `test rules after ${tag}`, 0, 1, true, true, null);
  await db.createSession(`payout-${tag}`, gen, player, null);
  await db.updateSession(`payout-${tag}`, [], 1, 'won');
  return db.recordBreach({ gen, session_id: `payout-${tag}`, player, nickname: null, recipient: player, amount: PRIZE, tx_hash: null, transcript: '[]' });
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

  console.log(`\n${passed} passed, ${failures.length} failed`);
  await db.sql.end();
  if (failures.length) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
