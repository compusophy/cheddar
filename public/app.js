const $ = (s) => document.querySelector(s);
const api = async (path, opts) => {
  const r = await fetch('/api' + path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const j = await r.json().catch(() => ({ error: 'something broke' }));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ls = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

// the purse. a wallet that lives in this browser. the player never needs to know that.
let purse = { key: ls.get('key'), address: ls.get('address') };
if (!purse.key || !purse.address) {
  const w = ethers.Wallet.createRandom();
  purse = { key: w.privateKey, address: w.address };
  ls.set('key', purse.key); ls.set('address', purse.address);
}
let balance = 0;
async function refreshPurse(pop) {
  try { balance = Number((await api('/balance/' + purse.address)).balance) || 0; } catch {}
  if (balance < (state?.stake || 0.25) && !refreshPurse.filling) {
    // testnet: the faucet keeps the purse topped up so play is free. the stake is still real.
    refreshPurse.filling = true;
    try { await api('/faucet', { method: 'POST', body: JSON.stringify({ address: purse.address }) }); await new Promise((r) => setTimeout(r, 4000)); balance = Number((await api('/balance/' + purse.address)).balance) || 0; } catch {}
    refreshPurse.filling = false;
  }
  $('#bal').textContent = `$${balance.toFixed(2)}`;
  $('#cashbal').textContent = `$${balance.toFixed(2)}`;
  if (pop) { $('#purse').classList.remove('pop'); void $('#purse').offsetWidth; $('#purse').classList.add('pop'); }
}

let state = null, session = null, word = 'cheese';

document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('nav button').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('hidden', v.id !== b.dataset.view));
  if (b.dataset.view === 'history') loadHistory();
}));

async function loadState() {
  state = await api('/state');
  word = state.word;
  $('#gen').textContent = state.learning ? 'learning…' : `gen ${state.gen}`;
  $('#gen').classList.toggle('learning', !!state.learning);
  $('#jackpot').textContent = `pot $${Number(state.jackpot).toFixed(2)}`;
  $('#stakeline') && ($('#stakeline').textContent = `a game costs $${state.stake.toFixed(2)}. win and the pot is yours.`);
  $('#policy').textContent = state.policy;
  if (state.learning) setTimeout(loadState, 4000);
}
$('#showrules').onclick = (e) => { e.preventDefault(); $('#policy').classList.toggle('hidden'); };

const highlight = (text) => esc(text).replace(new RegExp(`(${word})`, 'gi'), '<mark>$1</mark>');
function addTurn(t) {
  const d = document.createElement('div');
  if (t.role === 'user') { d.className = 'turn user'; d.textContent = t.text; }
  else if (t.role === 'agent') { d.className = 'turn agent'; d.innerHTML = highlight(t.text); }
  else { d.className = 'turn system'; d.textContent = t.text; }
  $('#log').appendChild(d); $('#log').scrollTop = $('#log').scrollHeight;
}
/** the stake: the purse pays the house before the first message. the player just sees the pot grow. */
async function stake() {
  const provider = new ethers.JsonRpcProvider(state.rpc, state.chain);
  const signer = new ethers.Wallet(purse.key, provider);
  const token = new ethers.Contract(state.token, ['function transfer(address,uint256) returns (bool)'], signer);
  const tx = await token.transfer(state.house, ethers.parseUnits(state.stake.toFixed(6), 6));
  return tx.hash;
}
async function ensureSession() {
  if (session) return;
  addTurn({ role: 'system', text: `staking $${state.stake.toFixed(2)}…` });
  let hash;
  try { hash = await stake(); } catch (e) { throw new Error('could not stake: ' + (e.shortMessage || e.message)); }
  const r = await api('/session', { method: 'POST', body: JSON.stringify({ player: purse.address, nickname: ls.get('nick') || '', stake: hash }) });
  session = { id: r.session, gen: r.gen, turnsLeft: state.max_turns };
  $('#intro')?.remove();
  $('#log').querySelector('.turn.system')?.remove();
  $('#jackpot').textContent = `pot $${Number(r.jackpot).toFixed(2)}`;
  $('#jackpot').classList.remove('pop'); void $('#jackpot').offsetWidth; $('#jackpot').classList.add('pop');
  refreshPurse(false);
}
const showTurns = () => { $('#turns').textContent = session ? `${session.turnsLeft} left` : ''; };

