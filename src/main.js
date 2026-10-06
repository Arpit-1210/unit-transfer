import './style.css';
import { supabase } from './supabase.js';
import { makePdf } from './pdf.js';

// ── helpers ──
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const todayIST = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
const dmy = (d) => { const [y, m, day] = String(d).slice(0, 10).split('-'); return `${day}-${m}-${y}`; };
const fmtQty = (n) => Number(n).toLocaleString('en-IN');
const VEHICLES = ['Van', 'Car', 'Truck', 'Tempo', 'Other'];
const LS_KEY = 'ut_draft_v1';

function toast(msg, type = '') {
  const t = $('#toast');
  t.textContent = msg; t.className = `toast show ${type}`;
  clearTimeout(t._t); t._t = setTimeout(() => (t.className = 'toast'), 2800);
}

// ── state ──
let units = [], products = [];
let view = 'new';
let draft = blankDraft();
let picked = null;          // product chosen in the search box
let saved = null;           // { transfer, items } after a successful save
let history = [];
let histFilter = { q: '', from: '', to: '' };
let detail = null;

function blankDraft(keep = {}) {
  return { no: '', date: todayIST(), from: keep.from || '', to: keep.to || '', vehicle_type: 'Van', vehicle_no: '', driver: '', note: '', items: [] };
}
const persistDraft = () => { try { localStorage.setItem(LS_KEY, JSON.stringify(draft)); } catch {} };
function restoreDraft() {
  try {
    const d = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    if (d && d.items && d.items.length) return { ...blankDraft(), ...d };
  } catch {}
  return blankDraft();
}

// ── data ──
async function loadBase() {
  const [u, p] = await Promise.all([
    supabase.from('ut_units').select('name').order('name'),
    supabase.from('ut_products').select('sno, name, rate').order('name').limit(2000),
  ]);
  if (u.error || p.error) throw (u.error || p.error);
  units = (u.data || []).map((x) => x.name);
  products = p.data || [];
}

async function nextNumber(date) {
  const prefix = `UT-${date.replaceAll('-', '')}-`;
  const { data } = await supabase.from('ut_transfers').select('transfer_no').like('transfer_no', prefix + '%').order('transfer_no', { ascending: false }).limit(1);
  const last = data?.[0]?.transfer_no;
  const n = last ? parseInt(last.slice(prefix.length), 10) + 1 : 1;
  return prefix + String(n).padStart(3, '0');
}

async function saveTransfer() {
  const d = draft;
  if (!d.from || !d.to) return toast('Select both units', 'error');
  if (d.from === d.to) return toast('From and To unit must be different', 'error');
  if (!d.items.length) return toast('Add at least one product', 'error');
  const btn = $('#btn-save'); btn.disabled = true; btn.textContent = 'Saving…';
  const totalQty = d.items.reduce((s, i) => s + Number(i.qty), 0);
  let no = d.no || (await nextNumber(d.date));
  const row = () => ({
    transfer_no: no, transfer_date: d.date, from_unit: d.from, to_unit: d.to,
    vehicle_type: d.vehicle_type, vehicle_no: d.vehicle_no.trim(), driver: d.driver.trim(), note: d.note.trim(),
    total_qty: totalQty, status: 'done',
  });
  let { data: t, error } = await supabase.from('ut_transfers').insert([row()]).select().single();
  if (error && error.code === '23505') { no = await nextNumber(d.date); ({ data: t, error } = await supabase.from('ut_transfers').insert([row()]).select().single()); }
  if (error) { btn.disabled = false; btn.textContent = 'Save & Download PDF'; return toast('Save failed: ' + error.message, 'error'); }
  const items = d.items.map((i, n) => ({ transfer_id: t.id, sno: i.sno, product_name: i.name, quantity: i.qty, position: n + 1 }));
  const ins = await supabase.from('ut_items').insert(items);
  if (ins.error) {
    await supabase.from('ut_transfers').delete().eq('id', t.id);
    btn.disabled = false; btn.textContent = 'Save & Download PDF';
    return toast('Save failed: ' + ins.error.message, 'error');
  }
  saved = { transfer: t, items };
  try { localStorage.removeItem(LS_KEY); } catch {}
  makePdf(t, items).save(`${t.transfer_no}.pdf`);
  render();
}

// ── navigation ──
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => { view = b.dataset.view; detail = null; render(); }));

function render() {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  if (view === 'history') return detail ? renderDetail() : renderHistory();
  return saved ? renderSaved() : renderNew();
}

// ── NEW TRANSFER ──
function unitOptions(sel, placeholder) {
  return `<option value="">${placeholder}</option>` + units.map((u) => `<option ${u === sel ? 'selected' : ''}>${esc(u)}</option>`).join('');
}

