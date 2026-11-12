/** storage. postgres on neon; the site runs on vercel functions with no disk and no long-lived process. */
import postgres from 'postgres';
import { GEN0, DAILY_CAP, JACKPOT_SEED } from './game';
import { net, flag } from './net';

const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!url) throw new Error('[db] DATABASE_URL missing');
// onnotice: neon emits 'relation already exists' NOTICEs on every cold start from CREATE TABLE IF NOT EXISTS
// DB_POOL: connections per instance. 1 for a local single-session database such as pglite.
export const sql = postgres(url, { max: Math.max(1, Number(process.env.DB_POOL) || 5), idle_timeout: 20, prepare: false, onnotice: () => {} });

/**
 * a counter that moves whenever something a visitor can see changes here: the pot, the generation,
 * whether it is learning. the page asks for the game's state every few seconds, for every visitor;
 * with this the answer can be kept and handed out again until one of those things has changed.
 */
let changes = 0;
export const stamp = () => changes;
const touch = () => { changes++; };

let ready: Promise<void> | null = null;
export function init(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    await sql`CREATE TABLE IF NOT EXISTS generations (
      id SERIAL PRIMARY KEY, gen INT NOT NULL UNIQUE, policy TEXT NOT NULL,
      parent_breach_id INT, hardening_rounds INT NOT NULL DEFAULT 0,
      regression_passed INT NOT NULL DEFAULT 1, legit_passed INT NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT now())`;
    await sql`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, gen INT NOT NULL, player TEXT NOT NULL, nickname TEXT,
      transcript TEXT NOT NULL, turns INT NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'open',
      created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now())`;
    await sql`CREATE TABLE IF NOT EXISTS breaches (
      id SERIAL PRIMARY KEY, gen INT NOT NULL, session_id TEXT NOT NULL,
      player TEXT NOT NULL, nickname TEXT, recipient TEXT NOT NULL, amount DOUBLE PRECISION NOT NULL,
      tx_hash TEXT, transcript TEXT NOT NULL, autoimmune INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT now())`;
    await sql`CREATE TABLE IF NOT EXISTS disbursements (
      id SERIAL PRIMARY KEY, recipient TEXT NOT NULL, amount DOUBLE PRECISION NOT NULL,
      tx_hash TEXT, session_id TEXT, created_at TIMESTAMPTZ DEFAULT now())`;
    await sql`CREATE TABLE IF NOT EXISTS regression_runs (
      id SERIAL PRIMARY KEY, candidate_gen INT NOT NULL, round INT NOT NULL,
      breach_id INT, kind TEXT NOT NULL, passed INT NOT NULL, detail TEXT, created_at TIMESTAMPTZ DEFAULT now())`;
    await sql`CREATE TABLE IF NOT EXISTS locks (name TEXT PRIMARY KEY, holder TEXT, taken_at TIMESTAMPTZ DEFAULT now())`;
    await sql`CREATE TABLE IF NOT EXISTS rate_hits (id SERIAL PRIMARY KEY, bucket TEXT NOT NULL, at TIMESTAMPTZ DEFAULT now())`;
    await sql`CREATE INDEX IF NOT EXISTS rate_hits_bucket_at ON rate_hits (bucket, at)`;
    await sql`CREATE TABLE IF NOT EXISTS stakes (
      id SERIAL PRIMARY KEY, session_id TEXT NOT NULL, player TEXT NOT NULL, amount DOUBLE PRECISION NOT NULL,
      tx_hash TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now())`;
    await sql`CREATE TABLE IF NOT EXISTS jackpot (id INT PRIMARY KEY DEFAULT 1, amount DOUBLE PRECISION NOT NULL)`;
    await sql`INSERT INTO jackpot (id, amount) VALUES (1, ${JACKPOT_SEED}) ON CONFLICT DO NOTHING`;
    await sql`ALTER TABLE breaches ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ`;
    // how much of a win has left the house so far. a prize bigger than a daily cap is paid in parts.
    await sql`ALTER TABLE breaches ADD COLUMN IF NOT EXISTS paid DOUBLE PRECISION NOT NULL DEFAULT 0`;
    await sql`ALTER TABLE generations ADD COLUMN IF NOT EXISTS lesson TEXT`;
    // one message at a time in a game: set while a reply is being produced, cleared when it is done.
    await sql`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS busy_until TIMESTAMPTZ`;
    // the win that took the pot for its generation. there is at most one per generation.
    await sql`ALTER TABLE breaches ADD COLUMN IF NOT EXISTS took_pot INT NOT NULL DEFAULT 0`;
    // a payment towards a win: which win, the moment after which its transaction can never land, and
    // whether the chain has confirmed it. a row with a hash and no confirmation is a payment in flight.
    await sql`ALTER TABLE disbursements ADD COLUMN IF NOT EXISTS win_id INT`;
    await sql`ALTER TABLE disbursements ADD COLUMN IF NOT EXISTS valid_before BIGINT`;
    await sql`ALTER TABLE disbursements ADD COLUMN IF NOT EXISTS confirmed INT NOT NULL DEFAULT 0`;
    // how many times a lesson has been started for this win. one that keeps failing to finish is cut down.
    await sql`ALTER TABLE breaches ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0`;
    // every thought the ai paid for: what it was for, which model, what it cost, and the payment that bought it.
    await sql`CREATE TABLE IF NOT EXISTS thoughts (
      id SERIAL PRIMARY KEY, purpose TEXT NOT NULL, model TEXT NOT NULL, amount DOUBLE PRECISION NOT NULL,
      tx_hash TEXT, created_at TIMESTAMPTZ DEFAULT now())`;
    await sql`CREATE INDEX IF NOT EXISTS thoughts_at ON thoughts (created_at)`;
    // a stake can arrive as a machine payment (an agent paying over http 402) instead of a purse transfer.
    await sql`ALTER TABLE stakes ADD COLUMN IF NOT EXISTS via TEXT`;
    // a machine payment that has been taken, written down the moment it is, before the game is opened:
    // which payment, by what proof (a fingerprint of the credential, never the credential), and the
    // game it bought once there is one. it is what lets the same request be sent twice and charged once.
    await sql`CREATE TABLE IF NOT EXISTS agent_payments (
      cred TEXT PRIMARY KEY, tx_hash TEXT NOT NULL, payer TEXT, session_id TEXT, created_at TIMESTAMPTZ DEFAULT now())`;
    await sql`INSERT INTO generations (gen, policy) VALUES (0, ${GEN0}) ON CONFLICT DO NOTHING`;
    await belongsHere();
    // a payment opens one game. the code that records a stake enforces it; this index is the second
    // lock on the same door. it is not allowed to stop the game starting: a table that already holds
    // a duplicate from before the rule existed just goes without it.
    try { await sql`CREATE UNIQUE INDEX IF NOT EXISTS stakes_one_game_per_payment ON stakes (lower(tx_hash))`; }
    catch (e) { console.warn('[db] stakes already holds a payment used twice; the unique index was not created:', (e as Error).message); }
  })().catch((e) => { ready = null; throw e; }); // a failed init must not poison the instance
  return ready;
}

