// tempo wallet, for the page.
//
// the page keeps its money in a purse of its own (a key in this browser). on real money that purse
// has to be filled from somewhere, and tempo's wallet is where a person can turn a card or a bank
// transfer into dollars on tempo. this file is the whole of the page's dealings with it: connect,
// open the wallet's own "add funds", and send an amount to the purse.
//
// it is tempo's accounts sdk (npm `accounts`), bundled into one file so the page can load it from
// its own origin: the page's content security policy runs scripts from nowhere else. the page never
// sees a key or a passkey: every one of these opens the wallet's own window, and the person approves
// there. built with `npm run build` in this folder; the result is public/vendor/tempo-wallet.js.
import { Provider, tempoWallet } from 'accounts';

type Where = { testnet: boolean; chainId: number };
const hex = (n: number) => `0x${n.toString(16)}` as `0x${string}`;

let made: { testnet: boolean; provider: ReturnType<typeof Provider.create> } | null = null;
function provider(testnet: boolean) {
  // mpp: false. the sdk can also pay http 402 charges by replacing the page's fetch; the page does not ask it to.
  if (!made || made.testnet !== testnet) made = { testnet, provider: Provider.create({ adapter: tempoWallet(), testnet, mpp: false }) };
  return made.provider;
}

const api = {
  /** open the wallet and ask which account to use. resolves with its address. */
  async connect(o: Where): Promise<string> {
    const r: any = await provider(o.testnet).request({ method: 'wallet_connect' } as any);
    const first = r?.accounts?.[0];
    const address = typeof first === 'string' ? first : first?.address;
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(address))) throw new Error('the wallet did not name an account');
    return address;
  },
  /**
   * the wallet's own "add funds": a card or a bank on real money, the faucet on the testnet.
   * resolving means the wallet's window is done, not that the money has arrived: look at the balance.
   */
  async deposit(o: Where & { address: string; token: string; amount?: string }): Promise<void> {
    await provider(o.testnet).request({ method: 'wallet_deposit', params: [{
      address: o.address, chainId: hex(o.chainId), token: o.token,
      ...(o.amount ? { amount: o.amount } : {}), ...(o.testnet ? { intent: 'faucet' } : {}),
    }] } as any);
  },
  /** send `amount` (a plain number of dollars, as text) of `token` from the connected account to `to`. the wallet asks the person. resolves with the transaction's hash. */
  async send(o: Where & { token: string; to: string; amount: string }): Promise<string> {
    const r: any = await provider(o.testnet).request({ method: 'wallet_transfer', params: [{ amount: o.amount, to: o.to, token: o.token, chainId: hex(o.chainId) }] } as any);
    const hash = r?.receipt?.transactionHash;
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(hash))) throw new Error('the wallet did not report a transaction');
    return hash;
  },
};
export type TempoWallet = typeof api;
(globalThis as any).tempoWallet = api;
