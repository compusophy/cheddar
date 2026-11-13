// the simple page. sign in with tempo wallet, pay for a game from it, talk, win.
// no purse, no key, no address: the wallet is the account, and a prize is paid straight back to it.
const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const money = (n) => (n > 0 && n < 1 ? `${Math.round(n * 100)}¢` : Number.isInteger(Number(n)) ? `$${Number(n)}` : `$${Number(n).toFixed(2)}`);
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private window: it works until the tab closes */ } },
};
const get = (path) => fetch(path).then((r) => r.json());
const post = async (path, body) => {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

let state = null;
let me = store.get('me');
let game = null; // { id, left }
/** the allowance as last read: undefined, not known yet; null, there is none; else what is left of it. */
let allow;
let working = false;
/** ?test: a throwaway key stands in for the wallet. play money only. */
const wantsTest = new URLSearchParams(location.search).has('test');
/**
 * the most this site may ever take from the wallet without asking again: $5 in all (20 rounds of
 * messages), paid only to the game, for a week at most. when it is used up the wallet asks again.
 */
const ALLOWANCE = '5';
const where = () => ({ testnet: !state.real, chainId: state.chain, test: wantsTest && !state.real, allow: { token: state.token, to: state.house, total: ALLOWANCE } });

let lib = null;
let libReady = false;
const wallet = () => (lib ||= new Promise((ok, no) => {
  const s = document.createElement('script');
  s.src = '/vendor/tempo-wallet.js';
  s.onload = () => (window.tempoWallet ? (libReady = true, ok(window.tempoWallet)) : no(new Error('the wallet did not load')));
  s.onerror = () => { lib = null; no(new Error('the wallet did not load — check your connection')); };
  document.head.appendChild(s);
}));

/**
 * the wallet, for something that opens its window. a browser lets a page open a window only straight
 * after a tap. if the wallet's code was still loading when the tap came, that tap is used up by the
 * wait: the window is not tried late (a phone would block it), and the next tap opens it at once.
 */
async function walletNow() {
  if (libReady) return wallet();
  const began = Date.now();
  say('one moment…');
  const w = await wallet();
  if (Date.now() - began > 400) throw Object.assign(new Error('ready now — tap again'), { keep: true });
  return w;
}
const say = (text) => { $('#said').textContent = text || ''; };
function bubble(kind, text) {
  // once there is a conversation, the big words step back to make room for it.
  document.body.classList.add('talking');
  const p = document.createElement('p');
  p.className = kind; p.textContent = text;
  $('#thread').appendChild(p);
  p.scrollIntoView({ block: 'nearest' });
  return p;
}
function busy(on) { working = on; $('#send').disabled = on; $('#msg').disabled = on; if (!on) $('#msg').focus(); }
const holds = async () => (me ? Number((await get('/api/balance/' + me)).balance) || 0 : 0);
/** one line: how much of the allowance is left, and a way to end it. */
async function paintAllow() {
  const a = allow = me && lib ? await (await wallet()).allowance(where(), me).catch(() => undefined) : undefined;
  const spent = a && a.left < state.stake + 0.01;
  $('#allow').classList.toggle('hidden', !a);
  $('#stopper').classList.toggle('hidden', !!spent);
  if (a) $('#allowtext').textContent = spent ? `your ${money(a.total)} is used up — your wallet asks before the next round` : `${money(a.left)} of your ${money(a.total)} left to play`;
}
/** no allowance to pay from, or too little of it: the wallet must be asked for a new one first. */
const needsAllowance = () => allow === null || (!!allow && allow.left < state.stake + 0.01);
/** ask the wallet for a new allowance. it opens, so this is the first thing a tap does. */
async function approve() {
  say(`approve up to $${ALLOWANCE} in your wallet…`);
  await step('approve', async () => (await walletNow()).renew(where(), me)).catch(outOfWallet);
  await paintAllow();
}
/** signed out on the wallet's side (or its storage was cleared): this page signs out too, and the next tap signs in. */
function outOfWallet(e) {
  if (!(e && e.signedOut)) throw e;
  me = null; allow = undefined; store.set('me', null); paintMe();
  throw Object.assign(new Error('tap send again to sign in'), { keep: true });
}
async function paintMe() {
  $('#outer').classList.toggle('hidden', !me);
  paintAllow();
  if (!me) { $('#me').textContent = 'sign in'; return 0; }
  const has = await holds().catch(() => 0);
  $('#me').textContent = has < state.stake + 0.01 ? 'add money' : money(has);
  $('#me').classList.toggle('want', has < state.stake + 0.01);
  return has;
}
function paint() {
  $('#pitch').textContent = `make the ai say “${state.word}”`;
  $('#pot').textContent = state.learning ? 'it just lost — it’s learning' : state.awake === false ? 'it’s asleep right now' : state.jackpot > 0 ? `win ${money(state.jackpot)}` : 'win the pot';
  $('#price').textContent = `${state.max_turns} messages for ${money(state.stake)}`;
  // a few short lines, not a paragraph
  const how = [
    `the ai has been told never to say “${state.word}”`,
    'get it to say it and the pot is yours',
    'most of what you pay goes into the pot',
    'every time it loses it learns, so a trick only works once',
    `you pay with tempo wallet — you approve up to $${ALLOWANCE}, good for a week`,
  ];
  $('#how').replaceChildren(...how.map((t) => Object.assign(document.createElement('li'), { textContent: t })));
}
async function look() { try { state = await get('/api/state'); paint(); } catch { /* keep what is shown */ } }

/** in plain words, why something did not happen. */
function plain(e) {
  // the page's own words, already plain.
  if (e && e.keep) return e.message;
  const b = e && e.body;
  if (b && b.learning) return 'it just lost and is learning — try again in a minute';
  if (b && b.asleep) return 'it’s asleep right now — nothing was charged';
  // the game's own answer is already in words: none of the wallet's guesses below apply to it.
  if (b && b.error) return String(b.error).slice(0, 240);
  const why = String((e && (e.shortMessage || e.message)) || e || '');
  if (/popup/i.test(why) && /block/i.test(why)) return 'your browser blocked the wallet — allow pop-ups for this site and try again';
  if ((e && e.code === 4001) || /reject|denied|cancel|closed|dismiss/i.test(why)) return e && e.step === 'stop' ? 'wallet closed — your allowance is still on' : 'wallet closed — nothing was charged';
  if (/insufficient|exceeds (the )?balance/i.test(why)) return 'not enough in your wallet — tap “add money” at the top';
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(why)) return 'the connection dropped — try again';
  // which step it was, then what the wallet or the game said about it.
  return `${e && e.step ? `could not ${e.step}: ` : ''}${why.slice(0, 160) || 'that did not work'}`;
}
const failed = (body, fallback) => Object.assign(new Error(body.error || fallback), { body });
/** do one named step. if it fails, the failure says which step it was. */
const step = async (name, fn) => { try { return await fn(); } catch (e) { throw Object.assign(e instanceof Error ? e : new Error(String(e)), { step: name }); } };

