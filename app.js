/*
 * RETO AHORRO — app.js
 * Desarrollado por Deison Bm
 *
 * CONFIGURABLE: el usuario elige meta, casillas y plazo.
 * Los montos se generan con números cerrados y seed fija.
 * La misma configuración SIEMPRE produce los mismos montos.
 * localStorage solo guarda config + estado done.
 */

const API_URL   = 'https://script.google.com/macros/s/AKfycbxfYbEhluQOElwh0PHg9MIY4zIbehYkB3MMdL0i0x3oyelCKgVWScf5m4fAuJefsoT2rQ/exec';
const SYNC_MS   = 60000;
const RETRY_MS  = 15000;
const LS_CFG    = 'reto_cfg_v1';   // {meta, n, plazo, seed, nombre}
const LS_DONE   = 'reto_done_v1';  // {id: bool}
const LS_THEME  = 'reto_theme';
const LS_AUTH   = 'reto_auth';

const _H = s => [...s].reduce((h,c)=>Math.imul(31,h)+c.charCodeAt(0)|0, 5381);
const PIN_HASH  = _H('2323');

// ─── Estado global ───────────────────────────────────
let CFG        = null;   // {meta, n, plazo, seed, nombre}
let CASILLAS   = [];     // [{id, monto}] — inmutables tras generación
let done       = {};     // {id: bool}
let pinBuf     = '';
let filtro     = 'all';
let pendingId  = null;
let syncTimer  = null;
let retryTimer = null;
let writeQueue = [];
let _tt        = null;

// ════════════════════════════════════════════════════
//  GENERADOR DE MONTOS CERRADOS
//  Usa PRNG determinista (seed) → misma config = mismos montos siempre
//  Números cerrados: múltiplos redondos según magnitud
// ════════════════════════════════════════════════════
function roundNice(v) {
  if (v <= 0)      return 500;
  if (v < 2000)    return Math.max(500, Math.round(v / 500) * 500);
  if (v < 10000)   return Math.round(v / 1000) * 1000;
  if (v < 50000)   return Math.round(v / 5000) * 5000;
  if (v < 200000)  return Math.round(v / 10000) * 10000;
  if (v < 1000000) return Math.round(v / 50000) * 50000;
  return Math.round(v / 100000) * 100000;
}

function generateMontos(meta, n, seed) {
  // PRNG Lehmer
  let s = (seed ^ 0xdeadbeef) >>> 0;
  const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };

  // Distribución log-normal: mayoría valores pequeños, pocos grandes
  const raw = Array.from({length: n}, () => {
    const u1 = rand() + 1e-9, u2 = rand();
    const z  = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return Math.exp(z * 1.2 + 2);
  });

  const sumRaw = raw.reduce((a, b) => a + b, 0);
  let montos   = raw.map(r => roundNice(r / sumRaw * meta));

  // Ajuste iterativo para que la suma sea exactamente meta
  for (let iter = 0; iter < 80; iter++) {
    const diff = meta - montos.reduce((a, b) => a + b, 0);
    if (diff === 0) break;
    const sorted = montos.map((v, i) => ({v, i})).sort((a, b) => b.v - a.v);
    for (const {i} of sorted) {
      const d = meta - montos.reduce((a, b) => a + b, 0);
      if (d === 0) break;
      const step = d > 0 ? Math.min(roundNice(d), d) : Math.max(-roundNice(-d), d);
      const nv   = roundNice(montos[i] + step);
      if (nv > 0) montos[i] = nv;
    }
  }
  // Corrección final en el mayor si hay residuo
  const maxI = montos.indexOf(Math.max(...montos));
  montos[maxI] += meta - montos.reduce((a, b) => a + b, 0);

  // Shuffle con misma seed (reproducible)
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [montos[i], montos[j]] = [montos[j], montos[i]];
  }
  return montos;
}

// ════════════════════════════════════════════════════
//  ARRANQUE
// ════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  applyTheme();
  buildStars();
  initLogin();
  if (sessionStorage.getItem(LS_AUTH) === '1') afterLogin();
});

