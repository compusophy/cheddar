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
/**
 * what the lessons after players' wins may cost in a day, out of the daily ceiling. a reply costs a
 * twentieth of a cent and a lesson can cost tens of cents: it rewrites the rules and replays old
 * conversations against them. without a share of its own, a handful of wins in a day spent all of
 * it on lessons and left nothing to reply with, and anyone able to keep winning could do that on
 * purpose for about a nickel a time. when it is nearly gone the house stops selling games until it
 * has room again (see `canLearn`): it does not take a stake it could not afford to learn from losing.
 */
export const LESSON_DAILY_CAP = num('LESSON_DAILY_CAP', Math.round(THINK_DAILY_CAP * 70) / 100);
/**
 * which share of the day a thought is counted against, if any. a reply to a player is counted
 * against none, only the day's ceiling. so is a lesson from one of the machine's wins: the machine
 * stops playing once its games and lessons together have cost its allowance, so there is at most one
 * such lesson past it, and that one is finished properly rather than cut short.
 */
const shareOf = (purpose: string): db.Share | undefined =>
  purpose === 'machine' ? { purposes: ['machine'], cap: MACHINE_DAILY_CAP, name: 'machine' }
    : purpose === 'patch' || purpose === 'test' || purpose === 'lesson' ? { purposes: ['patch', 'test', 'lesson'], cap: LESSON_DAILY_CAP, name: 'lesson' }
      : undefined;
/** a plain bearer key, for an endpoint that is not paid per call. unset in the normal setup. */
const API_KEY = env('THINK_API_KEY');

const rawKey = env('THINK_KEY') || env('AGENT_PRIVATE_KEY');
if (!isKey(rawKey)) throw new Error('[think] no wallet to think with: set AGENT_PRIVATE_KEY (or THINK_KEY)');
const account = privateKeyToAccount(rawKey);
export const payer = account.address;
const reader = createPublicClient({ chain, transport: http(rpc) });

export const describe = () => ({ url: new URL(THINK_URL).host, network: thinkNetName, payer, keyed: !!API_KEY,
  explorer: thinkNetName === 'mainnet' ? 'https://explore.tempo.xyz' : 'https://explore.moderato.tempo.xyz' });

/**
 * why a thought was not bought. the four are not interchangeable, and what a lesson does next depends
 * on which it was:
 *   asleep   the house cannot pay for this right now: an empty wallet, the day's ceiling reached,
 *            or a dear thought that costs more than is free. nothing is wrong that money or time
 *            will not fix: whatever was under way waits.
 *   budget   the day's budget for this kind of thinking ran out in the act: the ceiling, or a share
 *            of it. a lesson that has a rewrite in hand ships it with the tests it got through.
 *   price    the seller made no offer the wallet may accept: dearer than a thought may cost, or in
 *            a token or on a chain it does not pay in. asking again will get the same answer, so
 *            the caller does without it.
 *   trouble  anything else: the seller did not answer, a payment failed, a balance could not be
 *            read. not a statement about money at all. the caller tries again later.
 */
export type BrokeKind = 'asleep' | 'budget' | 'price' | 'trouble';
/** it could not pay. the caller tells the player nothing was used up. */
export class Broke extends Error {
  constructor(why: string, readonly kind: BrokeKind = 'trouble') { super(why); this.name = 'Broke'; }
}

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
        // when the house pays its own network fee (the seller did not offer to, or its offer failed),
        // it pays it in the same token, so that one balance is all the wallet ever needs.
        feeToken: THINK_TOKEN,
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
 * real stakes. when the stakes and the thinking money are one wallet, the players are what pays for
 * the ai's thoughts, and the house needs no money of its own to begin:
 *
 *   - the stake about to arrive pays for its own game. the house's share of it (a fifth, five cents)
 *     is thinking money the moment it lands, and a whole game of replies costs less (GAME_NEED).
 *   - a win pays for its own lesson. when the house has less free than a lesson costs, what it lacks
 *     is kept back from the pot before the prize goes out: never more than LESSON_LEVY of the pot (a
 *     fifth), and nothing at all once the house can afford the lesson by itself.
 *   - a lesson is cut to its short form when the money is short, and is begun with LESSON_MIN free.
 *
 * so a house that starts at zero can sell its first game, and a loss never leaves it with rules it
 * cannot afford to fix. off (0) unless the wallet is shared; on by default only on real money.
 */