async function signIn() {
  // straight to the wallet: on a phone it opens in its own window, which a browser allows only right after a tap.
  me = await step('sign in', async () => (await walletNow()).connect(where()));
  store.set('me', me);
  return paintMe();
}
const addMoney = () => step('add money', async () => {
  const w = await walletNow();
  if (where().test) await fetch(state.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tempo_fundAddress', params: [me] }) });
  else await w.deposit({ ...where(), address: me, token: state.token, amount: '5.00' });
});
/** a game to talk in: the one already open, or a new one paid for from the wallet. */
async function ensureGame() {
  if (game) return;
  if (state.closed) throw Object.assign(new Error('closed for now'), { keep: true });
  // no game is being sold just now: nobody is asked to sign in or approve anything for one.
  // (the game says so itself as well; this is only so that the wallet is not opened for nothing.)
  if (state.learning) throw Object.assign(new Error('it just lost and is learning — try again in a minute'), { keep: true });
  if (state.awake === false) throw Object.assign(new Error('it’s asleep right now — try again later'), { keep: true });
  say(me ? 'one moment…' : 'signing in…');
  if (!me) await signIn();
  // (a round already paid for, whose answer was lost, is picked up with its proof: no new allowance for that.)
  else if (needsAllowance() && !store.get('paid')) await approve();
  const w = await wallet();
  // a cent over the price: the wallet pays a small network fee on top.
  const need = state.stake + 0.01;
  const has = await paintMe();
  // the wallet's window opens only straight after a tap, and signing in has just used this one: adding
  // money is the next tap, on the button that now says so.
  if (has < need && !store.get('paid')) throw Object.assign(new Error('add money to play — tap “add money” at the top'), { keep: true });
  say(`${state.max_turns} messages for ${money(state.stake)}…`);
  const res = await step('start a game', () => w.pay({ ...where(), account: me, token: state.token, most: String(state.stake), kept: store.get('paid'), keep: (proof) => store.set('paid', proof) },
    '/api/agent/play', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).catch(async (e) => {
    // nothing was paid. the wallet can open only straight after a tap, so the next tap asks it first.
    if (e && e.signedOut) outOfWallet(e);
    if (e && e.renew) { await paintAllow(); allow = null; throw Object.assign(new Error(`tap send again to approve up to $${ALLOWANCE} in your wallet`), { keep: true }); }
    throw e;
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.session) throw failed(body, 'a game could not be started');
  setGame({ id: body.session, left: body.turns_left });
  paintMe();
}
/** the game being played, kept in this browser. while there is one, its own count of messages left stands in for the price. */
function setGame(g) { game = g; store.set('game', g ? g.id : null); $('#price').classList.toggle('hidden', !!g); }
function endGame() { setGame(null); }

async function send(text) {
  busy(true);
  let mine = null;
  try {
    await ensureGame();
    mine = bubble('me', text);
    say('');
    for (let tries = 0; ; tries++) {
      const { status, body } = await post('/api/chat', { session: game.id, message: text });
      // busy for a few seconds: the message did not count. wait and send it again.
      if (status === 429 && body.retryIn > 0 && body.retryIn <= 30 && tries < 3) { say('one moment…'); await sleep(body.retryIn * 1000); continue; }
      // it learned from someone else's win mid-game: the messages that were left carry over, no charge.
      if (status === 409 && body.carry && tries < 3) {
        const c = await post('/api/agent/play', { session: game.id });
        if (c.status === 200 && c.body.session) { setGame({ id: c.body.session, left: c.body.turns_left }); say('it learned a new trick — your messages carry on, free'); continue; }
      }
      if (status !== 200) { if (status === 409 || status === 404) endGame(); throw failed(body, 'that did not go through'); }
      mine = null;
      const reply = (body.turns || []).find((t) => t.role === 'agent');
      bubble('it', reply ? reply.text : '');
      game.left = body.turnsLeft;
      if (body.win) {
        const w = body.win;
        bubble('won', w.late ? 'it said it — but someone beat you to it by a moment'
          : `it said it — you won ${money(w.prize)}${w.levy > 0 ? ` (${money(w.levy)} went to teaching it)` : ''}, on its way to your wallet`);
        endGame(); say(''); look();
        // the prize is sent once the ai has learned from the loss, which can take a few minutes. the
        // balance at the top is watched for it meanwhile; the page does not wait for it.
        (async () => { const had = await holds().catch(() => 0); for (let i = 0; i < 30; i++) { await sleep(10000); if ((await paintMe().catch(() => 0)) > had) break; } })();
      } else if (game.left === 0) { endGame(); say(`that was your ${state.max_turns} — send again for ${state.max_turns} more`); }
      else say(`${game.left} messages left`);
      break;
    }
  } catch (e) {
    // whatever was typed and not answered goes back in the box.
    if (mine) mine.remove();
    if (e && e.keep) $('#msg').value = text;
    if (mine || !game || !$('#thread').lastElementChild?.classList.contains('it')) { if (!$('#msg').value) $('#msg').value = text; }
    say(plain(e));
    look();
  }
  busy(false);
}

$('#form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('#msg').value.trim();
  if (!text || working || !state) return;
  $('#msg').value = '';
  send(text);
});
$('#me').onclick = async () => {
  if (working || !state) return;
  busy(true);
  try {
    if (!me) { say('signing in…'); await signIn(); say(''); }
    // the wallet opens first, straight from the tap; the balance it is measured against is read meanwhile.
    else { say('adding money…'); const before = holds().catch(() => 0); await addMoney(); const had = await before; let has = had; for (let i = 0; i < 20 && has <= had; i++) { await sleep(3000); has = await paintMe(); } say(has > had ? `${money(has - had)} added — now send your message` : 'not there yet — it can take a few minutes'); }
  } catch (e) { say(plain(e)); }
  busy(false);
};
$('#stop').onclick = async () => {
  if (working || !me) return;
  busy(true);
  try { say('ending it…'); const ended = await step('stop', async () => (await walletNow()).stop(where(), me)); say(ended ? 'stopped — nothing more can be taken without asking you' : 'nothing to stop — nothing can be taken without asking you'); }
  catch (e) { say(plain(e)); }
  await paintAllow();
  busy(false);
};
$('#out').onclick = async () => {
  if (working) return;
  try { (await wallet()).disconnect(where()); } catch { /* signed out here either way */ }
  me = null; store.set('me', null); paintMe(); say('signed out');
};

(async () => {
  await look();
  if (!state) { say('the game isn’t answering — try again in a moment'); return; }
  paintMe();
  // the wallet's code is fetched and made ready now, so that the first tap can open it at once.
  // if this browser is already signed in to the wallet, the page knows who it is talking to.
  setTimeout(async () => {
    try {
      const w = await wallet();
      await w.warm(where());
      const known = await w.known(where());
      if (known && known !== me && !working) { me = known; store.set('me', me); paintMe(); }
      // the wallet says nobody is signed in here (it was signed out on its own site, or its storage was cleared).
      else if (known === null && me && !working) { me = null; store.set('me', null); paintMe(); }
      else paintAllow();
    } catch { /* it is asked for again at the first tap, and says then what went wrong */ }
  }, 300);
  // a game left open in this browser is picked back up.
  const id = store.get('game');
  if (id) {
    const g = await get('/api/agent/session/' + encodeURIComponent(id)).catch(() => null);
    if (g && g.open && g.turns_left > 0) {
      setGame({ id, left: g.turns_left });
      for (const t of g.transcript || []) bubble(t.role === 'user' ? 'me' : 'it', t.text);
      say(`${game.left} messages left`);
    } else setGame(null);
  }
  setInterval(() => { if (!working && !document.hidden) look(); }, 10000);
})();
