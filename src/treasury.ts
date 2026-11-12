import { createClient, createPublicClient, http, encodeFunctionData, parseUnits, formatUnits, isAddress, decodeEventLog, keccak256 } from 'viem';
import { prepareTransactionRequest, signTransaction, sendRawTransaction } from 'viem/actions';
import { privateKeyToAccount } from 'viem/accounts';
import { tempo as tempoMainnet, tempoModerato } from 'viem/chains';
import { net } from './net';

/** the stablecoin every stake and prize is paid in, on whichever network this deployment runs. */
const TOKEN = net.token;

/** tempo, as viem knows it: its transaction type carries the fee token and the expiring nonce used below. */
export const tempoChain = net.real ? tempoMainnet : tempoModerato;

const erc20Abi = [
  { name: 'transfer', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
  { name: 'balanceOf', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'Transfer', type: 'event', anonymous: false,
    inputs: [{ name: 'from', type: 'address', indexed: true }, { name: 'to', type: 'address', indexed: true }, { name: 'value', type: 'uint256', indexed: false }] },
] as const;

const publicClient = createPublicClient({ chain: tempoChain, transport: http(net.rpc) });

function isValidHexKey(key: string): key is `0x${string}` {
  return /^0x[0-9a-fA-F]{64}$/.test(key);
}

const rawKey = (process.env.AGENT_PRIVATE_KEY || '').trim();
export let agentAddress: `0x${string}` = '0x0000000000000000000000000000000000000000';

if (!isValidHexKey(rawKey)) {
  throw new Error('[treasury] AGENT_PRIVATE_KEY missing or invalid. cheddar does not simulate money. run `npm run keygen`.');
}
const account = privateKeyToAccount(rawKey);
agentAddress = account.address;
const wallet = createClient({ account, chain: tempoChain, transport: http(net.rpc) });
console.log(`[treasury] agent wallet ${agentAddress} on ${net.name} (${net.symbol}${net.real ? ', REAL MONEY' : ''})`);

export async function balance(address: `0x${string}` = agentAddress): Promise<string> {
  try {
    const raw = await publicClient.readContract({ address: TOKEN, abi: erc20Abi, functionName: 'balanceOf', args: [address] });
    return formatUnits(raw, 6);
  } catch (e) {
    console.error('[treasury] balance error', (e as Error).message);
    return '0';
  }
}

/**
 * a payment out of the house, made so that it can only ever happen once.
 *
 * the old way sent a transfer and called it paid the moment the node took it. two things could go
 * wrong, and with real money both cost someone: a transfer the node took but the chain never
 * included was recorded as paid (the winner got nothing), and a transfer whose answer was lost on
 * the way back was recorded as failed and sent again (the house paid twice).
 *
 * so a payment is now three steps the caller can stop between:
 *   1. sign it. the transaction uses tempo's expiring nonce: it names a moment after which it can
 *      never be included, and its hash is known before it is sent. the caller writes the hash down.
 *   2. send it, and wait to see it in a block.
 *   3. if the answer is unclear, ask the chain later by that hash. it either landed, or failed, or
 *      its moment passed and it never will. only then may anything be sent again.
 * an expiring nonce also means two payments signed at the same moment cannot collide.
 */
export type Signed = { hash: `0x${string}`; validBefore: number; serialized: `0x${string}` };
export type Outcome = 'landed' | 'failed' | 'pending' | 'expired';
/** how long a signed payment stays sendable. tempo refuses one that is too close to its limit, so this is not much. */
const VALID_SECONDS = 25;

export async function signPayment(to: string, amount: number | string): Promise<Signed> {
  if (!isAddress(to)) throw new Error('invalid recipient address');
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) throw new Error('invalid amount');
  const data = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to as `0x${string}`, parseUnits(n.toFixed(6), 6)] });
  const validBefore = Math.floor(Date.now() / 1000) + VALID_SECONDS;
  // the fee is paid in the token being sent, so the house needs to hold nothing else.
  const request = await prepareTransactionRequest(wallet, { to: TOKEN, data, feeToken: TOKEN, nonceKey: 'expiring', validBefore } as any);
  const serialized = (await signTransaction(wallet, request as any)) as `0x${string}`;
  return { hash: keccak256(serialized), validBefore, serialized };
}

/** what became of a signed payment, as the chain tells it. never guesses: an answer it cannot get is "pending". */
export async function outcomeOf(hash: string, validBefore: number): Promise<Outcome> {
  try {
    const r = await publicClient.getTransactionReceipt({ hash: hash as `0x${string}` });
    return r.status === 'success' ? 'landed' : 'failed';
  } catch (e) {
    if ((e as Error).name !== 'TransactionReceiptNotFoundError') return 'pending';
  }
  try {
    const block = await publicClient.getBlock();
    // well past its limit by the chain's own clock, and still in no block: it never will be.
    if (Number(block.timestamp) <= validBefore + EXPIRY_MARGIN) return 'pending';
  } catch { return 'pending'; }
  // "it never landed" is the one answer that lets a payment be sent again, so it is not taken from a
  // single look. the first "not found" may have come from a node that was behind the one that just
  // gave the time. it is asked once more, now that the limit is known to have passed.
  try {
    const r = await publicClient.getTransactionReceipt({ hash: hash as `0x${string}` });
    return r.status === 'success' ? 'landed' : 'failed';
  } catch (e) { return (e as Error).name === 'TransactionReceiptNotFoundError' ? 'expired' : 'pending'; }
}
/** how far past its limit, in seconds of chain time, a payment must be before it is called expired. */
const EXPIRY_MARGIN = 20;