/**
 * a ledger belongs to the money it was built with.
 *
 * the pot and every win still owed are plain numbers in this database. built on play money they are
 * play dollars; point the same database at mainnet and they become real debts the house never took
 * in. so the database remembers which network it was started on, and the game will not run on it
 * under the other one. a reset wipes the ledger and the mark with it, so a reset database belongs to
 * whichever network reset it. to move a ledger across with its numbers intact, ALLOW_NETWORK_CHANGE=1
 * lets it through and re-marks it.
 */
async function belongsHere() {
  await sql`CREATE TABLE IF NOT EXISTS ledger_mark (key TEXT PRIMARY KEY, value TEXT NOT NULL)`;
  let home = (await sql<{ value: string }[]>`SELECT value FROM ledger_mark WHERE key = 'network'`)[0]?.value ?? null;
  if (!home) {
    const [seen] = await sql<{ played: boolean }[]>`SELECT (EXISTS (SELECT 1 FROM sessions) OR EXISTS (SELECT 1 FROM stakes) OR EXISTS (SELECT 1 FROM breaches)) AS played`;
    home = ledgerHome(null, !!seen.played, net.name);
    await sql`INSERT INTO ledger_mark (key, value) VALUES ('network', ${home}) ON CONFLICT DO NOTHING`;
  }
  if (home === net.name) return;
  if (flag('ALLOW_NETWORK_CHANGE')) {
    console.warn(`[db] this ledger was built on ${home} and is being moved to ${net.name} because ALLOW_NETWORK_CHANGE is set. its pot and any win it owes come with it.`);
    await sql`UPDATE ledger_mark SET value = ${net.name} WHERE key = 'network'`;
    return;
  }
  throw new Error(`[db] this database was built on ${home} and the game is set to ${net.name}. its pot and the wins it owes are ${home} money: running on ${net.name} would turn them into ${net.real ? 'real debts' : 'play money'}. use a fresh database, wipe this one (npm run reset), or set ALLOW_NETWORK_CHANGE=1 if you mean to move it as it is.`);
}
/**
 * the network a ledger belongs to. one that carries a mark belongs where the mark says. one with no
 * mark and no games in it is new, and belongs to whoever is starting it. one with no mark but games
 * already played is older than the mark, and nothing that old ever ran on real money: it is play money.
 */
export function ledgerHome(mark: string | null, played: boolean, starting: string): string {
  return mark ?? (played ? 'testnet' : starting);
}
/** a reset touches real money when the game is set to it, or when the ledger was built on it. either way it takes ALLOW_RESET. */
export const resetIsGuarded = (real: boolean, home: string | null) => real || home === 'mainnet';

// ---------- the daily cap: the one rule that lives in code ----------

export async function spentLast24h(): Promise<number> {
  const [r] = await sql<{ total: number }[]>`SELECT COALESCE(SUM(amount), 0)::float AS total FROM disbursements WHERE created_at > now() - interval '1 day'`;
  return Number(r.total);
}
export const clearDisbursementWindow = () => sql`DELETE FROM disbursements`;

/** reserve headroom BEFORE the transfer, in one transaction with the table locked, so concurrent functions cannot both spend the same allowance. */
export async function reserveDisbursement(recipient: string, amount: number, sessionId: string | null): Promise<{ ok: true; id: number } | { ok: false; remaining: number }> {
  return sql.begin(async (tx) => {
    await tx`LOCK TABLE disbursements IN SHARE ROW EXCLUSIVE MODE`;
    const [r] = await tx<{ total: number }[]>`SELECT COALESCE(SUM(amount), 0)::float AS total FROM disbursements WHERE created_at > now() - interval '1 day'`;
    const remaining = DAILY_CAP - Number(r.total);
    if (amount > remaining) return { ok: false as const, remaining };
    const [row] = await tx<{ id: number }[]>`INSERT INTO disbursements (recipient, amount, tx_hash, session_id) VALUES (${recipient.toLowerCase()}, ${amount}, NULL, ${sessionId}) RETURNING id`;
    return { ok: true as const, id: row.id };
  }) as any;
}
/**
 * reserve as much of `want` as both caps allow right now: the house's daily cap and this purse's.
 * a prize can be bigger than a cap (the pot has no ceiling, the caps do), and a reservation that is
 * all-or-nothing would leave such a prize unpayable for ever. this one grants a part and says how much;
 * the rest stays owed and is paid as the window rolls. less than a cent of headroom is not worth a
 * transfer, unless a cent is more than what is owed.
 */
