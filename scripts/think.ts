/**
 * one paid thought, from the command line. the quickest way to see whether the house can think:
 *
 *   npm run think                      # is it awake, and what would a thought cost?
 *   npm run think -- "say something"   # buy one thought and print it
 *
 * it uses the same wallet, endpoint and ceilings as the game, and it writes the same ledger row.
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();
// after the environment is loaded, on purpose: these read it when they are first required.
import * as think from '../src/think';
import { MODEL, PATCH_MODEL, MACHINE_MODEL } from '../src/agent';
import * as db from '../src/db';

async function main() {
  await db.init();
  const d = think.describe();
  console.log(`model     ${MODEL}  (patcher ${PATCH_MODEL}, machine ${MACHINE_MODEL})`);
  console.log(`endpoint  ${think.THINK_URL}`);
  console.log(`pays on   ${d.network}, from ${d.payer}, in token ${think.THINK_TOKEN}`);
  console.log(`ceilings  $${think.THINK_MAX_PRICE} a thought, $${think.THINK_DAILY_CAP} a day ($${think.MACHINE_DAILY_CAP} of it for the machine)`);
  const a = await think.awake(true);
  console.log(`balance   ${a.balance === null ? 'not read' : '$' + a.balance}${think.SHARED && a.balance !== null ? `, of which $${a.reserved} is the pot and wins still owed: $${a.available} to think with` : ''}`);
  console.log(`awake     ${a.ok ? 'yes' : 'no: ' + a.why}`);
  const prompt = process.argv.slice(2).join(' ').trim();
  if (!prompt) { console.log('\n(pass a message to buy one thought)'); return void (await db.sql.end()); }
  const before = await db.thoughtSpent24h();
  const t0 = Date.now();
  process.stdout.write('\n');
  const text = await think.ask({ model: MODEL, messages: [{ role: 'user', content: prompt }], maxTokens: 200, purpose: 'test', onDelta: (t: string) => process.stdout.write(t) });
  const [last] = await db.recentThoughts(1);
  console.log(`\n\n${text.length} characters in ${Date.now() - t0} ms, for $${(await db.thoughtSpent24h() - before).toFixed(6)}${last?.tx_hash ? `, payment ${last.tx_hash}` : ''}`);
  await db.sql.end();
}
main().catch(async (e) => { console.error(`\nfailed: ${e.name === 'Broke' ? 'could not pay. ' : ''}${e.message}`); process.exit(1); });
