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

// the purse: a wallet that lives in this browser. nobody needs to know that.
let purse = { key: ls.get('key'), address: ls.get('address') };
if (!purse.key || !purse.address) {
  const w = ethers.Wallet.createRandom();
  purse = { key: w.privateKey, address: w.address };
  ls.set('key', purse.key); ls.set('address', purse.address);
}
let balance = 0, state = null, session = null, word = 'cheese';

async function readBalance() { try { balance = Number((await api('/balance/' + purse.address)).balance) || 0; } catch {} return balance; }
function paintBalance(withPop) { $('#bal').textContent = `$${balance.toFixed(2)}`; $('#cashbal').textContent = `$${balance.toFixed(2)}`; if (withPop) pop($('#purse')); }
/** testnet: the purse fills itself once so the first game can be staked. */
async function fillIfEmpty() {
  await readBalance();
  if (balance >= (state?.stake || 0.25)) return paintBalance(false);
  status('getting you some money…', 'busy');
  try { await api('/faucet', { method: 'POST', body: JSON.stringify({ address: purse.address }) }); } catch {}
  for (let i = 0; i < 8 && balance < (state?.stake || 0.25); i++) { await sleep(2000); await readBalance(); }
  paintBalance(balance > 0); status('');
}

// the status line: one place, one sentence, between the thread and the keyboard.
function status(text, kind) { const el = $('#status'); el.textContent = text; el.className = 'status' + (kind ? ' ' + kind : ''); }

document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('hidden', v.id !== b.dataset.view));
  if (b.dataset.view === 'history') loadHistory();
}));

async function loadState() {
  state = await api('/state');
  word = state.word;
  $('#gen').textContent = state.learning ? 'learning…' : `gen ${state.gen}`;
  $('#gen').classList.toggle('learning', !!state.learning);
  $('#jackpot').textContent = `$${Number(state.jackpot).toFixed(2)}`;
  $('#stakeamt').textContent = state.stake.toFixed(2);
  $('#policy').textContent = state.policy;
  if (state.learning) setTimeout(loadState, 4000);
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
/** ask the server first. it either resumes the game you are in, or tells you to stake. */
async function ensureSession() {
  if (session) return;
  const open = async (stakeHash) => api('/session', { method: 'POST', body: JSON.stringify({ player: purse.address, nickname: ls.get('nick') || '', stake: stakeHash }) });
  let r;
  try { r = await open(); } catch (e) { if (!/stake required/.test(e.message)) throw e; }
  if (!r) {
    if (balance < state.stake) await fillIfEmpty();
    status(`putting $${state.stake.toFixed(2)} in the pot…`, 'busy');
    let hash;
    try { hash = await stake(); } catch (e) { throw new Error('could not stake: ' + (e.shortMessage || e.message)); }
    status('confirming…', 'busy');
    r = await open(hash);
    $('#jackpot').textContent = `$${Number(r.jackpot).toFixed(2)}`; pop($('#jackpot'));
    readBalance().then(() => paintBalance(false));
  }
  session = { id: r.session, gen: r.gen, turnsLeft: r.resumed ? r.turnsLeft : state.max_turns };
  $('#intro')?.remove();
  if (r.resumed) {
    for (const t of r.transcript) t.role === 'user' ? bubble('me', esc(t.text)) : bubble('it', highlight(t.text));
    status(`picking up where you left off. ${r.turnsLeft} left.`, 'ok');
  } else status(`you're in. ${state.max_turns} messages.`, 'ok');
}

let sending = false;
$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('#msg').value.trim(); if (!text || sending) return;
  sending = true; $('#send').disabled = true; $('#msg').value = ''; $('#msg').style.height = '';
  try {
    await ensureSession();
    bubble('me', esc(text));                 // your message lands the instant you send it
    showTyping();
    const r = await api('/chat', { method: 'POST', body: JSON.stringify({ session: session.id, message: text }) });
    hideTyping();
    const reply = r.turns.find((t) => t.role === 'agent');
    if (reply) bubble('it', highlight(reply.text));
    session.turnsLeft = r.turnsLeft;
    if (r.win) {
      const w = document.createElement('div'); w.className = 'win';
      w.innerHTML = `<div class="h1">it said it.</div><div class="money">$${Number(r.win.prize).toFixed(2)}</div><div class="h2">yours. it lands once it's done learning why it lost.</div>`;
      thread().appendChild(w); scrollDown();
      status('it is learning…', 'busy'); end();
      const before = balance;
      for (let i = 0; i < 30; i++) { await sleep(8000); await readBalance(); if (balance > before) { paintBalance(true); status('paid.', 'ok'); break; } }
    } else if (r.turnsLeft === 0) { note('out of messages. it held.'); status(''); end(); }
    else status(`${r.turnsLeft} left`);
  } catch (err) {
    hideTyping(); status(err.message, 'bad');
    if (/learn|session is|go again/.test(err.message)) end();
  }
  sending = false; $('#send').disabled = false; $('#msg').focus();
});
$('#msg').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#form').requestSubmit(); } });
$('#msg').addEventListener('input', (e) => { e.target.style.height = ''; e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px'; });
function end() { $('#form').classList.add('hidden'); $('#again').classList.remove('hidden'); session = null; loadState(); }
$('#again').onclick = () => { thread().innerHTML = ''; $('#again').classList.add('hidden'); $('#form').classList.remove('hidden'); status(''); $('#msg').focus(); };

// history: each generation as a tiny replay of the message that beat it, then what it learned
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
    const lastYou = w ? w.transcript.filter((t) => t.role === 'user').pop()?.text : '';
    const lastIt = w ? w.transcript.filter((t) => t.role === 'agent').pop()?.text : '';
    return `<details class="gen-card" ${i === 0 ? 'open' : ''}>
      <summary><b>gen ${g.gen}</b><span class="meta">${g.gen === 0 ? 'where it started' : `${esc(w?.nickname || 'someone')} beat it`}</span>
        ${g.gen > 0 && !g.regression_passed ? '<span class="badge bad">leaky</span>' : ''}${g.gen > 0 && !g.legit_passed ? '<span class="badge bad">clammed up</span>' : ''}${w?.autoimmune ? '<span class="badge auto">autoimmune</span>' : ''}</summary>
      ${lastYou ? `<div class="how">${esc(lastYou)}</div><div class="said">${highlight(lastIt)}</div>` : ''}
      ${prev ? '<div class="learned">what it learned</div>' : ''}
      ${diffHtml(prev ? prev.policy : null, g.policy)}</details>`;
  }).join('');
  $('#board tbody').innerHTML = board.map((r) => `<tr><td>${esc(r.nickname || 'anonymous')}</td><td class="dim">gen ${r.highest_gen}</td><td class="dim">${r.wins}×</td><td class="money">${Number(r.won) > 0 ? '$' + Number(r.won).toFixed(2) : '—'}</td></tr>`).join('') || '<tr><td class="dim">nobody yet</td></tr>';
}

// cash out
$('#purse').onclick = () => { $('#cashout').classList.remove('hidden'); readBalance().then(() => paintBalance(false)); $('#cashstatus').textContent = ''; };
$('#cashclose').onclick = () => $('#cashout').classList.add('hidden');
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

loadState().then(fillIfEmpty);
