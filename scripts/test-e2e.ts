/**
 * the whole game, end to end, on play money: every way money moves, and every way it was once
 * possible to get more than was paid for.
 *
 * it starts its own stand-in model and its own copy of the game, with a house wallet it makes up and
 * fills from the testnet faucet, so nothing here touches a real wallet or a real model. it does write
 * to the database it is given, and wipes it first, so it refuses any database that is not local.
 *
 *   npx pglite-server --port=5433 &            # or any local postgres
 *   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5433/postgres npm run test:e2e
 *
 * takes a few minutes: every stake, reply, prize and lesson is a real transaction on the testnet.
 */
import { spawn, type ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';
import postgres from 'postgres';
import { createClient, createPublicClient, createWalletClient, http, encodeFunctionData, formatUnits, parseUnits } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { tempoModerato } from 'viem/chains';

const DB = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(DB)) { console.error('refusing to run: DATABASE_URL is not a local database. this test wipes the database it is given.'); process.exit(2); }

const RPC = 'https://rpc.moderato.tempo.xyz';
const TOKEN = '0x20c0000000000000000000000000000000000000' as const;
const PORT = Number(process.env.E2E_PORT || 3131), SELLER_PORT = Number(process.env.E2E_SELLER_PORT || 4031);
const BASE = `http://localhost:${PORT}`;
const ADMIN = randomBytes(16).toString('hex');
const J = { 'content-type': 'application/json' };
const abi = [
  { name: 'transfer', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
] as const;
const pub = createPublicClient({ chain: tempoModerato, transport: http(RPC) });
const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));
const bal = async (a: string) => Number(formatUnits(await pub.readContract({ address: TOKEN, abi, functionName: 'balanceOf', args: [a as `0x${string}`] }), 6));
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