export const LEVY = SHARED ? Math.min(0.5, Math.max(0, num('LESSON_LEVY', net.real ? 0.2 : 0))) : 0;
export const LESSON_MIN = num('LESSON_MIN', 0.05);
export const GAME_NEED = num('GAME_NEED', 0.03);
/**
 * below this the house is treated as unable to think. it is also the cushion: what is left when the
 * thinking stops still has to pay the network fee on a prize, and to cover the few thoughts bought
 * between two looks at the wallet. on real stakes it is a cent, so that the first game is playable
 * on the five cents its own stake brings.
 */
const FLOOR = num('THINK_FLOOR', LEVY > 0 ? 0.01 : 0.05);

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
/** `wakesIn` is seconds until it can think again, when that is known: a spent daily budget frees up by itself, an empty wallet does not. */
export type Awake = { ok: boolean; why: string | null; balance: number | null; reserved: number; available: number | null; wakesIn?: number; /** the wallet could not be read: not a statement about money. */ unknown?: boolean; /** there is money, and less of it than the floor. */ short?: boolean };
let last: { at: number; value: Awake } | null = null;
let looking: Promise<Awake> | null = null;
export async function awake(fresh = false): Promise<Awake> {
  // on real stakes a no is kept for a few seconds only: money may be on its way in, and the first
  // game on an empty wallet must not be told no for twenty. everywhere else, and whenever the
  // wallet could not be read, an answer is kept the full twenty: an empty house is asked the same
  // question by every open page, and the chain's public endpoint is not ours to lean on.
  if (!fresh && last && Date.now() - last.at < (last.value.ok || last.value.unknown || !(LEVY > 0) ? 20_000 : 3_000)) return last.value;
  // several askers at the same moment share one look at the wallet.
  if (!fresh && looking) return looking;
  const p: Promise<Awake> = look().finally(() => { if (looking === p) looking = null; });
  looking = p;
  return p;
}
/** a thought has been bought: what is free is less by its price. near the floor the wallet is read again rather than trusted. */
function noteSpent(price: number) {
  if (!last || last.value.available === null) return;
  const available = Math.round((last.value.available - price) * 1e6) / 1e6;
  last = available < FLOOR * 2 ? null : { at: last.at, value: { ...last.value, available } };
}
async function look(): Promise<Awake> {
  let value: Awake;
  try {
    const spent = await db.thoughtSpent24h();
    if (API_KEY) value = { ok: true, why: null, balance: null, reserved: 0, available: null };
    else {
      const m = await spendable();
      const why = spent >= THINK_DAILY_CAP ? "today's thinking budget is spent" : m.available < FLOOR ? 'out of thinking money' : null;
      value = { ok: !why, why, ...m, ...(why && spent < THINK_DAILY_CAP ? { short: true } : {}) };
      if (spent >= THINK_DAILY_CAP) {
        const at = await db.thinkingFreesAt(THINK_DAILY_CAP, Math.min(FLOOR, THINK_DAILY_CAP)).catch(() => null);
        if (at) value.wakesIn = Math.max(1, Math.ceil((at.getTime() - Date.now()) / 1000));
      }
    }
  } catch (e) {
    // could not read the balance: say so plainly rather than guess either way.
    value = { ok: false, why: 'cannot check its thinking money right now', balance: null, reserved: 0, available: null, unknown: true };
    console.error('[think] awake check failed', (e as Error).message);
  }
  last = { at: Date.now(), value };
  return value;
}

/**
 * could the house pay for a whole lesson right now?
 *
 * this is the question behind every stake. the house does not sell a game it could not afford to
 * learn from losing: a game against rules that have been beaten and cannot yet be fixed is not the
 * game. so it asks for the price of a lesson, not of a reply, in three places at once: free in the
 * wallet, left under the day's ceiling, and (for a lesson that follows a player's win) left in the
 * day's share for lessons. a lesson is not begun on less either, because one that runs out part-way
 * has paid for work it throws away. the answer comes with why not, and when, if time will fix it.
 *
 * `awake` is the narrower question, asked before each single thought: can this one be paid for.
 * it reads the wallet; this reads nothing more from the chain, so it cannot fail where `awake` answers.
 */
export const LESSON_NEED = num('LESSON_NEED', 0.5);
// settings that can never be met are said out loud, once, where the operator will see them: a game
// that will not sell a single game looks, from outside, exactly like one that is out of money.
const NEVER_SELLS = LESSON_NEED > Math.min(LESSON_DAILY_CAP, THINK_DAILY_CAP) + 1e-9;
if (NEVER_SELLS) console.warn(`[think] LESSON_NEED ($${LESSON_NEED}) is more than a day allows (LESSON_DAILY_CAP $${LESSON_DAILY_CAP}, THINK_DAILY_CAP $${THINK_DAILY_CAP}): no game will ever be sold. lower LESSON_NEED or raise the caps.`);
/**
 * `besides`: money that stops being free the moment a game is lost (the pot's next seed, when the pot and the thinking money are one wallet).
 * `need`: what has to be free in the wallet. the price of a lesson, unless the caller knows better (real stakes: see LEVY).
 * `incoming`: money about to arrive that will be free when it does (the house's share of the stake being asked for).
 */
