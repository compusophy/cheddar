/**
 * storage. postgres, because the site runs on vercel functions: no persistent disk, no long-lived
 * process. every function that used to be a synchronous sqlite call is now async. the schema and the
 * rules are unchanged; only the driver moved.
 */
import postgres from 'postgres';
import { APPROVED, DAILY_CAP } from './constants';
import { TIERS } from './tiers';

export { APPROVED, APPROVED_ADDRESSES, LEGIT_NEW_SUPPLIER, isBreachRecipient, DAILY_CAP } from './constants';

const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!url) throw new Error('[db] DATABASE_URL missing');
// onnotice: neon emits 'relation already exists' NOTICEs on every cold start from CREATE TABLE IF NOT EXISTS
export const sql = postgres(url, { max: 5, idle_timeout: 20, prepare: false, onnotice: () => {} });

let ready: Promise<void> | null = null;
/** create tables and seed on first use. cheap to call; runs once per instance. */
export function init(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    await sql`CREATE TABLE IF NOT EXISTS generations (
      id SERIAL PRIMARY KEY, tier INT NOT NULL, gen INT NOT NULL, policy TEXT NOT NULL,
      parent_breach_id INT, hardening_rounds INT NOT NULL DEFAULT 0,
      regression_passed INT NOT NULL DEFAULT 1, legit_passed INT NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT now(), UNIQUE (tier, gen))`;
    await sql`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, tier INT NOT NULL, gen INT NOT NULL, player TEXT NOT NULL, nickname TEXT,
      transcript TEXT NOT NULL, turns INT NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'open',
      created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now())`;
    await sql`CREATE TABLE IF NOT EXISTS breaches (
      id SERIAL PRIMARY KEY, tier INT NOT NULL, gen INT NOT NULL, session_id TEXT NOT NULL,
      player TEXT NOT NULL, nickname TEXT, recipient TEXT NOT NULL, amount DOUBLE PRECISION NOT NULL,
      tx_hash TEXT, transcript TEXT NOT NULL, autoimmune INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT now())`;
    await sql`CREATE TABLE IF NOT EXISTS po_registry (
      po TEXT PRIMARY KEY, item TEXT NOT NULL, limit_amount DOUBLE PRECISION NOT NULL,
      remit_to TEXT, closed INT NOT NULL DEFAULT 0)`;
    await sql`CREATE TABLE IF NOT EXISTS invoices (
      number TEXT PRIMARY KEY, supplier TEXT NOT NULL, payee TEXT NOT NULL,
      amount DOUBLE PRECISION NOT NULL, paid INT NOT NULL DEFAULT 0)`;
    await sql`CREATE TABLE IF NOT EXISTS disbursements (
      id SERIAL PRIMARY KEY, tier INT NOT NULL DEFAULT 3, recipient TEXT NOT NULL,
      amount DOUBLE PRECISION NOT NULL, tx_hash TEXT, session_id TEXT, created_at TIMESTAMPTZ DEFAULT now())`;
    await sql`CREATE TABLE IF NOT EXISTS regression_runs (
      id SERIAL PRIMARY KEY, tier INT NOT NULL, candidate_gen INT NOT NULL, round INT NOT NULL,
      breach_id INT, kind TEXT NOT NULL, passed INT NOT NULL, detail TEXT, created_at TIMESTAMPTZ DEFAULT now())`;
    await sql`CREATE TABLE IF NOT EXISTS locks (
      name TEXT PRIMARY KEY, holder TEXT, taken_at TIMESTAMPTZ DEFAULT now())`;
    await seedBooks();
    await seedGenerations();
  })();
  return ready;
}

// ---------- the books ----------

export type PoRow = { po: string; item: string; limit_amount: number; remit_to: string | null; closed: number };
export type InvoiceRow = { number: string; supplier: string; payee: string; amount: number; paid: number };

const normalizeRef = (r: string) => (r || '').trim().toUpperCase().replace(/\s+/g, '').replace(/^PO(?!-)/, 'PO-');

const SEED_POS: [string, string, number][] = [
  ['PO-8814', 'kraft mailers', 3.0],
  ['PO-8827', 'thermal label rolls', 2.0],
  ['PO-8830', 'pallet wrap', 4.0],
];
const SEED_INVOICES: [string, keyof typeof APPROVED, number][] = [
  ['INV-4471', 'northwind paper co', 2.5],
  ['INV-A2210', 'acme logistics', 1.25],
];
export async function seedBooks() {
  for (const [p, item, lim] of SEED_POS)
    await sql`INSERT INTO po_registry (po, item, limit_amount, remit_to, closed) VALUES (${p}, ${item}, ${lim}, NULL, 0) ON CONFLICT DO NOTHING`;
  for (const [num, sup, amt] of SEED_INVOICES)
    await sql`INSERT INTO invoices (number, supplier, payee, amount, paid) VALUES (${num}, ${sup}, ${APPROVED[sup]}, ${amt}, 0) ON CONFLICT DO NOTHING`;
}

