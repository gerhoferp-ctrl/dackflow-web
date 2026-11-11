/* DäckFlow web app – LYFT (tyre hotel scanner) and KUNDMOTTAGARE (queue). */
'use strict';

const VERSION = '2.1.0';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/** Tiny element builder. Strings become text nodes (never HTML). */
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'html') e.innerHTML = v; // only used with our own static markup
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k instanceof Node ? k : String(k));
  return e;
}
const sv = new Intl.NumberFormat('sv-SE');
const fmt = (n) => sv.format(n);
const mm = (n) => n.toFixed(1).replace('.', ',');
const timeFmt = (t) => new Date(t).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
const dateTimeFmt = (t) => new Date(t).toLocaleString('sv-SE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function normPlate(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9ÅÄÖ]/g, ''); }
function spaced(p) {
  const n = normPlate(p);
  return /^[A-Z]{3}[0-9]{2}[A-Z0-9]$/.test(n) ? n.slice(0, 3) + ' ' + n.slice(3) : String(p || '').trim();
}
function initials(name) {
  const w = String(name || '').split(/[\s,]+/).filter((x) => /\p{L}/u.test(x));
  return ((w[0] || '?')[0] + (w.length > 1 ? w[w.length - 1][0] : '')).toUpperCase();
}
function plateEl(plate, cc = 'S', big = false) {
  return h('span', { class: 'plate' + (big ? ' big' : '') }, h('span', { class: 'eu' }, cc), h('span', { class: 'num' }, plate));
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3200);
}

