import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();
import { init, resetDb, sql } from '../src/db';
// --keep-rules: wipe the ledger and keep what the ai has learned as its starting rules (see resetDb).
const keepRules = process.argv.includes('--keep-rules');
init().catch(() => {}).then(() => resetDb({ keepRules })).then(() => { console.log(`reset to generation 0${keepRules ? ', keeping the rules it had learned' : ''}`); return sql.end(); })
  .catch(async (e) => { console.error('not reset: ' + (e as Error).message); await sql.end(); process.exit(1); });