export const lookupPo = async (po: string) => (await sql<PoRow[]>`SELECT * FROM po_registry WHERE po = ${normalizeRef(po)}`)[0];
export const allPos = () => sql<PoRow[]>`SELECT * FROM po_registry ORDER BY po`;
export const registerRemittance = (po: string, address: string | null) =>
  sql`UPDATE po_registry SET remit_to = ${address ? address.toLowerCase() : null} WHERE po = ${normalizeRef(po)}`;
export const reopenPo = (po: string) => sql`UPDATE po_registry SET closed = 0 WHERE po = ${normalizeRef(po)}`;
export const closePo = (po: string) => sql`UPDATE po_registry SET closed = 1 WHERE po = ${normalizeRef(po)}`;

export const lookupInvoice = async (n: string) => (await sql<InvoiceRow[]>`SELECT * FROM invoices WHERE number = ${normalizeRef(n)}`)[0];
export const allInvoices = () => sql<InvoiceRow[]>`SELECT * FROM invoices ORDER BY number`;
export const markInvoicePaid = (n: string) => sql`UPDATE invoices SET paid = 1 WHERE number = ${normalizeRef(n)}`;
export const reopenInvoice = (n: string) => sql`UPDATE invoices SET paid = 0 WHERE number = ${normalizeRef(n)}`;
export const registerInvoice = (num: string, supplier: string, payee: string, amount: number) =>
  sql`INSERT INTO invoices (number, supplier, payee, amount, paid) VALUES (${normalizeRef(num)}, ${supplier}, ${payee.toLowerCase()}, ${amount}, 0)
      ON CONFLICT (number) DO UPDATE SET supplier = EXCLUDED.supplier, payee = EXCLUDED.payee, amount = EXCLUDED.amount, paid = 0`;

/** what the lookup tool tells the agent. one shape for both books. */
export async function lookupReference(ref: string) {
  const inv = await lookupInvoice(ref);
  if (inv) return { found: true, kind: 'invoice', reference: inv.number, supplier: inv.supplier, payable_to: inv.payee, amount: inv.amount, paid: !!inv.paid };
  const row = await lookupPo(ref);
  if (!row) return { found: false };
  return { found: true, kind: 'purchase_order', reference: row.po, item: row.item, limit: row.limit_amount, closed: !!row.closed, payable_to: row.remit_to, registered: !!row.remit_to };
}

/** resolve a payment reference against the books (tier 3). the reference decides the payee and the ceiling, not the chat. */
export type Resolved =
  | { ok: true; kind: 'invoice' | 'po'; ref: string; payee: string; max: number }
  | { ok: false; reason: string };
export async function resolveReference(ref: string): Promise<Resolved> {
  const r = normalizeRef(ref);
  if (!r) return { ok: false, reason: 'a payment reference is required (an invoice number or a purchase order)' };
  const inv = await lookupInvoice(r);
  if (inv) {
    if (inv.paid) return { ok: false, reason: `invoice ${inv.number} has already been paid` };
    return { ok: true, kind: 'invoice', ref: inv.number, payee: inv.payee, max: inv.amount };
  }
  const po = await lookupPo(r);
  if (po) {
    if (po.closed) return { ok: false, reason: `purchase order ${po.po} is closed; it has already been paid` };
    if (!po.remit_to) return { ok: false, reason: `purchase order ${po.po} has no remittance address registered by the shop owner` };
    return { ok: true, kind: 'po', ref: po.po, payee: po.remit_to, max: po.limit_amount };
  }
  return { ok: false, reason: `no invoice or purchase order matching ${r} exists in the shop records` };
}

// ---------- velocity limit (tier 3) ----------

export async function spentLast24h(): Promise<number> {
  const [r] = await sql<{ total: number }[]>`SELECT COALESCE(SUM(amount), 0)::float AS total FROM disbursements WHERE created_at > now() - interval '1 day'`;
  return Number(r.total);
}
export const clearDisbursementWindow = () => sql`DELETE FROM disbursements`;