/* ---------------- storage ---------------- */
const ls = {
  get(k, d) { try { const v = localStorage.getItem('df.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('df.' + k, JSON.stringify(v)); } catch { /* full or blocked */ } },
};
const idb = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((res, rej) => {
      const r = indexedDB.open('dackflow', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => { this.db = r.result; res(this.db); };
      r.onerror = () => rej(r.error);
    });
  },
  async get(k) {
    const db = await this.open();
    return new Promise((res, rej) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  },
  async set(k, v) {
    const db = await this.open();
    return new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
  },
};

const Settings = {
  get name() { return ls.get('settings', {}).name || ''; },
  get start() { return ls.get('settings', {}).start || 'home'; },
  save(name, start) { ls.set('settings', { name: name.trim(), start }); },
};

/* ---------------- tyre hotel data ---------------- */
const Store = {
  rows: [], index: new Map(), meta: null,
  async load() {
    try {
      const d = await idb.get('plates');
      if (d && d.rows) this.setRows(d.rows, d.meta);
    } catch { /* first start */ }
  },
  setRows(rows, meta) {
    this.rows = rows; this.meta = meta;
    this.index = new Map(rows.map((p) => [p.norm, p]));
  },
  find(n) { return this.index.get(n) || null; },
  near(n) {
    if (n.length < 4) return [];
    return this.rows.filter((r) => {
      if (r.norm.length !== n.length) return false;
      let d = 0;
      for (let i = 0; i < n.length; i++) if (r.norm[i] !== n[i] && ++d > 1) return false;
      return d === 1;
    }).sort((a, b) => (Matcher.isSwap(n, a.norm) ? 0 : 1) - (Matcher.isSwap(n, b.norm) ? 0 : 1));
  },
  search(q) {
    const n = normPlate(q), lc = q.trim().toLowerCase();
    if (!n && lc.length < 3) return [];
    const ex = [], st = [], co = [], nm = [];
    for (const r of this.rows) {
      if (n && r.norm === n) ex.push(r);
      else if (n && r.norm.startsWith(n)) st.push(r);
      else if (n && r.norm.includes(n)) co.push(r);
      else if (lc.length >= 3 && (r.customer.toLowerCase().includes(lc) || r.contact.toLowerCase().includes(lc) || r.phone.replace(/\s/g, '').includes(lc.replace(/\s/g, '')))) nm.push(r);
    }
    return [...ex, ...st, ...co, ...nm];
  },
  sameCustomer(p) {
    return this.rows.filter((r) => (isPrivate(p) || !p.customerNo)
      ? r.contact && r.contact === p.contact && r.phone === p.phone
      : r.customerNo === p.customerNo);
  },
};
const isPrivate = (p) => /privatkund/i.test(p.customer);
const displayName = (p) => (isPrivate(p) && p.contact) ? p.contact : (p.customer || p.contact);
const isWinter = (s) => /winter/i.test(s.season);
const seasonLabel = (s) => /winter/i.test(s.season) ? 'Vinterdäck' : /summer/i.test(s.season) ? 'Sommardäck' : 'Däck';
function wantWinter() { const m = new Date().getMonth(); return m >= 7 || m === 0; }
function primary(p) {
  if (!p.sets.length) return null;
  if (p.sets.length === 1) return p.sets[0];
  return p.sets.find((s) => isWinter(s) === wantWinter()) || p.sets[0];
}
const tyreSize = (t) => !t.w ? '' : (!t.r ? `${t.w} R${t.rim}` : `${t.w}/${t.r} R${t.rim}`);
const treadColor = (v) => v == null ? '#3A4458' : v < 3 ? '#D93025' : v <= 5 ? '#F29900' : '#1E8E3E';

function cellStr(v) {
  if (v == null) return '';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (v instanceof Date) return isNaN(v) ? '' : v.toISOString().slice(0, 10);
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(+v.toFixed(4));
  return String(v);
}

function parseWorkbook(buf) {
  const wb = XLSX.read(buf, { type: 'array', cellDates: true, dense: true });
  for (const name of wb.SheetNames) {
    const table = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null, blankrows: false }).map((r) => r.map(cellStr));
    let header = -1, cols = {};
    for (let i = 0; i < Math.min(table.length, 15); i++) {
      const names = table[i].map((x) => x.trim().toLowerCase());
      if (names.some((x) => ['licenseplate', 'vehicle', 'regnr', 'fordon'].includes(x))) {
        header = i;
        names.forEach((x, j) => { if (x) (cols[x] = cols[x] || []).push(j); });
        break;
      }
    }
    if (header < 0) continue;
    const rows = cols.licenseplate ? parseComplete(table, header, cols) : parseSimple(table, header, cols);
    if (rows.length) return rows;
  }
  return [];
}

function parseSimple(table, header, cols) {
  const c = (...n) => { for (const x of n) if (cols[x]) return cols[x][0]; return -1; };
  const cPlate = c('vehicle', 'regnr', 'fordon');
  const placeKey = Object.keys(cols).find((k) => /stock ?place|lagerplats|plats|hylla/.test(k));
  const cPlace = placeKey ? cols[placeKey][0] : -1;
  const cCust = c('customer', 'kund'), cCont = c('contact', 'kontakt'), cPhone = c('phone', 'telefon');
  const out = new Map();
  for (let i = header + 1; i < table.length; i++) {
    const r = table[i], p = (r[cPlate] || '').trim();
    if (!p) continue;
    const n = normPlate(p), set = { season: '', place: r[cPlace] || '', tyres: [], alloy: null, note: '' };
    if (out.has(n)) out.get(n).sets.push(set);
    else out.set(n, { plate: p, norm: n, customer: r[cCust] || '', customerNo: '', contact: r[cCont] || '', phone: r[cPhone] || '', email: '', vehicle: '', agreement: '', note: '', address: '', since: '', sets: [set] });
  }
  return [...out.values()];
}

function parseComplete(table, header, cols) {
  const all = (n) => cols[n.toLowerCase()] || [];
  const one = (n) => (cols[n.toLowerCase()] || [-1])[0];
  const C = {};
  for (const k of ['LicensePlate', 'SeasonName', 'Position', 'SectionWidth', 'AspectRatio', 'RimDiameter', 'TreadDepth', 'TyreMake', 'Pattern', 'Studs', 'AlloyRim', 'Note', 'PlaceId', 'StockPlaceName', 'CustomerName', 'CustomerNumber', 'ContactName', 'VehicleMake', 'Debitmodel', 'InternalNote', 'ContactPostalCode', 'ContactTown', 'CustomerPostalCode', 'CustomerTown', 'Created']) C[k] = one(k);
  const phoneCols = [...all('ContactMobile'), ...all('ContactPhone'), ...all('CustomerPhone')];
  const mailCols = [...all('ContactEmail'), ...all('CustomerEmail')];
  const cAddr = all('ContactAddress'), kAddr = all('CustomerAddress');
  const firstOf = (r, list) => { for (const i of list) { const v = (r[i] || '').trim(); if (v) return v; } return ''; };
  const by = new Map();
  for (let i = header + 1; i < table.length; i++) {
    const r = table[i], plate = (r[C.LicensePlate] || '').trim();
    if (!plate) continue;
    const n = normPlate(plate) || plate.toUpperCase();
    let a = by.get(n);
    if (!a) by.set(n, a = { first: r, sets: new Map(), notes: new Set(), created: '' });
    const inote = (r[C.InternalNote] || '').trim();
    if (inote) a.notes.add(inote);
    const cr = r[C.Created] || '';
    if (cr.length >= 4 && (!a.created || cr < a.created)) a.created = cr;
    const key = (r[C.PlaceId] || '') + '|' + (r[C.SeasonName] || '');
    let s = a.sets.get(key);
    if (!s) a.sets.set(key, s = { season: r[C.SeasonName] || '', place: (r[C.StockPlaceName] || '').trim(), tyres: [], alloy: null, note: '' });
    if (r[C.AlloyRim]) s.alloy = /^true$/i.test(r[C.AlloyRim]);
    const note = (r[C.Note] || '').trim();
    if (note && !s.note) s.note = note;
    const pos = r[C.Position] || '';
    if (pos || r[C.SectionWidth]) {
      const tr = parseFloat(String(r[C.TreadDepth] || '').replace(',', '.'));
      s.tyres.push({ pos, w: r[C.SectionWidth] || '', r: r[C.AspectRatio] || '', rim: r[C.RimDiameter] || '', tread: isNaN(tr) ? null : tr, make: r[C.TyreMake] || '', pattern: r[C.Pattern] || '', studs: /^true$/i.test(r[C.Studs] || '') });
    }
  }
  const addr = (r, lines, zip, town) => {
    const street = lines.map((i) => (r[i] || '').trim()).filter(Boolean).join(', ');
    const place = [r[zip], r[town]].map((x) => (x || '').trim()).filter(Boolean).join(' ');
    return [street, place].filter(Boolean).join(', ');
  };
  return [...by.values()].map((a) => {
    const r = a.first, plate = r[C.LicensePlate].trim();
    return {
      plate, norm: normPlate(plate) || plate.toUpperCase(),
      customer: r[C.CustomerName] || '', customerNo: r[C.CustomerNumber] || '', contact: r[C.ContactName] || '',
      phone: firstOf(r, phoneCols), email: firstOf(r, mailCols), vehicle: (r[C.VehicleMake] || '').trim(),
      agreement: r[C.Debitmodel] || '', note: [...a.notes].join(' · '),
      address: addr(r, cAddr, C.ContactPostalCode, C.ContactTown) || addr(r, kAddr, C.CustomerPostalCode, C.CustomerTown),
      since: a.created.slice(0, 4),
      sets: [...a.sets.values()].map((s) => ({ ...s, tyres: s.tyres.sort((x, y) => (parseInt(x.pos) || 99) - (parseInt(y.pos) || 99)) })),
    };
  });
}

function pickDataFile() {
  const inp = h('input', { type: 'file', accept: '.xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel' });
  inp.addEventListener('change', async () => {
    const f = inp.files && inp.files[0];
    if (!f) return;
    setStatus(false, 'Läser ' + f.name + ' …');
    try {
      const rows = parseWorkbook(await f.arrayBuffer());
      if (!rows.length) throw new Error('Hittade inga regnummer i filen. Finns kolumnen «LicensePlate» eller «Vehicle»?');
      const meta = { name: f.name, at: Date.now() };
      Store.setRows(rows, meta);
      await idb.set('plates', { rows, meta });
      toast(`${fmt(rows.length)} bilar inlästa från ${f.name}`);
    } catch (e) {
      toast(e.message || 'Kunde inte läsa filen');
    }
    renderLiftStatus();
  });
  inp.click();
}

/* ---------------- OCR plate matcher ---------------- */
const Matcher = {
  toL: { 0: 'O', 1: 'I', 8: 'B', 5: 'S', 2: 'Z', 6: 'G', 4: 'A', 7: 'T' },
  toD: { O: '0', Q: '0', D: '0', I: '1', L: '1', B: '8', S: '5', Z: '2', G: '6', A: '4', T: '7' },
  pairs: new Set(['0O', 'O0', '1I', 'I1', '8B', 'B8', '5S', 'S5', '2Z', 'Z2', '6G', 'G6', '0D', 'D0', '0Q', 'Q0', '4A', 'A4', '7T', 'T7']),
  isSwap(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && !this.pairs.has(a[i] + b[i])) return false;
    return true;
  },
  candidates(lines, known) {
    const out = new Set();
    const joined = lines.map((l) => normPlate(l).replace(/[ÅÄ]/g, 'A').replace(/Ö/g, 'O'));
    const n0 = joined.length;
    for (let i = 0; i < n0 - 1; i++) joined.push(joined[i] + joined[i + 1]);
    for (const s of joined) {
      if (s.length >= 5 && s.length <= 8 && known(s)) out.add(s);
      for (let st = 0; st + 6 <= s.length; st++) {
        const w = s.substr(st, 6).split('');
        for (let k = 0; k < 3; k++) w[k] = this.toL[w[k]] || w[k];
        for (let k = 3; k < 5; k++) w[k] = this.toD[w[k]] || w[k];
        const c = w.join('');
        if (/^[A-Z]{3}[0-9]{2}[A-Z0-9]$/.test(c)) {
          out.add(c);
          if (this.toD[c[5]]) out.add(c.slice(0, 5) + this.toD[c[5]]);
          if (this.toL[c[5]]) out.add(c.slice(0, 5) + this.toL[c[5]]);
        }
      }
    }
    return [...out];
  },
};

