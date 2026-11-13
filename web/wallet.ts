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
import { parseUnits, formatUnits, toFunctionSelector } from 'viem';
import { Actions } from 'viem/tempo';

/**
 * `test`: a throwaway key kept in this browser stands in for the wallet. play money only; the page refuses it on real money.
 * `allow`: at sign-in, the person is asked once to let this site spend up to `total` dollars of `token`
 * in all, paid only to `to`, within a week. it is a cap for the life of the permission, not a rate:
 * once it is used up or the week is over, nothing more can be taken without asking again. until then
 * a round of messages is paid without opening the wallet.
 */
type Allow = { token: string; to: string; total: string };
type Where = { testnet: boolean; chainId: number; test?: boolean; allow?: Allow };
const WEEK = 7 * 86_400;
const TRANSFER = toFunctionSelector('transfer(address,uint256)');
const TRANSFER_WITH_MEMO = toFunctionSelector('transferWithMemo(address,uint256,bytes32)');
/** a payment's network fee comes out of the allowance too. a cent is more than it has been. */
const FEE_ROOM = parseUnits('0.01', 6);
/** what the wallet is asked to allow, made when it is asked: the week starts then. */
const terms = (a: Allow) => ({
  // no `period`: the limit is for the key's whole life, not a daily amount that comes back.
  expiry: Math.floor(Date.now() / 1000) + WEEK,
  limits: [{ token: a.token as `0x${string}`, limit: parseUnits(a.total, 6) }],
  // a payment for a round is a token transfer to the game, with or without a memo. nothing else may be signed with this key.
  scopes: [TRANSFER, TRANSFER_WITH_MEMO].map((selector) => ({ address: a.token as `0x${string}`, selector, recipients: [a.to as `0x${string}`] })),
});
/** the wallet must be asked again before anything more is paid: the allowance is used up, ended or missing. */
const askAgain = (why: string) => Object.assign(new Error(why), { renew: true });
const hex = (n: number) => `0x${n.toString(16)}` as `0x${string}`;
const isAddress = (a: unknown): a is `0x${string}` => /^0x[0-9a-fA-F]{40}$/.test(String(a));

