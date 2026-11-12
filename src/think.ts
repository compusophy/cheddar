/**
 * how the ai pays for its own thoughts.
 *
 * there is no api key in this project. the model lives behind an http endpoint that answers 402
 * payment required (the machine payments protocol, on tempo), and the house wallet pays for each
 * call with one signed stablecoin transfer: the same wallet that takes the stakes. a reply costs a
 * fraction of a cent, the stake covers it many times over, and every payment is a transaction anyone
 * can look up. the ai is a small business: money in from players, money out for thinking and prizes.
 *
 * three things stand between the model and the wallet, and none of them is the model:
 *   - a ceiling on what one thought may cost (THINK_MAX_PRICE). a dearer quote is refused unsigned.
 *   - a ceiling on what a day of thinking may cost (THINK_DAILY_CAP), reserved in the database
 *     before each payment so two functions cannot both spend the last of it.
 *   - the wallet only ever signs for the one token and the one chain it was told to pay in.
 */
import { createClient, createPublicClient, http, formatUnits, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { tempo as tempoMainnet, tempoModerato } from 'viem/chains';
import { net, num } from './net';
import { agentAddress } from './treasury';
import * as db from './db';

const env = (k: string) => (process.env[k] || '').trim();
const isAddr = (s: string): s is `0x${string}` => /^0x[0-9a-fA-F]{40}$/.test(s);
const isKey = (s: string): s is `0x${string}` => /^0x[0-9a-fA-F]{64}$/.test(s);

/** the model's address. any openai-compatible chat endpoint that charges over mpp will do. */
export const THINK_URL = env('THINK_URL') || 'https://openrouter.mpp.tempo.xyz/v1/chat/completions';
/** where the seller is paid. the public model proxies only take real dollars, so this is mainnet even when the game is on play money. */
const thinkNetName = (env('THINK_NETWORK') || 'mainnet').toLowerCase();
if (thinkNetName !== 'mainnet' && thinkNetName !== 'testnet') throw new Error(`[think] THINK_NETWORK must be "mainnet" or "testnet", not "${thinkNetName}"`);
const chain = thinkNetName === 'mainnet' ? tempoMainnet : tempoModerato;
const rpc = env('THINK_RPC') || (thinkNetName === net.name ? net.rpc : thinkNetName === 'mainnet' ? 'https://rpc.tempo.xyz' : 'https://rpc.moderato.tempo.xyz');
/**
 * the one token the wallet will pay for thoughts in. when thinking and the game share a network it is
 * the game's own token (stakes in, thoughts out, one balance). otherwise USDC.e on mainnet, the
 * faucet dollar on testnet.
 */
const tokenEnv = env('THINK_TOKEN');
if (tokenEnv && !isAddr(tokenEnv)) throw new Error('[think] THINK_TOKEN is not an address');
export const THINK_TOKEN: `0x${string}` = isAddr(tokenEnv) ? tokenEnv
  : thinkNetName === net.name ? net.token
  : thinkNetName === 'mainnet' ? '0x20C000000000000000000000b9537d11c60E8b50' : '0x20c0000000000000000000000000000000000000';

export const THINK_MAX_PRICE = num('THINK_MAX_PRICE', 0.05);
/**
 * the rule rewrite after a loss is one big call on a better model: the whole rulebook and the whole
 * winning conversation go in. it gets its own, higher ceiling, because a rewrite that is refused for
 * its price can never be retried into success and the game would stay beaten.
 */
export const PATCH_MAX_PRICE = num('PATCH_MAX_PRICE', 0.25);
export const THINK_DAILY_CAP = num('THINK_DAILY_CAP', 5);
/** the machine plays free and wins nothing, so its thinking is pure cost. this is its allowance. */
export const MACHINE_DAILY_CAP = num('MACHINE_DAILY_CAP', 0.5);
/** below this the house is treated as unable to think, and no new stake is taken. */
const FLOOR = num('THINK_FLOOR', 0.05);
/** a plain bearer key, for an endpoint that is not paid per call. unset in the normal setup. */
const API_KEY = env('THINK_API_KEY');

const rawKey = env('THINK_KEY') || env('AGENT_PRIVATE_KEY');
if (!isKey(rawKey)) throw new Error('[think] no wallet to think with: set AGENT_PRIVATE_KEY (or THINK_KEY)');
const account = privateKeyToAccount(rawKey);
export const payer = account.address;
const reader = createPublicClient({ chain, transport: http(rpc) });

export const describe = () => ({ url: new URL(THINK_URL).host, network: thinkNetName, payer, keyed: !!API_KEY,
  explorer: thinkNetName === 'mainnet' ? 'https://explore.tempo.xyz' : 'https://explore.moderato.tempo.xyz' });

/** it could not pay. the caller tells the player nothing was used up. */
export class Broke extends Error { constructor(why: string) { super(why); this.name = 'Broke'; } }

// mppx is published as es modules only, and this project compiles to commonjs: load it on first use.
type Loaded = { mppx: any; Receipt: any };
let loaded: Promise<Loaded> | null = null;
function load(): Promise<Loaded> {
  return (loaded ||= (async () => {
    const [{ Mppx, tempo }, { Receipt }] = await Promise.all([import('mppx/client'), import('mppx')]);
    const mppx = Mppx.create({
      polyfill: false,
      methods: [tempo.charge({
        account,
        allowedChainIds: [chain.id],
        currencies: [THINK_TOKEN],
        decimals: 6,
        maxAmount: String(Math.max(THINK_MAX_PRICE, PATCH_MAX_PRICE)),
        ...(isAddr(env('THINK_RECIPIENT')) ? { expectedRecipients: [env('THINK_RECIPIENT') as `0x${string}`] } : {}),
        getClient: () => createClient({ chain, transport: http(rpc) }),
      } as any)],
    } as any);
    return { mppx, Receipt };
  })().catch((e) => { loaded = null; throw e; }));
}

/** does the payment client load here? a deployment can bundle everything else and still miss it. */
export const ready = () => load().then(() => true);

export async function balance(): Promise<number> {
  const raw = await reader.readContract({
    address: THINK_TOKEN, functionName: 'balanceOf', args: [payer],
    abi: [{ name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] }] as const,
  });
  return Number(formatUnits(raw, 6));
}