export async function reserveUpTo(recipient: string, want: number, purseCap: number, sessionId: string | null, winId: number | null = null): Promise<{ ok: true; id: number; amount: number } | { ok: false; why: string }> {
  const who = recipient.toLowerCase();
  return sql.begin(async (tx) => {
    await tx`LOCK TABLE disbursements IN SHARE ROW EXCLUSIVE MODE`;
    const [g] = await tx<{ total: number }[]>`SELECT COALESCE(SUM(amount), 0)::float AS total FROM disbursements WHERE created_at > now() - interval '1 day'`;
    const [p] = await tx<{ total: number }[]>`SELECT COALESCE(SUM(amount), 0)::float AS total FROM disbursements WHERE recipient = ${who} AND created_at > now() - interval '1 day'`;
    const house = DAILY_CAP - Number(g.total), purse = purseCap - Number(p.total);
    const amount = Math.floor(Math.min(want, house, purse) * 1e6 + 1e-6) / 1e6;
    if (!(amount > 0) || amount < Math.min(want, 0.01) - 1e-9) return { ok: false as const, why: house <= purse ? 'daily cap' : 'purse daily cap' };
    const [row] = await tx<{ id: number }[]>`INSERT INTO disbursements (recipient, amount, tx_hash, session_id, win_id) VALUES (${who}, ${amount}, NULL, ${sessionId}, ${winId}) RETURNING id`;
    return { ok: true as const, id: row.id, amount };
  }) as any;
}
/** the payment has been signed: its hash and its limit are written down before it is sent anywhere. */
export const signedReservation = (id: number, txHash: string, validBefore: number) => sql`UPDATE disbursements SET tx_hash = ${txHash}, valid_before = ${validBefore} WHERE id = ${id}`;
/** the chain has confirmed it. */
export const settleReservation = (id: number, txHash: string) => sql`UPDATE disbursements SET tx_hash = ${txHash}, confirmed = 1 WHERE id = ${id}`;
/** payments towards a win that were signed and have not been confirmed or given up on: in flight. */
export const paymentsInFlight = (winId: number) => sql<{ id: number; amount: number; tx_hash: string; valid_before: string | null }[]>`
  SELECT id, amount, tx_hash, valid_before FROM disbursements WHERE win_id = ${winId} AND tx_hash IS NOT NULL AND confirmed = 0 ORDER BY id ASC`;
export const releaseReservation = (id: number) => sql`DELETE FROM disbursements WHERE id = ${id}`;
/** a payment towards this win was set aside or sent in the last couple of minutes and has not been confirmed yet. */
export const paymentPending = async (winId: number) =>
  (await sql`SELECT 1 FROM disbursements WHERE win_id = ${winId} AND confirmed = 0 AND created_at > now() - interval '2 minutes' LIMIT 1`).length > 0;
/** the payments that have landed towards one win, oldest first. a prize bigger than a daily cap has more than one. */
export const paymentsFor = (winId: number) => sql<{ amount: number; tx_hash: string; created_at: Date }[]>`
  SELECT amount, tx_hash, created_at FROM disbursements WHERE win_id = ${winId} AND confirmed = 1 AND tx_hash IS NOT NULL ORDER BY id ASC`;
/**
 * when the house can next pay this purse anything. both caps count a rolling day, so room comes back
 * as old payments turn a day old. `at` is null when there is room now; `held` names the cap in the way.
 */
export async function payableAt(recipient: string, purseCap: number): Promise<{ at: Date | null; held: 'purse daily cap' | 'daily cap' | null }> {
  const who = recipient.toLowerCase();
  const day = await sql<{ amount: number; at: Date; recipient: string }[]>`
    SELECT amount, created_at AS at, recipient FROM disbursements WHERE created_at > now() - interval '1 day' ORDER BY created_at, id`;
  const house = freesAt(day, DAILY_CAP, 0.01), purse = freesAt(day.filter((d) => d.recipient === who), purseCap, 0.01);
  if (!house && !purse) return { at: null, held: null };
  return (purse?.getTime() ?? 0) >= (house?.getTime() ?? 0) ? { at: purse, held: 'purse daily cap' } : { at: house, held: 'daily cap' };
}
/** what the house still owes one purse, across all its wins. */
export const owedTo = async (player: string) =>
  Number((await sql<{ t: number }[]>`SELECT COALESCE(SUM(amount - paid),0)::float AS t FROM breaches WHERE lower(player) = ${player.toLowerCase()} AND tx_hash IS NULL AND amount > 0`)[0].t);

// ---------- thinking money: the ai pays for its own inference, one payment per thought ----------

/**
 * set aside the price of one thought before paying for it, so two functions cannot both spend the
 * last of the day's allowance. `cap` is the whole house's limit; `purposeCap` is a tighter one for a
 * single purpose (the machine has its own pocket money). returns the row to settle, or why not.
 */
export async function reserveThought(purpose: string, model: string, amount: number, cap: number, purposeCap?: number): Promise<{ ok: true; id: number } | { ok: false; why: string }> {
  return sql.begin(async (tx) => {
    await tx`LOCK TABLE thoughts IN SHARE ROW EXCLUSIVE MODE`;
    const [g] = await tx<{ total: number }[]>`SELECT COALESCE(SUM(amount), 0)::float AS total FROM thoughts WHERE created_at > now() - interval '1 day'`;
    if (Number(g.total) + amount > cap + 1e-9) return { ok: false as const, why: "today's thinking budget is spent" };
    if (purposeCap !== undefined) {
      const [p] = await tx<{ total: number }[]>`SELECT COALESCE(SUM(amount), 0)::float AS total FROM thoughts WHERE purpose = ${purpose} AND created_at > now() - interval '1 day'`;
      if (Number(p.total) + amount > purposeCap + 1e-9) return { ok: false as const, why: `today's ${purpose} budget is spent` };
    }
    const [row] = await tx<{ id: number }[]>`INSERT INTO thoughts (purpose, model, amount) VALUES (${purpose}, ${model}, ${amount}) RETURNING id`;
    return { ok: true as const, id: row.id };
  }) as any;
}
export const settleThought = (id: number, txHash: string | null) => sql`UPDATE thoughts SET tx_hash = ${txHash} WHERE id = ${id}`;
export const releaseThought = (id: number) => sql`DELETE FROM thoughts WHERE id = ${id}`;
export const thoughtSpent24h = async (purpose?: string) => Number((purpose
  ? await sql<{ t: number }[]>`SELECT COALESCE(SUM(amount),0)::float AS t FROM thoughts WHERE purpose = ${purpose} AND created_at > now() - interval '1 day'`
  : await sql<{ t: number }[]>`SELECT COALESCE(SUM(amount),0)::float AS t FROM thoughts WHERE created_at > now() - interval '1 day'`)[0].t);
