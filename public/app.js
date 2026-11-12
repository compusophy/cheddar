const $ = (s) => document.querySelector(s);
const api = async (path, opts) => {
  const r = await fetch('/api' + path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const j = await r.json().catch(() => ({ error: 'something broke' }));
  // a refusal carries what the server said with it: some say why, and when to ask again.
  if (!r.ok) throw Object.assign(new Error(j.error || r.statusText), { status: r.status, body: j });
  return j;
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ls = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} }, del: (k) => { try { localStorage.removeItem(k); } catch {} } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** a wait, said the way a person would: "a minute", "25 min", "3h". */
const howLong = (s) => { s = Number(s); return s < 90 ? 'a minute' : s < 5400 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)}h`; };
/** why it is asleep, with when it wakes if that is known. */
const asleepLine = () => `asleep: ${state.asleep}.${state.wakes_in ? ` back in about ${howLong(state.wakes_in)}.` : ''} no charge.`;
const pop = (el) => { el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop'); };
const money = (n) => `$${Number(n).toFixed(2)}`;
/** small amounts keep their small digits: a reply costs a fraction of a cent, and $0.00 would be a lie. */
const small = (n) => { n = Number(n); return n > 0 && n < 0.01 ? `$${n.toFixed(4)}` : money(n); };
/** count a number on screen from one value to another. */
function tween(el, from, to, ms = 900) {
  const t0 = performance.now();
  const f = (now) => { const k = Math.min(1, (now - t0) / ms); el.textContent = money(from + (to - from) * (1 - Math.pow(1 - k, 3))); if (k < 1) requestAnimationFrame(f); };
  requestAnimationFrame(f);
}

// the purse: a wallet that lives in this browser. nobody needs to know that.
let purse = { key: ls.get('key'), address: ls.get('address') };
if (!purse.key || !purse.address) {
  const w = ethers.Wallet.createRandom();
  purse = { key: w.privateKey, address: w.address };
  ls.set('key', purse.key); ls.set('address', purse.address);
}
let balance = 0, state = null, session = null, word = 'cheese';

/** what the house still owes this purse from a win, when a daily cap has held part of a prize back. */
let owedToMe = null;
async function readBalance() {
  try { const r = await api('/balance/' + purse.address); balance = Number(r.balance) || 0; owedToMe = r.owed > 0 ? { amount: Number(r.owed), nextIn: Number(r.owed_next_in) || 0 } : null; } catch {}
  return balance;
}
const owedLine = () => !owedToMe ? '' : `the house still owes you ${money(owedToMe.amount)} from a win. it pays a purse only so much a day, so the rest comes by itself${owedToMe.nextIn ? `: the next part in about ${howLong(owedToMe.nextIn)}` : ''}.`;
function paintBalance(withPop) {
  $('#bal').textContent = money(balance); $('#cashbal').textContent = money(balance);
  const owed = $('#owed'); if (owed) { owed.textContent = owedLine(); owed.classList.toggle('hidden', !owedToMe); }
  // money the house owes this purse is worth a line of its own when the status line has nothing else to say.
  if (owedToMe && state && !$('#status').textContent) status('');
  if (withPop) pop($('#purse'));
}

// the chain, as little of it as the page needs. gas here is paid in the same dollars being sent, and
// the most a transfer could cost is set aside before it runs, so "all of it" is never quite all of it.
const TOKEN_ABI = ['function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)'];
const chain = () => new ethers.JsonRpcProvider(state.rpc, state.chain, { staticNetwork: true });
const tokenAs = (signer) => new ethers.Contract(state.token, TOKEN_ABI, signer);
/** what one transfer to `to` will set aside for gas, in token units, with the exact limits to send it under. */
async function feeFor(token, to) {
  const [gas, fd] = await Promise.all([token.transfer.estimateGas(to, 1n), token.runner.provider.getFeeData()]);
  const gasLimit = (gas * 13n) / 10n + 20000n;
  const maxFeePerGas = fd.maxFeePerGas ?? fd.gasPrice ?? 0n;
  const maxPriorityFeePerGas = fd.maxPriorityFeePerGas ?? 0n;
  // the gas price is in attodollars (1e-18); the token has six decimals. round up.
  const reserve = (gasLimit * maxFeePerGas + 10n ** 12n - 1n) / 10n ** 12n;
  return { gasLimit, maxFeePerGas, maxPriorityFeePerGas, reserve };
}
/** a game needs the stake and a little for gas. two cents covers the worst case many times over. */
const needed = () => (state?.stake ?? 0.25) + 0.02;

/**
 * play money only: the house stands a purse that cannot afford a game a dollar, once a day. when it
 * does not (this purse has had today's, or the house has given out its day's worth) the server says
 * why and when, the page says so too, and it does not ask again until it is worth asking.
 */
let dry = null;
function dryLine() {
  const left = Math.round(((Number(ls.get('dryUntil')) || 0) - Date.now()) / 1000);
  if (left <= 0) { ls.del('dryUntil'); ls.del('dryAsk'); ls.del('dryWhy'); return null; }
  const when = ` more in about ${howLong(left)}.`;
  const why = ls.get('dryWhy');
  return why === 'house' ? `the house has given out today's play money.${when}`
    : why === 'visitor' ? `the house has given your network its share of play money for today.${when}`
    : `your purse is empty, and it has had today's ${money(state.grant)} from the house.${when}`;
}
/** the status line says an empty purse whenever it has nothing more pressing to say (see `status`). */
const sayDry = () => { paintBalance(false); status(''); };
async function fillIfEmpty() {
  await readBalance();
  if (!(state?.grant > 0) || balance >= needed()) {
    // real money: nobody is given any. an empty purse is said up front, with where to fill it, before anyone types.
    dry = state?.real && balance < needed() ? `a game is ${money(state.stake)}, and your purse is empty. tap it, top right, to add money.` : null;
    paintBalance(false); if (dry && !$('#status').textContent) status('');
    return;
  }
  if (Date.now() < (Number(ls.get('dryAsk')) || 0) && (dry = dryLine())) return sayDry();
  status(ls.get('had') ? `your purse is empty. ${money(state.grant)} from the house…` : `a welcome ${money(state.grant)} for your first games…`, 'busy');
  try { await api('/faucet', { method: 'POST', body: JSON.stringify({ address: purse.address }) }); ls.set('had', '1'); dry = null; ls.del('dryUntil'); ls.del('dryAsk'); ls.del('dryWhy'); }
  catch (e) {
    const b = e.body || {};
    if (b.retry_after > 0 && (b.why === 'had' || b.why === 'house' || b.why === 'visitor')) {
      if (b.why === 'had') ls.set('had', '1');
      // the purse's own day is known exactly. the house's count can free up sooner, and a visitor can
      // move to another network, so those two are asked about again before long.
      ls.set('dryUntil', String(Date.now() + b.retry_after * 1000)); ls.set('dryWhy', b.why);
      ls.set('dryAsk', String(Date.now() + (b.why === 'had' ? b.retry_after : Math.min(b.retry_after, 600)) * 1000));
      dry = dryLine(); return sayDry();
    }
  }
  for (let i = 0; i < 8 && balance < needed(); i++) { await sleep(2000); await readBalance(); }
  paintBalance(balance > 0); status('');
}