$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#msg').value.trim(); if (!msg) return;
  $('#send').disabled = true; $('#msg').value = ''; $('#msg').style.height = '';
  try {
    await ensureSession();
    const r = await api('/chat', { method: 'POST', body: JSON.stringify({ session: session.id, message: msg }) });
    r.turns.forEach(addTurn);
    session.turnsLeft = r.turnsLeft; showTurns();
    if (r.win) {
      const w = document.createElement('div'); w.className = 'win';
      w.innerHTML = `<div class="big">it said it.</div><div class="huge">$${Number(r.win.prize).toFixed(2)}</div><div class="small">the pot is yours. it lands in your purse once it has finished learning why it lost.</div>`;
      $('#log').appendChild(w); $('#log').scrollTop = $('#log').scrollHeight;
      end(); const poll = setInterval(async () => { const b = balance; await refreshPurse(false); if (balance > b) { refreshPurse(true); clearInterval(poll); } }, 8000); setTimeout(() => clearInterval(poll), 240000);
    } else if (r.turnsLeft === 0) { addTurn({ role: 'system', text: 'out of turns. it held.' }); end(); }
  } catch (err) { addTurn({ role: 'system', text: err.message }); if (/learn|session is/.test(err.message)) end(); }
  $('#send').disabled = false; $('#msg').focus();
});
$('#msg').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#form').requestSubmit(); } });
$('#msg').addEventListener('input', (e) => { e.target.style.height = ''; e.target.style.height = Math.min(e.target.scrollHeight, 140) + 'px'; });
function end() { $('#form').classList.add('hidden'); $('#again').classList.remove('hidden'); session = null; showTurns(); loadState(); }
$('#again').onclick = () => { $('#log').innerHTML = ''; $('#again').classList.add('hidden'); $('#form').classList.remove('hidden'); $('#msg').focus(); };

// history: every generation, what beat it, what it learned
async function loadHistory() {
  const { generations, wins, board } = await api('/history');
  const m = state?.machine;
  $('#machinepulse').textContent = m && m.wins ? `🤖 the machine plays around the clock · ${m.wins} win${m.wins === 1 ? '' : 's'}` : '🤖 the machine plays around the clock. beat it to the next one.';
  const byId = Object.fromEntries(wins.map((w) => [w.id, w]));
  const diffHtml = (prev, cur) => !prev || !window.Diff ? `<pre>${esc(cur)}</pre>`
    : '<pre>' + Diff.diffWords(prev, cur).map((p) => p.added ? `<ins>${esc(p.value)}</ins>` : p.removed ? `<del>${esc(p.value)}</del>` : esc(p.value)).join('') + '</pre>';
  $('#gens').innerHTML = generations.slice().reverse().map((g, i, arr) => {
    const w = g.parent_breach_id ? byId[g.parent_breach_id] : null;
    const prev = arr[i + 1];
    const how = w ? w.transcript.filter((t) => t.role === 'user').map((t) => t.text).join('\n\n') : '';
    return `<details class="gen" ${i === 0 ? 'open' : ''}>
      <summary><b>gen ${g.gen}</b><span class="meta">${g.gen === 0 ? 'where it started' : `after ${esc(w?.nickname || 'someone')} beat it`}</span>
        ${g.gen > 0 && !g.regression_passed ? '<span class="badge bad">leaky</span>' : ''}${g.gen > 0 && !g.legit_passed ? '<span class="badge bad">clammed up</span>' : ''}${w?.autoimmune ? '<span class="badge auto">autoimmune</span>' : ''}</summary>
      ${how ? `<div class="how">${esc(how)}</div>` : ''}
      ${prev ? '<div class="meta">what it learned</div>' : ''}
      ${diffHtml(prev ? prev.policy : null, g.policy)}</details>`;
  }).join('');
  $('#board tbody').innerHTML = board.map((r) => `<tr><td>${esc(r.nickname || 'anonymous')}</td><td class="dim">gen ${r.highest_gen}</td><td class="dim">${r.wins}×</td><td class="money">${Number(r.won) > 0 ? '$' + Number(r.won).toFixed(2) : '—'}</td></tr>`).join('') || '<tr><td class="dim">nobody yet</td></tr>';
}

// cash out: the only place the wallet surfaces, and only as "send it somewhere" or "copy the key"
$('#purse').onclick = () => { $('#cashout').classList.remove('hidden'); refreshPurse(false); $('#cashstatus').textContent = ''; };
$('#cashclose').onclick = () => $('#cashout').classList.add('hidden');
$('#cashkey').onclick = async () => { try { await navigator.clipboard.writeText(purse.key); $('#cashstatus').textContent = 'copied. keep it somewhere safe.'; } catch { prompt('your secret key', purse.key); } };
$('#cashsend').onclick = async () => {
  const to = $('#cashto').value.trim();
  if (!ethers.isAddress(to)) { $('#cashstatus').textContent = 'that does not look like a wallet address.'; return; }
  if (balance <= 0) { $('#cashstatus').textContent = 'nothing to send yet.'; return; }
  $('#cashstatus').textContent = 'sending…'; $('#cashsend').disabled = true;
  try {
    const provider = new ethers.JsonRpcProvider('https://rpc.moderato.tempo.xyz', 42431);
    const signer = new ethers.Wallet(purse.key, provider);
    const token = new ethers.Contract('0x20c0000000000000000000000000000000000000', ['function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)'], signer);
    const raw = await token.balanceOf(purse.address);
    const tx = await token.transfer(to, raw);
    await tx.wait();
    $('#cashstatus').textContent = 'sent.'; refreshPurse(false);
  } catch (e) { $('#cashstatus').textContent = 'could not send: ' + (e.shortMessage || e.message); }
  $('#cashsend').disabled = false;
};

loadState().then(() => refreshPurse(false)); showTurns();