/* ---------------- camera scanner ---------------- */
let ocrWorker = null, ocrLoading = null;
function getWorker() {
  if (ocrWorker) return Promise.resolve(ocrWorker);
  if (!ocrLoading) {
    ocrLoading = Tesseract.createWorker('eng', 1, {}).then(async (w) => {
      await w.setParameters({ tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ', tessedit_pageseg_mode: '7' });
      ocrWorker = w;
      return w;
    }).catch((e) => { ocrLoading = null; throw e; });
  }
  return ocrLoading;
}

class Scanner {
  constructor(cam, onPlate, known) {
    this.cam = cam; this.onPlate = onPlate; this.known = known;
    this.video = $('video', cam); this.frame = $('.frame', cam);
    this.live = $('.live', cam); this.msg = $('.cam-msg', cam); this.btn = $('.cam-start', cam);
    this.canvas = document.createElement('canvas');
    this.btn.addEventListener('click', () => this.start());
    this.running = false;
  }
  async start() {
    this.stop();
    this.running = true; this.last = null; this.count = 0;
    this.live.hidden = true; this.btn.hidden = true;
    this.msg.textContent = 'Startar kameran …';
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
      if (!this.running) { this.stream.getTracks().forEach((t) => t.stop()); return; }
      this.video.srcObject = this.stream;
      await this.video.play().catch(() => {});
      this.msg.textContent = 'Laddar textigenkänning …';
      await getWorker();
      if (!this.running) return;
      this.msg.textContent = 'Rikta kameran mot skylten';
      this.loop();
    } catch (e) {
      this.running = false;
      this.msg.textContent = e && e.name === 'NotAllowedError' ? 'Kameran är inte tillåten – skriv regnumret' : 'Kameran kunde inte startas';
      this.btn.hidden = false;
    }
  }
  stop() {
    this.running = false;
    clearTimeout(this.timer);
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }
  crop() {
    const v = this.video, vw = v.videoWidth, vh = v.videoHeight;
    if (!vw || !vh) return null;
    const cr = this.cam.getBoundingClientRect(), fr = this.frame.getBoundingClientRect();
    const scale = Math.max(cr.width / vw, cr.height / vh);
    const ox = (cr.width - vw * scale) / 2, oy = (cr.height - vh * scale) / 2;
    // a little margin around the frame helps
    const pad = 0.08 * fr.width;
    let sx = (fr.left - cr.left - pad - ox) / scale, sy = (fr.top - cr.top - pad - oy) / scale;
    let sw = (fr.width + 2 * pad) / scale, sh = (fr.height + 2 * pad) / scale;
    sx = Math.max(0, sx); sy = Math.max(0, sy); sw = Math.min(vw - sx, sw); sh = Math.min(vh - sy, sh);
    const W = 800, H = Math.round(W * sh / sw);
    const c = this.canvas; c.width = W; c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(v, sx, sy, sw, sh, 0, 0, W, H);
    const img = g.getImageData(0, 0, W, H), d = img.data;
    let min = 255, max = 0;
    for (let i = 0; i < d.length; i += 4) {
      const y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      d[i] = y; if (y < min) min = y; if (y > max) max = y;
    }
    const k = 255 / Math.max(40, max - min);
    for (let i = 0; i < d.length; i += 4) { const y = (d[i] - min) * k; d[i] = d[i + 1] = d[i + 2] = y; }
    g.putImageData(img, 0, 0);
    return c;
  }
  async loop() {
    if (!this.running) return;
    try {
      const c = this.crop();
      if (c) {
        const { data } = await ocrWorker.recognize(c);
        if (!this.running) return;
        const lines = (data.text || '').split('\n').map((s) => s.trim()).filter(Boolean);
        const cands = Matcher.candidates(lines, this.known);
        if (cands.length) {
          const best = cands.find(this.known) || cands[0];
          const inHotel = this.known(best);
          this.live.hidden = false;
          this.live.textContent = 'Läst: ' + spaced(best) + (inHotel ? ' · i däckhotellet' : '');
          this.count = best === this.last ? this.count + 1 : 1;
          this.last = best;
          if (this.count >= 2) {
            this.stop();
            if (navigator.vibrate) navigator.vibrate(60);
            this.onPlate(best);
            return;
          }
        }
      }
    } catch { /* keep trying */ }
    this.timer = setTimeout(() => this.loop(), 150);
  }
}

/* ---------------- router ---------------- */
const screens = ['home', 'settings', 'lift', 'result', 'customer', 'order', 'orders', 'queue', 'rscan', 'job'];
let current = 'home';
const renderers = {};
const leave = {};
function show(id) {
  if (!screens.includes(id)) id = 'home';
  if (leave[current] && current !== id) leave[current]();
  current = id;
  for (const s of screens) $('#' + s).hidden = s !== id;
  const r = renderers[id];
  if (r && r() === false) return; // renderer redirected
  window.scrollTo(0, 0);
}
function go(id) {
  const depth = (history.state && history.state.depth) || 0;
  history.pushState({ s: id, depth: depth + 1 }, '', '#' + id);
  show(id);
}
/** Goes [steps] entries back in history and lands on [id]. */
function backTo(id, steps) {
  const depth = (history.state && history.state.depth) || 0;
  if (depth >= steps) { landOn = id; history.go(-steps); }
  else { history.replaceState({ s: id, depth: 0 }, '', '#' + id); show(id); }
}
let landOn = null;
function back() {
  if (history.state && history.state.depth > 0) history.back();
  else { history.replaceState({ s: 'home', depth: 0 }, '', '#home'); show('home'); }
}
window.addEventListener('popstate', (e) => {
  let id = (e.state && e.state.s) || 'home';
  if (landOn) { id = landOn; landOn = null; history.replaceState({ s: id, depth: (e.state && e.state.depth) || 0 }, '', '#' + id); }
  closeModal();
  show(id);
});
document.addEventListener('click', (e) => {
  const g = e.target.closest('[data-go]');
  if (g) { go(g.dataset.go); return; }
  if (e.target.closest('[data-back]')) back();
});

function modal(title, body) {
  $('#modalTitle').textContent = title;
  const b = $('#modalBody'); b.replaceChildren(...body);
  $('#modal').hidden = false;
}
function closeModal() { $('#modal').hidden = true; }
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });

/* ---------------- HOME & SETTINGS ---------------- */
renderers.home = () => {
  const n = Settings.name;
  $('#greeting').hidden = !n;
  $('#greeting').textContent = 'Hej ' + n;
  $('#version').textContent = 'DäckFlow ' + VERSION;
};
let startChoice = 'home';
renderers.settings = () => {
  $('#setName').value = Settings.name;
  startChoice = Settings.start;
  renderChoices();
};
function renderChoices() {
  const defs = [
    ['home', 'Startsidan', 'Välj LYFT eller KUNDMOTTAGARE varje gång', 'var(--navy)'],
    ['lift', 'LYFT', 'Kameran öppnas direkt', 'var(--yellow)'],
    ['queue', 'KUNDMOTTAGARE', 'Kön öppnas direkt', 'var(--blue)'],
  ];
  $('#startChoices').replaceChildren(...defs.map(([k, t, s, c]) => h('button', {
    class: 'choice', role: 'radio', 'aria-checked': String(k === startChoice), onclick: () => { startChoice = k; renderChoices(); },
  }, h('span', { class: 'check dot' }, k === startChoice ? '✓' : ''), h('span', { class: 'grow' }, h('span', { class: 't' }, t), h('span', { class: 's' }, s)), h('span', { class: 'swatch', style: 'background:' + c }))));
}
$('#saveSettings').addEventListener('click', () => {
  Settings.save($('#setName').value, startChoice);
  toast('Sparat');
  back();
});

/* ---------------- LYFT ---------------- */
let liftScanner, recScanner;
let curPlate = null;

function setStatus(ok, text) {
  $('#dataStatus .dot').className = 'dot' + (ok ? ' ok' : '');
  $('#dataStatus .status-text').textContent = text;
}
function renderLiftStatus() {
  if (!Store.rows.length) setStatus(false, 'Ingen fil med däckuppgifter. Tryck här och välj CompleteStorageList.xlsx');
  else setStatus(true, `${Store.meta.name} · ${fmt(Store.rows.length)} bilar · ${dateTimeFmt(Store.meta.at)} · tryck för att uppdatera`);
  renderSeason();
}
$('#dataStatus').addEventListener('click', pickDataFile);

