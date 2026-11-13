// the simple page. sign in with tempo wallet, pay for a game from it, talk, win.
// no purse, no key, no address: the wallet is the account, and a prize is paid straight back to it.
const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const money = (n) => (n > 0 && n < 1 ? `${Math.round(n * 100)}¢` : `$${Number(n).toFixed(2)}`);
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
  s.onload = () => (window.tempoWallet ? (libReady = true, ok(window.tempoWallet)) : no(new Error('the wallet did not load.')));
  s.onerror = () => { lib = null; no(new Error('the wallet did not load. check your connection.')); };
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
  if (Date.now() - began > 800) throw Object.assign(new Error('ready now. tap again.'), { keep: true });
  return w;
}
const say = (text) => { $('#said').textContent = text || ''; };
function bubble(kind, text) {
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
  if (a) $('#allowtext').textContent = spent ? `your ${money(a.total)} is used up. your wallet asks before the next game.` : `${money(a.left)} of your ${money(a.total)} left to play`;
}
/** no allowance to pay from, or too little of it: the wallet must be asked for a new one first. */
const needsAllowance = () => allow === null || (!!allow && allow.left < state.stake + 0.01);
/** ask the wallet for a new allowance. it opens, so this is the first thing a tap does. */
async function approve() {
  say(`approve up to $${ALLOWANCE} in your wallet…`);
  await step('approve', async () => (await walletNow()).renew(where(), me));
  await paintAllow();
}
async function paintMe() {
  $('#out').classList.toggle('hidden', !me);
  // signed out: the price says what signing in will ask for.
  if (state) $('#price').textContent = `${state.max_turns} messages for ${money(state.stake)}${me ? '' : ` · you approve up to $${ALLOWANCE} once`}`;
  paintAllow();
  if (!me) { $('#me').textContent = 'sign in'; return 0; }
  const has = await holds().catch(() => 0);
  $('#me').textContent = has < state.stake + 0.01 ? 'add money' : money(has);
  $('#me').classList.toggle('want', has < state.stake + 0.01);
  return has;
}
function paint() {
  $('#pitch').textContent = `make the ai say “${state.word}”.`;
  $('#pot').textContent = state.learning ? 'it just lost. it is learning.' : state.awake === false ? 'it is asleep right now.' : state.jackpot > 0 ? `win ${money(state.jackpot)}.` : 'win the pot.';
  $('#price').textContent = `${state.max_turns} messages for ${money(state.stake)}${me ? '' : ` · you approve up to $${ALLOWANCE} once`}`;
  $('#how').textContent = `the ai has been told never to say “${state.word}”. you get ${state.max_turns} messages for ${money(state.stake)}. if it says the word in any reply, you win the pot. most of what you pay goes into the pot. every time it loses it learns, so the same trick does not work twice. you sign in and pay with tempo wallet: a passkey, no app. at sign-in you let this site take up to $${ALLOWANCE} in all, only for messages and only to the game, for a week at most. when that is used up the wallet asks you again.`;
}
async function look() { try { state = await get('/api/state'); paint(); } catch { /* keep what is shown */ } }

