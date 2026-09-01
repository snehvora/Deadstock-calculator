/* Product catalog + purchase orders, stored in a local SQLite file.
   node:sqlite ships with Node 22, so this adds no dependencies. The file
   lives next to the server and never leaves the machine. */
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'stock.db');
require('fs').mkdirSync(path.dirname(FILE), { recursive: true });

const db = new DatabaseSync(FILE);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id          TEXT PRIMARY KEY,
  product_id  TEXT,
  name        TEXT NOT NULL DEFAULT '',
  cat         TEXT NOT NULL DEFAULT '',
  sub         TEXT NOT NULL DEFAULT '',
  brand       TEXT NOT NULL DEFAULT '',
  vendor      TEXT NOT NULL DEFAULT '',
  unit        TEXT NOT NULL DEFAULT '',
  cost        REAL NOT NULL DEFAULT 0,
  pdate       TEXT NOT NULL DEFAULT '',
  pdate_ms    INTEGER,
  purch_unit  TEXT NOT NULL DEFAULT '',
  purch_cost  REAL NOT NULL DEFAULT 0,
  stock       REAL NOT NULL DEFAULT 0,
  sales       REAL NOT NULL DEFAULT 0,
  stock_piece REAL NOT NULL DEFAULT 0,
  per_default REAL NOT NULL DEFAULT 1,
  box_size    REAL NOT NULL DEFAULT 0,
  case_size   REAL NOT NULL DEFAULT 0,
  source      TEXT NOT NULL DEFAULT '',
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_products_name   ON products(name);
CREATE INDEX IF NOT EXISTS ix_products_vendor ON products(vendor);
CREATE INDEX IF NOT EXISTS ix_products_cat    ON products(cat);
CREATE INDEX IF NOT EXISTS ix_products_brand  ON products(brand);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  vendor     TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'draft',
  notes      TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS po_lines (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  po_id      INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_id TEXT    NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  qty        REAL    NOT NULL DEFAULT 0,
  unit_cost  REAL    NOT NULL DEFAULT 0,
  note       TEXT    NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  UNIQUE(po_id, product_id)
);
CREATE INDEX IF NOT EXISTS ix_lines_po ON po_lines(po_id);
`);

const now = () => Date.now();
const s = v => (v === null || v === undefined) ? '' : String(v);
const n = v => { const x = Number(v); return Number.isFinite(x) ? x : 0; };

/* ---------- products ---------- */

/* A row keeps its Product ID when the report has one. Reports sometimes omit it,
   so fall back to a deterministic fingerprint of the identifying text — that way
   re-importing the same report updates rows instead of duplicating them. */
function rowKey(r){
  const pid = s(r.id).trim();
  if (pid) return pid;
  const sig = [r.name, r.brand, r.unit, r.cat].map(v => s(v).trim().toLowerCase()).join('|');
  let h = 5381;
  for (let i = 0; i < sig.length; i++) h = ((h * 33) ^ sig.charCodeAt(i)) >>> 0;
  return 'auto:' + h.toString(36) + ':' + sig.slice(0, 40);
}

const upsertProduct = db.prepare(`
INSERT INTO products (id, product_id, name, cat, sub, brand, vendor, unit, cost, pdate, pdate_ms,
                      purch_unit, purch_cost, stock, sales, stock_piece, per_default,
                      box_size, case_size, source, updated_at)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(id) DO UPDATE SET
  product_id=excluded.product_id, name=excluded.name, cat=excluded.cat, sub=excluded.sub,
  brand=excluded.brand, vendor=excluded.vendor, unit=excluded.unit, cost=excluded.cost,
  pdate=excluded.pdate, pdate_ms=excluded.pdate_ms, purch_unit=excluded.purch_unit,
  purch_cost=excluded.purch_cost, stock=excluded.stock, sales=excluded.sales,
  stock_piece=excluded.stock_piece, per_default=excluded.per_default,
  box_size=excluded.box_size, case_size=excluded.case_size, source=excluded.source,
  updated_at=excluded.updated_at`);

function importProducts(rows, source){
  const t = now();
  let count = 0;
  db.exec('BEGIN');
  try {
    for (const r of rows || []) {
      const key = rowKey(r);
      if (!key) continue;
      const ms = Number(r.pdateMs);
      upsertProduct.run(
        key, s(r.id), s(r.name), s(r.cat), s(r.sub), s(r.brand), s(r.vendor), s(r.unit),
        n(r.cost), s(r.pdate), Number.isFinite(ms) && ms > 0 ? Math.trunc(ms) : null,
        s(r.purchUnit), n(r.purchCost), n(r.stock), n(r.sales), n(r.stockPiece),
        n(r.perDefault) || 1, n(r.boxSize), n(r.caseSize), s(source), t
      );
      count++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { imported: count, total: countProducts() };
}

const countProducts = () => db.prepare('SELECT COUNT(*) c FROM products').get().c;

const SORTABLE = {
  name:'name', id:'product_id', brand:'brand', vendor:'vendor', cat:'cat', sub:'sub',
  stock:'stock', sales:'sales', cost:'cost', unit:'unit', pdate:'pdate_ms', updated:'updated_at'
};

/* Filters are composed into a parameterised WHERE — values never reach the SQL text.
   Sort direction and column are whitelisted for the same reason. */
function productWhere(f){
  const w = [], p = [];
  if (f.q) {
    /* % and _ are LIKE wildcards; a shopper typing them means the literal
       character, so escape them rather than matching everything. */
    const esc = String(f.q).replace(/[\\%_]/g, c => '\\' + c);
    const like = '%' + esc + '%';
    w.push("(name LIKE ? ESCAPE '\\' OR product_id LIKE ? ESCAPE '\\'"
         + " OR brand LIKE ? ESCAPE '\\' OR vendor LIKE ? ESCAPE '\\')");
    p.push(like, like, like, like);
  }
  if (f.cat)    { w.push('cat = ?');    p.push(f.cat); }
  if (f.sub)    { w.push('sub = ?');    p.push(f.sub); }
  if (f.brand)  { w.push('brand = ?');  p.push(f.brand); }
  if (f.vendor) { w.push('vendor = ?'); p.push(f.vendor); }
  if (f.stock === 'in')   w.push('stock > 0');
  if (f.stock === 'out')  w.push('stock <= 0');
  if (f.novendor === '1') w.push("vendor = ''");
  return { sql: w.length ? 'WHERE ' + w.join(' AND ') : '', params: p };
}

function listProducts(f){
  const { sql, params } = productWhere(f);
  const total = db.prepare(`SELECT COUNT(*) c FROM products ${sql}`).get(...params).c;
  const col = SORTABLE[f.sort] || 'name';
  const dir = String(f.dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  const limit = Math.min(Math.max(parseInt(f.limit, 10) || 100, 1), 500);
  const offset = Math.max(parseInt(f.offset, 10) || 0, 0);
  const rows = db.prepare(
    `SELECT * FROM products ${sql} ORDER BY ${col} ${dir} NULLS LAST, id ASC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);
  return { total, limit, offset, rows };
}