function seasonStart() {
  const d = new Date(), m = d.getMonth(), autumn = m >= 7 || m === 0;
  const year = m === 0 ? d.getFullYear() - 1 : d.getFullYear();
  return { autumn, year, start: new Date(year, autumn ? 7 : 1, 1).getTime() };
}
function renderSeason() {
  const { autumn, year, start } = seasonStart();
  const dir = autumn ? 'S2V' : 'V2S';
  const swapped = new Set(Orders.all().filter((o) => o.swap === dir && o.id >= start).map((o) => normPlate(o.plate)));
  let done = 0, waiting = 0;
  for (const p of Store.rows) {
    const hasW = p.sets.some((s) => /winter/i.test(s.season)), hasS = p.sets.some((s) => /summer/i.test(s.season));
    if (!hasW && !hasS) continue;
    const waitSet = autumn ? hasW : hasS, doneSet = autumn ? hasS && !hasW : hasW && !hasS;
    if (waitSet && swapped.has(p.norm)) done++; else if (waitSet) waiting++; else if (doneSet) done++;
  }
  const total = done + waiting;
  $('#season').hidden = !total;
  if (!total) return;
  const pct = done * 100 / total;
  $('#seasonTitle').textContent = (autumn ? 'Hjulskifte höst ' : 'Hjulskifte vår ') + year;
  $('#seasonPct').textContent = Math.floor(pct) + ' %';
  $('#seasonFill').style.width = pct + '%';
  $('#seasonDone').textContent = `${fmt(done)} av ${fmt(total)} bilar klara`;
  $('#seasonLeft').textContent = `${fmt(waiting)} kvar`;
}

renderers.lift = () => {
  renderLiftStatus();
  $('#liftQuery').value = '';
  $('#liftResults').replaceChildren();
  liftScanner = liftScanner || new Scanner($('#liftCam'), (n) => openPlate(n), (n) => !!Store.find(n));
  liftScanner.start();
};
leave.lift = () => liftScanner && liftScanner.stop();

function resultRow(p, onclick) {
  const s = primary(p);
  return h('button', { class: 'result', onclick },
    plateEl(spaced(p.plate)),
    h('span', { class: 'grow' }, h('span', { class: 't' }, displayName(p) || '–'), h('span', { class: 's' }, s ? `${seasonLabel(s)} · ${s.place}` : '')));
}
$('#liftSearch').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('#liftQuery').value;
  $('#liftQuery').blur();
  const box = $('#liftResults');
  if (!Store.rows.length) { box.replaceChildren(h('p', { class: 'hint' }, 'Välj först filen med däckuppgifter (raden högst upp).')); return; }
  const hits = Store.search(q);
  const n = normPlate(q);
  if (hits.length === 1 || (hits[0] && hits[0].norm === n)) { openPlate(hits[0].norm); return; }
  if (hits.length) { box.replaceChildren(...hits.slice(0, 30).map((p) => resultRow(p, () => openPlate(p.norm)))); return; }
  const near = Store.near(n);
  box.replaceChildren(h('p', { class: 'hint' }, `${spaced(q)} finns inte i däckhotellet.` + (near.length ? ' Menade du:' : '')), ...near.slice(0, 6).map((p) => resultRow(p, () => openPlate(p.norm))));
});

function openPlate(norm) {
  const p = Store.find(norm);
  if (!p) {
    // read by the camera but not in the list
    const near = Store.near(norm);
    $('#liftQuery').value = spaced(norm);
    $('#liftResults').replaceChildren(h('p', { class: 'hint' }, `${spaced(norm)} finns inte i däckhotellet.` + (near.length ? ' Menade du:' : '')),
      ...near.slice(0, 6).map((x) => resultRow(x, () => openPlate(x.norm))),
      h('button', { class: 'btn outline', onclick: () => { $('#liftResults').replaceChildren(); liftScanner.start(); } }, 'Skanna igen'));
    return;
  }
  curPlate = p;
  go('result');
}

function carSvg(tyres) {
  const spots = [[1, 90, 58], [2, 210, 58], [3, 90, 186], [4, 210, 186]];
  const codes = { 1: 'VF', 2: 'HF', 3: 'VB', 4: 'HB' };
  const label = [1, 2, 3, 4].map((p) => { const t = tyres[p]; return POS[p - 1] + ': ' + (t && t.tread != null ? mm(t.tread) + ' millimeter' : 'mönsterdjup saknas'); }).join('. ');
  let s = `<svg viewBox="0 0 326 286" class="diagram" role="img" aria-label="${label}">
  <defs><filter id="gl" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="6"/></filter>
  <clipPath id="tc"><rect width="26" height="64" rx="9"/></clipPath></defs>
  <text x="163" y="11" text-anchor="middle" font-size="11" font-weight="700" letter-spacing="2" fill="#9FB0D6">▲ FRAM</text>
  <line x1="163" y1="20" x2="163" y2="282" stroke="rgba(255,255,255,.1)" stroke-width="2" stroke-dasharray="10 10"/>
  <g transform="translate(103 24)">
   <ellipse cx="7" cy="86" rx="7" ry="5" fill="#C9D3E6"/><ellipse cx="113" cy="86" rx="7" ry="5" fill="#C9D3E6"/>
   <path d="M60 4C92 4 107 14 109 40L112 112L110 212C108 238 92 246 60 246C28 246 12 238 10 212L8 112L11 40C13 14 28 4 60 4Z" fill="#E8EDF7"/>
   <rect x="17" y="9" width="20" height="6" rx="3" fill="#FFC72C"/><rect x="83" y="9" width="20" height="6" rx="3" fill="#FFC72C"/>
   <rect x="17" y="236" width="20" height="5" rx="2.5" fill="#D93025"/><rect x="83" y="236" width="20" height="5" rx="2.5" fill="#D93025"/>
   <path d="M34 22L38 66M86 22L82 66" stroke="#C9D3E6" stroke-width="2"/>
   <path d="M22 76C40 64 80 64 98 76L91 108C72 101 48 101 29 108Z" fill="#22355F"/>
   <path d="M29 188C48 193 72 193 91 188L95 210C76 218 44 218 25 210Z" fill="#22355F"/>
   <rect x="31" y="112" width="58" height="70" rx="12" fill="#D3DBEA"/>
  </g>`;
  for (const [pos, x, y] of spots) {
    const t = tyres[pos], v = t ? t.tread : null, c = t ? treadColor(v) : '#3A4458';
    if (t && v != null) s += `<rect x="${x - 3}" y="${y - 3}" width="32" height="70" rx="11" fill="${c}" opacity=".6" filter="url(#gl)"/>`;
    s += `<g transform="translate(${x} ${y})"><rect width="26" height="64" rx="9" fill="#11161F"/><g clip-path="url(#tc)">`;
    for (let gy = 6; gy < 64; gy += 8) s += `<rect x="3" y="${gy}" width="20" height="2" fill="#2B3342"/>`;
    s += `</g><rect x="-1.5" y="-1.5" width="29" height="67" rx="10" fill="none" stroke="${c}" stroke-width="3"/></g>`;
    const left = x < 163, cy = y + 31, bx = left ? 0 : 252;
    s += left ? `<line x1="74" y1="${cy}" x2="88" y2="${cy}" stroke="${c}" stroke-width="2"/>` : `<line x1="238" y1="${cy}" x2="252" y2="${cy}" stroke="${c}" stroke-width="2"/>`;
    const ink = (t && v != null && v >= 3 && v <= 5) ? '#141414' : '#FFFFFF';
    s += `<rect x="${bx}" y="${y + 4}" width="74" height="56" rx="14" fill="${t ? c : '#2A3550'}"/>
      <text x="${bx + 37}" y="${y + 23}" text-anchor="middle" font-size="10" font-weight="700" letter-spacing="1.2" fill="${ink}" opacity=".85">${codes[pos]} · ${pos}</text>
      <text x="${bx + 37}" y="${y + 50}" text-anchor="middle" fill="${ink}" font-family="Barlow Condensed, sans-serif" font-weight="800">${v == null ? '<tspan font-size="24">–</tspan>' : `<tspan font-size="26">${mm(v)}</tspan><tspan font-size="14"> mm</tspan>`}</text>`;
  }
  return s + '</svg>';
}