/** everything the machine has cost today: its own games and the lessons its wins set off. */
export const machineSpent24h = async () => Number((await sql<{ t: number }[]>`SELECT COALESCE(SUM(amount),0)::float AS t FROM thoughts WHERE purpose IN ('machine', 'machine-lesson') AND created_at > now() - interval '1 day'`)[0].t);
/**
 * when the day's thinking budget will have room again. the budget is whatever was spent in the last
 * 24 hours, so it frees up as old thoughts pass out of that window: this finds the moment enough of
 * them have for `room` dollars to be spendable again. `spent` is the last day's thoughts, oldest
 * first. null when there is room already.
 */
export function freesAt(spent: { amount: number; at: Date }[], cap: number, room: number): Date | null {
  let left = spent.reduce((t, x) => t + Number(x.amount), 0);
  if (left + room <= cap + 1e-9) return null;
  for (const x of spent) {
    left -= Number(x.amount);
    if (left + room <= cap + 1e-9) return new Date(new Date(x.at).getTime() + 24 * 3600_000);
  }
  return null; // room is more than the whole budget: it never frees
}
export const thinkingFreesAt = async (cap: number, room: number) =>
  freesAt(await sql<{ amount: number; at: Date }[]>`SELECT amount, created_at AS at FROM thoughts WHERE created_at > now() - interval '1 day' ORDER BY created_at, id`, cap, room);
/** what thinking has cost, by purpose. */
export async function thoughtBooks() {
  const rows = await sql<any[]>`SELECT purpose, COUNT(*)::int AS n, COALESCE(SUM(amount),0)::float AS spent,
    COALESCE(SUM(CASE WHEN created_at > now() - interval '1 day' THEN amount ELSE 0 END),0)::float AS spent_24h FROM thoughts GROUP BY purpose ORDER BY purpose`;
  const total = rows.reduce((a, r) => a + Number(r.spent), 0), day = rows.reduce((a, r) => a + Number(r.spent_24h), 0), n = rows.reduce((a, r) => a + r.n, 0);
  return { thoughts: n, spent: Math.round(total * 1e6) / 1e6, spent_24h: Math.round(day * 1e6) / 1e6, by_purpose: rows.map((r) => ({ purpose: r.purpose, thoughts: r.n, spent: Number(r.spent), spent_24h: Number(r.spent_24h) })) };
}
/** the last few payments the ai made for its own thoughts, newest first. public: they are on chain anyway. */
export const recentThoughts = (limit = 12) => sql<{ purpose: string; model: string; amount: number; tx_hash: string | null; created_at: string }[]>`
  SELECT purpose, model, amount, tx_hash, created_at FROM thoughts WHERE tx_hash IS NOT NULL ORDER BY id DESC LIMIT ${limit}`;

// ---------- the jackpot ----------

/** the pot, to the millionth of a dollar: sums of binary floats are not shown to people. */
export const jackpot = async () => Math.round(Number((await sql<{ amount: number }[]>`SELECT amount FROM jackpot WHERE id = 1`)[0]?.amount ?? 0) * 1e6) / 1e6;
/**
 * a payment opens one game, once.
 *
 * the check "has this payment been used?" and the write that uses it have to be one step. apart,
 * the same payment sent several times at the same moment passed the check every time: eight
 * requests, eight games, and a pot grown by eight stakes the house never received. so the table is
 * locked for the length of the step, and the hash is compared without regard to letter case, because
 * the same transaction can be written 0xAB… or 0xab… and is still the same transaction.
 * returns false when the payment has been used before.
 */
async function useStake(tx: any, sessionId: string, player: string, amount: number, txHash: string, toPot: number, via: string | null): Promise<boolean> {
  await tx`LOCK TABLE stakes IN SHARE ROW EXCLUSIVE MODE`;
  if ((await tx`SELECT 1 FROM stakes WHERE lower(tx_hash) = ${txHash.toLowerCase()} LIMIT 1`).length) return false;
  await tx`INSERT INTO stakes (session_id, player, amount, tx_hash, via) VALUES (${sessionId}, ${player.toLowerCase()}, ${amount}, ${txHash.toLowerCase()}, ${via})`;
  await tx`UPDATE jackpot SET amount = amount + ${toPot} WHERE id = 1`;
  touch();
  return true;
}
/** record a stake and grow the pot. false when that payment was already used. */
export const recordStake = (sessionId: string, player: string, amount: number, txHash: string, toPot: number, via: string | null = null): Promise<boolean> =>
  sql.begin((tx) => useStake(tx, sessionId, player, amount, txHash, toPot, via)) as any;
/**
 * a stake becomes a game: the payment is used, the pot grows and the game is opened, together or not
 * at all. a function that died between them used to leave a stake spent with no game to show for it.
 */
export const openStaked = (o: { sessionId: string; gen: number; player: string; nickname: string | null; amount: number; txHash: string; toPot: number; via: string | null }): Promise<boolean> =>
  sql.begin(async (tx) => {
    if (!(await useStake(tx, o.sessionId, o.player, o.amount, o.txHash, o.toPot, o.via))) return false;
    await tx`INSERT INTO sessions (id, gen, player, nickname, transcript) VALUES (${o.sessionId}, ${o.gen}, ${o.player.toLowerCase()}, ${o.nickname}, '[]')`;
    return true;
  }) as any;
/** take the whole pot for a win and reseed it. returns what was taken. atomic, so two wins cannot both take it. */
export async function claimJackpot(): Promise<number> {
  return sql.begin(async (tx) => {
    const [r] = await tx<{ amount: number }[]>`UPDATE jackpot SET amount = ${JACKPOT_SEED} WHERE id = 1 RETURNING (SELECT amount FROM jackpot WHERE id = 1) AS amount`;
    touch();
    // to the millionth of a dollar, which is the smallest amount the token can move.
    return Math.round(Number(r.amount) * 1e6) / 1e6;
  }) as any;
}
// ---------- carried-over games ----------
// a paid game can be ended by someone else: another player wins, the ai learns, and every game open
// against the old rules is over. the player paid for a number of messages and did not get them, so
// the ones left over are handed back as a new game against the new rules, at no charge. it is given
// once per interrupted game, only for a game that was paid for, and only for the part not yet used.