/**
 * is the wallet that pays for thoughts the same money that holds the pot? it is when thinking and the
 * game share a network, a token and a wallet, which is the normal real-money setup: one balance,
 * stakes in, thoughts and prizes out.
 */
export const SHARED = thinkNetName === net.name && THINK_TOKEN.toLowerCase() === net.token.toLowerCase() && payer.toLowerCase() === agentAddress.toLowerCase();

/**
 * what the house may spend on thoughts. when one balance holds everything, the pot and every win
 * still owed are not thinking money: they are promised to players. only what is left over is the
 * ai's to think with, so a long run of chatter can never eat a prize.
 */
export async function spendable(): Promise<{ balance: number; reserved: number; available: number }> {
  const bal = await balance();
  if (!SHARED) return { balance: bal, reserved: 0, available: bal };
  const [pot, owed] = await Promise.all([db.jackpot(), db.owedTotal()]);
  const reserved = Math.round((pot + owed) * 1e6) / 1e6;
  return { balance: bal, reserved, available: Math.round((bal - reserved) * 1e6) / 1e6 };
}

/**
 * can the house think right now? asked before a stake is taken, so nobody pays for a game the ai
 * cannot afford to play, and again before every thought. cached briefly: it is read on every page load.
 */
export type Awake = { ok: boolean; why: string | null; balance: number | null; reserved: number; available: number | null };
let last: { at: number; value: Awake } | null = null;
export async function awake(fresh = false): Promise<Awake> {
  if (!fresh && last && Date.now() - last.at < 20_000) return last.value;
  let value: Awake;
  try {
    const spent = await db.thoughtSpent24h();
    if (API_KEY) value = { ok: true, why: null, balance: null, reserved: 0, available: null };
    else {
      const m = await spendable();
      const why = spent >= THINK_DAILY_CAP ? "today's thinking budget is spent" : m.available < FLOOR ? 'out of thinking money' : null;
      value = { ok: !why, why, ...m };
    }
  } catch (e) {
    // could not read the balance: say so plainly rather than guess either way.
    value = { ok: false, why: 'cannot check its thinking money right now', balance: null, reserved: 0, available: null };
    console.error('[think] awake check failed', (e as Error).message);
  }
  last = { at: Date.now(), value };
  return value;
}

export type Msg = { role: 'system' | 'user' | 'assistant'; content: string };
export type Ask = {
  model: string;
  messages: Msg[];
  maxTokens: number;
  /** what the thought is for. it names the row in the ledger and picks the budget it draws on. */
  purpose: 'chat' | 'machine' | 'machine-lesson' | 'patch' | 'test' | 'lesson';
  /** the most this one thought may cost. default: THINK_MAX_PRICE. */
  maxPrice?: number;
  onDelta?: (t: string) => void;
};

const amountOf = (challenge: any): number => Number(formatUnits(BigInt(challenge?.request?.amount ?? '0'), 6));

/**
 * who pays the network fee on a payment. a seller can offer to pay it (the buyer signs, the seller
 * adds its own signature and broadcasts): that is "pull", it is the default, and it costs the house
 * nothing extra. if the seller's half of that fails, the house can broadcast the payment itself and
 * pay its own fee, a fraction of a tenth of a cent: that is "push". THINK_MODE=push forces it;
 * otherwise push is used for ten minutes after a seller fails to complete a sponsored payment.
 */
const MODE = env('THINK_MODE').toLowerCase();
if (MODE && MODE !== 'pull' && MODE !== 'push') throw new Error(`[think] THINK_MODE must be "pull" or "push", not "${MODE}"`);
let pushUntil = 0;

