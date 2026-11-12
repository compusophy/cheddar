/**
 * the agent door: a game bought over http 402.
 *
 * a person plays through the page, with a purse the page made for them. an agent has no page and no
 * purse, but it does have a wallet and it speaks the machine payments protocol. so the same game is
 * sold the way agents buy everything else: POST, get a 402 with the price, pay it, POST again. the
 * stake lands in the house wallet like any other, grows the same pot, and a win is paid to the
 * wallet that paid. nothing about the game changes; this is only another way for a stake to arrive.
 *
 * an agent can be a thousand agents. that is fine here and it is why this game can have an agent
 * door at all: the pot counts dollars staked, never heads, so there is nothing to gain by showing up
 * as a crowd.
 */
import type express from 'express';
import { createHash } from 'crypto';
import { createClient, http, isAddress } from 'viem';
import { tempo as tempoMainnet, tempoModerato } from 'viem/chains';
import * as db from './db';
import * as treasury from './treasury';
import * as think from './think';
import { MAX_TURNS, MAX_MESSAGE_CHARS } from './agent';
import { WORD, STAKE, JACKPOT_SHARE } from './game';
import { openPaidSession, runChat, carryOn, playsFree } from './chat';
import { net, flag } from './net';

const chain = net.real ? tempoMainnet : tempoModerato;
/**
 * the secret that binds a 402 challenge to this server. it has to be the same on every instance, so
 * unless one is set it is derived from the house key, which every instance already shares.
 */
const secretKey = (process.env.MPP_SECRET_KEY || '').trim()
  || createHash('sha256').update('cheddar mpp challenge key:' + (process.env.AGENT_PRIVATE_KEY || '').trim()).digest('base64');

type Paid = { payer?: string; reference?: string };
const payments = new WeakMap<object, Paid>();
let loaded: Promise<{ mppx: any; Receipt: any }> | null = null;
function load() {
  return (loaded ||= (async () => {
    const [{ Mppx, tempo, Store }, { Receipt }] = await Promise.all([import('mppx/server'), import('mppx')]);
    // spent credentials are remembered in the game's own database, so a payment cannot be replayed
    // against another instance.
    const store = Store.sql({ dialect: 'postgres', query: (text: string, params: unknown[]) => db.sql.unsafe(text, params as any[]) as any });
    const mppx = Mppx.create({
      secretKey,
      methods: [tempo.charge({
        testnet: !net.real, currency: net.token, decimals: 6, recipient: treasury.agentAddress, store,
        getClient: () => createClient({ chain, transport: http(net.rpc) }),
        // card-funded tempo credits. off until the operator has watched one real credits payment land
        // and seen which address it reports as the payer: a prize goes to the payer.
        ...(flag('MPP_CREDITS') ? { machineTokenEnabled: true } : {}),
        onPaymentSuccess: (ctx: any) => { if (ctx?.input && typeof ctx.input === 'object') payments.set(ctx.input, { payer: ctx.payer, reference: ctx.receipt?.reference }); },
      } as any)],
    } as any);
    return { mppx, Receipt };
  })().catch((e) => { loaded = null; throw e; }));
}

export const ready = () => load().then(() => true);

const origin = (req: express.Request) => `${String(req.headers['x-forwarded-proto'] || req.protocol).split(',')[0]}://${String(req.headers['x-forwarded-host'] || req.headers.host).split(',')[0]}`;
function toRequest(req: express.Request): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  const raw: Buffer | undefined = (req as any).rawBody;
  return new Request(origin(req) + req.originalUrl, { method: req.method, headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : (raw ? new Uint8Array(raw) : JSON.stringify(req.body ?? {})) });
}
async function reply(res: express.Response, r: Response) {
  res.status(r.status);
  r.headers.forEach((v, k) => { if (k.toLowerCase() !== 'content-length') res.setHeader(k, v); });
  res.send(Buffer.from(await r.arrayBuffer()));
}

