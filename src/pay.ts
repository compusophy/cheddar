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
let loaded: Promise<{ mppx: any; Receipt: any; Credential: any }> | null = null;
function load() {
  return (loaded ||= (async () => {
    const [{ Mppx, tempo, Store }, { Receipt, Credential }] = await Promise.all([import('mppx/server'), import('mppx')]);
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
    return { mppx, Receipt, Credential };
  })().catch((e) => { loaded = null; throw e; }));
}
/**
 * has the money for this request already left the payer?
 *
 * a payment arrives one of two ways. "pull": the payer signs a transfer and hands it over, and it
 * only happens if this server sends it. "push": the payer sends the transfer themselves and hands
 * over its hash. a pulled payment can still be turned away at no cost to anyone. a pushed one has
 * been made: turning the request away then keeps the money and gives nothing for it.
 */
function movedAlready(Credential: any, request: Request): boolean {
  try { return ['hash', 'zone'].includes(Credential.fromRequest(request)?.payload?.type); }
  catch { return false; } // no credential, or not one this understands: nothing has been paid yet
}

/**
 * a fingerprint of the payment a request carries: enough to recognise the same payment presented
 * again, and of no use to anyone who reads it. null when the request carries none.
 */
function fingerprint(req: express.Request): string | null {
  const h = String(req.headers.authorization || '').trim();
  return /^Payment\s+\S/i.test(h) ? createHash('sha256').update(h).digest('hex') : null;
}
/**
 * a payment this server has already taken, presented again. the game it bought is found (or, if it
 * was never opened, opened now) and handed back. nothing is charged: nothing is even asked of the
 * payment layer. the payment is recognised by the credential itself, which only its payer holds, and
 * never by a transaction hash a caller names, which anyone can read off the chain.
 */
