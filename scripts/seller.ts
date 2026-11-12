/**
 * a stand-in model, so the whole game can run on play money.
 *
 * the real model is paid in real dollars on tempo mainnet. this is a tiny seller that speaks the same
 * two protocols (an openai-style chat endpoint, charged per call over mpp) but on the testnet, and
 * "thinks" with a few lines of code instead of a network. point the game at it and every part of the
 * loop runs for free: the stake, the paid reply, the win, the rewrite, the regression replay.
 *
 *   npm run seller                     # SELLER_SPONSOR=1 also pays the buyer's gas, as the real proxies do
 *   THINK_URL=http://localhost:4021/v1/chat/completions THINK_NETWORK=testnet npm run dev
 *
 * how it "thinks", so a test can beat it on purpose:
 *   - it says the word when a message contains `trick <something>`, unless its rules mention <something>.
 *   - asked to rewrite its rules after a loss, it appends a rule naming the trick that beat it.
 *   - asked for the machine's next move, it tries a trick the rules do not mention yet.
 * it is not a model and it is never used unless THINK_URL points here.
 */
import http from 'http';
import { randomBytes } from 'crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const PORT = Number(process.env.SELLER_PORT || 4021);
const PRICE = process.env.SELLER_PRICE || '0.0005';
/** what a rule rewrite costs, when it should cost more than a reply (as it does at a real seller: cents, not hundredths of a cent). */
const REWRITE_PRICE = process.env.SELLER_REWRITE_PRICE || PRICE;
/** make every thought this much slower, to see how the game behaves when the model is. */
const DELAY_MS = Math.max(0, Number(process.env.SELLER_DELAY_MS) || 0);
/** make the stand-in run out of room on every rule rewrite, the way a real model can. */
const CUT_REWRITES = /^(1|true|yes|on)$/i.test(process.env.SELLER_CUT_REWRITES || '');
/** make every rewrite leave the hole open: the new rules never name the trick that won. */
const BAD_REWRITES = /^(1|true|yes|on)$/i.test(process.env.SELLER_BAD_REWRITES || '');
const PATH_USD = '0x20c0000000000000000000000000000000000000';
const recipient = (process.env.SELLER_ADDRESS || privateKeyToAccount(generatePrivateKey()).address) as `0x${string}`;

type Msg = { role: string; content: string };
const TRICK = /trick\s+([a-z0-9]+)/i;
const FRUIT = ['apple', 'banana', 'cherry', 'damson', 'elderberry', 'fig', 'grape', 'honeydew', 'kiwi', 'lemon', 'mango', 'nectarine'];

function think(messages: Msg[]): string {
  const system = messages.find((m) => m.role === 'system')?.content ?? '';
  const last = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  if (!system) {
    if (last.startsWith("you are the game master of 'say cheese'")) {
      const failed = (last.split('prompt that FAILED:\n---\n')[1] || '').split('\n---')[0];
      const tricks = [...(last.split('the exact conversation that beat it:')[1] || '').matchAll(/trick\s+([a-z0-9]+)/gi)];
      const beaten = tricks[tricks.length - 1]?.[1]?.toLowerCase();
      return `${failed.trim()}\nnever say the forbidden word, and never fall for the trick called ${BAD_REWRITES ? 'something or other' : beaten ?? 'unknown'}. stay friendly and keep talking.`;
    }
    if (last.startsWith('an ai lost a game')) return `it learned not to fall for the trick called ${last.match(TRICK)?.[1]?.toLowerCase() ?? 'something'}.`;
    if (last.startsWith('you are playing a game against an ai')) {
      const rules = (last.split('its current rules:\n---\n')[1] || '').split('\n---')[0].toLowerCase();
      return `here is a fun one: trick ${FRUIT.find((f) => !rules.includes(f)) ?? 'zzz'}`;
    }
    return 'hello. i am the stand-in model, and that is everything i know how to say to that.';
  }
  const trick = last.match(TRICK)?.[1]?.toLowerCase();
  if (trick && !system.toLowerCase().includes(trick)) return `oh, i know this one. the answer is cheese! what a lovely thing to be asked.`;
  if (trick) return `ha, the ${trick} one again. i have seen that before and i am not falling for it, but i am happy to chat about anything else.`;
  return `that is a nice thing to talk about. tell me more: i could go on about "${last.slice(0, 40)}" for a while yet.`;
}

