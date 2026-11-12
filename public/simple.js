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
let working = false;
/** ?test: a throwaway key stands in for the wallet. play money only. */
const wantsTest = new URLSearchParams(location.search).has('test');
const where = () => ({ testnet: !state.real, chainId: state.chain, test: wantsTest && !state.real });

let lib = null;
const wallet = () => (lib ||= new Promise((ok, no) => {
  const s = document.createElement('script');
  s.src = '/vendor/tempo-wallet.js';
  s.onload = () => (window.tempoWallet ? ok(window.tempoWallet) : no(new Error('the wallet did not load.')));
  s.onerror = () => { lib = null; no(new Error('the wallet did not load. check your connection.')); };
  document.head.appendChild(s);
}));

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
async function paintMe() {
  $('#out').classList.toggle('hidden', !me);
  if (!me) { $('#me').textContent = 'sign in'; return 0; }
  const has = await holds().catch(() => 0);
  $('#me').textContent = `${money(has)} · add`;
  return has;
}
function paint() {
  $('#pitch').textContent = `make the ai say “${state.word}”.`;
  $('#pot').textContent = state.learning ? 'it just lost. it is learning.' : state.awake === false ? 'it is asleep right now.' : state.jackpot > 0 ? `win ${money(state.jackpot)}.` : 'win the pot.';
  $('#price').textContent = `${money(state.stake)} a game · ${state.max_turns} messages`;
  $('#how').textContent = `the ai has been told never to say “${state.word}”. get it to say it and you win the pot. a game is ${money(state.stake)} for ${state.max_turns} messages, and most of that goes into the pot. every time it loses it learns, so the same trick does not work twice. you sign in and pay with tempo wallet: a passkey, no app.`;
}
async function look() { try { state = await get('/api/state'); paint(); } catch { /* keep what is shown */ } }

/** in plain words, why something did not happen. */
function plain(e) {
  const b = e && e.body;
  if (b && b.learning) return 'it just lost and is learning. try again in a minute.';
  if (b && b.asleep) return 'it is asleep right now. nothing was charged.';
  const why = String((e && (e.shortMessage || e.message)) || e || '');
  if (/popup/i.test(why) && /block/i.test(why)) return 'your browser blocked the wallet. allow pop-ups for this site and try again.';
  if ((e && e.code === 4001) || /reject|denied|cancel|closed|dismiss/i.test(why)) return 'the wallet was closed. nothing was charged.';
  return why.slice(0, 160) || 'that did not work. nothing was charged.';
}
const failed = (body, fallback) => Object.assign(new Error(body.error || fallback), { body });

async function signIn() {
  const w = await wallet();
  me = (await w.known(where())) || (await w.connect(where()));
  store.set('me', me);
  return paintMe();
}
async function addMoney() {
  const w = await wallet();
  if (where().test) await fetch(state.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tempo_fundAddress', params: [me] }) });
  else await w.deposit({ ...where(), address: me, token: state.token, amount: '5.00' });
}
/** a game to talk in: the one already open, or a new one paid for from the wallet. */
async function ensureGame() {
  if (game) return;
  if (state.closed) throw new Error('closed for now.');
  const w = await wallet();
  if (!me) { say('signing in…'); await signIn(); }
  // a cent over the price: the wallet pays a small network fee on top.
  const need = state.stake + 0.01;
  let has = await paintMe();
  if (has < need && !store.get('paid')) {
    say('add money to play.');
    await addMoney();
    for (let i = 0; i < 20 && has < need; i++) { await sleep(3000); has = await paintMe(); }
    if (has < need) throw new Error('the money is not there yet. it can take a few minutes: send again when it shows.');
  }
  say(`starting a game: ${money(state.stake)}`);
  const res = await w.pay({ ...where(), token: state.token, most: String(state.stake), kept: store.get('paid'), keep: (proof) => store.set('paid', proof) },
    '/api/agent/play', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
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
      } else if (game.left === 0) { endGame(); say('that game is over. send again to start a new one.'); }
      else say(`${game.left} messages left`);
      break;
    }
  } catch (e) {
    // whatever was typed and not answered goes back in the box.
    if (mine) mine.remove();
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
    else { say('adding money…'); const had = await holds(); await addMoney(); let has = had; for (let i = 0; i < 20 && has <= had; i++) { await sleep(3000); has = await paintMe(); } say(has > had ? `${money(has - had)} added.` : 'the money is not there yet. it can take a few minutes.'); }
  } catch (e) { say(plain(e)); }
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
