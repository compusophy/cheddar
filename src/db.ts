import Database from 'better-sqlite3';
import path from 'path';
import { APPROVED, DAILY_CAP } from './constants';
import { TIERS } from './tiers';

export { APPROVED, APPROVED_ADDRESSES, LEGIT_NEW_SUPPLIER, isBreachRecipient, DAILY_CAP } from './constants';

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'cheddar.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS generations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tier INTEGER NOT NULL,
    gen INTEGER NOT NULL,
    policy TEXT NOT NULL,
    parent_breach_id INTEGER,
    hardening_rounds INTEGER NOT NULL DEFAULT 0,
    regression_passed INTEGER NOT NULL DEFAULT 1,
    legit_passed INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (tier, gen)
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    tier INTEGER NOT NULL,
    gen INTEGER NOT NULL,
    player TEXT NOT NULL,
    nickname TEXT,
    transcript TEXT NOT NULL,
    turns INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'open',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS breaches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tier INTEGER NOT NULL,
    gen INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    player TEXT NOT NULL,
    nickname TEXT,
    recipient TEXT NOT NULL,
    amount REAL NOT NULL,
    tx_hash TEXT,
    transcript TEXT NOT NULL,
    autoimmune INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS po_registry (
    po TEXT PRIMARY KEY,
    item TEXT NOT NULL,
    limit_amount REAL NOT NULL,
    remit_to TEXT,
    closed INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS invoices (
    number TEXT PRIMARY KEY,
    supplier TEXT NOT NULL,
    payee TEXT NOT NULL,
    amount REAL NOT NULL,
    paid INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS disbursements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tier INTEGER NOT NULL DEFAULT 3,
    recipient TEXT NOT NULL,
    amount REAL NOT NULL,
    tx_hash TEXT,
    session_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS regression_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tier INTEGER NOT NULL,
    candidate_gen INTEGER NOT NULL,
    round INTEGER NOT NULL,
    breach_id INTEGER,
    kind TEXT NOT NULL,
    passed INTEGER NOT NULL,
    detail TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

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
export function seedBooks() {
  const po = db.prepare('INSERT OR IGNORE INTO po_registry (po, item, limit_amount, remit_to, closed) VALUES (?, ?, ?, NULL, 0)');
  for (const [p, item, lim] of SEED_POS) po.run(p, item, lim);
  const inv = db.prepare('INSERT OR IGNORE INTO invoices (number, supplier, payee, amount, paid) VALUES (?, ?, ?, ?, 0)');
  for (const [num, sup, amt] of SEED_INVOICES) inv.run(num, sup, APPROVED[sup], amt);
}

export const lookupPo = (po: string) => db.prepare('SELECT * FROM po_registry WHERE po = ?').get(normalizeRef(po)) as PoRow | undefined;
export const allPos = () => db.prepare('SELECT * FROM po_registry ORDER BY po').all() as PoRow[];
export const registerRemittance = (po: string, address: string | null) =>
  db.prepare('UPDATE po_registry SET remit_to = ? WHERE po = ?').run(address ? address.toLowerCase() : null, normalizeRef(po));
export const reopenPo = (po: string) => db.prepare('UPDATE po_registry SET closed = 0 WHERE po = ?').run(normalizeRef(po));
export const closePo = (po: string) => db.prepare('UPDATE po_registry SET closed = 1 WHERE po = ?').run(normalizeRef(po));

export const lookupInvoice = (n: string) => db.prepare('SELECT * FROM invoices WHERE number = ?').get(normalizeRef(n)) as InvoiceRow | undefined;
export const allInvoices = () => db.prepare('SELECT * FROM invoices ORDER BY number').all() as InvoiceRow[];
export const markInvoicePaid = (n: string) => db.prepare('UPDATE invoices SET paid = 1 WHERE number = ?').run(normalizeRef(n));
export const reopenInvoice = (n: string) => db.prepare('UPDATE invoices SET paid = 0 WHERE number = ?').run(normalizeRef(n));
export const registerInvoice = (num: string, supplier: string, payee: string, amount: number) =>
  db.prepare('INSERT OR REPLACE INTO invoices (number, supplier, payee, amount, paid) VALUES (?, ?, ?, ?, 0)').run(normalizeRef(num), supplier, payee.toLowerCase(), amount);

/** what the lookup tool tells the agent. one shape for both books. */
export function lookupReference(ref: string) {
  const inv = lookupInvoice(ref);
  if (inv) return { found: true, kind: 'invoice', reference: inv.number, supplier: inv.supplier, payable_to: inv.payee, amount: inv.amount, paid: !!inv.paid };
  const row = lookupPo(ref);
  if (!row) return { found: false };
  return { found: true, kind: 'purchase_order', reference: row.po, item: row.item, limit: row.limit_amount, closed: !!row.closed, payable_to: row.remit_to, registered: !!row.remit_to };
}

/**
 * resolve a payment reference against the books (tier 3). every disbursement must cite one.
 * the reference decides the payee and the ceiling, not the chat.
 */
export type Resolved =
  | { ok: true; kind: 'invoice' | 'po'; ref: string; payee: string; max: number }
  | { ok: false; reason: string };
export function resolveReference(ref: string): Resolved {
  const r = normalizeRef(ref);
  if (!r) return { ok: false, reason: 'a payment reference is required (an invoice number or a purchase order)' };
  const inv = lookupInvoice(r);
  if (inv) {
    if (inv.paid) return { ok: false, reason: `invoice ${inv.number} has already been paid` };
    return { ok: true, kind: 'invoice', ref: inv.number, payee: inv.payee, max: inv.amount };
  }
  const po = lookupPo(r);
  if (po) {
    if (po.closed) return { ok: false, reason: `purchase order ${po.po} is closed; it has already been paid` };
    if (!po.remit_to) return { ok: false, reason: `purchase order ${po.po} has no remittance address registered by the shop owner` };
    return { ok: true, kind: 'po', ref: po.po, payee: po.remit_to, max: po.limit_amount };
  }
  return { ok: false, reason: `no invoice or purchase order matching ${r} exists in the shop records` };
}

// ---------- velocity limit (tier 3) ----------

export function spentLast24h(): number {
  return (db.prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM disbursements WHERE created_at > datetime('now', '-1 day')").get() as { total: number }).total;
}
export const clearDisbursementWindow = () => db.prepare('DELETE FROM disbursements').run();

/**
 * reserve headroom against the daily cap BEFORE the transfer is sent, in one synchronous transaction,
 * so concurrent sessions cannot both spend the same allowance. a failed transfer releases it.
 */
export const reserveDisbursement = db.transaction((tier: number, recipient: string, amount: number, sessionId: string | null): { ok: true; id: number } | { ok: false; remaining: number } => {
  const remaining = DAILY_CAP - spentLast24h();
  if (amount > remaining) return { ok: false, remaining };
  const r = db.prepare('INSERT INTO disbursements (tier, recipient, amount, tx_hash, session_id) VALUES (?, ?, ?, NULL, ?)').run(tier, recipient.toLowerCase(), amount, sessionId);
  return { ok: true, id: Number(r.lastInsertRowid) };
}) as (tier: number, recipient: string, amount: number, sessionId: string | null) => { ok: true; id: number } | { ok: false; remaining: number };
export const settleReservation = (id: number, txHash: string) => db.prepare('UPDATE disbursements SET tx_hash = ? WHERE id = ?').run(txHash, id);
export const releaseReservation = (id: number) => db.prepare('DELETE FROM disbursements WHERE id = ?').run(id);

// ---------- generations, sessions, breaches (all per tier) ----------

export type Generation = { id: number; tier: number; gen: number; policy: string; parent_breach_id: number | null; hardening_rounds: number; regression_passed: number; legit_passed: number; created_at: string };
export type Breach = { id: number; tier: number; gen: number; session_id: string; player: string; nickname: string | null; recipient: string; amount: number; tx_hash: string | null; transcript: string; autoimmune: number; created_at: string };
export type SessionRow = { id: string; tier: number; gen: number; player: string; nickname: string | null; transcript: string; turns: number; status: string; created_at: string; updated_at: string };

export function seedGenerations() {
  const ins = db.prepare('INSERT OR IGNORE INTO generations (tier, gen, policy) VALUES (?, 0, ?)');
  for (const t of TIERS) ins.run(t.id, t.gen0);
}

export const currentGeneration = (tier: number) => db.prepare('SELECT * FROM generations WHERE tier = ? ORDER BY gen DESC LIMIT 1').get(tier) as Generation;
export const getGeneration = (tier: number, gen: number) => db.prepare('SELECT * FROM generations WHERE tier = ? AND gen = ?').get(tier, gen) as Generation | undefined;
export const allGenerations = (tier: number) => db.prepare('SELECT * FROM generations WHERE tier = ? ORDER BY gen ASC').all(tier) as Generation[];
export const createGeneration = (tier: number, gen: number, policy: string, parentBreachId: number, rounds: number, regressionPassed: boolean, legitPassed: boolean) =>
  db.prepare('INSERT INTO generations (tier, gen, policy, parent_breach_id, hardening_rounds, regression_passed, legit_passed) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(tier, gen, policy, parentBreachId, rounds, regressionPassed ? 1 : 0, legitPassed ? 1 : 0);

export const getSession = (id: string) => db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
export const createSession = (id: string, tier: number, gen: number, player: string, nickname: string | null) =>
  db.prepare('INSERT INTO sessions (id, tier, gen, player, nickname, transcript) VALUES (?, ?, ?, ?, ?, ?)').run(id, tier, gen, player, nickname, '[]');
export const updateSession = (id: string, transcript: unknown[], turns: number, status: string) =>
  db.prepare('UPDATE sessions SET transcript = ?, turns = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(JSON.stringify(transcript), turns, status, id);

export function recordBreach(b: Omit<Breach, 'id' | 'created_at' | 'autoimmune'>): number {
  const r = db.prepare('INSERT INTO breaches (tier, gen, session_id, player, nickname, recipient, amount, tx_hash, transcript) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(b.tier, b.gen, b.session_id, b.player, b.nickname, b.recipient, b.amount, b.tx_hash, b.transcript);
  return Number(r.lastInsertRowid);
}
export const markAutoimmune = (id: number) => db.prepare('UPDATE breaches SET autoimmune = 1 WHERE id = ?').run(id);
export const allBreaches = (tier?: number) =>
  (tier === undefined
    ? db.prepare('SELECT * FROM breaches ORDER BY id ASC').all()
    : db.prepare('SELECT * FROM breaches WHERE tier = ? ORDER BY id ASC').all(tier)) as Breach[];
export const breachesForGen = (tier: number, gen: number) => db.prepare('SELECT * FROM breaches WHERE tier = ? AND gen = ? ORDER BY id ASC').all(tier, gen) as Breach[];
export const breachById = (id: number) => db.prepare('SELECT * FROM breaches WHERE id = ?').get(id) as Breach | undefined;

export const recordRegression = (tier: number, candidateGen: number, round: number, breachId: number | null, kind: string, passed: boolean, detail: string) =>
  db.prepare('INSERT INTO regression_runs (tier, candidate_gen, round, breach_id, kind, passed, detail) VALUES (?, ?, ?, ?, ?, ?, ?)').run(tier, candidateGen, round, breachId, kind, passed ? 1 : 0, detail);
export const regressionsForGen = (tier: number, gen: number) => db.prepare('SELECT * FROM regression_runs WHERE tier = ? AND candidate_gen = ? ORDER BY round, id').all(tier, gen);

export function leaderboard() {
  return db.prepare(`SELECT player, MAX(nickname) AS nickname, COUNT(*) AS breaches, SUM(amount) AS stolen, MAX(tier) AS highest_tier, MAX(gen) AS highest_gen
    FROM breaches GROUP BY player ORDER BY highest_tier DESC, breaches DESC, highest_gen DESC LIMIT 50`).all();
}

const MACHINE_NICK = '🤖 the machine';
/** the machine's last win, for the live ticker. */
export function machinePulse() {
  const b = db.prepare('SELECT tier, amount, created_at FROM breaches WHERE nickname = ? ORDER BY id DESC LIMIT 1').get(MACHINE_NICK) as any;
  const total = (db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS s FROM breaches WHERE nickname = ?').get(MACHINE_NICK)) as any;
  return { wins: total.n, stolen: total.s, last: b ? { tier: b.tier, amount: b.amount, at: b.created_at } : null };
}

export function tierSummary() {
  return TIERS.map((t) => {
    const g = currentGeneration(t.id);
    const b = allBreaches(t.id);
    return { tier: t.id, slug: t.slug, name: t.name, tagline: t.tagline, tools: t.tools, gen: g.gen, breaches: b.length, stolen: b.reduce((s, x) => s + x.amount, 0) };
  });
}

export function resetDb() {
  db.exec('DELETE FROM regression_runs; DELETE FROM breaches; DELETE FROM sessions; DELETE FROM generations; DELETE FROM po_registry; DELETE FROM invoices; DELETE FROM disbursements;');
  seedBooks();
  seedGenerations();
}

seedBooks();
seedGenerations();
