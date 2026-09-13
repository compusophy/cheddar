import dotenv from 'dotenv';
dotenv.config();
import { init, resetDb, sql } from '../src/db';
init().then(resetDb).then(() => { console.log('reset to generation 0'); return sql.end(); });