/** the page says what kind of money this is, once it knows. */
function describeMoney() {
  const real = !!state.real;
  const price = $('#price');
  if (price) price.textContent = real ? `${money(state.stake)} a game, from your purse.` : `play money. an empty purse gets ${money(state.grant)} a day from the house.`;
  $('#cashabout').textContent = real
    ? `real dollars (${state.symbol} on tempo), kept in this browser and nowhere else. each game stakes ${money(state.stake)}; most of it goes into the pot. copy your secret key and keep it somewhere safe: if this browser forgets it, the money is gone.`
    : `test dollars, kept in this browser. they are worth nothing, but every stake and every payout is a real transaction. each game stakes ${money(state.stake)}; most of it goes into the pot. when the purse cannot afford a game the house puts in ${money(state.grant)}, once a day.`;
  const thinks = $('#thinks');
  if (thinks) thinks.textContent = 'it buys each reply itself, out of the stakes. no api key anywhere.';
  $('#addmoney').classList.toggle('hidden', !real);
  $('#addr').textContent = purse.address;
  $('#addhow').innerHTML = `send <b>${esc(state.symbol)}</b> on the <b>tempo</b> network to this address. only ${esc(state.symbol)}, only tempo: anything else will not show up here. a dollar is ${Math.floor(1 / needed())} games.`
    + `<br><br>no ${esc(state.symbol)} yet? 1. open <a href="https://wallet.tempo.xyz" target="_blank" rel="noopener noreferrer">tempo wallet</a> (a passkey, no app). 2. press add funds there: card, bank or another chain. 3. send some to the address above. or use a <a href="https://tempo.xyz/developers/docs/partners/bridges" target="_blank" rel="noopener noreferrer">bridge</a>.`;
}

// one status line, between the thread and the keyboard
function status(text, kind) {
  const el = $('#status');
  // nothing else to say, and the house cannot pay for a reply: say that, before anyone types.
  if (!text && state && state.awake === false && !state.learning) { text = asleepLine(); kind = 'busy'; }
  // or the purse cannot afford a game and the house has no dollar for it yet: say that, and when.
  else if (!text && dry && !session && balance < needed()) text = dry;
  // or the house owes this purse the rest of a prize: say so, and when the next of it comes.
  else if (!text && owedToMe && !session) { text = `the house still owes you ${money(owedToMe.amount)} from a win.${owedToMe.nextIn ? ` the next part in about ${howLong(owedToMe.nextIn)}.` : ' it is on its way.'}`; kind = 'ok'; }
  el.textContent = text; el.className = 'status' + (kind ? ' ' + kind : '');
}

document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('hidden', v.id !== b.dataset.view));
  if (b.dataset.view === 'history') loadHistory();
}));

let lastGen = null, wasLearning = false, poll = null;
/**
 * a paid game that the ai's learning cut short leaves its unused messages waiting. `carry` is how
 * many, when there are some: the next game is then the rest of that one, and it is not charged.
 */
