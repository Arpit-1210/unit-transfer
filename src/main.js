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
let role = { admin: false, unit: null, email: '' };
let units = [], products = [];
let view = 'new';
let draft = blankDraft();
let picked = null;          // product chosen in the search box
let saved = null;           // { transfer, items } after a successful save
let history = [];
let histFilter = { q: '', from: '', to: '' };
let detail = null;
let edit = null;            // admin: transfer being edited

function blankDraft(keep = {}) {
  return { no: '', date: todayIST(), from: role.unit || keep.from || '', to: keep.to || '', vehicle_type: 'Van', vehicle_no: '', driver: '', note: '', items: [] };
}
const persistDraft = () => { try { localStorage.setItem(LS_KEY, JSON.stringify(draft)); } catch {} };
function restoreDraft() {
  try {
    const d = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    if (d && d.items && d.items.length) return { ...blankDraft(), ...d, from: role.unit || d.from };
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
  const { data, error } = await supabase.rpc('ut_next_no', { p_date: date });
  if (error) throw error;
  return data;
}

async function saveTransfer() {
  const d = draft;
  if (!d.from || !d.to) return toast('Select both units', 'error');
  if (d.from === d.to) return toast('From and To unit must be different', 'error');
  if (!d.items.length) return toast('Add at least one product', 'error');
  const btn = $('#btn-save'); btn.disabled = true; btn.textContent = 'Saving…';
  const { data: res, error } = await supabase.rpc('ut_save_transfer', { p: {
    transfer_date: d.date, from_unit: d.from, to_unit: d.to, vehicle_type: d.vehicle_type,
    vehicle_no: d.vehicle_no.trim(), driver: d.driver.trim(), note: d.note.trim(),
    items: d.items.map((i) => ({ sno: i.sno, name: i.name, qty: i.qty })),
  } });
  if (error) { btn.disabled = false; btn.textContent = 'Save & Download PDF'; return toast('Save failed: ' + error.message, 'error'); }
  const t = res.transfer, items = res.items;
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
        <div><label>From unit</label><select id="f-from" ${role.admin ? '' : 'disabled'}>${role.admin ? unitOptions(d.from, 'Select unit') : `<option>${esc(role.unit)}</option>`}</select></div>
        <div class="arrow">→</div>
        <div><label>To unit</label><select id="f-to">${unitOptions(d.to, 'Select unit')}</select></div>
      </div>
      ${role.admin ? '<button class="link" id="add-unit">+ Add another unit</button>' : ''}
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
      ${role.admin ? '<button class="link" id="add-product">+ Add new product to catalogue</button>' : ''}
      <div id="newprod"></div>
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

  if (role.admin) $('#f-from').onchange = (e) => { d.from = e.target.value; persistDraft(); };
  $('#f-to').onchange = (e) => { d.to = e.target.value; persistDraft(); };
  $('#f-date').onchange = (e) => { d.date = e.target.value || todayIST(); d.no = ''; persistDraft(); setNumber(); };
  $('#f-vtype').onchange = (e) => { d.vehicle_type = e.target.value; persistDraft(); };
  $('#f-vno').oninput = (e) => { d.vehicle_no = e.target.value; persistDraft(); };
  $('#f-driver').oninput = (e) => { d.driver = e.target.value; persistDraft(); };
  $('#f-note').oninput = (e) => { d.note = e.target.value; persistDraft(); };
  if (role.admin) { $('#add-unit').onclick = addUnit; $('#add-product').onclick = () => addProduct($('#psearch').value); }
  $('#btn-add').onclick = addItem;
  $('#pqty').addEventListener('keydown', (e) => { if (e.key === 'Enter') addItem(); });
  $('#btn-save').onclick = saveTransfer;
  $('#btn-clear').onclick = () => { if (!d.items.length || confirm('Clear this transfer?')) { draft = blankDraft(); picked = null; persistDraft(); renderNew(); } };

  const s = $('#psearch'), r = $('#presults');
  s.addEventListener('input', () => {
    const q = s.value.trim().toLowerCase();
    if (!q) { r.hidden = true; return; }
    const list = products.filter((p) => p.name.toLowerCase().includes(q) || String(p.sno) === q).slice(0, 30);
    r.innerHTML = list.map((p) => `<div class="res" data-sno="${p.sno}"><span>${esc(p.name)}</span><small>#${p.sno}</small></div>`).join('') || `<div class="res">No match${role.admin ? ' — use “+ Add new product to catalogue” below' : ''}</div>`;
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

async function addProduct(prefill = '') {
  const box = $('#newprod');
  if (box.innerHTML) { box.innerHTML = ''; return; }
  const { data: mx } = await supabase.from('ut_products').select('sno').order('sno', { ascending: false }).limit(1);
  const next = (mx?.[0]?.sno || 0) + 1;
  box.innerHTML = `<div class="picked" style="display:block">
    <div class="row">
      <div><label>Product code (S.NO)</label><input id="np-code" type="number" inputmode="numeric" min="1" value="${next}" /></div>
      <div><label>Product name</label><input id="np-name" value="${esc(prefill.trim())}" placeholder="e.g. Ganesh Statue 2ft" /></div>
    </div>
    <div class="stack"><button class="btn primary" id="np-save">Save product</button><button class="btn ghost" id="np-cancel">Cancel</button></div>
  </div>`;
  $('#np-cancel').onclick = () => { box.innerHTML = ''; };
  $('#np-save').onclick = async () => {
    const sno = parseInt($('#np-code').value, 10);
    const name = $('#np-name').value.trim();
    if (!sno || sno < 1) return toast('Enter a product code', 'error');
    if (!name) return toast('Enter product name', 'error');
    if (products.some((p) => p.sno === sno)) return toast(`Code ${sno} already used`, 'error');
    if (products.some((p) => p.name.toLowerCase() === name.toLowerCase())) return toast('Product name already exists', 'error');
    const { data, error } = await supabase.from('ut_products').insert([{ sno, name, rate: 0, active: true }]).select().single();
    if (error) return toast('Could not add: ' + error.message, 'error');
    products = [...products, data].sort((x, y) => x.name.localeCompare(y.name));
    picked = data; box.innerHTML = ''; $('#psearch').value = ''; $('#presults').hidden = true;
    renderPicked(); toast(`${name} (#${sno}) added to catalogue`); $('#pqty').focus();
  };
}

// ── SAVED ──
function renderSaved() {
  const { transfer: t, items } = saved;
  const total = items.reduce((s, i) => s + Number(i.quantity), 0);
  $('#app').innerHTML = `
    <div class="card success">
      <div class="big">✅</div>
      <h3>${esc(t.transfer_no)} saved</h3>
      <p>${esc(t.from_unit)} → ${esc(t.to_unit)} · ${items.length} item${items.length === 1 ? '' : 's'} · qty ${fmtQty(total)}<br/>PDF downloaded.${role.admin ? ' It is also in History.' : ''}</p>
      <div class="stack">
        <button class="btn primary" id="s-pdf">Download PDF again</button>
        <button class="btn ghost" id="s-new">Start a new transfer</button>
      </div>
    </div>`;
  $('#s-pdf').onclick = () => makePdf(t, items).save(`${t.transfer_no}.pdf`);
  $('#s-new').onclick = () => { draft = blankDraft({ from: t.from_unit, to: role.admin ? t.to_unit : '' }); saved = null; picked = null; renderNew(); };
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
        ${t.edited_at ? `<tr><td><b>Edited</b></td><td>${esc(t.edited_by || '')} · ${dmy(t.edited_at)}</td></tr>` : ''}
        ${t.created_by_email ? `<tr><td><b>Made by</b></td><td>${esc(t.created_by_email)}</td></tr>` : ''}
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
      <button class="btn ghost" id="d-edit">✏️ Edit this transfer</button>
      <button class="btn danger" id="d-del">Delete this transfer</button>
    </div>`;
  $('#d-back').onclick = () => { detail = null; renderHistory(); };
  $('#d-pdf').onclick = () => makePdf(t, items.map((i) => ({ ...i }))).save(`${t.transfer_no}.pdf`);
  $('#d-edit').onclick = startEdit;
  $('#d-del').onclick = async () => {
    if (!confirm(`Delete ${t.transfer_no}? This cannot be undone.`)) return;
    const { data, error } = await supabase.from('ut_transfers').delete().eq('id', t.id).select();
    if (error || !(data || []).length) return toast('Delete failed: ' + (error?.message || 'not allowed'), 'error');
    toast('Deleted'); detail = null; renderHistory();
  };
}


// ── ADMIN: edit a saved transfer ──
function startEdit() {
  const { t, items } = detail;
  edit = { from: t.from_unit, to: t.to_unit, date: String(t.transfer_date).slice(0, 10), vehicle_type: t.vehicle_type || 'Van', vehicle_no: t.vehicle_no || '', driver: t.driver || '', note: t.note || '',
    items: items.map((i) => ({ sno: i.sno, name: i.product_name, qty: Number(i.quantity) })) };
  renderEdit();
}

function renderEdit() {
  const { t } = detail, e = edit;
  const total = e.items.reduce((s, i) => s + Number(i.qty), 0);
  $('#app').innerHTML = `
    <button class="link" id="e-back">← Cancel editing</button>
    <div class="card" style="margin-top:6px">
      <div class="logno"><b>${esc(t.transfer_no)}</b><span class="badge">Editing</span></div>
      <div class="route">
        <div><label>From unit</label><select id="e-from">${unitOptions(e.from, 'Select unit')}</select></div>
        <div class="arrow">→</div>
        <div><label>To unit</label><select id="e-to">${unitOptions(e.to, 'Select unit')}</select></div>
      </div>
      <div class="row" style="margin-top:6px">
        <div><label>Date</label><input type="date" id="e-date" value="${e.date}" /></div>
        <div><label>Vehicle</label><select id="e-vtype">${VEHICLES.map((v) => `<option ${v === e.vehicle_type ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      </div>
      <div class="row">
        <div><label>Vehicle number</label><input id="e-vno" value="${esc(e.vehicle_no)}" /></div>
        <div><label>Driver</label><input id="e-driver" value="${esc(e.driver)}" /></div>
      </div>
      <div class="field"><label>Note</label><textarea id="e-note" rows="2">${esc(e.note)}</textarea></div>
    </div>
    <div class="card">
      <h2>Items</h2>
      ${e.items.length ? `<table><thead><tr><th>#</th><th>Item</th><th class="num">Qty</th><th></th></tr></thead><tbody>
        ${e.items.map((i, n) => `<tr><td>${n + 1}</td><td>${esc(i.name)}<div style="font-size:11px;color:var(--mute)">#${i.sno ?? ''}</div></td>
          <td class="num"><input type="number" min="1" data-eq="${n}" value="${i.qty}" inputmode="numeric" /></td>
          <td><button class="x" data-edel="${n}" aria-label="Remove">✕</button></td></tr>`).join('')}
      </tbody></table>
      <div class="summary"><span>${e.items.length} item${e.items.length === 1 ? '' : 's'}</span><span>Total qty: ${fmtQty(total)}</span></div>` : '<div class="empty">No items</div>'}
      <div class="addrow" style="margin-top:12px">
        <div><label>Add product</label><input id="e-prod" list="e-plist" placeholder="Type product name…" autocomplete="off" /><datalist id="e-plist">${products.map((p) => `<option value="${esc(p.name)}"></option>`).join('')}</datalist></div>
        <div><label>Qty</label><input type="number" id="e-pqty" inputmode="numeric" min="1" placeholder="0" style="width:90px" /></div>
        <button class="btn add" id="e-add">+ Add</button>
      </div>
    </div>
    <div class="stack"><button class="btn primary" id="e-save">Save changes</button><button class="btn ghost" id="e-cancel">Cancel</button></div>`;
  const grab = () => { e.from = $('#e-from').value; e.to = $('#e-to').value; e.date = $('#e-date').value; e.vehicle_type = $('#e-vtype').value; e.vehicle_no = $('#e-vno').value; e.driver = $('#e-driver').value; e.note = $('#e-note').value; };
  $('#e-back').onclick = $('#e-cancel').onclick = () => { edit = null; renderDetail(); };
  document.querySelectorAll('[data-eq]').forEach((inp) => inp.addEventListener('change', () => {
    const v = parseFloat(inp.value);
    if (!v || v <= 0) { inp.value = e.items[inp.dataset.eq].qty; return toast('Quantity must be more than 0', 'error'); }
    grab(); e.items[inp.dataset.eq].qty = v; renderEdit();
  }));
  document.querySelectorAll('[data-edel]').forEach((b) => b.addEventListener('click', () => { grab(); e.items.splice(+b.dataset.edel, 1); renderEdit(); }));
  $('#e-add').onclick = () => {
    const p = products.find((x) => x.name.toLowerCase() === $('#e-prod').value.trim().toLowerCase());
    const qty = parseFloat($('#e-pqty').value);
    if (!p) return toast('Pick a product from the list', 'error');
    if (!qty || qty <= 0) return toast('Enter quantity', 'error');
    grab();
    const ex = e.items.find((i) => i.sno === p.sno);
    if (ex) ex.qty += qty; else e.items.push({ sno: p.sno, name: p.name, qty });
    renderEdit();
  };
  $('#e-save').onclick = async () => {
    grab();
    if (!e.from || !e.to || e.from === e.to) return toast('From and To unit must be different', 'error');
    if (!e.items.length) return toast('Add at least one product', 'error');
    const btn = $('#e-save'); btn.disabled = true; btn.textContent = 'Saving…';
    const { data: res, error } = await supabase.rpc('ut_update_transfer', { p_id: t.id, p: {
      transfer_date: e.date, from_unit: e.from, to_unit: e.to, vehicle_type: e.vehicle_type, vehicle_no: e.vehicle_no.trim(),
      driver: e.driver.trim(), note: e.note.trim(), items: e.items.map((i) => ({ sno: i.sno, name: i.name, qty: i.qty })) } });
    if (error) { btn.disabled = false; btn.textContent = 'Save changes'; return toast('Save failed: ' + error.message, 'error'); }
    const i = history.findIndex((x) => x.id === t.id); if (i >= 0) history[i] = res.transfer;
    detail = { t: res.transfer, items: res.items }; edit = null;
    toast('Changes saved ✓'); renderDetail();
  };
}

// ── login ──
function showLogin() {
  document.querySelector('.tabs').hidden = true; $('#logout').hidden = true;
  $('#app').innerHTML = `
    <form class="card login" id="login-form" autocomplete="on">
      <h2>🔒 Sign in</h2>
      <p>Enter your login ID and password to continue.</p>
      <div class="field"><label>Login ID</label><input id="l-email" type="email" name="username" autocomplete="username" inputmode="email" placeholder="name@gfpl.com" required /></div>
      <div class="field"><label>Password</label><div class="pwwrap"><input id="l-pass" type="password" name="password" autocomplete="current-password" required /><button type="button" id="l-show">Show</button></div></div>
      <div class="err" id="l-err"></div>
      <button class="btn primary" id="l-go" type="submit">Sign in</button>
    </form>`;
  $('#l-show').onclick = () => { const i = $('#l-pass'); const s = i.type === 'password'; i.type = s ? 'text' : 'password'; $('#l-show').textContent = s ? 'Hide' : 'Show'; };
  $('#login-form').onsubmit = async (e) => {
    e.preventDefault();
    const btn = $('#l-go'); btn.disabled = true; btn.textContent = 'Signing in…'; $('#l-err').textContent = '';
    const { error } = await supabase.auth.signInWithPassword({ email: $('#l-email').value.trim(), password: $('#l-pass').value });
    if (error) { btn.disabled = false; btn.textContent = 'Sign in'; $('#l-err').textContent = /invalid login credentials/i.test(error.message) ? 'Wrong login ID or password' : error.message; return; }
    startApp();
  };
}

async function startApp() {
  $('#app').innerHTML = '<div class="empty">Loading…</div>';
  const { data: u } = await supabase.auth.getUser();
  const email = (u?.user?.email || '').toLowerCase();
  const m = email.match(/^unit(\d+)@gfpl\.com$/);
  role = { admin: email === 'admin@gfpl.com', unit: m ? 'Unit ' + m[1] : null, email };
  $('#logout').hidden = false;
  if (!role.admin && !role.unit) { document.querySelector('.tabs').hidden = true; $('#app').innerHTML = '<div class="card empty">This login is not allowed to use Unit Transfer.<br/>Ask the owner.</div>'; return; }
  document.querySelector('.tabs').hidden = !role.admin;   // unit users only see the entry screen
  try { await loadBase(); }
  catch (e) { $('#app').innerHTML = `<div class="card empty">Could not connect to the database.<br/><small>${esc(e.message || e)}</small><br/><br/>Did you run the SQL setup files in Supabase?</div>`; return; }
  draft = restoreDraft(); view = 'new'; detail = null; edit = null; saved = null;
  render();
}

$('#logout').onclick = async () => { await supabase.auth.signOut(); showLogin(); };

// ── start ──
(async function init() {
  const { data } = await supabase.auth.getSession();
  if (data?.session) startApp(); else showLogin();
  supabase.auth.onAuthStateChange((ev) => { if (ev === 'SIGNED_OUT') showLogin(); });
})();
