/*
 * RETO AHORRO — app.js v3 (Firebase Firestore)
 * Desarrollado por Deison Bm
 * * ─────────────────────────────────────────────────────
 */

// ══════════════════════════════════════════════════════
// CONFIGURACIÓN DE FIREBASE
// ══════════════════════════════════════════════════════
const firebaseConfig = {
  apiKey: "AIzaSyDlfkGoQqtPZsk93CQRUFyLGHRu0lm6vwc",
  authDomain: "reto-ahorro-a05b1.firebaseapp.com",
  projectId: "reto-ahorro-a05b1",
  storageBucket: "reto-ahorro-a05b1.firebasestorage.app",
  messagingSenderId: "622538392610",
  appId: "1:622538392610:web:3d4376a7a5c2e78867f67b"
};

// ID fijo del reto compartido (todos acceden al mismo)
// Si quieres múltiples retos distintos, cámbialo por un valor diferente
const RETO_ID = 'reto-principal';

// ══════════════════════════════════════════════════════
//  CONSTANTES
// ══════════════════════════════════════════════════════
const LS_THEME = 'reto_theme';
const LS_AUTH  = 'reto_auth';
const LS_CACHE = 'reto_cache_v3';   // cache local (fallback offline)

const _H = s => [...s].reduce((h,c) => Math.imul(31,h) + c.charCodeAt(0)|0, 5381);
const PIN_HASH = _H('2323');

// ══════════════════════════════════════════════════════
//  ESTADO GLOBAL
// ══════════════════════════════════════════════════════
let db         = null;
let CFG        = null;   // {meta, n, plazo, seed, nombre, fechaCreacion}
let CASILLAS   = [];
let done       = {};     // {id: bool}
let pinBuf     = '';
let filtro     = 'all';
let pendingId  = null;
let unsubscribe = null;  // listener en tiempo real
let _tt        = null;

// ══════════════════════════════════════════════════════
//  REFERENCIAS FIRESTORE
//  retos/{RETO_ID}            → config del reto
//  retos/{RETO_ID}/casillas/{id} → estado de cada casilla
// ══════════════════════════════════════════════════════
const retoRef    = () => db.collection('retos').doc(RETO_ID);
const casillaRef = (id) => retoRef().collection('casillas').doc(String(id));

// ══════════════════════════════════════════════════════
//  GENERADOR DE MONTOS (determinista con seed)
// ══════════════════════════════════════════════════════
function roundNice(v) {
  if (v <= 0)       return 500;
  if (v < 2000)     return Math.max(500, Math.round(v/500)*500);
  if (v < 10000)    return Math.round(v/1000)*1000;
  if (v < 50000)    return Math.round(v/5000)*5000;
  if (v < 200000)   return Math.round(v/10000)*10000;
  if (v < 1000000)  return Math.round(v/50000)*50000;
  return Math.round(v/100000)*100000;
}

function generateMontos(meta, n, seed) {
  let s = (seed ^ 0xdeadbeef) >>> 0;
  const rand = () => { s=(s*1664525+1013904223)>>>0; return s/0x100000000; };
  const raw  = Array.from({length:n}, () => {
    const u1=rand()+1e-9, u2=rand();
    return Math.exp(Math.sqrt(-2*Math.log(u1))*Math.cos(2*Math.PI*u2)*1.2+2);
  });
  const sumRaw = raw.reduce((a,b)=>a+b,0);
  let montos   = raw.map(r=>roundNice(r/sumRaw*meta));
  for (let iter=0;iter<80;iter++) {
    const diff = meta - montos.reduce((a,b)=>a+b,0);
    if (diff===0) break;
    const sorted = montos.map((v,i)=>({v,i})).sort((a,b)=>b.v-a.v);
    for (const {i} of sorted) {
      const d=meta-montos.reduce((a,b)=>a+b,0);
      if (d===0) break;
      const step=d>0?Math.min(roundNice(d),d):Math.max(-roundNice(-d),d);
      const nv=roundNice(montos[i]+step);
      if (nv>0) montos[i]=nv;
    }
  }
  const maxI=montos.indexOf(Math.max(...montos));
  montos[maxI]+=meta-montos.reduce((a,b)=>a+b,0);
  for (let i=n-1;i>0;i--) {
    const j=Math.floor(rand()*(i+1));
    [montos[i],montos[j]]=[montos[j],montos[i]];
  }
  return montos;
}