let carry = null;
function paintAgain() {
  const learning = !!state?.learning;
  // play again waits for the new rules to land
  $('#again').disabled = learning;
  $('#again').textContent = learning ? 'it is learning…' : carry ? `carry on · ${carry.turnsLeft} left, no charge` : `play again · ${money(state.stake)}`;
}
async function checkCarry() {
  try { const r = await peek(); carry = r.session ? null : (r.carry || null); } catch { /* ask again later */ }
  paintAgain();
}
/**
 * the game's state: the pot, the generation, whether it is learning or asleep. asked for every few
 * seconds while the page is being looked at, and not at all while it is not. `fresh` is for when
 * this page has just changed something itself and an answer a couple of seconds old would be wrong.
 */
async function loadState(fresh) {
  // a tab nobody is looking at does not ask. it asks the moment it is looked at again (see below).
  if (document.hidden && state && fresh !== true) { clearTimeout(poll); poll = setTimeout(loadState, 10000); return; }
  // one failed request must not end the polling: on a phone the network drops all the time.
  try { state = await api(fresh === true ? '/state?fresh=' + Date.now() : '/state'); }
  catch { clearTimeout(poll); poll = setTimeout(loadState, 5000); return; }
  word = state.word;
  const learning = state.learning;
  $('#gen').textContent = learning ? 'learning…' : `gen ${state.gen}`;
  $('#msg').maxLength = state.max_chars;
  $('#gen').classList.toggle('learning', !!learning);
  if (!session) $('#jackpot').textContent = money(state.jackpot);
  paintAgain();
  // whoever is mid-conversation is told the moment it starts, not when they next speak.
  $('#send').disabled = !!learning || sending;
  $('#msg').disabled = !!learning;
  if (learning) status(`it is learning · ${learning.phase}`, 'busy');
  else if (lastGen !== null && lastGen !== state.gen) {
    status(`it learned something. generation ${state.gen}.`, 'ok');
    if (session) { note('it learned something mid-conversation. that game is over, but the messages you had left carry over.'); end(); }
    else checkCarry();
  } else if (wasLearning) status('');
  // asleep: the house cannot pay for a reply right now. said up front, before anyone stakes.
  if (!learning && state.awake === false && !sending && !$('#status').textContent) status('');
  wasLearning = !!learning;
  lastGen = state.gen;
  clearTimeout(poll); poll = setTimeout(loadState, learning ? 3000 : 10000);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && state) loadState(); });
// the rulebook is a dialogue, not something that shoves the conversation down the page.
const sheet = (id, open) => $(id).classList.toggle('hidden', !open);
$('#gen').onclick = () => {
  $('#rulesgen').textContent = `gen ${state.gen}`;
  $('#rulesmeta').textContent = state.gen === 0 ? 'where it started' : `everything here was learned from ${state.gen} defeat${state.gen === 1 ? '' : 's'}`;
  $('#policy').textContent = state.policy;
  sheet('#rulesheet', true);
};
$('#rulesclose').onclick = () => sheet('#rulesheet', false);
// a tap outside any sheet closes it
document.querySelectorAll('.sheet').forEach((s) => s.addEventListener('click', (e) => { if (e.target === s) s.classList.add('hidden'); }));

// the thread
const thread = () => $('#thread');
const scrollDown = () => { thread().scrollTop = thread().scrollHeight; };
const highlight = (t) => esc(t).replace(new RegExp(`(${word})`, 'gi'), '<mark>$1</mark>');
function bubble(kind, html) { const d = document.createElement('div'); d.className = 'msg ' + kind; d.innerHTML = html; thread().appendChild(d); scrollDown(); return d; }
const note = (t) => { const d = document.createElement('div'); d.className = 'note'; d.textContent = t; thread().appendChild(d); scrollDown(); };
/**
 * the receipt under a reply: what the ai paid for it, linked to the payment when there is one.
 * built from elements and text, never from markup.
 */
function receipt(after, paid, into = thread()) {
  if (!paid || !(Number(paid.cost) > 0)) return;
  const tx = /^0x[0-9a-fA-F]{64}$/.test(paid.tx || '') ? paid.tx : null;
  const el = document.createElement(tx ? 'a' : 'div');
  el.className = 'receipt';
  el.textContent = `it paid ${small(paid.cost)} for that`;
  if (tx) { el.href = `${state.thinks.explorer}/receipt/${tx}`; el.target = '_blank'; el.rel = 'noopener noreferrer'; el.title = 'the receipt for the payment that bought this reply'; }
  if (after && after.parentNode === into) after.after(el); else into.appendChild(el);
  scrollDown();
}
let typing = null;
const showTyping = () => { typing = bubble('it typing', '<i></i><i></i><i></i>'); };
const hideTyping = () => { typing?.remove(); typing = null; };

/** the stake: the purse pays the house before the first message. */
async function stake() {
  const token = tokenAs(new ethers.Wallet(purse.key, chain()));
  return (await token.transfer(state.house, ethers.parseUnits(state.stake.toFixed(6), 6))).hash;
}
/**
 * a game is looked up by the purse that owns it, and the purse proves it by signing a short dated
 * message. an address alone opens nothing: addresses are public, the key is not.
 */