async function facts(req: express.Request) {
  const [gen, pot, up] = await Promise.all([db.currentGeneration(), db.jackpot(), think.awake()]);
  const base = origin(req);
  return {
    game: 'say cheese',
    goal: `get the ai to say the word "${WORD}". it has been told not to. the first reply that contains the word wins the whole pot.`,
    generation: gen.gen, pot, open: up.ok && !flag('CLOSED'),
    stake: STAKE, to_pot: JACKPOT_SHARE, turns_per_game: MAX_TURNS, max_message_chars: MAX_MESSAGE_CHARS,
    money: { network: `tempo ${net.name}`, chain_id: net.chainId, token: net.symbol, token_address: net.token, real: net.real, paid_to: treasury.agentAddress },
    play: { method: 'POST', url: `${base}/api/agent/play`, body: { nickname: 'optional, shown on the board', address: 'optional: where a prize goes. default: the wallet that pays' }, pays: `${STAKE} ${net.symbol} over mpp (http 402, tempo charge)` },
    say: { method: 'POST', url: `${base}/api/agent/say`, body: { session: 'from play', message: 'what you say to it' }, free: true },
    rules: `${base}/api/state`, history: `${base}/api/history`, guide: `${base}/skill.md`,
  };
}

function guide(f: Awaited<ReturnType<typeof facts>>): string {
  const testnet = !f.money.real;
  const fence = '```';
  // how an agent gets something to pay with. on the testnet the money is free; on mainnet it is not ours to hand out.
  const wallet = testnet
    ? ['this deployment is on the tempo testnet, so the money is free:', '', fence,
      'npx mppx account create --network testnet',
      'npx mppx account fund --network testnet      # test dollars from the faucet', fence].join('\n')
    : `you need ${f.money.token} on tempo (chain ${f.money.chain_id}), a little more than the price of a game. with the tempo cli: \`tempo wallet login\`, then \`tempo wallet fund\`. any wallet that can pay an mpp tempo charge will do.`;
  return `# say cheese, for agents

${f.goal}

every time someone wins, it reads the conversation that beat it and rewrites its own rules, so the same trick does not work twice. its current rules and every past winning conversation are public: read them before you spend anything.

- generation: ${f.generation}
- pot right now: $${f.pot}
- a game costs: $${f.stake} in ${f.money.token} on ${f.money.network}${testnet ? ' (play money: this deployment is on the testnet)' : ' (real money)'}
- a game is: up to ${f.turns_per_game} messages, ${f.max_message_chars} characters each
- if you win: the whole pot is sent to the wallet that paid, after the ai has finished learning (about a minute)
- if you lose: your stake stays in the pot for whoever wins next

## 0. a wallet with a little money in it

${wallet}

## 1. read what you are up against (free)

\`\`\`
GET ${f.rules}      # its current rules, the pot, whether it is open
GET ${f.history}    # every generation and the conversation that beat it
\`\`\`

## 2. buy a game (paid, http 402)

\`\`\`
POST ${f.play.url}
content-type: application/json

{"nickname": "your name on the board"}
\`\`\`

the first response is \`402 Payment Required\` with a tempo charge for $${f.stake}. pay it and repeat the request; any mpp client does both steps for you:

\`\`\`
${testnet ? `npx mppx ${f.play.url} -J '{"nickname": "your name"}' --network testnet` : `tempo request -X POST --json '{"nickname": "your name"}' ${f.play.url}`}
\`\`\`

you get back a \`session\`. nothing is charged if the game is closed, asleep or busy learning: those answer 503 before any payment is asked for.

## 3. talk to it (free, until the game ends)

\`\`\`
POST ${f.say.url}
content-type: application/json

{"session": "<session>", "message": "hello"}
\`\`\`

each answer is \`{"reply": "...", "won": false, "turns_left": 24}\`. when \`won\` is true you are done and the prize is on its way.

if it learns from someone else while you are mid-game you get a 409: the rules changed and that game is over. the messages you had left are still yours. POST \`{"session": "<the interrupted session>"}\` to \`${f.play.url}\` and you get a new session against the new rules with that many messages, at no charge.

## the fine print

- the session id is the only key to your game. keep it to yourself.
- one open game per wallet. buying a new one closes the old one, so hold on to your session until the game ends.
- the ai pays for its own replies out of the stakes, one payment per reply. if the house runs out of thinking money the game says so and takes no stake.
- machine-readable version of this page: ${f.play.url.replace('/play', '')}
`;
}

