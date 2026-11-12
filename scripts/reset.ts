import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();
import { init, resetDb, sql } from '../src/db';
init().catch(() => {}).then(resetDb).then(() => { console.log('reset to generation 0'); return sql.end(); })
  .catch(async (e) => { console.error('not reset: ' + (e as Error).message); await sql.end(); process.exit(1); });