let made: { key: string; provider: ReturnType<typeof Provider.create> } | null = null;
function provider(o: Where) {
  // the test key is given the same allowance, so that the allowance itself can be tried on play money.
  const a = o.allow;
  const key = `${o.testnet}:${!!o.test}:${a ? `${a.token}:${a.to}:${a.total}` : ''}`;
  if (!made || made.key !== key) made = { key, provider: Provider.create({
    // the wallet opens as its own window, on its own site. a passkey is then used exactly as it is on
    // wallet.tempo.xyz itself. inside this page (the sdk's other way) the wallet's server refused it.
    adapter: o.test ? secp256k1() : tempoWallet({ mount: Mount.popup() }),
    testnet: o.testnet,
    // the sdk can replace the page's fetch so that any 402 is paid without asking. it is not asked to:
    // a payment is made only where the page asks for one (see `pay`).
    mpp: false,
    ...(a ? { accessKey: { authorize: () => terms(a) } } : {}),
  }) };
  return made.provider;
}
const same = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase();
/** the allowances for this game that this browser holds, in date or not. */
function ourKeys(o: Where, account: string): any[] {
  const a = o.allow;
  if (!a) return [];
  const keys: any[] = (provider(o) as any).store?.accessKeys?.list?.({ account, chainId: o.chainId }) ?? [];
  return keys.filter((k) => (k.scopes ?? []).some((s: any) => same(s.address, a.token) && (s.recipients ?? []).some((r: any) => same(r, a.to)))
    && (k.limits ?? []).some((l: any) => same(l.token, a.token)));
}
/** the allowance this page asked for, if this browser holds one that is still in date. */
const heldKey = (o: Where, account: string): any | null => ourKeys(o, account).find((k) => !k.expiry || k.expiry * 1000 > Date.now()) ?? null;
/** what is left of an allowance, as the chain counts it. a key not used yet has all of it. null: could not be read just now. */
async function leftOf(o: Where, account: string, k: any): Promise<{ left: bigint; total: bigint } | null> {
  const total: bigint = k.limits.find((l: any) => same(l.token, o.allow!.token)).limit;
  try {
    const p: any = provider(o);
    if ((await p.getAccessKeyStatus({ address: account, accessKey: k.address, chainId: o.chainId })) !== 'published') return { left: total, total };
    const { remaining } = await Actions.accessKey.getRemainingLimit(p.getClient({ chainId: o.chainId }), { account: account as `0x${string}`, accessKey: k.address, token: o.allow!.token as `0x${string}` });
    return { left: remaining, total };
  } catch { return null; }
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
  /**
   * what is left of the allowance, in dollars, and when it ends. null: there is none, and the next
   * payment will ask the wallet. a key that has not been used yet has all of it left.
   */
  async allowance(o: Where, account: string): Promise<{ left: number; total: number; until: number } | null> {
    const k = heldKey(o, account);
    if (!k) return null;
    const n = await leftOf(o, account, k);
    if (!n) throw new Error('the allowance could not be read just now');
    return { left: Number(formatUnits(n.left, 6)), total: Number(formatUnits(n.total, 6)), until: Number(k.expiry || 0) };
  },
  /**
   * ask the wallet for a new allowance, the same as the one given at sign-in: the old one is used up,
   * over, or was ended. the wallet opens, so this is called straight after a tap. the old one is
   * forgotten here first, or it would still be picked to pay with.
   */
  async renew(o: Where, account: string): Promise<void> {
    if (!o.allow) return;
    const p: any = provider(o);
    for (const k of ourKeys(o, account)) p.store.accessKeys.remove({ accessKey: k.address, account: k.access ?? account, chainId: o.chainId });
    await p.request({ method: 'wallet_authorizeAccessKey', params: [terms(o.allow)] });
  },
  /** end the allowance now. the wallet asks the person to confirm. afterwards nothing can be taken without asking. */
  async stop(o: Where, account: string): Promise<void> {
    const k = heldKey(o, account);
    if (!k) return;
    await provider(o).request({ method: 'wallet_revokeAccessKey', params: [{ address: account, accessKeyAddress: k.address, chainId: hex(o.chainId) }] } as any);
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
  async pay(o: Where & { account: string; token: string; most: string; kept?: string | null; keep?: (proof: string | null) => void }, url: string, init: RequestInit = {}): Promise<Response> {
    const withProof = (proof: string): RequestInit => ({ ...init, headers: { ...(init.headers as Record<string, string>), authorization: proof } });
    if (o.kept) {
      const again = await fetch(url, withProof(o.kept));
      // anything but "that proof is no good" is the answer to the payment already made.
      if (again.status !== 402 && again.status !== 409) { if (again.ok) o.keep?.(null); return again; }
      o.keep?.(null);
    }
    const unpaid = await fetch(url, init);
    if (unpaid.status !== 402) return unpaid;
    // paid from the allowance, never by opening the wallet here: by now the tap that could open it
    // has passed. with none, or not enough left for the price and its fee, the page asks for a new one.
    if (o.allow) {
      const k = heldKey(o, o.account);
      if (!k) throw askAgain('there is no allowance to pay from');
      const n = await leftOf(o, o.account, k);
      if (n && n.left < parseUnits(o.most, 6) + FEE_ROOM) throw askAgain('the allowance is used up');
    }
    const client: any = Mppx.create({ polyfill: false, methods: [tempo.charge({
      ...(provider(o).getMppxParameters() as any),
      // the wallet sends its own payment and pays its own fee, in the same dollars.
      mode: 'push', allowedChainIds: [o.chainId], currencies: [o.token], feeToken: o.token, decimals: 6, maxAmount: o.most,
    } as any)] } as any);
    const payment = await client.preparePayment(unpaid, { request: init });
    let credential;
    try { credential = await payment.createCredential({ mode: 'push' }); }
    catch (e) {
      // the chain refused the allowance (spent, ended): nothing was paid. the page asks for a new one.
      if (o.allow && /SpendingLimit|KeyExpired|KeyNotFound|KeyAlreadyRevoked/.test(String((e as any)?.message ?? e))) throw askAgain('the allowance is used up');
      throw e;
    }
    const paid: RequestInit = payment.setCredential(init, credential);
    const proof = new Headers(paid.headers as HeadersInit).get('authorization');
    if (proof) o.keep?.(proof);
    const res = await fetch(url, paid);
    if (res.ok) o.keep?.(null);
    return res;
  },
};
export type TempoWallet = typeof api;
(globalThis as any).tempoWallet = api;