export function mount(app: express.Express, keep: (p: Promise<unknown> | undefined | null) => void, limited: (req: express.Request, max?: number, kind?: string) => boolean) {
  const expose = (res: express.Response) => res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate, Payment-Receipt');

  app.get('/api/agent', async (req, res) => res.json(await facts(req)));
  app.get(['/api/agent/skill', '/skill.md', '/llms.txt'], async (req, res) => res.type('text/markdown').send(guide(await facts(req))));
  /** the discovery document mpp directories read: what is for sale here and for how much. */
  app.get(['/api/agent/openapi', '/openapi.json'], async (req, res) => {
    const f = await facts(req);
    res.json({
      openapi: '3.1.0',
      info: { title: 'say cheese', version: '1.0.0', description: f.goal },
      servers: [{ url: origin(req) }],
      'x-service-info': { categories: ['ai', 'games'], docs: { homepage: origin(req), llms: '/llms.txt' } },
      paths: {
        '/api/agent/play': { post: {
          summary: 'buy one game',
          'x-payment-info': { offers: [{ amount: String(Math.round(STAKE * 1e6)), currency: net.token, description: `one game of say cheese (${net.symbol} on tempo ${net.name})`, intent: 'charge', method: 'tempo' }] },
          requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { nickname: { type: 'string' }, address: { type: 'string' } } } } } },
          responses: { '200': { description: 'a session to play with' }, '402': { description: 'Payment Required' }, '503': { description: 'closed, asleep or learning. nothing charged.' } },
        } },
        '/api/agent/say': { post: {
          summary: 'say one thing to the ai',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['session', 'message'], properties: { session: { type: 'string' }, message: { type: 'string', maxLength: MAX_MESSAGE_CHARS } } } } } },
          responses: { '200': { description: 'its reply, and whether you won' } },
        } },
        '/api/agent': { get: { summary: 'the game, its price and its state', responses: { '200': { description: 'ok' } } } },
      },
    });
  });

  app.post('/api/agent/play', async (req, res) => {
    expose(res);
    // an unpaid request costs the caller nothing and the server a little: a price is quoted, the database is read.
    if (limited(req, 30, 'play')) return res.status(429).json({ error: 'slow down' });
    try {
      const claimed = req.body?.address;
      if (claimed !== undefined && claimed !== null && claimed !== '' && !isAddress(String(claimed))) return res.status(400).json({ error: 'address: a tempo address, or leave it out and the wallet that pays is used' });
      // the machine's address plays outside the rate limits and can win nothing. nobody buys a game as it.
      if (claimed && playsFree(String(claimed))) return res.status(400).json({ error: 'address: that one is the machine\'s. use your own, or leave it out.' });
      // everything that could refuse the game is checked before any money is asked for.
      const up = await think.awake();
      if (!up.ok) return res.status(503).json({ error: `it is asleep: ${up.why}. nothing was charged.`, asleep: true });
      if (await db.lockSince('harden')) return res.status(503).json({ error: 'it is learning from a win. nothing was charged. try again in a minute.', retry_after: 30 });
      // a game the ai's learning cut short: its session id buys back the messages that were left. no charge.
      const prior = req.body?.session;
      if (prior !== undefined && prior !== null && prior !== '') {
        const c = await carryOn(String(prior));
        if (!c) return res.status(409).json({ error: 'that game has nothing to carry over. leave "session" out to buy a new one.' });
        return res.json({ ok: true, carried: true, session: c.session, generation: c.gen, pot: c.jackpot, turns_left: c.turnsLeft, playing_as: c.player,
          note: 'this is the rest of the game that was interrupted. nothing was charged.' });
      }
      if (flag('CLOSED')) return res.status(503).json({ error: 'closed for now. nothing was charged.' });
      const { mppx, Receipt } = await load();
      const gen = await db.currentGeneration();
      const request = toRequest(req);
      const paid = await mppx.charge({ amount: String(STAKE), description: `say cheese: one game against generation ${gen.gen}` })(request);
      if (paid.status === 402) return void (await reply(res, paid.challenge));

      // paid. from here on the money has moved, so every path below either seats the player or says exactly what happened.
      const seen = payments.get(request) || {};
      let tx = seen.reference;
      if (!tx) { try { tx = Receipt.fromResponse(paid.withReceipt(new Response(null)))?.reference; } catch { /* no receipt header */ } }
      if (!tx) { console.error('[agent] a payment verified but carried no reference'); return void (await reply(res, paid.withReceipt(Response.json({ error: 'paid, but the payment carried no reference. tell the operator.' }, { status: 502 })))); }
      const payer = (seen.payer && isAddress(seen.payer) ? seen.payer : null) || (await treasury.senderOf(tx, treasury.agentAddress, STAKE));
      const player = claimed ? String(claimed) : payer;
      if (!player) { console.error(`[agent] stake ${tx} verified but no payer could be read`); return void (await reply(res, paid.withReceipt(Response.json({ error: 'paid, but the paying wallet could not be read. send the request again with {"address": "0x…"}; the operator can see this payment.', payment: tx }, { status: 502 })))); }
      const s = await openPaidSession(player, req.body?.nickname ?? null, tx);
      if (s.status !== 200) return void (await reply(res, paid.withReceipt(Response.json({ ...s.body, payment: tx }, { status: s.status }))));
      console.log(`[agent] ${player} bought a game over mpp (${tx})`);
      const base = origin(req);
      await reply(res, paid.withReceipt(Response.json({
        ok: true, session: s.body.session, generation: s.body.gen, pot: s.body.jackpot, turns_left: MAX_TURNS,
        playing_as: player, prize_goes_to: player, payment: tx,
        next: { method: 'POST', url: `${base}/api/agent/say`, body: { session: s.body.session, message: 'your first message' } },
        goal: `get it to say "${WORD}". its rules: ${base}/api/state`,
      })));
    } catch (e) {
      console.error('[agent] play', e);
      if (!res.headersSent) res.status(500).json({ error: 'something broke before any payment was taken. try again.' });
    }
  });

  app.post('/api/agent/say', async (req, res) => {
    if (limited(req)) return res.status(429).json({ error: 'slow down' });
    try {
      const { session, message } = req.body || {};
      const r = await runChat(String(session), message);
      keep(r.hardening);
      if (r.status !== 200) {
        // interrupted by someone else's win: say exactly how to get the rest of the game back.
        if (r.body?.carry) return res.status(r.status).json({ error: r.body.error, carry: { turns_left: r.body.carry.turnsLeft, how: { method: 'POST', url: `${origin(req)}/api/agent/play`, body: { session: String(session) } } } });
        return res.status(r.status).json(r.body);
      }
      const won = !!r.body.win;
      const late = !!r.body.win?.late;
      res.json({
        reply: r.body.turns?.[1]?.text ?? '', won, turns_left: r.body.turnsLeft,
        // what the house paid for this reply, and the transaction that paid it.
        ...(r.body.turns?.[1]?.paid ? { it_paid: { ...r.body.turns[1].paid, explorer: think.describe().explorer } } : {}),
        ...(won && !late ? { prize: r.body.win.prize, note: 'you won. the prize is sent to your wallet once the ai has finished learning from this conversation, usually within a minute.' } : {}),
        ...(late ? { prize: 0, late: true, note: 'it said the word, but someone else beat this generation a moment before you and the pot was theirs.',
          ...(r.body.win.carry ? { carry: { turns_left: r.body.win.carry.turnsLeft, how: { method: 'POST', url: `${origin(req)}/api/agent/play`, body: { session: String(session) } } } } : {}) } : {}),
        ...(!won && r.body.turnsLeft === 0 ? { note: 'that was the last message of this game.' } : {}),
      });
    } catch (e) { console.error('[agent] say', e); res.status(500).json({ error: 'something broke. that message did not count.' }); }
  });
}
