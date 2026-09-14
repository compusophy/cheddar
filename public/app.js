const $ = (s) => document.querySelector(s);
const api = async (path, opts) => {
  const r = await fetch('/api' + path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const j = await r.json().catch(() => ({ error: 'something broke' }));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ls = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
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
/** testnet: the purse fills itself once so the first game can be staked. */
async function fillIfEmpty() {
  await readBalance();
  if (balance >= (state?.stake || 0.25)) return paintBalance(false);
  status('getting you some money…', 'busy');
  try { await api('/faucet', { method: 'POST', body: JSON.stringify({ address: purse.address }) }); } catch {}
  for (let i = 0; i < 8 && balance < (state?.stake || 0.25); i++) { await sleep(2000); await readBalance(); }
  paintBalance(balance > 0); status('');
}

// one status line, between the thread and the keyboard
function status(text, kind) { const el = $('#status'); el.textContent = text; el.className = 'status' + (kind ? ' ' + kind : ''); }

document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('hidden', v.id !== b.dataset.view));
  if (b.dataset.view === 'history') loadHistory();
}));

let lastGen = null;
async function loadState() {
  state = await api('/state');
  word = state.word;
  const learning = state.learning;
  $('#gen').textContent = learning ? `learning: ${learning.phase}` : `gen ${state.gen}`;
  $('#gen').classList.toggle('learning', !!learning);
  if (!session) $('#jackpot').textContent = money(state.jackpot);
  $('#stakeamt').textContent = state.stake.toFixed(2);
  $('#policy').textContent = state.policy;
  // play again waits for the new rules to land
  $('#again').disabled = !!learning;
  $('#again').textContent = learning ? `it's learning… ${learning.phase}` : `play again · ${money(state.stake)}`;
  if (learning && !session) status(`someone just beat it. ${learning.phase}…`, 'busy');
  else if (lastGen !== null && lastGen !== state.gen && !session) status(`new rules. generation ${state.gen}.`, 'ok');
  lastGen = state.gen;
  if (learning) setTimeout(loadState, 3000);
}
$('#showrules').onclick = () => $('#policy').classList.toggle('hidden');

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
  const provider = new ethers.JsonRpcProvider(state.rpc, state.chain);
  const signer = new ethers.Wallet(purse.key, provider);
  const token = new ethers.Contract(state.token, ['function transfer(address,uint256) returns (bool)'], signer);
  return (await token.transfer(state.house, ethers.parseUnits(state.stake.toFixed(6), 6))).hash;
}
const openSession = (stakeHash) => api('/session', { method: 'POST', body: JSON.stringify({ player: purse.address, nickname: ls.get('nick') || '', stake: stakeHash }) });
function adopt(r) {
  session = { id: r.session, gen: r.gen, turnsLeft: r.resumed ? r.turnsLeft : state.max_turns };
  $('#intro')?.remove();
  if (r.resumed) {
    for (const t of r.transcript) t.role === 'user' ? bubble('me', esc(t.text)) : bubble('it', highlight(t.text));
    status('picking up where you left off.', 'ok');
  } else status('');
}
/** ask the server first. it either resumes the game you are in, or tells you to stake. */
async function ensureSession() {
  if (session) return;
  let r;
  try { r = await openSession(); } catch (e) { if (!/stake required/.test(e.message)) throw e; }
  if (!r) {
    if (balance < state.stake) await fillIfEmpty();
    status(`putting ${money(state.stake)} in the pot…`, 'busy');
    let hash;
    try { hash = await stake(); } catch (e) { throw new Error('could not stake: ' + (e.shortMessage || e.message)); }
    status('confirming…', 'busy');
    r = await openSession(hash);
    tween($('#jackpot'), state.jackpot, r.jackpot, 700); pop($('#jackpot')); state.jackpot = r.jackpot;
    readBalance().then(() => paintBalance(false));
  }
  adopt(r);
}
/** on load: if there is a game open, the thread is waiting for you. */
async function resumeIfOpen() {
  try { const r = await openSession(); if (r?.resumed) adopt(r); } catch {}
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
  w.innerHTML = `<div class="h1">it said it.</div><div class="money">${money(prize)}</div><div class="h2">yours. it lands once it's done learning why it lost.</div>
    ${ls.get('nick') ? '' : `<div class="claim"><input id="nick" placeholder="your name for the board" maxlength="24"><button id="nickgo">claim it</button></div>`}`;
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
  try {
    await ensureSession();
    bubble('me', esc(text));
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
    if (/learn|session is|run its course/.test(err.message)) end();
  }
  sending = false; $('#send').disabled = false; $('#send').textContent = 'send'; $('#msg').focus();
});
$('#msg').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#form').requestSubmit(); } });
$('#msg').addEventListener('input', (e) => { e.target.style.height = ''; e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px'; });
function end() { $('#form').classList.add('hidden'); $('#again').classList.remove('hidden'); session = null; loadState(); }
$('#again').onclick = () => { if ($('#again').disabled) return; thread().innerHTML = ''; $('#again').classList.add('hidden'); $('#form').classList.remove('hidden'); status(''); $('#msg').focus(); };

// history: each generation replays the conversation that beat it, then what it learned
async function loadHistory() {
  const { generations, wins, board } = await api('/history');
  const m = state?.machine;
  $('#machinepulse').textContent = m && m.wins ? `🤖 a bot plays around the clock · ${m.wins} win${m.wins === 1 ? '' : 's'}` : '🤖 a bot plays around the clock. beat it to the next one.';
  const byId = Object.fromEntries(wins.map((w) => [w.id, w]));
  const diffHtml = (prev, cur) => !prev || !window.Diff ? `<pre>${esc(cur)}</pre>`
    : '<pre>' + Diff.diffWords(prev, cur).map((p) => p.added ? `<ins>${esc(p.value)}</ins>` : p.removed ? `<del>${esc(p.value)}</del>` : esc(p.value)).join('') + '</pre>';
  $('#gens').innerHTML = generations.slice().reverse().map((g, i, arr) => {
    const w = g.parent_breach_id ? byId[g.parent_breach_id] : null;
    const prev = arr[i + 1];
    const replay = w ? w.transcript.map((t) => `<div class="mini ${t.role === 'user' ? 'me' : 'it'}">${t.role === 'user' ? esc(t.text) : highlight(t.text)}</div>`).join('') : '';
    return `<details class="gen-card" ${i === 0 ? 'open' : ''}>
      <summary><b>gen ${g.gen}</b><span class="meta">${g.gen === 0 ? 'where it started' : `${esc(w?.nickname || 'someone')} beat it${w?.prize ? ' · ' + money(w.prize) : ''}`}</span>
        ${g.gen > 0 && !g.regression_passed ? '<span class="badge bad">leaky</span>' : ''}${g.gen > 0 && !g.legit_passed ? '<span class="badge bad">clammed up</span>' : ''}${w?.autoimmune ? '<span class="badge auto">autoimmune</span>' : ''}</summary>
      ${replay ? `<div class="replay">${replay}</div>` : ''}
      ${prev ? '<div class="learned">what it learned</div>' : ''}
      ${diffHtml(prev ? prev.policy : null, g.policy)}</details>`;
  }).join('');
  $('#board tbody').innerHTML = board.map((r) => `<tr><td>${esc(r.nickname || 'anonymous')}</td><td class="dim">gen ${r.highest_gen}</td><td class="dim">${r.wins}×</td><td class="money">${Number(r.won) > 0 ? money(r.won) : '—'}</td></tr>`).join('') || '<tr><td class="dim">nobody yet</td></tr>';
}

// cash out + name
$('#purse').onclick = () => { $('#cashout').classList.remove('hidden'); readBalance().then(() => paintBalance(false)); $('#cashstatus').textContent = ''; $('#cashnick').value = ls.get('nick') || ''; };
$('#cashclose').onclick = () => $('#cashout').classList.add('hidden');
$('#cashnick').addEventListener('change', (e) => saveName(e.target.value));
$('#cashkey').onclick = async () => { try { await navigator.clipboard.writeText(purse.key); $('#cashstatus').textContent = 'copied. keep it safe.'; } catch { prompt('your secret key', purse.key); } };
$('#cashsend').onclick = async () => {
  const to = $('#cashto').value.trim();
  if (!ethers.isAddress(to)) { $('#cashstatus').textContent = 'that does not look like an address.'; return; }
  if (balance <= 0) { $('#cashstatus').textContent = 'nothing to send yet.'; return; }
  $('#cashstatus').textContent = 'sending…'; $('#cashsend').disabled = true;
  try {
    const provider = new ethers.JsonRpcProvider(state.rpc, state.chain);
    const signer = new ethers.Wallet(purse.key, provider);
    const token = new ethers.Contract(state.token, ['function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)'], signer);
    const tx = await token.transfer(to, await token.balanceOf(purse.address)); await tx.wait();
    $('#cashstatus').textContent = 'sent.'; await readBalance(); paintBalance(false);
  } catch (e) { $('#cashstatus').textContent = 'could not send: ' + (e.shortMessage || e.message); }
  $('#cashsend').disabled = false;
};

loadState().then(() => { fillIfEmpty(); resumeIfOpen(); });