export async function canLearn(whose: 'house' | 'machine' = 'house', fresh = false, besides = 0, need = LESSON_NEED, incoming = 0): Promise<Awake> {
  const seen = await awake(fresh);
  // with a stake on its way in, a wallet that is only short of the floor is not a no yet: the stake is counted first.
  if (!seen.ok && !(incoming > 0 && seen.short)) return seen;
  const a: Awake = { ...seen, ok: true, why: null, short: undefined };
  const no = (why: string, at?: Date | null): Awake => ({ ...a, ok: false, why, ...(at ? { wakesIn: Math.max(1, Math.ceil((at.getTime() - Date.now()) / 1000)) } : {}) });
  if (NEVER_SELLS) return no('a lesson is set to cost more than a day of thinking may: its settings need a look');
  try {
    if ((await db.thoughtSpent24h()) + LESSON_NEED > THINK_DAILY_CAP + 1e-9) return no("today's thinking budget is nearly spent", await db.thinkingFreesAt(THINK_DAILY_CAP, LESSON_NEED).catch(() => null));
    if (whose === 'house' && (await db.lessonSpent24h()) + LESSON_NEED > LESSON_DAILY_CAP + 1e-9) return no("today's money for lessons is spent", await db.lessonFreesAt(LESSON_DAILY_CAP, LESSON_NEED).catch(() => null));
  } catch (e) {
    console.error('[think] could not check the day\'s budgets', (e as Error).message);
    return no('cannot check its thinking money right now');
  }
  if (a.available !== null && a.available + incoming + 1e-9 < need + besides) {
    // said as what it is: short of the thinking itself, or only of the money a loss would call on (the pot's next seed).
    const butFor = besides > 0 && a.available + incoming + 1e-9 >= need;
    return no(butFor ? 'it cannot put up the next pot yet' : incoming > 0 ? 'too little thinking money left to play a game' : 'too little thinking money left to learn from a loss');
  }
  return a;
}
/** what is free has just changed by more than a rounding (a stake landed, a pot became a prize): the next look reads the wallet again. */
export const forgetAwake = () => { last = null; };
/** real stakes: is the house selling a game? this game's replies have to be payable once its stake has landed, and the day's budgets need room. */
export const canSell = (fresh = false, incoming = 0, besides = 0): Promise<Awake> => canLearn('house', fresh, besides, GAME_NEED, incoming);
/** real stakes: how much of a lesson's price the house does not have free right now. it is what a win's levy is asked to cover, and no more. */
/** `reseed`: what the pot is filled back up to after the win, out of the same wallet. it stops being free at that moment. */
export async function lessonLack(reseed = 0): Promise<number> {
  if (!(LEVY > 0)) return 0;
  const before = last?.value.available ?? null;
  const a = await awake(true);
  // no wallet to read (a key pays for thoughts): nothing is lacking that a levy could fix.
  if (a.available === null && !a.unknown) return 0;
  // the wallet could not be read at this moment: go by the last reading there was. with none at
  // all, ask for the whole share: a lost game nobody can pay to learn from is the worse mistake.
  const free = a.available ?? before;
  if (free === null) return LESSON_NEED;
  return Math.max(0, Math.round((LESSON_NEED + reseed - free) * 1e6) / 1e6);
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
  /**
   * how much hidden reasoning to ask for, on models that reason. on those models the reasoning is
   * taken out of the same token budget as the answer, so a long answer wants this kept low.
   */
  reasoning?: 'low' | 'medium' | 'high';
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
    body: JSON.stringify({ model: a.model, messages: a.messages, max_tokens: a.maxTokens, stream: !!a.onDelta, ...(a.reasoning ? { reasoning: { effort: a.reasoning } } : {}) }),
    signal: AbortSignal.timeout(120_000),
  };
  let prepared: any;
  try { prepared = await mppx.prepareRequest(THINK_URL, init); }
  catch (e) {
    // the seller answered and made no offer the wallet is allowed to accept: wrong token, wrong chain,
    // or dearer than the ceiling. asking again gets the same answer. anything else that goes wrong
    // here (no answer at all, a timeout) is trouble on the way, and may be gone the next time.
    const msg = (e as Error).message || '';
    throw new Broke(`no payable offer from the model: ${msg.slice(0, 200)}`, /no method found/i.test(msg) ? 'price' : 'trouble');
  }
  if (!prepared.payment) return { res: prepared.response, paid: false, sellerFailed: false, cost: 0, tx: null };
  // the same question the game asks before it takes a stake, asked again before every payment: a
  // game already under way does not get to think with money that is promised to a winner.
  const up = await awake();
  // a wallet that could not be read is trouble on the way, not an empty wallet: a lesson must not take it for the money running out.
  if (!up.ok) throw new Broke(up.why || 'asleep', up.unknown ? 'trouble' : 'asleep');
  const price = amountOf(prepared.payment.challenge);
  const ceiling = a.maxPrice ?? THINK_MAX_PRICE;
  if (!(price > 0) || price > ceiling) throw new Broke(`a thought was quoted at $${price}; the ceiling is $${ceiling}`, 'price');
  // being awake means there is at least the floor to think with, which covers a reply many times
  // over. a dear thought (the rule rewrite after a loss) can cost more than the floor, and paying
  // it then would come out of the pot or a prize still owed. it is checked against what is free.
  if (price > FLOOR) {
    const m = await spendable().catch(() => null);
    last = null; // what is free is about to change by more than a rounding, or could not be read: look again next time
    if (!m) throw new Broke('cannot check what is free to think with right now');
    // and it has to leave the floor behind it: the replies that test a rewrite, and the fee on the prize, come after.
    if (price + FLOOR > m.available + 1e-9) throw new Broke(`a thought at $${price} would leave less than the $${FLOOR} it keeps back: $${m.available} is free to think with`, 'asleep');
  }
  const rsv = await db.reserveThought(a.purpose, a.model, price, THINK_DAILY_CAP, shareOf(a.purpose));
  if (!rsv.ok) throw new Broke(rsv.why, 'budget'); // the day's ceiling, or this kind of thinking's share of it
  noteSpent(price);
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
  if (res.status === 402) {
    // refused outright. in pull mode nothing was sent by this side, so the money is free again and the
    // caller may try once more paying its own fee; refused there too, the house simply cannot buy this thought.
    await db.releaseThought(rsv.id); last = null;
    if (!mode) return { res, paid: false, sellerFailed: true, cost: 0, tx: null };
    throw new Broke('the payment for a thought was refused');
  }
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
export async function askPaid(a: Ask): Promise<{ text: string; paid: Paid; cutOff: boolean }> {
  const pushing = MODE === 'push' || Date.now() < pushUntil;
  let t = await attempt(a, pushing ? 'push' : undefined);
  if (t.sellerFailed && !pushing && MODE !== 'pull') {
    console.warn(`[think] the seller did not complete a payment it was to broadcast (${t.res.status}). paying our own fee for the next ten minutes.`);
    pushUntil = Date.now() + 10 * 60_000;
    t = await attempt(a, 'push');
  }
  const { res } = t;
  if (res.status === 402) throw new Broke('the payment for a thought was refused');
  if (!res.ok) throw new Error(`[think] the model answered ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
  let text: string, finish: string | null;
  if (a.onDelta) ({ text, finish } = await readStream(res, a.onDelta));
  else { const choice = ((await res.json()) as any)?.choices?.[0]; text = choice?.message?.content ?? ''; finish = choice?.finish_reason ?? null; }
  // "length" is the model saying it ran out of room: what came back stops mid-thought.
  return { text, paid: t.paid ? { cost: t.cost, tx: t.tx } : null, cutOff: finish === 'length' };
}
/** the same, for callers that only want the words. */
export const ask = async (a: Ask): Promise<string> => (await askPaid(a)).text;

/** an openai-style event stream: `data: {json}` lines, a `[DONE]` at the end, comment lines in between. */
async function readStream(res: Response, onDelta: (t: string) => void): Promise<{ text: string; finish: string | null }> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '', text = '', finish: string | null = null;
  const eat = (line: string) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    try { const c = JSON.parse(data)?.choices?.[0]; const t = c?.delta?.content; if (typeof t === 'string' && t) { text += t; onDelta(t); } if (c?.finish_reason) finish = c.finish_reason; } catch { /* a partial or foreign line */ }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) { eat(buf.slice(0, i).trimEnd()); buf = buf.slice(i + 1); }
  }
  eat(buf.trimEnd());
  return { text, finish };
}

/** exact units, for callers that deal in money rather than display numbers. */
export const toUnits = (n: number) => parseUnits(n.toFixed(6), 6);
