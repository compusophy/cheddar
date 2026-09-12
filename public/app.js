const $ = (s) => document.querySelector(s);
const api = async (path, opts) => {
  const r = await fetch('/api' + path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const j = await r.json().catch(() => ({ error: 'bad response' }));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const short = (a) => a ? a.slice(0, 6) + '…' + a.slice(-4) : '';

let state = null, session = null;
let tier = 1;
try { tier = Number(localStorage.getItem('tier')) || 1; } catch {}
let evoTier = tier;

// views
document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('nav button').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('hidden', v.id !== b.dataset.view));
  if (b.dataset.view === 'evolution') loadGens();
  if (b.dataset.view === 'breaches') loadBreaches();
  if (b.dataset.view === 'board') loadBoard();
  if (b.dataset.view === 'findings') loadFindings();
}));

function renderLadder(tiers, selected, onPick, el) {
  el.innerHTML = tiers.map((t) => `
    <button class="rung ${t.tier === selected ? 'active' : ''}" data-tier="${t.tier}">
      <span class="rung-name">${esc(t.name)}</span>
      <span class="rung-meta">gen ${t.gen} · ${t.breaches} breach${t.breaches === 1 ? '' : 'es'} · ${t.stolen.toFixed(2)} stolen</span>
      <span class="rung-tag">${esc(t.tagline)}</span>
    </button>`).join('');
  el.querySelectorAll('.rung').forEach((r) => r.addEventListener('click', () => onPick(Number(r.dataset.tier))));
}

async function loadState() {
  state = await api('/state?tier=' + tier);
  renderLadder(state.tiers, tier, (t) => { if (session) return; tier = t; try { localStorage.setItem('tier', t); } catch {} loadState(); }, $('#ladder'));
  $('#policy').textContent = state.policy;
  $('#msg').placeholder = state.tools === 'pay+lookup'
    ? 'you are talking to the shop\'s treasurer. it can pay, and it can look up the shop\'s books.'
    : 'you are talking to the shop\'s treasurer. it can call pay(to, amount). everything it knows is in its policy.';
  $('#status').innerHTML = state.hardening
    ? `${esc(state.tier_name)} · generation <b>${state.gen}</b> was just robbed. the treasurer is hardening its policy… <span class="dim">(refreshes automatically)</span>`
    : `${esc(state.tier_name)} · generation <b>${state.gen}</b> · treasurer holds <b>${Number(state.balance).toFixed(2)} pathusd</b> on tempo · ${state.max_turns} turns · ${state.max_pay} pathusd max per pay` +
      (state.tier === 3 ? ` · ${state.spent_24h.toFixed(2)} / ${state.daily_cap} daily cap used` : '');
  $('#wallet').textContent = `treasurer: ${state.agent} · model: ${state.model} · tempo moderato (42431)`;
  if (state.hardening) setTimeout(loadState, 5000);
}

// session
try { $('#player').value = localStorage.getItem('player') || ''; $('#nick').value = localStorage.getItem('nick') || ''; } catch {}
$('#start').addEventListener('click', async () => {
  try {
    const player = $('#player').value.trim(), nickname = $('#nick').value.trim();
    try { localStorage.setItem('player', player); localStorage.setItem('nick', nickname); } catch {}
    const r = await api('/session', { method: 'POST', body: JSON.stringify({ player, nickname, tier }) });
    session = { id: r.session, gen: r.gen, tier: r.tier, turnsLeft: state.max_turns };
    $('#log').innerHTML = '';
    addTurn({ role: 'system', text: `session opened on ${state.tier_name}, generation ${r.gen}. the treasurer is listening.` });
    $('#setup').classList.add('hidden'); $('#chat').classList.remove('hidden'); $('#newsession').classList.add('hidden');
    $('#form').classList.remove('hidden');
    updateTurns();
    $('#msg').focus();
  } catch (e) { alert(e.message); }
});
$('#newsession').addEventListener('click', () => { session = null; $('#chat').classList.add('hidden'); $('#setup').classList.remove('hidden'); loadState(); });

function updateTurns() { $('#turns').textContent = `${session.turnsLeft} turn${session.turnsLeft === 1 ? '' : 's'} left`; }

function addTurn(t) {
  const d = document.createElement('div');
  if (t.role === 'user') { d.className = 'turn user'; d.innerHTML = `<span class="who">you:</span> ${esc(t.text)}`; }
  else if (t.role === 'agent') { d.className = 'turn agent'; d.innerHTML = `<span class="who">treasurer:</span> ${esc(t.text)}`; }
  else if (t.role === 'tool' && t.name === 'lookup_po') {
    d.className = 'turn tool lookup';
    d.textContent = `lookup(${t.args.po}) → ${JSON.stringify(t.result)}`;
  } else if (t.role === 'tool') {
    const paid = t.result && t.result.ok;
    const approved = state && Object.values(state.approved).some((a) => a.toLowerCase() === (t.args.to || '').toLowerCase());
    d.className = 'turn tool' + (paid && approved ? ' approved' : '') + (!paid ? ' refused' : '');
    d.textContent = `pay(to=${t.args.to}, amount=${t.args.amount}${t.args.reference ? `, reference=${t.args.reference}` : ''}) → ${JSON.stringify(t.result)}`;
  } else { d.className = 'turn system'; d.textContent = t.text; }
  $('#log').appendChild(d); $('#log').scrollTop = $('#log').scrollHeight;
}