/** one attempt at one paid request. `paid` is false only when nothing can have left the wallet. */
async function attempt(a: Ask, mode: 'push' | undefined): Promise<{ res: Response; paid: boolean; sellerFailed: boolean; cost: number; tx: string | null }> {
  const { mppx, Receipt } = await load();
  const init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(API_KEY ? { authorization: `Bearer ${API_KEY}` } : {}) },
    body: JSON.stringify({ model: a.model, messages: a.messages, max_tokens: a.maxTokens, stream: !!a.onDelta }),
    signal: AbortSignal.timeout(120_000),
  };
  let prepared: any;
  try { prepared = await mppx.prepareRequest(THINK_URL, init); }
  catch (e) {
    // no offer the wallet is allowed to accept: wrong token, wrong chain, or dearer than the ceiling.
    throw new Broke(`no payable offer from the model: ${(e as Error).message.slice(0, 200)}`);
  }
  if (!prepared.payment) return { res: prepared.response, paid: false, sellerFailed: false, cost: 0, tx: null };
  // the same question the game asks before it takes a stake, asked again before every payment: a
  // game already under way does not get to think with money that is promised to a winner.
  const up = await awake();
  if (!up.ok) throw new Broke(up.why || 'asleep');
  const price = amountOf(prepared.payment.challenge);
  const ceiling = a.maxPrice ?? THINK_MAX_PRICE;
  if (!(price > 0) || price > ceiling) throw new Broke(`a thought was quoted at $${price}; the ceiling is $${ceiling}`);
  const rsv = await db.reserveThought(a.purpose, a.model, price, THINK_DAILY_CAP, a.purpose === 'machine' ? MACHINE_DAILY_CAP : undefined);
  if (!rsv.ok) throw new Broke(rsv.why);
  let res: Response;
  try { res = await prepared.payment.pay(mode ? { mode } : undefined); }
  catch (e) {
    // a payment that plainly never left (no balance, refused, reverted) returns its money to the
    // day's budget. anything vaguer (a timeout, a dropped connection) may have been paid, so it
    // stays counted: the budget errs on the side of having spent.
    const why = (e as Error).message || '';
    if (/insufficient|revert|rejected|refused|denied|not allowed|exceeds|no offer/i.test(why)) await db.releaseThought(rsv.id);
    last = null; // the balance is the likeliest reason; look again next time someone asks
    throw new Broke(`could not pay for a thought: ${why.slice(0, 200)}`);
  }
  if (res.status === 402) { await db.releaseThought(rsv.id); last = null; throw new Broke('the payment for a thought was refused'); }
  let tx: string | null = null;
  try { tx = Receipt.fromResponse(res)?.reference ?? null; } catch { /* no receipt on this response */ }
  await db.settleThought(rsv.id, tx);
  // a seller that answers 5xx without a receipt took the signed payment and could not finish its
  // half. the row stays counted (the signature was handed over), and the caller may try push.
  return { res, paid: true, sellerFailed: res.status >= 500 && !tx, cost: price, tx };
}

/** what one thought cost and the payment that bought it. `null` when the endpoint asked for nothing. */
export type Paid = { cost: number; tx: string | null } | null;

/** one thought, paid for: the model's text and the receipt. throws `Broke` when the house cannot or will not pay. */
export async function askPaid(a: Ask): Promise<{ text: string; paid: Paid }> {
  const pushing = MODE === 'push' || Date.now() < pushUntil;
  let t = await attempt(a, pushing ? 'push' : undefined);
  if (t.sellerFailed && !pushing && MODE !== 'pull') {
    console.warn(`[think] the seller could not complete a sponsored payment (${t.res.status}). paying our own fee for the next ten minutes.`);
    pushUntil = Date.now() + 10 * 60_000;
    t = await attempt(a, 'push');
  }
  const { res } = t;
  if (!res.ok) throw new Error(`[think] the model answered ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
  const text: string = a.onDelta ? await readStream(res, a.onDelta) : (((await res.json()) as any)?.choices?.[0]?.message?.content ?? '');
  return { text, paid: t.paid ? { cost: t.cost, tx: t.tx } : null };
}
/** the same, for callers that only want the words. */
export const ask = async (a: Ask): Promise<string> => (await askPaid(a)).text;

/** an openai-style event stream: `data: {json}` lines, a `[DONE]` at the end, comment lines in between. */
async function readStream(res: Response, onDelta: (t: string) => void): Promise<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '', text = '';
  const eat = (line: string) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    try { const t = JSON.parse(data)?.choices?.[0]?.delta?.content; if (typeof t === 'string' && t) { text += t; onDelta(t); } } catch { /* a partial or foreign line */ }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) { eat(buf.slice(0, i).trimEnd()); buf = buf.slice(i + 1); }
  }
  eat(buf.trimEnd());
  return text;
}

/** exact units, for callers that deal in money rather than display numbers. */
export const toUnits = (n: number) => parseUnits(n.toFixed(6), 6);