async function sameAgain(req: express.Request, res: express.Response, cred: string, was: { tx_hash: string; payer: string | null; session_id: string | null }, claimed: string | null) {
  let sessionId = was.session_id || (await db.sessionOfStake(was.tx_hash));
  if (!sessionId) {
    const player = claimed || was.payer || (await treasury.senderOf(was.tx_hash, treasury.agentAddress, STAKE));
    if (!player) return res.status(502).json({ error: 'this payment was taken, but the paying wallet could not be read. send the same request again, with the same payment attached and {"address": "0x…"}: it is not charged twice.', payment: was.tx_hash });
    const s = await openPaidSession(player, req.body?.nickname ?? null, was.tx_hash);
    sessionId = s.status === 200 ? (s.body as any).session : await db.sessionOfStake(was.tx_hash);
    if (!sessionId) return res.status(s.status).json({ ...s.body, payment: was.tx_hash });
    console.log(`[agent] ${player} was seated on asking again, for a payment already taken (${was.tx_hash})`);
  }
  if (!was.session_id) await db.seatAgentPayment(cred, sessionId);
  const [row, gen] = await Promise.all([db.getSession(sessionId), db.currentGeneration()]);
  if (!row) return res.status(409).json({ error: 'this payment bought a game that is no longer on record. nothing more was charged.', payment: was.tx_hash });
  const live = row.status === 'open' && row.gen === gen.gen;
  const base = origin(req);
  res.json({
    ok: true, again: true, session: sessionId, generation: row.gen, turns_left: Math.max(0, MAX_TURNS - row.turns),
    playing_as: row.player, prize_goes_to: row.player, payment: was.tx_hash, over: !live,
    note: live ? 'this payment already bought this game. nothing more was charged: carry on with it.'
      : `this payment already bought a game, and that game is over (${row.status === 'open' ? 'the rules have changed since' : row.status}). nothing more was charged. if it was interrupted, POST {"session": "${sessionId}"} here for what was left of it; otherwise ask again with no payment attached, for a new price.`,
    ...(live ? { next: { method: 'POST', url: `${base}/api/agent/say`, body: { session: sessionId, message: 'your next message' } }, goal: `get it to say "${WORD}". its rules: ${base}/api/state` } : {}),
  });
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

you get back a \`session\`. nothing is charged if the game is closed, asleep or busy learning: those answer 503 before any payment is asked for, and a payment you have signed but not sent is not sent. a payment you sent yourself (push mode) has been made, so it is never turned away: you get your game whatever state the game is in, with a \`note\` saying what to expect.

the request is safe to send again. if the answer never reaches you, or says the game could not be opened, send the same request with the same payment attached: you get the game that payment bought (\`"again": true\`) and are not charged twice.

## 3. talk to it (free, until the game ends)

\`\`\`
POST ${f.say.url}
content-type: application/json

{"session": "<session>", "message": "hello"}
\`\`\`

each answer is \`{"reply": "...", "won": false, "turns_left": 24}\`. when \`won\` is true you are done and the prize is on its way.

a prize is sent to the wallet that paid for the game, once it has learned from the conversation. the \`prize_status\` url in the winning answer says what has been paid (\`paid\`, \`payments\` with a receipt each) and what has not (\`still_owed\`, with \`waiting_for\` and \`next_payment_in\` seconds). the house pays one wallet a limited amount a day, so a very large pot arrives in parts, by itself.

a 429 means the game is busy (too many messages at once, from you or from everyone). that message did not count and used none of your turns: wait \`retry_after\` seconds and send it again.

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
    let taken: string | null = null; // the payment, from the moment it has been taken
    try {
      const claimed = req.body?.address;
      if (claimed !== undefined && claimed !== null && claimed !== '' && !isAddress(String(claimed))) return res.status(400).json({ error: 'address: a tempo address, or leave it out and the wallet that pays is used' });
      // the machine's address plays outside the rate limits and can win nothing. nobody buys a game as it.
      if (claimed && playsFree(String(claimed))) return res.status(400).json({ error: 'address: that one is the machine\'s. use your own, or leave it out.' });
      // the same request, sent again with the same payment attached, is the same purchase. it is answered
      // with the game that payment bought and nothing is charged twice: an answer lost on the way, or a
      // game that could not be opened the first time, costs the payer one more request and nothing else.
      const cred = fingerprint(req);
      const before = cred ? await db.agentPayment(cred) : undefined;
      if (cred && before) return void (await sameAgain(req, res, cred, before, claimed ? String(claimed) : null));
      const { mppx, Receipt, Credential } = await load();
      const request = toRequest(req);
      // everything that could refuse the game is checked before any money is asked for, or taken. but a
      // payment the payer has already sent themselves is not turned away for any of it: the money has
      // moved, so the game is theirs, exactly as a stake that has left a purse always becomes a game.
      const moved = movedAlready(Credential, request);
      const [up, learning] = await Promise.all([think.awake(), db.lockSince('harden')]);
      if (!moved && !up.ok) return res.status(503).json({ error: `it is asleep: ${up.why}. nothing was charged.`, asleep: true, ...(up.wakesIn ? { retry_after: up.wakesIn } : {}) });
      if (!moved && learning) return res.status(503).json({ error: 'it is learning from a win. nothing was charged. try again in a minute.', retry_after: 30 });
      // a game the ai's learning cut short: its session id buys back the messages that were left. no charge.
      const prior = req.body?.session;
      if (prior !== undefined && prior !== null && prior !== '') {
        const c = await carryOn(String(prior));
        if (!c) return res.status(409).json({ error: 'that game has nothing to carry over. leave "session" out to buy a new one.' });
        return res.json({ ok: true, carried: true, session: c.session, generation: c.gen, pot: c.jackpot, turns_left: c.turnsLeft, playing_as: c.player,
          note: 'this is the rest of the game that was interrupted. nothing was charged.' });
      }
      if (!moved && flag('CLOSED')) return res.status(503).json({ error: 'closed for now. nothing was charged.' });
      const gen = await db.currentGeneration();
      const paid = await mppx.charge({ amount: String(STAKE), description: `say cheese: one game against generation ${gen.gen}` })(request);
      if (paid.status === 402) return void (await reply(res, paid.challenge));

      // paid. from here on the money has moved, so every path below either seats the player or says exactly what happened.
      const seen = payments.get(request) || {};
      let tx = seen.reference;
      if (!tx) { try { tx = Receipt.fromResponse(paid.withReceipt(new Response(null)))?.reference; } catch { /* no receipt header */ } }
      if (!tx) { console.error('[agent] a payment verified but carried no reference'); return void (await reply(res, paid.withReceipt(Response.json({ error: 'paid, but the payment carried no reference. tell the operator.' }, { status: 502 })))); }
      taken = tx;
      const payer = (seen.payer && isAddress(seen.payer) ? seen.payer : null) || (await treasury.senderOf(tx, treasury.agentAddress, STAKE));
      // written down before anything else is done with it: if the game cannot be opened now, the same
      // request sent again finds the payment here and opens it then.
      if (cred) await db.noteAgentPayment(cred, tx, payer).catch((e) => console.error('[agent] a payment was taken and could not be noted:', tx, (e as Error).message));
      const player = claimed ? String(claimed) : payer;
      if (!player) { console.error(`[agent] stake ${tx} verified but no payer could be read`); return void (await reply(res, paid.withReceipt(Response.json({ error: 'paid, but the paying wallet could not be read. send the same request again, with the same payment attached and {"address": "0x…"}: it is not charged twice.', payment: tx }, { status: 502 })))); }
      const s = await openPaidSession(player, req.body?.nickname ?? null, tx);
      if (s.status !== 200) return void (await reply(res, paid.withReceipt(Response.json({ ...s.body, payment: tx }, { status: s.status }))));
      if (cred) await db.seatAgentPayment(cred, (s.body as any).session).catch(() => { /* the stake itself says which game it bought */ });
      console.log(`[agent] ${player} bought a game over mpp (${tx})`);
      const base = origin(req);
      await reply(res, paid.withReceipt(Response.json({
        ok: true, session: s.body.session, generation: s.body.gen, pot: s.body.jackpot, turns_left: MAX_TURNS,
        playing_as: player, prize_goes_to: player, payment: tx,
        next: { method: 'POST', url: `${base}/api/agent/say`, body: { session: s.body.session, message: 'your first message' } },
        goal: `get it to say "${WORD}". its rules: ${base}/api/state`,
        // seated because the payment had already been made, at a moment the game would otherwise have said no.
        ...(moved && learning ? { note: 'your payment had already been made, so the game is yours. it is learning from a win right now: when it has, this game is carried over to the new rules at no charge (the answer to your next message says how).' }
          : moved && !up.ok ? { note: `your payment had already been made, so the game is yours. it is asleep right now (${up.why}): a message sent while it is asleep is refused and uses none of your turns.` }
          : moved && flag('CLOSED') ? { note: 'your payment had already been made, so the game is yours, though no new games are being sold right now.' } : {}),
      })));
    } catch (e) {
      console.error('[agent] play', e);
      if (!res.headersSent) res.status(500).json(taken
        ? { error: 'your payment was taken, and the game could not be opened just now. send the same request again with the same payment attached: it is not charged twice.', payment: taken }
        : { error: 'something broke before any payment was taken. try again.' });
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
        // busy: the message did not count. say how long to wait, in the words the rest of this door uses.
        if (r.status === 429 && r.body?.retryIn) return res.status(429).json({ error: r.body.error, why: r.body.why, retry_after: r.body.retryIn, note: 'that message did not count and used none of your turns. wait retry_after seconds and send it again.' });
        return res.status(r.status).json(r.body);
      }
      const won = !!r.body.win;
      const late = !!r.body.win?.late;
      res.json({
        reply: r.body.turns?.[1]?.text ?? '', won, turns_left: r.body.turnsLeft,
        // what the house paid for this reply, and the transaction that paid it.
        ...(r.body.turns?.[1]?.paid ? { it_paid: { ...r.body.turns[1].paid, ...(r.body.turns[1].paid.tx ? { receipt: `${think.describe().explorer}/receipt/${r.body.turns[1].paid.tx}` } : {}) } } : {}),
        ...(won && !late ? { prize: r.body.win.prize, prize_status: `${origin(req)}/api/win/${r.body.win.id}`, note: 'you won. the prize is sent to your wallet once the ai has finished learning from this conversation, usually within a minute. prize_status says when it has been paid, with its receipt.' } : {}),
        ...(late ? { prize: 0, late: true, note: 'it said the word, but someone else beat this generation a moment before you and the pot was theirs.',
          ...(r.body.win.carry ? { carry: { turns_left: r.body.win.carry.turnsLeft, how: { method: 'POST', url: `${origin(req)}/api/agent/play`, body: { session: String(session) } } } } : {}) } : {}),
        ...(!won && r.body.turnsLeft === 0 ? { note: 'that was the last message of this game.' } : {}),
      });
    } catch (e) { console.error('[agent] say', e); res.status(500).json({ error: 'something broke. that message did not count.' }); }
  });
}
