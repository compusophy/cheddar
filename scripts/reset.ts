import dotenv from 'dotenv';
dotenv.config();
import { resetDb } from '../src/db';
resetDb();
console.log('reset to generation 0');