// ══════════════════════════════════════════════════════
//  ARRANQUE
// ══════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  applyTheme();
  buildStars();
  initLogin();
  if (sessionStorage.getItem(LS_AUTH) === '1') afterLogin();
});

// ══════════════════════════════════════════════════════
//  ESTRELLAS
// ══════════════════════════════════════════════════════
function buildStars() {
  const c = document.getElementById('stars-canvas');
  if (!c) return;
  const ctx = c.getContext('2d');
  let s = [];
  const resize = () => {
    c.width=innerWidth; c.height=innerHeight;
    s=Array.from({length:120},()=>({
      x:Math.random()*c.width, y:Math.random()*c.height,
      r:Math.random()*1.4+.3, o:Math.random(), d:Math.random()*.003+.001
    }));
  };
  const draw = () => {
    ctx.clearRect(0,0,c.width,c.height);
    s.forEach(p=>{
      p.o+=p.d; if(p.o>1||p.o<0) p.d*=-1;
      ctx.beginPath(); ctx.arc(p.x,p.y,p.r,0,Math.PI*2);
      ctx.fillStyle=`rgba(255,255,255,${Math.max(0,Math.min(1,p.o)).toFixed(2)})`;
      ctx.fill();
    });
    requestAnimationFrame(draw);
  };
  addEventListener('resize',resize); resize(); draw();
}

// ══════════════════════════════════════════════════════
//  LOGIN
// ══════════════════════════════════════════════════════
function initLogin() {
  document.querySelectorAll('.kbtn[data-n]').forEach(b=>
    b.addEventListener('click', ()=>pressKey(b.dataset.n)));
  document.getElementById('kbtn-del').addEventListener('click', delKey);
  document.addEventListener('keydown', e=>{
    if (document.getElementById('login-screen').classList.contains('hidden')) return;
    if (e.key>='0'&&e.key<='9') pressKey(e.key);
    if (e.key==='Backspace') delKey();
  });
}
function pressKey(n) {
  if (pinBuf.length>=4) return;
  pinBuf+=n; renderDots();
  if (pinBuf.length===4) setTimeout(checkPin, 180);
}
function delKey() { pinBuf=pinBuf.slice(0,-1); renderDots(); }
function renderDots() {
  for (let i=0;i<4;i++) {
    const d=document.getElementById(`pd${i}`);
    d.classList.toggle('filled', i<pinBuf.length);
    d.classList.remove('shake');
  }
}
function checkPin() {
  if (_H(pinBuf)===PIN_HASH) {
    sessionStorage.setItem(LS_AUTH,'1');
    for (let i=0;i<4;i++) {
      const d=document.getElementById(`pd${i}`);
      Object.assign(d.style,{background:'#00e5a0',borderColor:'#00e5a0',boxShadow:'0 0 12px #00e5a0'});
    }
    setTimeout(afterLogin, 430);
  } else {
    for (let i=0;i<4;i++) document.getElementById(`pd${i}`).classList.add('shake');
    document.getElementById('pin-msg').classList.remove('hidden');
    pinBuf='';
    setTimeout(()=>{ renderDots(); document.getElementById('pin-msg').classList.add('hidden'); },1300);
  }
}
function afterLogin() {
  document.getElementById('login-screen').classList.add('hidden');
  bootApp();
}

// ══════════════════════════════════════════════════════
//  BOOT — inicia Firebase y carga config
// ══════════════════════════════════════════════════════
async function bootApp() {
  showLoading('Conectando con Firebase...');

  // Inicializar Firebase
  try {
    if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
    db = firebase.firestore();
    // Persistencia offline: si no hay internet usa caché local de Firestore
    db.settings({ cacheSizeBytes: firebase.firestore.CACHE_SIZE_UNLIMITED });
  } catch(e) {
    hideLoading();
    showToast('Error al conectar con Firebase. Revisa la config.', 'error');
    console.error('Firebase init error:', e);
    return;
  }

  // Cargar configuración del reto desde Firestore
  showLoading('Cargando tu reto...');
  try {
    const snap = await retoRef().get();
    if (snap.exists && snap.data()?.meta) {
      CFG = snap.data();
      saveCache(CFG, {});
    }
  } catch(e) {
    // Offline: intentar caché local del navegador
    const cached = loadCache();
    if (cached) CFG = cached.cfg;
  }

  hideLoading();

  if (!CFG) {
    showWizard();
    return;
  }

  CASILLAS = generateMontos(CFG.meta, CFG.n, CFG.seed).map((monto,i)=>({id:i+1,monto}));
  initDone();
  showApp();
  startRealtimeSync(); // escucha cambios en tiempo real
}

