const http = require('http');
const fs = require('fs');
const path = require('path');
const db = require('./db');

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, 'public');
const MAX_BODY = 64 * 1024 * 1024;   // a full report import is a few MB of JSON

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const json = (res, code, body) => {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8',
                        'Content-Length': buf.length, 'Cache-Control': 'no-store' });
  res.end(buf);
};

function readBody(req){
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('Request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      try { resolve(JSON.parse(text)); }
      catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

/* ---------- API ----------
   Returns true when the request was an /api/ call and has been answered. */
async function api(req, res, url){
  const seg = url.pathname.split('/').filter(Boolean);   // ['api', ...]
  if (seg[0] !== 'api') return false;

  const m = req.method;
  const q = Object.fromEntries(url.searchParams);
  const body = (m === 'POST' || m === 'PATCH' || m === 'PUT' || m === 'DELETE')
    ? await readBody(req) : {};

  // /api/products...
  if (seg[1] === 'products') {
    if (seg[2] === 'facets' && m === 'GET') return json(res, 200, db.facets()), true;
    if (seg[2] === 'ids'    && m === 'GET') return json(res, 200, { ids: db.productIds(q) }), true;
    if (seg[2] === 'import' && m === 'POST') {
      if (!Array.isArray(body.rows)) return json(res, 400, { error: 'rows[] required' }), true;
      return json(res, 200, db.importProducts(body.rows, body.source || '')), true;
    }
    if (!seg[2] && m === 'GET')    return json(res, 200, db.listProducts(q)), true;
    if (!seg[2] && m === 'DELETE') return json(res, 200, db.clearProducts()), true;
  }

  // /api/pos...
  if (seg[1] === 'pos') {
    if (!seg[2]) {
      if (m === 'GET')  return json(res, 200, { pos: db.listPOs() }), true;
      if (m === 'POST') return json(res, 201, db.createPO(body)), true;
    } else {
      const id = Number(seg[2]);
      if (!Number.isInteger(id)) return json(res, 400, { error: 'Bad purchase order id' }), true;

      if (!seg[3]) {
        if (m === 'GET') {
          const po = db.getPO(id);
          return po ? json(res, 200, po) : json(res, 404, { error: 'No such purchase order' }), true;
        }
        if (m === 'PATCH')  return json(res, 200, db.updatePO(id, body)), true;
        if (m === 'DELETE') return json(res, 200, db.deletePO(id)), true;
      }

      if (seg[3] === 'lines') {
        if (!seg[4]) {
          if (m === 'POST') {
            const items = Array.isArray(body.items) ? body.items : [];
            const out = db.addLines(id, items);
            return out ? json(res, 200, out) : json(res, 404, { error: 'No such purchase order' }), true;
          }
          if (m === 'DELETE') {
            return json(res, 200, body.all ? db.clearLines(id)
                                           : db.deleteLines(id, body.ids || [])), true;
          }
        } else if (m === 'PATCH') {
          return json(res, 200, db.updateLine(id, Number(seg[4]), body)), true;
        }
      }
    }
  }

  return json(res, 404, { error: 'Unknown endpoint' }), true;
}

/* ---------- static ---------- */
function serveStatic(req, res, pathname){
  let rel = pathname;
  if (rel === '/' || rel === '') rel = '/index.html';

  const file = path.join(ROOT, path.normalize(rel));
  if (!file.startsWith(ROOT)) {           // block path traversal
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(buf);
  });
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  api(req, res, url)
    .then(handled => { if (!handled) serveStatic(req, res, decodeURIComponent(url.pathname)); })
    .catch(err => json(res, 400, { error: err.message || 'Request failed' }));
}).listen(PORT, () => {
  console.log(`Stock planner listening on http://localhost:${PORT}`);
  console.log(`Database: ${db.FILE} (${db.countProducts().toLocaleString()} products)`);
});
