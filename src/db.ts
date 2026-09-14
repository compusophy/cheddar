/** storage. postgres on neon; the site runs on vercel functions with no disk and no long-lived process. */
import postgres from 'postgres';
import { GEN0, DAILY_CAP } from './game';

const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!url) throw new Error('[db] DATABASE_URL missing');
// onnotice: neon emits 'relation already exists' NOTICEs on every cold start from CREATE TABLE IF NOT EXISTS
export const sql = postgres(url, { max: 5, idle_timeout: 20, prepare: false, onnotice: () => {} });

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
    await sql`INSERT INTO generations (gen, policy) VALUES (0, ${GEN0}) ON CONFLICT DO NOTHING`;
  })();
  return ready;
}

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
export const settleReservation = (id: number, txHash: string) => sql`UPDATE disbursements SET tx_hash = ${txHash} WHERE id = ${id}`;
export const releaseReservation = (id: number) => sql`DELETE FROM disbursements WHERE id = ${id}`;

// ---------- generations, sessions, breaches ----------

export type Generation = { id: number; gen: number; policy: string; parent_breach_id: number | null; hardening_rounds: number; regression_passed: number; legit_passed: number; created_at: string };
export type Breach = { id: number; gen: number; session_id: string; player: string; nickname: string | null; recipient: string; amount: number; tx_hash: string | null; transcript: string; autoimmune: number; created_at: string };
export type SessionRow = { id: string; gen: number; player: string; nickname: string | null; transcript: string; turns: number; status: string; created_at: string; updated_at: string };

export const currentGeneration = async () => (await sql<Generation[]>`SELECT * FROM generations ORDER BY gen DESC LIMIT 1`)[0];
export const getGeneration = async (gen: number) => (await sql<Generation[]>`SELECT * FROM generations WHERE gen = ${gen}`)[0];
export const allGenerations = () => sql<Generation[]>`SELECT * FROM generations ORDER BY gen ASC`;
export const createGeneration = (gen: number, policy: string, parentBreachId: number, rounds: number, regressionPassed: boolean, legitPassed: boolean) =>
  sql`INSERT INTO generations (gen, policy, parent_breach_id, hardening_rounds, regression_passed, legit_passed)
      VALUES (${gen}, ${policy}, ${parentBreachId}, ${rounds}, ${regressionPassed ? 1 : 0}, ${legitPassed ? 1 : 0}) ON CONFLICT DO NOTHING`;

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
export const markAutoimmune = (id: number) => sql`UPDATE breaches SET autoimmune = 1 WHERE id = ${id}`;
export const allBreaches = () => sql<Breach[]>`SELECT * FROM breaches ORDER BY id ASC`;
export const breachesForGen = (gen: number) => sql<Breach[]>`SELECT * FROM breaches WHERE gen = ${gen} ORDER BY id ASC`;
export const breachById = async (id: number) => (await sql<Breach[]>`SELECT * FROM breaches WHERE id = ${id}`)[0];

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

// ---------- locks: hardening runs once at a time, even across function instances ----------

export async function acquireLock(name: string, holder: string): Promise<boolean> {
  await sql`DELETE FROM locks WHERE name = ${name} AND taken_at < now() - interval '10 minutes'`;
  return (await sql`INSERT INTO locks (name, holder) VALUES (${name}, ${holder}) ON CONFLICT DO NOTHING RETURNING name`).length > 0;
}
export const releaseLock = (name: string) => sql`DELETE FROM locks WHERE name = ${name}`;
export const lockSince = async (name: string) => (await sql<{ taken_at: string }[]>`SELECT taken_at FROM locks WHERE name = ${name} AND taken_at > now() - interval '10 minutes'`)[0]?.taken_at ?? null;

export async function lastBotTick(): Promise<number> {
  const r = (await sql<{ taken_at: string }[]>`SELECT taken_at FROM locks WHERE name = 'bot-tick'`)[0]?.taken_at;
  return r ? new Date(r).getTime() : 0;
}
export const markBotTick = () => sql`INSERT INTO locks (name, holder, taken_at) VALUES ('bot-tick', 'bot', now()) ON CONFLICT (name) DO UPDATE SET taken_at = now()`;

/** wipe everything and reseed generation 0. drops the old per-tier tables too, so a redeploy over the previous schema is clean. */
export async function resetDb() {
  for (const t of ['regression_runs', 'breaches', 'sessions', 'generations', 'disbursements', 'locks', 'po_registry', 'invoices']) await sql.unsafe(`DROP TABLE IF EXISTS ${t}`);
  ready = null;
  await init();
}