let proofCache = null;
async function proof() {
  if (proofCache && Date.now() - proofCache.ts < 4 * 60_000) return proofCache;
  const ts = Date.now();
  const sig = await new ethers.Wallet(purse.key).signMessage(`say cheese purse: ${purse.address.toLowerCase()} ${ts}`);
  return (proofCache = { ts, sig });
}
const peek = async () => { const p = await proof(); return api(`/session?player=${purse.address}&ts=${p.ts}&sig=${p.sig}`); };
const openSession = async (stakeHash) => { const p = await proof(); return api('/session', { method: 'POST', body: JSON.stringify({ player: purse.address, nickname: ls.get('nick') || '', stake: stakeHash, ts: p.ts, sig: p.sig }) }); };
/**
 * a stake that has left the purse must become a game, whatever happens between the two. the hash is
 * kept until the server has opened a session for it, so a dropped connection, a slow block or a closed
 * tab costs a moment and never the stake. only the server saying that hash is no good lets go of it.
 */
async function openFor(hash) {
  for (let i = 0; ; i++) {
    try { const r = await openSession(hash); ls.del('pending'); return r; }
    catch (e) {
      const waiting = /not find the stake|failed to fetch|networkerror|load failed|something broke/i.test(e.message);
      if (!waiting) { ls.del('pending'); throw e; }
      if (i >= 5) throw new Error('your stake is safe. it has not shown up yet: send again in a moment.');
      status('waiting for your stake to land…', 'busy'); await sleep(3000);
    }
  }
}
const showAbandon = () => { $('#abandon').classList.toggle('hidden', !session); disarm(); };
function adopt(r) {
  session = { id: r.session, gen: r.gen, turnsLeft: r.turnsLeft ?? state.max_turns };
  $('#intro')?.remove();
  if (r.resumed) {
    for (const t of r.transcript) { if (t.role === 'user') bubble('me', esc(t.text)); else receipt(bubble('it', highlight(t.text)), t.paid); }
    status('picking up where you left off.', 'ok');
  } else status('');
  showAbandon();
}
/** ask the server first. it either resumes the game you are in, or tells you to stake. */
async function ensureSession() {
  if (session) return;
  let r = await peek();
  if (r.session) ls.del('pending'); // one game per purse: an open game is where the last stake went
  else if (r.carry && !ls.get('pending')) {
    // the rest of a game that was interrupted: opened without a stake.
    r = await openSession(undefined);
    carry = null; paintAgain();
    if (r.carried) note(`this is the rest of the game it interrupted: ${r.turnsLeft} messages, no charge.`);
  } else {
    let hash = ls.get('pending');
    if (hash) status('picking your stake back up…', 'busy');
    else {
      if (state.closed) throw new Error('closed for now. nothing was charged.');
      if (state.awake === false) throw new Error(asleepLine());
      if (balance < needed()) await fillIfEmpty();
      if (balance < needed()) {
        if (state.real) openPurse();
        throw new Error(state.real ? `add money to play: a game is ${money(state.stake)}.` : dry || 'your purse is empty.');
      }
      status(`putting ${money(state.stake)} in the pot…`, 'busy');
      try { hash = await stake(); } catch (e) { throw new Error('could not stake: ' + (e.shortMessage || e.message)); }
      ls.set('pending', hash);
      status('confirming…', 'busy');
    }
    r = await openFor(hash);
    tween($('#jackpot'), state.jackpot, r.jackpot, 700); pop($('#jackpot')); state.jackpot = r.jackpot;
    readBalance().then(() => paintBalance(false));
  }
  adopt(r);
}
/** on load: if there is a game open, the thread is waiting for you. */
async function resumeIfOpen() {
  try {
    const r = await peek();
    if (r.session) { ls.del('pending'); adopt(r); }
    else if (ls.get('pending')) status('a game you paid for is waiting. say something.', 'ok');
    else if (r.carry) { carry = r.carry; paintAgain(); status(`you have ${r.carry.turnsLeft} messages left from a game it interrupted. no charge.`, 'ok'); }
  } catch {}
}

/** the reply streams in over server-sent events; each token lands in the bubble as it arrives. */
async function chatStream(text, onDelta) {
  const r = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify({ session: session.id, message: text }) });
  // a refusal keeps what the server said with it: whether it answered at all, and how long to wait if it is busy.
  if (!r.ok || !r.body) { const j = await r.json().catch(() => ({})); throw Object.assign(new Error(j.error || r.statusText), { status: r.status, body: j }); }
  const reader = r.body.getReader(), dec = new TextDecoder();
  let buf = '', final = null;
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 2);
      if (!line.startsWith('data:')) continue;
      const ev = JSON.parse(line.slice(5));
      if (ev.delta) onDelta(ev.delta);
      if (ev.done) final = ev;
    }
  }
  if (!final) throw new Error('lost the connection');
  if (final.status !== 200) throw Object.assign(new Error(final.error || 'something broke'), { status: final.status, body: final });
  return final;
}