/* Every id matching the current filter — lets "select all" cover the whole
   result set, not just the page on screen. */
function productIds(f){
  const { sql, params } = productWhere(f);
  return db.prepare(`SELECT id FROM products ${sql}`).all(...params).map(r => r.id);
}

function facets(){
  const col = c => db.prepare(
    `SELECT DISTINCT ${c} v FROM products WHERE ${c} <> '' ORDER BY ${c}`
  ).all().map(r => r.v);
  return { cats: col('cat'), subs: col('sub'), brands: col('brand'), vendors: col('vendor'),
           total: countProducts() };
}

function clearProducts(){
  db.exec('DELETE FROM products');
  return { total: 0 };
}

/* ---------- purchase orders ---------- */

function listPOs(){
  return db.prepare(`
    SELECT o.*, COUNT(l.id) lines,
           COALESCE(SUM(l.qty), 0) units,
           COALESCE(SUM(l.qty * l.unit_cost), 0) value
    FROM purchase_orders o LEFT JOIN po_lines l ON l.po_id = o.id
    GROUP BY o.id ORDER BY o.updated_at DESC`).all();
}

function createPO({ name, vendor, notes }){
  const t = now();
  const info = db.prepare(
    'INSERT INTO purchase_orders (name, vendor, status, notes, created_at, updated_at) VALUES (?,?,?,?,?,?)'
  ).run(s(name).trim() || 'Untitled PO', s(vendor), 'draft', s(notes), t, t);
  return getPO(Number(info.lastInsertRowid));
}