/** in plain words, why something did not happen. */
function plain(e) {
  // the page's own words, already plain.
  if (e && e.keep) return e.message;
  const b = e && e.body;
  if (b && b.learning) return 'it just lost and is learning. try again in a minute.';
  if (b && b.asleep) return 'it is asleep right now. nothing was charged.';
  const why = String((e && (e.shortMessage || e.message)) || e || '');
  if (/popup/i.test(why) && /block/i.test(why)) return 'your browser blocked the wallet. allow pop-ups for this site and try again.';
  if ((e && e.code === 4001) || /reject|denied|cancel|closed|dismiss/i.test(why)) return 'the wallet was closed. nothing was charged.';
  // which step it was, then what the wallet or the game said about it.
  return `${e && e.step ? `could not ${e.step}: ` : ''}${why.slice(0, 160) || 'that did not work.'}`;
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
  if (state.closed) throw new Error('closed for now.');
  say(me ? 'one moment…' : 'signing in…');
  if (!me) await signIn();
  else if (needsAllowance()) await approve();
  const w = await wallet();
  // a cent over the price: the wallet pays a small network fee on top.
  const need = state.stake + 0.01;
  const has = await paintMe();
  // the wallet's window opens only straight after a tap, and signing in has just used this one: adding
  // money is the next tap, on the button that now says so.
  if (has < need && !store.get('paid')) throw Object.assign(new Error(`add money to play: tap “add money” at the top. ${state.max_turns} messages are ${money(state.stake)}.`), { keep: true });
  say(`${state.max_turns} messages for ${money(state.stake)}…`);
  const res = await step('start a game', () => w.pay({ ...where(), account: me, token: state.token, most: String(state.stake), kept: store.get('paid'), keep: (proof) => store.set('paid', proof) },
    '/api/agent/play', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).catch(async (e) => {
    // nothing was paid. the wallet can open only straight after a tap, so the next tap asks it first.
    if (e && e.renew) { await paintAllow(); allow = null; throw Object.assign(new Error(`tap send again: your wallet will ask you to approve up to $${ALLOWANCE} for messages.`), { keep: true }); }
    throw e;
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.session) throw failed(body, 'a game could not be started.');
  game = { id: body.session, left: body.turns_left };
  store.set('game', game.id);
  paintMe();
}
function endGame() { game = null; store.set('game', null); }

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
        if (c.status === 200 && c.body.session) { game = { id: c.body.session, left: c.body.turns_left }; store.set('game', game.id); say('it learned a new trick. your game carries on, no charge.'); continue; }
      }
      if (status !== 200) { if (status === 409 || status === 404) endGame(); throw failed(body, 'that did not go through.'); }
      mine = null;
      const reply = (body.turns || []).find((t) => t.role === 'agent');
      bubble('it', reply ? reply.text : '');
      game.left = body.turnsLeft;
      if (body.win) {
        const w = body.win;
        bubble('won', w.late ? 'it said it, but someone beat you to it by a moment.'
          : `it said it. you won ${money(w.prize)}.${w.levy > 0 ? ` ${money(w.levy)} of the pot went to teaching it.` : ''} it is on its way to your wallet.`);
        endGame(); say(''); look();
        for (let i = 0; i < 12; i++) { await sleep(5000); await paintMe(); }
      } else if (game.left === 0) { endGame(); say(`that was your ${state.max_turns}. send again for ${state.max_turns} more (${money(state.stake)}).`); }
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
    else { say('adding money…'); const before = holds().catch(() => 0); await addMoney(); const had = await before; let has = had; for (let i = 0; i < 20 && has <= had; i++) { await sleep(3000); has = await paintMe(); } say(has > had ? `${money(has - had)} added. now send your message.` : 'the money is not there yet. it can take a few minutes.'); }
  } catch (e) { say(plain(e)); }
  busy(false);
};
$('#stop').onclick = async () => {
  if (working || !me) return;
  busy(true);
  try { say('ending it…'); await step('stop', async () => (await walletNow()).stop(where(), me)); say(`stopped. nothing more can be taken without asking you.`); }
  catch (e) { say(plain(e)); }
  await paintAllow();
  busy(false);
};
$('#out').onclick = async () => {
  if (working) return;
  try { (await wallet()).disconnect(where()); } catch { /* signed out here either way */ }
  me = null; store.set('me', null); paintMe(); say('signed out.');
};

(async () => {
  await look();
  if (!state) { say('the game is not answering. try again in a moment.'); return; }
  paintMe();
  // the wallet's code is fetched and made ready now, so that the first tap can open it at once.
  // if this browser is already signed in to the wallet, the page knows who it is talking to.
  setTimeout(async () => {
    try {
      const w = await wallet();
      await w.warm(where());
      const known = await w.known(where());
      if (known && known !== me && !working) { me = known; store.set('me', me); paintMe(); }
      else paintAllow();
    } catch { /* it is asked for again at the first tap, and says then what went wrong */ }
  }, 300);
  // a game left open in this browser is picked back up.
  const id = store.get('game');
  if (id) {
    const g = await get('/api/agent/session/' + encodeURIComponent(id)).catch(() => null);
    if (g && g.open && g.turns_left > 0) {
      game = { id, left: g.turns_left };
      for (const t of g.transcript || []) bubble(t.role === 'user' ? 'me' : 'it', t.text);
      say(`${game.left} messages left`);
    } else store.set('game', null);
  }
  setInterval(() => { if (!working && !document.hidden) look(); }, 10000);
})();
