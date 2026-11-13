// tempo wallet, for the page.
//
// a person signs in to tempo's wallet (a passkey: no app, no seed phrase), adds money there with a
// card, and pays the game from it. this file is the whole of the page's dealings with the wallet.
//
// it is tempo's accounts sdk (npm `accounts`) and the payment client (`mppx`), bundled into one file
// so the page can load it from its own origin: the page's content security policy runs scripts from
// nowhere else. the page never sees a key or a passkey. every prompt is the wallet's own window.
// built with `npm run build` in this folder; the result is public/vendor/tempo-wallet.js.
import { Provider, tempoWallet, secp256k1, Mount } from 'accounts';
import { Mppx, tempo } from 'mppx/client';
import { parseUnits } from 'viem';

/**
 * `test`: a throwaway key kept in this browser stands in for the wallet. play money only; the page refuses it on real money.
 * `allow`: at sign-in, the person is asked once to let this site spend up to `perDay` dollars of `token` a day,
 * paid only to `to`. after that a game is paid without opening the wallet again.
 */
type Allow = { token: string; to: string; perDay: string };
type Where = { testnet: boolean; chainId: number; test?: boolean; allow?: Allow };
const DAY = 86_400;
const hex = (n: number) => `0x${n.toString(16)}` as `0x${string}`;
const isAddress = (a: unknown): a is `0x${string}` => /^0x[0-9a-fA-F]{40}$/.test(String(a));

let made: { key: string; provider: ReturnType<typeof Provider.create> } | null = null;
function provider(o: Where) {
  const a = o.test ? undefined : o.allow;
  const key = `${o.testnet}:${!!o.test}:${a ? `${a.token}:${a.to}:${a.perDay}` : ''}`;
  if (!made || made.key !== key) made = { key, provider: Provider.create({
    // the wallet opens as its own window, on its own site. a passkey is then used exactly as it is on
    // wallet.tempo.xyz itself. inside this page (the sdk's other way) the wallet's server refused it.
    adapter: o.test ? secp256k1() : tempoWallet({ mount: Mount.popup() }),
    testnet: o.testnet,
    // the sdk can replace the page's fetch so that any 402 is paid without asking. it is not asked to:
    // a payment is made only where the page asks for one (see `pay`).
    mpp: false,
    ...(a ? { accessKey: { authorize: {
      expiry: Math.floor(Date.now() / 1000) + 30 * DAY,
      limits: [{ token: a.token as `0x${string}`, limit: parseUnits(a.perDay, 6), period: DAY }],
      scopes: [{ address: a.token as `0x${string}`, recipients: [a.to as `0x${string}`] }],
    } } } : {}),
  }) };
  return made.provider;
}
const first = (r: any): string | null => {
  const a = Array.isArray(r) ? r[0] : r?.accounts?.[0];
  const address = typeof a === 'string' ? a : a?.address;
  return isAddress(address) ? address : null;
};

const api = {
  /**
   * get ready, asking nobody anything. on a phone the wallet opens in a window of its own, and a
   * browser lets a page open one only at the moment of a tap: whatever can be done beforehand is.
   */
  async warm(o: Where): Promise<void> {
    try { await (provider(o) as any).ready?.(); } catch { /* it will say so when it is asked for something */ }
  },
  /** the account already signed in here, if there is one. asks nobody anything. */
  async known(o: Where): Promise<string | null> {
    try { return first(await provider(o).request({ method: 'eth_accounts' } as any)); } catch { return null; }
  },
  /** sign in: the wallet opens and asks which account to use. resolves with its address. */
  async connect(o: Where): Promise<string> {
    // the throwaway test key: the one already made is used again; there is none until one is made.
    if (o.test) { const had = await api.known(o); if (had) return had; }
    // the real wallet does its own signing in and signing up.
    const address = first(await provider(o).request({ method: 'wallet_connect', ...(o.test ? { params: [{ capabilities: { method: 'register' } }] } : {}) } as any));
    if (!address) throw new Error('the wallet did not name an account');
    return address;
  },
  /** sign out of the wallet here. */
  async disconnect(o: Where): Promise<void> {
    try { await provider(o).request({ method: 'wallet_disconnect' } as any); } catch { /* nothing to sign out of */ }
  },
  /**
   * the wallet's own "add money": a card or a bank on real money, the faucet on the testnet.
   * resolving means the wallet's window is done, not that the money has arrived: look at the balance.
   */
  async deposit(o: Where & { address: string; token: string; amount?: string }): Promise<void> {
    await provider(o).request({ method: 'wallet_deposit', params: [{
      address: o.address, chainId: hex(o.chainId), token: o.token,
      ...(o.amount ? { amount: o.amount } : {}), ...(o.testnet ? { intent: 'faucet' } : {}),
    }] } as any);
  },
  /** send `amount` (dollars, as text) of `token` from the wallet to `to`. the wallet asks the person. resolves with the transaction's hash. */
  async send(o: Where & { token: string; to: string; amount: string }): Promise<string> {
    const r: any = await provider(o).request({ method: 'wallet_transfer', params: [{ amount: o.amount, to: o.to, token: o.token, chainId: hex(o.chainId) }] } as any);
    const hash = r?.receipt?.transactionHash;
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(hash))) throw new Error('the wallet did not report a transaction');
    return hash;
  },
  /**
   * ask for something that costs money: a request that is answered 402 with a price is paid from the
   * wallet, once, and asked again with the proof. `most` is the most this one request may cost, in
   * dollars: a dearer price is refused here, before the wallet is asked anything.
   *
   * a payment can be made and its answer lost on the way. so the proof is handed to `keep` the
   * moment it exists and taken back (`keep(null)`) once the answer has arrived. shown again later
   * as `kept`, it buys the same thing and is not charged twice.
   */
  async pay(o: Where & { token: string; most: string; kept?: string | null; keep?: (proof: string | null) => void }, url: string, init: RequestInit = {}): Promise<Response> {
    const withProof = (proof: string): RequestInit => ({ ...init, headers: { ...(init.headers as Record<string, string>), authorization: proof } });
    if (o.kept) {
      const again = await fetch(url, withProof(o.kept));
      // anything but "that proof is no good" is the answer to the payment already made.
      if (again.status !== 402 && again.status !== 409) { if (again.ok) o.keep?.(null); return again; }
      o.keep?.(null);
    }
    const unpaid = await fetch(url, init);
    if (unpaid.status !== 402) return unpaid;
    const client: any = Mppx.create({ polyfill: false, methods: [tempo.charge({
      ...(provider(o).getMppxParameters() as any),
      // the wallet sends its own payment and pays its own fee, in the same dollars.
      mode: 'push', allowedChainIds: [o.chainId], currencies: [o.token], feeToken: o.token, decimals: 6, maxAmount: o.most,
    } as any)] } as any);
    const payment = await client.preparePayment(unpaid, { request: init });
    const paid: RequestInit = payment.setCredential(init, await payment.createCredential({ mode: 'push' }));
    const proof = new Headers(paid.headers as HeadersInit).get('authorization');
    if (proof) o.keep?.(proof);
    const res = await fetch(url, paid);
    if (res.ok) o.keep?.(null);
    return res;
  },
};
export type TempoWallet = typeof api;
(globalThis as any).tempoWallet = api;