function showLoading(txt='Cargando...') {
  const el=document.getElementById('loading-screen');
  const tx=el?.querySelector('.loading-txt');
  if (tx) tx.textContent=txt;
  el?.classList.remove('hidden');
}
function hideLoading() {
  document.getElementById('loading-screen')?.classList.add('hidden');
}

// ══════════════════════════════════════════════════════
//  CACHE LOCAL (fallback offline)
// ══════════════════════════════════════════════════════
function saveCache(cfg, doneMap) {
  try { localStorage.setItem(LS_CACHE, JSON.stringify({cfg, doneMap})); } catch(_){}
}
function loadCache() {
  try { return JSON.parse(localStorage.getItem(LS_CACHE)) || null; } catch(_){ return null; }
}

// ══════════════════════════════════════════════════════
//  ESTADO done
// ══════════════════════════════════════════════════════
function initDone() {
  // Todas en false al arrancar; se sobreescriben con el listener
  done = {};
  CASILLAS.forEach(c=>{ done[c.id]=false; });
}

// ══════════════════════════════════════════════════════
//  SINCRONIZACIÓN EN TIEMPO REAL (Firestore onSnapshot)
// ══════════════════════════════════════════════════════
function startRealtimeSync() {
  if (unsubscribe) unsubscribe();

  unsubscribe = retoRef().collection('casillas').onSnapshot(
    snapshot => {
      let changed = false;
      snapshot.docChanges().forEach(change => {
        const id  = parseInt(change.doc.id);
        const nd  = !!change.doc.data()?.completada;
        if (done[id] !== nd) { done[id]=nd; changed=true; }
      });
      if (changed) {
        renderGrid();
        updateDashboard();
        saveCache(CFG, done);
      }
      setSyncUI('online');
      setFooter('En tiempo real · ' + new Date().toLocaleTimeString());
    },
    err => {
      console.warn('Sync error:', err);
      setSyncUI('offline');
      setFooter('Sin conexión — datos locales activos');
    }
  );
}

// ══════════════════════════════════════════════════════
//  WIZARD — 3 pasos
// ══════════════════════════════════════════════════════
let wStep  = 1;
let wDraft = {};

function showWizard() {
  document.getElementById('wizard-screen').classList.remove('hidden');
  document.getElementById('app-screen').classList.add('hidden');
  wStep=1; wDraft={};
  goToStep(1);
}

function goToStep(step) {
  wStep=step;
  document.querySelectorAll('.wiz-step').forEach((el,i)=>{
    el.classList.toggle('wiz-active',  i+1===step);
    el.classList.toggle('wiz-done',    i+1<step);
    el.classList.toggle('wiz-pending', i+1>step);
  });
  document.querySelectorAll('.wiz-panel').forEach(p=>p.classList.add('hidden'));
  document.getElementById(`wiz-p${step}`).classList.remove('hidden');
  const back=document.getElementById('wiz-back');
  const next=document.getElementById('wiz-next');
  back.style.visibility=step>1?'visible':'hidden';
  next.textContent=step===3?'🚀 Crear Reto':'Siguiente →';
  if (step===3) fillSummary();
}