const CARRY_WHERE = (maxTurns: number) => sql`s.status = 'stale' AND s.turns < ${maxTurns} AND s.updated_at > now() - interval '1 day'
  AND EXISTS (SELECT 1 FROM stakes k WHERE k.session_id = s.id)`;
/** is there an interrupted paid game waiting for this player? a read; nothing changes. */
export const carryFor = async (player: string, maxTurns: number) =>
  (await sql<{ id: string; turns: number }[]>`SELECT s.id, s.turns FROM sessions s WHERE s.player = ${player.toLowerCase()} AND ${CARRY_WHERE(maxTurns)} ORDER BY s.updated_at DESC LIMIT 1`)[0] ?? null;
/**
 * take the carry-over, once. the interrupted game is marked as carried and a new one is opened with
 * the same number of messages already counted as used. one statement decides who gets it, so two
 * requests at the same moment cannot both.
 */
export async function takeCarry(by: { player: string } | { sessionId: string }, maxTurns: number, newId: string, gen: number, nickname: string | null): Promise<{ from: string; turns: number; player: string } | null> {
  return sql.begin(async (tx) => {
    const pick = 'player' in by
      ? tx`SELECT s.id FROM sessions s WHERE s.player = ${by.player.toLowerCase()} AND ${CARRY_WHERE(maxTurns)} ORDER BY s.updated_at DESC LIMIT 1`
      : tx`SELECT s.id FROM sessions s WHERE s.id = ${by.sessionId} AND ${CARRY_WHERE(maxTurns)}`;
    const [old] = await tx<{ id: string; turns: number; player: string; nickname: string | null }[]>`
      UPDATE sessions SET status = 'carried', updated_at = now() WHERE id = (${pick}) AND status = 'stale' RETURNING id, turns, player, nickname`;
    if (!old) return null;
    await tx`INSERT INTO sessions (id, gen, player, nickname, transcript, turns) VALUES (${newId}, ${gen}, ${old.player}, ${nickname ?? old.nickname}, '[]', ${old.turns})`;
    // a zero-amount stake row ties the new game to the money that paid for the old one, so the new
    // game can itself be carried over if it is interrupted again. it adds nothing to the pot.
    await tx`INSERT INTO stakes (session_id, player, amount, tx_hash, via) VALUES (${newId}, ${old.player}, 0, ${'carry:' + old.id}, 'carry')`;
    return { from: old.id, turns: old.turns, player: old.player };
  }) as any;
}
export const sessionPaid = async (id: string) => (await sql`SELECT 1 FROM stakes WHERE session_id = ${id} LIMIT 1`).length > 0;

/** one open game per purse at a time: you are either playing or you are not. */
export const openSessionFor = async (player: string) =>
  (await sql<SessionRow[]>`SELECT * FROM sessions WHERE player = ${player.toLowerCase()} AND status = 'open' AND updated_at > now() - interval '30 minutes' ORDER BY updated_at DESC LIMIT 1`)[0];
export const hasOpenSession = async (player: string) => !!(await openSessionFor(player));
/**
 * take this purse's dollar from the house: one a day. true for exactly one caller, however many ask
 * at the same moment: asking "was it given?" and then writing "it was given" as two steps let all of
 * them through. a purse that took one more than a day ago may take another.
 */
export const claimFaucet = async (player: string) =>
  (await sql`INSERT INTO locks (name, holder, taken_at) VALUES (${'faucet-' + player.toLowerCase()}, 'faucet', now())
    ON CONFLICT (name) DO UPDATE SET taken_at = now() WHERE locks.taken_at < now() - interval '1 day' RETURNING name`).length > 0;
/** a dollar that was claimed and then could not be given: the purse may ask again. */
export const unclaimFaucet = (player: string) => sql`DELETE FROM locks WHERE name = ${'faucet-' + player.toLowerCase()} AND holder = 'faucet'`;
/** seconds until this purse may be given another dollar. 0 when it may now. */
export async function faucetWaits(player: string): Promise<number> {
  const [r] = await sql<{ s: number }[]>`SELECT CEIL(EXTRACT(EPOCH FROM (taken_at + interval '1 day' - now())))::int AS s FROM locks WHERE name = ${'faucet-' + player.toLowerCase()}`;
  return Math.max(0, Number(r?.s ?? 0));
}
/** wins paid to one purse in the last day; the per-purse cap stops one player taking every pot in a row. */
export const wonLast24h = async (player: string) =>
  Number((await sql<{ t: number }[]>`SELECT COALESCE(SUM(amount),0)::float AS t FROM breaches WHERE player = ${player.toLowerCase()} AND paid_at > now() - interval '1 day'`)[0].t);
export const stakeSeen = async (txHash: string) => (await sql`SELECT 1 FROM stakes WHERE lower(tx_hash) = ${txHash.toLowerCase()} LIMIT 1`).length > 0;
/** the game a payment bought, if it has bought one. */
export const sessionOfStake = async (txHash: string): Promise<string | null> =>
  (await sql<{ session_id: string }[]>`SELECT session_id FROM stakes WHERE lower(tx_hash) = ${txHash.toLowerCase()} LIMIT 1`)[0]?.session_id ?? null;
/** a machine payment this server has taken, looked up by the fingerprint of the credential that made it. */
export const agentPayment = async (cred: string) =>
  (await sql<{ tx_hash: string; payer: string | null; session_id: string | null }[]>`SELECT tx_hash, payer, session_id FROM agent_payments WHERE cred = ${cred}`)[0];
/** written the moment the payment is taken, before anything else is done with it. */
export const noteAgentPayment = (cred: string, txHash: string, payer: string | null) =>
  sql`INSERT INTO agent_payments (cred, tx_hash, payer) VALUES (${cred}, ${txHash.toLowerCase()}, ${payer ? payer.toLowerCase() : null}) ON CONFLICT (cred) DO NOTHING`;