$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#msg').value.trim(); if (!msg || !session) return;
  $('#send').disabled = true; $('#msg').value = '';
  try {
    const r = await api('/chat', { method: 'POST', body: JSON.stringify({ session: session.id, message: msg }) });
    r.turns.forEach(addTurn);
    session.turnsLeft = r.turnsLeft; updateTurns();
    if (r.breach) {
      const b = document.createElement('div'); b.className = 'breach-banner';
      b.innerHTML = `breach. the treasurer sent ${r.breach.amount} pathusd to ${esc(r.breach.to)}.` +
        ` <a href="${esc(r.breach.explorer)}" target="_blank" rel="noopener">tx</a>` +
        `<br>generation ${session.gen} is dead. it is now reading your transcript and writing generation ${session.gen + 1}.`;
      $('#log').appendChild(b);
      endSession();
    } else if (r.turnsLeft === 0) { addTurn({ role: 'system', text: 'out of turns. the treasurer held.' }); endSession(); }
  } catch (err) { addTurn({ role: 'system', text: 'error: ' + err.message }); if (/generation changed|hardening/.test(err.message)) endSession(); }
  $('#send').disabled = false; $('#msg').focus();
});
function endSession() { $('#form').classList.add('hidden'); $('#newsession').classList.remove('hidden'); loadState(); }

// evolution
async function loadGens() {
  const { tiers } = await api('/tiers');
  renderLadder(tiers, evoTier, (t) => { evoTier = t; loadGens(); }, $('#evo-tiers'));
  const { generations } = await api('/generations?tier=' + evoTier);
  $('#gens').innerHTML = generations.slice().reverse().map((g) => `
    <div class="gen"><h3>generation ${g.gen}</h3>
      <div class="meta">${g.created_at} · ${g.breaches} breach${g.breaches === 1 ? '' : 'es'}
        ${g.gen > 0 ? `· born from breach #${g.parent_breach_id} after ${g.hardening_rounds} round${g.hardening_rounds === 1 ? '' : 's'}
        <span class="badge ${g.regression_passed ? 'ok' : 'bad'}">regression+secrecy ${g.regression_passed ? 'pass' : 'fail'}</span>
        <span class="badge ${g.legit_passed ? 'ok' : 'bad'}">legit ${g.legit_passed ? 'pass' : 'fail'}</span>` : '· seed'}
      </div>
      <pre>${esc(g.policy)}</pre></div>`).join('');
}

// breaches
async function loadBreaches() {
  const { breaches } = await api('/breaches');
  const explorer = state ? state.explorer : 'https://explore.moderato.tempo.xyz';
  $('#breachlist').innerHTML = breaches.length ? breaches.slice().reverse().map((b) => `
    <div class="breach"><h3>breach #${b.id} · tier ${b.tier} · generation ${b.gen}</h3>
      <div class="meta">${b.created_at} · by ${esc(b.nickname || short(b.player))} · ${b.amount} pathusd → ${esc(b.recipient)}
        ${b.tx_hash ? `· <a href="${explorer}/tx/${b.tx_hash}" target="_blank" rel="noopener">tx</a>` : '· adjudicated'}
        ${b.autoimmune ? '<span class="badge auto">autoimmune</span>' : ''}</div>
      <pre>${b.transcript.map((t) => t.role === 'user' ? 'you: ' + esc(t.text) : t.role === 'agent' ? 'treasurer: ' + esc(t.text) : t.name === 'lookup_po' ? `lookup(${esc(t.args.po)}) → ${esc(JSON.stringify(t.result))}` : `pay(${esc(t.args.to)}, ${t.args.amount}${t.args.reference ? ', ' + esc(t.args.reference) : ''}) → ${esc(JSON.stringify(t.result))}`).join('\n\n')}</pre></div>`).join('')
    : '<p class="hint">nobody has robbed it yet.</p>';
}

// leaderboard
async function loadBoard() {
  const { leaderboard } = await api('/leaderboard');
  $('#boardtable tbody').innerHTML = leaderboard.map((r) => `<tr><td>${esc(r.nickname || short(r.player))}</td><td>${r.highest_tier}</td><td>${r.breaches}</td><td>${r.highest_gen}</td><td>${Number(r.stolen).toFixed(2)}</td></tr>`).join('') || '<tr><td colspan="5" class="hint">empty</td></tr>';
}

// findings
let findingsLoaded = false;
async function loadFindings() {
  if (findingsLoaded) return;
  const md = await (await fetch('/api/findings')).text();
  $('#findings-body').innerHTML = window.marked ? marked.parse(md) : `<pre>${esc(md)}</pre>`;
  findingsLoaded = true;
}

loadState();
