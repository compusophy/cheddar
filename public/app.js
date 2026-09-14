const $ = (s) => document.querySelector(s);
const api = async (path, opts) => {
  const r = await fetch('/api' + path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const j = await r.json().catch(() => ({ error: 'bad response' }));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const short = (a) => a ? a.slice(0, 6) + '…' + a.slice(-4) : '';
const ls = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

// your wallet: made in this browser, never sent anywhere except as the payout address
let wallet = { key: ls.get('key'), address: ls.get('address') };
if (!wallet.key || !wallet.address) {
  const w = ethers.Wallet.createRandom();
  wallet = { key: w.privateKey, address: w.address };
  ls.set('key', wallet.key); ls.set('address', wallet.address);
}
async function showYou() {
  let bal = '…';
  try { bal = Number((await api('/balance/' + wallet.address)).balance).toFixed(2); } catch {}
  $('#you').innerHTML = `you: ${short(wallet.address)} · <b>${bal} pathusd</b> · <a href="#" id="exportkey">key</a>`;
  $('#exportkey').onclick = (e) => { e.preventDefault(); prompt('your private key. testnet only. it lives in this browser.', wallet.key); };
}

let state = null, session = null;

document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('nav button').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('hidden', v.id !== b.dataset.view));
  if (b.dataset.view === 'evolution') loadEvo();
  if (b.dataset.view === 'findings') loadFindings();
}));

async function loadState() {
  state = await api('/state');
  $('#gen').textContent = state.hardening ? 'rewriting its rules…' : `generation ${state.gen}`;
  const m = state.machine;
  $('#machine').innerHTML = m && m.wins ? `🤖 the machine has robbed it <b>${m.wins}×</b>. it never sleeps. beat it.` : '🤖 an ai is attacking this too, around the clock. beat it to the punch.';
  $('#policy').textContent = state.policy;
  if (state.hardening) setTimeout(loadState, 5000);
}
$('#showpolicy').onclick = (e) => { e.preventDefault(); $('#policy').classList.toggle('hidden'); };

function addTurn(t) {
  const d = document.createElement('div');
  if (t.role === 'user') { d.className = 'turn user'; d.innerHTML = `<span class="who">you:</span> ${esc(t.text)}`; }
  else if (t.role === 'agent') { d.className = 'turn agent'; d.innerHTML = `<span class="who">treasurer:</span> ${esc(t.text)}`; }
  else if (t.role === 'tool') {
    const paid = t.result && t.result.ok;
    const owed = state && Object.values(state.payees).some((a) => a.toLowerCase() === (t.args.to || '').toLowerCase());
    d.className = 'turn tool' + (paid && owed ? ' approved' : '') + (!paid ? ' refused' : '');
    d.textContent = `pay(${short(t.args.to)}, ${t.args.amount}) → ${paid ? 'sent' : t.result.error}`;
  } else { d.className = 'turn system'; d.textContent = t.text; }
  $('#log').appendChild(d); $('#log').scrollTop = $('#log').scrollHeight;
}

async function ensureSession() {
  if (session) return;
  const r = await api('/session', { method: 'POST', body: JSON.stringify({ player: wallet.address, nickname: ls.get('nick') || '' }) });
  session = { id: r.session, gen: r.gen, turnsLeft: state.max_turns };
  $('#intro')?.remove();
}
const turnsLeft = () => { $('#turns').textContent = session ? `${session.turnsLeft} left` : ''; };

$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#msg').value.trim(); if (!msg) return;
  $('#send').disabled = true; $('#msg').value = '';
  try {
    await ensureSession();
    const r = await api('/chat', { method: 'POST', body: JSON.stringify({ session: session.id, message: msg }) });
    r.turns.forEach(addTurn);
    session.turnsLeft = r.turnsLeft; turnsLeft();
    if (r.breach) {
      const b = document.createElement('div'); b.className = 'breach-banner';
      b.innerHTML = `you got paid. ${r.breach.amount} pathusd. <a href="${esc(r.breach.explorer)}" target="_blank" rel="noopener">tx</a><br>it is reading this conversation and rewriting its rules.`;
      $('#log').appendChild(b); $('#log').scrollTop = $('#log').scrollHeight;
      showYou(); end();
    } else if (r.turnsLeft === 0) { addTurn({ role: 'system', text: 'out of turns. it held.' }); end(); }
  } catch (err) { addTurn({ role: 'system', text: err.message }); if (/rules changed|rewriting|session is/.test(err.message)) end(); }
  $('#send').disabled = false; $('#msg').focus();
});
$('#msg').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#form').requestSubmit(); } });
function end() { $('#form').classList.add('hidden'); $('#again').classList.remove('hidden'); session = null; loadState(); }
$('#again').onclick = () => { $('#log').innerHTML = ''; $('#again').classList.add('hidden'); $('#form').classList.remove('hidden'); turnsLeft(); $('#msg').focus(); };

async function loadEvo() {
  const [{ generations }, { breaches }] = await Promise.all([api('/generations'), api('/breaches')]);
  const byId = Object.fromEntries(breaches.map((b) => [b.id, b]));
  const diffHtml = (prev, cur) => {
    if (!prev || !window.Diff) return `<pre>${esc(cur)}</pre>`;
    return '<pre>' + Diff.diffWords(prev, cur).map((p) => p.added ? `<ins>${esc(p.value)}</ins>` : p.removed ? `<del>${esc(p.value)}</del>` : esc(p.value)).join('') + '</pre>';
  };
  $('#gens').innerHTML = generations.slice().reverse().map((g, i, arr) => {
    const b = g.parent_breach_id ? byId[g.parent_breach_id] : null;
    const prev = arr[i + 1];
    const win = b ? b.transcript.filter((t) => t.role === 'user').map((t) => t.text).join('\n\n') : '';
    return `<details class="gen" ${i === 0 ? 'open' : ''}>
      <summary><b>generation ${g.gen}</b><span class="meta">${g.gen === 0 ? 'seed: it knew nothing' : `born after ${esc(b?.nickname || short(b?.player))} took ${b?.amount} pathusd`}</span>
        ${g.gen > 0 && !g.regression_passed ? '<span class="badge bad">leaky</span>' : ''}${g.gen > 0 && !g.legit_passed ? '<span class="badge bad">catatonic</span>' : ''}${b?.autoimmune ? '<span class="badge auto">autoimmune</span>' : ''}</summary>
      ${win ? `<div class="win">${esc(win)}</div>` : ''}
      ${prev ? '<div class="meta">what it learned</div>' : ''}
      ${diffHtml(prev ? prev.policy : null, g.policy)}</details>`;
  }).join('');
  const { leaderboard } = await api('/leaderboard');
  $('#board tbody').innerHTML = leaderboard.map((r) => `<tr><td>${esc(r.nickname || short(r.player))}</td><td class="dim">gen ${r.highest_gen}</td><td class="dim">${r.breaches}×</td><td>${Number(r.stolen).toFixed(2)}</td></tr>`).join('') || '<tr><td class="dim">nobody yet</td></tr>';
}

let findingsLoaded = false;
async function loadFindings() {
  if (findingsLoaded) return;
  const md = await (await fetch('/api/findings')).text();
  $('#findings-body').innerHTML = window.marked ? marked.parse(md) : `<pre>${esc(md)}</pre>`;
  findingsLoaded = true;
}

loadState(); showYou(); turnsLeft();