/** and completed once the game it paid for exists. */
export const seatAgentPayment = (cred: string, sessionId: string) => sql`UPDATE agent_payments SET session_id = ${sessionId} WHERE cred = ${cred}`;
export const markPaid = (winId: number, amount: number, txHash: string) => sql`UPDATE breaches SET amount = ${amount}, paid = ${amount}, tx_hash = ${txHash}, paid_at = now() WHERE id = ${winId}`;
/** one transfer towards a win. the win carries a tx hash only once it is paid in full: that is what "paid" means everywhere else. */
export const addPayment = (winId: number, amount: number, txHash: string) => sql`
  UPDATE breaches SET paid = paid + ${amount}, paid_at = now(),
    tx_hash = CASE WHEN paid + ${amount} >= amount - 0.000001 THEN ${txHash} ELSE tx_hash END
  WHERE id = ${winId}`;
export const stakedLast24h = async () => Number((await sql<{ t: number }[]>`SELECT COALESCE(SUM(amount),0)::float AS t FROM stakes WHERE created_at > now() - interval '1 day'`)[0].t);

// ---------- generations, sessions, breaches ----------

export type Generation = { id: number; gen: number; policy: string; lesson: string | null; parent_breach_id: number | null; hardening_rounds: number; regression_passed: number; legit_passed: number; created_at: string };
export type Breach = { id: number; gen: number; session_id: string; player: string; nickname: string | null; recipient: string; amount: number; paid?: number; tx_hash: string | null; transcript: string; autoimmune: number; created_at: string };
export type SessionRow = { id: string; gen: number; player: string; nickname: string | null; transcript: string; turns: number; status: string; created_at: string; updated_at: string };

export const currentGeneration = async () => (await sql<Generation[]>`SELECT * FROM generations ORDER BY gen DESC LIMIT 1`)[0];
export const getGeneration = async (gen: number) => (await sql<Generation[]>`SELECT * FROM generations WHERE gen = ${gen}`)[0];
export const allGenerations = () => sql<Generation[]>`SELECT * FROM generations ORDER BY gen ASC`;
export const createGeneration = (gen: number, policy: string, parentBreachId: number, rounds: number, regressionPassed: boolean, legitPassed: boolean, lesson: string | null) =>
  (touch(), sql`INSERT INTO generations (gen, policy, parent_breach_id, hardening_rounds, regression_passed, legit_passed, lesson)
      VALUES (${gen}, ${policy}, ${parentBreachId}, ${rounds}, ${regressionPassed ? 1 : 0}, ${legitPassed ? 1 : 0}, ${lesson}) ON CONFLICT DO NOTHING`.then((r) => (touch(), r)));

export const getSession = async (id: string) => (await sql<SessionRow[]>`SELECT * FROM sessions WHERE id = ${id}`)[0];
export const createSession = (id: string, gen: number, player: string, nickname: string | null) =>
  sql`INSERT INTO sessions (id, gen, player, nickname, transcript) VALUES (${id}, ${gen}, ${player}, ${nickname}, '[]')`;
export const updateSession = (id: string, transcript: unknown[], turns: number, status: string) =>
  sql`UPDATE sessions SET transcript = ${JSON.stringify(transcript)}, turns = ${turns}, status = ${status}, updated_at = now() WHERE id = ${id}`;

export async function recordBreach(b: Omit<Breach, 'id' | 'created_at' | 'autoimmune'>): Promise<number> {
  const [r] = await sql<{ id: number }[]>`INSERT INTO breaches (gen, session_id, player, nickname, recipient, amount, tx_hash, transcript)
    VALUES (${b.gen}, ${b.session_id}, ${b.player}, ${b.nickname}, ${b.recipient}, ${b.amount}, ${b.tx_hash}, ${b.transcript}) RETURNING id`;
  return r.id;
}
/** a lesson is starting for this win. returns how many times one has now been started. */
export const lessonStarted = async (id: number) => Number((await sql<{ attempts: number }[]>`UPDATE breaches SET attempts = attempts + 1 WHERE id = ${id} RETURNING attempts`)[0]?.attempts ?? 1);
/** it stopped for want of money, not for want of time: that start does not count against it. */
export const lessonPaused = (id: number) => sql`UPDATE breaches SET attempts = GREATEST(attempts - 1, 0) WHERE id = ${id}`;
/**
 * one message at a time in a game. without this, several messages sent at the same moment were each
 * answered and together counted as one: more replies than the stake paid for, and a transcript that
 * kept only one of them. the flag is taken before the model is asked and given back after; it also
 * expires by itself, so a function that dies mid-reply cannot lock a game for good.
 */
export const beginTurn = async (id: string) =>
  (await sql`UPDATE sessions SET busy_until = now() + interval '150 seconds' WHERE id = ${id} AND status = 'open' AND (busy_until IS NULL OR busy_until < now()) RETURNING id`).length > 0;
export const endTurn = (id: string) => sql`UPDATE sessions SET busy_until = NULL WHERE id = ${id}`;

/**
 * a win, recorded in one step: the pot is taken, the game is closed and the win is written down
 * together or not at all. done apart, a function dying between them could empty the pot with no win
 * on record.
 *
 * winners are let through one at a time, and only the first paying player to beat a generation takes
 * its pot. several games can be mid-reply at the moment one of them wins; if each later one also
 * "took the pot", each would collect the fresh seed, and a player with one working trick and many
 * purses could farm it. a later winner is told the truth: someone beat it a moment before. their
 * game is treated as interrupted, so the messages they had left carry over. the machine never takes
 * the pot and never stands in a player's way.
 */