function renderNew() {
  const d = draft;
  $('#app').innerHTML = `
    <div class="card">
      <div class="logno"><div><label style="margin:0">Transfer log</label><b id="lognum">${esc(d.no || '…')}</b></div><span class="badge">Draft</span></div>
      <div class="route">
        <div><label>From unit</label><select id="f-from">${unitOptions(d.from, 'Select unit')}</select></div>
        <div class="arrow">→</div>
        <div><label>To unit</label><select id="f-to">${unitOptions(d.to, 'Select unit')}</select></div>
      </div>
      <button class="link" id="add-unit">+ Add another unit</button>
      <div class="row" style="margin-top:6px">
        <div><label>Date</label><input type="date" id="f-date" value="${d.date}" /></div>
        <div><label>Vehicle</label><select id="f-vtype">${VEHICLES.map((v) => `<option ${v === d.vehicle_type ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      </div>
      <div class="row">
        <div><label>Vehicle number (optional)</label><input id="f-vno" value="${esc(d.vehicle_no)}" placeholder="JH 01 AB 1234" /></div>
        <div><label>Driver (optional)</label><input id="f-driver" value="${esc(d.driver)}" placeholder="Driver name" /></div>
      </div>
    </div>

    <div class="card">
      <h2>Add products</h2>
      <div class="search-wrap">
        <label>Search product (name or code)</label>
        <input id="psearch" placeholder="Type to search ${products.length} products…" autocomplete="off" />
        <div id="presults" class="results" hidden></div>
      </div>
      <div id="pickedbox"></div>
      <div class="addrow">
        <div><label>Quantity</label><input type="number" id="pqty" inputmode="numeric" min="1" step="1" placeholder="0" /></div>
        <button class="btn add" id="btn-add">+ Add</button>
      </div>
    </div>

    <div class="card">
      <h2>Items in this transfer</h2>
      <div id="items"></div>
    </div>

    <div class="card">
      <div class="field"><label>Note (optional)</label><textarea id="f-note" rows="2" placeholder="e.g. urgent order, painting batch">${esc(d.note)}</textarea></div>
      <div class="stack">
        <button class="btn primary" id="btn-save">Save &amp; Download PDF</button>
        <button class="btn ghost" id="btn-clear">Clear</button>
      </div>
    </div>`;
  renderItems(); renderPicked();
  if (!d.no) setNumber();

  $('#f-from').onchange = (e) => { d.from = e.target.value; persistDraft(); };
  $('#f-to').onchange = (e) => { d.to = e.target.value; persistDraft(); };
  $('#f-date').onchange = (e) => { d.date = e.target.value || todayIST(); d.no = ''; persistDraft(); setNumber(); };
  $('#f-vtype').onchange = (e) => { d.vehicle_type = e.target.value; persistDraft(); };
  $('#f-vno').oninput = (e) => { d.vehicle_no = e.target.value; persistDraft(); };
  $('#f-driver').oninput = (e) => { d.driver = e.target.value; persistDraft(); };
  $('#f-note').oninput = (e) => { d.note = e.target.value; persistDraft(); };
  $('#add-unit').onclick = addUnit;
  $('#btn-add').onclick = addItem;
  $('#pqty').addEventListener('keydown', (e) => { if (e.key === 'Enter') addItem(); });
  $('#btn-save').onclick = saveTransfer;
  $('#btn-clear').onclick = () => { if (!d.items.length || confirm('Clear this transfer?')) { draft = blankDraft(); picked = null; persistDraft(); renderNew(); } };

  const s = $('#psearch'), r = $('#presults');
  s.addEventListener('input', () => {
    const q = s.value.trim().toLowerCase();
    if (!q) { r.hidden = true; return; }
    const list = products.filter((p) => p.name.toLowerCase().includes(q) || String(p.sno) === q).slice(0, 30);
    r.innerHTML = list.map((p) => `<div class="res" data-sno="${p.sno}"><span>${esc(p.name)}</span><small>#${p.sno}</small></div>`).join('') || '<div class="res">No match</div>';
    r.hidden = false;
  });
  r.addEventListener('click', (e) => {
    const el = e.target.closest('.res[data-sno]'); if (!el) return;
    picked = products.find((p) => String(p.sno) === el.dataset.sno);
    r.hidden = true; s.value = ''; renderPicked(); $('#pqty').focus();
  });
}

async function setNumber() {
  try { draft.no = await nextNumber(draft.date); persistDraft(); const el = $('#lognum'); if (el) el.textContent = draft.no; } catch {}
}

function renderPicked() {
  const box = $('#pickedbox'); if (!box) return;
  box.innerHTML = picked ? `<div class="picked"><span>${esc(picked.name)}</span><small>#${picked.sno}</small></div>` : '';
}

