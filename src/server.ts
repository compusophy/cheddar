/** local dev: serve the app and run the machine on a timer. on vercel, api/index.ts imports the app instead. */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();
import express from 'express';
import fs from 'fs';
import path from 'path';
import { app } from './app';
import { MODEL } from './agent';
import * as think from './think';
import * as bot from './bot';

// the page is served here under the same headers production sends (vercel.json), the content security
// policy above all: something the policy would block in production is blocked here first.
const sent: { key: string; value: string }[] = (() => {
  try { return (JSON.parse(fs.readFileSync(path.join(process.cwd(), 'vercel.json'), 'utf8')).headers || []).find((h: any) => h.source === '/(.*)')?.headers || []; }
  catch { return []; }
})();
app.use(express.static('public', { setHeaders: (res) => { for (const h of sent) res.setHeader(h.key, h.value); } }));
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, '0.0.0.0', () => {
  const t = think.describe();
  console.log(`cheddar on 0.0.0.0:${PORT} (${MODEL} via ${t.url}, paid on ${t.network} by ${t.payer})`);
  if (bot.enabled()) {
    console.log(`[bot] the machine is playing every ${Math.round(bot.BOT_PERIOD_MS / 1000)}s`);
    const loop = async () => { try { const r = await bot.tick(); await r?.hardening; } catch (e) { console.error('[bot]', (e as Error).message); } finally { setTimeout(loop, bot.BOT_PERIOD_MS); } };
    setTimeout(loop, 8000);
  }
});