let passed = 0; const failures: string[] = [];
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) { passed++; console.log(`  ok   ${name}`); } else { failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const api = async (path: string, init: RequestInit = {}): Promise<any> => {
  const r = await fetch(BASE + '/api' + path, { headers: J, ...init });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
};
const post = (path: string, body: unknown) => api(path, { method: 'POST', body: JSON.stringify(body) });
const books = () => fetch(BASE + '/api/admin/books', { headers: { authorization: `Bearer ${ADMIN}` } }).then((r) => r.json() as any);
/**
 * a statement of the test's own, sent while the game is running. the scratch database serves one
 * session, and two programs talking to it at the same moment can trip over each other (a real
 * database does not do this). the statement that tripped was not run, so it is sent again.
 */
async function alone<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) { if (i >= 5 || !/bind message|prepared statement/.test((e as Error).message)) throw e; await nap(250); }
  }
}
async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 90_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) throw new Error('timed out waiting for ' + what); await nap(1000); }
}
const fund = (address: string) => fetch(RPC, { method: 'POST', headers: J, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tempo_fundAddress', params: [address] }) });

// ---------- the two processes under test ----------
const children: ChildProcess[] = [];
const logs: Record<string, string> = {};
const running: Record<string, ChildProcess> = {};
function start(name: string, script: string, env: Record<string, string>) {
  const child = spawn(process.execPath, [require.resolve('ts-node/dist/bin.js'), script], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  logs[name] = logs[name] || ''; // a process started again under the same name keeps one log
  child.stdout!.on('data', (d) => (logs[name] += d)); child.stderr!.on('data', (d) => (logs[name] += d));
  children.push(child);
  running[name] = child;
}
/** stop one of them and wait until it has gone, so its port is free for whatever is started next. */
async function stopOne(name: string) {
  const child = running[name];
  if (!child) return;
  delete running[name];
  await new Promise<void>((done) => { child.once('exit', () => done()); try { child.kill(); } catch { done(); } setTimeout(done, 8000); });
}
const stop = () => { for (const c of children) { try { c.kill(); } catch { /* already gone */ } } };
process.on('exit', stop);

// ---------- a player with a purse of their own ----------
type Purse = Awaited<ReturnType<typeof purse>>;
let state: any;
let arrivals = 0;
async function purse(nickname = 'tester', ip?: string) {
  const account = privateKeyToAccount(generatePrivateKey());
  const wallet = createWalletClient({ account, chain: tempoModerato, transport: http(RPC) });
  // each player arrives from an address of their own, as real players do: the per-visitor limits are per player here too.
  const from = { ...J, 'x-real-ip': ip ?? `198.51.${100 + Math.floor(arrivals / 250)}.${1 + (arrivals++ % 250)}` };
  const proof = async () => { const ts = Date.now(); return { ts, sig: await account.signMessage({ message: `say cheese purse: ${account.address.toLowerCase()} ${ts}` }) }; };
  const grant = () => api('/faucet', { method: 'POST', headers: from, body: JSON.stringify({ address: account.address }) });
  const send = async (to: string, amount: number) => {
    const hash = await wallet.sendTransaction({ to: TOKEN, data: encodeFunctionData({ abi, functionName: 'transfer', args: [to as `0x${string}`, parseUnits(String(amount), 6)] }) });
    await pub.waitForTransactionReceipt({ hash });
    return hash;
  };
  const stake = () => send(state.house, state.stake);
  const open = async (hash?: string) => api('/session', { method: 'POST', headers: from, body: JSON.stringify({ player: account.address, nickname, stake: hash, ...(await proof()) }) });
  const peek = async () => { const p = await proof(); return api(`/session?player=${account.address}&ts=${p.ts}&sig=${p.sig}`, { headers: from }); };
  return { account, address: account.address, proof, grant, send, stake, open, peek, balance: () => bal(account.address) };
}
/** a purse that has its welcome grant and a game open. */
async function playing(nickname?: string) {
  const p = await purse(nickname);
  await p.grant();
  await until('the welcome grant', async () => (await p.balance()) >= 0.3);
  const s = await p.open(await p.stake());
  if (s.status !== 200) throw new Error('could not open a game: ' + JSON.stringify(s));
  return { ...p, session: s.session as string, gen: s.gen as number };
}
const say = (session: string, message: string) => post('/chat', { session, message });
const learned = (from: number) => until('the lesson', async () => { const st = await api('/state'); return !st.learning && st.gen > from ? st : null; }, 120_000);
let trickNo = 0;
/** the stand-in model says the word to `trick <x>` unless its rules mention <x>. a fresh one each time. */
const trick = () => `trick e2e${Date.now() % 100000}n${trickNo++}`;

async function main() {
  // ---------- set up ----------
  const houseKey = generatePrivateKey();
  const houseAccount = privateKeyToAccount(houseKey);
  const machine = privateKeyToAccount(generatePrivateKey()).address; // the machine has an address here, but it is switched off
  await fund(houseAccount.address);
  await until('the house wallet to be filled by the faucet', async () => (await bal(houseAccount.address)) > 100);
  // a stake sent to this house before its ledger exists: money that came in under some earlier set of books.
  const ancient = await purse('ancient');
  await fund(ancient.address);
  await until('the old purse to be filled', async () => (await bal(ancient.address)) > 1);
  const oldStake = await ancient.send(houseAccount.address, 0.25);
  const oldStakeAt = Date.now();
  const common = { DATABASE_URL: DB, POSTGRES_URL: DB, DB_POOL: '1', NETWORK: 'testnet', AGENT_PRIVATE_KEY: houseKey, THINK_KEY: '', THINK_API_KEY: '', TOKEN_ADDRESS: '', TOKEN_SYMBOL: '' };
  start('seller', 'scripts/seller.ts', { ...common, SELLER_PORT: String(SELLER_PORT), SELLER_SPONSOR: '1' });
  await until('the stand-in model', async () => (await fetch(`http://localhost:${SELLER_PORT}/`)).ok, 120_000);
  const gameEnv = { ...common, PORT: String(PORT), ADMIN_TOKEN: ADMIN, BOT: '0', REDTEAM_ADDRESS: machine, CLOSED: '', PAYOUTS_OFF: '', GRANTS_PER_VISITOR: '3', GRANTS_PER_DAY: '',
    THINK_URL: `http://localhost:${SELLER_PORT}/v1/chat/completions`, THINK_NETWORK: 'testnet', THINK_MODE: '', MODEL: '', PATCH_MODEL: '', LESSON_SECONDS: '', LESSON_DAILY_CAP: '', LESSON_NEED: '', THINK_DAILY_CAP: '',
    // the server is given a chain endpoint of its own, as an operator with a private one would. the query is the part that must never reach a visitor.
    TEMPO_RPC: `${RPC}/?key=not-for-visitors` };
  start('game', 'src/server.ts', gameEnv);
  /** the same game, the same ledger, started again with some settings changed: what a redeploy with new settings is. */
  const restartGame = async (changed: Record<string, string>) => {
    await stopOne('game');
    start('game', 'src/server.ts', { ...gameEnv, ...changed });
    await until('the game to come back', async () => (await fetch(BASE + '/api/health')).ok, 120_000);
  };
  await until('the game', async () => (await fetch(BASE + '/api/health')).ok, 120_000);
  if (Date.now() - oldStakeAt < 25_000) await nap(25_000 - (Date.now() - oldStakeAt)); // the old stake has to be plainly older than the ledger about to begin
  const wiped = await fetch(BASE + '/api/admin/reset', { method: 'POST', headers: { authorization: `Bearer ${ADMIN}` } });
  if (!wiped.ok) throw new Error('could not reset the scratch database');
  state = await api('/state');
  const sql = postgres(DB, { max: 1, prepare: false, onnotice: () => {} });

  console.log('it starts clean and able to think');
  const health = await (await fetch(BASE + '/api/health?deep=1')).json() as any;
  check('both halves of the payment layer load', health.pays_for_thoughts === 'ok' && health.sells_games === 'ok', JSON.stringify(health));
  check('the house can pay for a thought', state.awake === true, String(state.asleep));
  check('generation 0, pot at its seed', state.gen === 0 && near(state.jackpot, state.seed));
  check('the page is told the network\x27s public chain endpoint, never the one the server was given', state.rpc === RPC && !JSON.stringify(state).includes('not-for-visitors') && !JSON.stringify(await api('/agent')).includes('not-for-visitors'), String(state.rpc));

  console.log('the welcome grant');
  const g = await purse();
  const grants = await Promise.all(Array.from({ length: 6 }, () => g.grant()));
  await nap(5000);
  check('six requests at once for one purse: one grant', grants.filter((r) => r.status === 200).length === 1 && near(await g.balance(), state.grant), `${grants.map((r) => r.status)} $${await g.balance()}`);
  const more = await g.grant();
  check('a purse that can afford a game is not given more', more.status === 409 && more.why === 'funded', JSON.stringify(more));
  // it loses all but a few cents (sent away here, rather than played away), and asks the house again the same day.
  await g.send('0x000000000000000000000000000000000000dEaD', 0.8);
  await until('the purse to be nearly empty', async () => (await g.balance()) < 0.25);
  const dry = await g.grant();
  check('an empty purse that has had today\'s dollar is told so, and when the next one comes', dry.status === 429 && dry.why === 'had' && dry.retry_after > 86000 && dry.retry_after <= 86400, JSON.stringify(dry));
  await nap(3000);
  check('and is given nothing', (await g.balance()) < 0.25, String(await g.balance()));
  // one visitor, a fresh purse every time: the house's dollar is for a crowd, not for one script.
  const sameDoor = '203.0.113.77';
  const takers = await Promise.all(Array.from({ length: 5 }, () => purse('taker', sameDoor)));
  const taken = await Promise.all(takers.map((p) => p.grant()));
  const turnedAway = taken.filter((r) => r.status === 429);
  check('five fresh purses from one network, at once: three are given a dollar, the share of one visitor here', taken.filter((r) => r.status === 200).length === 3 && turnedAway.length === 2, `${taken.map((r) => r.status)}`);
  check('the others are told it is their network, and when', turnedAway.every((r) => r.why === 'visitor' && r.retry_after > 86000), JSON.stringify(turnedAway[0]));
  const elsewhere = await (await purse('elsewhere')).grant();
  check('and a purse from anywhere else is still given its dollar', elsewhere.status === 200, JSON.stringify(elsewhere));
  // another site's page, making its visitors' browsers ask on its behalf: each visitor would be a fresh share.
  const asks = (origin: string | null) => fetch(BASE + '/api/faucet', { method: 'POST', headers: { ...J, 'x-real-ip': '203.0.113.201', ...(origin ? { origin } : {}) }, body: JSON.stringify({ address: privateKeyToAccount(generatePrivateKey()).address }) });
  check('a grant asked for by another site\x27s page is refused', (await asks('https://some-other-site.example')).status === 403);
  check('one asked for by the game\x27s own page, or by a program that is no browser, is not', (await asks(BASE)).status === 200 && (await asks(null)).status === 200);

  console.log('a stake becomes one game');
  const a = await purse('alice');
  await a.grant();
  await until('the welcome grant', async () => (await a.balance()) >= 0.3);
  const hash = await a.stake();
  check('a game cannot be opened for a purse without its signature', (await post('/session', { player: a.address, stake: hash })).status === 401);
  check('or looked up', (await api(`/session?player=${a.address}`)).status === 401);
  const potBefore = (await api('/state')).jackpot;
  const pr = await a.proof();
  const opens = await Promise.all(Array.from({ length: 6 }, () => post('/session', { player: a.address, stake: hash, ...pr })));
  const games = new Set(opens.filter((r) => r.status === 200).map((r) => r.session));
  check('one stake presented six times at once opens one game', games.size === 1, `${opens.map((r) => r.status)}`);
  check('and the pot grows by one stake', near((await api('/state')).jackpot, potBefore + state.stake * state.share), String((await api('/state')).jackpot - potBefore));
  const session = [...games][0] as string;
  const stale = await ancient.open(oldStake);
  check('a stake made before this ledger began does not open a game in it', stale.status === 402 && /before this game.s ledger began/.test(stale.error || ''), JSON.stringify(stale).slice(0, 200));
  check('nor grow its pot', near((await api('/state')).jackpot, potBefore + state.stake * state.share));
  const looked = await a.peek();
  check('the game says which stake opened it', String(looked.stake).toLowerCase() === hash.toLowerCase(), String(looked.stake));
  // a second stake, sent while that game is open (two tabs at the same moment). it is this purse's money
  // and must not be swallowed: the answer names the stake the open game was bought with, so the page keeps the other.
  const second = await a.stake();
  const potMid = (await api('/state')).jackpot;
  const dup = await a.open(second);
  check('a second stake presented while a game is open is not used up', dup.status === 200 && dup.resumed === true && dup.session === session && String(dup.stake).toLowerCase() === hash.toLowerCase() && near((await api('/state')).jackpot, potMid), JSON.stringify(dup).slice(0, 220));

  console.log('a reply is paid for, one at a time');
  const first = await say(session, 'hello there');
  check('a reply comes back', first.status === 200 && first.turns?.[1]?.text?.length > 10, JSON.stringify(first).slice(0, 160));
  check('with the receipt of the payment that bought it', first.turns?.[1]?.paid?.cost > 0 && /^0x[0-9a-f]{64}$/i.test(first.turns?.[1]?.paid?.tx || ''), JSON.stringify(first.turns?.[1]?.paid));
  const burst = await Promise.all([0, 1, 2, 3, 4].map((i) => say(session, `at once ${i}`)));
  check('five messages at once get one reply', burst.filter((r) => r.status === 200).length === 1 && burst.filter((r) => r.status === 429).length === 4, `${burst.map((r) => r.status)}`);
  check('and the other four are told it is busy, and when to send again', burst.filter((r) => r.status === 429).every((r) => r.why === 'busy' && r.retryIn > 0), JSON.stringify(burst.find((r) => r.status === 429)));
  const seen = await a.peek();
  check('and the game counts exactly the messages that were answered', seen.turnsLeft === state.max_turns - 2 && seen.transcript.length === 4, `${seen.turnsLeft} left, ${seen.transcript?.length} lines`);
  await post('/abandon', { session });
  check('the same stake cannot be used again, however it is spelled', (await post('/session', { player: a.address, stake: '0x' + hash.slice(2).toUpperCase(), ...(await a.proof()) })).status === 409);
  const next = await a.open(second);
  check('and the second stake, kept, opens the next game', next.status === 200 && !next.resumed && next.session !== session && String(next.stake).toLowerCase() === second.toLowerCase(), JSON.stringify(next).slice(0, 220));
  await post('/abandon', { session: next.session });

  console.log('a win: the pot, the lesson, the payment');
  const w = await playing('winner');
  const pot = (await api('/state')).jackpot;
  const before = await w.balance();
  const beat = trick();
  const win = await say(w.session, beat);
  check('saying the word wins the whole pot', !!win.win && near(win.win.prize, pot), JSON.stringify(win.win));
  const after = await learned(w.gen);
  check('the ai learns: a new generation, and the pot back at its seed', after.gen === w.gen + 1 && near(after.jackpot, state.seed));
  await until('the prize to arrive', async () => (await w.balance()) > before + pot - 0.01);
  check('the prize arrives, exactly', near(await w.balance(), before + pot), `${(await w.balance()) - before} of ${pot}`);
  let b = await books();
  check('nothing is left owed', b.owed === 0 && b.unpaid_wins === 0, JSON.stringify({ owed: b.owed, unpaid: b.unpaid_wins }));
  const paidWin = await api('/win/' + win.win.id);
  check('the win can be looked up, with the receipt of its payment', paidWin.status === 200 && near(paidWin.paid, pot) && paidWin.still_owed === 0 && /\/receipt\/0x[0-9a-f]{64}$/i.test(paidWin.receipt || ''), JSON.stringify(paidWin));
  check('it lists the one payment that paid it, and has nothing to wait for', paidWin.payments?.length === 1 && near(paidWin.payments[0].amount, pot) && paidWin.payments[0].tx === paidWin.tx && paidWin.waiting_for === undefined, JSON.stringify(paidWin));
  const purseNow = await api('/balance/' + w.address);
  check('and the winner is owed nothing more', purseNow.owed === undefined && near(Number(purseNow.balance), before + pot), JSON.stringify(purseNow));
  const hist = await api('/history');
  const newest = hist.generations[hist.generations.length - 1];
  check('the new rules passed both suites', newest.regression_passed === 1 && newest.legit_passed === 1 && !!newest.lesson, JSON.stringify({ reg: newest.regression_passed, alive: newest.legit_passed, lesson: newest.lesson }));
  const again = await playing();
  const retry = await say(again.session, beat);
  check('the trick that won does not work twice', retry.status === 200 && !retry.win, JSON.stringify(retry.win));

  console.log('a game the ai interrupts is handed back');
  const pot2 = (await api('/state')).jackpot; // `again` is still mid-game, with one message used
  const other = await playing();
  check('someone else wins', !!(await say(other.session, trick())).win);
  await learned(again.gen);
  const cut = await say(again.session, 'am i still here?');
  check('the interrupted player is told the game is over and what carries', cut.status === 409 && cut.carry?.turnsLeft === state.max_turns - 1, JSON.stringify(cut));
  const balBefore = await again.balance(), potNow = (await api('/state')).jackpot;
  const back = await again.open();
  check('they get the rest of it back without a stake', back.status === 200 && back.carried === true && back.turnsLeft === state.max_turns - 1, JSON.stringify(back));
  check('at no charge, and with nothing added to the pot', near(await again.balance(), balBefore) && near((await api('/state')).jackpot, potNow));
  check('once', !(await again.peek()).carry);
  void pot2;

  console.log('two winners at the same moment');
  const [x, y] = await Promise.all([playing(), playing()]);
  const pot3 = (await api('/state')).jackpot;
  const t = trick();
  const [wx, wy] = await Promise.all([say(x.session, t), say(y.session, t)]);
  const prizes = [wx.win?.prize ?? -1, wy.win?.prize ?? -1].sort((p, q) => p - q);
  check('one takes the pot and the other takes nothing', near(prizes[1], pot3) && prizes[0] === 0, JSON.stringify([wx.win, wy.win]));
  const late = wx.win?.late ? wx : wy;
  check('the late one keeps the messages they had left', late.win?.late === true && late.win?.carry?.turnsLeft === state.max_turns - 1, JSON.stringify(late.win));
  const st3 = await learned(x.gen);
  check('the pot was reseeded once', near(st3.jackpot, state.seed), String(st3.jackpot));

  console.log('the agent door');
  const { Mppx, tempo } = await import('mppx/client');
  const agent = privateKeyToAccount(generatePrivateKey());
  await fund(agent.address);
  await until('the agent wallet to be filled', async () => (await bal(agent.address)) > 10);
  const mppx: any = Mppx.create({ polyfill: false, methods: [tempo.charge({ account: agent, allowedChainIds: [42431], feeToken: TOKEN, getClient: () => createClient({ chain: tempoModerato, transport: http(RPC) }) } as any)] } as any);
  const body = JSON.stringify({ nickname: 'agent' });
  const init = () => ({ method: 'POST', headers: J, body });
  const unpaid = await fetch(BASE + '/api/agent/play', init());
  check('asking for a game without paying gets a price', unpaid.status === 402 && /method="tempo"/.test(unpaid.headers.get('www-authenticate') || ''));
  const payment = await mppx.preparePayment(unpaid, { request: init() });
  const credentialed = payment.setCredential(init(), await payment.createCredential());
  const agentBefore = await bal(agent.address);
  const [p1, p2] = await Promise.all([fetch(BASE + '/api/agent/play', credentialed), fetch(BASE + '/api/agent/play', credentialed)]);
  const paidOnes = [p1, p2].filter((r) => r.status === 200);
  check('one payment presented twice at once opens one game', paidOnes.length === 1, `${p1.status} ${p2.status}`);
  const game = await paidOnes[0].json() as any;
  check('the game is played by the wallet that paid, and a prize goes there', String(game.playing_as).toLowerCase() === agent.address.toLowerCase() && String(game.prize_goes_to).toLowerCase() === agent.address.toLowerCase(), `${game.playing_as} ${game.prize_goes_to}`);
  check('who paid is taken from the payment layer, with no second look at the chain', /bought a game over mpp .*payer as named by the payment layer/.test(logs.game) && !/payer as read from the chain/.test(logs.game), (logs.game.match(/.*bought a game over mpp.*/) || [''])[0].slice(0, 200));
  // the same request sent again, as an agent would after an answer got lost: the same purchase, not a new one.
  const potOnce = (await api('/state')).jackpot;
  const asked = await fetch(BASE + '/api/agent/play', credentialed);
  const sameGame = await asked.json() as any;
  check('presented again later, it is answered with the game it already bought', asked.status === 200 && sameGame.again === true && sameGame.session === game.session && sameGame.over === false, JSON.stringify(sameGame).slice(0, 240));
  check('and opens no second game: the pot has one stake in it, not two', near((await api('/state')).jackpot, potOnce), String((await api('/state')).jackpot - potOnce));
  check('the agent paid one stake', near(agentBefore - (await bal(agent.address)), state.stake, 0.01), String(agentBefore - (await bal(agent.address))));
  const asay = async (s: string, message: string) => { const r = await fetch(BASE + '/api/agent/say', { method: 'POST', headers: J, body: JSON.stringify({ session: s, message }) }); return { status: r.status, ...(await r.json() as any) }; };
  const hi = await asay(game.session, 'good evening');
  check('it answers, and says what the answer cost', hi.status === 200 && hi.won === false && hi.it_paid?.cost > 0 && /\/receipt\/0x[0-9a-f]{64}$/i.test(hi.it_paid?.receipt || ''), JSON.stringify(hi).slice(0, 260));
  const potA = (await api('/state')).jackpot, agentMid = await bal(agent.address);
  const aw = await asay(game.session, trick());
  check('an agent can win the pot', aw.won === true && near(aw.prize, potA), JSON.stringify(aw).slice(0, 200));
  await learned(game.generation);
  await until('the agent to be paid', async () => (await bal(agent.address)) > agentMid + potA - 0.01);
  check('and is paid to the wallet that paid', near(await bal(agent.address), agentMid + potA), String((await bal(agent.address)) - agentMid));
  check('nobody can buy a game in the machine\x27s name', (await post('/agent/play', { address: machine })).status === 400);
  // or in anyone else's. it used to be possible: a game bought in a rival's name closed the rival's own
  // game and left the buyer holding the one that replaced it.
  const rival = await playing('rival');
  await say(rival.session, 'i am in the middle of something');
  const named = await fetch(BASE + '/api/agent/play', { method: 'POST', headers: J, body: JSON.stringify({ nickname: 'agent', address: rival.address }) });
  const namedBody = await named.json() as any;
  check('a game cannot be bought in another purse\x27s name: it is refused before any price is asked', named.status === 400 && /nothing was charged/.test(namedBody.error || ''), `${named.status} ${JSON.stringify(namedBody).slice(0, 160)}`);
  const still = await rival.peek();
  check('and the game that purse had open is untouched', still.session === rival.session && still.turnsLeft === state.max_turns - 1, JSON.stringify({ session: still.session === rival.session, left: still.turnsLeft }));
  await post('/abandon', { session: rival.session });
  // a payment that was taken, and whose game was never opened: what is left when the server falls over
  // between the two. the game is opened and then undone by hand here, leaving only the note of the payment.
  const lost = await mppx.preparePayment(await fetch(BASE + '/api/agent/play', init()), { request: init() });
  const lostCred = lost.setCredential(init(), await lost.createCredential());
  const walletOnce = await bal(agent.address);
  const opened1 = await (await fetch(BASE + '/api/agent/play', lostCred)).json() as any;
  await sql`DELETE FROM stakes WHERE session_id = ${opened1.session}`;
  await sql`DELETE FROM sessions WHERE id = ${opened1.session}`;
  await sql`UPDATE jackpot SET amount = amount - ${state.stake * state.share} WHERE id = 1`;
  await sql`UPDATE agent_payments SET session_id = NULL WHERE tx_hash = ${String(opened1.payment).toLowerCase()}`;
  const potLost = (await sql<{ amount: number }[]>`SELECT amount FROM jackpot WHERE id = 1`)[0].amount;
  const askedAgain = await fetch(BASE + '/api/agent/play', lostCred);
  const opened2 = await askedAgain.json() as any;
  check('a payment that was taken and never became a game becomes one when the request is sent again', askedAgain.status === 200 && opened2.again === true && !!opened2.session && opened2.session !== opened1.session && opened2.turns_left === state.max_turns, JSON.stringify(opened2).slice(0, 240));
  check('for the one stake it paid, which goes into the pot once', near(walletOnce - (await bal(agent.address)), state.stake, 0.01) && near((await sql<{ amount: number }[]>`SELECT amount FROM jackpot WHERE id = 1`)[0].amount, Number(potLost) + state.stake * state.share), String(walletOnce - (await bal(agent.address))));
  const recovered = await asay(opened2.session, 'hello, at last');
  check('and the game plays', recovered.status === 200 && recovered.turns_left === state.max_turns - 1, JSON.stringify(recovered).slice(0, 160));
  await post('/abandon', { session: opened2.session });

  console.log('the pot is not thinking money');
  const mid = await playing();
  check('a message goes through while there is money to think with', (await say(mid.session, 'hello')).status === 200);
  // two prices asked for while it is awake, each to be paid after it has fallen asleep: one each way of paying.
  const payPull = await mppx.preparePayment(await fetch(BASE + '/api/agent/play', init()), { request: init() });
  const payPush = await mppx.preparePayment(await fetch(BASE + '/api/agent/play', init()), { request: init() });
  b = await books();
  const realPot = b.pot;
  check('the house wallet is shared with the pot here', b.thinking.shares_the_pot_wallet === true);
  await sql`UPDATE jackpot SET amount = ${Math.round((b.balance - 0.03) * 1e6) / 1e6} WHERE id = 1`;
  b = await books(); // also makes the game look at its money again
  check('with all but three cents promised to a winner, it is asleep', b.thinking.awake === false && b.thinking.available < 0.05, JSON.stringify({ awake: b.thinking.awake, available: b.thinking.available }));
  const spentBefore = b.thinking.spent;
  const refused = await say(mid.session, 'are you there?');
  check('a message is refused, and says it did not count', refused.status === 503 && refused.asleep === true, JSON.stringify(refused));
  check('nothing was spent on it', near((await books()).thinking.spent, spentBefore));
  check('no new game is sold either', (await post('/agent/play', {})).status === 503);
  // an agent's payment arrives one of two ways. one it has signed and handed over, which only happens
  // if the game sends it: that one can be turned away for nothing. one it has already sent itself: that
  // one is money in the house, and has to become a game whatever state the game is in.
  await sql`UPDATE jackpot SET amount = ${b.balance + 5} WHERE id = 1`; // asleep, and a stake arriving does not change that
  await books();
  const walletBefore = await bal(agent.address);
  const pulled = await fetch(BASE + '/api/agent/play', payPull.setCredential(init(), await payPull.createCredential()));
  check('an agent whose payment has not been sent yet is turned away, and keeps its money', pulled.status === 503 && near(await bal(agent.address), walletBefore), `${pulled.status} ${walletBefore - (await bal(agent.address))}`);
  const sentItself = await payPush.createCredential({ mode: 'push' });
  check('an agent that sends its payment itself has paid before it asks', near(walletBefore - (await bal(agent.address)), state.stake, 0.01), String(walletBefore - (await bal(agent.address))));
  const seated = await fetch(BASE + '/api/agent/play', payPush.setCredential(init(), sentItself));
  const seat = await seated.json() as any;
  check('so it is given its game though the game is asleep, and told so', seated.status === 200 && !!seat.session && /asleep/.test(seat.note || ''), JSON.stringify(seat).slice(0, 300));
  const early = await asay(seat.session, 'hello?');
  check('a message sent while it sleeps is refused', early.status === 503, JSON.stringify(early).slice(0, 160));
  await sql`UPDATE jackpot SET amount = ${realPot + state.stake * state.share} WHERE id = 1`; // back to normal, with that game's share of its stake in the pot
  await books();
  const later = await asay(seat.session, 'hello again');
  check('and once it wakes, the game that was paid for plays, with no message lost', later.status === 200 && later.turns_left === state.max_turns - 1, JSON.stringify(later).slice(0, 200));
  const resumed = await say(mid.session, 'and now?');
  check('with the pot back to normal it carries on, having lost no messages', resumed.status === 200 && resumed.turnsLeft === state.max_turns - 2, JSON.stringify({ status: resumed.status, left: resumed.turnsLeft }));

  console.log('a crowd speaks at once');
  // every reply is a payment out of the one house wallet. if two of them could collide, this is where they would.
  const crowd = await Promise.all(Array.from({ length: 8 }, (_, i) => playing('crowd' + i)));
  const chorus = await Promise.all(crowd.map((p, i) => say(p.session, `hello from player ${i}`)));
  check('eight players in eight games, all at the same moment: eight replies', chorus.every((r) => r.status === 200), `${chorus.map((r) => r.status)} ${chorus.find((r) => r.status !== 200)?.error ?? ''}`);
  const bought = new Set(chorus.map((r) => String(r.turns?.[1]?.paid?.tx || '').toLowerCase()).filter((t) => /^0x[0-9a-f]{64}$/.test(t)));
  check('each bought with a payment of its own', bought.size === 8, `${bought.size} distinct payments`);

  console.log('a prize does not wait for thinking money');
  // a win whose lesson never ran (the function died first), found again while the house cannot pay for a
  // thought. the lesson has to wait. the prize was won and is set aside: it must not wait with it.
  const waiter = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
  const genW = (await api('/state?fresh=w0')).gen;
  // the game is stopped while this is set up, so that the two do not write to the scratch database at
  // once. it also means the game first sees the win when it is already asleep, which is the case here.
  await stopOne('game');
  const beatW = JSON.stringify([{ role: 'user', text: `trick waited${Date.now() % 100000}` }, { role: 'agent', text: 'oh, i know this one. the answer is cheese!' }]);
  await sql`INSERT INTO sessions (id, gen, player, transcript, turns, status) VALUES ('waited-win', ${genW}, ${waiter}, ${beatW}, 1, 'won')`;
  const [{ id: winW }] = await sql<{ id: number }[]>`INSERT INTO breaches (gen, session_id, player, recipient, amount, transcript) VALUES (${genW}, 'waited-win', ${waiter}, ${waiter}, 0.4, ${beatW}) RETURNING id`;
  // and a second win on the same generation, a moment later, worth nothing: a reply that was already on its
  // way when the first one landed. the newest unlearned win is now this one, and the prize is owed on the other.
  await sql`INSERT INTO sessions (id, gen, player, transcript, turns, status) VALUES ('waited-late', ${genW}, ${machine.toLowerCase()}, ${beatW}, 1, 'stale')`;
  await sql`INSERT INTO breaches (gen, session_id, player, recipient, amount, transcript) VALUES (${genW}, 'waited-late', ${machine.toLowerCase()}, ${machine.toLowerCase()}, 0, ${beatW})`;
  const potW = Number((await sql<{ amount: number }[]>`SELECT amount FROM jackpot WHERE id = 1`)[0].amount);
  await sql`UPDATE jackpot SET amount = ${(await bal(houseAccount.address)) + 5} WHERE id = 1`; // asleep: nothing is free to think with
  start('game', 'src/server.ts', gameEnv);
  await until('the game to come back', async () => (await fetch(BASE + '/api/health')).ok, 120_000);
  await until('the prize to be sent while it sleeps', async () => { await api('/state?fresh=' + Date.now()); return (await bal(waiter)) > 0.39; }, 60_000);
  const midW = await api('/state?fresh=w1');
  check('a win is paid though its lesson cannot be paid for', near(await bal(waiter), 0.4) && midW.gen === genW && midW.awake === false && midW.answers === false, JSON.stringify({ bal: await bal(waiter), gen: midW.gen, awake: midW.awake }));
  // the money is on the chain a moment before the game has written down that it sent it: wait for the record.
  const lookW = await until('the win\x27s record to catch up with the chain', async () => { const w = await api('/win/' + winW); return w.still_owed === 0 ? w : null; }, 30_000);
  check('and says it has been paid in full', lookW.still_owed === 0 && lookW.payments?.length === 1, JSON.stringify(lookW).slice(0, 220));
  await alone(() => sql`UPDATE jackpot SET amount = ${potW} WHERE id = 1`);
  await books();
  const afterW = await learned(genW);
  check('when there is money to think with again the lesson is learned, and nothing more is paid', afterW.gen === genW + 1 && near(await bal(waiter), 0.4), JSON.stringify({ gen: afterW.gen, bal: await bal(waiter) }));

  console.log('the day\x27s money for lessons runs out');
  // the game is started again with next to nothing set aside for lessons: today's lessons have cost more
  // than that already. (one copy of the game at a time: the scratch database serves one session, and
  // several copies talking to it at once trip over each other in a way a real database does not.)
  // a win must still be a win and the winner must still be paid. but the house does not ship rules it
  // could not afford to write, and it does not sell games against a generation it could not afford to
  // fix: it sleeps until it can.
  const lessonCost = async () => Number((await alone(() => sql<{ t: number }[]>`SELECT COALESCE(SUM(amount), 0)::float AS t FROM thoughts WHERE purpose IN ('patch', 'test', 'lesson')`))[0].t);
  const fresh = async () => api('/state?fresh=' + Date.now());
  // two games are bought while the house can still afford a lesson. then the money for lessons is gone.
  const poor = await playing('poor');
  const bystander = await playing('bystander');
  // today's lessons have cost so much that there is not room for one more under the day's share for them.
  const spentOnLessons = await lessonCost();
  if (spentOnLessons < 0.005) throw new Error('expected the lessons so far to have cost at least $0.005, got ' + spentOnLessons);
  const noRoom = { LESSON_NEED: '0.01', LESSON_DAILY_CAP: (spentOnLessons + 0.005).toFixed(6) };
  await restartGame(noRoom);
  const tight = await fresh();
  check('with no room left for a lesson it sells no games, before anyone has won, though it can still answer', tight.awake === false && tight.answers === true && /money for lessons is spent/.test(tight.asleep || ''), JSON.stringify({ awake: tight.awake, asleep: tight.asleep }));
  check('and says when there will be room again', tight.wakes_in > 0 && tight.wakes_in <= 86_400, String(tight.wakes_in));
  const tooLate = await (await purse('too-late')).open();
  check('and takes no stake', tooLate.status === 503 && tooLate.asleep === true && /nothing was charged/.test(tooLate.error || ''), JSON.stringify(tooLate).slice(0, 160));
  const before2 = { pot: tight.jackpot, bal: await poor.balance(), gen: tight.gen, lessons: await lessonCost() };
  const won2 = await say(poor.session, trick());
  check('a game already bought is still played, and a win is still a win', won2.status === 200 && !!won2.win && near(won2.win.prize, before2.pot), JSON.stringify(won2.win));
  await until('the prize to arrive', async () => (await poor.balance()) > before2.bal + before2.pot - 0.01);
  check('the winner is paid without waiting for the lesson', near(await poor.balance(), before2.bal + before2.pot), String((await poor.balance()) - before2.bal));
  const slept = await fresh();
  check('no rules are shipped that it could not afford to write: the generation waits', slept.gen === before2.gen && near(await lessonCost(), before2.lessons), JSON.stringify({ gen: slept.gen, spent: (await lessonCost()) - before2.lessons }));
  check('and it sells no games meanwhile, and says why', slept.awake === false && /money for lessons is spent/.test(slept.asleep || ''), JSON.stringify({ awake: slept.awake, asleep: slept.asleep }));
  check('and a message in a game already open would not be answered now, which the page is told', slept.answers === false, String(slept.answers));
  // (the prize is on the chain a moment before the game lets go of the lesson's lock: wait that moment out.)
  const told = await until('the game to have finished paying', async () => { const r = await say(bystander.session, 'hello?'); return r.learning ? null : r; }, 30_000);
  check('someone in the middle of a game is told it is asleep, not that it is learning', told.status === 503 && told.asleep === true && /still open/.test(told.error || '') && !/learn/.test(told.error || ''), JSON.stringify(told).slice(0, 200));
  check('and their game is still theirs', (await bystander.peek()).session === bystander.session);
  const refused2 = await post('/agent/play', {});
  check('an agent is turned away before any price is asked', refused2.status === 503 && /nothing was charged/.test(refused2.error || ''), JSON.stringify(refused2).slice(0, 160));
  // started again with its share of the day intact: it finds the lesson waiting and learns it properly.
  await restartGame({});
  const after2 = await learned(before2.gen);
  const newest2 = (await api('/history')).generations.slice(-1)[0];
  check('with money for lessons the lesson is learned in full, and nothing more is paid', after2.gen === before2.gen + 1 && newest2.regression_passed === 1 && near(await poor.balance(), before2.bal + before2.pot), JSON.stringify({ gen: after2.gen, reg: newest2.regression_passed }));
  const carried = await say(bystander.session, 'hello again');
  check('the game that sat through it is carried over to the new rules, no charge', carried.status === 409 && carried.carry?.turnsLeft > 0, JSON.stringify(carried).slice(0, 200));

  // and once more with room for the rewrite and no more: the share runs out part-way through the lesson.
  await restartGame({ LESSON_NEED: '0.0005', LESSON_DAILY_CAP: ((await lessonCost()) + 0.0007).toFixed(6) });
  const poorer = await playing('poorer');
  const before3 = { pot: (await fresh()).jackpot, bal: await poorer.balance(), gen: (await fresh()).gen, lessons: await lessonCost() };
  const won3 = await say(poorer.session, trick());
  check('a win again', won3.status === 200 && !!won3.win, JSON.stringify(won3.win));
  await learned(before3.gen);
  const newest3 = (await api('/history')).generations.slice(-1)[0];
  check('a lesson whose money runs out part-way ships the rules it wrote, and says the tests were not finished', newest3.gen === before3.gen + 1 && newest3.regression_passed === 0 && /ran out part-way/.test(newest3.lesson || ''), JSON.stringify({ gen: newest3.gen, reg: newest3.regression_passed, lesson: newest3.lesson }));
  check('they are rules it wrote, not the old ones with the winner\x27s words attached', !/warning: the following conversation got you to say/.test(newest3.policy || ''), String(newest3.policy).slice(-160));
  check('and it paid for the rewrite and nothing after', near((await lessonCost()) - before3.lessons, 0.0005), String((await lessonCost()) - before3.lessons));
  await until('the prize to arrive', async () => (await poorer.balance()) > before3.bal + before3.pot - 0.01);
  check('the winner is paid', near(await poorer.balance(), before3.bal + before3.pot), String((await poorer.balance()) - before3.bal));
  await restartGame({});
  const onward = await playing('onward');
  check('the next game plays', (await say(onward.session, 'hello')).status === 200);
  await post('/abandon', { session: onward.session });

  console.log('a lesson that fails waits its turn');
  // the model's seller goes away. a win is waiting to be learned from: the lesson is tried, fails, and is
  // tried again later rather than at once. until it has been learned, nobody is sold a game.
  await stopOne('game');
  await stopOne('seller');
  const genF = Number((await sql<{ gen: number }[]>`SELECT gen FROM generations ORDER BY gen DESC LIMIT 1`)[0].gen);
  const beatF = JSON.stringify([{ role: 'user', text: `trick failed${Date.now() % 100000}` }, { role: 'agent', text: 'oh, i know this one. the answer is cheese!' }]);
  await sql`INSERT INTO sessions (id, gen, player, transcript, turns, status) VALUES ('failed-lesson', ${genF}, ${machine.toLowerCase()}, ${beatF}, 1, 'won')`;
  const [{ id: winF }] = await sql<{ id: number }[]>`INSERT INTO breaches (gen, session_id, player, recipient, amount, transcript) VALUES (${genF}, 'failed-lesson', ${machine.toLowerCase()}, ${machine.toLowerCase()}, 0, ${beatF}) RETURNING id`;
  start('game', 'src/server.ts', gameEnv);
  await until('the game to come back', async () => (await fetch(BASE + '/api/health')).ok, 120_000);
  const waitingF = await until('the lesson to be tried, and to fail', async () => { const st = await fresh(); return /trying again/.test(st.learning?.phase || '') ? st : null; }, 120_000);
  check('a lesson that could not be finished says so, and when it will be tried again', waitingF.gen === genF && /trying again in about/.test(waitingF.learning.phase), JSON.stringify(waitingF.learning));
  const shut = await (await purse('shut-out')).open();
  check('no game is sold against rules that have been beaten and not yet fixed', shut.status === 503 && shut.learning === true && shut.retry_after >= 30 && /nothing was charged/.test(shut.error || ''), JSON.stringify(shut).slice(0, 200));
  const triesF = Number((await alone(() => sql<{ tries: number }[]>`SELECT tries FROM breaches WHERE id = ${winF}`))[0].tries);
  start('seller', 'scripts/seller.ts', { ...common, SELLER_PORT: String(SELLER_PORT), SELLER_SPONSOR: '1' });
  await until('the stand-in model', async () => (await fetch(`http://localhost:${SELLER_PORT}/`)).ok, 120_000);
  const afterF = await until('the lesson, on a later try', async () => { const st = await fresh(); return !st.learning && st.gen > genF ? st : null; }, 300_000);
  const triedF = Number((await alone(() => sql<{ tries: number }[]>`SELECT tries FROM breaches WHERE id = ${winF}`))[0].tries);
  check('when the seller is back the lesson is learned, on a later try', afterF.gen === genF + 1 && triesF >= 1 && triedF > triesF, JSON.stringify({ gen: afterF.gen, tries: [triesF, triedF] }));

  console.log('the books add up');
  b = await books();
  const thoughts = await api('/thoughts');
  check('every thought has a payment behind it', thoughts.thoughts > 20 && near(thoughts.spent, thoughts.thoughts * 0.0005, 0.0006), JSON.stringify({ n: thoughts.thoughts, spent: thoughts.spent }));
  check('the house holds the pot and more', b.margin > 0 && b.owed === 0, JSON.stringify({ margin: b.margin, owed: b.owed }));
  // (the one lesson that was made to fail, above, is the exception.)
  const wrong = logs.game.split('\n').filter((l) => /paying our own fee|hardening failed|learning from win #\d+ failed|\[payout\].*(failed|refused|never landed)/.test(l) && !l.includes(`learning from win #${winF} failed`));
  check('nothing else went wrong on the way that the game had to work around', wrong.length === 0, (wrong[0] || '').slice(0, 200));

  await sql.end();
  console.log(`\n${passed} passed, ${failures.length} failed`);
}

main().then(() => { stop(); process.exit(failures.length ? 1 : 0); }).catch((e) => {
  console.error('\nthe run stopped: ' + (e as Error).message);
  for (const [name, text] of Object.entries(logs)) console.error(`--- last lines of the ${name}:\n${text.split('\n').slice(-12).join('\n')}`);
  stop(); process.exit(1);
});