function addItem() {
  const qty = parseFloat($('#pqty').value);
  if (!picked) return toast('Search and select a product', 'error');
  if (!qty || qty <= 0) return toast('Enter quantity', 'error');
  const ex = draft.items.find((i) => i.sno === picked.sno);
  if (ex) ex.qty += qty; else draft.items.push({ sno: picked.sno, name: picked.name, qty });
  picked = null; $('#pqty').value = ''; persistDraft(); renderPicked(); renderItems();
  $('#psearch').focus();
}

function renderItems() {
  const el = $('#items'); if (!el) return;
  if (!draft.items.length) { el.innerHTML = '<div class="empty">No products added yet</div>'; return; }
  const total = draft.items.reduce((s, i) => s + Number(i.qty), 0);
  el.innerHTML = `<table><thead><tr><th>#</th><th>Item</th><th class="num">Qty</th><th></th></tr></thead><tbody>
    ${draft.items.map((i, n) => `<tr><td>${n + 1}</td><td>${esc(i.name)}<div style="font-size:11px;color:var(--mute)">#${i.sno}</div></td>
      <td class="num"><input type="number" min="1" data-q="${n}" value="${i.qty}" inputmode="numeric" /></td>
      <td><button class="x" data-del="${n}" aria-label="Remove">✕</button></td></tr>`).join('')}
    </tbody></table>
    <div class="summary"><span>${draft.items.length} item${draft.items.length === 1 ? '' : 's'}</span><span>Total qty: ${fmtQty(total)}</span></div>`;
  el.querySelectorAll('[data-q]').forEach((inp) => inp.addEventListener('change', () => {
    const v = parseFloat(inp.value);
    if (!v || v <= 0) { inp.value = draft.items[inp.dataset.q].qty; return toast('Quantity must be more than 0', 'error'); }
    draft.items[inp.dataset.q].qty = v; persistDraft(); renderItems();
  }));
  el.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => { draft.items.splice(+b.dataset.del, 1); persistDraft(); renderItems(); }));
}

async function addUnit() {
  const name = (prompt('New unit name (e.g. Unit 3)') || '').trim();
  if (!name) return;
  if (units.some((u) => u.toLowerCase() === name.toLowerCase())) return toast('Unit already exists', 'error');
  const { error } = await supabase.from('ut_units').insert([{ name }]);
  if (error) return toast('Could not add: ' + error.message, 'error');
  units = [...units, name].sort(); toast(`${name} added`);
  const keep = { from: draft.from, to: draft.to };
  renderNew(); $('#f-from').value = keep.from; $('#f-to').value = keep.to;
}

// ── SAVED ──
function renderSaved() {
  const { transfer: t, items } = saved;
  const total = items.reduce((s, i) => s + Number(i.quantity), 0);
  $('#app').innerHTML = `
    <div class="card success">
      <div class="big">✅</div>
      <h3>${esc(t.transfer_no)} saved</h3>
      <p>${esc(t.from_unit)} → ${esc(t.to_unit)} · ${items.length} item${items.length === 1 ? '' : 's'} · qty ${fmtQty(total)}<br/>PDF downloaded. It is also in History.</p>
      <div class="stack">
        <button class="btn primary" id="s-pdf">Download PDF again</button>
        <button class="btn ghost" id="s-new">Start a new transfer</button>
      </div>
    </div>`;
  $('#s-pdf').onclick = () => makePdf(t, items).save(`${t.transfer_no}.pdf`);
  $('#s-new').onclick = () => { draft = blankDraft({ from: t.from_unit, to: t.to_unit }); saved = null; picked = null; renderNew(); };
}

// ── HISTORY ──
async function renderHistory() {
  $('#app').innerHTML = `
    <div class="filters">
      <div class="full"><input id="h-q" placeholder="Search transfer no, vehicle, driver…" value="${esc(histFilter.q)}" /></div>
      <div><select id="h-from">${unitOptions(histFilter.from, 'From: any')}</select></div>
      <div><select id="h-to">${unitOptions(histFilter.to, 'To: any')}</select></div>
    </div>
    <div id="hlist"><div class="empty">Loading…</div></div>`;
  const reload = () => { histFilter = { q: $('#h-q').value.trim(), from: $('#h-from').value, to: $('#h-to').value }; drawHistory(); };
  $('#h-q').oninput = reload; $('#h-from').onchange = reload; $('#h-to').onchange = reload;
  const { data, error } = await supabase.from('ut_transfers').select('*').order('transfer_date', { ascending: false }).order('transfer_no', { ascending: false }).limit(500);
  if (error) { $('#hlist').innerHTML = `<div class="empty">Could not load: ${esc(error.message)}</div>`; return; }
  history = data || []; drawHistory();
}