// ════════════════════════════════════════════════════
//  ESTRELLAS
// ════════════════════════════════════════════════════
function buildStars() {
  const c = document.getElementById('stars-canvas');
  if (!c) return;
  const ctx = c.getContext('2d');
  let s = [];
  const resize = () => {
    c.width = innerWidth; c.height = innerHeight;
    s = Array.from({length: 120}, () => ({
      x: Math.random() * c.width, y: Math.random() * c.height,
      r: Math.random() * 1.4 + .3, o: Math.random(), d: Math.random() * .003 + .001,
    }));
  };
  const draw = () => {
    ctx.clearRect(0, 0, c.width, c.height);
    s.forEach(p => {
      p.o += p.d; if (p.o > 1 || p.o < 0) p.d *= -1;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,255,255,${Math.max(0, Math.min(1, p.o)).toFixed(2)})`;
      ctx.fill();
    });
    requestAnimationFrame(draw);
  };
  addEventListener('resize', resize); resize(); draw();
}

// ════════════════════════════════════════════════════
//  LOGIN
// ════════════════════════════════════════════════════
function initLogin() {
  document.querySelectorAll('.kbtn[data-n]').forEach(b =>
    b.addEventListener('click', () => pressKey(b.dataset.n)));
  document.getElementById('kbtn-del').addEventListener('click', delKey);
  document.addEventListener('keydown', e => {
    if (document.getElementById('login-screen').classList.contains('hidden')) return;
    if (e.key >= '0' && e.key <= '9') pressKey(e.key);
    if (e.key === 'Backspace') delKey();
  });
}
function pressKey(n) {
  if (pinBuf.length >= 4) return;
  pinBuf += n; renderDots();
  if (pinBuf.length === 4) setTimeout(checkPin, 180);
}
function delKey() { pinBuf = pinBuf.slice(0, -1); renderDots(); }
function renderDots() {
  for (let i = 0; i < 4; i++) {
    const d = document.getElementById(`pd${i}`);
    d.classList.toggle('filled', i < pinBuf.length);
    d.classList.remove('shake');
  }
}
function checkPin() {
  if (_H(pinBuf) === PIN_HASH) {
    sessionStorage.setItem(LS_AUTH, '1');
    for (let i = 0; i < 4; i++) {
      const d = document.getElementById(`pd${i}`);
      Object.assign(d.style, {background:'#00e5a0', borderColor:'#00e5a0', boxShadow:'0 0 12px #00e5a0'});
    }
    setTimeout(afterLogin, 430);
  } else {
    for (let i = 0; i < 4; i++) document.getElementById(`pd${i}`).classList.add('shake');
    document.getElementById('pin-msg').classList.remove('hidden');
    pinBuf = '';
    setTimeout(() => { renderDots(); document.getElementById('pin-msg').classList.add('hidden'); }, 1300);
  }
}
function afterLogin() {
  document.getElementById('login-screen').classList.add('hidden');
  bootApp();
}

// ════════════════════════════════════════════════════
//  BOOT
// ════════════════════════════════════════════════════
function bootApp() {
  CFG = loadCfg();
  if (!CFG) { showWizard(); return; }
  CASILLAS = generateMontos(CFG.meta, CFG.n, CFG.seed).map((monto, i) => ({id: i+1, monto}));
  loadDone();
  showApp();
}

// ════════════════════════════════════════════════════
//  CONFIG
// ════════════════════════════════════════════════════
function loadCfg() {
  try {
    const r = JSON.parse(localStorage.getItem(LS_CFG));
    return (r && r.meta && r.n && r.seed) ? r : null;
  } catch(_) { return null; }
}
function saveCfg(cfg) { localStorage.setItem(LS_CFG, JSON.stringify(cfg)); }

// ════════════════════════════════════════════════════
//  DONE
// ════════════════════════════════════════════════════
function saveDone() { localStorage.setItem(LS_DONE, JSON.stringify(done)); }
function loadDone() {
  try {
    const r = JSON.parse(localStorage.getItem(LS_DONE));
    done = (r && typeof r === 'object' && !Array.isArray(r)) ? r : {};
  } catch(_) { done = {}; }
  CASILLAS.forEach(c => { if (done[c.id] === undefined) done[c.id] = false; });
}

// ════════════════════════════════════════════════════
//  WIZARD — 3 pasos
// ════════════════════════════════════════════════════
let wStep  = 1;
let wDraft = {};

function showWizard() {
  document.getElementById('wizard-screen').classList.remove('hidden');
  document.getElementById('app-screen').classList.add('hidden');
  wStep = 1; wDraft = {};
  goToStep(1);
}

function goToStep(step) {
  wStep = step;
  // Indicador
  document.querySelectorAll('.wiz-step').forEach((el, i) => {
    el.classList.toggle('wiz-active',  i + 1 === step);
    el.classList.toggle('wiz-done',    i + 1 < step);
    el.classList.toggle('wiz-pending', i + 1 > step);
  });
  // Paneles
  document.querySelectorAll('.wiz-panel').forEach(p => p.classList.add('hidden'));
  document.getElementById(`wiz-p${step}`).classList.remove('hidden');
  // Botones
  const back = document.getElementById('wiz-back');
  const next = document.getElementById('wiz-next');
  back.style.visibility = step > 1 ? 'visible' : 'hidden';
  next.textContent = step === 3 ? '🚀 Crear Reto' : 'Siguiente →';
  // Actualizar resumen si es paso 3
  if (step === 3) fillSummary();
}

function initWizard() {
  // Presets meta
  document.querySelectorAll('.preset-meta').forEach(b =>
    b.addEventListener('click', () => {
      document.querySelectorAll('.preset-meta').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      document.getElementById('wiz-meta').value = b.dataset.v;
      livePreview();
    })
  );
  // Presets casillas
  document.querySelectorAll('.preset-n').forEach(b =>
    b.addEventListener('click', () => {
      document.querySelectorAll('.preset-n').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      document.getElementById('wiz-n').value = b.dataset.v;
      livePreview();
    })
  );
  // Presets plazo
  document.querySelectorAll('.preset-plazo').forEach(b =>
    b.addEventListener('click', () => {
      document.querySelectorAll('.preset-plazo').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      document.getElementById('wiz-plazo').value = b.dataset.v;
      livePreview();
    })
  );

  ['wiz-meta','wiz-n','wiz-plazo'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', () => {
      // Quitar active de presets al escribir manual
      livePreview();
    });
  });

  document.getElementById('wiz-next').addEventListener('click', wizNext);
  document.getElementById('wiz-back').addEventListener('click', wizBack);
  livePreview();
}

function livePreview() {
  const meta  = parseInt(document.getElementById('wiz-meta')?.value) || 8000000;
  const n     = parseInt(document.getElementById('wiz-n')?.value)    || 200;
  const plazo = parseInt(document.getElementById('wiz-plazo')?.value)|| 12;
  const pMes  = Math.ceil(n / plazo);
  const avg   = Math.round(meta / n);

  setText('prev-meta',  fmt(meta));
  setText('prev-meta2', fmt(meta));
  setText('prev-n',     n + ' casillas');
  setText('prev-n2',    n + ' casillas');
  setText('prev-plazo', plazo + (plazo === 1 ? ' mes' : ' meses'));
  setText('prev-plazo2', plazo + (plazo === 1 ? ' mes' : ' meses'));
  setText('prev-ritmo', '~' + pMes + ' casilla' + (pMes===1?'':`s`) + '/mes');
  setText('prev-ritmo2', '~' + pMes + ' casilla' + (pMes===1?'':`s`) + '/mes');
  setText('prev-avg',   fmt(avg) + ' promedio');
}

function fillSummary() {
  const nombre = document.getElementById('wiz-nombre')?.value || 'Mi Reto';
  setText('sum-nombre', nombre);
  setText('sum-meta',   fmt(wDraft.meta));
  setText('sum-n',      wDraft.n + ' casillas');
  setText('sum-plazo',  wDraft.plazo + (wDraft.plazo === 1 ? ' mes' : ' meses'));
  setText('sum-avg',    fmt(Math.round(wDraft.meta / wDraft.n)) + ' promedio/casilla');
}

function wizNext() {
  clearWizErr();
  if (wStep === 1) {
    const meta = parseInt(document.getElementById('wiz-meta').value);
    const n    = parseInt(document.getElementById('wiz-n').value);
    if (!meta || meta < 10000)     { showWizErr('Ingresa una meta válida (mín. $10.000)'); return; }
    if (!n || n < 5 || n > 500)   { showWizErr('Las casillas deben estar entre 5 y 500'); return; }
    wDraft.meta = meta; wDraft.n = n;
    goToStep(2);
  } else if (wStep === 2) {
    const plazo = parseInt(document.getElementById('wiz-plazo').value);
    if (!plazo || plazo < 1 || plazo > 120) { showWizErr('El plazo debe estar entre 1 y 120 meses'); return; }
    wDraft.plazo = plazo;
    goToStep(3);
  } else if (wStep === 3) {
    const nombre = document.getElementById('wiz-nombre').value.trim();
    if (!nombre) { showWizErr('Ponle un nombre a tu reto'); return; }
    wDraft.nombre = nombre;
    wDraft.seed   = (Date.now() ^ (Math.random() * 0x7fffffff | 0)) >>> 0;
    saveCfg(wDraft);
    CFG = wDraft;
    CASILLAS = generateMontos(CFG.meta, CFG.n, CFG.seed).map((monto, i) => ({id: i+1, monto}));
    loadDone();
    document.getElementById('wizard-screen').classList.add('hidden');
    showApp();
  }
}
function wizBack() { if (wStep > 1) goToStep(wStep - 1); }
function showWizErr(msg) {
  const el = document.getElementById('wiz-err');
  if (!el) return;
  el.textContent = msg; el.classList.remove('hidden');
}
function clearWizErr() {
  const el = document.getElementById('wiz-err');
  if (el) el.classList.add('hidden');
}

// ════════════════════════════════════════════════════
//  APP
// ════════════════════════════════════════════════════
function showApp() {
  document.getElementById('app-screen').classList.remove('hidden');
  setText('hdr-nombre', CFG.nombre || 'Reto Ahorro');
  renderGrid();
  updateDashboard();
  bindEvents();
  syncFromSheets();
  clearInterval(syncTimer);  syncTimer  = setInterval(syncFromSheets, SYNC_MS);
  clearInterval(retryTimer); retryTimer = setInterval(flushQueue, RETRY_MS);
}

// ════════════════════════════════════════════════════
//  GRID — pendientes primero, completadas al final
// ════════════════════════════════════════════════════
function renderGrid() {
  const grid    = document.getElementById('grid');
  const pending  = CASILLAS.filter(c => !done[c.id]);
  const completed= CASILLAS.filter(c =>  done[c.id]);
  const ordered  = [...pending, ...completed];

  if (grid.children.length === CASILLAS.length) {
    const frag = document.createDocumentFragment();
    ordered.forEach(c => {
      const el = grid.querySelector(`.casilla[data-id="${c.id}"]`);
      if (el) { el.classList.toggle('done', !!done[c.id]); frag.appendChild(el); }
    });
    grid.appendChild(frag);
    applyFilter(); return;
  }

  grid.innerHTML = '';
  const frag = document.createDocumentFragment();
  ordered.forEach(c => frag.appendChild(makeCasilla(c)));
  grid.appendChild(frag);
  applyFilter();
}

function makeCasilla(c) {
  const color = getColor(c.monto);
  const el    = document.createElement('div');
  el.className  = 'casilla' + (done[c.id] ? ' done' : '');
  el.dataset.id = c.id;
  el.style.setProperty('--cc', color);
  el.innerHTML = `
    <span class="cas-num">#${String(c.id).padStart(3,'0')}</span>
    <span class="cas-amount">${fmt(c.monto)}</span>
    <i class="fa-solid fa-circle-check cas-check"></i>
    <div class="cas-particles"></div>
  `;
  el.addEventListener('click', () => onCasillaClick(c.id));
  return el;
}

function getColor(m) {
  // Color relativo a la media del reto
  const avg = CFG.meta / CFG.n;
  if (m < avg * 0.4)  return '#00e5a0';
  if (m < avg * 0.9)  return '#3d8bff';
  if (m < avg * 1.8)  return '#a78bfa';
  if (m < avg * 3.5)  return '#fb923c';
  return '#f472b6';
}

// ════════════════════════════════════════════════════
//  DASHBOARD
// ════════════════════════════════════════════════════
function updateDashboard() {
  const doneList = CASILLAS.filter(c => done[c.id]);
  const saved    = doneList.reduce((s, c) => s + c.monto, 0);
  const left     = Math.max(0, CFG.meta - saved);
  const pct      = Math.min(100, saved / CFG.meta * 100);
  const pendN    = CASILLAS.length - doneList.length;

  setText('hero-amount',  fmt(saved));
  setText('hero-meta',    'Meta: ' + fmt(CFG.meta));
  setText('stat-left',    fmt(left));
  setText('stat-done',    doneList.length);
  setText('stat-total-n', CASILLAS.length);
  setText('stat-pend',    pendN);

  const circ   = 263.9;
  const offset = circ - (circ * pct / 100);
  document.getElementById('ring-fill').setAttribute('stroke-dashoffset', offset.toFixed(1));
  setText('ring-pct',    Math.round(pct) + '%');
  document.getElementById('prog-fill').style.width = `${pct}%`;
  setText('prog-done-n',  doneList.length);
  setText('prog-total-n', CASILLAS.length);
  setText('fc-all',   CASILLAS.length);
  setText('fc-pend',  pendN);
  setText('fc-done',  doneList.length);
}

function applyFilter() {
  document.querySelectorAll('.casilla').forEach(el => {
    const id   = parseInt(el.dataset.id);
    let   show = true;
    if (filtro === 'pending') show = !done[id];
    if (filtro === 'done')    show =  !!done[id];
    el.classList.toggle('f-hide', !show);
  });
}

// ════════════════════════════════════════════════════
//  MARCAR CASILLA
// ════════════════════════════════════════════════════
function onCasillaClick(id) {
  if (done[id]) return;
  const c = CASILLAS.find(x => x.id === id); if (!c) return;
  pendingId = id;
  const color = getColor(c.monto);
  const iw = document.getElementById('mc-icon-wrap');
  iw.style.background  = `color-mix(in srgb, ${color} 14%, transparent)`;
  iw.style.borderColor = `color-mix(in srgb, ${color} 30%, transparent)`;
  iw.style.color       = color;
  setText('mc-title', `Casilla #${String(c.id).padStart(3,'0')}`);
  setText('mc-body',  '¿Confirmás que guardaste este dinero?');
  document.getElementById('mc-amount-row').innerHTML =
    `<i class="fa-solid fa-coins" style="color:${color}"></i> ${fmt(c.monto)}`;
  document.getElementById('modal-cas').classList.remove('hidden');
}

function confirmMark() {
  if (pendingId === null) return;
  const id = pendingId; pendingId = null;
  document.getElementById('modal-cas').classList.add('hidden');
  if (done[id]) return;

  done[id] = true;
  saveDone();

  const c  = CASILLAS.find(x => x.id === id);
  const el = document.querySelector(`.casilla[data-id="${id}"]`);
  if (el) {
    el.classList.add('done', 'popping');
    spawnParticles(el, getColor(c.monto));
    el.addEventListener('animationend', () => {
      el.classList.remove('popping');
      document.getElementById('grid').appendChild(el);
    }, {once: true});
  }

  updateDashboard();
  applyFilter();
  showToast(`✓ ${fmt(c.monto)} guardado`);
  writeToSheets(id);
}

function spawnParticles(el, color) {
  const pp = el.querySelector('.cas-particles'); if (!pp) return;
  for (let i = 0; i < 8; i++) {
    const p = document.createElement('div'); p.className = 'cas-p';
    p.style.cssText = `left:${10+Math.random()*80}%;top:${10+Math.random()*80}%;background:${color};animation-delay:${i*30}ms`;
    pp.appendChild(p); setTimeout(() => p.remove(), 600);
  }
}

// ════════════════════════════════════════════════════
//  GOOGLE SHEETS
// ════════════════════════════════════════════════════
async function syncFromSheets() {
  setSyncUI('syncing');
  try {
    const res  = await fetch(`${API_URL}?action=getAll&t=${Date.now()}`);
    const data = await res.json();
    if (data?.casillas?.length) {
      let changed = false;
      data.casillas.forEach(r => {
        const id = r.id, nd = !!r.completada;
        if (done[id] !== undefined && done[id] !== nd) { done[id] = nd; changed = true; }
      });
      if (changed) { saveDone(); renderGrid(); updateDashboard(); }
    }
    setSyncUI('online');
    setFooter('Sincronizado — ' + new Date().toLocaleTimeString());
  } catch(_) {
    setSyncUI('offline');
    setFooter('Sin conexión — datos locales activos');
  }
}

async function writeToSheets(id) {
  const c = CASILLAS.find(x => x.id === id); if (!c) return;
  try {
    const res = await fetch(API_URL, {
      method: 'POST', headers: {'Content-Type': 'text/plain'},
      body: JSON.stringify({action:'update', id, monto:c.monto, completada:true, fechaActualizacion:new Date().toISOString()}),
    });
    const d = await res.json();
    if (d?.ok) { writeQueue = writeQueue.filter(q => q !== id); setFooter('Guardado en nube — ' + new Date().toLocaleTimeString()); }
    else enqueue(id);
  } catch(_) { enqueue(id); setSyncUI('offline'); }
}

function enqueue(id) { if (!writeQueue.includes(id)) writeQueue.push(id); }
async function flushQueue() { for (const id of [...writeQueue]) await writeToSheets(id); }
async function resetOnSheets() {
  try { await fetch(API_URL, {method:'POST', headers:{'Content-Type':'text/plain'}, body:JSON.stringify({action:'resetAll'})}); }
  catch(_) {}
}

// ════════════════════════════════════════════════════
//  EVENTOS
// ════════════════════════════════════════════════════
function bindEvents() {
  document.getElementById('btn-theme').addEventListener('click', toggleTheme);

  // Reiniciar progreso (mantiene config)
  document.getElementById('btn-reset').addEventListener('click', () =>
    document.getElementById('modal-reset').classList.remove('hidden'));
  document.getElementById('mr-cancel').addEventListener('click', () =>
    document.getElementById('modal-reset').classList.add('hidden'));
  document.getElementById('mr-ok').addEventListener('click', () => {
    document.getElementById('modal-reset').classList.add('hidden');
    doReset();
  });

  // Nuevo reto (borra todo, vuelve al wizard)
  document.getElementById('btn-config').addEventListener('click', () =>
    document.getElementById('modal-reconfig').classList.remove('hidden'));
  document.getElementById('mrc-cancel').addEventListener('click', () =>
    document.getElementById('modal-reconfig').classList.add('hidden'));
  document.getElementById('mrc-ok').addEventListener('click', () => {
    document.getElementById('modal-reconfig').classList.add('hidden');
    clearInterval(syncTimer); clearInterval(retryTimer);
    localStorage.removeItem(LS_CFG); localStorage.removeItem(LS_DONE);
    resetOnSheets();
    CFG = null; CASILLAS = []; done = {};
    document.getElementById('app-screen').classList.add('hidden');
    document.getElementById('grid').innerHTML = '';
    showWizard();
  });

  document.getElementById('mc-ok').addEventListener('click', confirmMark);
  document.getElementById('mc-cancel').addEventListener('click', () => {
    pendingId = null;
    document.getElementById('modal-cas').classList.add('hidden');
  });

  ['modal-cas','modal-reset','modal-reconfig'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', e => { if (e.target.id === id) e.target.classList.add('hidden'); });
  });

  document.getElementById('btn-logout').addEventListener('click', () => {
    clearInterval(syncTimer); clearInterval(retryTimer);
    sessionStorage.removeItem(LS_AUTH);
    document.getElementById('app-screen').classList.add('hidden');
    document.getElementById('login-screen').classList.remove('hidden');
    pinBuf = ''; renderDots();
    document.getElementById('pin-msg').classList.add('hidden');
  });

  document.querySelectorAll('.fpill').forEach(b =>
    b.addEventListener('click', () => {
      document.querySelectorAll('.fpill').forEach(x => x.classList.remove('active'));
      b.classList.add('active'); filtro = b.dataset.f; applyFilter();
    })
  );
}

// ════════════════════════════════════════════════════
//  RESET (mantiene config)
// ════════════════════════════════════════════════════
function doReset() {
  CASILLAS.forEach(c => { done[c.id] = false; });
  saveDone(); writeQueue = [];
  renderGrid(); updateDashboard();
  showToast('Progreso reiniciado');
  resetOnSheets();
}

// ════════════════════════════════════════════════════
//  TEMA
// ════════════════════════════════════════════════════
function applyTheme() {
  const t = localStorage.getItem(LS_THEME) || 'dark';
  document.body.className = t;
  const ic = document.getElementById('theme-icon');
  if (ic) ic.className = t === 'dark' ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
}
function toggleTheme() {
  const next = document.body.classList.contains('dark') ? 'light' : 'dark';
  document.body.className = next; localStorage.setItem(LS_THEME, next);
  const ic = document.getElementById('theme-icon');
  if (ic) ic.className = next === 'dark' ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
}

// ════════════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════════════
function setSyncUI(state) {
  const dot = document.getElementById('badge-dot');
  const txt = document.getElementById('badge-txt');
  if (!dot || !txt) return;
  dot.className = 'badge-dot';
  if (state === 'online')  txt.textContent = 'En línea';
  if (state === 'offline') { dot.classList.add('offline'); txt.textContent = 'Sin conexión'; }
  if (state === 'syncing') { dot.classList.add('syncing'); txt.textContent = 'Sincronizando...'; }
}
function setFooter(msg) { const el = document.getElementById('footer-status'); if (el) el.textContent = msg; }
function setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }
function fmt(n) { return '$' + Math.round(n).toLocaleString('es-CO'); }
function showToast(msg) {
  const el = document.getElementById('toast'), tx = document.getElementById('toast-msg');
  if (!el || !tx) return;
  tx.textContent = msg; el.classList.remove('hidden');
  clearTimeout(_tt); _tt = setTimeout(() => el.classList.add('hidden'), 2600);
}

// Init wizard on load
document.addEventListener('DOMContentLoaded', initWizard);