/** send a signed payment and watch for it. "pending" means: not seen yet, ask again with `outcomeOf`. */
export async function broadcast(p: Signed): Promise<Outcome> {
  let refused = '';
  try {
    const named = await sendRawTransaction(wallet, { serializedTransaction: p.serialized });
    // the hash was worked out here before sending, and everything after looks the payment up by it.
    // if the node calls the same transaction something else, the node's name is the one the chain
    // will know it by: the caller is handed that one, and writes it down in place of ours.
    if (named && named.toLowerCase() !== p.hash.toLowerCase()) { console.error(`[treasury] the node names this payment ${named}, not ${p.hash}. using the node's.`); p.hash = named; }
  }
  catch (e) { refused = (e as Error).message; } // the node may hold it all the same: the chain decides, not this error
  const until = Date.now() + (refused ? 6_000 : 20_000);
  for (;;) {
    const o = await outcomeOf(p.hash, p.validBefore);
    if (o !== 'pending') return o;
    if (Date.now() >= until) { if (refused) console.error('[treasury] payment not seen after a refusal:', refused.slice(0, 200)); return 'pending'; }
    await new Promise((r) => setTimeout(r, 700));
  }
}

/** `maybe`: it was sent and has not been seen in a block yet, so it may still land. */
export type PayResult = { ok: true; hash: string } | { ok: false; error: string; maybe?: boolean };

/** sign, send and confirm in one go, for payments nothing else depends on (the welcome grant). */
export async function pay(to: string, amount: string): Promise<PayResult> {
  try {
    const p = await signPayment(to, amount);
    const o = await broadcast(p);
    if (o === 'landed') { console.log(`[treasury] paid ${amount} ${net.symbol} to ${to}: ${p.hash}`); return { ok: true, hash: p.hash }; }
    if (o === 'pending') return { ok: false, error: 'the transfer was not confirmed', maybe: true };
    return { ok: false, error: o === 'failed' ? 'the transfer was refused' : 'the transfer was not sent in time' };
  } catch (e) {
    console.error('[treasury] pay error', (e as Error).message);
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * verify that a transaction moved at least `amount` of the stablecoin from `from` to `to`.
 * this is how a stake is checked: the purse sends, the server confirms on chain, nothing is trusted
 * from the client. waits briefly for the receipt so a just-sent stake counts.
 */
export async function verifyTransfer(hash: string, from: string, to: string, amount: number): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const receipt = await publicClient.waitForTransactionReceipt({ hash: hash as `0x${string}`, timeout: 20_000 });
    if (receipt.status !== 'success') return { ok: false, error: 'stake transaction failed' };
    const want = parseUnits(amount.toFixed(6), 6);
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== TOKEN.toLowerCase()) continue;
      try {
        const ev = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics, eventName: 'Transfer' });
        if (ev.args.from.toLowerCase() === from.toLowerCase() && ev.args.to.toLowerCase() === to.toLowerCase() && ev.args.value >= want) return { ok: true };
      } catch { /* not a transfer */ }
    }
    return { ok: false, error: 'that transaction is not a stake to the house' };
  } catch (e) {
    return { ok: false, error: 'could not find the stake on chain yet' };
  }
}

/** who sent at least `amount` to `to` in this transaction. the proven payer, read from the chain rather than from what a caller says. */
export async function senderOf(hash: string, to: string, amount: number): Promise<`0x${string}` | null> {
  try {
    const receipt = await publicClient.waitForTransactionReceipt({ hash: hash as `0x${string}`, timeout: 20_000 });
    if (receipt.status !== 'success') return null;
    const want = parseUnits(amount.toFixed(6), 6);
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== TOKEN.toLowerCase()) continue;
      try {
        const ev = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics, eventName: 'Transfer' });
        if (ev.args.to.toLowerCase() === to.toLowerCase() && ev.args.value >= want) return ev.args.from;
      } catch { /* not a transfer */ }
    }
  } catch { /* not found in time */ }
  return null;
}

/** tempo testnet faucet, same two-step fallback say cheese used. there is no such thing on mainnet. */
export async function faucet(address: string): Promise<{ status: number; body: unknown }> {
  if (net.real) return { status: 400, body: { error: 'no faucet on mainnet: fund the house wallet yourself' } };
  const lower = address.toLowerCase();
  // the docs faucet first; if it answers no, or does not answer at all, the node's own faucet method.
  let r: Response | null = null, text = '', body: any = { error: 'unreachable' };
  try {
    r = await fetch('https://docs.tempo.xyz/api/faucet', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: lower }) });
    text = await r.text();
    try { body = JSON.parse(text); } catch { body = { error: text }; }
  } catch (e) { r = null; body = { error: (e as Error).message }; }
  if (!r || !r.ok || body?.error) {
    r = await fetch(net.rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tempo_fundAddress', params: [lower], id: 1 }) });
    text = await r.text();
    try { body = JSON.parse(text); } catch { body = { error: text }; }
  }
  return { status: r.status, body };
}