export async function recordWin(o: { gen: number; sessionId: string; player: string; nickname: string | null; transcript: unknown[]; turns: number; paying: boolean }): Promise<{ winId: number; prize: number; late: boolean }> {
  return sql.begin(async (tx) => {
    const [pot] = await tx<{ amount: number }[]>`SELECT amount FROM jackpot WHERE id = 1 FOR UPDATE`;
    const already = o.paying && (await tx`SELECT 1 FROM breaches WHERE gen = ${o.gen} AND took_pot = 1 LIMIT 1`).length > 0;
    const takes = o.paying && !already;
    const prize = takes ? Math.round(Number(pot.amount) * 1e6) / 1e6 : 0;
    if (takes) await tx`UPDATE jackpot SET amount = ${JACKPOT_SEED} WHERE id = 1`;
    const text = JSON.stringify(o.transcript);
    await tx`UPDATE sessions SET transcript = ${text}, turns = ${o.turns}, status = ${already ? 'stale' : 'won'}, busy_until = NULL, updated_at = now() WHERE id = ${o.sessionId}`;
    const [r] = await tx<{ id: number }[]>`INSERT INTO breaches (gen, session_id, player, nickname, recipient, amount, tx_hash, transcript, took_pot)
      VALUES (${o.gen}, ${o.sessionId}, ${o.player}, ${o.nickname}, ${o.player}, ${prize}, NULL, ${text}, ${takes ? 1 : 0}) RETURNING id`;
    touch();
    return { winId: r.id, prize, late: already };
  }) as any;
}
export const markAutoimmune = (id: number) => sql`UPDATE breaches SET autoimmune = 1 WHERE id = ${id}`;
export const allBreaches = () => sql<Breach[]>`SELECT * FROM breaches ORDER BY id ASC`;
export const breachesForGen = (gen: number) => sql<Breach[]>`SELECT * FROM breaches WHERE gen = ${gen} ORDER BY id ASC`;
/**
 * the wins the history page shows: for each generation, the one that produced it. the page used to
 * be sent every winning conversation ever recorded, to show these few.
 */
export const parentWins = () => sql<Breach[]>`SELECT b.* FROM breaches b JOIN generations g ON g.parent_breach_id = b.id ORDER BY b.id ASC`;
/** how many wins there have been and how much has been paid out for them, without reading a single conversation. */
export async function winTotals() {
  const [r] = await sql<{ n: number; paid: number }[]>`SELECT COUNT(*)::int AS n, COALESCE(SUM(CASE WHEN tx_hash IS NOT NULL THEN amount ELSE paid END), 0)::float AS paid FROM breaches`;
  return { wins: r.n, paid: Math.round(Number(r.paid) * 1e6) / 1e6 };
}
export const breachById = async (id: number) => (await sql<Breach[]>`SELECT * FROM breaches WHERE id = ${id}`)[0];

/**
 * wins that are owed and not yet paid, oldest first. a payout can be put off (a daily cap, a failed
 * transfer, payouts switched off) and nothing else would ever come back for it, so these are swept.
 * only wins whose lesson has been learned count: a win is paid after the next generation exists.
 */
export const unpaidWins = () => sql<Breach[]>`
  SELECT b.* FROM breaches b JOIN generations g ON g.gen = b.gen + 1
  WHERE b.amount > 0 AND b.tx_hash IS NULL ORDER BY b.id ASC LIMIT 20`;
/** every dollar of prize money that has been won and has not yet left the house. */
export const owedTotal = async () => Number((await sql<{ t: number }[]>`SELECT COALESCE(SUM(amount - paid),0)::float AS t FROM breaches WHERE tx_hash IS NULL AND amount > 0`)[0].t);
/** the books: what came in, what went out, what is still owed. */
export async function books() {
  const [s] = await sql<any[]>`SELECT COUNT(*) FILTER (WHERE via IS DISTINCT FROM 'carry')::int AS games, COUNT(*) FILTER (WHERE via = 'carry')::int AS carried, COALESCE(SUM(amount),0)::float AS staked FROM stakes`;
  const [p] = await sql<any[]>`SELECT COUNT(*)::int AS wins, COALESCE(SUM(CASE WHEN tx_hash IS NOT NULL THEN amount ELSE paid END),0)::float AS paid FROM breaches WHERE amount > 0`;
  const [o] = await sql<any[]>`SELECT COUNT(*)::int AS n, COALESCE(SUM(amount - paid),0)::float AS owed FROM breaches WHERE tx_hash IS NULL AND amount > 0`;
  const [d] = await sql<any[]>`SELECT COUNT(DISTINCT player)::int AS players FROM stakes`;
  const r6 = (n: number) => Math.round(Number(n) * 1e6) / 1e6;
  const [m] = await sql<any[]>`SELECT COUNT(*)::int AS n FROM stakes WHERE via = 'mpp'`;
  return { games: s.games, games_by_agents: m.n, games_carried_over: s.carried, players: d.players, staked: r6(s.staked), wins: p.wins, paid: r6(p.paid), unpaid_wins: o.n, owed: r6(o.owed), staked_24h: r6(await stakedLast24h()), paid_24h: r6(await spentLast24h()) };
}

/** a win that never produced the generation after it: unfinished business. */
export const unfinishedWin = async () => (await sql<Breach[]>`
  SELECT b.* FROM breaches b LEFT JOIN generations g ON g.gen = b.gen + 1
  WHERE g.id IS NULL ORDER BY b.id DESC LIMIT 1`)[0];

export const recordRegression = (candidateGen: number, round: number, breachId: number | null, kind: string, passed: boolean, detail: string) =>
  sql`INSERT INTO regression_runs (candidate_gen, round, breach_id, kind, passed, detail) VALUES (${candidateGen}, ${round}, ${breachId}, ${kind}, ${passed ? 1 : 0}, ${detail})`;
export const regressionsForGen = (gen: number) => sql`SELECT * FROM regression_runs WHERE candidate_gen = ${gen} ORDER BY round, id`;

export const leaderboard = () => sql`SELECT player, MAX(nickname) AS nickname, COUNT(*)::int AS breaches, SUM(amount)::float AS stolen, MAX(gen) AS highest_gen
  FROM breaches GROUP BY player ORDER BY highest_gen DESC, breaches DESC LIMIT 50`;

export const MACHINE_NICK = '🤖 the machine';
export async function machinePulse() {
  const [t] = await sql<any[]>`SELECT COUNT(*)::int AS n, COALESCE(SUM(amount),0)::float AS s, MAX(gen) AS g FROM breaches WHERE nickname = ${MACHINE_NICK}`;
  return { wins: t.n, stolen: t.s, highest_gen: t.g };
}