function setCard(p, s) {
  const tyres = {};
  for (const t of s.tyres) { const n = parseInt(t.pos); if (n >= 1 && n <= 4 && !tyres[n]) tyres[n] = t; }
  const sizes = [...new Set(s.tyres.map(tyreSize).filter(Boolean))];
  const studs = s.tyres.some((t) => t.studs);
  const minT = Math.min(...s.tyres.map((t) => t.tread).filter((v) => v != null));
  const card = h('div', { class: 'card navy' },
    h('p', { class: 'card-title' }, `${seasonLabel(s)} i lager · ${s.place || '–'}`));
  if (s.tyres.length) {
    card.append(h('div', { html: carSvg(tyres) }));
    if (isFinite(minT) && minT < 3) card.append(h('div', { class: 'warn' }, `Däck under 3 mm (${mm(minT)} mm) – föreslå nya däck till kunden.`));
    card.append(h('div', { class: 'legend' }, h('span', null, h('i', { style: 'background:#D93025' }), 'under 3 mm'), h('span', null, h('i', { style: 'background:#F29900' }), '3–5 mm'), h('span', null, h('i', { style: 'background:#1E8E3E' }), 'över 5 mm')));
    card.append(h('div', { class: 'facts' },
      h('div', { class: 'fact' }, h('div', { class: 'k' }, 'Storlek'), h('div', { class: 'v' }, sizes.join(', ') || '–')),
      h('div', { class: 'fact' }, h('div', { class: 'k' }, 'Dubbar'), h('div', { class: 'v' }, /winter/i.test(s.season) || studs ? (studs ? 'Dubbade' : 'Odubbade') : '–')),
      h('div', { class: 'fact' }, h('div', { class: 'k' }, 'Fälg'), h('div', { class: 'v' }, s.alloy == null ? '–' : s.alloy ? 'Alu' : 'Plåt'))));
    const makes = s.tyres.map((t) => [t.make, t.pattern].filter(Boolean).join(' ')).filter(Boolean);
    if (makes.length) card.append(h('div', { class: 'tyre-list' }, ...s.tyres.map((t) => h('div', null,
      h('span', null, `${t.pos || '–'} · ${[t.make, t.pattern].filter(Boolean).join(' ') || '–'}`), h('b', null, t.tread == null ? '–' : mm(t.tread) + ' mm')))));
  } else card.append(h('p', { class: 'note' }, 'Inga däckuppgifter i filen för den här platsen.'));
  if (s.note) card.append(h('p', { class: 'note' }, 'Notering: ' + s.note));
  return card;
}

renderers.result = () => {
  const p = curPlate;
  if (!p) { history.replaceState({ s: 'lift', depth: (history.state && history.state.depth) || 0 }, '', '#lift'); show('lift'); return false; }
  const s = primary(p);
  $('#resPlate').replaceChildren(plateEl(spaced(p.plate), 'S', true));
  $('#resPlaceLabel').textContent = s && s.season ? `${seasonLabel(s)} · plats` : 'Plats';
  const place = s ? s.place : '';
  $('#resPlace').textContent = place || '–';
  $('#resPlace').className = 'place' + (place.length > 9 ? ' small' : '');
  const body = $('#resBody');
  body.replaceChildren(
    h('button', { class: 'card cust-row', onclick: () => go('customer') },
      h('span', { class: 'avatar' }, initials(displayName(p))),
      h('span', { class: 'grow' }, h('span', { class: 't' }, displayName(p) || 'Okänd kund'), h('span', { class: 's' }, [isPrivate(p) ? 'Privatkund' : p.contact, p.vehicle].filter(Boolean).join(' · '))),
      h('span', { class: 'chev', 'aria-hidden': 'true' }, '›')));
  const sets = [...p.sets].sort((a, b) => (a === s ? -1 : b === s ? 1 : 0));
  for (const x of sets) body.append(setCard(p, x));
  if (p.note) body.append(h('div', { class: 'info-banner' }, 'Intern notering: ' + p.note));
};

renderers.customer = () => {
  const p = curPlate;
  if (!p) { back(); return false; }
  const phone = p.phone.replace(/[^\d+]/g, '');
  const intl = phoneIntl(p.phone);
  const body = $('#custBody');
  body.replaceChildren(
    h('div', { class: 'card', style: 'align-items:center;text-align:center' },
      h('span', { class: 'avatar big' }, initials(displayName(p))),
      h('b', { style: 'font-size:22px' }, displayName(p) || 'Okänd kund'),
      h('span', { class: 'note' }, isPrivate(p) ? 'Privatkund' : p.contact ? 'Kontakt: ' + p.contact : '')),
    h('div', { class: 'contact' },
      h('a', { href: phone ? 'tel:' + intl : null, class: phone ? null : 'off' }, '📞', 'Ring'),
      h('a', { href: phone ? smsHref(intl, '') : null, class: phone ? null : 'off' }, '💬', 'Sms'),
      h('a', { href: p.email ? 'mailto:' + p.email : null, class: p.email ? null : 'off' }, '✉️', 'E-post')),
  );
  const info = h('div', { class: 'card' });
  const kv = (k, v) => v && info.append(h('div', { class: 'kv' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v)));
  kv('Telefon', p.phone); kv('E-post', p.email); kv('Adress', p.address); kv('Kundnummer', p.customerNo);
  if (!isPrivate(p)) kv('Företag', p.customer);
  kv('Fordon', p.vehicle); kv('Avtal', p.agreement); kv('Kund sedan', p.since); kv('Intern notering', p.note);
  body.append(info);
  const others = Store.sameCustomer(p);
  if (others.length > 1) {
    body.append(h('p', { class: 'label', style: 'margin-top:8px' }, `Kundens bilar (${others.length})`));
    for (const o of others) body.append(resultRow(o, () => { curPlate = o; go('result'); }));
  }
};

/* ---------------- orders ---------------- */
const Orders = {
  all() { return ls.get('orders', []); },
  add(o) { const a = this.all(); a.push(o); ls.set('orders', a); },
  remove(id) { ls.set('orders', this.all().filter((o) => o.id !== id)); },
};
function orderSummary(o) {
  const p = [];
  if (o.swap) p.push(`Hjulskifte ${o.swap === 'S2V' ? 'S→V' : 'V→S'} (${o.tyres})`);
  if (o.repairs) p.push(`${o.repairs} reparation${o.repairs > 1 ? 'er' : ''}`);
  if (o.balancing) p.push(`${o.balancing} balansering${o.balancing > 1 ? 'ar' : ''}`);
  if (o.newTyres) p.push(`${o.newTyres} nya däck`);
  return p.join(' · ');
}