function initWizard() {
  document.querySelectorAll('.preset-meta').forEach(b=>
    b.addEventListener('click',()=>{
      document.querySelectorAll('.preset-meta').forEach(x=>x.classList.remove('active'));
      b.classList.add('active');
      document.getElementById('wiz-meta').value=b.dataset.v;
      livePreview();
    })
  );
  document.querySelectorAll('.preset-n').forEach(b=>
    b.addEventListener('click',()=>{
      document.querySelectorAll('.preset-n').forEach(x=>x.classList.remove('active'));
      b.classList.add('active');
      document.getElementById('wiz-n').value=b.dataset.v;
      livePreview();
    })
  );
  document.querySelectorAll('.preset-plazo').forEach(b=>
    b.addEventListener('click',()=>{
      document.querySelectorAll('.preset-plazo').forEach(x=>x.classList.remove('active'));
      b.classList.add('active');
      document.getElementById('wiz-plazo').value=b.dataset.v;
      livePreview();
    })
  );
  ['wiz-meta','wiz-n','wiz-plazo'].forEach(id=>{
    document.getElementById(id)?.addEventListener('input',()=>livePreview());
  });
  document.getElementById('wiz-next').addEventListener('click', wizNext);
  document.getElementById('wiz-back').addEventListener('click', wizBack);
  livePreview();
}

function livePreview() {
  const meta  = parseInt(document.getElementById('wiz-meta')?.value)||8000000;
  const n     = parseInt(document.getElementById('wiz-n')?.value)||200;
  const plazo = parseInt(document.getElementById('wiz-plazo')?.value)||12;
  const pMes  = Math.ceil(n/plazo);
  const avg   = Math.round(meta/n);
  setText('prev-meta',   fmt(meta));
  setText('prev-meta2',  fmt(meta));
  setText('prev-n',      n+' casillas');
  setText('prev-n2',     n+' casillas');
  setText('prev-plazo',  plazo+(plazo===1?' mes':' meses'));
  setText('prev-plazo2', plazo+(plazo===1?' mes':' meses'));
  setText('prev-ritmo',  '~'+pMes+' casilla'+(pMes===1?'':'s')+'/mes');
  setText('prev-ritmo2', '~'+pMes+' casilla'+(pMes===1?'':'s')+'/mes');
  setText('prev-avg',    fmt(avg)+' promedio');
}

function fillSummary() {
  const nombre=document.getElementById('wiz-nombre')?.value||'Mi Reto';
  setText('sum-nombre', nombre);
  setText('sum-meta',   fmt(wDraft.meta));
  setText('sum-n',      wDraft.n+' casillas');
  setText('sum-plazo',  wDraft.plazo+(wDraft.plazo===1?' mes':' meses'));
  setText('sum-avg',    fmt(Math.round(wDraft.meta/wDraft.n))+' promedio/casilla');
}

async function wizNext() {
  clearWizErr();
  if (wStep===1) {
    const meta=parseInt(document.getElementById('wiz-meta').value);
    const n=parseInt(document.getElementById('wiz-n').value);
    if (!meta||meta<10000)   { showWizErr('Ingresa una meta válida (mín. $10.000)'); return; }
    if (!n||n<5||n>500)      { showWizErr('Las casillas deben estar entre 5 y 500'); return; }
    wDraft.meta=meta; wDraft.n=n;
    goToStep(2);
  } else if (wStep===2) {
    const plazo=parseInt(document.getElementById('wiz-plazo').value);
    if (!plazo||plazo<1||plazo>120){ showWizErr('El plazo debe estar entre 1 y 120 meses'); return; }
    wDraft.plazo=plazo;
    goToStep(3);
  } else if (wStep===3) {
    const nombre=document.getElementById('wiz-nombre').value.trim();
    if (!nombre) { showWizErr('Ponle un nombre a tu reto'); return; }
    wDraft.nombre        = nombre;
    wDraft.seed          = (Date.now() ^ (Math.random()*0x7fffffff|0)) >>> 0;
    wDraft.fechaCreacion = new Date().toISOString();

    // Deshabilitar botón mientras guarda
    const btn=document.getElementById('wiz-next');
    btn.disabled=true; btn.textContent='Guardando...';

    try {
      // Guardar config en Firestore (documento raíz del reto)
      await retoRef().set(wDraft);
      CFG = wDraft;
      saveCache(CFG, {});
      CASILLAS = generateMontos(CFG.meta, CFG.n, CFG.seed).map((monto,i)=>({id:i+1,monto}));
      initDone();
      document.getElementById('wizard-screen').classList.add('hidden');
      showApp();
      startRealtimeSync();
    } catch(e) {
      btn.disabled=false; btn.textContent='🚀 Crear Reto';
      showWizErr('Error al guardar. Verifica tu conexión.');
      console.error(e);
    }
  }
}
function wizBack() { if (wStep>1) goToStep(wStep-1); }
function showWizErr(msg) {
  const el=document.getElementById('wiz-err');
  if (!el) return;
  const sp=el.querySelector('span');
  if (sp) sp.textContent=msg; else el.childNodes[1] && (el.childNodes[1].textContent=msg);
  el.classList.remove('hidden');
}
function clearWizErr() { document.getElementById('wiz-err')?.classList.add('hidden'); }