/**
 * reserve headroom against the daily cap BEFORE the transfer is sent, inside one transaction with the
 * table locked, so concurrent functions cannot both spend the same allowance. a failed transfer releases it.
 */
export async function reserveDisbursement(tier: number, recipient: string, amount: number, sessionId: string | null): Promise<{ ok: true; id: number } | { ok: false; remaining: number }> {
  return sql.begin(async (tx) => {
    await tx`LOCK TABLE disbursements IN SHARE ROW EXCLUSIVE MODE`;
    const [r] = await tx<{ total: number }[]>`SELECT COALESCE(SUM(amount), 0)::float AS total FROM disbursements WHERE created_at > now() - interval '1 day'`;
    const remaining = DAILY_CAP - Number(r.total);
    if (amount > remaining) return { ok: false as const, remaining };
    const [row] = await tx<{ id: number }[]>`INSERT INTO disbursements (tier, recipient, amount, tx_hash, session_id) VALUES (${tier}, ${recipient.toLowerCase()}, ${amount}, NULL, ${sessionId}) RETURNING id`;
    return { ok: true as const, id: row.id };
  }) as any;
}
export const settleReservation = (id: number, txHash: string) => sql`UPDATE disbursements SET tx_hash = ${txHash} WHERE id = ${id}`;
export const releaseReservation = (id: number) => sql`DELETE FROM disbursements WHERE id = ${id}`;

// ---------- generations, sessions, breaches (all per tier) ----------

export type Generation = { id: number; tier: number; gen: number; policy: string; parent_breach_id: number | null; hardening_rounds: number; regression_passed: number; legit_passed: number; created_at: string };
export type Breach = { id: number; tier: number; gen: number; session_id: string; player: string; nickname: string | null; recipient: string; amount: number; tx_hash: string | null; transcript: string; autoimmune: number; created_at: string };
export type SessionRow = { id: string; tier: number; gen: number; player: string; nickname: string | null; transcript: string; turns: number; status: string; created_at: string; updated_at: string };

export async function seedGenerations() {
  for (const t of TIERS) await sql`INSERT INTO generations (tier, gen, policy) VALUES (${t.id}, 0, ${t.gen0}) ON CONFLICT DO NOTHING`;
}

export const currentGeneration = async (tier: number) => (await sql<Generation[]>`SELECT * FROM generations WHERE tier = ${tier} ORDER BY gen DESC LIMIT 1`)[0];
export const getGeneration = async (tier: number, gen: number) => (await sql<Generation[]>`SELECT * FROM generations WHERE tier = ${tier} AND gen = ${gen}`)[0];
export const allGenerations = (tier: number) => sql<Generation[]>`SELECT * FROM generations WHERE tier = ${tier} ORDER BY gen ASC`;
export const createGeneration = (tier: number, gen: number, policy: string, parentBreachId: number, rounds: number, regressionPassed: boolean, legitPassed: boolean) =>
  sql`INSERT INTO generations (tier, gen, policy, parent_breach_id, hardening_rounds, regression_passed, legit_passed)
      VALUES (${tier}, ${gen}, ${policy}, ${parentBreachId}, ${rounds}, ${regressionPassed ? 1 : 0}, ${legitPassed ? 1 : 0}) ON CONFLICT DO NOTHING`;

export const getSession = async (id: string) => (await sql<SessionRow[]>`SELECT * FROM sessions WHERE id = ${id}`)[0];
export const createSession = (id: string, tier: number, gen: number, player: string, nickname: string | null) =>
  sql`INSERT INTO sessions (id, tier, gen, player, nickname, transcript) VALUES (${id}, ${tier}, ${gen}, ${player}, ${nickname}, '[]')`;
export const updateSession = (id: string, transcript: unknown[], turns: number, status: string) =>
  sql`UPDATE sessions SET transcript = ${JSON.stringify(transcript)}, turns = ${turns}, status = ${status}, updated_at = now() WHERE id = ${id}`;

export async function recordBreach(b: Omit<Breach, 'id' | 'created_at' | 'autoimmune'>): Promise<number> {
  const [r] = await sql<{ id: number }[]>`INSERT INTO breaches (tier, gen, session_id, player, nickname, recipient, amount, tx_hash, transcript)
    VALUES (${b.tier}, ${b.gen}, ${b.session_id}, ${b.player}, ${b.nickname}, ${b.recipient}, ${b.amount}, ${b.tx_hash}, ${b.transcript}) RETURNING id`;
  return r.id;
}
export const markAutoimmune = (id: number) => sql`UPDATE breaches SET autoimmune = 1 WHERE id = ${id}`;
export const allBreaches = (tier?: number) =>
  tier === undefined ? sql<Breach[]>`SELECT * FROM breaches ORDER BY id ASC` : sql<Breach[]>`SELECT * FROM breaches WHERE tier = ${tier} ORDER BY id ASC`;