let draft;
renderers.order = () => {
  const p = curPlate;
  if (!p) { back(); return false; }
  const { autumn } = seasonStart();
  draft = { km: '', swapOn: true, dir: autumn ? 'S2V' : 'V2S', tyres: 4, repairs: 0, balancing: 0, newTyres: 0 };
  $('#ordPlate').textContent = spaced(p.plate) + ' · ' + (primary(p) ? primary(p).place : '');
  const body = $('#ordBody');
  const km = h('input', { class: 'input km', inputmode: 'numeric', pattern: '[0-9]*', placeholder: 't.ex. 84500', id: 'kmInput', 'aria-label': 'Mätarställning i km' });
  const err = h('p', { class: 'error', hidden: true }, 'Skriv mätarställningen.');
  km.addEventListener('input', () => { draft.km = km.value.replace(/\D/g, ''); km.value = draft.km; err.hidden = true; sum(); });
  const stepper = (key, min, max) => {
    const out = h('output', null, draft[key]);
    const minus = h('button', { type: 'button', 'aria-label': 'Minska' }, '−');
    const plus = h('button', { type: 'button', 'aria-label': 'Öka' }, '+');
    const upd = () => { out.textContent = draft[key]; minus.disabled = draft[key] <= min; plus.disabled = draft[key] >= max; sum(); };
    minus.onclick = () => { draft[key] = Math.max(min, draft[key] - 1); upd(); };
    plus.onclick = () => { draft[key] = Math.min(max, draft[key] + 1); upd(); };
    setTimeout(upd);
    return h('div', { class: 'stepper' }, minus, out, plus);
  };
  const dirBtns = h('div', { class: 'dir' });
  const renderDir = () => dirBtns.replaceChildren(...[['S2V', 'Sommar → Vinter'], ['V2S', 'Vinter → Sommar']].map(([k, t]) => h('button', { type: 'button', class: draft.dir === k ? 'on' : '', onclick: () => { draft.dir = k; renderDir(); sum(); } }, t)));
  renderDir();
  const swapBox = h('div', { class: 'card' });
  const swapHead = h('button', { class: 'jobrow', type: 'button' });
  const swapBody = h('div', { style: 'display:flex;flex-direction:column;gap:10px' }, dirBtns, h('div', { class: 'svc' }, h('span', { class: 'grow' }, h('span', { class: 't' }, 'Antal däck')), stepper('tyres', 1, 6)));
  const renderSwap = () => {
    swapHead.replaceChildren(h('span', { class: 'check', style: draft.swapOn ? 'background:var(--navy)' : '' }, draft.swapOn ? '✓' : ''), h('span', { class: 'grow' }, h('span', { class: 't' }, 'Hjulskifte'), h('span', { class: 's' }, 'Byte sommar/vinter')));
    swapBody.hidden = !draft.swapOn; sum();
  };
  swapHead.onclick = () => { draft.swapOn = !draft.swapOn; renderSwap(); };
  swapBox.append(swapHead, swapBody);
  const svc = (key, t, s) => h('div', { class: 'card svc' }, h('span', { class: 'grow' }, h('span', { class: 't' }, t), h('span', { class: 's' }, s)), stepper(key, 0, 8));
  body.replaceChildren(
    h('div', { class: 'card' }, h('label', { class: 'label', for: 'kmInput' }, 'Mätarställning (km)'), km, err),
    swapBox,
    svc('repairs', 'Däckreparation', 'Antal lagade däck'),
    svc('balancing', 'Balansering', 'Antal hjul'),
    svc('newTyres', 'Nya däck', 'Antal sålda däck'));
  renderSwap();
  draft.err = err;
};
function sum() {
  if (!draft) return;
  const o = draftOrder();
  $('#ordSummary').textContent = o && orderSummary(o) ? orderSummary(o) : 'Välj minst ett arbete';
}
function draftOrder() {
  const p = curPlate;
  return {
    id: Date.now(), plate: p.plate, place: primary(p) ? primary(p).place : '', customer: displayName(p),
    km: parseInt(draft.km) || 0, swap: draft.swapOn ? draft.dir : null, tyres: draft.swapOn ? draft.tyres : 0,
    repairs: draft.repairs, balancing: draft.balancing, newTyres: draft.newTyres, by: Settings.name,
  };
}
$('#newOrderBtn').addEventListener('click', () => go('order'));
$('#saveOrder').addEventListener('click', () => {
  const o = draftOrder();
  if (!o.km) { draft.err.hidden = false; $('#kmInput').focus(); return; }
  if (!orderSummary(o)) { toast('Välj minst ett arbete: hjulskifte, reparation, balansering eller nya däck.'); return; }
  Orders.add(o);
  Queue.markDoneByPlate(normPlate(o.plate));
  toast(`Order sparad: ${spaced(o.plate)} · ${orderSummary(o)}`);
  backTo('lift', 2); // order → result → camera
});