// ══════════════════════════════════════════════════════
//  APP
// ══════════════════════════════════════════════════════
function showApp() {
  document.getElementById('app-screen').classList.remove('hidden');
  setText('hdr-nombre', CFG.nombre||'Reto Ahorro');
  renderGrid();
  updateDashboard();
  bindEvents();
  setSyncUI('syncing');
}

// ══════════════════════════════════════════════════════
//  GRID
// ══════════════════════════════════════════════════════
function renderGrid() {
  const grid    =document.getElementById('grid');
  const pending  =CASILLAS.filter(c=>!done[c.id]);
  const completed=CASILLAS.filter(c=> done[c.id]);
  const ordered  =[...pending,...completed];

  if (grid.children.length===CASILLAS.length) {
    const frag=document.createDocumentFragment();
    ordered.forEach(c=>{
      const el=grid.querySelector(`.casilla[data-id="${c.id}"]`);
      if (el) { el.classList.toggle('done',!!done[c.id]); frag.appendChild(el); }
    });
    grid.appendChild(frag);
    applyFilter(); return;
  }

  grid.innerHTML='';
  const frag=document.createDocumentFragment();
  ordered.forEach(c=>frag.appendChild(makeCasilla(c)));
  grid.appendChild(frag);
  applyFilter();
}

function makeCasilla(c) {
  const color=getColor(c.monto);
  const el=document.createElement('div');
  el.className ='casilla'+(done[c.id]?' done':'');
  el.dataset.id=c.id;
  el.style.setProperty('--cc',color);
  el.innerHTML=`
    <span class="cas-num">#${String(c.id).padStart(3,'0')}</span>
    <span class="cas-amount">${fmt(c.monto)}</span>
    <i class="fa-solid fa-circle-check cas-check"></i>
    <div class="cas-particles"></div>
  `;
  el.addEventListener('click',()=>onCasillaClick(c.id));
  return el;
}

function getColor(m) {
  const avg=CFG.meta/CFG.n;
  if (m<avg*0.4)  return '#00e5a0';
  if (m<avg*0.9)  return '#3d8bff';
  if (m<avg*1.8)  return '#a78bfa';
  if (m<avg*3.5)  return '#fb923c';
  return '#f472b6';
}

// ══════════════════════════════════════════════════════
//  DASHBOARD
// ══════════════════════════════════════════════════════
function updateDashboard() {
  const doneList=CASILLAS.filter(c=>done[c.id]);
  const saved   =doneList.reduce((s,c)=>s+c.monto,0);
  const left    =Math.max(0,CFG.meta-saved);
  const pct     =Math.min(100,saved/CFG.meta*100);
  const pendN   =CASILLAS.length-doneList.length;

  setText('hero-amount',  fmt(saved));
  setText('hero-meta',    'Meta: '+fmt(CFG.meta));
  setText('stat-left',    fmt(left));
  setText('stat-done',    doneList.length);
  setText('stat-total-n', CASILLAS.length);
  setText('stat-pend',    pendN);

  const circ=263.9, offset=circ-(circ*pct/100);
  document.getElementById('ring-fill').setAttribute('stroke-dashoffset',offset.toFixed(1));
  setText('ring-pct',    Math.round(pct)+'%');
  document.getElementById('prog-fill').style.width=`${pct}%`;
  setText('prog-done-n',  doneList.length);
  setText('prog-total-n', CASILLAS.length);
  setText('fc-all',       CASILLAS.length);
  setText('fc-pend',      pendN);
  setText('fc-done',      doneList.length);
}

function applyFilter() {
  document.querySelectorAll('.casilla').forEach(el=>{
    const id=parseInt(el.dataset.id);
    let show=true;
    if (filtro==='pending') show=!done[id];
    if (filtro==='done')    show= !!done[id];
    el.classList.toggle('f-hide',!show);
  });
}