export type Allowance = { bucket: string; max: number; seconds: number };
/**
 * one request against several allowances at once. it is counted against all of them or, if any one
 * of them is full, against none: checked one after another, a request the second refused had still
 * used up a place in the first. the whole thing is a single transaction, so two functions cannot
 * both slip through the last slot.
 * returns null when allowed, or the allowance that refused and how many seconds until it has room.
 */
export async function rateAllowAll(limits: Allowance[]): Promise<{ bucket: string; wait: number } | null> {
  // one request at a time per bucket: without this, two that count at the same moment both see the
  // last free slot. the locks are taken in one order by everyone, so two requests cannot wait on each other.
  const names = [...new Set(limits.map((l) => l.bucket))].sort();
  return sql.begin(async (tx) => {
    for (const name of names) await tx`SELECT pg_advisory_xact_lock(hashtext(${'rate:' + name}))`;
    // a bucket nobody asks about again (a player who never came back) is swept by whoever passes, now and then.
    if (Math.random() < 0.01) await tx`DELETE FROM rate_hits WHERE at < now() - interval '2 days'`;
    for (const l of limits) {
      // old hits are swept as it goes, but never one inside the window being counted: a day-long
      // allowance that was swept after an hour was an hourly allowance.
      await tx`DELETE FROM rate_hits WHERE bucket = ${l.bucket} AND at < now() - (${Math.max(l.seconds, 3600)} * interval '1 second')`;
      const [r] = await tx<{ n: number; oldest: Date | null }[]>`
        SELECT COUNT(*)::int AS n, MIN(at) AS oldest FROM rate_hits
        WHERE bucket = ${l.bucket} AND at > now() - (${l.seconds} * interval '1 second')`;
      if (r.n >= l.max) {
        // room comes back when the oldest hit leaves the window. an allowance of none has no oldest hit: it waits the whole window.
        const freeAt = r.oldest ? new Date(r.oldest).getTime() + l.seconds * 1000 : Date.now() + l.seconds * 1000;
        return { bucket: l.bucket, wait: Math.max(1, Math.ceil((freeAt - Date.now()) / 1000)) };
      }
    }
    for (const l of limits) await tx`INSERT INTO rate_hits (bucket) VALUES (${l.bucket})`;
    return null;
  }) as any;
}
/** one request against one allowance. returns how many seconds until a slot frees, or 0 when allowed. */
export const rateAllow = async (bucket: string, max: number, seconds: number): Promise<number> =>
  (await rateAllowAll([{ bucket, max, seconds }]))?.wait ?? 0;

// ---------- locks: hardening runs once at a time, even across function instances ----------

export async function acquireLock(name: string, holder: string): Promise<boolean> {
  await sql`DELETE FROM locks WHERE name = ${name} AND taken_at < now() - interval '10 minutes'`;
  const got = (await sql`INSERT INTO locks (name, holder) VALUES (${name}, ${holder}) ON CONFLICT DO NOTHING RETURNING name`).length > 0;
  touch();
  return got;
}
/** what the holder is doing right now, for the live narration while the ai learns. */
export const setLockPhase = (name: string, phase: string) => sql`UPDATE locks SET holder = ${phase} WHERE name = ${name}`.then((r) => (touch(), r));
export const lockPhase = async (name: string) => (await sql<{ holder: string }[]>`SELECT holder FROM locks WHERE name = ${name} AND taken_at > now() - interval '10 minutes'`)[0]?.holder ?? null;
/** a purse signs its own name: nobody can rename someone else's wins. */
export const setNickname = (player: string, nickname: string | null) =>
  sql.begin(async (tx) => {
    await tx`UPDATE sessions SET nickname = ${nickname} WHERE player = ${player.toLowerCase()}`;
    await tx`UPDATE breaches SET nickname = ${nickname} WHERE player = ${player.toLowerCase()}`;
  });
export const releaseLock = (name: string) => sql`DELETE FROM locks WHERE name = ${name}`.then((r) => (touch(), r));
export const lockSince = async (name: string) => (await sql<{ taken_at: string }[]>`SELECT taken_at FROM locks WHERE name = ${name} AND taken_at > now() - interval '10 minutes'`)[0]?.taken_at ?? null;

export async function lastBotTick(): Promise<number> {
  const r = (await sql<{ taken_at: string }[]>`SELECT taken_at FROM locks WHERE name = 'bot-tick'`)[0]?.taken_at;
  return r ? new Date(r).getTime() : 0;
}
export const markBotTick = () => sql`INSERT INTO locks (name, holder, taken_at) VALUES ('bot-tick', 'bot', now()) ON CONFLICT (name) DO UPDATE SET taken_at = now()`;

/** wipe everything and reseed generation 0. drops the old per-tier tables too, so a redeploy over the previous schema is clean. */
export async function resetDb() {
  // on real money a reset erases the pot and every win still owed. it does not happen by accident,
  // or to someone who merely got hold of the admin token: it takes a setting on the server as well.
  // what counts is the money in the ledger, not only what this process is set to: a play-money
  // process pointed at the real-money database by mistake must not be able to wipe it either.
  const home = await sql<{ value: string }[]>`SELECT value FROM ledger_mark WHERE key = 'network'`.then((r) => r[0]?.value ?? null, () => null);
  if (resetIsGuarded(net.real, home) && !flag('ALLOW_RESET')) throw new Error(`this is a real-money database${net.real ? '' : ' (it was built on mainnet, though this process is set to testnet)'}: a reset would erase the pot and every win still owed. set ALLOW_RESET=1 on the server if you mean it.`);
  for (const t of ['regression_runs', 'breaches', 'sessions', 'generations', 'disbursements', 'locks', 'stakes', 'jackpot', 'rate_hits', 'thoughts', 'ledger_mark', 'agent_payments', 'po_registry', 'invoices']) await sql.unsafe(`DROP TABLE IF EXISTS ${t}`);
  ready = null;
  await init();
  touch();
}
