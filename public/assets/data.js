/* Shared across pages: file parsing, the row model, formatting, charts, tooltip.
   Page-specific rules live in each page's own script. */

let ROWS = [];

/* ---------- helpers ---------- */
function num(v){ const n=parseFloat(String(v??'').replace(/[, ]/g,'')); return isFinite(n)?n:0; }
const esc = s => String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmt = n => !isFinite(n) ? '∞'
  : Math.abs(n)>=1e6 ? (n/1e6).toFixed(1)+'M'
  : Math.abs(n)>=1e3 ? (n/1e3).toFixed(1)+'k'
  : Math.round(n).toLocaleString();

/* ---------- parsing ---------- */
function parseCSV(text){
  const out=[]; let row=[], cur='', q=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(q){ if(c==='"'){ if(text[i+1]==='"'){cur+='"';i++;} else q=false; } else cur+=c; }
    else if(c==='"') q=true;
    else if(c===','){ row.push(cur); cur=''; }
    else if(c==='\n'){ row.push(cur); out.push(row); row=[]; cur=''; }
    else if(c!=='\r') cur+=c;
  }
  if(cur!==''||row.length){ row.push(cur); out.push(row); }
  return out;
}
function parseHTMLTable(text){
  const doc = new DOMParser().parseFromString(text,'text/html');
  const out=[];
  doc.querySelectorAll('tr').forEach(tr=>{
    const cs=[...tr.querySelectorAll('td,th')].map(td=>td.textContent.trim());
    if(cs.length) out.push(cs);
  });
  return out;
}

function ingest(matrix){
  const head = matrix[0].map(h=>h.trim());
  const idx = name => head.findIndex(h=>h.toLowerCase().replace(/[^a-z]/g,'')===name);
  const iStock = idx('currentstockindefaultunit');
  const iSales = idx('salesindefaultunit');
  if(iStock<0 || iSales<0){
    alert('Could not find the "Current Stock In Default Unit" and "Sales In Default Unit" columns.');
    return false;
  }
  const col = {
    id:idx('productid'), cat:idx('categoryname'), sub:idx('subcategoryname'),
    brand:idx('brandname'), name:idx('productname'), unit:idx('unittype'),
    vend:idx('purchasevendor'), cost:idx('lastpurchasepriceindefaultunit'),
    pdate:idx('purchasedate'), pqty:idx('purchasequantity'), punit:idx('purchaseunittype'),
    pcost:idx('purchaseunitcostprice'), spiece:idx('stockinpiece'),
    piece:idx('piece'), box:idx('box'), kase:idx('case')
  };
  const g=(r,i)=> i>=0 ? (r[i]||'') : '';
  ROWS = matrix.slice(1).filter(r=>r.length>=head.length-2).map((r,n)=>{
    const stock=num(r[iStock]), sales=num(r[iSales]);
    const stockPiece=num(g(r,col.spiece));
    return {
      key: g(r,col.id) || ('row'+n),
      id: g(r,col.id), cat:g(r,col.cat), sub:g(r,col.sub), brand:g(r,col.brand),
      name:g(r,col.name), unit:g(r,col.unit), vendor:g(r,col.vend),
      cost:num(g(r,col.cost)), pdate:g(r,col.pdate),
      purchUnit:g(r,col.punit), purchCost:num(g(r,col.pcost)),
      stock, sales, stockPiece,
      /* pieces per one default unit — lets us convert an order into boxes/cases */
      perDefault: (stock>0 && stockPiece>0) ? stockPiece/stock : 1,
      boxSize:num(g(r,col.box)), caseSize:num(g(r,col.kase)),
      ratio: stock>0 ? (sales/stock*100) : (sales>0?Infinity:0),
      excess: stock - sales
    };
  });
  return ROWS.length>0;
}