function drawHistory() {
  const q = histFilter.q.toLowerCase();
  const rows = history.filter((t) =>
    (!histFilter.from || t.from_unit === histFilter.from) && (!histFilter.to || t.to_unit === histFilter.to) &&
    (!q || [t.transfer_no, t.vehicle_no, t.driver, t.vehicle_type, t.note].join(' ').toLowerCase().includes(q)));
  const el = $('#hlist'); if (!el) return;
  if (!rows.length) { el.innerHTML = '<div class="empty">No transfers found</div>'; return; }
  el.innerHTML = rows.map((t) => `
    <div class="card hcard" data-id="${t.id}" style="cursor:pointer">
      <div>
        <div class="no">${esc(t.transfer_no)}</div>
        <div class="route-txt">${esc(t.from_unit)} → ${esc(t.to_unit)}</div>
        <div class="meta">${dmy(t.transfer_date)} · ${esc(t.vehicle_type || '')} ${esc(t.vehicle_no || '')} · qty ${fmtQty(t.total_qty)}</div>
      </div>
      <button class="btn ghost sm" data-pdf="${t.id}">PDF</button>
    </div>`).join('');
  el.querySelectorAll('[data-pdf]').forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation(); const t = history.find((x) => x.id === b.dataset.pdf); await downloadPdf(t);
  }));
  el.querySelectorAll('.hcard').forEach((c) => c.addEventListener('click', () => openDetail(c.dataset.id)));
}

async function fetchItems(id) {
  const { data, error } = await supabase.from('ut_items').select('sno, product_name, quantity, position').eq('transfer_id', id).order('position');
  if (error) throw error; return data || [];
}
async function downloadPdf(t) {
  try { makePdf(t, await fetchItems(t.id)).save(`${t.transfer_no}.pdf`); } catch (e) { toast('Could not create PDF: ' + e.message, 'error'); }
}

async function openDetail(id) {
  const t = history.find((x) => x.id === id); if (!t) return;
  try { detail = { t, items: await fetchItems(id) }; } catch (e) { return toast('Could not load: ' + e.message, 'error'); }
  renderDetail();
}

function renderDetail() {
  const { t, items } = detail;
  const total = items.reduce((s, i) => s + Number(i.quantity), 0);
  $('#app').innerHTML = `
    <button class="link" id="d-back">← Back to history</button>
    <div class="card" style="margin-top:6px">
      <div class="logno"><b>${esc(t.transfer_no)}</b><span class="badge done">Saved</span></div>
      <table><tbody>
        <tr><td><b>Route</b></td><td>${esc(t.from_unit)} → ${esc(t.to_unit)}</td></tr>
        <tr><td><b>Date</b></td><td>${dmy(t.transfer_date)}</td></tr>
        <tr><td><b>Vehicle</b></td><td>${esc(t.vehicle_type || '-')} ${esc(t.vehicle_no || '')}</td></tr>
        <tr><td><b>Driver</b></td><td>${esc(t.driver || '-')}</td></tr>
        <tr><td><b>Note</b></td><td>${esc(t.note || '-')}</td></tr>
      </tbody></table>
    </div>
    <div class="card">
      <h2>Items</h2>
      <table><thead><tr><th>#</th><th>Item</th><th class="num">Qty</th></tr></thead><tbody>
        ${items.map((i, n) => `<tr><td>${n + 1}</td><td>${esc(i.product_name)}<div style="font-size:11px;color:var(--mute)">#${i.sno ?? ''}</div></td><td class="num">${fmtQty(i.quantity)}</td></tr>`).join('')}
      </tbody></table>
      <div class="summary"><span>${items.length} item${items.length === 1 ? '' : 's'}</span><span>Total qty: ${fmtQty(total)}</span></div>
    </div>
    <div class="stack">
      <button class="btn primary" id="d-pdf">Download PDF</button>
      <button class="btn danger" id="d-del">Delete this transfer</button>
    </div>`;
  $('#d-back').onclick = () => { detail = null; renderHistory(); };
  $('#d-pdf').onclick = () => makePdf(t, items.map((i) => ({ ...i }))).save(`${t.transfer_no}.pdf`);
  $('#d-del').onclick = async () => {
    if (!confirm(`Delete ${t.transfer_no}? This cannot be undone.`)) return;
    const { data, error } = await supabase.from('ut_transfers').delete().eq('id', t.id).select();
    if (error || !(data || []).length) return toast('Delete failed: ' + (error?.message || 'not allowed'), 'error');
    toast('Deleted'); detail = null; renderHistory();
  };
}

// ── start ──
(async function init() {
  $('#app').innerHTML = '<div class="empty">Loading…</div>';
  try { await loadBase(); }
  catch (e) { $('#app').innerHTML = `<div class="card empty">Could not connect to the database.<br/><small>${esc(e.message || e)}</small><br/><br/>Did you run sql/setup.sql in Supabase?</div>`; return; }
  draft = restoreDraft();
  render();
})();