function touchPO(id){
  db.prepare('UPDATE purchase_orders SET updated_at = ? WHERE id = ?').run(now(), id);
}

function getPO(id){
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(id);
  if (!po) return null;
  po.lines = db.prepare(`
    SELECT l.id, l.product_id, l.qty, l.unit_cost, l.note, l.created_at,
           p.product_id AS pid, p.name, p.brand, p.cat, p.sub, p.vendor, p.unit,
           p.cost, p.stock, p.sales, p.pdate, p.purch_unit, p.purch_cost,
           p.box_size, p.case_size, p.per_default
    FROM po_lines l JOIN products p ON p.id = l.product_id
    WHERE l.po_id = ? ORDER BY p.vendor, p.name`).all(id);
  return po;
}

const PATCHABLE = ['name', 'vendor', 'status', 'notes'];
function updatePO(id, body){
  const sets = [], params = [];
  for (const k of PATCHABLE) {
    if (body[k] !== undefined) { sets.push(`${k} = ?`); params.push(s(body[k])); }
  }
  if (!sets.length) return getPO(id);
  sets.push('updated_at = ?'); params.push(now(), id);
  db.prepare(`UPDATE purchase_orders SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return getPO(id);
}

function deletePO(id){
  const info = db.prepare('DELETE FROM purchase_orders WHERE id = ?').run(id);
  return { deleted: Number(info.changes) };
}

/* Adding a product already on the PO bumps its quantity rather than erroring —
   picking the same item from two different searches should accumulate. */
const addLine = db.prepare(`
INSERT INTO po_lines (po_id, product_id, qty, unit_cost, note, created_at)
VALUES (?,?,?,?,?,?)
ON CONFLICT(po_id, product_id) DO UPDATE SET qty = po_lines.qty + excluded.qty`);

function addLines(poId, items){
  if (!getPO(poId)) return null;
  const t = now();
  let added = 0, skipped = 0;
  const priceOf = db.prepare('SELECT cost FROM products WHERE id = ?');
  db.exec('BEGIN');
  try {
    for (const it of items || []) {
      const pid = s(it.product_id || it.id);
      const prod = pid && priceOf.get(pid);
      if (!prod) { skipped++; continue; }
      const qty = it.qty === undefined ? 1 : n(it.qty);
      const cost = it.unit_cost === undefined ? n(prod.cost) : n(it.unit_cost);
      addLine.run(poId, pid, qty, cost, s(it.note), t);
      added++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  touchPO(poId);
  return { added, skipped, po: getPO(poId) };
}

function updateLine(poId, lineId, body){
  const sets = [], params = [];
  if (body.qty !== undefined)       { sets.push('qty = ?');       params.push(n(body.qty)); }
  if (body.unit_cost !== undefined) { sets.push('unit_cost = ?'); params.push(n(body.unit_cost)); }
  if (body.note !== undefined)      { sets.push('note = ?');      params.push(s(body.note)); }
  if (sets.length) {
    params.push(lineId, poId);
    db.prepare(`UPDATE po_lines SET ${sets.join(', ')} WHERE id = ? AND po_id = ?`).run(...params);
    touchPO(poId);
  }
  return getPO(poId);
}

function deleteLines(poId, ids){
  if (!ids || !ids.length) return getPO(poId);
  const holes = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM po_lines WHERE po_id = ? AND id IN (${holes})`).run(poId, ...ids.map(Number));
  touchPO(poId);
  return getPO(poId);
}

function clearLines(poId){
  db.prepare('DELETE FROM po_lines WHERE po_id = ?').run(poId);
  touchPO(poId);
  return getPO(poId);
}

module.exports = {
  FILE, importProducts, listProducts, productIds, facets, countProducts, clearProducts,
  listPOs, createPO, getPO, updatePO, deletePO, addLines, updateLine, deleteLines, clearLines
};