// ══════════════════════════════════════════════════════
//  MARCAR CASILLA
// ══════════════════════════════════════════════════════
function onCasillaClick(id) {
  if (done[id]) return;
  const c=CASILLAS.find(x=>x.id===id); if (!c) return;
  pendingId=id;
  const color=getColor(c.monto);
  const iw=document.getElementById('mc-icon-wrap');
  iw.style.background  =`color-mix(in srgb,${color} 14%,transparent)`;
  iw.style.borderColor =`color-mix(in srgb,${color} 30%,transparent)`;
  iw.style.color       =color;
  setText('mc-title', `Casilla #${String(c.id).padStart(3,'0')}`);
  setText('mc-body',  '¿Confirmás que guardaste este dinero?');
  document.getElementById('mc-amount-row').innerHTML=
    `<i class="fa-solid fa-coins" style="color:${color}"></i> ${fmt(c.monto)}`;
  document.getElementById('modal-cas').classList.remove('hidden');
}

async function confirmMark() {
  if (pendingId===null) return;
  const id=pendingId; pendingId=null;
  document.getElementById('modal-cas').classList.add('hidden');
  if (done[id]) return;

  // Optimistic UI: actualizar localmente primero
  done[id]=true;
  const c =CASILLAS.find(x=>x.id===id);
  const el=document.querySelector(`.casilla[data-id="${id}"]`);
  if (el) {
    el.classList.add('done','popping');
    spawnParticles(el, getColor(c.monto));
    el.addEventListener('animationend',()=>{
      el.classList.remove('popping');
      document.getElementById('grid').appendChild(el);
    },{once:true});
  }
  updateDashboard();
  applyFilter();
  showToast(`✓ ${fmt(c.monto)} guardado`);

  // Escribir en Firestore (en segundo plano)
  try {
    await casillaRef(id).set({
      monto:      c.monto,
      completada: true,
      fecha:      new Date().toISOString()
    });
    saveCache(CFG, done);
  } catch(e) {
    // Si falla, revertir
    done[id]=false;
    renderGrid();
    updateDashboard();
    showToast('Error al guardar. Sin conexión.', 'error');
    console.error(e);
  }
}

function spawnParticles(el, color) {
  const pp=el.querySelector('.cas-particles'); if (!pp) return;
  for (let i=0;i<8;i++) {
    const p=document.createElement('div'); p.className='cas-p';
    p.style.cssText=`left:${10+Math.random()*80}%;top:${10+Math.random()*80}%;background:${color};animation-delay:${i*30}ms`;
    pp.appendChild(p); setTimeout(()=>p.remove(),600);
  }
}

// ══════════════════════════════════════════════════════
//  RESET
// ══════════════════════════════════════════════════════
async function doReset() {
  showLoading('Reiniciando...');
  try {
    // Borrar toda la subcolección casillas en Firestore
    const snap=await retoRef().collection('casillas').get();
    const batch=db.batch();
    snap.forEach(doc=>batch.delete(doc.ref));
    await batch.commit();

    // Reiniciar local
    CASILLAS.forEach(c=>{ done[c.id]=false; });
    saveCache(CFG, done);
    renderGrid();
    updateDashboard();
    showToast('Progreso reiniciado');
  } catch(e) {
    showToast('Error al reiniciar. Sin conexión.', 'error');
    console.error(e);
  }
  hideLoading();
}

// ══════════════════════════════════════════════════════
//  NUEVO RETO
// ══════════════════════════════════════════════════════
async function doNewReto() {
  showLoading('Borrando reto...');
  try {
    // Borrar casillas
    const snap=await retoRef().collection('casillas').get();
    const batch=db.batch();
    snap.forEach(doc=>batch.delete(doc.ref));
    await batch.commit();
    // Borrar config del reto
    await retoRef().delete();

    localStorage.removeItem(LS_CACHE);
    CFG=null; CASILLAS=[]; done={};
    if (unsubscribe) { unsubscribe(); unsubscribe=null; }
    document.getElementById('app-screen').classList.add('hidden');
    document.getElementById('grid').innerHTML='';
    hideLoading();
    showWizard();
  } catch(e) {
    hideLoading();
    showToast('Error. Sin conexión.', 'error');
    console.error(e);
  }
}