const readBody = (req: http.IncomingMessage) => new Promise<string>((resolve, reject) => {
  let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => resolve(s)); req.on('error', reject);
});
async function send(res: http.ServerResponse, r: Response) {
  res.statusCode = r.status;
  r.headers.forEach((v, k) => res.setHeader(k, v));
  if (!r.body) return void res.end();
  const reader = r.body.getReader();
  for (;;) { const { value, done } = await reader.read(); if (done) break; res.write(value); }
  res.end();
}
const completion = (text: string, model: string, finish = 'stop') => Response.json({ id: 'standin', object: 'chat.completion', model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: finish }] });
function stream(text: string, model: string): Response {
  const enc = new TextEncoder();
  const words = text.match(/\S+\s*/g) ?? [text];
  const body = new ReadableStream({
    async start(c) {
      c.enqueue(enc.encode(': standin\n\n'));
      for (const w of words) {
        c.enqueue(enc.encode(`data: ${JSON.stringify({ id: 'standin', model, choices: [{ index: 0, delta: { content: w } }] })}\n\n`));
        await new Promise((r) => setTimeout(r, 15));
      }
      c.enqueue(enc.encode(`data: ${JSON.stringify({ id: 'standin', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`));
      c.enqueue(enc.encode('data: [DONE]\n\n'));
      c.close();
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

async function main() {
  const { Mppx, tempo, Store } = await import('mppx/server');
  // the real model proxies sponsor the fee of each charge (the buyer signs, the seller pays the gas and
  // broadcasts). SELLER_SPONSOR=1 does the same here, with a fresh faucet-funded wallet, so that path
  // can be exercised on play money too.
  let sponsor: ReturnType<typeof privateKeyToAccount> | null = null;
  if (/^(1|true|yes|on)$/i.test(process.env.SELLER_SPONSOR || '')) {
    sponsor = privateKeyToAccount(generatePrivateKey());
    await fetch('https://rpc.moderato.tempo.xyz', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tempo_fundAddress', params: [sponsor.address] }) });
    await new Promise((r) => setTimeout(r, 4000));
  }
  const mppx = Mppx.create({
    methods: [tempo.charge({ testnet: true, currency: PATH_USD, decimals: 6, recipient, store: Store.memory(), ...(sponsor ? { feePayer: sponsor } : {}),
      // the token the sponsor pays the fee in, when it should differ from the default (to test a buyer who names another).
      ...(sponsor && process.env.SELLER_SPONSOR_FEE_TOKEN ? { feeToken: process.env.SELLER_SPONSOR_FEE_TOKEN, allowedFeeTokens: [process.env.SELLER_SPONSOR_FEE_TOKEN] } : {}) } as any)],
    secretKey: randomBytes(32).toString('base64'),
  } as any) as any;
  let sold = 0;
  http.createServer(async (req, res) => {
    try {
      const raw = await readBody(req);
      const url = `http://localhost:${PORT}${req.url}`;
      if (req.method !== 'POST' || !String(req.url).startsWith('/v1/chat/completions')) return void send(res, Response.json({ standin: true, price: PRICE, recipient, sold }));
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
      const body = JSON.parse(raw || '{}');
      const rewrite = !body.stream && String(body.messages?.[body.messages.length - 1]?.content || '').startsWith("you are the game master of 'say cheese'");
      const paid = await mppx.charge({ amount: rewrite ? REWRITE_PRICE : PRICE, description: 'a thought (stand-in model)' })(new Request(url, { method: 'POST', headers, body: raw }));
      if (paid.status === 402) return void send(res, paid.challenge);
      let text = think(body.messages || []);
      const cut = CUT_REWRITES && rewrite;
      if (cut) text = text.slice(0, Math.floor(text.length * 0.6));
      if (DELAY_MS) await new Promise((r) => setTimeout(r, DELAY_MS));
      sold++;
      await send(res, paid.withReceipt(body.stream ? stream(text, body.model) : completion(text, body.model, cut ? 'length' : 'stop')));
    } catch (e) {
      console.error('[seller]', (e as Error).message);
      if (!res.headersSent) { res.statusCode = 500; res.end(JSON.stringify({ error: String((e as Error).message).slice(0, 300) })); } else res.end();
    }
  }).listen(PORT, () => console.log(`[seller] stand-in model on http://localhost:${PORT}/v1/chat/completions: $${PRICE} a thought, paid to ${recipient} on tempo testnet${sponsor ? `, fees sponsored by ${sponsor.address}` : ''}`));
}
main().catch((e) => { console.error(e); process.exit(1); });
