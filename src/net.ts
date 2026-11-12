/**
 * where the money lives. one switch, NETWORK, so the same code runs on play money and on real money.
 *
 * testnet is the default and needs nothing. mainnet refuses to start without an explicit token: a wrong
 * token address is the one mistake here that cannot be taken back, so it is never guessed and never
 * defaulted. everything else in the codebase asks this file instead of naming a chain.
 */
export type Net = {
  name: 'testnet' | 'mainnet';
  /** true when the dollars are worth dollars. the welcome grant and the faucet only exist when this is false. */
  real: boolean;
  chainId: number;
  /** the chain endpoint this server talks to. TEMPO_RPC can make it a private one, often with a key in its address: it never leaves the server. */
  rpc: string;
  /** the chain endpoint a browser is told to use: always the network's public one, which is also the only one the page's own policy lets it reach. */
  publicRpc: string;
  explorer: string;
  token: `0x${string}`;
  symbol: string;
};

const env = (k: string) => (process.env[k] || '').trim();
const isAddr = (s: string): s is `0x${string}` => /^0x[0-9a-fA-F]{40}$/.test(s);

function load(): Net {
  const which = (env('NETWORK') || 'testnet').toLowerCase();
  if (which !== 'testnet' && which !== 'mainnet') throw new Error(`[net] NETWORK must be "testnet" or "mainnet", not "${which}"`);

  if (which === 'testnet') {
    return {
      name: 'testnet', real: false, chainId: 42431,
      rpc: env('TEMPO_RPC') || 'https://rpc.moderato.tempo.xyz', publicRpc: 'https://rpc.moderato.tempo.xyz',
      explorer: 'https://explore.moderato.tempo.xyz',
      token: '0x20c0000000000000000000000000000000000000', symbol: 'pathUSD',
    };
  }

  const token = env('TOKEN_ADDRESS'), symbol = env('TOKEN_SYMBOL');
  if (!isAddr(token)) throw new Error('[net] mainnet needs TOKEN_ADDRESS: the stablecoin stakes and prizes are paid in. see the readme.');
  if (!symbol) throw new Error('[net] mainnet needs TOKEN_SYMBOL: the name players are told to send (for example USDC.e).');
  return {
    name: 'mainnet', real: true, chainId: 4217,
    rpc: env('TEMPO_RPC') || 'https://rpc.tempo.xyz', publicRpc: 'https://rpc.tempo.xyz',
    explorer: 'https://explore.tempo.xyz',
    token, symbol,
  };
}

export const net: Net = load();

/** a number from the environment, or the default. negative, empty and non-numeric values are ignored. */
export function num(key: string, fallback: number): number {
  const raw = env(key);
  if (!raw) return fallback;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}
/** an on/off switch from the environment. */
export const flag = (key: string) => /^(1|true|yes|on)$/i.test(env(key));