/* ---------- file loading (shared by both pages) ---------- */
function readReport(file, done){
  const fr=new FileReader();
  fr.onload=()=>{
    const text=fr.result;
    let matrix;
    if(/\.csv$/i.test(file.name)) matrix=parseCSV(text);
    else if(/<t[rd]/i.test(text)) matrix=parseHTMLTable(text);
    else { alert('Unsupported file. Export the report as .xls (HTML) or .csv.'); return; }
    if(!matrix || matrix.length<2){ alert('No rows found in that file.'); return; }
    if(!ingest(matrix)) return;
    cacheReport(file.name);
    done(file.name);
  };
  fr.readAsText(file);
}

/* Keep the parsed report for the other page, so one upload serves both.
   sessionStorage is capped (~5MB) — if it overflows we just drop the cache
   and the other page asks for the file again. */
function cacheReport(name){
  try{
    sessionStorage.setItem('rpt', JSON.stringify({name, rows:ROWS}));
  }catch(e){ try{ sessionStorage.removeItem('rpt'); }catch(_){} }
}
function loadCachedReport(){
  try{
    const s=JSON.parse(sessionStorage.getItem('rpt')||'null');
    if(s && s.rows && s.rows.length){ ROWS=s.rows; return s.name; }
  }catch(e){}
  return null;
}

/* ---------- wiring for the drop zone + file input ---------- */
function wireLoader({input, dropzone, onload}){
  const handle = f => readReport(f, onload);
  input.addEventListener('change', e=>{ if(e.target.files[0]) handle(e.target.files[0]); });
  if(dropzone){
    ['dragenter','dragover'].forEach(ev=>dropzone.addEventListener(ev,e=>{e.preventDefault();dropzone.classList.add('over');}));
    ['dragleave','drop'].forEach(ev=>dropzone.addEventListener(ev,e=>{e.preventDefault();dropzone.classList.remove('over');}));
    dropzone.addEventListener('drop',e=>{ const f=e.dataTransfer.files[0]; if(f) handle(f); });
    dropzone.addEventListener('click',()=>input.click());
  }
}

/* ---------- grouping ---------- */
function group(rows, keyfn, valfn){
  const m=new Map();
  rows.forEach(r=>{
    const k=(keyfn(r)||'').trim() || '(none)';
    const o=m.get(k) || {k, v:0, n:0}; o.v+=valfn(r); o.n++; m.set(k,o);
  });
  return [...m.values()];
}
/* rank and keep the head; the tail is reported in the caption, not drawn as a
   dominating "Other" bar that would outrank every real entry */
function topN(list, n){
  list.sort((a,b)=>b.v-a.v);
  const head=list.slice(0,n), tail=list.slice(n);
  head.rest = {count:tail.length, v:tail.reduce((s,o)=>s+o.v,0), total:list.length};
  return head;
}
function tailCap(rows, noun, one, what){
  const r=rows.rest;
  if(!r || !r.count) return rows.length===1 ? `The only ${one}, by ${what}`
                                            : `All ${rows.length} ${noun}, by ${what}`;
  return `Top ${rows.length} of ${r.total} ${noun} — ${fmt(r.v)} more across the other ${r.count}`;
}

/* ---------- tooltip ---------- */
let tipEl;
function tipInit(){ tipEl = document.getElementById('tip'); }
function tipOn(e,html){ tipEl.innerHTML=html; tipEl.style.opacity=1; tipMove(e); }
function tipMove(e){
  const r=tipEl.getBoundingClientRect();
  tipEl.style.left = Math.min(e.clientX+14, innerWidth-r.width-10)+'px';
  tipEl.style.top  = Math.min(e.clientY+14, innerHeight-r.height-10)+'px';
}
function tipOff(){ tipEl.style.opacity=0; }
function bindTips(scope){
  scope.querySelectorAll('path[data-t]').forEach(el=>{
    el.addEventListener('mouseenter',e=>tipOn(e, el.dataset.t));
    el.addEventListener('mousemove',tipMove);
    el.addEventListener('mouseleave',tipOff);
  });
}

