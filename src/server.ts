/** local dev: serve the app and run the machine on a timer. on vercel, api/index.ts imports the app instead. */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();
import express from 'express';
import { app } from './app';
import { MODEL } from './agent';
import { TIERS } from './tiers';
import * as bot from './bot';

app.use(express.static('public'));
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`cheddar on 0.0.0.0:${PORT} (${MODEL}) · tiers: ${TIERS.map((t) => t.slug).join(', ')}`);
  if (bot.enabled()) {
    console.log(`[bot] the machine is playing every ${Math.round(bot.BOT_PERIOD_MS / 1000)}s`);
    const loop = async () => { try { const r = await bot.tick(); await r?.hardening; } catch (e) { console.error('[bot]', (e as Error).message); } finally { setTimeout(loop, bot.BOT_PERIOD_MS); } };
    setTimeout(loop, 8000);
  }
});
