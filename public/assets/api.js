/* Thin wrapper over the JSON API in server.js. Every call returns parsed JSON
   and throws an Error carrying the server's message, so callers can just
   try/catch and show `e.message`. */
async function apiFetch(path, opts = {}){
  let res;
  try {
    res = await fetch(path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
  } catch (e) {
    throw new Error('Cannot reach the server. Is `npm start` running?');
  }
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { error: text.slice(0, 200) }; }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const api = {
  products: q  => apiFetch('/api/products?' + new URLSearchParams(q)),
  productIds: q=> apiFetch('/api/products/ids?' + new URLSearchParams(q)),
  facets: ()   => apiFetch('/api/products/facets'),
  import: (rows, source) => apiFetch('/api/products/import', { method:'POST', body:{ rows, source } }),
  clearProducts: () => apiFetch('/api/products', { method:'DELETE' }),

  listPOs: ()      => apiFetch('/api/pos'),
  createPO: b      => apiFetch('/api/pos', { method:'POST', body:b }),
  getPO: id        => apiFetch('/api/pos/' + id),
  updatePO: (id,b) => apiFetch('/api/pos/' + id, { method:'PATCH', body:b }),
  deletePO: id     => apiFetch('/api/pos/' + id, { method:'DELETE' }),

  addLines: (id, items, o)  => apiFetch(`/api/pos/${id}/lines`, { method:'POST', body:{ items, ...o } }),
  updateLine: (id, lid, b)  => apiFetch(`/api/pos/${id}/lines/${lid}`, { method:'PATCH', body:b }),
  deleteLines: (id, ids)    => apiFetch(`/api/pos/${id}/lines`, { method:'DELETE', body:{ ids } }),
  clearLines: id            => apiFetch(`/api/pos/${id}/lines`, { method:'DELETE', body:{ all:true } })
};

/* The PO the user is currently adding to, remembered across pages. */
const ACTIVE = 'activePO';
const activePO   = () => { const v = localStorage.getItem(ACTIVE); return v ? +v : null; };
const setActivePO = id => { if (id) localStorage.setItem(ACTIVE, id); else localStorage.removeItem(ACTIVE); };

/* ---------- shared nav + toast ---------- */
function navBar(current){
  const links = [
    ['index.html','Deadstock'], ['order.html','What to order'],
    ['catalog.html','Catalog'], ['po.html','Purchase orders']
  ];
  return links.map(([h,t]) =>
    `<a href="${h}"${h===current?' class="on"':''}>${t}</a>`).join('');
}

let toastTimer;
function toast(msg, kind){
  let el = document.getElementById('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
  el.className = 'show' + (kind ? ' ' + kind : '');
  el.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.className = '', 3200);
}