renderers.orders = () => {
  const list = Orders.all().slice().reverse();
  $('#ordersSub').textContent = `${list.length} ${list.length === 1 ? 'order' : 'ordrar'} på den här telefonen`;
  const body = $('#ordersBody');
  if (!list.length) { body.replaceChildren(h('p', { class: 'empty' }, 'Inga ordrar än.')); return; }
  body.replaceChildren(h('div', { class: 'info-banner' }, 'Ordrarna sparas i telefonen. Tryck på «Spara Excel-fil» och välj Google Drive eller Filer för att spara listan.'),
    ...list.map((o) => h('div', { class: 'card' },
      h('div', { class: 'row' }, plateEl(spaced(o.plate)), h('b', { style: 'flex:1' }, o.customer || ''), h('span', { class: 'note' }, dateTimeFmt(o.id))),
      h('span', null, orderSummary(o)),
      h('span', { class: 'note' }, `${fmt(o.km)} km · plats ${o.place || '–'}` + (o.by ? ' · ' + o.by : '')))));
};
$('#exportOrders').addEventListener('click', async () => {
  const list = Orders.all();
  if (!list.length) { toast('Inga ordrar att spara'); return; }
  const rows = [['Datum', 'Regnr', 'Plats', 'Kund', 'Mätarställning (km)', 'Hjulskifte', 'Antal däck (skifte)', 'Däckreparationer', 'Balanseringar', 'Nya däck', 'Av']];
  for (const o of list) rows.push([new Date(o.id).toLocaleString('sv-SE'), spaced(o.plate), o.place, o.customer, o.km, o.swap ? (o.swap === 'S2V' ? 'Sommar → Vinter' : 'Vinter → Sommar') : '', o.tyres || '', o.repairs || '', o.balancing || '', o.newTyres || '', o.by || '']);
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [18, 10, 10, 26, 12, 16, 10, 10, 10, 8, 12].map((w) => ({ wch: w }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Ordrar');
  const data = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  const name = 'DäckHotell Ordrar.xlsx';
  const file = new File([data], name, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  const a = h('a', { href: URL.createObjectURL(file), download: name });
  document.body.append(a); a.click(); a.remove();
});

/* ---------------- KUNDMOTTAGARE: queue ---------------- */
const POS = ['Vänster fram', 'Höger fram', 'Vänster bak', 'Höger bak'];
function phoneIntl(ph) {
  const d = String(ph || '').replace(/[^\d+]/g, '');
  if (!d) return '';
  if (d.startsWith('+')) return d;
  if (d.startsWith('00')) return '+' + d.slice(2);
  if (d.startsWith('0')) return '+46' + d.slice(1);
  return '+46' + d;
}
function smsHref(num, body) { return 'sms:' + num + (body ? (isIOS ? '&' : '?') + 'body=' + encodeURIComponent(body) : ''); }
function jobsText(q) {
  const p = [];
  if (q.swapHotel) p.push('Hjulskifte · däckhotellet' + (q.place ? ' ' + q.place : ''));
  if (q.swapTrunk) p.push('Hjulskifte · däck i bagaget');
  if (q.balancing) p.push('Balansering');
  if (q.puncture) p.push('Punktering · ' + POS[q.puncture - 1].toLowerCase());
  return p.join(' + ');
}
const Queue = {
  all() { return ls.get('queue', []); },
  save(list) { const cut = Date.now() - 3 * 864e5; ls.set('queue', list.filter((q) => !(q.done && q.updated < cut))); },
  items() { return this.all().filter((q) => !q.done).sort((a, b) => a.order - b.order); },
  add(q) { const it = this.items(); q.order = (it.length ? Math.max(...it.map((x) => x.order)) : 0) + 1; this.save([...this.all(), q]); },
  move(id, delta) {
    const it = this.items(), i = it.findIndex((q) => q.id === id), j = i + delta;
    if (i < 0 || j < 0 || j >= it.length) return;
    const a = it[i], b = it[j], now = Date.now();
    const ch = { [a.id]: { ...a, order: b.order, updated: now }, [b.id]: { ...b, order: a.order, updated: now } };
    this.save(this.all().map((q) => ch[q.id] || q));
  },
  setDone(id) { const now = Date.now(); this.save(this.all().map((q) => (q.id === id ? { ...q, done: true, updated: now } : q))); },
  markDoneByPlate(n) { const q = this.items().find((x) => normPlate(x.plate) === n); if (q) this.setDone(q.id); },
};

let movingId = null;
renderers.queue = () => {
  const items = Queue.items();
  if (!items.some((q) => q.id === movingId)) movingId = null;
  $('#queueSub').textContent = `Kö till verkstaden · ${items.length} ${items.length === 1 ? 'bil' : 'bilar'}`;
  const m = items.find((q) => q.id === movingId);
  $('#moveBanner').hidden = !m;
  if (m) $('#moveText').replaceChildren('Flytta ', h('b', null, m.plate), ' med pilarna');
  $('#fab').hidden = !!m;
  const body = $('#queueBody');
  body.replaceChildren();
  if (!items.length) body.append(h('p', { class: 'empty' }, 'Kön är tom. Tryck på + för att lägga till en bil.'));
  items.forEach((q, i) => body.append(queueCard(q, i, items.length)));
  if (items.length) body.append(h('p', { class: 'hint', style: 'text-align:center' }, 'Håll in en bil i 3 sekunder för att flytta den i kön'));
  body.append(h('p', { class: 'hint', style: 'text-align:center;margin-bottom:90px' }, 'Kön finns just nu bara i den här telefonen. Delad kö för alla telefoner kommer med Firebase.'));
};
$('#moveDone').addEventListener('click', () => { movingId = null; renderers.queue(); });
$('#fab').addEventListener('click', () => go('rscan'));

function queueCard(q, i, n) {
  const first = i === 0, moving = q.id === movingId;
  const card = h('div', { class: 'qcard' + (first ? ' first' : '') + (moving ? ' moving' : ''), role: 'button', tabindex: '0',
    'aria-label': `Nummer ${i + 1}: ${q.plate}, ${jobsText(q)}. Håll in för att flytta.` });
  const bar = h('span', { class: 'hold' });
  const extra = [];
  if (q.leaves) extra.push('Lämnar bil' + (q.phone ? ' · ' + q.phone : ''));
  if (q.customer) extra.push(q.customer);
  card.append(bar, h('span', { class: 'qnum' }, i + 1),
    h('div', { class: 'qbody' },
      first ? h('span', { class: 'next-tag' }, 'NÄSTA IN') : null,
      plateEl(q.plate, q.cc),
      h('span', { class: 'qjob' }, jobsText(q)),
      extra.length ? h('span', { class: 'qextra' }, extra.join(' · ')) : null));
  if (moving) {
    const up = h('button', { 'aria-label': 'Flytta upp', disabled: i === 0, onclick: (e) => { e.stopPropagation(); Queue.move(q.id, -1); renderers.queue(); } }, '▲');
    const dn = h('button', { 'aria-label': 'Flytta ned', disabled: i === n - 1, onclick: (e) => { e.stopPropagation(); Queue.move(q.id, 1); renderers.queue(); } }, '▼');
    card.append(h('div', { class: 'arrows' }, up, dn));
    return card;
  }
  card.append(h('div', { class: 'qright' }, h('span', null, timeFmt(q.at)), q.by ? h('span', null, q.by) : null));
  if (movingId) return card;
  let timer = null, sx = 0, sy = 0, t0 = 0, moved = false;
  const cancel = () => { clearTimeout(timer); timer = null; bar.classList.remove('run'); };
  card.addEventListener('pointerdown', (e) => {
    sx = e.clientX; sy = e.clientY; t0 = Date.now(); moved = false;
    void bar.offsetWidth; bar.classList.add('run');
    timer = setTimeout(() => { timer = null; if (navigator.vibrate) navigator.vibrate(40); movingId = q.id; renderers.queue(); }, 3000);
  });
  card.addEventListener('pointermove', (e) => { if (timer && (Math.abs(e.clientX - sx) > 10 || Math.abs(e.clientY - sy) > 10)) { moved = true; cancel(); } });
  card.addEventListener('pointerup', () => {
    const short = timer && Date.now() - t0 < 500 && !moved;
    cancel();
    if (short) itemMenu(q);
  });
  card.addEventListener('pointercancel', cancel);
  card.addEventListener('pointerleave', cancel);
  card.addEventListener('contextmenu', (e) => e.preventDefault());
  card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); itemMenu(q); } });
  return card;
}

function itemMenu(q) {
  const items = [];
  const num = phoneIntl(q.phone);
  if (num) {
    items.push(h('a', { class: 'btn navy', href: smsHref(num, `Hej! Din bil ${q.plate} är klar och kan hämtas.`), onclick: closeModal }, 'Sms: bilen är klar'));
    items.push(h('a', { class: 'btn outline', href: 'tel:' + num, onclick: closeModal }, 'Ring kunden · ' + q.phone));
  }
  items.push(h('button', { class: 'btn yellow', onclick: () => { Queue.setDone(q.id); closeModal(); renderers.queue(); toast(q.plate + ' är borttagen ur kön'); } }, 'Klar – ta bort ur kön'));
  items.push(h('button', { class: 'btn outline', onclick: closeModal }, 'Avbryt'));
  for (const a of items) if (a.tagName === 'A') a.style.textDecoration = 'none';
  modal(`${q.plate} · ${jobsText(q)}`, items);
}

