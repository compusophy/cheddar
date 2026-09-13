import { createWalletClient, createPublicClient, http, defineChain, encodeFunctionData, parseUnits, formatUnits, isAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export const TEMPO_RPC = 'https://rpc.moderato.tempo.xyz';
export const PATH_USD = '0x20c0000000000000000000000000000000000000' as const;
export const EXPLORER = 'https://explore.moderato.tempo.xyz';

export const tempoChain = defineChain({
  id: 42431,
  name: 'tempo moderato',
  network: 'moderato',
  nativeCurrency: { name: 'USD', symbol: 'USD', decimals: 18 },
  rpcUrls: { default: { http: [TEMPO_RPC] }, public: { http: [TEMPO_RPC] } },
});

const erc20Abi = [
  { name: 'transfer', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
  { name: 'balanceOf', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
] as const;

const publicClient = createPublicClient({ chain: tempoChain, transport: http() });

function isValidHexKey(key: string): key is `0x${string}` {
  return /^0x[0-9a-fA-F]{64}$/.test(key);
}

const rawKey = (process.env.AGENT_PRIVATE_KEY || '').trim();
let walletClient: ReturnType<typeof createWalletClient> | null = null;
export let agentAddress: `0x${string}` = '0x0000000000000000000000000000000000000000';

if (!isValidHexKey(rawKey)) {
  throw new Error('[treasury] AGENT_PRIVATE_KEY missing or invalid. cheddar does not simulate money. run `npm run keygen`.');
}
const account = privateKeyToAccount(rawKey);
agentAddress = account.address;
walletClient = createWalletClient({ account, chain: tempoChain, transport: http() });
console.log(`[treasury] agent wallet ${agentAddress}`);

export async function balance(address: `0x${string}` = agentAddress): Promise<string> {
  try {
    const raw = await publicClient.readContract({ address: PATH_USD, abi: erc20Abi, functionName: 'balanceOf', args: [address] });
    return formatUnits(raw, 6);
  } catch (e) {
    console.error('[treasury] balance error', (e as Error).message);
    return '0';
  }
}

export type PayResult = { ok: true; hash: string } | { ok: false; error: string };

/** sends pathUSD from the agent wallet on tempo. every call moves real testnet money. */
export async function pay(to: string, amount: string): Promise<PayResult> {
  if (!isAddress(to)) return { ok: false, error: 'invalid recipient address' };
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, error: 'invalid amount' };
  try {
    const data = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to as `0x${string}`, parseUnits(n.toFixed(6), 6)] });
    const hash = await walletClient!.sendTransaction({ to: PATH_USD, data, account, chain: tempoChain });
    console.log(`[treasury] paid ${n} pathUSD to ${to}: ${hash}`);
    return { ok: true, hash };
  } catch (e) {
    console.error('[treasury] pay error', (e as Error).message);
    return { ok: false, error: (e as Error).message };
  }
}

/** tempo testnet faucet, same two-step fallback say cheese used. */
export async function faucet(address: string): Promise<{ status: number; body: unknown }> {
  const lower = address.toLowerCase();
  let r = await fetch('https://docs.tempo.xyz/api/faucet', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: lower }) });
  let text = await r.text();
  let body: any; try { body = JSON.parse(text); } catch { body = { error: text }; }
  if (!r.ok || body?.error) {
    r = await fetch(TEMPO_RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tempo_fundAddress', params: [lower], id: 1 }) });
    text = await r.text();
    try { body = JSON.parse(text); } catch { body = { error: text }; }
  }
  return { status: r.status, body };
}