/* ---------- chart primitives (rounded on the value end, square on the baseline) ---------- */
function hbar(x,y,w,h,r){
  r=Math.min(r,w);
  return `M${x},${y}h${w-r}a${r},${r} 0 0 1 ${r},${r}v${h-2*r}a${r},${r} 0 0 1 ${-r},${r}h${-(w-r)}z`;
}
function vbar(x,y,w,h,r){
  r=Math.min(r,h,w/2);
  return `M${x},${y+h}v${-(h-r)}a${r},${r} 0 0 1 ${r},${-r}h${w-2*r}a${r},${r} 0 0 1 ${r},${r}v${h-r}z`;
}
function barChart(el, rows, {title, cap, unit}){
  if(!rows.length){ el.innerHTML = `<h3>${title}</h3><div class="cap">${cap}</div><div class="empty">No data</div>`; return; }
  const LBL=138, PAD=8, RIGHT=52, BH=17, GAP=9;
  const W=520, H=rows.length*(BH+GAP)+18;
  const max=Math.max(...rows.map(r=>r.v))||1;
  const plot=W-LBL-RIGHT;
  const bars=rows.map((r,i)=>{
    const y=i*(BH+GAP), w=Math.max(2, r.v/max*plot);
    const label=r.k.length>22 ? r.k.slice(0,21)+'…' : r.k;
    return `<text class="cat" x="${LBL-PAD}" y="${y+BH/2+4}" text-anchor="end">${esc(label)}</text>
      <path class="bar" d="${hbar(LBL,y,w,BH,4)}"
        data-t="<b>${esc(r.k)}</b><div class='t2'>${fmt(r.v)} ${unit}<br>${r.n.toLocaleString()} products</div>"></path>
      <text class="val" x="${LBL+w+7}" y="${y+BH/2+4}">${fmt(r.v)}</text>`;
  }).join('');
  el.innerHTML = `<h3>${title}</h3><div class="cap">${cap}</div>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${title}">
      <line class="gl" x1="${LBL}" y1="0" x2="${LBL}" y2="${rows.length*(BH+GAP)-GAP}"/>${bars}</svg>`;
}
function colChart(el, bins, {title, cap, xlab}){
  const W=520, H=190, L=34, B=34, T=14, R=6;
  const max=Math.max(...bins.map(b=>b.n))||1;
  const pw=W-L-R, ph=H-B-T, bw=pw/bins.length;
  const ticks=[0,.5,1].map(f=>{
    const y=T+ph-f*ph;
    return `<line class="gl" x1="${L}" y1="${y}" x2="${W-R}" y2="${y}"/>
            <text class="axl" x="${L-6}" y="${y+3}" text-anchor="end">${fmt(max*f)}</text>`;
  }).join('');
  const cols=bins.map((b,i)=>{
    const h=Math.max(1, b.n/max*ph), x=L+i*bw+2, w=bw-4;
    return `<path class="bar" d="${vbar(x,T+ph-h,w,h,4)}" data-t="${b.tip}"></path>
      <text class="axl" x="${x+w/2}" y="${T+ph+14}" text-anchor="middle">${esc(b.short)}</text>
      <text class="val" x="${x+w/2}" y="${T+ph-h-5}" text-anchor="middle">${b.n?fmt(b.n):''}</text>`;
  }).join('');
  el.innerHTML = `<h3>${title}</h3><div class="cap">${cap}</div>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${title}">${ticks}${cols}
      <text class="axl" x="${L+pw/2}" y="${H-3}" text-anchor="middle">${esc(xlab)}</text></svg>`;
}

/* ---------- CSV export ---------- */
function downloadCSV(filename, header, rows){
  const q = v => `"${String(v??'').replace(/"/g,'""')}"`;
  const body=[header.map(q).join(',')].concat(rows.map(r=>r.map(q).join(',')));
  const url=URL.createObjectURL(new Blob([body.join('\n')],{type:'text/csv'}));
  const a=document.createElement('a'); a.href=url; a.download=filename; a.click();
  URL.revokeObjectURL(url);
}