// ══════════════════════════════════════════════════════
//  EVENTOS
// ══════════════════════════════════════════════════════
function bindEvents() {
  document.getElementById('btn-theme').addEventListener('click', toggleTheme);

  document.getElementById('btn-reset').addEventListener('click',()=>
    document.getElementById('modal-reset').classList.remove('hidden'));
  document.getElementById('mr-cancel').addEventListener('click',()=>
    document.getElementById('modal-reset').classList.add('hidden'));
  document.getElementById('mr-ok').addEventListener('click',()=>{
    document.getElementById('modal-reset').classList.add('hidden');
    doReset();
  });

  document.getElementById('btn-config').addEventListener('click',()=>
    document.getElementById('modal-reconfig').classList.remove('hidden'));
  document.getElementById('mrc-cancel').addEventListener('click',()=>
    document.getElementById('modal-reconfig').classList.add('hidden'));
  document.getElementById('mrc-ok').addEventListener('click',()=>{
    document.getElementById('modal-reconfig').classList.add('hidden');
    doNewReto();
  });

  document.getElementById('mc-ok').addEventListener('click', confirmMark);
  document.getElementById('mc-cancel').addEventListener('click',()=>{
    pendingId=null;
    document.getElementById('modal-cas').classList.add('hidden');
  });

  ['modal-cas','modal-reset','modal-reconfig'].forEach(id=>{
    const el=document.getElementById(id);
    if (el) el.addEventListener('click',e=>{ if(e.target.id===id) e.target.classList.add('hidden'); });
  });

  document.getElementById('btn-logout').addEventListener('click',()=>{
    if (unsubscribe) { unsubscribe(); unsubscribe=null; }
    sessionStorage.removeItem(LS_AUTH);
    document.getElementById('app-screen').classList.add('hidden');
    document.getElementById('login-screen').classList.remove('hidden');
    pinBuf=''; renderDots();
    document.getElementById('pin-msg').classList.add('hidden');
  });

  document.querySelectorAll('.fpill').forEach(b=>
    b.addEventListener('click',()=>{
      document.querySelectorAll('.fpill').forEach(x=>x.classList.remove('active'));
      b.classList.add('active'); filtro=b.dataset.f; applyFilter();
    })
  );
}

// ══════════════════════════════════════════════════════
//  TEMA
// ══════════════════════════════════════════════════════
function applyTheme() {
  const t=localStorage.getItem(LS_THEME)||'dark';
  document.body.className=t;
  const ic=document.getElementById('theme-icon');
  if (ic) ic.className=t==='dark'?'fa-solid fa-sun':'fa-solid fa-moon';
}
function toggleTheme() {
  const next=document.body.classList.contains('dark')?'light':'dark';
  document.body.className=next; localStorage.setItem(LS_THEME,next);
  const ic=document.getElementById('theme-icon');
  if (ic) ic.className=next==='dark'?'fa-solid fa-sun':'fa-solid fa-moon';
}

// ══════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════
function setSyncUI(state) {
  const dot=document.getElementById('badge-dot');
  const txt=document.getElementById('badge-txt');
  if (!dot||!txt) return;
  dot.className='badge-dot';
  if (state==='online')  txt.textContent='En línea';
  if (state==='offline') { dot.classList.add('offline'); txt.textContent='Sin conexión'; }
  if (state==='syncing') { dot.classList.add('syncing'); txt.textContent='Sincronizando...'; }
}
function setFooter(msg) { const el=document.getElementById('footer-status'); if(el) el.textContent=msg; }
function setText(id,val) { const el=document.getElementById(id); if(el) el.textContent=val; }
function fmt(n) { return '$'+Math.round(n).toLocaleString('es-CO'); }
function showToast(msg, type='ok') {
  const el=document.getElementById('toast');
  const tx=document.getElementById('toast-msg');
  const ic=el?.querySelector('.toast-icon');
  if (!el||!tx) return;
  tx.textContent=msg;
  if (ic) ic.className=type==='error'
    ?'fa-solid fa-circle-xmark toast-icon toast-err'
    :'fa-solid fa-circle-check toast-icon';
  el.classList.remove('hidden');
  clearTimeout(_tt); _tt=setTimeout(()=>el.classList.add('hidden'),2800);
}

document.addEventListener('DOMContentLoaded', initWizard);