// the win moment
function chime() {
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)(); const now = ac.currentTime;
    [[523.25, 0], [659.25, .11], [783.99, .22], [1046.5, .33]].forEach(([f, t]) => {
      const o = ac.createOscillator(), g = ac.createGain(); o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0, now + t); g.gain.linearRampToValueAtTime(.16, now + t + .02); g.gain.exponentialRampToValueAtTime(.001, now + t + .6);
      o.connect(g).connect(ac.destination); o.start(now + t); o.stop(now + t + .65);
    });
  } catch {}
}
function burst() {
  const c = document.createElement('canvas'); c.className = 'burst'; document.body.appendChild(c);
  const ctx = c.getContext('2d'); c.width = innerWidth; c.height = innerHeight;
  const ps = Array.from({ length: 110 }, () => { const a = Math.random() * Math.PI * 2, v = 4 + Math.random() * 9; return { x: c.width / 2, y: c.height * .42, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 4, r: 3 + Math.random() * 4, hue: Math.random() < .8 ? 45 : 0, sat: Math.random() < .8 ? '100%' : '0%', life: 1 }; });
  const t0 = performance.now();
  const f = (now) => {
    const k = (now - t0) / 1400; ctx.clearRect(0, 0, c.width, c.height);
    for (const p of ps) { p.x += p.vx; p.y += p.vy; p.vy += .22; p.vx *= .99; p.life = 1 - k; ctx.globalAlpha = Math.max(0, p.life); ctx.fillStyle = `hsl(${p.hue} ${p.sat} ${p.hue ? '60%' : '95%'})`; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 7); ctx.fill(); }
    if (k < 1) requestAnimationFrame(f); else c.remove();
  };
  requestAnimationFrame(f);
}
function celebrate(prize) {
  burst(); chime(); try { navigator.vibrate?.([40, 60, 120]); } catch {}
  const w = document.createElement('div'); w.className = 'win';
  const brag = `i made an ai say ${word} and took the ${money(prize)} pot. it is rewriting its own rules because of me.\n${location.origin}`;
  w.innerHTML = `<div class="h1">it said it.</div><div class="money">${money(prize)}</div><div class="h2">yours. it lands once it's done learning why it lost.</div>
    ${ls.get('nick') ? '' : `<div class="claim"><input id="nick" placeholder="your name for the board" maxlength="24"><button id="nickgo">claim it</button></div>`}
    <a class="share" href="https://twitter.com/intent/tweet?text=${encodeURIComponent(brag)}" target="_blank" rel="noopener noreferrer">tell people</a>`;
  thread().appendChild(w); scrollDown();
  $('#nickgo')?.addEventListener('click', () => saveName($('#nick').value, $('#nickgo')));
  tween($('#jackpot'), state.jackpot, state.seed, 1200); state.jackpot = state.seed;
}
/** a name, signed by the purse so only its owner can set it. */
async function saveName(name, btn) {
  const clean = String(name || '').trim().slice(0, 24);
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  try {
    const signer = new ethers.Wallet(purse.key);
    const signature = await signer.signMessage(`say cheese name: ${clean}`);
    const r = await api('/name', { method: 'POST', body: JSON.stringify({ player: purse.address, nickname: clean, signature }) });
    ls.set('nick', r.nickname || ''); if (btn) btn.textContent = r.nickname ? 'yours' : 'saved'; $('#cashnick') && ($('#cashnick').value = r.nickname || '');
  } catch (e) { if (btn) { btn.disabled = false; btn.textContent = 'claim it'; } status(e.message, 'bad'); }
}
/**
 * after a win: watch for the prize to land, and say what happened to it. all of it arrives, or part
 * of it does and the rest is owed, or a daily cap holds the whole of it for now. each of those is
 * said under the win, with the receipt of whatever was sent. a winner is never left to wonder.
 *
 * the money is on the chain a moment before the game has written down that it sent it. nothing is
 * said about what is "still owed" from a record that has not caught up with the purse: this waits
 * until the game's account of what it paid covers what actually arrived.
 */
const HELD = /^(purse daily cap|daily cap|the operator)$/; // the reasons a prize waits that are not "it is on its way"
async function watchPayout(before, winId) {
  const card = document.querySelector('#thread .win:last-of-type') || thread();
  const sayOwed = (w) => {
    const d = document.createElement('div');
    d.className = 'owed';
    d.textContent = `${money(w.still_owed)} ${w.paid > 0 ? 'more ' : ''}is yours. ${w.note || 'it is sent by itself.'}${w.next_payment_in > 90 ? ` the next part in about ${howLong(w.next_payment_in)}.` : ''}`;
    card.appendChild(d); scrollDown();
  };
  for (let i = 0; i < 40; i++) {
    await sleep(6000); await readBalance();
    if (balance > before) {
      const got = balance - before;
      tween($('#bal'), before, balance, 1000); pop($('#purse')); $('#cashbal').textContent = money(balance); status('paid.', 'ok');
      try { chime(); } catch { /* a sound the browser would not play is no reason to stop here */ }
      let w = null;
      for (let k = 0; k < 8 && !w; k++) {
        try { const seen = await api('/win/' + winId); if (seen.paid >= got - 0.000001) w = seen; } catch { /* ask again */ }
        if (!w) await sleep(2000);
      }
      if (!w) return; // the money arrived. the rest is a nicety, and is not guessed at.
      // the prize is a payment like any other: link its receipt under the win.
      if (w.receipt && /^https:\/\//.test(w.receipt)) {
        const a = document.createElement('a');
        a.className = 'receipt paid'; a.href = w.receipt; a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.textContent = `${money(w.paid)} paid to you`;
        card.appendChild(a); scrollDown();
      }
      // a prize bigger than the house pays in a day comes in parts. the rest is said, not left to be wondered about.
      if (w.still_owed > 0 && HELD.test(w.waiting_for || '')) { sayOwed(w); status('paid in part. the rest follows.', 'ok'); }
      return;
    }
    // it has learned, and still nothing has been sent: a daily cap, or the operator, is holding all of it.
    try {
      const w = await api('/win/' + winId);
      if (w.still_owed > 0 && HELD.test(w.waiting_for || '')) { sayOwed(w); status('yours, and held for now. it will be sent.', 'ok'); return; }
    } catch { /* ask again next time round */ }
  }
}

