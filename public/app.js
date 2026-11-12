const $ = (s) => document.querySelector(s);
const api = async (path, opts) => {
  const r = await fetch('/api' + path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const j = await r.json().catch(() => ({ error: 'something broke' }));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ls = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} }, del: (k) => { try { localStorage.removeItem(k); } catch {} } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pop = (el) => { el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop'); };
const money = (n) => `$${Number(n).toFixed(2)}`;
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

async function readBalance() { try { balance = Number((await api('/balance/' + purse.address)).balance) || 0; } catch {} return balance; }
function paintBalance(withPop) { $('#bal').textContent = money(balance); $('#cashbal').textContent = money(balance); if (withPop) pop($('#purse')); }

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

/** play money only: the purse fills itself once so the first game can be staked. */
async function fillIfEmpty() {
  await readBalance();
  if (!(state?.grant > 0) || balance >= needed()) return paintBalance(false);
  status(`a welcome ${money(state.grant)} for your first games…`, 'busy');
  try { await api('/faucet', { method: 'POST', body: JSON.stringify({ address: purse.address }) }); } catch {}
  for (let i = 0; i < 8 && balance < needed(); i++) { await sleep(2000); await readBalance(); }
  paintBalance(balance > 0); status('');
}

/** the page says what kind of money this is, once it knows. */
function describeMoney() {
  const real = !!state.real;
  const price = $('#price');
  if (price) price.textContent = real ? `${money(state.stake)} a game, from your purse.` : `play money. a new purse gets ${money(state.grant)} to start.`;
  $('#cashabout').textContent = real
    ? `real dollars (${state.symbol} on tempo), kept in this browser and nowhere else. each game stakes ${money(state.stake)}; most of it goes into the pot. copy your secret key and keep it somewhere safe: if this browser forgets it, the money is gone.`
    : `test dollars, kept in this browser. they are worth nothing, but every stake and every payout is a real transaction. each game stakes ${money(state.stake)}; most of it goes into the pot.`;
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
  if (!text && state && state.awake === false && !state.learning) { text = `asleep: ${state.asleep}. no charge.`; kind = 'busy'; }
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
async function loadState() {
  state = await api('/state');
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
    for (const t of r.transcript) t.role === 'user' ? bubble('me', esc(t.text)) : bubble('it', highlight(t.text));
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
      if (state.awake === false) throw new Error(`asleep: ${state.asleep}. no charge.`);
      if (balance < needed()) await fillIfEmpty();
      if (balance < needed()) {
        if (state.real) openPurse();
        throw new Error(state.real ? `add money to play: a game is ${money(state.stake)}.` : 'your purse is empty.');
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
  if (!r.ok || !r.body) { const j = await r.json().catch(() => ({})); throw new Error(j.error || r.statusText); }
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
  if (final.status !== 200) throw new Error(final.error || 'something broke');
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
/** after a win: watch the purse until the pot lands, then make it count up. */
async function watchPayout(before) {
  for (let i = 0; i < 40; i++) {
    await sleep(6000); await readBalance();
    if (balance > before) { tween($('#bal'), before, balance, 1000); pop($('#purse')); $('#cashbal').textContent = money(balance); status('paid.', 'ok'); chime(); return; }
  }
}

let sending = false;
$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('#msg').value.trim(); if (!text || sending) return;
  sending = true; $('#send').disabled = true; $('#send').textContent = '···'; $('#msg').value = ''; $('#msg').style.height = '';
  try { navigator.vibrate?.(8); } catch {}
  let posted = false;
  try {
    await ensureSession();
    bubble('me', esc(text)); posted = true;
    showTyping();
    let it = null, acc = '';
    const r = await chatStream(text, (delta) => {
      acc += delta;
      if (!it) { hideTyping(); it = bubble('it', ''); }
      it.innerHTML = highlight(acc); scrollDown();
    });
    hideTyping();
    const reply = r.turns?.find((t) => t.role === 'agent');
    if (reply) { if (!it) it = bubble('it', ''); it.innerHTML = highlight(reply.text); }
    session.turnsLeft = r.turnsLeft;
    if (r.win) { const before = balance; celebrate(r.win.prize); status('it is learning…', 'busy'); end(); watchPayout(before); }
    else if (r.turnsLeft === 0) { note('that is the end of this conversation.'); status(''); end(); }
    else status('');
  } catch (err) {
    hideTyping(); status(err.message, 'bad');
    // a message that never reached the thread (no money yet, a stake still landing) goes back in the box.
    if (!posted && !$('#msg').value) $('#msg').value = text;
    if (/learn|session is|run its course/.test(err.message)) end();
  }
  sending = false; $('#send').disabled = false; $('#send').textContent = 'send'; $('#msg').focus();
});
$('#msg').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#form').requestSubmit(); } });
$('#msg').addEventListener('input', (e) => { e.target.style.height = ''; e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px'; });
function end() { $('#form').classList.add('hidden'); $('#again').classList.remove('hidden'); session = null; showAbandon(); loadState().then(checkCarry); }

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
  const [{ generations, wins, board }, th] = await Promise.all([api('/history'), api('/thoughts').catch(() => null)]);
  const byId = Object.fromEntries(wins.map((w) => [w.id, w]));
  const paid = wins.reduce((t, w) => t + (w.paid ? Number(w.prize) : 0), 0);
  $('#histstrip').innerHTML = [
    `<span class="cell"><b>gen ${state?.gen ?? generations.length - 1}</b></span>`,
    `<span class="cell gen">${wins.length} win${wins.length === 1 ? '' : 's'}</span>`,
    `<span class="cell gen">${money(paid)} paid</span>`,
    th && th.thoughts ? `<a class="cell gen" ${th.recent[0]?.tx ? `href="${esc(th.explorer)}/tx/${esc(th.recent[0].tx)}" target="_blank" rel="noopener noreferrer"` : ''} title="what it has paid for its own replies. the link is its latest payment.">${money(th.spent)} on thinking</a>` : '',
    `<span class="cell gen right">🤖 always playing</span>`,
  ].join('');

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
        <div class="line"><b>gen ${g.gen}</b><span class="meta">${g.gen === 0 ? 'where it started' : `beaten by ${esc(w?.nickname || 'someone')}`}</span>${flags}${w && w.prize ? `<span class="prize">${money(w.prize)}</span>` : ''}</div>
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
function openPurse() { sheet('#cashout', true); readBalance().then(() => paintBalance(false)); $('#cashstatus').textContent = ''; $('#cashnick').value = ls.get('nick') || ''; disarmRestore(); }
$('#purse').onclick = openPurse;
$('#cashclose').onclick = () => sheet('#cashout', false);
$('#cashnick').addEventListener('change', (e) => saveName(e.target.value));
$('#cashkey').onclick = async () => { try { await navigator.clipboard.writeText(purse.key); $('#cashstatus').textContent = 'copied. keep it safe.'; } catch { prompt('your secret key', purse.key); } };
$('#addrcopy').onclick = async () => { try { await navigator.clipboard.writeText(purse.address); $('#addrcopy').textContent = 'copied'; setTimeout(() => { $('#addrcopy').textContent = 'copy'; }, 1500); } catch { prompt('your purse address', purse.address); } };
$('#cashsend').onclick = async () => {
  const to = $('#cashto').value.trim();
  if (!ethers.isAddress(to)) { $('#cashstatus').textContent = 'that does not look like an address.'; return; }
  if (balance <= 0) { $('#cashstatus').textContent = 'nothing to send yet.'; return; }
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

loadState().then(() => { describeMoney(); fillIfEmpty(); resumeIfOpen(); });