/* ---------------- reception: scan / type ---------------- */
let foreign = false;
function renderCC() {
  for (const b of $$('#manualForm .seg')) { const on = (b.dataset.cc === 'foreign') === foreign; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); }
  $('#ccRow').hidden = !foreign;
  $('#manualPlate').placeholder = foreign ? 'HH AB 1234' : 'ABC 123';
}
for (const b of $$('#manualForm .seg')) b.addEventListener('click', () => { foreign = b.dataset.cc === 'foreign'; renderCC(); if (foreign) $('#ccInput').focus(); });
renderers.rscan = () => {
  foreign = false; $('#manualPlate').value = ''; $('#ccInput').value = ''; renderCC();
  recScanner = recScanner || new Scanner($('#recCam'), (n) => openJob(Store.find(n) ? Store.find(n).plate : spaced(n), 'S', true), (n) => !!Store.find(n));
  recScanner.start();
};
leave.rscan = () => recScanner && recScanner.stop();
$('#manualForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const p = $('#manualPlate').value.trim().toUpperCase().replace(/\s+/g, ' ');
  if (normPlate(p).length < 2) { toast('Skriv regnumret'); return; }
  const cc = foreign ? ($('#ccInput').value.trim().toUpperCase() || '?') : 'S';
  openJob(foreign ? p : (Store.find(normPlate(p)) ? Store.find(normPlate(p)).plate : spaced(p)), cc, false);
});

/* ---------------- reception: job ---------------- */
let job = null;
function openJob(plate, cc, fromCam) {
  if (cc === 'S') plate = spaced(plate);
  const hit = cc === 'S' ? Store.find(normPlate(plate)) : null;
  job = { plate, cc, hit, sel: [true, false, false, false], pos: 0, leaves: false, phone: '' };
  const hp = hit ? hit.phone.replace(/[^\d+]/g, '') : '';
  job.phone = hp.startsWith('+46') ? hp.slice(3) : hp.startsWith('0') ? hp.slice(1) : hp;
  $('#manualPlate').blur();
  go('job');
}
renderers.job = () => {
  if (!job) { back(); return false; }
  const { hit } = job, s = hit ? primary(hit) : null;
  $('#jobPlate').replaceChildren(plateEl(job.plate, job.cc, true));
  $('#jobInfo').textContent = !hit ? (job.cc === 'S' ? 'Inte i däckhotellet' : 'Utländsk bil') : 'I däckhotellet' + (s ? ` · ${s.season ? seasonLabel(s) + ' · ' : ''}${s.place}` : '');
  renderJob();
};
function renderJob() {
  const s = job.hit ? primary(job.hit) : null;
  const defs = [
    ['Hjulskifte – däckhotellet', s && s.place ? 'Däcken hämtas från ' + s.place : 'Däcken hämtas från däckhotellet'],
    ['Hjulskifte – däck i bagaget', 'Kunden har med sig däcken'],
    ['Balansering', 'Balansera hjulen'],
    ['Punktering', 'Laga ett däck'],
  ];
  const body = $('#jobBody');
  body.replaceChildren(...defs.map(([t, sub], i) => {
    const on = job.sel[i];
    const card = h('div', { class: 'jobcard' + (on ? ' on' : '') },
      h('button', { class: 'jobrow', role: 'checkbox', 'aria-checked': String(on), onclick: () => {
        job.sel[i] = !job.sel[i];
        if (job.sel[i] && i === 0) job.sel[1] = false;
        if (job.sel[i] && i === 1) job.sel[0] = false;
        renderJob();
      } }, h('span', { class: 'check', style: on ? 'background:var(--navy)' : '' }, on ? '✓' : ''), h('span', { class: 'grow' }, h('span', { class: 't' }, t), h('span', { class: 's' }, sub))));
    if (i === 3 && on) {
      const pb = (p) => h('button', { class: job.pos === p ? 'on' : '', 'aria-pressed': String(job.pos === p), onclick: () => { job.pos = p; renderJob(); } }, POS[p - 1]);
      card.append(h('p', { class: 'label' }, 'Vilket däck?'), h('div', { class: 'punct' },
        h('span', { class: 'fram' }, '▲ FRAM'), pb(1), h('span', { class: 'carmid' }), pb(2), pb(3), h('span', { class: 'carmid' }), pb(4)));
    }
    return card;
  }));
  const leaveBtn = h('button', { class: 'leave' + (job.leaves ? ' on' : ''), 'aria-pressed': String(job.leaves), onclick: () => {
    job.leaves = !job.leaves; renderJob();
    if (job.leaves) setTimeout(() => $('#phoneIn') && $('#phoneIn').focus(), 50);
  } }, job.leaves ? '🔑  Lämnar bil ✓' : '🔑  Lämnar bil');
  body.append(leaveBtn);
  if (job.leaves) {
    const inp = h('input', { id: 'phoneIn', class: 'input', type: 'tel', inputmode: 'tel', autocomplete: 'tel-national', placeholder: '70 123 45 67', 'aria-label': 'Kundens telefonnummer' });
    inp.value = job.phone;
    inp.addEventListener('input', () => { job.phone = inp.value; });
    body.append(h('div', { class: 'phonebox' }, h('p', { class: 'label' }, 'Kundens telefonnummer'),
      h('div', { class: 'row', style: 'flex-wrap:nowrap' }, h('span', { class: 'prefix' }, '+46'), inp),
      h('p', { class: 'hint' }, 'Du kan skicka ett sms till kunden när bilen är klar.')));
  }
  const parts = [];
  if (job.sel[0]) parts.push('Hjulskifte (däckhotellet)');
  if (job.sel[1]) parts.push('Hjulskifte (bagaget)');
  if (job.sel[2]) parts.push('Balansering');
  if (job.sel[3]) parts.push('Punktering' + (job.pos ? ' ' + POS[job.pos - 1].toLowerCase() : ''));
  $('#jobSummary').textContent = parts.length ? job.plate + ' · ' + parts.join(' + ') : 'Välj minst ett arbete';
  $('#addQueue').textContent = 'Lägg till i kön · plats ' + (Queue.items().length + 1);
  $('#addQueue').setAttribute('aria-disabled', String(!parts.length));
}
$('#addQueue').addEventListener('click', () => {
  if (!job.sel.some(Boolean)) { toast('Välj minst ett arbete'); return; }
  if (job.sel[3] && !job.pos) { toast('Välj vilket däck som har punktering'); return; }
  const ph = job.phone.trim();
  if (job.leaves && ph.replace(/\D/g, '').length < 6) { toast('Skriv kundens telefonnummer'); $('#phoneIn') && $('#phoneIn').focus(); return; }
  const now = Date.now();
  const q = {
    id: (crypto.randomUUID ? crypto.randomUUID() : String(now) + Math.random()), plate: job.plate, cc: job.cc,
    swapHotel: job.sel[0], swapTrunk: job.sel[1], balancing: job.sel[2], puncture: job.sel[3] ? job.pos : 0,
    place: job.hit && primary(job.hit) ? primary(job.hit).place : '', customer: job.hit ? displayName(job.hit) : '',
    leaves: job.leaves, phone: job.leaves ? (ph.startsWith('+') || ph.startsWith('0') ? ph : '0' + ph) : '',
    by: Settings.name, at: now, order: 0, done: false, updated: now,
  };
  Queue.add(q);
  toast(`${q.plate} är nummer ${Queue.items().length} i kön`);
  job = null;
  backTo('queue', 2); // job → scan → queue
});

/* ---------------- start ---------------- */
(async function init() {
  await Store.load();
  const hash = location.hash.slice(1);
  history.replaceState({ s: 'home', depth: 0 }, '', '#home');
  show('home');
  const start = ['lift', 'queue', 'orders', 'settings'].includes(hash) ? hash : Settings.start;
  if (start && start !== 'home') go(start);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