/** why the game asked for a moment, said shortly. the wait is counted down after it. */
const WAITS = { crowd: 'everyone is playing at once.', fast: 'easy.', busy: 'it is still answering.' };
let sending = false;
$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('#msg').value.trim(); if (!text || sending) return;
  sending = true; $('#send').disabled = true; $('#send').textContent = '···'; $('#msg').value = ''; $('#msg').style.height = '';
  try { navigator.vibrate?.(8); } catch {}
  let mine = null, it = null;
  try {
    await ensureSession();
    mine = bubble('me', esc(text));
    let acc = '', r;
    for (let tries = 0; ; tries++) {
      showTyping();
      try {
        r = await chatStream(text, (delta) => {
          acc += delta;
          if (!it) { hideTyping(); it = bubble('it', ''); }
          it.innerHTML = highlight(acc); scrollDown();
        });
        break;
      } catch (err) {
        hideTyping();
        // the game is busy, said for how long, and it is not long: wait it out and send the message for them.
        const wait = Math.ceil(Number(err.body?.retryIn) || 0);
        if (!(err.status === 429 && wait > 0 && wait <= 30) || tries >= 3) throw err;
        for (let s = wait; s > 0; s--) { status(`${WAITS[err.body.why] || 'one moment.'} sending yours in ${s}s…`, 'busy'); await sleep(1000); }
        status('');
      }
    }
    hideTyping();
    const reply = r.turns?.find((t) => t.role === 'agent');
    if (reply) { if (!it) it = bubble('it', ''); it.innerHTML = highlight(reply.text); receipt(it, reply.paid); }
    session.turnsLeft = r.turnsLeft;
    if (r.win && r.win.late) { note('it said it. but someone else beat it a moment before you, and the pot was theirs.' + (r.win.carry ? ' the messages you had left carry over.' : '')); status('it is learning…', 'busy'); end(); }
    else if (r.win) { const before = balance; celebrate(r.win.prize); status('it is learning…', 'busy'); end(); watchPayout(before, r.win.id); }
    else if (r.turnsLeft === 0) { note('that is the end of this conversation.'); status(''); end(); }
    else status('');
  } catch (err) {
    hideTyping();
    let said = err.message, kind = 'bad', over = false;
    const giveBack = () => { mine?.remove(); it?.remove(); if (!$('#msg').value) $('#msg').value = text; };
    if (!mine) giveBack(); // it never reached the thread (no money yet, a stake still landing): back in the box.
    else {
      // the message is on the thread, and it stays there only if the game has it. a refusal means it
      // does not. when the answer was lost on the way, nobody here knows: the game is asked what it has.
      const refused = err.status && (err.status < 500 || err.status === 503); // the game's own "no", as against a crash or a timeout
      const has = refused ? null : await peek().catch(() => null);
      if (refused) giveBack();
      else if (has?.session && session && has.turnsLeft < session.turnsLeft) {
        // the game took it and answered. show what it has, in place of whatever arrived of it here.
        mine.remove(); it?.remove();
        for (const t of has.transcript.slice(-2)) { if (t.role === 'user') bubble('me', esc(t.text)); else receipt(bubble('it', highlight(t.text)), t.paid); }
        session.turnsLeft = has.turnsLeft; said = ''; kind = '';
      } else if (has?.session) { giveBack(); said = 'that did not get through. it is back in the box: send it again.'; } // the game is open and never saw it.
      else if (has) { said = 'lost the connection, and that game has ended. history shows how.'; over = true; }
      // and if the game could not be asked either, the thread is left as it is.
    }
    status(said, kind);
    if (over || /learn|session is|run its course/.test(err.message)) end();
  }
  sending = false; $('#send').disabled = false; $('#send').textContent = 'send'; $('#msg').focus();
});
$('#msg').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#form').requestSubmit(); } });
$('#msg').addEventListener('input', (e) => { e.target.style.height = ''; e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px'; });
function end() { $('#form').classList.add('hidden'); $('#again').classList.remove('hidden'); session = null; showAbandon(); loadState(true).then(checkCarry); }

/** start over: two presses, because it forfeits the rest of a paid game. */
let armed = null;
function disarm() { clearTimeout(armed); armed = null; $('#abandon').classList.remove('armed'); $('#abandon').textContent = 'start over'; }
$('#abandon').onclick = async () => {
  if (!session) return;
  if (!armed) {
    $('#abandon').classList.add('armed'); $('#abandon').textContent = 'forfeit?';
    armed = setTimeout(disarm, 4000);
    return;
  }
  const id = session.id; disarm();
  try { await api('/abandon', { method: 'POST', body: JSON.stringify({ session: id }) }); } catch {}
  session = null; thread().innerHTML = ''; showAbandon();
  $('#again').classList.add('hidden'); $('#form').classList.remove('hidden');
  status('cleared. your next message starts a new game.', 'ok');
  $('#msg').focus();
};
$('#again').onclick = () => { if ($('#again').disabled) return; thread().innerHTML = ''; $('#again').classList.add('hidden'); $('#form').classList.remove('hidden'); status(''); showAbandon(); $('#msg').focus(); };

// history: a ledger of defeats. each row is a generation, the line that killed it, and what it learned.
async function loadHistory() {
  const [{ generations, wins, totals, board, explorer }, th] = await Promise.all([api('/history'), api('/thoughts').catch(() => null)]);
  // a prize that has been paid links to its receipt.
  const prizeOf = (w) => /^0x[0-9a-fA-F]{64}$/.test(w.tx || '') && explorer
    ? `<a class="prize" href="${esc(explorer)}/receipt/${esc(w.tx)}" target="_blank" rel="noopener noreferrer" title="the receipt for this prize">${money(w.prize)}</a>`
    : `<span class="prize">${money(w.prize)}</span>`;
  const byId = Object.fromEntries(wins.map((w) => [w.id, w]));
  // `wins` holds only the conversations shown below; the counts come already added up.
  const won = Number(totals?.wins ?? wins.length), paid = Number(totals?.paid ?? 0);
  // one line of facts that wraps where it has to: five cells of ten characters do not fit a phone, or even the page.
  const thinking = th && th.thoughts
    ? ` · <a ${th.recent[0]?.tx ? `href="${esc(th.explorer)}/receipt/${esc(th.recent[0].tx)}" target="_blank" rel="noopener noreferrer"` : ''} title="what it has paid for its own replies. the link is its latest payment.">${small(th.spent)} on thinking</a>`
    : '';
  $('#histstrip').innerHTML = `<div class="cell sum"><b>gen ${Number(state?.gen ?? generations.length - 1)}</b> · ${won} win${won === 1 ? '' : 's'} · ${money(paid)} paid${thinking}</div>`;

  $('#gens').innerHTML = generations.slice().reverse().map((g, i, arr) => {
    const w = g.parent_breach_id ? byId[g.parent_breach_id] : null;
    const prev = arr[i + 1];
    const kill = w ? w.transcript.filter((t) => t.role === 'user').pop()?.text : '';
    const flags = [
      g.gen > 0 && !g.regression_passed ? '<span class="badge bad">leaky</span>' : '',
      g.gen > 0 && !g.legit_passed ? '<span class="badge bad">clammed up</span>' : '',
      w?.autoimmune ? '<span class="badge auto">autoimmune</span>' : '',
    ].join('');
    const replay = w ? w.transcript.map((t) => `<div class="mini ${t.role === 'user' ? 'me' : 'it'}">${t.role === 'user' ? esc(t.text) : highlight(t.text)}</div>`).join('') : '';
    return `<details class="gen-card" ${i === 0 ? 'open' : ''}>
      <summary>
        <div class="line"><b>gen ${g.gen}</b><span class="meta">${g.gen === 0 ? 'where it started' : `beaten by ${esc(w?.nickname || 'someone')}`}</span>${flags}${w && w.prize ? prizeOf(w) : ''}</div>
        ${kill ? `<div class="kill">${esc(kill)}</div>` : ''}
      </summary>
      <div class="body">
        ${replay ? `<div class="replay">${replay}</div>` : ''}
        ${g.lesson ? `<div class="learned">what it learned</div><div class="took">${esc(g.lesson)}</div>` : ''}
        <details class="fold"><summary>${g.gen === 0 ? 'the rules it started with' : 'its new rules in full'}</summary><pre>${esc(g.policy)}</pre></details>
      </div>
    </details>`;
  }).join('');

  $('#board tbody').innerHTML = board.map((r) => `<tr><td>${esc(r.nickname || 'anonymous')}</td><td class="dim">gen ${r.highest_gen}</td><td class="dim">${r.wins}×</td><td class="money">${Number(r.won) > 0 ? money(r.won) : '—'}</td></tr>`).join('') || '<tr><td class="dim">nobody yet</td></tr>';
}

// the purse: money in, money out, a name, and moving it between browsers
/**
 * money on its way in. someone adding money sends it from a wallet somewhere else and comes back to
 * look, so while the purse is open the balance is read every few seconds and money that arrives
 * says so. it stops when the purse is closed, and does nothing while the page is not being looked at.
 */
let purseWatch = null;
async function lookForMoney() {
  if (document.hidden || sending) return;
  const had = balance; await readBalance();
  if (balance > had + 0.000001) {
    paintBalance(true);
    const said = `${money(balance - had)} arrived.`;
    if (!$('#cashout').classList.contains('hidden')) $('#cashstatus').textContent = said + (balance >= needed() ? ' you can play.' : '');
    else if (!session && !sending) status(said, 'ok');
  } else paintBalance(false);
}
function openPurse() {
  sheet('#cashout', true); readBalance().then(() => paintBalance(false)); $('#cashstatus').textContent = ''; $('#cashnick').value = ls.get('nick') || ''; disarmRestore(); disarmSend();
  clearInterval(purseWatch); purseWatch = setInterval(lookForMoney, 5000);
}
function closePurse() { sheet('#cashout', false); clearInterval(purseWatch); purseWatch = null; disarmSend(); if (!$('#status').textContent) status(''); }
$('#purse').onclick = openPurse;
$('#cashclose').onclick = closePurse;
// and on coming back to the page from somewhere else (a wallet, most likely), one look.
document.addEventListener('visibilitychange', () => { if (!document.hidden && state) lookForMoney(); });
$('#cashnick').addEventListener('change', (e) => saveName(e.target.value));
$('#cashkey').onclick = async () => { try { await navigator.clipboard.writeText(purse.key); $('#cashstatus').textContent = 'copied. keep it safe.'; } catch { prompt('your secret key', purse.key); } };
$('#addrcopy').onclick = async () => { try { await navigator.clipboard.writeText(purse.address); $('#addrcopy').textContent = 'copied'; setTimeout(() => { $('#addrcopy').textContent = 'copy'; }, 1500); } catch { prompt('your purse address', purse.address); } };
/**
 * everything in the purse, sent somewhere else. it cannot be taken back, so it takes two presses:
 * the first says how much and where to, the second sends it. changing the address starts over. a
 * few destinations are refused outright, because money sent to them is simply gone.
 */
let sendArmed = null;
function disarmSend() { clearTimeout(sendArmed?.timer); sendArmed = null; const b = $('#cashsend'); b.classList.remove('armed'); b.textContent = 'send all'; }
$('#cashto').addEventListener('input', disarmSend);
$('#cashsend').onclick = async () => {
  const to = $('#cashto').value.trim();
  const say = (t) => { $('#cashstatus').textContent = t; };
  if (!ethers.isAddress(to)) { disarmSend(); return say('that does not look like an address.'); }
  const dest = ethers.getAddress(to), lower = dest.toLowerCase();
  if (lower === purse.address.toLowerCase()) { disarmSend(); return say('that is this purse.'); }
  if (/^0x0{40}$/.test(lower) || lower === String(state.token).toLowerCase()) { disarmSend(); return say('money sent to that address is gone for good. not sending.'); }
  if (lower === String(state.house).toLowerCase()) { disarmSend(); return say('that is the house. money sent there is not a stake, and does not come back. not sending.'); }
  if (balance <= 0) { disarmSend(); return say('nothing to send yet.'); }
  if (!sendArmed || sendArmed.to !== lower) {
    disarmSend();
    await readBalance(); paintBalance(false);
    if (balance <= 0) return say('nothing to send yet.');
    $('#cashsend').classList.add('armed'); $('#cashsend').textContent = 'send it?';
    say(`${money(balance)}, all of it, to ${dest.slice(0, 8)}…${dest.slice(-6)}. this cannot be undone. press again to send.`);
    sendArmed = { to: lower, timer: setTimeout(disarmSend, 8000) };
    return;
  }
  disarmSend();
  $('#cashstatus').textContent = 'sending…'; $('#cashsend').disabled = true;
  try {
    const token = tokenAs(new ethers.Wallet(purse.key, chain()));
    // gas comes out of the same dollars and is set aside first, so send everything but that.
    const [have, fee] = await Promise.all([token.balanceOf(purse.address), feeFor(token, to)]);
    if (have <= fee.reserve) throw new Error('there is less here than the network fee.');
    const tx = await token.transfer(to, have - fee.reserve, { gasLimit: fee.gasLimit, maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas });
    await tx.wait();
    $('#cashstatus').textContent = 'sent. a fraction of a cent stays behind: the unspent part of the network fee.'; await readBalance(); paintBalance(false);
  } catch (e) { $('#cashstatus').textContent = 'could not send: ' + (e.shortMessage || e.message); }
  $('#cashsend').disabled = false;
};

/**
 * use a purse from another browser: paste its secret key and this browser becomes that purse.
 * two presses, because it replaces the purse that is here, and whatever is in that one is only
 * reachable with its own key.
 */
let restoreArmed = null;
function disarmRestore() { clearTimeout(restoreArmed); restoreArmed = null; const b = $('#restorego'); b.classList.remove('armed'); b.textContent = 'switch to it'; }
$('#restorego').onclick = () => {
  const raw = $('#restorekey').value.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? '0x' + raw : raw;
  let w = null;
  try { if (/^0x[0-9a-fA-F]{64}$/.test(key)) w = new ethers.Wallet(key); } catch {}
  if (!w) { $('#cashstatus').textContent = 'that is not a secret key.'; return; }
  if (w.address.toLowerCase() === purse.address.toLowerCase()) { $('#cashstatus').textContent = 'that is the purse already here.'; return; }
  if (!restoreArmed) {
    $('#restorego').classList.add('armed'); $('#restorego').textContent = 'replace this purse?';
    $('#cashstatus').textContent = balance >= 0.01 ? `this purse still holds ${money(balance)}. copy its key first, or that money stays behind.` : 'the purse here will be replaced.';
    restoreArmed = setTimeout(disarmRestore, 6000);
    return;
  }
  ls.set('key', w.privateKey); ls.set('address', w.address); ls.del('nick'); ls.del('pending');
  location.reload();
};

// start up once the game's state is known; until then keep asking.
(async () => { await loadState(); while (!state) { await sleep(2000); await loadState(); } describeMoney(); fillIfEmpty(); resumeIfOpen(); })();