export const breachesForGen = (tier: number, gen: number) => sql<Breach[]>`SELECT * FROM breaches WHERE tier = ${tier} AND gen = ${gen} ORDER BY id ASC`;
export const breachById = async (id: number) => (await sql<Breach[]>`SELECT * FROM breaches WHERE id = ${id}`)[0];

export const recordRegression = (tier: number, candidateGen: number, round: number, breachId: number | null, kind: string, passed: boolean, detail: string) =>
  sql`INSERT INTO regression_runs (tier, candidate_gen, round, breach_id, kind, passed, detail) VALUES (${tier}, ${candidateGen}, ${round}, ${breachId}, ${kind}, ${passed ? 1 : 0}, ${detail})`;
export const regressionsForGen = (tier: number, gen: number) => sql`SELECT * FROM regression_runs WHERE tier = ${tier} AND candidate_gen = ${gen} ORDER BY round, id`;

export const leaderboard = () => sql`SELECT player, MAX(nickname) AS nickname, COUNT(*)::int AS breaches, SUM(amount)::float AS stolen, MAX(tier) AS highest_tier, MAX(gen) AS highest_gen
  FROM breaches GROUP BY player ORDER BY highest_tier DESC, breaches DESC, highest_gen DESC LIMIT 50`;

const MACHINE_NICK = '🤖 the machine';
/** the machine's last win, for the live ticker. */
export async function machinePulse() {
  const [b] = await sql<any[]>`SELECT tier, amount, created_at FROM breaches WHERE nickname = ${MACHINE_NICK} ORDER BY id DESC LIMIT 1`;
  const [t] = await sql<any[]>`SELECT COUNT(*)::int AS n, COALESCE(SUM(amount),0)::float AS s FROM breaches WHERE nickname = ${MACHINE_NICK}`;
  return { wins: t.n, stolen: t.s, last: b ? { tier: b.tier, amount: b.amount, at: b.created_at } : null };
}

export async function tierSummary() {
  const out = [];
  for (const t of TIERS) {
    const g = await currentGeneration(t.id);
    const b = await allBreaches(t.id);
    out.push({ tier: t.id, slug: t.slug, name: t.name, tagline: t.tagline, tools: t.tools, gen: g.gen, breaches: b.length, stolen: b.reduce((s, x) => s + Number(x.amount), 0) });
  }
  return out;
}

// ---------- locks: hardening runs once per tier even across function instances ----------

/** take the lock for a tier, or return false if another instance holds a fresh one. stale locks (10 min) are reclaimed. */
export async function acquireLock(name: string, holder: string): Promise<boolean> {
  await sql`DELETE FROM locks WHERE name = ${name} AND taken_at < now() - interval '10 minutes'`;
  const r = await sql`INSERT INTO locks (name, holder) VALUES (${name}, ${holder}) ON CONFLICT DO NOTHING RETURNING name`;
  return r.length > 0;
}
export const releaseLock = (name: string) => sql`DELETE FROM locks WHERE name = ${name}`;
export const isLocked = async (name: string) => (await sql`SELECT 1 FROM locks WHERE name = ${name} AND taken_at > now() - interval '10 minutes'`).length > 0;
export const lockSince = async (name: string) => (await sql<{ taken_at: string }[]>`SELECT taken_at FROM locks WHERE name = ${name}`)[0]?.taken_at ?? null;

/** the machine's cadence, shared across instances: when did it last play? */
export async function lastBotTick(): Promise<number> {
  const r = await lockSince('bot-tick');
  return r ? new Date(r).getTime() : 0;
}
export const markBotTick = async () => { await sql`INSERT INTO locks (name, holder, taken_at) VALUES ('bot-tick', 'bot', now()) ON CONFLICT (name) DO UPDATE SET taken_at = now()`; };

export async function resetDb() {
  await sql`DELETE FROM regression_runs`; await sql`DELETE FROM breaches`; await sql`DELETE FROM sessions`;
  await sql`DELETE FROM generations`; await sql`DELETE FROM po_registry`; await sql`DELETE FROM invoices`;
  await sql`DELETE FROM disbursements`; await sql`DELETE FROM locks`;
  await seedBooks();
  await seedGenerations();
}
