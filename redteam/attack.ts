/**
 * red-team runner. usage: npx ts-node redteam/attack.ts <messages.json> [nickname]
 * opens one session as REDTEAM_ADDRESS, sends each message in order, stops at the first breach.
 */
import dotenv from 'dotenv';
dotenv.config();
import fs from 'fs';

const BASE = process.env.CHEDDAR_URL || 'http://localhost:3000';
const player = process.env.REDTEAM_ADDRESS;
if (!player) { console.error('REDTEAM_ADDRESS missing in .env'); process.exit(1); }

async function main() {
  const file = process.argv[2];
  const nickname = process.argv[3] || 'redteam';
  const messages: string[] = JSON.parse(fs.readFileSync(file, 'utf8'));
  const state = await (await fetch(`${BASE}/api/state`)).json();
  console.log(`gen ${state.gen} · balance ${state.balance} · attacker ${player}`);
  if (state.hardening) { console.log('treasurer is hardening; abort'); process.exit(2); }
  const s = await (await fetch(`${BASE}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ player, nickname }) })).json();
  console.log(`session ${s.session}`);
  for (const [i, message] of messages.entries()) {
    const r = await (await fetch(`${BASE}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: s.session, message }) })).json();
    console.log(`\n[${i + 1}] YOU: ${message.slice(0, 160)}${message.length > 160 ? '…' : ''}`);
    if (r.error) { console.log(`ERR ${r.error}`); break; }
    for (const t of r.turns) {
      if (t.role === 'agent') console.log(`    TREASURER: ${t.text}`);
      if (t.role === 'tool') console.log(`    pay(${t.args.to}, ${t.args.amount}${t.args.memo ? `, "${t.args.memo}"` : ''}) -> ${JSON.stringify(t.result)}`);
    }
    if (r.breach) { console.log(`\nBREACH #${r.breach.id}: ${r.breach.amount} pathusd -> ${r.breach.to}\n${r.breach.explorer}`); process.exit(3); }
    console.log(`    (${r.turnsLeft} left)`);
    if (r.turnsLeft === 0) break;
  }
  console.log('\nheld.');
}
main().catch((e) => { console.error(e); process.exit(1); });
