// Dominio System — Dashboard Cliente v3
// Orquesta: Supabase client, views, realtime, ARIA

// ============================================
// SENTRY · global error handlers (renderer → main vía IPC)
// v2.1.39: unificado con captura de _lastErrorMsg para bug reports.
// Antes había DOS addEventListener('error') separados (uno acá + otro
// abajo en línea 3578) → handler duplicado, listener leak.
// ============================================
window._lastErrorMsg = null;
(function _wireSentryHandlers(){
  window.addEventListener('error', (e) => {
    try {
      const msg = e?.error?.message || e?.message || '';
      if(msg && !msg.includes('ResizeObserver')) window._lastErrorMsg = msg.slice(0, 300);
      if(window.electronAPI?.sentryCapture){
        const err = e?.error instanceof Error ? e.error : new Error(msg || 'Unknown error');
        window.electronAPI.sentryCapture(err);
      }
    } catch(_){}
  });

  window.addEventListener('unhandledrejection', (e) => {
    try {
      const reason = e?.reason;
      const msg = (reason instanceof Error ? reason.message : (typeof reason === 'string' ? reason : JSON.stringify(reason))) || '';
      if(msg) window._lastErrorMsg = msg.slice(0, 300);
      if(window.electronAPI?.sentryCapture){
        const err = reason instanceof Error ? reason : new Error(msg);
        window.electronAPI.sentryCapture(err);
      }
    } catch(_){}
  });
})();

// ============================================
// SUPABASE CLIENT (con JWT del cliente logueado)
// ============================================
const SUPABASE_URL = 'https://ywlyuuddqitduqtdttgo.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl3bHl1dWRkcWl0ZHVxdGR0dGdvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwNDg2MzgsImV4cCI6MjA4OTYyNDYzOH0.vpjRNcQ_v2Vo9M2oQsCq95mSLOCctRf6cO4sWzpNCF8';

// Session se carga desde IPC (main process). Hasta que boot() la cargue, usamos anon.
window.SESSION = null;
window.CLIENT_ID = null;
window.ACCESS_TOKEN = SUPABASE_ANON;

// Supabase client (SDK para realtime + auto-attach JWT en queries PostgREST)
// Se inicializa con anon; después de loadSession() reconfiguramos con JWT real
// Sprint 1B: eventsPerSecond subido a 100 (antes 10 dropeaba eventos en picos),
// heartbeat 30s, reconnect con exponential backoff hasta 30s máx.
window.sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON, {
  realtime: {
    params: { eventsPerSecond: 100 },
    heartbeatIntervalMs: 30000,
    reconnectAfterMs: (tries) => Math.min(1000 * Math.pow(2, Math.min(tries, 6)), 30000),
    timeout: 20000,
  },
});

async function loadSessionFromMain(){
  if(!window.electronAPI?.getSession){
    console.error('electronAPI.getSession no disponible. Abortando.');
    return false;
  }
  const sess = await window.electronAPI.getSession();
  if(!sess || !sess.accessToken){
    console.warn('Sin sesión. Redirigiendo a login...');
    window.electronAPI?.logout?.();
    return false;
  }
  window.SESSION = sess;
  window.CLIENT_ID = sess.clientId;
  window.ACCESS_TOKEN = sess.accessToken;
  // Actualizar Supabase SDK realtime con el JWT real
  window.sb.realtime.setAuth(sess.accessToken);
  // Suscribirse a refresh automático desde main
  if(window.electronAPI.onSessionRefreshed){
    window.electronAPI.onSessionRefreshed((s) => {
      console.log('Session refreshed by main');
      window.SESSION = s;
      window.ACCESS_TOKEN = s.accessToken;
      window.sb.realtime.setAuth(s.accessToken);
    });
  }
  return true;
}

function sbHeaders(pref){
  const h = {
    'apikey': SUPABASE_ANON,
    'Authorization': `Bearer ${window.ACCESS_TOKEN}`,
    'Content-Type': 'application/json'
  };
  if(pref) h['Prefer'] = pref;
  return h;
}

// Fetch wrapper: retry una vez con refresh si recibe 401
async function sbFetch(url, options = {}){
  let r = await fetch(url, options);
  if(r.status === 401 && window.electronAPI?.refreshSession){
    try {
      const fresh = await window.electronAPI.refreshSession();
      window.SESSION = fresh;
      window.ACCESS_TOKEN = fresh.accessToken;
      window.sb.realtime.setAuth(fresh.accessToken);
      const newOptions = { ...options, headers: { ...(options.headers||{}), 'Authorization': `Bearer ${fresh.accessToken}` } };
      r = await fetch(url, newOptions);
    } catch(e){
      console.warn('Refresh falló en 401; logout:', e.message);
      window.electronAPI?.logout?.();
      throw new Error('Session expired');
    }
  }
  return r;
}

// Sprint 2 · Proyecciones específicas para queries frecuentes.
// Evitan traer columnas innecesarias (payload bajo 20-35%, queries más rápidas).
// Agregar una columna aquí si una vista nueva la necesita.
// v2.1.35 — agregado created_via para diferenciar fuente real (aria / manual / walk_in)
const COLS_APPT  = 'id,client_id,lead_id,nombre,whatsapp,email,fecha,hora,servicio,estado,notas,precio_cents,descuento_pct,neto_cents,pagado,paid_at,metodo_pago,notified_at,confirmation_email_sent_at,confirmed_at,created_at,updated_at,created_via';
// v2.1.47 — incluir utm_source/utm_campaign para detalle de campaña pagada en sección Leads
const COLS_LEAD  = 'id,nombre,whatsapp,email,industria,empresa,fuente,status,estado_crm,intent_score,visitas,notas,ultima_visita,proxima_cita,created_at,utm_source,utm_campaign';
// FIX 2026-04-23: ia_suggestions NO tiene lead_id ni rejected_at (ver schema real).
// Columnas reales: id, client_id, type, title, reasoning, payload, confidence, source,
// status, approved_by, approved_at, executed_at, execution_result, expires_at, created_at.
const COLS_SUGG  = 'id,client_id,type,title,reasoning,payload,confidence,source,status,approved_by,approved_at,executed_at,expires_at,created_at';

// REST helpers (usan el JWT del cliente + auto-refresh on 401)
async function sbGet(table, params=''){
  const r = await sbFetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, { headers: sbHeaders() });
  if(!r.ok) throw new Error(`${table}: ${r.status}`);
  return r.json();
}
async function sbInsert(table, payload){
  const r = await sbFetch(`${SUPABASE_URL}/rest/v1/${table}`, { method:'POST', headers: sbHeaders('return=representation'), body: JSON.stringify(payload) });
  if(!r.ok){ const e = await r.json().catch(()=>({})); throw new Error(e.message || r.status); }
  return r.json();
}
async function sbPatch(table, id, payload){
  const r = await sbFetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, { method:'PATCH', headers: sbHeaders('return=representation'), body: JSON.stringify(payload) });
  if(!r.ok) throw new Error(`patch ${table}: ${r.status}`);
  return r.json();
}
// v2.1.24 — DELETE helper para CRUD de ad_campaigns
async function sbDelete(table, id){
  const r = await sbFetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, { method:'DELETE', headers: sbHeaders() });
  if(!r.ok) throw new Error(`delete ${table}: ${r.status}`);
  return true;
}
window.currentView = 'brief';
window.currentClient = null;
window.CLIENT_SERVICES = []; // cache de servicios del cliente

// ════════════════════════════════════════════════════════════════════
// DOM SAFETY HELPERS · v2.1.39
// ════════════════════════════════════════════════════════════════════
// Wrappers defensivos para evitar TypeError "Cannot set property of null"
// cuando un loader corre antes de que el DOM tenga el elemento (común
// tras rebuilds de view o navegación rápida).
//
// Uso: setSafe('elem-id', 'textContent', valor)
//      setSafeHTML('elem-id', '<strong>x</strong>')   // usa innerHTML
window.setSafe = function setSafe(id, prop, val){
  const el = document.getElementById(id);
  if(el) el[prop] = val;
  return el;
};
window.setSafeText = function setSafeText(id, val){
  const el = document.getElementById(id);
  if(el) el.textContent = val;
  return el;
};
window.setSafeHTML = function setSafeHTML(id, html){
  const el = document.getElementById(id);
  if(el) el.innerHTML = html;
  return el;
};

// ════════════════════════════════════════════════════════════════════
// TIMEZONE HELPERS · v2.1.36
// Toda la app debe formatear fechas/horas a través de estos helpers
// para respetar la zona horaria del local (clients.timezone).
// ════════════════════════════════════════════════════════════════════
//
// Por qué: clients.timezone (ej. 'America/Cancun') define el "reloj
// real" del local. Si el dashboard formatea con timezone del browser,
// hay desfaces (un cliente en Cancún viendo recordatorios calculados
// en UTC veía citas con hora corrida).
//
// Regla:
//   · Mostrar fechas/horas → usar window.fmtDateTZ / fmtTimeTZ / fmtDateTimeTZ
//   · Calcular "hoy/mañana" en zona del cliente → window.todayInTZ()
//   · Tiempo relativo ("hace 5 min") → window.fmtTimeAgoTZ
//
// Fallback:
//   · Si currentClient no está cargado → timezone del browser (raro,
//     solo durante boot temprano).
//   · Si timeZone inválida en Intl → catch fallback sin tz.
// ════════════════════════════════════════════════════════════════════
window.getTZ = function getTZ(){
  return (window.currentClient && window.currentClient.timezone) || undefined;
};

// Intl con tz: si la tz es inválida tira RangeError; capturamos y
// reintentamos sin timeZone para no romper UI.
function _safeIntlFormat(iso, opts){
  if(iso == null) return '—';
  const d = (iso instanceof Date) ? iso : new Date(iso);
  if(isNaN(d.getTime())) return '—';
  try { return new Intl.DateTimeFormat('es-MX', opts).format(d); }
  catch(_) {
    const fallback = { ...opts };
    delete fallback.timeZone;
    try { return new Intl.DateTimeFormat('es-MX', fallback).format(d); }
    catch(__) { return '—'; }
  }
}

window.fmtDateTZ = function fmtDateTZ(iso, opts){
  const tz = window.getTZ();
  return _safeIntlFormat(iso, { day:'2-digit', month:'short', year:'numeric', ...(opts || {}), timeZone: tz });
};

window.fmtTimeTZ = function fmtTimeTZ(iso, opts){
  const tz = window.getTZ();
  return _safeIntlFormat(iso, { hour:'2-digit', minute:'2-digit', hour12:false, ...(opts || {}), timeZone: tz });
};

window.fmtDateTimeTZ = function fmtDateTimeTZ(iso, opts){
  const tz = window.getTZ();
  return _safeIntlFormat(iso, {
    day:'2-digit', month:'short', year:'numeric',
    hour:'2-digit', minute:'2-digit', hour12:false,
    ...(opts || {}),
    timeZone: tz
  });
};

// Fechas tipo 'YYYY-MM-DD' (DATE columns como appointments.fecha)
// no tienen tz embebida. Las anclamos a mediodía para que ningún
// timezone las shifteé al día anterior/siguiente.
window.fmtPlainDateTZ = function fmtPlainDateTZ(ymd, opts){
  if(!ymd) return '—';
  const tz = window.getTZ();
  // 'T12:00:00' evita off-by-one en zonas con offset > 12h (no aplica
  // a LATAM pero es defensivo).
  return _safeIntlFormat(`${ymd}T12:00:00`, { day:'2-digit', month:'short', year:'numeric', ...(opts || {}), timeZone: tz });
};

// "hace 5 min" / "hace 2 h" / "hace 3 d" / fecha completa si >7d.
// Para diffs cortos no necesita tz (es relativo a Date.now()).
window.fmtTimeAgoTZ = function fmtTimeAgoTZ(iso){
  if(!iso) return '—';
  const then = new Date(iso);
  if(isNaN(then.getTime())) return '—';
  const diff = Math.floor((Date.now() - then.getTime()) / 1000);
  if(diff < 0)      return 'ahora';
  if(diff < 60)     return 'ahora';
  if(diff < 3600)   return Math.floor(diff / 60) + ' min';
  if(diff < 86400)  return Math.floor(diff / 3600) + ' h';
  if(diff < 604800) return Math.floor(diff / 86400) + ' d';
  // > 7 días: mostrar fecha en tz del cliente
  return window.fmtDateTZ(iso, { day:'numeric', month:'short' });
};

// Convierte un "wall-clock" (YYYY-MM-DD + HH:MM) en la tz del cliente
// a un timestamp UTC en ms. Crítico para comparar con Date.now() o
// para sortear citas correctamente sin importar la tz del browser.
//
// Ejemplo: cliente en America/Cancun (-5), cita 'fecha=2026-04-26
// hora=10:00'. Naive interpretación local del browser (en CDMX, -6)
// daría 10:00 CDMX = 16:00 UTC. Pero la cita es a las 10:00 Cancún
// = 15:00 UTC. wallTimeMs corrige esto.
window.wallTimeMs = function wallTimeMs(ymd, hhmm){
  if(!ymd) return 0;
  const h = (hhmm || '00:00').slice(0, 5);
  const tz = window.getTZ();
  if(!tz){
    const dt = new Date(`${ymd}T${h}:00`);
    return isNaN(dt.getTime()) ? 0 : dt.getTime();
  }
  try {
    // 1) Tratamos el string como si fuera UTC → timestamp candidato
    const naiveUtc = new Date(`${ymd}T${h}:00Z`).getTime();
    if(isNaN(naiveUtc)) return 0;
    // 2) Formateamos ese instante en la tz objetivo y vemos qué hora "marca"
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit',
      hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false
    });
    const parts = fmt.formatToParts(new Date(naiveUtc))
      .reduce((a, p) => { if(p.type !== 'literal') a[p.type] = p.value; return a; }, {});
    // Edge-case: hour='24' en algunos engines → normalizar a '00' del día siguiente
    let hh = parseInt(parts.hour, 10);
    let dayAdd = 0;
    if(hh === 24){ hh = 0; dayAdd = 1; }
    const wallAsUtc = Date.UTC(
      parseInt(parts.year, 10),
      parseInt(parts.month, 10) - 1,
      parseInt(parts.day, 10) + dayAdd,
      hh,
      parseInt(parts.minute, 10),
      parseInt(parts.second || '0', 10)
    );
    // 3) offset = cuánto adelanta la tz vs UTC en ESA fecha (DST-aware)
    const offset = wallAsUtc - naiveUtc;
    return naiveUtc - offset;
  } catch(_){
    const dt = new Date(`${ymd}T${h}:00`);
    return isNaN(dt.getTime()) ? 0 : dt.getTime();
  }
};

// Devuelve un objeto {y, m, d} con la fecha "hoy" según la tz del
// cliente. Útil para filtros tipo "citas de hoy" que deben respetar
// el cambio de día en la tz del local, no del browser.
window.todayInTZ = function todayInTZ(){
  const tz = window.getTZ();
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit' });
    const parts = fmt.formatToParts(new Date());
    const map = {};
    parts.forEach(p => { if(p.type !== 'literal') map[p.type] = p.value; });
    return { y: parseInt(map.year), m: parseInt(map.month), d: parseInt(map.day), ymd: `${map.year}-${map.month}-${map.day}` };
  } catch(_){
    const n = new Date();
    return { y: n.getFullYear(), m: n.getMonth()+1, d: n.getDate(), ymd: n.toISOString().slice(0,10) };
  }
};

// Init theme early (before render)
(function initTheme(){
  try {
    const saved = localStorage.getItem('theme') || 'dark';
    if(saved === 'light') document.body.classList.add('theme-light');
  } catch(e){}
})();

// ============================================
// TOAST
// ============================================
window.toast = function(title, body, kind='success'){
  const container = document.getElementById('toast-container');
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.innerHTML = `<div class="toast-title">${escapeHtml(title)}</div>${body ? `<div class="toast-body">${escapeHtml(body)}</div>` : ''}`;
  container.appendChild(t);
  setTimeout(() => t.remove(), 4500);
};

// ============================================
// MODAL (usado por markAsPaid, openNewAppt, openConvContextMenu, etc.)
// ============================================
window.showModal = function(title, bodyHtml, footerHtml){
  const overlay = document.getElementById('modal-overlay');
  if(!overlay){ console.warn('[modal] overlay no existe en el DOM'); return; }
  const titleEl = document.getElementById('modal-title');
  const bodyEl  = document.getElementById('modal-body');
  const footEl  = document.getElementById('modal-foot');
  if(titleEl) titleEl.textContent = title || '';
  if(bodyEl)  bodyEl.innerHTML = bodyHtml || '';
  if(footEl)  footEl.innerHTML = footerHtml || '';
  overlay.classList.add('show');

  // Cerrar con Escape
  const onKey = (e) => {
    if(e.key === 'Escape') { closeModal(); document.removeEventListener('keydown', onKey); }
  };
  document.addEventListener('keydown', onKey);

  // Click fuera del modal → cerrar
  overlay.onclick = (e) => { if(e.target === overlay) closeModal(); };
};

window.closeModal = function(){
  const overlay = document.getElementById('modal-overlay');
  if(!overlay) return;
  overlay.classList.remove('show');
  overlay.onclick = null;
};

// ============================================
// GLOBAL SEARCH (Cmd+K / Ctrl+K)
// ============================================
document.addEventListener('keydown', e => {
  if((e.metaKey || e.ctrlKey) && e.key === 'k'){
    e.preventDefault();
    document.getElementById('topnav-search-input')?.focus();
  }
});

// ============================================
// TOPNAV GROUP DROPDOWNS (Commit 4.5)
// ============================================
// 6 grupos colapsables en row 2: home, rendimiento, actividad, marketing, premium, cuenta
// Cada grupo abre un dropdown con los items que contiene.

const NAV_GROUP_OF_VIEW = {
  brief: 'home',
  funnel: 'rendimiento',
  ingresos: 'rendimiento',
  agenda: 'actividad',
  leads: 'actividad',
  crm: 'actividad',
  aria: 'actividad',
  campaigns: 'marketing',
  publicidad: 'marketing',
  reports: 'cuenta',  // movido de premium → cuenta
  billing: 'cuenta',
  settings: null      // settings va en avatar dropdown, no en nav
  // coach, dindex, sla — eliminados completamente
};

window.toggleNavGroup = function(name, btn){
  const wrap = btn.closest('.nav-group-wrap');
  const wasOpen = wrap.classList.contains('open');
  // Cerrar todos primero
  document.querySelectorAll('.nav-group-wrap').forEach(w => w.classList.remove('open'));
  // Abrir el actual si no estaba abierto
  if(!wasOpen) wrap.classList.add('open');
};

window.closeAllNavGroups = function(){
  document.querySelectorAll('.nav-group-wrap').forEach(w => w.classList.remove('open'));
};

// Click fuera cierra todos los dropdowns del topnav
document.addEventListener('click', e => {
  if(!e.target.closest('.nav-group-wrap')){
    closeAllNavGroups();
  }
});

// ESC cierra todos
document.addEventListener('keydown', e => {
  if(e.key === 'Escape') closeAllNavGroups();
});

// Highlight del grupo cuyo view está activo (se llama desde go() después de cambiar view)
window.highlightActiveNavGroup = function(view){
  const groupName = NAV_GROUP_OF_VIEW[view];
  document.querySelectorAll('.nav-group-btn').forEach(b => b.classList.remove('active'));
  if(groupName){
    document.querySelector(`.nav-group-wrap[data-group="${groupName}"] .nav-group-btn`)?.classList.add('active');
  }
};

// ============================================
// USER MENU (avatar dropdown - reemplaza sidebar footer)
// ============================================
window.toggleUserMenu = function(){
  document.getElementById('user-menu')?.classList.toggle('open');
};
window.closeUserMenu = function(){
  document.getElementById('user-menu')?.classList.remove('open');
};
// Cerrar dropdown al click fuera
document.addEventListener('click', e => {
  const menu = document.getElementById('user-menu');
  if(menu && menu.classList.contains('open') && !menu.contains(e.target)){
    menu.classList.remove('open');
  }
});

// Limpieza migración top-nav: borrar localStorage de sidebar viejo (one-time)
try {
  localStorage.removeItem('sb-collapsed');
  ['home','rendimiento','actividad','mensajeria','premium','cuenta'].forEach(n =>
    localStorage.removeItem('group-' + n));
} catch(e){}

// ============================================
// NAVIGATION
// ============================================
const viewTitles = {
  brief: 'Executive Brief',
  funnel: 'Funnel Diagnóstico',
  ingresos: 'Ingresos',
  publicidad: 'Publicidad',
  agenda: 'Agenda Inteligente',
  leads: 'Leads con Score',
  crm: 'CRM 360',
  campaigns: 'Campañas de Email',
  inbox: 'Inbox WhatsApp',
  reports: 'Reportes mensuales',
  billing: 'Facturación',
  settings: 'Configuración'
  // coach, dindex, sla — eliminados (no útiles)
};

// v2.3.3 — Stack de historial para flechas back/forward del topbar.
// Funciona como el historial del navegador: cada go() empuja al stack;
// navBack/navForward mueven el puntero sin re-empujar.
window._navHistory = window._navHistory || [];
window._navIdx     = window._navIdx     ?? -1;
window._navSkipPush = false;

function _updateNavArrows(){
  const back = document.getElementById('nav-back');
  const fwd  = document.getElementById('nav-fwd');
  if(back) back.disabled = window._navIdx <= 0;
  if(fwd)  fwd.disabled  = window._navIdx >= window._navHistory.length - 1;
}

window.navBack = function(){
  if(window._navIdx <= 0) return;
  window._navIdx--;
  window._navSkipPush = true;
  window.go(window._navHistory[window._navIdx]);
};
window.navForward = function(){
  if(window._navIdx >= window._navHistory.length - 1) return;
  window._navIdx++;
  window._navSkipPush = true;
  window.go(window._navHistory[window._navIdx]);
};

// Atajos: ⌘[ / ⌘] (mac) y Alt+← / Alt+→
document.addEventListener('keydown', e => {
  // Ignorar si está escribiendo en input/textarea
  const tag = e.target?.tagName;
  if(tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;
  const mod = e.metaKey || e.ctrlKey;
  if(mod && e.key === '['){ e.preventDefault(); window.navBack(); }
  else if(mod && e.key === ']'){ e.preventDefault(); window.navForward(); }
  else if(e.altKey && e.key === 'ArrowLeft'){ e.preventDefault(); window.navBack(); }
  else if(e.altKey && e.key === 'ArrowRight'){ e.preventDefault(); window.navForward(); }
});

window.go = function(view){
  // Push al stack salvo que vengamos de navBack/navForward
  if(!window._navSkipPush){
    // Si estábamos en medio del stack y navegamos a algo nuevo, cortamos el "forward"
    if(window._navIdx < window._navHistory.length - 1){
      window._navHistory = window._navHistory.slice(0, window._navIdx + 1);
    }
    // Evitar duplicados consecutivos (clicks repetidos en la misma vista)
    if(window._navHistory[window._navIdx] !== view){
      window._navHistory.push(view);
      window._navIdx = window._navHistory.length - 1;
      // Cap a 50 entradas para no crecer indefinidamente
      if(window._navHistory.length > 50){
        window._navHistory.shift();
        window._navIdx--;
      }
    }
  }
  window._navSkipPush = false;
  _updateNavArrows();

  window.currentView = view;
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelector(`.view[data-view="${view}"]`)?.classList.add('active');
  // top-nav usa .nav-link (mantenemos compat con .nav-item por si queda algo)
  document.querySelectorAll('.nav-link, .nav-item').forEach(n => n.classList.remove('active'));
  document.querySelector(`.nav-link[data-view="${view}"]`)?.classList.add('active');
  document.querySelector(`.nav-item[data-view="${view}"]`)?.classList.add('active');
  // Commit 4.5: highlight del grupo padre del view en el topnav
  if(typeof window.highlightActiveNavGroup === 'function') window.highlightActiveNavGroup(view);
  const crumb = document.getElementById('crumb-current');
  if(crumb) crumb.textContent = viewTitles[view] || view;
  document.querySelector('.content').scrollTop = 0;
  try { localStorage.setItem('last-view', view); } catch(e){}

  // Load data for the view
  if(view === 'brief') loadBriefData();
  else if(view === 'funnel') loadFunnel();
  // v2.1.24 — ROI desestructurado en 2 vistas independientes
  else if(view === 'ingresos') loadIngresosView();
  else if(view === 'publicidad') loadPublicidad();
  else if(view === 'agenda') loadAppointments();
  else if(view === 'leads') loadLeads();
  else if(view === 'crm') loadCRM();
  else if(view === 'campaigns') loadCampaigns();
  else if(view === 'reports') loadReports();
  else if(view === 'inbox') loadInbox();
  else if(view === 'billing') loadBilling();
  else if(view === 'settings') loadSettings();
  else if(view === 'aria') loadAriaSection();
};

window.logout = function(){
  // FIX v2.1.30 — cleanup completo antes de cerrar sesión:
  // 1) Disconnect realtime + listeners + timers debounce (en realtime.js)
  // 2) Clear setInterval del day-change watcher
  // 3) Destruir Charts pendientes (libera canvases)
  // 4) Limpiar caches con data del cliente actual (anti-leak entre clientes)
  // 5) Reset state global
  // 6) Stop idle logout watcher
  try { window.disconnectRealtime?.(); } catch(_){}
  try { if(window._dayChangeInterval){ clearInterval(window._dayChangeInterval); window._dayChangeInterval = null; } } catch(_){}
  try { if(window._chartBrief){ window._chartBrief.destroy?.(); window._chartBrief = null; } } catch(_){}
  // _ingresosChart y _pubChart son let module-scoped, no window — solo limpiamos si la página queda abierta
  try { window.dispatchEvent(new CustomEvent('app:cleanup-charts')); } catch(_){}
  try { window.idleLogout?.stop?.(); } catch(_){}
  // Limpiar caches que tienen data del cliente
  window._lastHistorialPagos = [];
  window.CLIENT_SERVICES = [];
  window.currentClient = null;
  window.CLIENT_ID = null;
  window.currentAriaConvId = null;
  if(window.ARIA){ window.ARIA.items = []; }
  if(window.electronAPI?.logout) window.electronAPI.logout();
  else window.location.href = 'login.html';
};

// Date en breadcrumb
(function(){
  const d = new Date();
  const months = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  const el = document.getElementById('crumb-date');
  if(el) el.textContent = `— ${months[d.getMonth()]} ${d.getFullYear()}`;
})();

// ============================================
// BOOT
// ============================================
async function boot(){
  try {
    // 1) Cargar sesión desde main process (safeStorage cifrado)
    const sessionOk = await loadSessionFromMain();
    if(!sessionOk) return; // main ya redirigió a login

    // 2) Load client
    const clients = await sbGet('clients', `id=eq.${window.CLIENT_ID}&select=*`);
    if(clients.length === 0){
      window.toast('Error', 'Cliente no encontrado', 'err');
      return;
    }
    window.currentClient = clients[0];
    renderClientInfo();

    // Load ARIA activity feed (notifications + executed suggestions)
    // Nuevo modelo v2.1.6: feed cronológico, no queue de aprobación
    await (window.loadNotifications ? window.loadNotifications() : Promise.resolve());

    // Initial view
    loadBriefData();

    // Init realtime
    window.initRealtime();

    // v2.3.3 — Siempre abrir en Resumen (brief).
    // Antes restaurábamos 'last-view' desde localStorage, pero generaba mal UX:
    // si el usuario cerraba en Configuración o Facturación, al reabrir aparecía allí
    // en vez del Resumen. El Resumen es la pantalla "home" de la app — siempre arranca aquí.
    // Limpiamos la clave para no confundir builds futuros.
    try { localStorage.removeItem('last-view'); } catch(_){}
    window.currentView = 'brief';
    // Seed del stack de navegación con 'brief' (para que las flechas funcionen desde el inicio)
    window._navHistory = ['brief'];
    window._navIdx = 0;
    _updateNavArrows();

    // Auto-logout por inactividad (default 30 min, configurable en Settings > Apariencia)
    window.idleLogout?.start();

    // v2.1.13: Auto-refresh al cambiar de mes/día.
    // Si la app queda abierta cuando el calendario rota (ej: 23:59 → 00:00 día nuevo,
    // o último día del mes → primero del siguiente), las vistas con rangos relativos
    // (agenda 1 mes, brief 30d, chart 6m) quedan obsoletas hasta navegar.
    // Solución: chequear cada 60s si cambió el día; si sí Y la vista es agenda/brief → refresh.
    // FIX v2.1.30 — guardar ID del setInterval para poder limpiarlo en logout
    // Antes: setInterval seguía corriendo después de logout (memory leak)
    let _lastDayKey = `${new Date().getFullYear()}-${new Date().getMonth()}-${new Date().getDate()}`;
    if(window._dayChangeInterval) clearInterval(window._dayChangeInterval);
    window._dayChangeInterval = setInterval(() => {
      const now = new Date();
      const currentKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
      if(currentKey !== _lastDayKey){
        const monthChanged = !_lastDayKey.startsWith(`${now.getFullYear()}-${now.getMonth()}`);
        console.log(`[calendar] día cambió: ${_lastDayKey} → ${currentKey}${monthChanged ? ' (mes nuevo)' : ''}`);
        _lastDayKey = currentKey;
        const v = window.currentView;
        if(v === 'agenda' && typeof window.loadAppointments === 'function') window.loadAppointments();
        if(v === 'brief'  && typeof window.loadBriefData    === 'function') window.loadBriefData();
        if(monthChanged) window.toast?.('📅 Mes nuevo', 'Tu vista se actualizó automáticamente', 'info');
      }
    }, 60000);

    // Sentry: set user context (solo UUID, nunca email/nombre) + tags útiles
    try {
      window.electronAPI?.sentrySetUser?.({ id: window.CLIENT_ID });
      window.electronAPI?.sentrySetTag?.('client_plan', window.currentClient?.plan || 'unknown');
      window.electronAPI?.sentrySetTag?.('client_industria', window.currentClient?.industria || 'unknown');
      window.electronAPI?.sentrySetTag?.('client_moneda', window.currentClient?.moneda || 'USD');
    } catch(_){}

    window.toast(`Bienvenido, ${window.currentClient.empresa || 'Cliente'}`, `Tu dashboard está sincronizado en tiempo real.`, 'success');

    // FIX v2.1.30 — Onboarding check: detecta si el cliente recién registrado tiene
    // configuración incompleta (sin servicios, sin WhatsApp conectado, vertical inactivo).
    // Muestra banner persistente con CTAs específicos hasta que complete setup.
    setTimeout(() => { try { window.checkOnboarding?.(); } catch(_){} }, 1500);
  } catch(err){
    console.error('Boot error:', err);
    window.toast('Error de conexión', err.message, 'err');
  }
}

// FIX v2.1.30 · Onboarding banner para cliente nuevo (post-LLC, primer cliente real)
window.checkOnboarding = async function(){
  try {
    const c = window.currentClient || {};
    const issues = [];

    // 1) Servicios configurados
    const services = await sbGet('services', `client_id=eq.${window.CLIENT_ID}&select=id&limit=1`);
    if(services.length === 0){
      issues.push({
        key: 'services',
        title: 'Configura al menos 1 servicio',
        body: 'ARIA usa tu catálogo de servicios para responder precios y agendar. Sin servicios no podrás recibir citas.',
        cta: 'Ir a Servicios',
        action: () => { window.go('settings'); setTimeout(() => window.setTab?.('servicios'), 200); }
      });
    }

    // 2) WhatsApp conectado
    if(!c.wa_phone_number_id || c.wa_status !== 'connected'){
      issues.push({
        key: 'whatsapp',
        title: 'Conecta tu WhatsApp Business',
        body: 'ARIA no puede recibir mensajes de tus leads sin un número WhatsApp Cloud API conectado.',
        cta: 'Conectar WhatsApp',
        action: () => { window.go('aria'); setTimeout(() => window.setTab?.('conexion'), 200); }
      });
    }

    // 3) Vertical activo (whitelist 3 verticales por ahora)
    const ACTIVE_VERTICALS = ['clinica_dental','clinica_estetica','spa'];
    if(c.vertical && !ACTIVE_VERTICALS.includes(c.vertical)){
      issues.push({
        key: 'vertical',
        title: `Vertical "${c.vertical}" en validación`,
        body: 'Tu vertical no está en producción. Algunas plantillas de ARIA pueden no estar optimizadas. Contáctanos para activarlo.',
        cta: 'Contactar soporte',
        action: () => { window.openSupport?.(); }
      });
    }

    if(issues.length === 0) return;

    // Renderizar banner persistente arriba del Brief (solo si la vista es brief)
    if(window.currentView !== 'brief') return;
    const view = document.querySelector('[data-view="brief"]');
    if(!view) return;
    let banner = document.getElementById('onboarding-banner');
    if(!banner){
      banner = document.createElement('div');
      banner.id = 'onboarding-banner';
      banner.style.cssText = 'margin-bottom:14px;padding:16px;background:rgba(232,193,76,0.06);border:1px solid rgba(232,193,76,0.25);border-radius:8px;';
      view.insertBefore(banner, view.firstChild?.nextSibling || null);
    }
    banner.innerHTML = `
      <div style="font-size:11px;color:var(--warn);font-family:'Geist Mono',monospace;letter-spacing:0.5px;text-transform:uppercase;margin-bottom:10px;">
        Configuración pendiente · ${issues.length} ${issues.length === 1 ? 'tema' : 'temas'}
      </div>
      <div style="display:flex;flex-direction:column;gap:10px;">
        ${issues.map((i, idx) => `
          <div style="display:flex;justify-content:space-between;align-items:start;gap:12px;padding:10px;background:var(--card2);border-radius:6px;">
            <div style="flex:1;min-width:0;">
              <div style="font-size:13px;font-weight:500;color:var(--text);margin-bottom:4px;">${escapeHtml(i.title)}</div>
              <div style="font-size:11px;color:var(--text2);line-height:1.5;">${escapeHtml(i.body)}</div>
            </div>
            <button class="btn primary" style="font-size:11px;padding:6px 12px;flex-shrink:0;" onclick="window._onboardingAction(${idx})">${escapeHtml(i.cta)}</button>
          </div>
        `).join('')}
      </div>
    `;
    window._onboardingActions = issues.map(i => i.action);
  } catch(err){
    console.error('[Onboarding] error:', err);
  }
};

window._onboardingAction = function(idx){
  const fn = window._onboardingActions?.[idx];
  if(typeof fn === 'function') fn();
};

// v2.1.32 — showSystemStatus eliminado (decisión usuario: no aporta valor real)
// Banner "Sistema activo" también eliminado del sidebar footer.

window.renderClientInfo = function(){
  const c = window.currentClient;
  const cName = document.getElementById('client-name');
  const cEmpresa = document.getElementById('client-empresa');
  if(cName) cName.textContent = c.responsable || c.nombre || c.empresa || '—';
  if(cEmpresa) cEmpresa.textContent = c.empresa || '—';
  // Plan: solo 'pro' o 'enterprise' (sistema actual). Default sano: PRO.
  const planRaw = (c.plan || 'pro').toLowerCase();
  const planNorm = (planRaw === 'enterprise') ? 'enterprise' : 'pro';
  // v2.1.32 — Plan dinámico aparece como 3ra línea bajo "automation plattform"
  // Ej: "Plan PRO" / "Plan ENTERPRISE"
  const planPill = document.getElementById('logo-plan-pill');
  if(planPill) planPill.textContent = `Plan ${planNorm.toUpperCase()}`;
  const cInitial = document.getElementById('client-initial');
  if(cInitial) cInitial.textContent = (c.empresa?.[0] || c.nombre?.[0] || '?').toUpperCase();

  // v2.1.55 (Commit 5) — Render avatar foto si existe, sino iniciales
  if(typeof window.refreshAvatarUI === 'function'){
    window.refreshAvatarUI(c.avatar_url || null);
  }

  // v2.1.33 — bloque "Badges" del Dindex eliminado (decisión usuario: redundante con
  // logo header que ahora muestra "Plan PRO/ENTERPRISE"). Stub null-safe queda como
  // defense-in-depth por si el id 'badge-plan' aparece en alguna versión cacheada.
  const badgePlan = document.getElementById('badge-plan');
  if(badgePlan){
    badgePlan.textContent = planNorm === 'enterprise' ? 'ENTERPRISE' : 'PRO';
  }
}

// ============================================
// VIEW: BRIEF (Executive Brief)
// ============================================
let _briefRefreshBusy = false;

window.refreshBrief = async function(){
  if(_briefRefreshBusy) return;
  const btn = document.getElementById('brief-refresh-btn');
  _briefRefreshBusy = true;
  if(btn){ btn.disabled = true; btn.style.opacity = '0.5'; btn.textContent = '…'; }
  try {
    await loadBriefData();
    window.toast && window.toast('✓ Brief actualizado', null, 'success');
  } catch(err){
    window.toast && window.toast('Error', err.message || 'No se pudo refrescar', 'err');
  } finally {
    setTimeout(() => {
      _briefRefreshBusy = false;
      if(btn){ btn.disabled = false; btn.style.opacity = ''; btn.textContent = '↻'; }
    }, 1200);
  }
};

window.loadBriefData = async function(){
  try {
    const now = new Date();
    const d30 = new Date(now - 30 * 864e5).toISOString();
    const d180 = new Date(now - 180 * 864e5).toISOString();
    const d180d = new Date(now - 180 * 864e5).toISOString().split('T')[0];

    const [leads30, apts30, paidAppts180, ariaApts30] = await Promise.all([
      sbGet('leads', `client_id=eq.${window.CLIENT_ID}&created_at=gte.${d30}&select=id,status`),
      // Citas activas creadas en los últimos 30 días (excluye canceladas y no-show).
      // Incluye pending + confirmed + completed para que el KPI refleje la actividad real,
      // no solo las ya confirmadas por email.
      sbGet('appointments', `client_id=eq.${window.CLIENT_ID}&created_at=gte.${d30}&estado=not.in.(cancelled,no_show)&select=id,estado`),
      // Ingresos reales de los últimos 180 días desde appointments pagadas
      sbGet('appointments', `client_id=eq.${window.CLIENT_ID}&pagado=eq.true&paid_at=gte.${d180}&select=paid_at,neto_cents,precio_cents&order=paid_at.asc`),
      // v2.1.15: Citas cerradas por ARIA — modelo híbrido B+C:
      //   · Número GRANDE = confirmed + completed (lead clickeó confirmación = intención real)
      //   · Subtítulo CHICO = pagadas + revenue real (cuántas ya generaron ingreso)
      // Filtro pre: lead_id IS NOT NULL (vino del funnel), excluye cancelled/no_show.
      // Traemos campos necesarios para distinguir confirmed vs paid en JS.
      // FIX v2.1.35 — usar created_via='aria' (real) en lugar de lead_id IS NOT NULL
      sbGet('appointments', `client_id=eq.${window.CLIENT_ID}&created_at=gte.${d30}&created_via=eq.aria&estado=not.in.(cancelled,no_show)&select=id,estado,pagado,neto_cents,precio_cents`)
    ]);

    const leadsCount = leads30.length;
    const citasCount = apts30.length;
    const convRate = leadsCount > 0 ? ((citasCount / leadsCount) * 100).toFixed(1) : '0.0';
    // v2.1.15: B+C híbrido. Solo cuentan las que el lead confirmó (intención real),
    // y trackeamos cuántas de esas ya se cobraron (ingreso confirmado).
    const ariaConfirmed = ariaApts30.filter(a => ['confirmed','completed'].includes(a.estado));
    const ariaConfirmedCount = ariaConfirmed.length;
    const ariaPaid = ariaConfirmed.filter(a => a.pagado === true);
    const ariaPaidCount = ariaPaid.length;
    const ariaPaidRevCents = ariaPaid.reduce((s, a) => s + (a.neto_cents || a.precio_cents || 0), 0);

    // Revenue agregado por mes Y por día (Commit 6: bars chart con month nav)
    const revenueByMonth = {};
    const revenueByMonthDay = {}; // { 'YYYY-MM': { 1: cents, 2: cents, ... } }
    const apptCountByMonthDay = {}; // { 'YYYY-MM': { 1: count, ... } }
    let totalRev30 = 0;
    paidAppts180.forEach(a => {
      const d = new Date(a.paid_at);
      const monthKey = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      const day = d.getDate();
      const cents = a.neto_cents || a.precio_cents || 0;
      revenueByMonth[monthKey] = (revenueByMonth[monthKey] || 0) + cents;
      if(!revenueByMonthDay[monthKey]) revenueByMonthDay[monthKey] = {};
      if(!apptCountByMonthDay[monthKey]) apptCountByMonthDay[monthKey] = {};
      revenueByMonthDay[monthKey][day] = (revenueByMonthDay[monthKey][day] || 0) + cents;
      apptCountByMonthDay[monthKey][day] = (apptCountByMonthDay[monthKey][day] || 0) + 1;
      if(now - d < 30 * 864e5) totalRev30 += cents;
    });
    // Guardamos en window para que briefChangeMonth() pueda re-renderizar sin re-fetch
    window._briefChartData = { revenueByMonthDay, apptCountByMonthDay, monedaSym: null };

    const moneda = window.currentClient?.moneda || 'USD';
    const monedaSym = { USD:'$', MXN:'$', DOP:'RD$', EUR:'€', COP:'$' }[moneda] || '$';

    // v2.1.39 — setSafe defensivo (si el DOM no tiene el id, no crashea)
    setSafeText('brief-leads', leadsCount);
    setSafeText('brief-citas', citasCount);
    setSafeText('brief-conv', convRate + '%');
    // v2.1.15: KPI con 2 niveles (B+C híbrido)
    setSafeText('brief-aria', ariaConfirmedCount);
    const ariaRev = document.getElementById('brief-aria-revenue');
    if(ariaRev){
      if(ariaConfirmedCount === 0){
        ariaRev.textContent = 'automatizadas 30d';
      } else if(ariaPaidCount === 0){
        ariaRev.textContent = 'confirmadas · sin pago aún';
      } else {
        const rev = (ariaPaidRevCents / 100).toLocaleString('en', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
        ariaRev.textContent = `${ariaPaidCount} pagada${ariaPaidCount === 1 ? '' : 's'} · ${monedaSym}${rev}`;
      }
    }

    // Hora + saludo (v2.1.36: hora calculada en tz del cliente, no del browser)
    let hour;
    try {
      const tz = window.getTZ();
      const hStr = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour:'numeric', hour12:false }).format(new Date());
      hour = parseInt(hStr, 10);
    } catch(_){ hour = new Date().getHours(); }
    const saludo = hour < 12 ? 'Buenos días' : hour < 19 ? 'Buenas tardes' : 'Buenas noches';
    const name = window.currentClient.responsable?.split(' ')[0] || window.currentClient.empresa || '';
    document.getElementById('brief-greet').textContent = `${saludo}, ${name}`;
    document.getElementById('brief-date').textContent = window.fmtDateTZ(new Date(), { day: 'numeric', month: 'long', year: 'numeric' }).toUpperCase();

    // Narrative real (v2.1.15: pasa confirmed + paid + revenue de ARIA)
    document.getElementById('brief-narrative').innerHTML = generateNarrativeReal(
      leadsCount, citasCount, convRate,
      ariaConfirmedCount, ariaPaidCount, ariaPaidRevCents,
      totalRev30, monedaSym
    );

    // Chart — Commit 6: CSS bars con días del mes + month nav
    if(window._chartBrief){ try { window._chartBrief.destroy?.(); } catch(_){} window._chartBrief = null; }
    window._briefChartData.monedaSym = monedaSym;
    // Render del mes actual al cargar
    const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
    window._briefSelectedMonth = window._briefSelectedMonth || currentMonthKey;
    renderBriefBarChart(window._briefSelectedMonth);

    // ─── Commit 6.5: Hero metric (ingresos del mes actual + delta vs mes prev) ───
    const monthsLong = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
    const curM = now.getMonth();
    const curY = now.getFullYear();
    const prevM = curM === 0 ? 11 : curM - 1;
    const prevY = curM === 0 ? curY - 1 : curY;
    const curKey = currentMonthKey;
    const prevKey = `${prevY}-${String(prevM+1).padStart(2,'0')}`;
    const curRevCents = revenueByMonth[curKey] || 0;
    const prevRevCents = revenueByMonth[prevKey] || 0;
    const dayOfMonth = now.getDate();
    const daysInCurrentMonth = new Date(curY, curM+1, 0).getDate();
    const projectionCents = dayOfMonth > 0 ? Math.round((curRevCents / dayOfMonth) * daysInCurrentMonth) : curRevCents;

    setSafeText('hero-month-label', monthsLong[curM].toUpperCase() + ' ' + curY);
    setSafeText('hero-revenue-value', (curRevCents / 100).toLocaleString('en', { maximumFractionDigits: 0 }));
    setSafeText('hero-currency', moneda);
    const heroDelta = document.getElementById('hero-revenue-delta');
    if(heroDelta){
      if(prevRevCents > 0){
        const pct = Math.round(((curRevCents - prevRevCents) / prevRevCents) * 100);
        heroDelta.textContent = (pct >= 0 ? '↑ +' : '↓ ') + Math.abs(pct) + '%';
        heroDelta.className = pct >= 0 ? 'up' : 'down';
      } else {
        heroDelta.textContent = '—';
        heroDelta.className = '';
      }
    }
    setSafeText('hero-revenue-delta-label', `vs ${monthsLong[prevM].toLowerCase()}`);
    setSafeText('hero-revenue-projection', curRevCents > 0
      ? `Proyección final del mes: ${monedaSym}${(projectionCents/100).toLocaleString('en', { maximumFractionDigits: 0 })}`
      : 'Sin ingresos cobrados aún este mes');

    // Ticket promedio (paid en últimos 30d) + delta vs paid en 30-60d previos
    const paid30 = paidAppts180.filter(a => (now - new Date(a.paid_at)) < 30 * 864e5);
    const paid30_60 = paidAppts180.filter(a => {
      const ms = now - new Date(a.paid_at);
      return ms >= 30 * 864e5 && ms < 60 * 864e5;
    });
    const ticketCents = paid30.length > 0 ? Math.round(paid30.reduce((s,a) => s + (a.neto_cents || a.precio_cents || 0), 0) / paid30.length) : 0;
    const ticketCentsPrev = paid30_60.length > 0 ? Math.round(paid30_60.reduce((s,a) => s + (a.neto_cents || a.precio_cents || 0), 0) / paid30_60.length) : 0;
    setSafeText('brief-ticket', ticketCents > 0 ? monedaSym + (ticketCents/100).toLocaleString('en', { maximumFractionDigits: 0 }) : '—');
    const ticketTrendEl = document.getElementById('brief-ticket-trend');
    if(ticketTrendEl){
      if(ticketCentsPrev > 0 && ticketCents > 0){
        const pct = Math.round(((ticketCents - ticketCentsPrev) / ticketCentsPrev) * 100);
        ticketTrendEl.textContent = (pct >= 0 ? '↑ +' : '↓ ') + Math.abs(pct) + '%';
        ticketTrendEl.className = 'kpi-trend ' + (pct >= 0 ? 'up' : 'down');
      } else {
        ticketTrendEl.textContent = ticketCents > 0 ? 'por cita pagada' : '—';
        ticketTrendEl.className = 'kpi-trend';
      }
    }

    // Leads trend (delta vs 30-60d previos no fetched, placeholder por ahora)
    const leadsTrendEl = document.getElementById('brief-leads-trend');
    if(leadsTrendEl){
      leadsTrendEl.textContent = leadsCount > 0 ? leadsCount + ' total' : '—';
      leadsTrendEl.className = 'kpi-trend up';
    }

    // ARIA % del total (cuántas citas vinieron de ARIA del total)
    const ariaTrendEl = document.getElementById('brief-aria-revenue');
    if(ariaTrendEl){
      if(citasCount > 0 && ariaConfirmedCount >= 0){
        const pct = Math.round((ariaConfirmedCount / citasCount) * 100);
        ariaTrendEl.textContent = pct + '% del total';
      } else {
        ariaTrendEl.textContent = ariaConfirmedCount > 0 ? 'automatizadas 30d' : '—';
      }
    }

    // Sugerencias: count + generated time + cards counts
    const hotLeadsCount = leads30.filter(l => ['active','contacted'].includes(l.status)).length || Math.min(leadsCount, 5);
    const pendingCount = apts30.filter(a => a.estado === 'pending').length;
    const inactiveCount = 0; // requiere fetch separado de clients (placeholder)
    let sugCount = 0;
    if(hotLeadsCount > 0) sugCount++;
    if(pendingCount > 0) sugCount++;
    sugCount++; // inactivos siempre se muestra como sugerencia
    setSafeText('brief-aria-suggestions-count', sugCount);
    // Generated time
    const genHr = String(now.getHours()).padStart(2, '0');
    const genMn = String(now.getMinutes()).padStart(2, '0');
    setSafeText('brief-aria-generated', `GENERADO A LAS ${genHr}:${genMn}`);
    // Sugerencia counts en cada card
    setSafeText('sug-hot-count', hotLeadsCount);
    setSafeText('sug-warn-count', pendingCount);
    setSafeText('sug-info-count', inactiveCount > 0 ? inactiveCount : '—');

    // Update nav badges
    const leadsCountEl = document.getElementById('leads-count');
    const apptCountEl = document.getElementById('appt-count');
    if(leadsCountEl) leadsCountEl.textContent = leadsCount;
    if(apptCountEl) apptCountEl.textContent = citasCount;

    // v2.3.3 — Cargar panel Próximas Citas (reemplazo de ARIA Sugerencias del Resumen)
    window.loadProximasCitas?.();
  } catch(err) {
    // FIX v2.1.12: error visible al usuario (antes era console.error silencioso
    // que dejaba todos los KPIs en "—" sin pista del problema)
    console.error('[Brief] error:', err);
    window.toast && window.toast('Brief no se pudo cargar', err.message || 'Error', 'err');
    window.electronAPI?.sentryCapture?.(err);
  }
};

// ============================================================
// v2.3.3 — PANEL · PRÓXIMAS CITAS (Resumen)
// Reemplaza el viejo "ARIA Sugerencias" con un panel realtime de citas hoy+mañana.
// Schema usado:
//   appointments.fecha (date) + .hora (time) → ordenar próximas 48h
//   appointments.created_via='aria' → calcular % cierre por ARIA
//   appointments.created_at + whatsapp_messages.created_at (primer mensaje del lead)
//     → tiempo de captación (lead→cita confirmada por ARIA)
//   leads.nombre + .whatsapp → enriquecer nombre + acceso al chat
// Realtime: ya wired vía realtime.js → debounceCall('appt-brief', loadBriefData),
// que llama de vuelta a esta función.
// ============================================================
window._proximasCache = [];

window.loadProximasCitas = async function(){
  const listEl = document.getElementById('next-list');
  const wrapEl = document.getElementById('next-list-wrap');
  if(!listEl) return; // vista actual no es brief

  try {
    // v2.3.4 FIX ELECTRON-9 · window.todayInTZ() devuelve un OBJETO {y,m,d,ymd},
    // no un string. Interpolarlo directo en la URL daba "fecha=gte.[object Object]"
    // → PostgREST respondía 400. Usamos .ymd para extraer el string YYYY-MM-DD.
    const todayObj    = window.todayInTZ ? window.todayInTZ() : null;
    const todayStr    = todayObj?.ymd || new Date().toISOString().slice(0, 10);
    const tomorrowDate = new Date();
    tomorrowDate.setDate(tomorrowDate.getDate() + 1);
    const tomorrowStr = tomorrowDate.toISOString().slice(0, 10);

    // 1) Próximas 48h activas (hoy + mañana, excluye canceladas/no-show)
    const proximas = await sbGet('appointments',
      `client_id=eq.${window.CLIENT_ID}&fecha=gte.${todayStr}&fecha=lte.${tomorrowStr}` +
      `&estado=not.in.(cancelled,no_show)` +
      `&select=id,lead_id,nombre,servicio,fecha,hora,created_at,created_via,estado` +
      `&order=fecha.asc,hora.asc&limit=100`
    );

    // 2) Calcular tiempo de captación: para cada cita con lead_id+created_via=aria,
    //    buscar el PRIMER mensaje del lead (direction='in') y diff con created_at.
    //    Lo hacemos en batch con un solo round-trip por la lista (limit chico).
    const leadIds = [...new Set(proximas.filter(a => a.lead_id && a.created_via === 'aria').map(a => a.lead_id))];
    const primerMsgPorLead = {};
    if(leadIds.length > 0){
      const idsCSV = leadIds.map(id => `"${id}"`).join(',');
      const firstMsgs = await sbGet('whatsapp_messages',
        `lead_id=in.(${idsCSV})&direction=eq.in&select=lead_id,created_at,body&order=created_at.asc&limit=500`
      );
      // Tomar el primer mensaje por lead (ya viene ordenado asc)
      firstMsgs.forEach(m => {
        if(!primerMsgPorLead[m.lead_id]) primerMsgPorLead[m.lead_id] = m;
      });
    }

    // 3) Enriquecer cada cita con captación + tag dia
    const enriched = proximas.map(a => {
      const isToday = a.fecha === todayStr;
      const isToma  = a.created_via === 'aria';
      let captacionLabel = '—';
      let primerMsg = null;
      if(isToma && a.lead_id && primerMsgPorLead[a.lead_id]){
        primerMsg = primerMsgPorLead[a.lead_id];
        const ms = new Date(a.created_at) - new Date(primerMsg.created_at);
        if(ms > 0){
          const min = Math.floor(ms / 60000);
          if(min < 60)        captacionLabel = `${min} min`;
          else if(min < 1440) captacionLabel = `${Math.floor(min/60)}h ${min%60}m`;
          else                captacionLabel = `${Math.floor(min/1440)}d`;
        }
      }
      const inicial = (a.nombre || '?').split(' ').filter(Boolean).slice(0,2).map(s => s[0]?.toUpperCase()).join('') || '?';
      return {
        ...a,
        dia: isToday ? 'hoy' : 'manana',
        inicial,
        hora_fmt: (a.hora || '00:00').slice(0,5),
        primer_msg: primerMsg,
        captacion_label: captacionLabel
      };
    });

    // Cache para que los modales puedan leer sin re-fetch
    window._proximasCache = enriched;

    // 4) Mini-stats (captación promedio + % cierre por ARIA)
    const conCapt = enriched.filter(a => a.primer_msg);
    let avgCaptureLabel = '—';
    if(conCapt.length > 0){
      const totalMin = conCapt.reduce((s, a) => {
        const ms = new Date(a.created_at) - new Date(a.primer_msg.created_at);
        return s + Math.max(0, Math.floor(ms/60000));
      }, 0);
      avgCaptureLabel = String(Math.round(totalMin / conCapt.length));
    }
    const ariaPct = enriched.length > 0
      ? Math.round((enriched.filter(a => a.created_via === 'aria').length / enriched.length) * 100)
      : 0;

    setSafeText('next-count', `${enriched.length} cita${enriched.length === 1 ? '' : 's'}`);
    setSafeText('next-avg-capture', avgCaptureLabel);
    setSafeText('next-aria-pct', enriched.length > 0 ? ariaPct : '—');

    // 5) Last-sync timestamp (en tz cliente)
    const now = new Date();
    const syncTxt = window.fmtTimeTZ ? window.fmtTimeTZ(now) : (`${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`);
    setSafeText('next-last-sync', syncTxt);

    // 6) Render
    if(enriched.length === 0){
      listEl.innerHTML = `<div class="next-empty">
        Sin citas próximas en las próximas 48h.<br>
        <span style="color:var(--text4);">ARIA agenda automáticamente cuando un lead acepta horario por WhatsApp.</span>
      </div>`;
    } else {
      listEl.innerHTML = enriched.map(a => `
        <div class="cita-card ${a.dia === 'manana' ? 'tomorrow' : ''}" data-cita-id="${a.id}">
          <div class="cita-card-avatar">${a.inicial}</div>
          <div class="cita-card-info">
            <div class="cita-card-row1">
              <span class="cita-card-name">${_escHtml(a.nombre || 'Sin nombre')}</span>
              <span class="cita-tag ${a.dia === 'hoy' ? 'hoy' : 'tomorrow'}">${a.dia === 'hoy' ? 'HOY' : 'MAÑANA'}</span>
            </div>
            <div class="cita-card-row2">
              <span class="cita-card-hora">${a.hora_fmt}</span>
              <span class="cita-card-sep">·</span>
              <span class="cita-card-svc">${_escHtml(a.servicio || 'Sin servicio')}</span>
            </div>
          </div>
          <div class="cita-card-actions">
            <button class="btn-cita" title="Detalle" onclick="openProximaInfo('${a.id}')">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
            </button>
            <button class="btn-cita" title="Chat WhatsApp" onclick="openProximaChat('${a.id}')">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
            </button>
          </div>
        </div>
      `).join('');
    }

    // 7) Fades de scroll arriba/abajo
    if(wrapEl){
      const updateFades = () => {
        const atTop    = listEl.scrollTop <= 4;
        const atBottom = listEl.scrollTop + listEl.clientHeight >= listEl.scrollHeight - 4;
        wrapEl.classList.toggle('no-scroll-top', atTop);
        wrapEl.classList.toggle('no-scroll-bottom', atBottom);
      };
      if(!wrapEl._fadesWired){
        listEl.addEventListener('scroll', updateFades);
        wrapEl._fadesWired = true;
      }
      updateFades();
    }
  } catch(err){
    console.error('[ProximasCitas] error:', err);
    listEl.innerHTML = `<div class="next-empty" style="color:var(--danger);">Error al cargar próximas citas.<br><span style="color:var(--text4);">${_escHtml(err.message || '')}</span></div>`;
    window.electronAPI?.sentryCapture?.(err);
  }
};

function _escHtml(s){ return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// ─── Modales del panel ─────────────────────────────────────────
let _pcCurrentId = null;

window.openProximaInfo = async function(id){
  const a = window._proximasCache.find(x => x.id === id);
  if(!a){ window.toast?.('Error', 'Cita no encontrada en cache', 'err'); return; }
  _pcCurrentId = id;

  const sub = document.getElementById('pc-info-sub');
  if(sub) sub.textContent = `${a.dia === 'hoy' ? 'HOY' : 'MAÑANA'} · ${a.hora_fmt}`;

  const body = document.getElementById('pc-info-body');
  const primerMsgTime = a.primer_msg ? new Date(a.primer_msg.created_at) : null;
  const primerMsgTxt  = a.primer_msg?.body || '—';
  const creadaTime    = new Date(a.created_at);
  const fmt = t => t ? (window.fmtTimeTZ ? window.fmtTimeTZ(t) : `${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}`) : '—';

  body.innerHTML = `
    <div class="pc-tl-paciente">
      <div class="av">${a.inicial}</div>
      <div class="meta">
        <div class="nombre">${_escHtml(a.nombre || 'Sin nombre')}</div>
        <div class="sub">${_escHtml(a.servicio || 'Sin servicio')}</div>
      </div>
    </div>
    <div class="pc-timeline">
      ${primerMsgTime ? `
      <div class="pc-tl-step">
        <div class="pc-tl-dot t1"><div class="core"></div></div>
        <div class="pc-tl-label">Primer mensaje</div>
        <div class="pc-tl-time">${fmt(primerMsgTime)}</div>
        <div class="pc-tl-detail">"${_escHtml(primerMsgTxt)}"</div>
      </div>` : ''}
      <div class="pc-tl-step">
        <div class="pc-tl-dot t2"><div class="core"></div></div>
        <div class="pc-tl-label">Cita ${a.created_via === 'aria' ? 'confirmada por ARIA' : 'creada manualmente'}</div>
        <div class="pc-tl-time">${fmt(creadaTime)}</div>
        <div class="pc-tl-detail">${a.created_via === 'aria' ? 'El paciente aceptó horario y servicio. ARIA cerró el agendamiento sin intervención humana.' : 'Cita registrada desde el panel manual o por integración externa.'}</div>
      </div>
      <div class="pc-tl-step">
        <div class="pc-tl-dot t3"><div class="core"></div></div>
        <div class="pc-tl-label">Cita programada</div>
        <div class="pc-tl-time">${a.hora_fmt} · ${a.dia === 'hoy' ? 'hoy' : 'mañana'}</div>
        <div class="pc-tl-detail">Recordatorio automático 2h antes por WhatsApp.</div>
      </div>
    </div>
    ${a.primer_msg ? `
    <div class="pc-cap-card">
      <div class="pc-cap-meta">
        <div class="pc-cap-label">Tiempo de captación</div>
        <div class="pc-cap-val">${a.captacion_label}</div>
        <div class="pc-cap-sub">Desde primer mensaje hasta cita confirmada.</div>
      </div>
    </div>` : ''}
  `;
  document.getElementById('pc-modal-info')?.classList.add('open');
};

window.openProximaChat = async function(id){
  const a = window._proximasCache.find(x => x.id === id);
  if(!a){ window.toast?.('Error', 'Cita no encontrada en cache', 'err'); return; }
  _pcCurrentId = id;

  const sub = document.getElementById('pc-chat-sub');
  if(sub) sub.textContent = `${a.nombre} · captación ${a.captacion_label}`;

  const body = document.getElementById('pc-chat-body');
  body.innerHTML = `
    <div class="pc-chat-head">
      <div class="av">${a.inicial}</div>
      <div class="meta">
        <div class="nombre">${_escHtml(a.nombre || 'Sin nombre')}</div>
        <div class="estado">● ${a.created_via === 'aria' ? 'cerrado por ARIA' : 'cita manual'}</div>
      </div>
    </div>
    <div class="pc-chat-thread" id="pc-chat-thread">
      <div style="text-align:center;color:var(--text3);font-size:11px;padding:14px;">Cargando conversación…</div>
    </div>
  `;
  document.getElementById('pc-modal-chat')?.classList.add('open');

  // Cargar últimos 50 mensajes del lead
  try {
    if(!a.lead_id){
      document.getElementById('pc-chat-thread').innerHTML = '<div style="text-align:center;color:var(--text3);font-size:11px;padding:14px;">Cita sin lead asociado · sin conversación.</div>';
      return;
    }
    const msgs = await sbGet('whatsapp_messages',
      `lead_id=eq.${a.lead_id}&select=id,direction,body,created_at&order=created_at.asc&limit=50`
    );
    const fmtT = t => {
      const d = new Date(t);
      return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
    };
    const bubbles = msgs.map(m => m.direction === 'in'
      ? `<div class="pc-bubble in">${_escHtml(m.body || '')}<span class="t">${fmtT(m.created_at)}</span></div>`
      : `<div class="pc-bubble out"><span class="by">⚡ ARIA</span><br>${_escHtml(m.body || '')}<span class="t">${fmtT(m.created_at)} · enviado</span></div>`
    ).join('');
    document.getElementById('pc-chat-thread').innerHTML = bubbles + `
      <div class="pc-chat-cita">
        <div class="lbl">✓ Cita agendada</div>
        <div class="v">${_escHtml(a.servicio || '')} · ${a.dia === 'hoy' ? 'hoy' : 'mañana'} ${a.hora_fmt}</div>
      </div>
    `;
    const thread = document.getElementById('pc-chat-thread');
    if(thread) thread.scrollTop = thread.scrollHeight;
  } catch(err){
    document.getElementById('pc-chat-thread').innerHTML = `<div style="text-align:center;color:var(--danger);font-size:11px;padding:14px;">Error: ${_escHtml(err.message || '')}</div>`;
  }
};

window.pcCloseModal = function(which){
  document.getElementById('pc-modal-' + which)?.classList.remove('open');
};

window.pcOpenChatFromInfo = function(){
  window.pcCloseModal('info');
  setTimeout(() => window.openProximaChat(_pcCurrentId), 180);
};

window.pcGoToAria = function(){
  window.pcCloseModal('chat');
  window.go?.('aria');
};

// v2.1.15: nuevos params ariaPaid + ariaRevCents → narrative refleja B+C híbrido
function generateNarrativeReal(leads, citas, conv, ariaConfirmed, ariaPaid, ariaRevCents, totalRev30Cents, sym){
  const revUsd = (totalRev30Cents / 100).toLocaleString('en', { minimumFractionDigits: 2 });
  const parts = [];

  if(leads === 0 && citas === 0 && totalRev30Cents === 0){
    return `Tu cuenta está lista. <strong>ARIA</strong> espera que configures tus servicios y empieces a agendar para mostrarte insights personalizados.`;
  }

  if(totalRev30Cents > 0){
    parts.push(`En los últimos 30 días generaste <strong class="hi-ok">${sym}${revUsd}</strong> en ingresos.`);
  }

  parts.push(`Recibiste <strong>${leads} leads</strong> y confirmaste <strong>${citas} citas</strong> (<span class="hi-ok">${conv}%</span> de conversión lead→cita).`);

  if(parseFloat(conv) > 40){
    parts.push(`Tu conversión está <span class="hi-ok">por encima del promedio de industria</span> (35%). Excelente.`);
  } else if(parseFloat(conv) > 0 && parseFloat(conv) < 25){
    parts.push(`Tu conversión está <span class="hi-danger">por debajo del promedio</span>. Revisa el funnel — probablemente hay fuga en seguimiento.`);
  }

  if(ariaConfirmed > 0){
    if(ariaPaid > 0 && ariaRevCents > 0){
      const ariaRev = (ariaRevCents / 100).toLocaleString('en', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
      parts.push(`<strong class="hi-ok">ARIA cerró ${ariaConfirmed} citas confirmadas</strong> este mes — de las cuales ${ariaPaid} ya generaron <strong class="hi-ok">${sym}${ariaRev}</strong> en ingresos.`);
    } else {
      parts.push(`<strong class="hi-ok">ARIA cerró ${ariaConfirmed} citas confirmadas</strong> este mes (lead → confirmación sin tu intervención). Aún sin pagos registrados.`);
    }
  }

  return parts.join(' ');
}

function generateNarrative(leads, citas, conv, aria, kpis){
  const parts = [];
  const lastK = kpis[kpis.length-1];

  if(leads === 0 && citas === 0){
    return `Aún no hay actividad en tu cuenta. <strong>ARIA</strong> está lista para ayudarte a empezar — agrega tu primera campaña y comenzamos a generar leads.`;
  }

  parts.push(`En los últimos 30 días recibiste <strong>${leads} leads</strong> y convertiste <strong>${citas} citas confirmadas</strong> (<span class="hi-ok">${conv}%</span> de conversión).`);

  if(parseFloat(conv) > 40){
    parts.push(`Tu tasa de conversión está <span class="hi-ok">por encima del promedio de industria</span> (35%). Sigue así.`);
  } else if(parseFloat(conv) > 0 && parseFloat(conv) < 25){
    parts.push(`Tu tasa de conversión está <span class="hi-danger">por debajo del promedio</span>. Revisa el funnel: probablemente hay fuga en el paso lead → contactado.`);
  }

  // Fix audit: la columna real es revenue_cents (bigint). ingresos_generados era legacy.
  const lastRev = lastK ? Number(lastK.revenue_cents || lastK.ingresos_generados || 0) : 0;
  if(lastRev > 0){
    const lastRevDisplay = lastK.revenue_cents ? (lastRev / 100) : lastRev;
    parts.push(`Ingresos generados este ciclo: <strong>$${Number(lastRevDisplay).toLocaleString('en', { minimumFractionDigits: 2 })}</strong>.`);
  }

  if(aria > 0){
    parts.push(`ARIA tiene <strong>${aria} sugerencias pendientes</strong> de tu revisión que podrían impactar directamente estos números.`);
  }

  return parts.join(' ');
}

// ============================================
// VIEW: FUNNEL
// ============================================
// Month-based navigation (alineado al mockup, igual que Ingresos chart)
let _funnelSelectedMonth = null;  // 'YYYY-MM' del mes seleccionado
let _funnelRange = 30;            // legacy, conservado por compat
let _funnelRefreshBusy = false;

window.funnelChangeMonth = function(dir){
  const cur = _funnelSelectedMonth;
  if(!cur) return;
  const [y, m] = cur.split('-').map(n => parseInt(n, 10));
  const d = new Date(y, m - 1 + dir, 1);
  const now = new Date();
  // No permitir avanzar más allá del mes actual
  if(d.getFullYear() > now.getFullYear() || (d.getFullYear() === now.getFullYear() && d.getMonth() > now.getMonth())) return;
  // Limite hacia atrás: 12 meses
  const oldestAllowed = new Date(now); oldestAllowed.setMonth(oldestAllowed.getMonth() - 12); oldestAllowed.setDate(1);
  if(d < oldestAllowed) return;
  _funnelSelectedMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  loadFunnel();
};

window.funnelGoToCurrentMonth = function(){
  const now = new Date();
  _funnelSelectedMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  loadFunnel();
};

// Compat: por si código viejo llama funnelRange — lo redirigimos al mes actual
window.funnelRange = function(days){
  window.funnelGoToCurrentMonth();
};

window.refreshFunnel = async function(){
  if(_funnelRefreshBusy) return;
  const btn = document.getElementById('funnel-refresh-btn');
  _funnelRefreshBusy = true;
  if(btn){ btn.disabled = true; btn.style.opacity = '0.5'; btn.textContent = '…'; }
  try {
    await loadFunnel();
    window.toast && window.toast('✓ Funnel actualizado', null, 'success');
  } catch(err){
    window.toast && window.toast('Error', err.message || 'No se pudo refrescar', 'err');
  } finally {
    setTimeout(() => {
      _funnelRefreshBusy = false;
      if(btn){ btn.disabled = false; btn.style.opacity = ''; btn.textContent = '↻'; }
    }, 1200);
  }
};

async function loadFunnel(){
  try {
    const now = new Date();
    // Init: si no hay mes seleccionado, usar el actual
    if(!_funnelSelectedMonth){
      _funnelSelectedMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    }
    const [y, m] = _funnelSelectedMonth.split('-').map(n => parseInt(n, 10));
    const monthStart = new Date(y, m - 1, 1);
    const monthEnd = new Date(y, m, 1); // primer día del mes siguiente (exclusive)
    const startIso = monthStart.toISOString();
    const endIso = monthEnd.toISOString();
    const isCurrentMonth = (y === now.getFullYear() && (m - 1) === now.getMonth());

    // Update labels del header
    const monthsLong = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
    const monthLabel = `${monthsLong[m-1]} ${y}`;
    const setTxt = (id, v) => { const el = document.getElementById(id); if(el) el.textContent = v; };
    setTxt('funnel-month-label', monthLabel);
    setTxt('funnel-month-current', monthLabel);
    setTxt('funnel-range-label', isCurrentMonth ? 'mes en curso · día ' + now.getDate() : 'mes cerrado');

    // Disable nav prev/next en bordes
    const prevBtn = document.getElementById('funnel-month-prev');
    const nextBtn = document.getElementById('funnel-month-next');
    if(prevBtn){
      const oldestAllowed = new Date(now); oldestAllowed.setMonth(oldestAllowed.getMonth() - 12); oldestAllowed.setDate(1);
      const candidate = new Date(y, m - 2, 1);
      prevBtn.disabled = candidate < oldestAllowed;
    }
    if(nextBtn) nextBtn.disabled = isCurrentMonth;

    // Days in month (para mostrar contexto en recomendación)
    const daysInMonth = new Date(y, m, 0).getDate();
    const days = isCurrentMonth ? now.getDate() : daysInMonth;

    const [leads, apts] = await Promise.all([
      sbGet('leads',
        `client_id=eq.${window.CLIENT_ID}&created_at=gte.${startIso}&created_at=lt.${endIso}&select=id,status,created_at`),
      sbGet('appointments',
        `client_id=eq.${window.CLIENT_ID}&created_at=gte.${startIso}&created_at=lt.${endIso}&select=id,estado,confirmed_at,pagado,paid_at,created_at`)
    ]);

    const total       = leads.length;
    const contactados = leads.filter(l => ['contactado','cita_agendada','cliente'].includes(l.status)).length;

    // Funnel principal: excluye canceladas y no_show del flujo hacia abajo.
    const aptsActivas = apts.filter(a => !['cancelled','no_show'].includes(a.estado));
    const agendados   = aptsActivas.length;
    // Una cita ya confirmada cuenta aunque luego pase a completed (usamos confirmed_at o estado ∈ confirmed/completed).
    const confirmados = aptsActivas.filter(a => a.confirmed_at != null || ['confirmed','completed'].includes(a.estado)).length;
    const realizados  = aptsActivas.filter(a => a.estado === 'completed').length;
    const pagados     = aptsActivas.filter(a => a.pagado === true).length;

    // Fuga: canceladas + no-show (separado, no cuenta en el funnel principal)
    const canceladas = apts.filter(a => a.estado === 'cancelled').length;
    const noShow     = apts.filter(a => a.estado === 'no_show').length;

    const stages = [
      { label: 'Leads nuevos',      count: total,       max: total },
      { label: 'Contactados',       count: contactados, max: total },
      { label: 'Citas agendadas',   count: agendados,   max: total },
      { label: 'Citas confirmadas', count: confirmados, max: total },
      { label: 'Citas realizadas',  count: realizados,  max: total },
      { label: 'Pagadas',           count: pagados,     max: total },
    ];

    const container = document.getElementById('funnel-container');
    if(!container) return;
    container.innerHTML = '';

    stages.forEach((s, i) => {
      const pctTotal = s.max > 0 ? (s.count / s.max) * 100 : 0;
      const prevCount = i > 0 ? stages[i-1].count : 0;
      const absorption = (i > 0 && prevCount > 0) ? (s.count / prevCount) * 100 : null;
      const dropPct    = (i > 0 && prevCount > 0) ? ((prevCount - s.count) / prevCount) * 100 : 0;
      const isDrop     = dropPct >= 35 && i > 0 && prevCount > 0;
      const absClass   = absorption == null ? '' : (absorption >= 65 ? 'ok' : (absorption < 50 ? 'drop' : ''));
      const absText    = absorption == null ? '' : `↓ ${absorption.toFixed(0)}%`;

      container.innerHTML += `
        <div class="funnel-row">
          <div class="funnel-label">${s.label}</div>
          <div class="funnel-bar"><div class="funnel-bar-fill ${isDrop?'drop':''}" style="width:${pctTotal}%"></div></div>
          <div class="funnel-count">${s.count}</div>
          <div class="funnel-pct">
            <span class="funnel-pct-total">${pctTotal.toFixed(0)}% total</span>
            <span class="funnel-pct-abs ${absClass}">${absText}</span>
          </div>
          <div>${isDrop ? '⚠' : ''}</div>
        </div>`;

      if(isDrop){
        const tip = s.label === 'Contactados'
          ? 'Revisa velocidad de primer contacto (<4min) y mensajería de apertura.'
          : s.label === 'Citas agendadas'
          ? 'Revisa fricción al agendar: horarios disponibles, opciones de servicios, CTA claro.'
          : s.label === 'Citas confirmadas'
          ? 'Refuerza recordatorios por WhatsApp 24h antes + email de confirmación dark-mode.'
          : s.label === 'Citas realizadas'
          ? 'Probablemente hay no-show. Activa recordatorio 2h antes y revisa tasa de cancelación.'
          : s.label === 'Pagadas'
          ? 'Hay realizadas sin pago registrado. Verifica que marques "pagado" al cerrar la cita.'
          : 'Revisa seguimiento.';
        container.innerHTML += `<div class="funnel-ia-hint"><strong>ARIA detectó fuga:</strong> Pierdes ${dropPct.toFixed(0)}% entre "${stages[i-1].label}" y "${s.label}". ${tip}</div>`;
      }
    });

    // Fuga panel (separado): canceladas + no-show como % de agendadas brutas
    const totalAgendadoBruto = agendados + canceladas + noShow;
    const fugaContainer = document.getElementById('funnel-fuga-container');
    const fugaSub = document.getElementById('funnel-fuga-sub');
    if(fugaContainer){
      fugaContainer.innerHTML = '';
      const fugaStages = [
        { label: 'Canceladas', count: canceladas, base: totalAgendadoBruto },
        { label: 'No-show',    count: noShow,     base: totalAgendadoBruto },
      ];
      fugaStages.forEach(f => {
        const pct = f.base > 0 ? (f.count / f.base) * 100 : 0;
        fugaContainer.innerHTML += `
          <div class="funnel-row">
            <div class="funnel-label">${f.label}</div>
            <div class="funnel-bar"><div class="funnel-bar-fill fuga" style="width:${pct}%"></div></div>
            <div class="funnel-count">${f.count}</div>
            <div class="funnel-pct">
              <span class="funnel-pct-total">${pct.toFixed(0)}%</span>
              <span class="funnel-pct-abs">de agendas</span>
            </div>
            <div></div>
          </div>`;
      });
      if(fugaSub){
        fugaSub.textContent = totalAgendadoBruto > 0
          ? `${canceladas + noShow} de ${totalAgendadoBruto} citas fugadas (${(((canceladas + noShow) / totalAgendadoBruto) * 100).toFixed(0)}%)`
          : 'Sin citas en este periodo';
      }
    }

    // ── Recomendación ARIA: detecta el mayor drop y sugiere acción ──
    const recoEl = document.getElementById('funnel-recommendation');
    if(recoEl){
      // Encontrar el mayor drop entre etapas
      let biggestDrop = null;
      for(let i = 1; i < stages.length; i++){
        const prev = stages[i-1].count;
        const curr = stages[i].count;
        if(prev > 0){
          const dropPct = ((prev - curr) / prev) * 100;
          if(!biggestDrop || dropPct > biggestDrop.pct){
            biggestDrop = { from: stages[i-1].label, to: stages[i].label, pct: dropPct, lost: prev - curr };
          }
        }
      }
      if(!biggestDrop || biggestDrop.pct < 15){
        recoEl.innerHTML = `Tu funnel está saludable: la peor conversión entre etapas es <strong style="color:var(--success);">menor al 15%</strong>. Continúa monitoreando esta vista para detectar cambios.`;
      } else {
        const tip = biggestDrop.from === 'Contactados' || biggestDrop.to === 'Contactados'
          ? 'Acelerá el primer contacto: ARIA debería responder en menos de 4 minutos.'
          : biggestDrop.to === 'Citas agendadas'
          ? 'Reducí la fricción al agendar: simplificá horarios y servicios disponibles.'
          : biggestDrop.to === 'Citas confirmadas'
          ? 'Activa la regla de confirmación 24h antes en ARIA + email de recordatorio.'
          : biggestDrop.to === 'Citas realizadas'
          ? 'Reducí no-shows con recordatorio 2h antes (email + WhatsApp).'
          : biggestDrop.to === 'Pagadas'
          ? 'Verifica que marques "pagado" al cerrar cada cita. Considerá pagos en línea (Enterprise).'
          : 'Revisa el seguimiento en este punto del funnel.';
        recoEl.innerHTML = `Pierdes el <strong style="color:var(--danger);">${biggestDrop.pct.toFixed(0)}%</strong> de tu volumen entre <strong style="color:var(--text);">"${biggestDrop.from}"</strong> y <strong style="color:var(--text);">"${biggestDrop.to}"</strong> (<strong>${biggestDrop.lost}</strong> casos perdidos en ${monthLabel}).<br><br><strong style="color:var(--text);">Recomendación:</strong> ${tip}`;
      }
    }
  } catch(err) {
    // FIX v2.1.20 P2 — error visible al usuario (antes: silenciado en console)
    console.error('[Funnel] error:', err);
    window.toast?.('Funnel no se pudo cargar', err.message || 'Error de conexión', 'err');
    window.electronAPI?.sentryCapture?.(err);
  }
}

window.loadFunnel = loadFunnel;

// ============================================
// v2.1.24 — VISTA INGRESOS (independiente, antes era tab dentro de ROI)
// ============================================
window.loadIngresosView = async function(){
  try {
    // FIX v2.1.31 — siempre llamar loadIngresos (sin guard _ingresosLoaded).
    // Antes: solo cargaba 1 vez al login y nunca más → realtime no actualizaba KPIs/chart
    // Ahora: cuando llega un pago vía realtime, los KPIs y la gráfica se redibujan
    await loadIngresos();
    // Cargar historial de pagos al abrir vista (defaults: mes actual)
    if(typeof window.loadHistorialPagos === 'function') window.loadHistorialPagos();
  } catch(err){
    console.error('[Ingresos] error:', err);
    window.toast?.('Ingresos no se pudo cargar', err.message || 'Error de conexión', 'err');
    window.electronAPI?.sentryCapture?.(err);
  }
};

// ============================================
// v2.1.24 — VISTA PUBLICIDAD (sección dedicada)
// ============================================
// Templates hardcoded por vertical (clinica_estetica). Futuro: tabla ad_templates.
const _PUB_TEMPLATES = [
  {
    icon: '🌸',
    name: 'Limpieza facial promo',
    body: '✨ Limpieza facial profunda con 20% off esta semana en {empresa}.\n\nResultados desde la primera sesión. Agenda en 30 segundos por WhatsApp.\n\n👉 Click "Enviar mensaje" abajo.',
    visual: 'Reel 15-30s de antes/después · música trending IG · texto overlay primeros 3s',
    cta_message: 'Quiero la promo de limpieza facial'
  },
  {
    icon: '💎',
    name: 'Botox promo',
    body: '💎 Botox profesional desde {empresa}.\n\nResultados naturales, sin ese look "congelado". Aplicación en 30 min con anestesia tópica.\n\nAbril con 20% off. ¿Te explico?',
    visual: 'Reel cara antes/después + cita testimonio · target 28-50 años',
    cta_message: 'Me interesa botox de abril 20% off'
  },
  {
    icon: '🎉',
    name: 'Pack anti-edad',
    body: '🎉 Pack anti-edad: tratamiento + radiofrecuencia + sérum.\n\n3 sesiones por el precio de 2.\n\nLa Dra. María diseña tu plan. Agenda valoración gratis.',
    visual: 'Carrusel 5 imágenes de tratamientos · target 35-55',
    cta_message: 'Me interesa el pack anti-edad'
  },
  {
    icon: '💌',
    name: 'Reactivación clientes',
    body: '👋 ¿Hace tiempo que no nos vemos?\n\nTenemos novedades en {empresa}: nuevos tratamientos + 15% off para clientes que regresan este mes.\n\n¿Te agendamos?',
    visual: 'Story 9:16 · texto centrado · CTA visible',
    cta_message: 'Quiero la promo de reactivación'
  }
];

// Publicidad: ahora navega por mes (alineado al mockup, igual que Ingresos/Funnel)
let _pubSelectedMonth = null;  // 'YYYY-MM' del mes seleccionado
let _pubRange = 30;            // legacy, conservado por compat
let _pubChart = null;
let _pubRefreshBusy = false;

window.pubChangeMonth = function(dir){
  const cur = _pubSelectedMonth;
  if(!cur) return;
  const [y, m] = cur.split('-').map(n => parseInt(n, 10));
  const d = new Date(y, m - 1 + dir, 1);
  const now = new Date();
  if(d.getFullYear() > now.getFullYear() || (d.getFullYear() === now.getFullYear() && d.getMonth() > now.getMonth())) return;
  const oldestAllowed = new Date(now); oldestAllowed.setMonth(oldestAllowed.getMonth() - 12); oldestAllowed.setDate(1);
  if(d < oldestAllowed) return;
  _pubSelectedMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  window.loadPublicidad();
};

window.pubGoToCurrentMonth = function(){
  const now = new Date();
  _pubSelectedMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  window.loadPublicidad();
};

// Compat: por si código viejo llama pubRange — redirige al mes actual
window.pubRange = function(days){
  window.pubGoToCurrentMonth();
};

window.refreshPublicidad = async function(){
  if(_pubRefreshBusy) return;
  const btn = document.getElementById('pub-refresh-btn');
  _pubRefreshBusy = true;
  if(btn){ btn.disabled = true; btn.style.opacity = '0.5'; btn.textContent = '…'; }
  try {
    await window.loadPublicidad();
    window.toast?.('✓ Publicidad actualizada', null, 'success');
  } catch(err){
    window.toast?.('Error', err.message || 'No se pudo refrescar', 'err');
  } finally {
    setTimeout(() => {
      _pubRefreshBusy = false;
      if(btn){ btn.disabled = false; btn.style.opacity = ''; btn.textContent = '↻'; }
    }, 1200);
  }
};

window.loadPublicidad = async function(){
  try {
    const c = window.currentClient || {};
    const moneda = c.moneda || 'USD';
    const monedaSym = { USD:'$', MXN:'$', DOP:'RD$', EUR:'€', COP:'$' }[moneda] || '$';

    // Init mes seleccionado si no hay (mes actual)
    const now = new Date();
    if(!_pubSelectedMonth){
      _pubSelectedMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    }
    const [y, m] = _pubSelectedMonth.split('-').map(n => parseInt(n, 10));
    const monthStart = new Date(y, m - 1, 1);
    const monthEnd = new Date(y, m, 1);
    const startIso = monthStart.toISOString();
    const endIso = monthEnd.toISOString();
    const isCurrentMonth = (y === now.getFullYear() && (m - 1) === now.getMonth());

    const monthsLong = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
    const monthLabel = `${monthsLong[m-1]} ${y}`;

    // Update labels del nav
    const setEl = (id, v) => { const el = document.getElementById(id); if(el) el.textContent = v; };
    setEl('pub-month-label', monthLabel);
    setEl('pub-month-current', monthLabel);

    // Disable nav prev/next en bordes
    const prevBtn = document.getElementById('pub-month-prev');
    const nextBtn = document.getElementById('pub-month-next');
    if(prevBtn){
      const oldestAllowed = new Date(now); oldestAllowed.setMonth(oldestAllowed.getMonth() - 12); oldestAllowed.setDate(1);
      const candidate = new Date(y, m - 2, 1);
      prevBtn.disabled = candidate < oldestAllowed;
    }
    if(nextBtn) nextBtn.disabled = isCurrentMonth;

    // 1) Tu número WhatsApp ARIA
    const waNumber = c.wa_display_phone || c.whatsapp || '+52 — — —';
    const waConnected = c.wa_status === 'connected';
    const waNumberEl = document.getElementById('pub-wa-number');
    if(waNumberEl) waNumberEl.textContent = waNumber;
    const waStatusEl = document.getElementById('pub-wa-status');
    if(waStatusEl) waStatusEl.innerHTML = waConnected
      ? '<span style="color:var(--success);">● ARIA conectada · responde 24/7</span>'
      : '<span style="color:var(--warn);">○ Conectá tu WhatsApp en Settings → Mi WhatsApp</span>';

    // Update label del trend
    const leadsTrendEl = document.getElementById('pub-leads-trend');
    if(leadsTrendEl) leadsTrendEl.textContent = isCurrentMonth ? 'mes en curso' : monthLabel.toLowerCase();

    // 2) KPIs filtered: leads del mes seleccionado
    const [adLeads, adAppts, paidAdAppts, campañas] = await Promise.all([
      sbGet('leads', `client_id=eq.${window.CLIENT_ID}&utm_source=in.(instagram,facebook,meta_ads)&utm_medium=eq.paid&created_at=gte.${startIso}&created_at=lt.${endIso}&select=id,utm_source,utm_campaign,created_at`),
      sbGet('appointments', `client_id=eq.${window.CLIENT_ID}&created_via=eq.aria&estado=in.(confirmed,completed)&created_at=gte.${startIso}&created_at=lt.${endIso}&select=id,lead_id,pagado,neto_cents,precio_cents,created_at`),
      sbGet('appointments', `client_id=eq.${window.CLIENT_ID}&created_via=eq.aria&pagado=eq.true&paid_at=gte.${startIso}&paid_at=lt.${endIso}&select=id,lead_id,neto_cents,precio_cents,paid_at`),
      sbGet('ad_campaigns', `client_id=eq.${window.CLIENT_ID}&select=*&order=created_at.desc`)
    ]);

    // Filtrar appts/paidAppts a solo los que vinieron de ads (lead_id en adLeads)
    const adLeadIds = new Set(adLeads.map(l => l.id));
    const adAppointments = adAppts.filter(a => adLeadIds.has(a.lead_id));
    const adPaidAppts = paidAdAppts.filter(a => adLeadIds.has(a.lead_id));
    const adRevenueCents = adPaidAppts.reduce((s,a) => s + (a.neto_cents || a.precio_cents || 0), 0);
    const adRevenueAmount = adRevenueCents / 100;

    document.getElementById('pub-leads').textContent = adLeads.length;
    document.getElementById('pub-citas').textContent = adAppointments.length;
    document.getElementById('pub-revenue').textContent = adLeads.length > 0
      ? `${monedaSym}${adRevenueAmount.toLocaleString('en',{minimumFractionDigits:0,maximumFractionDigits:0})}`
      : '—';

    // 3) Tabla campañas
    const campCount = document.getElementById('pub-camp-count');
    const campTbody = document.getElementById('pub-camp-tbody');
    if(campCount) campCount.textContent = `${campañas.length} campaña${campañas.length === 1 ? '' : 's'}`;
    if(campTbody){
      if(campañas.length === 0){
        campTbody.innerHTML = '<tr><td colspan="7" class="dim" style="text-align:center;padding:20px;">Aún no tienes campañas registradas. Click "+ Nueva campaña" para empezar.</td></tr>';
      } else {
        campTbody.innerHTML = campañas.map(camp => {
          // Leads que matchean este campaign nombre
          const leadsCamp = adLeads.filter(l => l.utm_campaign === camp.nombre).length;
          const cierresCamp = adAppointments.filter(a => {
            const lead = adLeads.find(l => l.id === a.lead_id);
            return lead?.utm_campaign === camp.nombre;
          }).length;
          const platIcon = camp.plataforma === 'facebook' ? '📘' : camp.plataforma === 'instagram' ? '📷' : '🌐';
          const statusChip = camp.status === 'active'
            ? '<span class="chip chip-ok"><span class="chip-dot"></span>Activa</span>'
            : camp.status === 'paused'
              ? '<span class="chip chip-warn"><span class="chip-dot"></span>Pausada</span>'
              : '<span class="chip chip-off"><span class="chip-dot"></span>Terminada</span>';
          return `
            <tr>
              <td><strong>${escapeHtml(camp.nombre)}</strong></td>
              <td class="dim">${platIcon} ${escapeHtml(camp.plataforma)}</td>
              <td class="dim" style="font-size:11px;font-style:italic;">"${escapeHtml((camp.mensaje_trigger || '').slice(0,40))}${(camp.mensaje_trigger || '').length > 40 ? '...' : ''}"</td>
              <td>${statusChip}</td>
              <td class="num">${leadsCamp}</td>
              <td class="num ok">${cierresCamp}</td>
              <td style="white-space:nowrap;">
                <button class="btn ghost" style="font-size:10px;padding:3px 8px;margin-right:4px;" onclick="openMetaWizard('${camp.id}')" title="Ver pasos para lanzar en Meta">Ver guía</button>
                <button class="btn ghost" style="font-size:10px;padding:3px 8px;" onclick="deleteAdCampaign('${camp.id}','${escapeHtml(camp.nombre)}')">Eliminar</button>
              </td>
            </tr>`;
        }).join('');
      }
    }

    // 4) Templates grid
    const templatesGrid = document.getElementById('pub-templates-grid');
    if(templatesGrid){
      templatesGrid.innerHTML = _PUB_TEMPLATES.map((t, idx) => `
        <div style="padding:12px;background:var(--card2);border-radius:8px;border:1px solid var(--border);cursor:pointer;transition:border-color 140ms;" onmouseover="this.style.borderColor='var(--border2)'" onmouseout="this.style.borderColor='var(--border)'" onclick="showAdTemplate(${idx})">
          <div style="font-size:24px;margin-bottom:6px;">${t.icon}</div>
          <div style="font-size:12px;font-weight:500;color:var(--text);margin-bottom:4px;">${escapeHtml(t.name)}</div>
          <div style="font-size:10px;color:var(--text3);line-height:1.5;">Click para ver copy + visual sugerido</div>
        </div>`).join('');
    }

    // 5) Historial de pagos detallado (lista cita por cita)
    await window.loadAdsPaymentHistory();

  } catch(err){
    console.error('[Publicidad] error:', err);
    window.toast?.('Publicidad no se pudo cargar', err.message || 'Error de conexión', 'err');
    window.electronAPI?.sentryCapture?.(err);
  }
};

// v2.1.28 — Historial detallado de pagos generados por ARIA via Publicidad
// Reemplaza _loadAdSpendHistory mensual + _renderRoasChart + edición retroactiva (todo eliminado v2.1.28)
window.loadAdsPaymentHistory = async function(){
  try {
    const c = window.currentClient || {};
    const moneda = c.moneda || 'USD';
    const monedaSym = { USD:'$', MXN:'$', DOP:'RD$', EUR:'€', COP:'$' }[moneda] || '$';
    const tbody = document.getElementById('pub-pay-tbody');
    if(!tbody) return;

    // Defaults: primer día del mes actual → hoy (v2.1.36: en tz del cliente)
    const fromEl = document.getElementById('pub-pay-from');
    const toEl   = document.getElementById('pub-pay-to');
    const t = window.todayInTZ();
    if(fromEl && !fromEl.value){
      fromEl.value = `${t.y}-${String(t.m).padStart(2,'0')}-01`;
    }
    if(toEl && !toEl.value){
      toEl.value = t.ymd;
    }
    const fromIso = `${fromEl.value}T00:00:00`;
    const toIso   = `${toEl.value}T23:59:59`;

    // Trae solo leads de ads + appointments pagados en el rango
    const [adsLeads, paidAppts, campaigns] = await Promise.all([
      sbGet('leads', `client_id=eq.${window.CLIENT_ID}&utm_source=in.(instagram,facebook,meta_ads)&utm_medium=eq.paid&select=id,utm_source,utm_campaign`),
      // FIX v2.1.35 — pagos de leads ARIA usan created_via='aria' como filtro real
      sbGet('appointments', `client_id=eq.${window.CLIENT_ID}&pagado=eq.true&created_via=eq.aria&paid_at=gte.${fromIso}&paid_at=lte.${toIso}&select=id,nombre,servicio,paid_at,neto_cents,precio_cents,metodo_pago,lead_id&order=paid_at.desc&limit=500`),
      sbGet('ad_campaigns', `client_id=eq.${window.CLIENT_ID}&select=id,nombre`)
    ]);

    // Filtrar solo los pagos cuyos leads vinieron de ads
    const adsLeadMap = new Map(adsLeads.map(l => [l.id, l]));
    const adPayments = paidAppts.filter(a => adsLeadMap.has(a.lead_id));

    const total = adPayments.reduce((s, a) => s + (a.neto_cents || a.precio_cents || 0), 0);
    document.getElementById('pub-pay-count').textContent = adPayments.length === 0
      ? 'Sin pagos en este rango'
      : `${adPayments.length} pago${adPayments.length === 1 ? '' : 's'} · total ${monedaSym}${(total/100).toLocaleString('en')}`;

    if(adPayments.length === 0){
      tbody.innerHTML = '<tr><td colspan="6" class="dim" style="text-align:center;padding:20px;">Sin pagos generados por ARIA via publicidad en este rango</td></tr>';
      return;
    }
    tbody.innerHTML = adPayments.map(a => {
      const monto = (a.neto_cents || a.precio_cents || 0) / 100;
      const fecha = window.fmtDateTZ(a.paid_at, { day:'2-digit', month:'short', year:'numeric' });
      const lead = adsLeadMap.get(a.lead_id);
      const platIcon = lead?.utm_source === 'facebook' ? '📘' : '📷';
      const campaignLabel = lead?.utm_campaign || `${platIcon} ${lead?.utm_source || 'ads'}`;
      return `
        <tr style="cursor:pointer;" onclick="showApptDetail('${a.id}')">
          <td class="num">${fecha}</td>
          <td>${escapeHtml(a.nombre || '—')}</td>
          <td class="dim">${escapeHtml(a.servicio || '—')}</td>
          <td class="num" style="color:var(--success);">${monedaSym}${monto.toLocaleString('en',{minimumFractionDigits:2})}</td>
          <td>${escapeHtml((a.metodo_pago || '—').toUpperCase())}</td>
          <td class="dim">${escapeHtml(campaignLabel)}</td>
        </tr>`;
    }).join('');
  } catch(err){
    console.error('[AdsPaymentHistory] error:', err);
    window.toast?.('Historial no se pudo cargar', err.message || 'Error de conexión', 'err');
    window.electronAPI?.sentryCapture?.(err);
  }
};

// v2.1.28 — funciones obsoletas (rollover, ROAS, inversión, chart, history mensual) removidas
// Stubs no-op por compat para evitar TypeError si quedan referencias antiguas en cache:
window._loadAdSpendHistory = async function(){ /* removed v2.1.28 */ };
window._renderRoasChart = function(){ /* removed v2.1.28 */ };
window._confirmAdSpendRollover = function(){ /* removed v2.1.28 */ };
window._focusAdSpendInput = function(){ /* removed v2.1.28 */ };
window.editAdSpend = function(){ /* removed v2.1.28 */ };
window._saveAdSpendForPeriod = function(){ /* removed v2.1.28 */ };
window.saveAdSpend = function(){ /* removed v2.1.28 */ };

// (Reemplazo del bloque viejo) — todo el código de history mensual + ROAS chart + edit retroactivo
// + saveAdSpend + rollover banner ha sido eliminado en v2.1.28 según decisión del usuario:
// "eliminar KPI ROAS · eliminar inversión · eliminar chart · eliminar Insight ARIA"
window.copyAriaNumber = function(){
  const el = document.getElementById('pub-wa-number');
  const num = el?.textContent || '';
  if(!num || num.includes('—')){
    window.toast?.('Sin número', 'Conecta tu WhatsApp en Settings primero', 'warn');
    return;
  }
  navigator.clipboard.writeText(num.trim())
    .then(() => window.toast?.('✓ Copiado', `${num.trim()} listo para pegar en Meta`, 'success'))
    .catch(() => window.toast?.('No se pudo copiar', 'Selecciona y copia manualmente', 'err'));
};

window.openNewAdCampaign = function(){
  // Sin presupuesto — el cliente no carga budget. ARIA + agenda + pagos generan
  // los datos automáticamente y el dashboard los refleja en tiempo real.
  const body = `
    <div class="field"><div class="field-label">NOMBRE DE LA CAMPAÑA</div><input class="field-input" id="adc-name" placeholder="Ej: Botox Abril 20% off"></div>
    <div class="field"><div class="field-label">PLATAFORMA</div><select class="field-select" id="adc-platform"><option value="instagram">📷 Instagram</option><option value="facebook">📘 Facebook</option><option value="meta_ads">🌐 Meta Ads (ambas)</option><option value="otra">Otra</option></select></div>
    <div class="field">
      <div class="field-label">MENSAJE PRE-LLENADO (clave para attribution)</div>
      <input class="field-input" id="adc-trigger" placeholder="Ej: Me interesa botox de abril 20% off">
      <div style="font-size:10px;color:var(--text3);margin-top:4px;line-height:1.5;">Pega este mensaje exacto en el campo "Mensaje pre-llenado" cuando crees el ad en Meta. ARIA detecta este texto y atribuye los leads a esta campaña automáticamente.</div>
    </div>
    <div style="padding:10px 12px;background:rgba(232,232,232,0.04);border:1px solid var(--border);border-radius:7px;font-size:11px;color:var(--text2);line-height:1.55;margin-top:6px;">
      ℹ Los leads, citas e ingresos de esta campaña se calculan <strong style="color:var(--text);">automáticamente</strong> desde la conversación con ARIA, la agenda y los pagos. No necesitas cargar presupuesto.
    </div>
  `;
  showModal('Nueva campaña de publicidad', body, `
    <button class="btn ghost" onclick="closeModal()">Cancelar</button>
    <button class="btn primary" onclick="saveAdCampaign()">Crear campaña</button>
  `);
};

window.saveAdCampaign = async function(){
  const nombre = (document.getElementById('adc-name')?.value || '').trim();
  const plataforma = document.getElementById('adc-platform')?.value || 'instagram';
  const trigger = (document.getElementById('adc-trigger')?.value || '').trim();

  if(nombre.length < 3){ window.toast?.('Nombre muy corto', 'Mínimo 3 caracteres', 'warn'); return; }
  if(trigger.length < 5){ window.toast?.('Mensaje trigger muy corto', 'Necesita al menos 5 caracteres para detección', 'warn'); return; }

  try {
    const inserted = await sbInsert('ad_campaigns', {
      client_id: window.CLIENT_ID,
      nombre,
      plataforma,
      mensaje_trigger: trigger,
      // presupuesto eliminado — el cliente no carga budget, ARIA+pagos calculan todo
      fecha_inicio: window.todayInTZ().ymd,
      status: 'active'
    });
    closeModal();
    window.toast?.('Campaña creada', 'Sigue los pasos para lanzar el ad en Meta', 'success');
    await window.loadPublicidad();
    // v2.1.26 — abrir wizard guiado post-creación
    if(inserted && inserted[0]?.id){
      setTimeout(() => window.openMetaWizard(inserted[0].id), 300);
    }
  } catch(err){
    console.error('[saveAdCampaign] error:', err);
    window.toast?.('Error', err.message || 'No se pudo guardar', 'err');
  }
};

// ============================================
// v2.1.26 — Wizard guiado para crear ad en Meta
// ============================================
window.openMetaAdsManager = function(){
  const url = 'https://business.facebook.com/adsmanager/manage/campaigns';
  if(window.electronAPI?.openExternal){
    window.electronAPI.openExternal(url);
  } else {
    window.open(url, '_blank');
  }
  window.toast?.('Abriendo Meta Ads Manager', 'Se abrió en tu navegador', 'info');
};

window.openMetaWizard = async function(campaignId){
  try {
    const camps = await sbGet('ad_campaigns', `id=eq.${campaignId}&select=*`);
    if(!camps.length){ window.toast?.('Campaña no encontrada', null, 'warn'); return; }
    const camp = camps[0];
    const c = window.currentClient || {};
    const waNumber = c.wa_display_phone || c.whatsapp || '+52 — — —';
    const platLabel = camp.plataforma === 'facebook' ? 'Facebook' : camp.plataforma === 'instagram' ? 'Instagram' : 'Meta';

    const stepBadge = (n) => `<div style="width:24px;height:24px;border-radius:50%;background:var(--card3);border:1px solid var(--border2);color:var(--text);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;font-family:'Geist Mono',monospace;flex-shrink:0;">${n}</div>`;
    const stepBlock = (n, title, body) => `
      <div style="display:flex;gap:12px;padding:14px 0;border-bottom:1px dashed var(--border);">
        ${stepBadge(n)}
        <div style="flex:1;min-width:0;">
          <div style="font-size:12px;font-weight:500;color:var(--text);margin-bottom:6px;">${title}</div>
          <div style="font-size:11px;color:var(--text2);line-height:1.6;">${body}</div>
        </div>
      </div>
    `;

    const body = `
      <div style="font-size:11px;color:var(--text3);font-family:'Geist Mono',monospace;letter-spacing:0.5px;text-transform:uppercase;margin-bottom:6px;">
        Campaña · ${escapeHtml(camp.nombre)}
      </div>
      <div style="font-size:12px;color:var(--text2);margin-bottom:14px;line-height:1.6;">
        Sigue estos 6 pasos en Meta Ads Manager para lanzar tu ad. Los datos críticos están listos para copiar.
      </div>

      ${stepBlock(1, 'Abrir Meta Ads Manager',
        `<button class="btn ghost" style="font-size:11px;padding:6px 12px;margin-top:4px;" onclick="openMetaAdsManager()">Abrir en navegador ↗</button>
         <div style="margin-top:6px;font-size:10px;color:var(--text3);">Login con tu cuenta de ${platLabel} si te lo pide.</div>`)}

      ${stepBlock(2, 'Crear campaña nueva',
        `Click el botón <strong>"+ Crear"</strong> arriba a la izquierda.<br>
         Selecciona objetivo: <strong>"Mensajes"</strong>.<br>
         Click <strong>Continuar</strong>.`)}

      ${stepBlock(3, 'Configurar conjunto de anuncios',
        `Define presupuesto, audiencia y ubicación.<br>
         En la sección <strong>"Destino del mensaje"</strong> selecciona: <strong>WhatsApp</strong>.`)}

      ${stepBlock(4, 'Conectar tu número WhatsApp',
        `En el campo <strong>"Número de WhatsApp Business"</strong> pega:
         <div style="display:flex;align-items:center;gap:8px;margin-top:8px;flex-wrap:wrap;">
           <code style="font-size:13px;color:var(--text);font-family:'Geist Mono',monospace;background:var(--card2);padding:6px 10px;border-radius:4px;border:1px solid var(--border);">${escapeHtml(waNumber)}</code>
           <button class="btn ghost" style="font-size:10px;padding:4px 10px;" onclick="_copyWizardWaNumber()">Copiar</button>
         </div>`)}

      ${stepBlock(5, 'Mensaje pre-llenado · CRÍTICO',
        `En el campo <strong>"Mensaje pre-llenado"</strong> pega EXACTO:
         <div style="display:flex;align-items:center;gap:8px;margin-top:8px;flex-wrap:wrap;">
           <code style="font-size:12px;color:var(--text);font-family:inherit;background:var(--card2);padding:8px 10px;border-radius:4px;border:1px solid var(--border);flex:1;min-width:200px;">${escapeHtml(camp.mensaje_trigger)}</code>
           <button class="btn ghost" style="font-size:10px;padding:4px 10px;" onclick="_copyWizardTrigger('${campaignId}')">Copiar</button>
         </div>
         <div style="margin-top:8px;padding:8px 10px;background:rgba(201,168,120,0.08);border:1px solid rgba(201,168,120,0.25);border-radius:4px;font-size:10px;color:var(--text2);line-height:1.5;">
           Si cambias una sola letra, ARIA no podrá atribuir los leads a esta campaña.
         </div>`)}

      ${stepBlock(6, 'Subir creatividad y publicar',
        `Sube tu video reel (15-30s recomendado), texto del ad y segmentación.<br>
         Revisa el preview y click <strong>"Publicar"</strong>.<br>
         <div style="margin-top:8px;font-size:10px;color:var(--text3);">Cuando lleguen leads vas a verlos en tiempo real en Publicidad y Agenda.</div>`)}
    `;
    showModal(`Lanzar campaña en Meta · paso a paso`, body, '<button class="btn ghost" onclick="closeModal()">Cerrar guía</button>');
  } catch(err){
    console.error('[openMetaWizard] error:', err);
    window.toast?.('Error', err.message || 'No se pudo abrir la guía', 'err');
  }
};

window._copyWizardWaNumber = function(){
  const c = window.currentClient || {};
  const num = c.wa_display_phone || c.whatsapp || '';
  if(!num){ window.toast?.('Sin número', 'Conecta WhatsApp en Settings', 'warn'); return; }
  navigator.clipboard.writeText(num.trim())
    .then(() => window.toast?.('Número copiado', 'Pégalo en el campo WhatsApp Business', 'success'))
    .catch(() => window.toast?.('No se pudo copiar', null, 'err'));
};

window._copyWizardTrigger = async function(campaignId){
  try {
    const camps = await sbGet('ad_campaigns', `id=eq.${campaignId}&select=mensaje_trigger`);
    const trigger = camps[0]?.mensaje_trigger || '';
    if(!trigger){ window.toast?.('Sin mensaje', null, 'warn'); return; }
    await navigator.clipboard.writeText(trigger);
    window.toast?.('Mensaje copiado', 'Pégalo en el campo Mensaje pre-llenado', 'success');
  } catch(err){
    window.toast?.('No se pudo copiar', err.message || '', 'err');
  }
};

window.deleteAdCampaign = async function(id, nombre){
  if(!confirm(`¿Eliminar campaña "${nombre}"?\nLas leads ya atribuidas se mantienen.`)) return;
  try {
    await sbDelete('ad_campaigns', id);
    window.toast?.('✓ Campaña eliminada', null, 'success');
    await window.loadPublicidad();
  } catch(err){
    window.toast?.('Error', err.message || 'No se pudo eliminar', 'err');
  }
};

window.showAdTemplate = function(idx){
  const t = _PUB_TEMPLATES[idx];
  if(!t) return;
  const c = window.currentClient || {};
  const empresa = c.empresa || c.responsable || 'tu negocio';
  const waNumber = c.wa_display_phone || c.whatsapp || '+52 — — —';
  const bodyText = t.body.replace(/\{empresa\}/g, empresa);

  // FIX v2.1.25 — usar índice en onclick en lugar de JSON.stringify(bodyText) inline.
  // El bug v2.1.24: el texto del template tenía comillas dobles ("Enviar mensaje"),
  // JSON.stringify devuelve `"...\"...\"..."`, al meterlo en onclick="..." rompía el
  // atributo HTML → "Unexpected end of input" en Sentry. La solución es pasar idx
  // y resolver el texto en runtime via _copyAdTemplateBody().
  const body = `
    <div style="font-size:11px;color:var(--text3);font-family:'Geist Mono',monospace;letter-spacing:0.5px;text-transform:uppercase;margin-bottom:10px;">
      ${t.icon} ${t.name}
    </div>
    <div style="font-size:11px;color:var(--text2);margin-bottom:6px;font-weight:500;">COPY DEL AD (cópialo y pégalo en Meta):</div>
    <div style="padding:14px;background:var(--card2);border:1px solid var(--border);border-radius:8px;font-size:12px;color:var(--text);line-height:1.6;white-space:pre-wrap;margin-bottom:12px;font-family:inherit;">${escapeHtml(bodyText)}</div>
    <button class="btn ghost" style="font-size:11px;padding:6px 12px;margin-bottom:14px;" onclick="_copyAdTemplateBody(${idx})">📋 Copiar copy</button>

    <div style="font-size:11px;color:var(--text2);margin-bottom:6px;font-weight:500;">SUGERENCIA VISUAL:</div>
    <div style="padding:10px 12px;background:var(--card2);border-radius:6px;font-size:11px;color:var(--text2);line-height:1.5;margin-bottom:14px;">${escapeHtml(t.visual)}</div>

    <div style="font-size:11px;color:var(--text2);margin-bottom:6px;font-weight:500;">CTA EN META:</div>
    <div style="padding:10px 12px;background:var(--aria-s);border:1px solid rgba(232,232,232,0.2);border-radius:6px;font-size:11px;color:var(--text);line-height:1.6;">
      Botón: <strong>"Enviar mensaje"</strong> (Click-to-WhatsApp)<br>
      Número: <code style="font-family:'Geist Mono',monospace;color:var(--accent);">${escapeHtml(waNumber)}</code><br>
      Mensaje pre-llenado: <em>"${escapeHtml(t.cta_message)}"</em>
    </div>
  `;
  showModal(`Template: ${t.name}`, body, '<button class="btn ghost" onclick="closeModal()">Cerrar</button>');
};

// Helper para copiar el body del template — evita inyectar JSON en HTML attribute
window._copyAdTemplateBody = function(idx){
  const t = _PUB_TEMPLATES[idx];
  if(!t) return;
  const c = window.currentClient || {};
  const empresa = c.empresa || c.responsable || 'tu negocio';
  const text = t.body.replace(/\{empresa\}/g, empresa);
  navigator.clipboard.writeText(text)
    .then(() => window.toast?.('✓ Copy copiado', 'Pégalo en tu ad de Meta', 'success'))
    .catch(() => window.toast?.('No se pudo copiar', 'Selecciona y copia manualmente', 'err'));
};

// Compat: por si quedó código viejo llamando loadROI / roiTab
window.loadROI = window.loadIngresosView;
window.roiTab = function(){ /* no-op v2.1.24 */ };

let _ingresosChart = null;

// v2.2.5 — `ingresosRange(days)` y `_ingresosRange` removidos.
// El selector 7d/30d/90d/365d nunca se mostró visualmente en la sección Ingresos.
// Los KPIs por método de pago ahora se sincronizan con el navegador del mes (chart).

async function loadIngresos(/* days arg legacy · ignorado en v2.2.5 */){
  const moneda = window.currentClient?.moneda || '$';
  const fmt = (cents) => moneda + ((cents || 0) / 100).toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  try {
    const now = new Date();
    const today   = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const weekStart = today - ((now.getDay() === 0 ? 6 : now.getDay() - 1) * 86400000); // lunes
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const yearStart = new Date(now.getFullYear(), 0, 1).getTime();
    const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime();
    const prevMonthEnd   = monthStart - 1;

    // v2.2.5 — single query · trae 1 año completo de pagos para todo
    // (eliminada `paid` query · era redundante con `allYear` para los métodos)
    const allYear = await sbGet('appointments',
      `client_id=eq.${window.CLIENT_ID}&pagado=eq.true&paid_at=gte.${new Date(yearStart - 365 * 86400000).toISOString()}&select=paid_at,neto_cents,precio_cents,metodo_pago,servicio&order=paid_at.asc`);

    // ── KPIs grandes (HOY/SEMANA/MES/YTD) · ventanas naturales · NO cambian con navegación de mes ──
    let sumHoy=0, sumSemana=0, sumMes=0, sumYear=0;
    let sumHoyPrev=0, sumSemanaPrev=0, sumMesPrev=0;
    allYear.forEach(a => {
      const t = new Date(a.paid_at).getTime();
      const cents = a.neto_cents || a.precio_cents || 0;
      if(t >= today) sumHoy += cents;
      else if(t >= today - 86400000) sumHoyPrev += cents;
      if(t >= weekStart) sumSemana += cents;
      else if(t >= weekStart - 7 * 86400000) sumSemanaPrev += cents;
      if(t >= monthStart) sumMes += cents;
      else if(t >= prevMonthStart && t <= prevMonthEnd) sumMesPrev += cents;
      if(t >= yearStart) sumYear += cents;
    });

    const setTxt = (id, val) => { const el = document.getElementById(id); if(el) el.textContent = val; };
    const setHtml = (id, val) => { const el = document.getElementById(id); if(el) el.innerHTML = val; };
    setTxt('ing-hoy', fmt(sumHoy));
    setTxt('ing-semana', fmt(sumSemana));
    setTxt('ing-mes', fmt(sumMes));
    setTxt('ing-year', fmt(sumYear));
    setHtml('ing-hoy-trend',    pctTrendInline(sumHoy, sumHoyPrev, 'vs ayer'));
    setHtml('ing-semana-trend', pctTrendInline(sumSemana, sumSemanaPrev, 'vs sem. pasada'));
    setHtml('ing-mes-trend',    pctTrendInline(sumMes, sumMesPrev, 'vs mes pasado'));

    // ── Chart cleanup ──
    if(_ingresosChart){ try { _ingresosChart.destroy?.(); } catch(_){} _ingresosChart = null; }

    // Build revenueByMonthDay + apptCountByMonthDay desde allYear
    // (también guardamos `allPaid` para que updateIngresosKpisByMethod() filtre por mes)
    const revenueByMonthDay = {};
    const apptCountByMonthDay = {};
    allYear.forEach(a => {
      const d = new Date(a.paid_at);
      const monthKey = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      const day = d.getDate();
      const cents = a.neto_cents || a.precio_cents || 0;
      if(!revenueByMonthDay[monthKey]) revenueByMonthDay[monthKey] = {};
      if(!apptCountByMonthDay[monthKey]) apptCountByMonthDay[monthKey] = {};
      revenueByMonthDay[monthKey][day] = (revenueByMonthDay[monthKey][day] || 0) + cents;
      apptCountByMonthDay[monthKey][day] = (apptCountByMonthDay[monthKey][day] || 0) + 1;
    });
    window._ingresosChartData = { revenueByMonthDay, apptCountByMonthDay, allPaid: allYear, monedaSym: moneda };

    // Render del mes actual al cargar (o el último seleccionado)
    const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
    window._ingresosSelectedMonth = window._ingresosSelectedMonth || currentMonthKey;
    if(typeof window.renderIngresosBarChart === 'function') {
      window.renderIngresosBarChart(window._ingresosSelectedMonth);
      // KPIs por método se actualizan automáticamente vía renderIngresosBarChart → updateIngresosKpisByMethod
    }

    window._ingresosLoaded = true;
  } catch(err) {
    console.error('[ingresos] error:', err);
  }
}

// v2.2.5 — KPIs por método de pago sincronizados con el mes del chart
// Antes: filtraban por últimos N días · ahora: filtran por mes seleccionado en navegador
window.updateIngresosKpisByMethod = function(monthKey){
  const data = window._ingresosChartData;
  if(!data || !Array.isArray(data.allPaid)) return;
  const moneda = data.monedaSym || '$';
  const fmt = (cents) => moneda + ((cents || 0) / 100).toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const setTxt = (id, val) => { const el = document.getElementById(id); if(el) el.textContent = val; };

  const [y, m] = monthKey.split('-').map(n => parseInt(n, 10));
  const monthStart = new Date(y, m - 1, 1).getTime();
  const monthEnd   = new Date(y, m, 1).getTime(); // primer día del siguiente mes (exclusivo)

  const monthPaid = data.allPaid.filter(a => {
    const t = new Date(a.paid_at).getTime();
    return t >= monthStart && t < monthEnd;
  });

  // Buckets · cash / card / transfer / other
  const methodAgg = { cash: {cents:0, count:0}, card: {cents:0, count:0}, transfer: {cents:0, count:0}, other: {cents:0, count:0} };
  monthPaid.forEach(a => {
    const raw = (a.metodo_pago || '').toLowerCase().trim();
    const cents = a.neto_cents || a.precio_cents || 0;
    let bucket;
    if(raw === 'efectivo' || raw === 'cash') bucket = 'cash';
    else if(raw === 'tarjeta' || raw === 'stripe' || raw === 'debito' || raw === 'débito' || raw === 'crédito' || raw === 'credito' || raw === 'card') bucket = 'card';
    else if(raw === 'transferencia' || raw === 'transfer' || raw === 'spei' || raw === 'wire') bucket = 'transfer';
    else bucket = 'other';
    methodAgg[bucket].cents += cents;
    methodAgg[bucket].count += 1;
  });
  const totalCents = methodAgg.cash.cents + methodAgg.card.cents + methodAgg.transfer.cents + methodAgg.other.cents;
  const fmtPct = (v) => totalCents > 0 ? Math.round((v / totalCents) * 100) + '%' : '0%';
  const fmtTrend = (b) => `${fmtPct(b.cents)} · ${b.count} pago${b.count === 1 ? '' : 's'}`;

  setTxt('ing-cash-val',       fmt(methodAgg.cash.cents));
  setTxt('ing-cash-trend',     fmtTrend(methodAgg.cash));
  setTxt('ing-card-val',       fmt(methodAgg.card.cents));
  setTxt('ing-card-trend',     fmtTrend(methodAgg.card));
  setTxt('ing-transfer-val',   fmt(methodAgg.transfer.cents));
  setTxt('ing-transfer-trend', fmtTrend(methodAgg.transfer));

  // Label dinámico que dice qué mes muestra
  const monthLabel = (typeof MONTHS_LONG_ES !== 'undefined' && MONTHS_LONG_ES[m - 1])
    ? `${MONTHS_LONG_ES[m - 1]} ${y}`
    : monthKey;
  const countTxt = monthPaid.length > 0
    ? `${monthPaid.length} pago${monthPaid.length === 1 ? '' : 's'} en ${monthLabel}`
    : `Sin pagos en ${monthLabel}`;
  setTxt('ing-metodos-count', countTxt);
};

// Helper: flecha + porcentaje de cambio
function pctTrendInline(curr, prev, label){
  if(prev === 0 && curr === 0) return `<span class="dim">—</span>`;
  if(prev === 0)                return `<span class="ok">↑ nuevo</span> <span class="dim">${label}</span>`;
  const delta = ((curr - prev) / prev * 100);
  const sign = delta >= 0 ? '↑' : '↓';
  const cls  = delta >= 0 ? 'ok' : 'danger';
  return `<span class="${cls}">${sign} ${Math.abs(delta).toFixed(0)}%</span> <span class="dim">${label}</span>`;
}

window.loadIngresos = loadIngresos;

// ============================================
// VIEW: AGENDA
// ============================================
// v2.1.16 — Estado de la vista Agenda (mes navegable + tab + filtro estado)
window._agendaState = {
  year: new Date().getFullYear(),
  month: new Date().getMonth(), // 0-11
  scope: 'proximas',            // 'proximas' | 'historicas' | 'todas'
  estado: 'todos',              // 'todos' | 'confirmed' | 'completed' | 'pagadas' | 'cancelled' | 'no_show'
};

window.prevMonth = function(){
  const s = window._agendaState;
  if(s.month === 0){ s.month = 11; s.year -= 1; } else { s.month -= 1; }
  window.loadAppointments();
};
window.nextMonth = function(){
  const s = window._agendaState;
  if(s.month === 11){ s.month = 0; s.year += 1; } else { s.month += 1; }
  window.loadAppointments();
};
window.goToCurrentMonth = function(){
  const now = new Date();
  window._agendaState.year = now.getFullYear();
  window._agendaState.month = now.getMonth();
  window.loadAppointments();
};
// v2.1.31 — botón refresh de Agenda (mismo patrón que Funnel/Ingresos)
let _agendaRefreshBusy = false;
window.refreshAgenda = async function(){
  if(_agendaRefreshBusy) return;
  const btn = document.getElementById('agenda-refresh-btn');
  _agendaRefreshBusy = true;
  if(btn){ btn.disabled = true; btn.style.opacity = '0.5'; btn.textContent = '…'; }
  try {
    await window.loadAppointments?.();
    window.toast?.('✓ Agenda actualizada', null, 'success');
  } catch(err){
    window.toast?.('Error', err.message || 'No se pudo refrescar', 'err');
  } finally {
    setTimeout(() => {
      _agendaRefreshBusy = false;
      if(btn){ btn.disabled = false; btn.style.opacity = ''; btn.textContent = '↻'; }
    }, 1200);
  }
};

window.setAgendaTab = function(scope){
  window._agendaState.scope = scope;
  document.querySelectorAll('[data-ascope]').forEach(b => b.classList.toggle('active', b.dataset.ascope === scope));
  window.loadAppointments();
};
window.setAgendaEstadoFilter = function(estado){
  window._agendaState.estado = estado;
  document.querySelectorAll('[data-aestado]').forEach(b => b.classList.toggle('active', b.dataset.aestado === estado));
  window.loadAppointments();
};

window.loadAppointments = async function(){
  try {
    const s = window._agendaState;
    const monthNames = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
    const monthLabel = `${monthNames[s.month]} ${s.year}`;
    document.getElementById('cal-month').textContent = monthLabel;

    // Rango del mes que se está visualizando (para llenar el calendario)
    const firstDay = new Date(s.year, s.month, 1);
    const lastDay  = new Date(s.year, s.month + 1, 0);
    const startOffset = firstDay.getDay();
    const monthStartIso = firstDay.toISOString().split('T')[0];
    const monthEndIso   = lastDay.toISOString().split('T')[0];

    // Trae citas del mes en pantalla (para calendario) + un buffer amplio para tabla
    // (la tabla puede mostrar próximas/históricas, no solo del mes actual)
    const apts = await sbGet('appointments',
      `client_id=eq.${window.CLIENT_ID}&select=${COLS_APPT}&order=fecha.desc,hora.desc&limit=1000`);

    // Calendar: solo del mes en visualización
    const now = new Date();
    const todayIso = now.toISOString().split('T')[0];
    const apptsByDate = {};
    apts.forEach(a => {
      if(a.fecha >= monthStartIso && a.fecha <= monthEndIso){
        (apptsByDate[a.fecha] = apptsByDate[a.fecha] || []).push(a);
      }
    });

    const grid = document.getElementById('cal-grid');
    grid.innerHTML = '';
    for(let i = 0; i < startOffset; i++) grid.innerHTML += '<div class="cal-cell" style="opacity:0.3"></div>';
    for(let d = 1; d <= lastDay.getDate(); d++){
      const date = `${s.year}-${String(s.month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const dayApts = apptsByDate[date] || [];
      const isToday = (date === todayIso);
      const apptHTML = dayApts.slice(0,2).map(a => `<div class="cal-appt">${a.hora?.slice(0,5)} ${escapeHtml(a.nombre||'').slice(0,12)}</div>`).join('');
      grid.innerHTML += `<div class="cal-cell ${dayApts.length?'has-appt':''} ${isToday?'today':''}" onclick="showDayAppts('${date}')"><div class="cal-day">${d}</div>${apptHTML}${dayApts.length > 2 ? `<div class="cal-appt">+${dayApts.length-2} más</div>`:''}</div>`;
    }

    // ─── Agenda KPIs + lista del día (alineado al mockup) ───
    try {
      const todayApts = apts.filter(a => a.fecha === todayIso && !['cancelled','no_show'].includes(a.estado));
      const todayConfirmed = todayApts.filter(a => a.estado === 'confirmed' || a.estado === 'completed').length;
      const todayPending = todayApts.filter(a => a.estado === 'pending').length;
      // Esta semana (lun-dom de la semana actual)
      const weekStart = new Date(now); weekStart.setDate(now.getDate() - ((now.getDay() + 6) % 7));
      const weekEnd   = new Date(weekStart); weekEnd.setDate(weekStart.getDate() + 6);
      const weekStartIso = weekStart.toISOString().split('T')[0];
      const weekEndIso   = weekEnd.toISOString().split('T')[0];
      const weekApts = apts.filter(a => a.fecha >= weekStartIso && a.fecha <= weekEndIso && !['cancelled','no_show'].includes(a.estado)).length;
      // Pendientes confirmar (futuras + pending)
      const pendingFuture = apts.filter(a => a.fecha >= todayIso && a.estado === 'pending').length;
      // No-show 30d
      const d30Iso = new Date(now - 30*864e5).toISOString().split('T')[0];
      const noshow30 = apts.filter(a => a.fecha >= d30Iso && a.estado === 'no_show').length;

      setSafeText('agenda-kpi-hoy', todayApts.length);
      setSafeText('agenda-kpi-hoy-sub', `${todayConfirmed} confirmadas${todayPending ? ' · ' + todayPending + ' pendientes' : ''}`);
      setSafeText('agenda-kpi-week', weekApts);
      setSafeText('agenda-kpi-week-sub', 'esta semana');
      setSafeText('agenda-kpi-pending', pendingFuture);
      setSafeText('agenda-kpi-noshow', noshow30);
      setSafeText('agenda-kpi-noshow-sub', noshow30 === 0 ? 'sin no-shows' : 'últimos 30 días');

      // Lista del día (panel derecho del calendario)
      const todayListEl = document.getElementById('agenda-today-list');
      const todayTitleEl = document.getElementById('agenda-today-title');
      const todaySubEl = document.getElementById('agenda-today-sub');
      if(todayListEl){
        const monthsShort = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
        if(todayTitleEl) todayTitleEl.textContent = `Hoy · ${now.getDate()} ${monthsShort[now.getMonth()]}`;
        if(todaySubEl) todaySubEl.textContent = todayApts.length === 0 ? 'sin citas' : `${todayApts.length} cita${todayApts.length === 1 ? '' : 's'}`;
        if(todayApts.length === 0){
          todayListEl.innerHTML = '<div class="agenda-today-empty" style="padding:18px;font-size:11px;color:var(--text3);text-align:center;">Sin citas para hoy</div>';
        } else {
          // Ordenar por hora ascendente
          const sorted = todayApts.slice().sort((a,b) => (a.hora || '').localeCompare(b.hora || ''));
          todayListEl.innerHTML = sorted.map(a => {
            const ariaIcon = a.created_via === 'aria' ? '🤖' : '📅';
            const stateChip = a.estado === 'confirmed' ? '<span class="chip-warn" style="background:var(--success-s);color:var(--success);font-size:9px;padding:2px 6px;border-radius:4px;font-family:Geist Mono,monospace;">CONF</span>'
              : a.estado === 'pending' ? '<span style="background:var(--warn-s);color:var(--warn);font-size:9px;padding:2px 6px;border-radius:4px;font-family:Geist Mono,monospace;">PEND</span>'
              : a.estado === 'completed' ? '<span style="background:var(--card3);color:var(--text2);font-size:9px;padding:2px 6px;border-radius:4px;font-family:Geist Mono,monospace;">DONE</span>'
              : '';
            return `<div class="agenda-today-item" onclick="showApptDetail('${a.id}')">
              <div class="icon">${ariaIcon}</div>
              <div class="info">
                <div class="title">${a.hora?.slice(0,5) || '—'} · ${escapeHtml(a.nombre || '—')}</div>
                <div class="meta">${escapeHtml(a.servicio || '—')}</div>
              </div>
              ${stateChip}
            </div>`;
          }).join('');
        }
      }
    } catch(kpiErr){
      console.warn('[Agenda KPIs] error:', kpiErr);
    }

    // FIX v2.1.31 — Filtros: aplicar estado primero. Si hay filtro de estado activo,
    // ignora el scope (para que "Canceladas" muestre TODAS las canceladas pasadas/futuras,
    // no solo las que cumplían el scope "Próximas"). Antes el filtro cancelled no aparecía
    // porque scope 'proximas' filtraba solo futuras y las cancelled quedaban excluidas.
    let filtered = apts.slice();
    const stateFilterActive = s.estado !== 'todos';

    if(s.estado === 'pagadas'){
      filtered = filtered.filter(a => a.pagado === true);
    } else if(stateFilterActive){
      filtered = filtered.filter(a => a.estado === s.estado);
    }

    if(!stateFilterActive){
      // Solo aplicar scope si NO hay filtro de estado activo
      // v2.1.36 — comparamos por YYYY-MM-DD (lexicográfico) usando el
      // "hoy" en tz del cliente, no del browser. Antes new Date(a.fecha)
      // se interpretaba como UTC midnight y shifteaba un día en tz LATAM.
      const todayYmd = window.todayInTZ().ymd;
      if(s.scope === 'proximas'){
        filtered = filtered.filter(a => (a.fecha && a.fecha >= todayYmd) || isOverduePendingAction(a));
        filtered.sort((a,b) => {
          const aOver = isOverduePendingAction(a);
          const bOver = isOverduePendingAction(b);
          if(aOver && !bOver) return -1;
          if(!aOver && bOver) return 1;
          const ta = _aptDatetimeMs(a), tb = _aptDatetimeMs(b);
          return aOver ? tb - ta : ta - tb;
        });
      } else if(s.scope === 'historicas'){
        filtered = filtered.filter(a => a.fecha && a.fecha < todayYmd);
        filtered.sort((a,b) => _aptDatetimeMs(b) - _aptDatetimeMs(a));
      } else {
        filtered.sort((a,b) => _aptDatetimeMs(b) - _aptDatetimeMs(a));
      }
    } else {
      // FIX v2.1.34 — Con filtro de estado activo, ordenar por updated_at DESC.
      // Esto coloca la última cancelada/no_show/pagada arriba (cuándo se hizo la acción),
      // no por la fecha de la cita programada. Resuelve la confusión cuando el cliente
      // cancela una cita y no la encuentra en el filtro porque está mezclada con
      // canceladas seedeadas viejas. Fallback a datetime de la cita si updated_at es null.
      const tsFor = (a) => {
        if(a.updated_at) return new Date(a.updated_at).getTime();
        if(a.paid_at)    return new Date(a.paid_at).getTime();
        if(a.confirmed_at) return new Date(a.confirmed_at).getTime();
        if(a.created_at) return new Date(a.created_at).getTime();
        return _aptDatetimeMs(a);
      };
      filtered.sort((a,b) => tsFor(b) - tsFor(a));
    }
    const totalMatch = filtered.length;
    filtered = filtered.slice(0, 100); // safety cap

    const titleMap = { proximas: 'Citas próximas', historicas: 'Citas históricas', todas: 'Todas las citas' };
    document.getElementById('appt-tbl-title').textContent = titleMap[s.scope] || 'Citas';
    document.getElementById('appt-tbl-sub').textContent =
      `${totalMatch} resultado${totalMatch === 1 ? '' : 's'} · filtro: ${s.estado === 'todos' ? 'todos los estados' : s.estado}`;

    const tbody = document.getElementById('appt-tbody');
    if(!tbody) return; // FIX v2.1.20 P4 — defensive guard
    if(filtered.length === 0){
      tbody.innerHTML = '<tr><td colspan="6" class="dim" style="text-align:center;padding:20px;">Sin citas para este filtro</td></tr>';
      return;
    }
    const moneda = window.currentClient?.moneda || 'USD';
    tbody.innerHTML = filtered.map(a => {
      let emailChip = '';
      if(a.email){
        if(a.estado === 'confirmed' && a.confirmed_at){
          emailChip = `<span class="email-chip confirmed">✓ CONFIRMADA POR EMAIL</span>`;
        } else if(a.confirmation_email_sent_at){
          emailChip = `<span class="email-chip sent">📧 EMAIL ENVIADO</span>`;
        }
      }
      const netoUSD = (a.neto_cents || a.precio_cents || 0) / 100;
      const pagoChip = a.pagado
        ? `<span class="chip chip-ok"><span class="chip-dot"></span>PAGADA · ${(a.metodo_pago||'').toUpperCase()}</span>`
        : `<button class="btn ghost" style="font-size:10px;padding:3px 8px;" onclick="event.stopPropagation();markAsPaid('${a.id}')">Marcar pagada</button>`;
      return `
        <tr style="cursor:pointer;" onclick="showApptDetail('${a.id}')">
          <td class="num">${window.fmtPlainDateTZ(a.fecha, {day:'2-digit', month:'short'})}</td>
          <td class="num">${a.hora?.slice(0,5) || '—'}</td>
          <td>${escapeHtml(a.nombre || '—')}<div style="margin-top:3px;">${emailChip}</div></td>
          <td class="dim">${escapeHtml(a.servicio || '—')}${netoUSD > 0 ? `<div class="num" style="font-size:10px;color:var(--success);">${moneda} ${netoUSD.toFixed(2)}</div>` : ''}</td>
          <td><span class="chip chip-${a.estado==='confirmed'?'ok':a.estado==='pending'?'warn':a.estado==='cancelled'||a.estado==='no_show'?'off':'off'}"><span class="chip-dot"></span>${a.estado||'—'}</span><div style="margin-top:4px;">${pagoChip}</div>${isOverduePendingAction(a) ? `<button class="btn danger" style="font-size:10px;padding:3px 8px;margin-top:4px;" onclick="event.stopPropagation();openOverdueModal('${a.id}')">⚠ No llegó / Cancelar</button>` : ''}</td>
          <td style="text-align:right;color:var(--text3);font-size:11px;">→</td>
        </tr>`;
    }).join('');
  } catch(err) {
    // FIX v2.1.20 P2 — error visible al usuario
    console.error('[Appts] error:', err);
    window.toast?.('Agenda no se pudo cargar', err.message || 'Error de conexión', 'err');
    window.electronAPI?.sentryCapture?.(err);
  }
};

// Helpers para detectar citas vencidas sin acción registrada
const _OVERDUE_GRACE_MS = 30 * 60 * 1000; // 30 minutos después de la hora de la cita
function _aptDatetimeMs(a){
  if(!a || !a.fecha) return 0;
  // v2.1.36 — usa wallTimeMs para interpretar fecha+hora en la tz del
  // cliente (no del browser). Antes una cita "10:00" se ordenaba por
  // 10:00 del browser, lo que rompía orden si el técnico revisaba
  // desde otra tz.
  return window.wallTimeMs(a.fecha, a.hora);
}
function isOverduePendingAction(a){
  if(!a || !a.fecha) return false;
  if(a.pagado === true) return false;
  if(['cancelled','no_show','completed'].includes(a.estado)) return false;
  const dt = _aptDatetimeMs(a);
  if(!dt) return false;
  return (Date.now() - dt) > _OVERDUE_GRACE_MS;
}

window.openOverdueModal = function(id){
  const body = `
    <div style="font-size:12px;color:var(--text2);margin-bottom:14px;line-height:1.5;">
      Esta cita ya pasó y no se marcó como pagada ni realizada. ¿Qué sucedió?
    </div>
    <div style="display:flex;flex-direction:column;gap:8px;">
      <button class="btn ghost" style="text-align:left;padding:10px 12px;" onclick="markOverdue('${id}','no_show')">
        <div style="font-size:13px;font-weight:500;">📵 No-show</div>
        <div style="font-size:10px;color:var(--text3);margin-top:3px;">El paciente no llegó a la cita</div>
      </button>
      <button class="btn ghost" style="text-align:left;padding:10px 12px;" onclick="markOverdue('${id}','cancelled')">
        <div style="font-size:13px;font-weight:500;">✕ Cancelada</div>
        <div style="font-size:10px;color:var(--text3);margin-top:3px;">La cita se canceló (por el paciente o por ti)</div>
      </button>
    </div>
    <div style="padding:10px;background:var(--danger-s);border-radius:6px;font-size:10px;color:var(--text3);margin-top:14px;line-height:1.5;">
      Ambas opciones registran la cita en el panel <strong style="color:var(--text2);">Fuga de citas</strong> del funnel para que ARIA detecte patrones.
    </div>
  `;
  showModal('Cita vencida sin registrar', body, '<button class="btn ghost" onclick="closeModal()">Cerrar</button>');
};

window.markOverdue = async function(id, estado){
  try {
    const label = estado === 'no_show' ? 'No-show' : 'Cancelada';
    await sbPatch('appointments', id, { estado });
    closeModal();
    window.toast(`✓ Cita marcada: ${label}`, 'Se sumará al panel de fuga del funnel', 'warn');
    // Realtime refresca agenda + funnel
  } catch(err){ window.toast('Error', err.message, 'err'); }
};

window.markAsPaid = async function(id){
  // Trae los datos de la cita para detectar descuento aplicado por campaña
  let appt = null;
  try {
    const rows = await sbGet('appointments', `id=eq.${id}&select=precio_cents,neto_cents,discount_percent,discount_code,discount_campaign_name`);
    appt = rows?.[0];
  } catch(_){}

  const moneda = window.currentClient?.moneda || 'USD';
  const monedaSym = { USD:'$', MXN:'$', DOP:'RD$', EUR:'€', COP:'$' }[moneda] || '$';
  const precio = (appt?.precio_cents || appt?.neto_cents || 0) / 100;
  const discountPct = appt?.discount_percent || 0;
  const sugerido = discountPct > 0 ? Math.round(precio * (1 - discountPct/100) * 100) / 100 : precio;

  const discountBlock = discountPct > 0 ? `
    <div style="padding:12px 14px;background:rgba(201,168,120,0.08);border:1px solid rgba(201,168,120,0.25);border-radius:8px;margin-bottom:12px;font-size:12px;color:var(--text2);line-height:1.55;">
      🎟 <strong style="color:var(--text);">Descuento aplicado · ${discountPct}%</strong>
      <div style="font-size:10px;color:var(--text3);font-family:'Geist Mono',monospace;letter-spacing:1px;margin-top:4px;">
        Código: ${escapeHtml(appt.discount_code || '—')}${appt.discount_campaign_name ? ' · Campaña: ' + escapeHtml(appt.discount_campaign_name) : ''}
      </div>
    </div>
  ` : '';

  const body = `
    ${discountBlock}
    <div class="field"><div class="field-label">MONTO COBRADO (${moneda})</div>
      <div style="display:flex;gap:10px;align-items:center;">
        <span style="color:var(--text2);font-size:14px;">${monedaSym}</span>
        <input type="number" class="field-input" id="pago-monto" min="0" step="0.01" value="${sugerido.toFixed(2)}" style="font-size:16px;font-family:'Geist Mono',monospace;font-weight:600;flex:1;">
      </div>
      ${precio > 0 ? `<div style="font-size:10px;color:var(--text3);margin-top:6px;">Precio del servicio: <strong style="color:var(--text2);">${monedaSym}${precio.toFixed(2)}</strong>${discountPct > 0 ? ` · con ${discountPct}% off → <strong style="color:var(--success);">${monedaSym}${sugerido.toFixed(2)}</strong>` : ''}</div>` : ''}
    </div>
    <div class="field"><div class="field-label">MÉTODO DE PAGO</div>
      <select class="field-select" id="pago-metodo">
        <option value="efectivo">💵 Efectivo</option>
        <option value="tarjeta">💳 Tarjeta</option>
        <option value="transferencia">🏦 Transferencia</option>
        <option value="otro">Otro</option>
      </select>
    </div>
    <div style="padding:10px 12px;background:var(--success-s);border-radius:6px;font-size:11px;color:var(--text2);line-height:1.5;">El ingreso se registra automáticamente en Ingresos · Brief · Funnel · CRM (LTV) · Campañas (atribuído).</div>
  `;
  showModal('Marcar cita como pagada', body, `<button class="btn ghost" onclick="closeModal()">Cancelar</button><button class="btn success" onclick="confirmMarkAsPaid('${id}')">Confirmar pago</button>`);
};

window.confirmMarkAsPaid = async function(id){
  const metodo = document.getElementById('pago-metodo').value;
  const montoInput = document.getElementById('pago-monto');
  const monto = parseFloat(montoInput?.value || '0');
  if(isNaN(monto) || monto < 0){
    window.toast('Monto inválido', 'Ingresa un monto válido', 'warn');
    return;
  }
  try {
    await sbPatch('appointments', id, {
      pagado: true,
      metodo_pago: metodo,
      neto_cents: Math.round(monto * 100),
      paid_at: new Date().toISOString(),
      estado: 'completed'
    });
    closeModal();
    window.toast('✓ Pago registrado', `${(window.currentClient?.moneda || 'USD')} ${monto.toFixed(2)} · ${metodo}`, 'success');
    // Realtime refresca
  } catch(err){ window.toast('Error', err.message, 'err'); }
};

window.showDayAppts = async function(date){
  const apts = await sbGet('appointments', `client_id=eq.${window.CLIENT_ID}&fecha=eq.${date}&select=${COLS_APPT}&order=hora.asc`);
  const moneda = window.currentClient?.moneda || 'USD';
  const monedaSym = { USD:'$', MXN:'$', DOP:'RD$', EUR:'€', COP:'$' }[moneda] || '$';
  const body = apts.length === 0
    ? '<div class="empty"><div class="empty-icon">·</div><div class="empty-title">Sin citas este día</div></div>'
    : apts.map(a => {
        const netoUSD = (a.neto_cents || a.precio_cents || 0) / 100;
        const estadoChip = `<span class="chip chip-${a.estado==='confirmed'?'ok':a.estado==='pending'?'warn':a.estado==='cancelled'||a.estado==='no_show'?'off':'ok'}" style="font-size:9px;"><span class="chip-dot"></span>${a.estado||'—'}</span>`;
        const pagoChip = a.pagado
          ? `<span class="chip chip-ok" style="font-size:9px;"><span class="chip-dot"></span>PAGADA · ${monedaSym}${netoUSD.toFixed(2)}</span>`
          : (netoUSD > 0 ? `<span class="chip chip-warn" style="font-size:9px;"><span class="chip-dot"></span>SIN PAGO · ${monedaSym}${netoUSD.toFixed(2)}</span>` : '');
        return `
          <div style="padding:12px;background:var(--card2);border-radius:6px;margin-bottom:8px;cursor:pointer;border:1px solid var(--border);" onclick="closeModal();showApptDetail('${a.id}')">
            <div style="display:flex;justify-content:space-between;align-items:start;gap:10px;">
              <div style="flex:1;min-width:0;">
                <div style="font-size:13px;font-weight:600;color:var(--text);">${escapeHtml(a.nombre || 'Sin nombre')}</div>
                <div style="font-size:11px;color:var(--text3);margin-top:3px;">${a.hora?.slice(0,5)} · ${escapeHtml(a.servicio || '—')}</div>
                <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;">${estadoChip}${pagoChip}</div>
              </div>
              <div style="color:var(--text3);font-size:12px;">→</div>
            </div>
          </div>`;
      }).join('');
  showModal(`Citas · ${window.fmtPlainDateTZ(date, {day:'numeric', month:'long', year:'numeric'})}`, body,
    `<button class="btn primary" onclick="closeModal();openNewAppt('${date}')">+ Agendar</button><button class="btn ghost" onclick="closeModal()">Cerrar</button>`);
};

// v2.1.16 · M1 — Detalle completo de cita con timeline
window.showApptDetail = async function(apptId){
  try {
    const apts = await sbGet('appointments', `id=eq.${apptId}&select=${COLS_APPT},reminded_24h_at,reminded_2h_at,confirmation_email_sent_at`);
    if(!apts.length){ window.toast('No encontrada', 'La cita no existe', 'warn'); return; }
    const a = apts[0];
    const moneda = window.currentClient?.moneda || 'USD';
    const monedaSym = { USD:'$', MXN:'$', DOP:'RD$', EUR:'€', COP:'$' }[moneda] || '$';
    const netoUSD = (a.neto_cents || a.precio_cents || 0) / 100;
    const fechaLabel = window.fmtPlainDateTZ(a.fecha, {day:'numeric', month:'long', year:'numeric'});

    // FIX v2.1.35 — usar created_via real (aria/manual/walk_in) en lugar de inferir por lead_id
    const isCancelled = a.estado === 'cancelled' || a.estado === 'no_show';
    const isCompleted = a.estado === 'completed';
    const wasConfirmed = !!a.confirmed_at; // antes de cancelar, ¿se llegó a confirmar?

    // v2.1.36 — wrappers locales que delegan en helpers globales (todos respetan currentClient.timezone)
    const fmtDateTime = (iso, opts = {day:'numeric', month:'short'}) => window.fmtDateTZ(iso, opts);
    const fmtTime = (iso) => window.fmtTimeTZ(iso);

    // Construir timeline (solo eventos relevantes según estado de la cita)
    const events = [];
    if(a.created_at){
      const sourceMeta = (() => {
        switch(a.created_via){
          case 'aria':    return { icon: '🤖', text: 'ARIA cerró la cita (lead → agendamiento)' };
          case 'walk_in': return { icon: '🚶', text: 'Cliente walk-in registrado en clínica' };
          case 'manual':
          default:        return { icon: '✋', text: 'Cita creada manualmente' };
        }
      })();
      events.push({ ts: a.created_at, icon: sourceMeta.icon, text: sourceMeta.text });
    }
    // Solo mostrar eventos de email/recordatorios si la cita NO fue cancelada antes
    // (si fue cancelled, esos emails ya no son relevantes y confunden al usuario)
    if(!isCancelled || wasConfirmed){
      if(a.confirmation_email_sent_at){
        events.push({ ts: a.confirmation_email_sent_at, icon: '📧', text: 'Email de confirmación enviado al cliente' });
      }
      if(a.confirmed_at){
        events.push({ ts: a.confirmed_at, icon: '✅', text: 'Cliente clickeó "Confirmar mi cita"' });
      }
      if(a.reminded_24h_at){
        events.push({ ts: a.reminded_24h_at, icon: '⏰', text: 'Recordatorio 24h enviado' });
      }
      if(a.reminded_2h_at){
        events.push({ ts: a.reminded_2h_at, icon: '🔔', text: 'Recordatorio 2h enviado' });
      }
    }
    if(a.notified_at && !isCancelled){
      events.push({ ts: a.notified_at, icon: '📲', text: 'Notificación enviada' });
    }
    // Eventos de estado final (usar updated_at como momento real del cambio si existe)
    if(isCompleted){
      events.push({ ts: a.updated_at || a.paid_at || a.confirmed_at || a.created_at, icon: '🟢', text: 'Estado → completed (cita atendida)' });
    } else if(a.estado === 'cancelled'){
      events.push({ ts: a.updated_at || a.created_at, icon: '🔴', text: 'Estado → cancelled' });
    } else if(a.estado === 'no_show'){
      events.push({ ts: a.updated_at || a.created_at, icon: '⚠️', text: 'Estado → no_show (no se presentó)' });
    }
    if(a.paid_at){
      events.push({
        ts: a.paid_at,
        icon: '💰',
        text: `Marcada pagada · ${monedaSym}${netoUSD.toFixed(2)}${a.metodo_pago ? ` (${a.metodo_pago})` : ''}`
      });
    }
    events.sort((x, y) => new Date(x.ts) - new Date(y.ts));

    // Render
    const estadoChip = `<span class="chip chip-${a.estado==='confirmed'?'ok':a.estado==='pending'?'warn':a.estado==='cancelled'||a.estado==='no_show'?'off':'ok'}"><span class="chip-dot"></span>${(a.estado||'—').toUpperCase()}</span>`;

    // FIX v2.1.35 — pagoLabel + confirmadaLabel respetan estado:
    // - Cancelled/no_show: NO muestra "$X pendiente" (no aplica) NI "esperando confirmación"
    // - Solo muestra info de pago/email si tiene sentido
    let pagoLabel = '';
    if(a.pagado){
      pagoLabel = `<div style="font-size:13px;color:var(--success);font-weight:500;">💰 Pagada ${monedaSym}${netoUSD.toFixed(2)}${a.metodo_pago ? ` (${a.metodo_pago})` : ''} — ${fmtDateTime(a.paid_at)}</div>`;
    } else if(isCancelled){
      pagoLabel = `<div style="font-size:13px;color:var(--text3);">${a.estado === 'no_show' ? '⚠ No se presentó · sin cobro' : '✕ Cancelada · sin cobro'}</div>`;
    } else if(netoUSD > 0){
      pagoLabel = `<div style="font-size:13px;color:var(--warn);">⚠ Sin pago registrado · ${monedaSym}${netoUSD.toFixed(2)} pendiente</div>`;
    }

    let confirmadaLabel = '';
    if(a.confirmed_at){
      confirmadaLabel = `<div style="font-size:12px;color:var(--success);">✅ Confirmada por email — ${fmtDateTime(a.confirmed_at)} ${fmtTime(a.confirmed_at)}</div>`;
    } else if(a.confirmation_email_sent_at && !isCancelled){
      confirmadaLabel = `<div style="font-size:12px;color:var(--text3);">📧 Email enviado · esperando confirmación</div>`;
    }

    const timelineHtml = events.length === 0
      ? '<div class="dim" style="text-align:center;padding:14px;">Sin eventos registrados</div>'
      : events.map(e => {
          // FIX v2.1.35 — usa timezone del cliente para mostrar fecha/hora consistente
          const dateLbl = fmtDateTime(e.ts);
          const timeLbl = fmtTime(e.ts);
          return `
            <div style="display:flex;gap:10px;padding:8px 0;border-bottom:1px dashed var(--border);">
              <div style="font-size:14px;width:22px;text-align:center;">${e.icon}</div>
              <div style="flex:1;min-width:0;">
                <div style="font-size:12px;color:var(--text);">${escapeHtml(e.text)}</div>
                <div style="font-size:10px;color:var(--text3);font-family:'Geist Mono',monospace;margin-top:2px;letter-spacing:0.5px;">${dateLbl} · ${timeLbl}</div>
              </div>
            </div>`;
        }).join('');

    const body = `
      <div style="padding-bottom:14px;border-bottom:1px solid var(--border);margin-bottom:14px;">
        <div style="font-size:13px;color:var(--text2);margin-bottom:6px;">${fechaLabel} · ${a.hora?.slice(0,5) || '—'} · ${escapeHtml(a.servicio || '—')}</div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px;">
          ${estadoChip}
          ${a.created_via === 'aria' ? '<span class="chip chip-aria"><span class="chip-dot"></span>POR ARIA</span>' : (a.created_via === 'walk_in' ? '<span class="chip"><span class="chip-dot"></span>WALK-IN</span>' : '<span class="chip"><span class="chip-dot"></span>MANUAL</span>')}
        </div>
        ${pagoLabel}
        ${confirmadaLabel}
        <div style="font-size:11px;color:var(--text3);margin-top:8px;">
          ${a.email ? `📧 ${escapeHtml(a.email)} · ` : ''}${a.whatsapp ? `📱 ${escapeHtml(a.whatsapp)}` : ''}
        </div>
      </div>
      <div style="font-size:11px;color:var(--text3);font-family:'Geist Mono',monospace;letter-spacing:0.5px;text-transform:uppercase;margin-bottom:8px;">Timeline</div>
      ${timelineHtml}
    `;
    showModal(`Cita · ${escapeHtml(a.nombre || 'Sin nombre')}`, body, '<button class="btn ghost" onclick="closeModal()">Cerrar</button>');
  } catch(err){
    console.error('[ApptDetail] error:', err);
    window.toast('Error', err.message || 'No se pudo cargar el detalle', 'err');
  }
};

// v2.1.16 · M3 — Historial de pagos en tab Ingresos + export CSV
window._lastHistorialPagos = []; // cache para export

window.loadHistorialPagos = async function(){
  try {
    const fromEl = document.getElementById('hp-from');
    const toEl   = document.getElementById('hp-to');
    if(!fromEl || !toEl) return;
    // Defaults: primer día del mes actual → hoy (v2.1.36: en tz del cliente)
    const _t = window.todayInTZ();
    if(!fromEl.value){
      fromEl.value = `${_t.y}-${String(_t.m).padStart(2,'0')}-01`;
    }
    if(!toEl.value){
      toEl.value = _t.ymd;
    }
    const from = fromEl.value;
    const to   = toEl.value;
    if(from > to){
      window.toast('Rango inválido', '"Desde" debe ser anterior a "Hasta"', 'warn');
      return;
    }
    const fromIso = `${from}T00:00:00`;
    const toIso   = `${to}T23:59:59`;
    const apts = await sbGet('appointments',
      `client_id=eq.${window.CLIENT_ID}&pagado=eq.true&paid_at=gte.${fromIso}&paid_at=lte.${toIso}&select=id,fecha,nombre,servicio,paid_at,neto_cents,precio_cents,metodo_pago,estado&order=paid_at.desc&limit=1000`);

    window._lastHistorialPagos = apts;
    const moneda = window.currentClient?.moneda || 'USD';
    const monedaSym = { USD:'$', MXN:'$', DOP:'RD$', EUR:'€', COP:'$' }[moneda] || '$';
    const totalCents = apts.reduce((s,a) => s + (a.neto_cents || a.precio_cents || 0), 0);
    const totalLbl = (totalCents / 100).toLocaleString('en', { minimumFractionDigits: 2 });

    document.getElementById('hp-count').textContent =
      `${apts.length} pago${apts.length === 1 ? '' : 's'} · total ${monedaSym}${totalLbl}`;

    const tbody = document.getElementById('hp-tbody');
    if(!tbody) return; // FIX v2.1.20 P4 — defensive guard
    if(apts.length === 0){
      tbody.innerHTML = '<tr><td colspan="6" class="dim" style="text-align:center;padding:20px;">Sin pagos en este rango</td></tr>';
      return;
    }
    tbody.innerHTML = apts.map(a => {
      const monto = (a.neto_cents || a.precio_cents || 0) / 100;
      const fecha = window.fmtDateTZ(a.paid_at, {day:'2-digit', month:'short', year:'numeric'});
      return `
        <tr style="cursor:pointer;" onclick="showApptDetail('${a.id}')">
          <td class="num">${fecha}</td>
          <td>${escapeHtml(a.nombre || '—')}</td>
          <td class="dim">${escapeHtml(a.servicio || '—')}</td>
          <td class="num" style="color:var(--success);">${monedaSym}${monto.toLocaleString('en',{minimumFractionDigits:2})}</td>
          <td>${escapeHtml((a.metodo_pago || '—').toUpperCase())}</td>
          <td><span class="chip chip-${a.estado==='completed'?'ok':a.estado==='confirmed'?'ok':'warn'}" style="font-size:9px;"><span class="chip-dot"></span>${a.estado||'—'}</span></td>
        </tr>`;
    }).join('');
  } catch(err){
    console.error('[Historial] error:', err);
    window.toast('Error', err.message || 'No se pudo cargar el historial', 'err');
  }
};

// v2.1.17 · Export PDF branded (jsPDF + AutoTable)
window.exportHistorialPDF = function(){
  const apts = window._lastHistorialPagos || [];
  if(apts.length === 0){
    window.toast('Sin datos', 'Aplica un rango primero o no hay pagos en este rango', 'warn');
    return;
  }
  if(typeof window.jspdf === 'undefined' || typeof window.jspdf.jsPDF === 'undefined'){
    window.toast('PDF no disponible', 'Librería jsPDF no cargada. Reintenta.', 'err');
    return;
  }
  try {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });

    // Colores Dominio (paleta light para PDF — fondo blanco)
    const C_TEXT      = [20, 20, 20];      // casi negro
    const C_TEXT_DIM  = [120, 120, 120];   // gris medio
    const C_TEXT_FAINT= [180, 180, 180];   // gris claro
    const C_ACCENT    = [12, 12, 12];      // dark accent (rectángulo header)
    const C_SUCCESS   = [50, 150, 95];     // verde para totales/montos
    const C_BORDER    = [220, 220, 220];   // bordes table

    const PAGE_W = doc.internal.pageSize.getWidth();
    const PAGE_H = doc.internal.pageSize.getHeight();
    const M = 15; // margen 15mm

    // Cliente + rango
    const c = window.currentClient || {};
    const empresa = c.empresa || c.responsable || 'Mi Negocio';
    const moneda = c.moneda || 'USD';
    const monedaSym = { USD:'$', MXN:'$', DOP:'RD$', EUR:'€', COP:'$' }[moneda] || '$';
    const fromIso = document.getElementById('hp-from')?.value || '';
    const toIso   = document.getElementById('hp-to')?.value || '';
    // v2.1.36 — fechas del rango (input type=date, formato YYYY-MM-DD) en tz del cliente
    const fmtDate = (iso) => iso ? window.fmtPlainDateTZ(iso, {day:'2-digit', month:'short', year:'numeric'}) : '—';

    // ──────── HEADER (logo text) ────────
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(15);
    doc.setTextColor(...C_TEXT);
    doc.text('Dominio System', M, M + 4);

    doc.setFont('courier', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...C_TEXT_DIM);
    doc.text('automation plattform', M, M + 9);

    // Título a la derecha
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(...C_TEXT);
    doc.text('HISTORIAL DE PAGOS', PAGE_W - M, M + 4, { align: 'right' });
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...C_TEXT_DIM);
    // FIX v2.1.18: usar ASCII hyphen en lugar de '→' (U+2192 NO está en WinAnsi 1252
    // que es el encoding default de jsPDF con fuentes core → se renderizaba como "!'")
    doc.text(`${fmtDate(fromIso)} - ${fmtDate(toIso)}`, PAGE_W - M, M + 9, { align: 'right' });

    // Línea separadora
    doc.setDrawColor(...C_BORDER);
    doc.setLineWidth(0.3);
    doc.line(M, M + 13, PAGE_W - M, M + 13);

    // ──────── INFO CLIENTE ────────
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(11);
    doc.setTextColor(...C_TEXT);
    doc.text(empresa, M, M + 22);
    doc.setFontSize(9);
    doc.setTextColor(...C_TEXT_DIM);
    if(c.industria) doc.text(c.industria, M, M + 27);

    // ──────── RESUMEN ────────
    const totalCents = apts.reduce((s, a) => s + (a.neto_cents || a.precio_cents || 0), 0);
    const totalLbl = (totalCents / 100).toLocaleString('en', { minimumFractionDigits: 2 });
    const metodos = {};
    apts.forEach(a => { const m = (a.metodo_pago || 'sin_metodo'); metodos[m] = (metodos[m] || 0) + 1; });
    const metodosLbl = Object.entries(metodos).map(([m,n]) => `${m}(${n})`).join(' · ');

    let y = M + 38;
    doc.setFont('courier', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...C_TEXT_FAINT);
    doc.text('RESUMEN', M, y);
    y += 6;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(...C_TEXT_DIM);
    doc.text('Total cobrado:', M, y);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...C_SUCCESS);
    doc.text(`${monedaSym}${totalLbl} ${moneda}`, M + 35, y);
    y += 5;
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...C_TEXT_DIM);
    doc.text('Pagos:', M, y);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...C_TEXT);
    doc.text(String(apts.length), M + 35, y);
    y += 5;
    if(metodosLbl){
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(...C_TEXT_DIM);
      doc.text('Métodos:', M, y);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(...C_TEXT);
      doc.text(metodosLbl, M + 35, y);
      y += 5;
    }

    // ──────── TABLA (autoTable) ────────
    y += 4;
    const rows = apts.map(a => {
      const monto = ((a.neto_cents || a.precio_cents || 0) / 100).toFixed(2);
      return [
        window.fmtDateTZ(a.paid_at, {day:'2-digit', month:'short'}),
        a.nombre || '—',
        a.servicio || '—',
        `${monedaSym}${parseFloat(monto).toLocaleString('en',{minimumFractionDigits:2})}`,
        (a.metodo_pago || '—').toUpperCase(),
        (a.estado || '—'),
      ];
    });
    // FIX v2.1.19: header de Monto incluye código moneda actual del cliente
    // (auto-adapta si cambia de MXN→USD/EUR/etc, sin hardcoding)
    doc.autoTable({
      startY: y,
      head: [['Fecha pago', 'Cliente', 'Servicio', `Monto (${moneda})`, 'Método', 'Estado']],
      body: rows,
      theme: 'grid',
      styles: {
        font: 'helvetica',
        fontSize: 9,
        cellPadding: 2.5,
        textColor: C_TEXT,
        lineColor: C_BORDER,
        lineWidth: 0.2,
      },
      headStyles: {
        fillColor: C_ACCENT,
        textColor: [255, 255, 255],
        fontStyle: 'bold',
        fontSize: 8,
        halign: 'left',
      },
      columnStyles: {
        0: { cellWidth: 22 },              // Fecha
        1: { cellWidth: 36 },              // Cliente
        2: { cellWidth: 'auto' },          // Servicio
        3: { cellWidth: 24, halign: 'right', textColor: C_SUCCESS, fontStyle: 'bold' }, // Monto
        // FIX v2.1.18: Método 22→30mm para que entre "TRANSFERENCIA" (13 chars). Estado 20→18mm.
        4: { cellWidth: 30, fontSize: 8 }, // Método
        5: { cellWidth: 18, fontSize: 8 }, // Estado
      },
      alternateRowStyles: { fillColor: [248, 248, 248] },
      margin: { left: M, right: M },
      didDrawPage: (data) => {
        // FOOTER en cada página
        doc.setFont('courier', 'normal');
        doc.setFontSize(7);
        doc.setTextColor(...C_TEXT_FAINT);
        const today = window.fmtDateTZ(new Date(), { day:'2-digit', month:'short', year:'numeric' });
        doc.text(`Generado por Dominio System · ${today} · dominiosystem.com`, M, PAGE_H - 8);
        const pageNum = doc.internal.getNumberOfPages();
        doc.text(`Página ${data.pageNumber} de ${pageNum}`, PAGE_W - M, PAGE_H - 8, { align: 'right' });
      },
    });

    // Descarga (diálogo nativo "Guardar como…")
    // FIX v2.1.19: filename incluye rango → cada rango = filename único, no colisiona
    const filename = `dominio-pagos_${fromIso || 'todo'}_a_${toIso || 'hoy'}.pdf`;
    doc.save(filename);
    window.toast('✓ PDF descargado', `${apts.length} pagos · ${filename}`, 'success');
  } catch(err){
    console.error('[ExportPDF] error:', err);
    window.toast('No se pudo generar el PDF', err.message || 'Error', 'err');
    window.electronAPI?.sentryCapture?.(err);
  }
};

window.exportHistorialCSV = function(){
  const apts = window._lastHistorialPagos || [];
  if(apts.length === 0){
    window.toast('Sin datos', 'Aplica un rango primero o no hay pagos en este rango', 'warn');
    return;
  }
  const moneda = window.currentClient?.moneda || 'USD';
  const escapeCsv = (v) => {
    if(v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const headers = ['Fecha pago','Cliente','Servicio','Monto','Moneda','Metodo pago','Estado','ID'];
  const rows = apts.map(a => {
    const monto = ((a.neto_cents || a.precio_cents || 0) / 100).toFixed(2);
    return [
      new Date(a.paid_at).toISOString().split('T')[0],
      a.nombre || '',
      a.servicio || '',
      monto,
      moneda,
      a.metodo_pago || '',
      a.estado || '',
      a.id || ''
    ].map(escapeCsv).join(',');
  });
  const csv = '﻿' + headers.join(',') + '\n' + rows.join('\n'); // UTF-8 BOM para Excel
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  // FIX v2.1.19: filename incluye rango → no colisiona entre exports diferentes
  const fromVal = document.getElementById('hp-from')?.value || 'todo';
  const toVal   = document.getElementById('hp-to')?.value   || 'hoy';
  const filename = `dominio-pagos_${fromVal}_a_${toVal}.csv`;
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  window.toast('✓ CSV descargado', `${apts.length} pagos · ${filename}`, 'success');
};

window.openNewAppt = async function(defaultDate, prefill){
  // v2.1.47 — prefill opcional cuando se viene desde un lead:
  //   { nombre, whatsapp, email, lead_id }
  // El lead_id se guarda en window._pendingLeadId para que saveAppt lo use.
  window._pendingLeadId = prefill?.lead_id || null;

  // Asegurarse de tener servicios cargados
  if(window.CLIENT_SERVICES.length === 0){
    try { window.CLIENT_SERVICES = await sbGet('services', `client_id=eq.${window.CLIENT_ID}&activo=eq.true&select=*&order=orden.asc`); } catch(e){}
  }
  // v2.1.36 — fecha "hoy" en tz del cliente, no del browser
  const today = defaultDate || window.todayInTZ().ymd;
  const moneda = window.currentClient?.moneda || 'USD';
  const svcOptions = window.CLIENT_SERVICES
    .filter(s => s.activo)
    .map(s => `<option value="${s.id}" data-precio="${s.precio_cents}" data-duracion="${s.duracion_min}">${escapeHtml(s.nombre)} — ${moneda} ${(s.precio_cents/100).toFixed(2)} · ${s.duracion_min}min</option>`)
    .join('');

  const noServices = window.CLIENT_SERVICES.length === 0;

  const body = `
    <div class="field"><div class="field-label">NOMBRE</div><input class="field-input" id="appt-name" placeholder="Nombre del cliente"></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
      <div class="field"><div class="field-label">WHATSAPP</div><input class="field-input" id="appt-wa" placeholder="+52..."></div>
      <div class="field"><div class="field-label">EMAIL <span style="color:var(--success);">(recomendado)</span></div><input class="field-input" id="appt-email" type="email" placeholder="cliente@email.com"></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
      <div class="field"><div class="field-label">FECHA</div><input class="field-input" id="appt-date" type="date" value="${today}"></div>
      <div class="field">
        <div class="field-label">HORA</div>
        <!-- v2.1.40 — picker custom AM/PM. El valor real (HH:MM 24h) se construye en getApptTime() -->
        <div style="display:flex;gap:6px;align-items:stretch;">
          <select class="field-select" id="appt-hour-12" style="flex:1;min-width:60px;">
            ${Array.from({length:12}, (_,i) => {
              const h = i + 1;
              return `<option value="${h}" ${h===10?'selected':''}>${h}</option>`;
            }).join('')}
          </select>
          <span style="display:flex;align-items:center;color:var(--text3);font-weight:600;">:</span>
          <select class="field-select" id="appt-minute" style="flex:1;min-width:60px;">
            ${['00','05','10','15','20','25','30','35','40','45','50','55'].map(m =>
              `<option value="${m}" ${m==='00'?'selected':''}>${m}</option>`
            ).join('')}
          </select>
          <select class="field-select" id="appt-ampm" style="flex:1;min-width:60px;">
            <option value="AM" selected>AM</option>
            <option value="PM">PM</option>
          </select>
        </div>
      </div>
    </div>
    ${noServices
      ? `<div class="field" style="padding:12px;background:var(--warn-s);border:1px solid rgba(201,168,120,0.2);border-radius:6px;font-size:11px;color:var(--text2);line-height:1.5;">
           ⚠ No tienes servicios configurados. <a onclick="closeModal();go('settings');setTab('servicios')" style="color:var(--accent);cursor:pointer;text-decoration:underline;">Configurar servicios</a> primero.
         </div>`
      : `<div class="field"><div class="field-label">SERVICIO</div><select class="field-select" id="appt-service-id" onchange="onServiceChange()">${svcOptions}</select></div>`
    }
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
      <div class="field"><div class="field-label">PRECIO (${moneda})</div><input class="field-input" id="appt-precio" type="number" step="0.01" min="0"></div>
      <div class="field"><div class="field-label">DESCUENTO (%)</div><input class="field-input" id="appt-descuento" type="number" value="0" min="0" max="100" oninput="updateNeto()"></div>
    </div>
    <div class="field" style="padding:10px;background:var(--card2);border-radius:6px;font-size:12px;display:flex;justify-content:space-between;">
      <span class="dim">Total a cobrar:</span>
      <strong id="appt-neto-preview" style="color:var(--success);font-family:'Geist Mono',monospace;">—</strong>
    </div>
    <div class="field"><div class="field-label">NOTAS</div><textarea class="field-textarea" id="appt-notes"></textarea></div>
    <div class="field" style="display:flex;align-items:center;gap:10px;padding:10px;background:var(--card2);border-radius:6px;">
      <label class="switch"><input type="checkbox" id="appt-send-email" checked><span class="slider"></span></label>
      <div style="flex:1;">
        <div style="font-size:12px;">Enviar email de confirmación</div>
        <div class="dim" style="font-size:10px;">El cliente recibe link para confirmar. Queda pending hasta que confirme.</div>
      </div>
    </div>
  `;
  showModal('Nueva cita', body, '<button class="btn ghost" onclick="closeModal()">Cancelar</button><button class="btn primary" onclick="saveAppt()">Agendar</button>');

  // Trigger pre-fill del primer servicio
  if(!noServices) setTimeout(() => onServiceChange(), 50);

  // v2.1.47 — si se llamó desde un lead, pre-llenar nombre/wa/email
  if(prefill){
    setTimeout(() => {
      const nameEl  = document.getElementById('appt-name');
      const waEl    = document.getElementById('appt-wa');
      const emailEl = document.getElementById('appt-email');
      if(nameEl  && prefill.nombre)   nameEl.value  = prefill.nombre;
      if(waEl    && prefill.whatsapp) waEl.value    = prefill.whatsapp;
      if(emailEl && prefill.email)    emailEl.value = prefill.email;
    }, 60);
  }
};

window.onServiceChange = function(){
  const sel = document.getElementById('appt-service-id');
  if(!sel) return;
  const opt = sel.options[sel.selectedIndex];
  const precio = parseInt(opt.dataset.precio) / 100;
  document.getElementById('appt-precio').value = precio.toFixed(2);
  updateNeto();
};

window.updateNeto = function(){
  const precio = parseFloat(document.getElementById('appt-precio')?.value || 0);
  const desc = parseFloat(document.getElementById('appt-descuento')?.value || 0);
  const neto = precio * (1 - desc / 100);
  const moneda = window.currentClient?.moneda || 'USD';
  const preview = document.getElementById('appt-neto-preview');
  if(preview) preview.textContent = `${moneda} ${neto.toFixed(2)}`;
};

// v2.1.40 — picker custom AM/PM → string HH:MM 24h (formato Postgres time)
window._readApptTime12 = function(){
  const h12 = parseInt(document.getElementById('appt-hour-12')?.value || '10', 10);
  const m   = String(document.getElementById('appt-minute')?.value || '00').padStart(2,'0');
  const ap  = document.getElementById('appt-ampm')?.value || 'AM';
  let h24 = h12 % 12; // 12 AM → 0, 1 AM → 1, ..., 12 PM → 12
  if(ap === 'PM') h24 += 12;
  return String(h24).padStart(2,'0') + ':' + m;
};

window.saveAppt = async function(){
  const email = document.getElementById('appt-email').value.trim();
  const sendEmail = document.getElementById('appt-send-email').checked && email;
  const serviceIdEl = document.getElementById('appt-service-id');
  const serviceId = serviceIdEl?.value || null;
  const service = window.CLIENT_SERVICES.find(s => s.id === serviceId);
  const precioInput = parseFloat(document.getElementById('appt-precio')?.value || 0);
  const descuento = parseFloat(document.getElementById('appt-descuento')?.value || 0);

  const nombreVal = document.getElementById('appt-name').value.trim();
  const waVal     = document.getElementById('appt-wa').value.trim();

  // v2.1.47 — auto-crear lead si la cita no viene pre-vinculada a uno.
  // Reglas:
  //  · Si window._pendingLeadId está set (vino desde botón "Agendar cita" del lead) → usar ese.
  //  · Si NO está set Y hay whatsapp, buscar lead existente con ese whatsapp.
  //  · Si tampoco existe → crear lead nuevo con fuente='manual', subtipo Walk-in.
  let leadId = window._pendingLeadId || null;
  if(!leadId && waVal){
    try {
      const existing = await sbGet('leads',
        `client_id=eq.${window.CLIENT_ID}&whatsapp=eq.${encodeURIComponent(waVal)}&select=id&limit=1`);
      if(existing.length) leadId = existing[0].id;
    } catch(_){}
  }
  if(!leadId && (waVal || email)){
    try {
      const [newLead] = await sbInsert('leads', {
        client_id: window.CLIENT_ID,
        nombre: nombreVal || null,
        whatsapp: waVal || null,
        email: email || null,
        fuente: 'walk_in',
        status: 'cita_agendada',
        notas: 'Lead auto-creado al agendar cita manual',
      });
      leadId = newLead?.id || null;
    } catch(e){
      // No bloqueamos la creación de la cita si falla la creación del lead
      console.warn('[saveAppt] auto-crear lead falló:', e?.message);
    }
  }

  // Nota: confirmation_token se autogenera en DB (DEFAULT gen_random_uuid).
  // El estado inicial es siempre 'pending' si vamos a pedir confirmación por email;
  // el workflow DS2-07 (cron 1min) lee notified_at=null y envía el email con botón.
  // Cuando el paciente hace click → confirm-appointment edge function hace UPDATE a 'confirmed'.
  const payload = {
    client_id: window.CLIENT_ID,
    service_id: serviceId,
    lead_id: leadId,                       // v2.1.47 — vínculo lead↔cita
    nombre: nombreVal,
    whatsapp: waVal,
    email: email || null,
    fecha: document.getElementById('appt-date').value,
    hora: window._readApptTime12(),
    servicio: service?.nombre || null,
    precio_cents: Math.round(precioInput * 100),
    descuento_pct: descuento,
    notas: document.getElementById('appt-notes').value,
    estado: sendEmail ? 'pending' : 'confirmed',
    // FIX v2.1.35 — diferenciar fuente real. UI cliente = manual.
    // ARIA workflows DS2-* setean 'aria' al insertar desde n8n.
    created_via: 'manual'
  };
  try {
    const [created] = await sbInsert('appointments', payload);
    closeModal();
    window._pendingLeadId = null; // limpiar prefill

    if(sendEmail){
      window.toast(
        '📧 Email enviándose',
        `A ${email} — el paciente recibirá un botón para confirmar. Mientras, la cita queda pendiente.`,
        'success'
      );
    } else {
      window.toast('✓ Cita confirmada manualmente', `${payload.nombre} · ${payload.fecha}`, 'success');
    }
  } catch(err){
    window.toast('Error', err.message, 'err');
  }
};

// DEPRECATED en Sprint FIX · ya no se usa
// El envío del email ahora lo maneja el cron DS2-07 en n8n que corre cada minuto:
// busca appointments con notified_at IS NULL y dispara el email con botón Confirmar.
// Esto elimina la dependencia del webhook n8n por-cliente y centraliza el envío.

// ============================================
// VIEW: LEADS CON SCORE
// ============================================
let _leadsRange = 30;
let _leadsRefreshBusy = false;

window.leadsRange = function(days){
  _leadsRange = days;
  document.querySelectorAll('.ingresos-range-btn[data-lrange]').forEach(b =>
    b.classList.toggle('active', Number(b.dataset.lrange) === days));
  const labels = { 7: 'últimos 7 días', 30: 'últimos 30 días', 90: 'últimos 90 días', 365: 'año en curso' };
  const el = document.getElementById('leads-range-label');
  if(el) el.textContent = labels[days] || 'periodo seleccionado';
  loadLeads();
};

window.refreshLeads = async function(){
  if(_leadsRefreshBusy) return;
  const btn = document.getElementById('leads-refresh-btn');
  _leadsRefreshBusy = true;
  if(btn){ btn.disabled = true; btn.style.opacity = '0.5'; btn.textContent = '…'; }
  try {
    await loadLeads();
    window.toast && window.toast('✓ Leads actualizados', null, 'success');
  } catch(err){
    window.toast && window.toast('Error', err.message || 'No se pudo refrescar', 'err');
  } finally {
    setTimeout(() => {
      _leadsRefreshBusy = false;
      if(btn){ btn.disabled = false; btn.style.opacity = ''; btn.textContent = '↻'; }
    }, 1200);
  }
};

// v2.1.47 — Leads rediseñado: cache local + filtro fuente + búsqueda por nombre.
// El fetch trae todos los leads del rango y los filtros se aplican client-side
// sobre el cache para evitar refetches.
let _leadsCache  = [];
let _leadsFilter = 'all';   // 'all' | 'aria' | 'manual'
let _leadsSearch = '';      // texto de búsqueda en lowercase

// Decide si un lead es "ARIA" o "Manual" basado en la columna `fuente`.
// Los leads con fuente 'manual' o 'walk_in' son humanos, el resto se atribuyen a ARIA.
function _leadKind(l){
  const f = (l.fuente || '').toLowerCase();
  if(f === 'manual' || f === 'walk_in') return 'manual';
  return 'aria';
}

// Etiqueta visible de fuente con detalle de campaña si aplica
function _leadFuenteLabel(l){
  const kind = _leadKind(l);
  if(kind === 'manual'){
    const sub = (l.fuente === 'walk_in') ? 'Walk-in' : 'Manual';
    return `<div style="font-size:11px;color:var(--text);">✋ Manual</div>
            <div class="dim" style="font-size:10px;">${escapeHtml(sub)}</div>`;
  }
  // ARIA — si vino de campaña pagada, mostrar plataforma + campaña
  const utm = (l.utm_source || '').toLowerCase();
  if(utm === 'instagram' || utm === 'facebook'){
    const platIcon = utm === 'instagram' ? '📷' : '📘';
    const platLabel = utm === 'instagram' ? 'Instagram' : 'Facebook';
    const camp = l.utm_campaign ? ` · "${escapeHtml(String(l.utm_campaign).slice(0,28))}"` : '';
    return `<div style="font-size:11px;color:var(--text);">🤖 ARIA</div>
            <div class="dim" style="font-size:10px;">${platIcon} ${platLabel}${camp}</div>`;
  }
  // ARIA orgánico (WhatsApp directo, Google, referido, etc.)
  const sub = l.fuente ? String(l.fuente).replace(/_/g, ' ') : 'WhatsApp';
  return `<div style="font-size:11px;color:var(--text);">🤖 ARIA</div>
          <div class="dim" style="font-size:10px;">${escapeHtml(sub)}</div>`;
}

async function loadLeads(){
  try {
    const days = _leadsRange || 30;
    const startIso = new Date(Date.now() - days * 86400000).toISOString();
    _leadsCache = await sbGet('leads',
      `client_id=eq.${window.CLIENT_ID}&created_at=gte.${startIso}&select=${COLS_LEAD}&order=created_at.desc`);
    _renderLeads();
  } catch(err){
    console.error('[Leads] error:', err);
    window.toast?.('Leads no se pudo cargar', err.message || 'Error de conexión', 'err');
    window.electronAPI?.sentryCapture?.(err);
  }
}

// Score → tier (HOT/WARM/COLD) calculado de intent_score (0-100)
function _leadTier(score){
  if(typeof score !== 'number' || score < 0) return null;
  if(score >= 80) return { tier: 'HOT',  cls: 'score-hot',  color: 'var(--danger)' };
  if(score >= 50) return { tier: 'WARM', cls: 'score-warm', color: 'var(--warn)' };
  return                  { tier: 'COLD', cls: 'score-cold', color: '#8a9aa8' };
}

// Render aplica filtros + búsqueda sobre el cache (no toca DB)
function _renderLeads(){
  const tbody = document.getElementById('leads-tbody');
  if(!tbody) return;

  let list = _leadsCache;

  // KPI counts (sobre cache completo, NO filtrado, para que el KPI total siempre refleje el rango)
  const totalLeads = _leadsCache.length;
  let hotCount = 0, warmCount = 0, coldCount = 0;
  let ariaCount = 0, manualCount = 0;
  _leadsCache.forEach(l => {
    const t = _leadTier(l.intent_score);
    if(t?.tier === 'HOT') hotCount++;
    else if(t?.tier === 'WARM') warmCount++;
    else if(t?.tier === 'COLD') coldCount++;
    if(_leadKind(l) === 'aria') ariaCount++;
    else if(_leadKind(l) === 'manual') manualCount++;
  });
  setSafeText('leads-kpi-total', totalLeads);
  setSafeText('leads-kpi-hot', hotCount);
  setSafeText('leads-kpi-warm', warmCount);
  setSafeText('leads-kpi-cold', coldCount);
  // Total subtitle: cuántos tienen score
  const scored = totalLeads - (totalLeads - hotCount - warmCount - coldCount);
  setSafeText('leads-kpi-total-sub', scored > 0 ? scored + ' con score' : 'sin score aún');
  // KPI range label sync
  const days = _leadsRange || 30;
  const rangeLabel = days === 365 ? 'YTD' : (days + 'D');
  setSafeText('leads-kpi-range-label', rangeLabel);
  // Source filter chip counts (alineado al mockup: "🤖 ARIA (134)", "✋ Manual (46)")
  const ariaCountEl = document.getElementById('leads-count-aria');
  const manualCountEl = document.getElementById('leads-count-manual');
  if(ariaCountEl) ariaCountEl.textContent = ariaCount > 0 ? `(${ariaCount})` : '';
  if(manualCountEl) manualCountEl.textContent = manualCount > 0 ? `(${manualCount})` : '';

  // Filtro fuente
  if(_leadsFilter === 'aria')   list = list.filter(l => _leadKind(l) === 'aria');
  if(_leadsFilter === 'manual') list = list.filter(l => _leadKind(l) === 'manual');

  // Búsqueda por nombre (case-insensitive, accent-insensitive simple)
  if(_leadsSearch){
    const q = _leadsSearch;
    list = list.filter(l => (l.nombre || '').toLowerCase().includes(q));
  }

  // Ordenar por intent_score descendente (HOT arriba)
  list = list.slice().sort((a, b) => (b.intent_score ?? -1) - (a.intent_score ?? -1));

  if(list.length === 0){
    tbody.innerHTML = `<tr><td colspan="6" class="dim" style="text-align:center;padding:20px;">${
      _leadsCache.length === 0 ? 'No hay leads en este periodo' : 'Ningún lead coincide con los filtros'
    }</td></tr>`;
    return;
  }

  tbody.innerHTML = list.map(l => {
    const tel = l.whatsapp || '';
    const mail = l.email || '';
    const hasTel = !!tel;
    const hasMail = !!mail;

    // Score pill (HOT/WARM/COLD + número)
    const t = _leadTier(l.intent_score);
    const scoreCell = t
      ? `<span class="score-pill ${t.cls}">${t.tier} ${l.intent_score}</span>`
      : '<span class="dim" style="font-size:10px;">—</span>';

    // v2.1.50 — 4 botones de acción: WhatsApp · Email · Agendar · Eliminar
    const btnWa = hasTel
      ? `<button class="btn ghost" style="font-size:11px;padding:4px 6px;min-width:28px;" onclick="leadAction('wa','${l.id}')" title="Enviar WhatsApp">📨</button>`
      : `<button class="btn ghost" style="font-size:11px;padding:4px 6px;min-width:28px;opacity:0.35;cursor:not-allowed;" disabled title="Sin teléfono">📨</button>`;
    const btnMail = hasMail
      ? `<button class="btn ghost" style="font-size:11px;padding:4px 6px;min-width:28px;" onclick="leadAction('mail','${l.id}')" title="Enviar email">✉</button>`
      : `<button class="btn ghost" style="font-size:11px;padding:4px 6px;min-width:28px;opacity:0.35;cursor:not-allowed;" disabled title="Sin email">✉</button>`;
    const btnAppt   = `<button class="btn primary" style="font-size:11px;padding:4px 6px;min-width:28px;" onclick="leadAction('appt','${l.id}')" title="Agendar cita">📅</button>`;
    const btnDelete = `<button class="btn ghost" style="font-size:11px;padding:4px 6px;min-width:28px;color:var(--danger);" onclick="leadAction('delete','${l.id}')" title="Eliminar lead">🗑</button>`;

    return `
      <tr>
        <td>${scoreCell}</td>
        <td><strong>${escapeHtml(l.nombre || '—')}</strong></td>
        <td class="num dim">${escapeHtml(tel || '—')}</td>
        <td class="dim" style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${
          hasMail
            ? escapeHtml(mail)
            : '<span style="color:var(--text3);">—</span>'
        }</td>
        <td>${_leadFuenteLabel(l)}</td>
        <td><div style="display:flex;gap:4px;flex-wrap:wrap;">${btnWa}${btnMail}${btnAppt}${btnDelete}</div></td>
      </tr>`;
  }).join('');
}

window.loadLeads = loadLeads;

// Filtro de fuente
window.leadsFilter = function(kind){
  _leadsFilter = kind;
  document.querySelectorAll('[data-lfilter]').forEach(b =>
    b.classList.toggle('active', b.dataset.lfilter === kind));
  _renderLeads();
};

// Búsqueda por nombre (debounce ligero)
let _leadsSearchTimer = null;
window.leadsSearch = function(text){
  clearTimeout(_leadsSearchTimer);
  _leadsSearchTimer = setTimeout(() => {
    _leadsSearch = (text || '').toLowerCase().trim();
    _renderLeads();
  }, 150);
};

// Acciones por fila: WhatsApp, Email, Agendar
window.leadAction = function(type, leadId){
  const lead = _leadsCache.find(l => l.id === leadId);
  if(!lead){ window.toast?.('Lead no encontrado', null, 'warn'); return; }

  if(type === 'wa'){
    if(!lead.whatsapp){ return; }
    // v2.1.48 — abrir el chat DENTRO del dashboard (sección ARIA → Conversaciones).
    // Si encuentra una conversación con ese teléfono → la abre.
    // Si no existe → mensaje informativo en lugar de saltar a wa.me externo.
    _openLeadInAriaChat(lead).catch(e => {
      console.warn('[leadAction] openInAriaChat error:', e?.message);
      window.toast?.('No se pudo abrir el chat', 'Verifica que ARIA esté conectada en la sección ARIA', 'warn');
    });
    return;
  }

  if(type === 'mail'){
    if(!lead.email){ return; }
    const subject = `Hola ${lead.nombre || ''}`;
    const body = `Hola ${lead.nombre || ''},\n\nTe escribimos de ${window.currentClient?.empresa || 'la clínica'}.\n\n`;
    const url = `mailto:${lead.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    if(window.electronAPI?.openExternal) window.electronAPI.openExternal(url);
    else window.open(url, '_blank');
    return;
  }

  if(type === 'appt'){
    // Abre el modal Nueva cita pre-rellenado con datos del lead
    if(typeof window.openNewAppt === 'function'){
      window.openNewAppt(undefined, {
        nombre:   lead.nombre || '',
        whatsapp: lead.whatsapp || '',
        email:    lead.email || '',
        lead_id:  lead.id,
      });
    }
    return;
  }

  if(type === 'delete'){
    // v2.1.50 — confirmar antes de borrar (FK ON DELETE SET NULL: no destruye citas/conv)
    const body = `
      <div style="padding:12px 14px;background:var(--card2);border-radius:8px;margin-bottom:12px;font-size:12px;line-height:1.5;">
        <div style="color:var(--danger);font-weight:600;margin-bottom:6px;">⚠ Eliminar lead</div>
        <div style="color:var(--text);"><strong>${escapeHtml(lead.nombre || '—')}</strong></div>
        <div class="dim" style="font-size:11px;margin-top:4px;">${escapeHtml(lead.whatsapp || '—')}</div>
        ${lead.email ? `<div class="dim" style="font-size:11px;">${escapeHtml(lead.email)}</div>` : ''}
      </div>
      <div style="font-size:12px;color:var(--text2);line-height:1.6;">
        Esta acción <strong>no borra</strong> citas ni conversaciones de WhatsApp asociadas, solo las desvincula del lead.<br><br>
        ¿Confirmas?
      </div>
    `;
    showModal('Eliminar lead', body,
      `<button class="btn ghost" onclick="closeModal()">Cancelar</button>` +
      `<button class="btn danger" onclick="_confirmDeleteLead('${lead.id}')">Eliminar permanentemente</button>`
    );
    return;
  }
};

// v2.1.50 — Borrado real del lead
window._confirmDeleteLead = async function(leadId){
  const lead = _leadsCache.find(l => l.id === leadId);
  try {
    await sbDelete('leads', leadId);
    closeModal();
    // Quitar del cache local + re-render para feedback inmediato
    _leadsCache = _leadsCache.filter(l => l.id !== leadId);
    _renderLeads();
    window.toast('✓ Lead eliminado', lead?.nombre || 'Lead borrado de la lista', 'success');
  } catch(err){
    console.error('[deleteLead] error:', err);
    window.toast('Error', err.message || 'No se pudo eliminar el lead', 'err');
  }
};

// v2.1.49 — Abrir chat del lead DENTRO del dashboard. Si no existe conversación,
// se CREA una nueva en aria_conversations y se abre con un input vacío para que
// el dueño escriba el primer mensaje (template o regular según ventana de 24h).
async function _openLeadInAriaChat(lead){
  const rawPhone = String(lead.whatsapp || '').replace(/\D/g, '');
  if(!rawPhone) {
    window.toast?.('Sin teléfono', 'Este lead no tiene número de WhatsApp', 'warn');
    return;
  }

  // Buscar conversación existente por teléfono. Probamos con y sin '+'.
  const phoneVariants = [rawPhone, '+' + rawPhone];
  let conv = null;
  for(const ph of phoneVariants){
    try {
      const res = await sbGet('aria_conversations',
        `client_id=eq.${window.CLIENT_ID}&deleted_at=is.null&phone=eq.${encodeURIComponent(ph)}&select=id&limit=1`);
      if(res.length){ conv = res[0]; break; }
    } catch(_){}
  }

  // Si no existe, crear nueva conversación
  let createdNew = false;
  if(!conv){
    try {
      const phoneStored = '+' + rawPhone; // formato internacional E.164
      const inserted = await sbInsert('aria_conversations', {
        client_id: window.CLIENT_ID,
        lead_id: lead.id || null,
        phone: phoneStored,
        nombre_contacto: lead.nombre || null,
        status: 'active',
        source: 'manual_dashboard',
      });
      conv = inserted[0];
      createdNew = true;
    } catch(err){
      console.error('[openLeadInAriaChat] crear conv:', err);
      window.toast?.('No se pudo iniciar el chat', err.message || 'Error al crear conversación', 'err');
      return;
    }
  }

  // Navegar a sección ARIA + tab Conversaciones
  if(typeof window.go === 'function') window.go('aria');
  if(typeof window.ariaTab === 'function'){
    setTimeout(() => window.ariaTab('conv'), 80);
  }

  // Refrescar la lista de conversaciones para que la recién creada
  // esté en ARIA_SECTION.conversations (que openConversation usa para buscar).
  setTimeout(async () => {
    try {
      if(typeof window.loadConversations === 'function') await window.loadConversations();
    } catch(_){}
    if(typeof window.openConversation === 'function'){
      window.openConversation(conv.id);
    }
    if(createdNew){
      window.toast?.(
        '✓ Chat iniciado',
        `Conversación creada con ${lead.nombre || rawPhone}. El primer mensaje fuera de la ventana de 24h debe ser un template aprobado por Meta.`,
        'aria'
      );
    }
  }, 300);
}

// v2.1.47 — Modal "+ Nuevo lead manual"
window.openNewLeadModal = function(){
  const body = `
    <div class="field"><div class="field-label">NOMBRE *</div>
      <input class="field-input" id="newlead-name" placeholder="Nombre completo">
    </div>
    <div class="field"><div class="field-label">WHATSAPP *</div>
      <input class="field-input" id="newlead-wa" placeholder="+52...">
    </div>
    <div class="field"><div class="field-label">EMAIL <span style="color:var(--text3);">(recomendado)</span></div>
      <input class="field-input" id="newlead-email" type="email" placeholder="cliente@email.com">
    </div>
    <div class="field"><div class="field-label">¿CÓMO LLEGÓ?</div>
      <select class="field-select" id="newlead-fuente">
        <option value="walk_in" selected>🚶 Walk-in (entró al local)</option>
        <option value="referido">👥 Referido</option>
        <option value="manual">✋ Otro</option>
      </select>
    </div>
    <div class="field"><div class="field-label">NOTAS</div>
      <textarea class="field-textarea" id="newlead-notes" placeholder="Servicio que le interesa, presupuesto, etc."></textarea>
    </div>
  `;
  showModal('Nuevo lead manual', body,
    '<button class="btn ghost" onclick="closeModal()">Cancelar</button>' +
    '<button class="btn primary" onclick="saveNewLead()">Guardar</button>');
};

window.saveNewLead = async function(){
  const nombre  = document.getElementById('newlead-name')?.value?.trim() || '';
  const wa      = document.getElementById('newlead-wa')?.value?.trim() || '';
  const email   = document.getElementById('newlead-email')?.value?.trim() || '';
  const fuente  = document.getElementById('newlead-fuente')?.value || 'manual';
  const notas   = document.getElementById('newlead-notes')?.value?.trim() || '';

  if(!nombre || nombre.length < 2){
    window.toast('Falta el nombre', 'Mínimo 2 caracteres', 'warn');
    return;
  }
  if(!wa || wa.length < 6){
    window.toast('Falta WhatsApp', 'Es obligatorio para que ARIA pueda contactar', 'warn');
    return;
  }

  // v2.1.50 — pre-check de duplicado por (client_id, whatsapp).
  // El constraint leads_client_whatsapp_uniq impide duplicados a nivel DB; acá
  // damos un mensaje claro al usuario en vez de un error Postgres genérico.
  let existing = null;
  try {
    const found = await sbGet('leads',
      `client_id=eq.${window.CLIENT_ID}&whatsapp=eq.${encodeURIComponent(wa)}&select=id,nombre,email,fuente,notas&limit=1`);
    if(found.length) existing = found[0];
  } catch(_){}

  if(existing){
    // Cerrar el modal actual y abrir uno de "lead duplicado" con 2 opciones:
    //   1) Actualizar el lead existente (PATCH email/notas/fuente si hay datos nuevos)
    //   2) Cancelar
    closeModal();
    const detail = `
      <div style="padding:12px 14px;background:var(--card2);border-radius:8px;margin-bottom:12px;font-size:12px;line-height:1.5;">
        <div style="color:var(--warn);font-weight:600;margin-bottom:6px;">⚠ Ya existe un lead con ese teléfono</div>
        <div style="color:var(--text);"><strong>${escapeHtml(existing.nombre || '—')}</strong></div>
        <div class="dim" style="font-size:11px;margin-top:4px;">${escapeHtml(wa)}</div>
        ${existing.email ? `<div class="dim" style="font-size:11px;">${escapeHtml(existing.email)}</div>` : ''}
      </div>
      <div style="font-size:12px;color:var(--text2);line-height:1.5;">
        ¿Qué quieres hacer?
      </div>
    `;
    showModal('Lead duplicado', detail,
      `<button class="btn ghost" onclick="closeModal()">Cancelar</button>` +
      `<button class="btn primary" onclick="_updateExistingLead('${existing.id}', ${JSON.stringify(email).replace(/"/g, '&quot;')}, ${JSON.stringify(notas).replace(/"/g, '&quot;')}, ${JSON.stringify(fuente).replace(/"/g, '&quot;')})">Actualizar lead existente</button>`
    );
    return;
  }

  try {
    await sbInsert('leads', {
      client_id: window.CLIENT_ID,
      nombre,
      whatsapp: wa,
      email: email || null,
      fuente,
      status: 'nuevo',
      estado_crm: 'activo',
      notas: notas || null,
    });
    closeModal();
    window.toast('✓ Lead creado', `${nombre} agregado a la lista`, 'success');
    if(typeof window.loadLeads === 'function') window.loadLeads();
  } catch(err){
    console.error('[saveNewLead] error:', err);
    // Fallback por si el pre-check no detectó (race condition con otro insert)
    const msg = (err.message || '').toLowerCase();
    if(msg.includes('duplicate key') || msg.includes('leads_client_whatsapp_uniq')){
      window.toast('Lead duplicado', 'Ya existe un lead con ese teléfono', 'warn');
    } else {
      window.toast('Error', err.message || 'No se pudo crear el lead', 'err');
    }
  }
};

// v2.1.50 — Actualizar lead existente (sin duplicar)
window._updateExistingLead = async function(leadId, newEmail, newNotas, newFuente){
  try {
    const patch = {};
    if(newEmail) patch.email = newEmail;
    if(newNotas) patch.notas = newNotas;
    if(newFuente && newFuente !== 'manual') patch.fuente = newFuente; // no sobrescribir si era 'manual' default
    if(Object.keys(patch).length === 0){
      closeModal();
      window.toast('Sin cambios', 'No hay datos nuevos para actualizar', 'aria');
      return;
    }
    await sbPatch('leads', leadId, patch);
    closeModal();
    window.toast('✓ Lead actualizado', 'Se aplicaron los cambios al lead existente', 'success');
    if(typeof window.loadLeads === 'function') window.loadLeads();
  } catch(err){
    console.error('[_updateExistingLead] error:', err);
    window.toast('Error', err.message || 'No se pudo actualizar', 'err');
  }
};

function calculateScore(lead){
  let score = 30;
  if(lead.status === 'cita_agendada') score += 40;
  if(lead.status === 'contactado') score += 20;
  if(lead.visitas > 3) score += 15;
  if(lead.visitas > 1) score += 10;
  if(lead.notas?.includes('plan')) score += 5;
  return Math.min(100, score);
}

// ============================================
// VIEW: CRM
// ============================================
let _crmRange = 90; // 0 = todos
let _crmRefreshBusy = false;

window.crmRange = function(days){
  _crmRange = days;
  document.querySelectorAll('.ingresos-range-btn[data-crange]').forEach(b =>
    b.classList.toggle('active', Number(b.dataset.crange) === days));
  const labels = {
    0: 'todos los clientes',
    30: 'visitaron en los últimos 30 días',
    90: 'visitaron en los últimos 90 días',
    180: 'visitaron en los últimos 6 meses',
    365: 'visitaron este año',
  };
  const el = document.getElementById('crm-range-label');
  if(el) el.textContent = labels[days] || 'periodo seleccionado';
  loadCRM();
};

window.refreshCRM = async function(){
  if(_crmRefreshBusy) return;
  const btn = document.getElementById('crm-refresh-btn');
  _crmRefreshBusy = true;
  if(btn){ btn.disabled = true; btn.style.opacity = '0.5'; btn.textContent = '…'; }
  try {
    await loadCRM();
    window.toast && window.toast('✓ CRM actualizado', null, 'success');
  } catch(err){
    window.toast && window.toast('Error', err.message || 'No se pudo refrescar', 'err');
  } finally {
    setTimeout(() => {
      _crmRefreshBusy = false;
      if(btn){ btn.disabled = false; btn.style.opacity = ''; btn.textContent = '↻'; }
    }, 1200);
  }
};

// CRM cache + búsqueda local (alineado al patrón de Leads)
let _crmCache = [];
let _crmSearch = '';

window.crmSearch = function(q){
  _crmSearch = (q || '').toLowerCase().trim();
  _renderCRM();
};

// Stub para botón "+ Cliente" — usa el modal de nuevo lead con preset de status=cliente
window.openNewClientModal = function(){
  if(typeof window.openNewLeadModal === 'function'){
    window.openNewLeadModal();
  } else {
    window.toast?.('Próximamente', 'Modal de nuevo cliente', 'info');
  }
};

async function loadCRM(){
  try {
    const days = _crmRange;
    let query = `client_id=eq.${window.CLIENT_ID}&status=eq.cliente&select=${COLS_LEAD}&order=ultima_visita.desc.nullslast`;
    if(days && days > 0){
      const fromDate = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
      query += `&ultima_visita=gte.${fromDate}`;
    }
    // Trae también ALL paid appointments para computar LTV por cliente
    // (sin filtro de fecha — LTV es lifetime, no del rango seleccionado)
    const [leads, paidApts] = await Promise.all([
      sbGet('leads', query),
      sbGet('appointments', `client_id=eq.${window.CLIENT_ID}&pagado=eq.true&select=lead_id,neto_cents,precio_cents&limit=2000`)
    ]);

    // Aggregar LTV por lead_id
    const ltvByLead = {};
    paidApts.forEach(a => {
      if(!a.lead_id) return;
      const cents = a.neto_cents || a.precio_cents || 0;
      ltvByLead[a.lead_id] = (ltvByLead[a.lead_id] || 0) + cents;
    });

    // Anotar LTV en cada lead
    _crmCache = leads.map(l => ({
      ...l,
      _ltv_cents: ltvByLead[l.id] || 0
    }));

    _renderCRM();
  } catch(err){
    console.error('[CRM] error:', err);
    window.toast?.('CRM no se pudo cargar', err.message || 'Error de conexión', 'err');
    window.electronAPI?.sentryCapture?.(err);
  }
}

function _renderCRM(){
  const tbody = document.getElementById('crm-tbody');
  if(!tbody) return;

  const moneda = window.currentClient?.moneda || 'USD';
  const monedaSym = { USD:'$', MXN:'$', DOP:'RD$', EUR:'€', COP:'$' }[moneda] || '$';
  const now = Date.now();

  // KPIs (sobre cache completo, no filtrado por search)
  let activeCount = 0, vipCount = 0, inactiveCount = 0, ltvSumCents = 0, ltvCount = 0;
  _crmCache.forEach(l => {
    activeCount++;
    const visitas = l.visitas || 0;
    if(visitas >= 5) vipCount++;
    // Inactivo 90d = última visita > 90 días
    if(l.ultima_visita){
      const days = (now - new Date(l.ultima_visita).getTime()) / 86400000;
      if(days > 90) inactiveCount++;
    } else {
      inactiveCount++; // sin visita registrada también cuenta como inactivo
    }
    if(l._ltv_cents > 0){
      ltvSumCents += l._ltv_cents;
      ltvCount++;
    }
  });
  const ltvAvgCents = ltvCount > 0 ? Math.round(ltvSumCents / ltvCount) : 0;
  setSafeText('crm-kpi-active', activeCount);
  setSafeText('crm-kpi-active-sub', activeCount > 0 ? `${activeCount - inactiveCount} en últimos 90d` : '—');
  setSafeText('crm-kpi-vip', vipCount);
  setSafeText('crm-kpi-inactive', inactiveCount);
  setSafeText('crm-kpi-ltv', ltvAvgCents > 0 ? monedaSym + (ltvAvgCents / 100).toLocaleString('en', { maximumFractionDigits: 0 }) : '—');

  // Filtro de búsqueda
  let list = _crmCache;
  if(_crmSearch){
    list = list.filter(l =>
      (l.nombre || '').toLowerCase().includes(_crmSearch) ||
      (l.whatsapp || '').toLowerCase().includes(_crmSearch)
    );
  }

  if(list.length === 0){
    tbody.innerHTML = `<tr><td colspan="7" class="dim" style="text-align:center;padding:20px;">${
      _crmCache.length === 0 ? 'No hay clientes en este periodo' : 'Ningún cliente coincide con la búsqueda'
    }</td></tr>`;
    return;
  }

  tbody.innerHTML = list.map(l => {
    const visitas = l.visitas || 0;
    const ltv = l._ltv_cents > 0 ? monedaSym + (l._ltv_cents/100).toLocaleString('en', { maximumFractionDigits: 0 }) : '—';
    // Estado segmentado
    let estadoChip;
    const daysSinceVisit = l.ultima_visita ? Math.floor((now - new Date(l.ultima_visita).getTime()) / 86400000) : null;
    if(visitas >= 5){
      estadoChip = '<span class="chip chip-ok"><span class="chip-dot"></span>VIP</span>';
    } else if(daysSinceVisit !== null && daysSinceVisit > 90){
      estadoChip = '<span class="chip chip-warn"><span class="chip-dot"></span>Reactivar</span>';
    } else if(visitas === 0){
      estadoChip = '<span class="chip chip-info"><span class="chip-dot"></span>Nueva</span>';
    } else {
      estadoChip = '<span class="chip chip-ok"><span class="chip-dot"></span>Activo</span>';
    }

    return `
      <tr>
        <td><strong>${escapeHtml(l.nombre || '—')}</strong><div class="dim" style="font-size:10px;">${escapeHtml(l.whatsapp || '')}</div></td>
        <td class="num dim">${l.ultima_visita ? window.fmtPlainDateTZ(l.ultima_visita) : '—'}</td>
        <td class="num dim">${l.proxima_cita ? window.fmtPlainDateTZ(l.proxima_cita) : '—'}</td>
        <td class="num">${visitas}</td>
        <td class="num mono" style="color:var(--text);">${ltv}</td>
        <td>${estadoChip}</td>
        <td><button class="btn aria" onclick="reactivateClient('${l.id}','${escapeHtml(l.nombre)}')" title="Genera mensaje personalizado de reactivación vía ARIA">Reactivar</button></td>
      </tr>`;
  }).join('');
}

window.loadCRM = loadCRM;

// v2.1.23 — Reactivar cliente: preview modal + ARIA mensaje personalizado contextual
// (Reemplaza suggestNBA que insertaba sin preview)
// En producción ARIA usa GPT-4o → confianza típica 90%+. Hoy mostramos placeholder.
window.reactivateClient = async function(leadId, name){
  try {
    // Trae contexto del lead + último appointment para personalizar
    const [leads, lastApts] = await Promise.all([
      sbGet('leads', `id=eq.${leadId}&select=nombre,whatsapp,fuente,ultima_visita,created_at,notas,intent_score`),
      sbGet('appointments', `lead_id=eq.${leadId}&estado=eq.completed&select=servicio,paid_at&order=paid_at.desc&limit=1`)
    ]);
    if(!leads.length){ window.toast?.('Lead no encontrado', null, 'warn'); return; }
    const lead = leads[0];
    const lastApt = lastApts[0];
    const empresa = window.currentClient?.empresa || 'tu negocio';

    // Calcular días sin actividad
    const refDate = lead.ultima_visita || lead.created_at;
    const daysSince = refDate ? Math.floor((Date.now() - new Date(refDate).getTime()) / 86400000) : null;

    // Servicio sugerido: continuidad si existe, fallback a Limpieza facial
    const suggestedService = lastApt?.servicio || 'Limpieza facial profunda';

    // Generar mensaje contextual
    let message;
    if(daysSince !== null && lastApt){
      message = `Hola ${lead.nombre}, te extrañamos en ${empresa}. Notamos que tu última visita fue hace ${daysSince} días. Tenemos disponibilidad esta semana para tu próxima ${suggestedService}. ¿Agendamos?`;
    } else if(daysSince !== null){
      message = `Hola ${lead.nombre}, te escribo desde ${empresa}. Notamos que mostraste interés hace ${daysSince} días. Tenemos novedades que podrían interesarte. ¿Te agendamos una valoración?`;
    } else {
      message = `Hola ${lead.nombre}, te escribimos desde ${empresa}. Tenemos disponibilidad esta semana y nos encantaría atenderte. ¿Te agendamos?`;
    }

    // Confidence — placeholder hasta que GPT-4o esté integrado en producción
    const confidence = 0.87;

    const personalizationLines = [
      `<li>Nombre: <strong style="color:var(--text);">${escapeHtml(lead.nombre || '—')}</strong></li>`,
      daysSince !== null ? `<li>Días sin actividad: <strong style="color:var(--text);">${daysSince}</strong></li>` : '',
      lastApt?.servicio ? `<li>Último servicio: <strong style="color:var(--text);">${escapeHtml(lastApt.servicio)}</strong></li>` : '',
      lead.fuente ? `<li>Fuente original: <strong style="color:var(--text);">${escapeHtml(lead.fuente)}</strong></li>` : '',
    ].filter(Boolean).join('');

    const body = `
      <div style="font-size:11px;color:var(--text3);font-family:'Geist Mono',monospace;letter-spacing:0.5px;text-transform:uppercase;margin-bottom:10px;">
        ARIA generó este mensaje personalizado
      </div>
      <div style="padding:14px;background:var(--card2);border:1px solid var(--border);border-radius:8px;font-size:13px;color:var(--text);line-height:1.6;margin-bottom:14px;">
        ${escapeHtml(message)}
      </div>
      <div style="padding:10px 12px;background:rgba(111,207,151,0.06);border:1px solid rgba(111,207,151,0.2);border-radius:6px;font-size:11px;color:var(--text2);line-height:1.6;margin-bottom:12px;">
        <div style="font-weight:500;color:var(--text);margin-bottom:6px;">Personalización aplicada</div>
        <ul style="list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:3px;">${personalizationLines}</ul>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;font-size:10px;color:var(--text3);font-family:'Geist Mono',monospace;">
        <div>Confianza ARIA: <strong style="color:var(--success);">${(confidence*100).toFixed(0)}%</strong></div>
        <div>Estado: <strong style="color:var(--warn);">PENDIENTE APROBACIÓN</strong></div>
      </div>
    `;
    showModal(`Reactivar a ${escapeHtml(lead.nombre || 'cliente')}`, body, `
      <button class="btn ghost" onclick="closeModal()">Cancelar</button>
      <button class="btn aria" onclick="_confirmReactivation('${leadId}', '${escapeHtml(lead.nombre || '')}', '${encodeURIComponent(message)}', ${confidence})">Crear sugerencia</button>
    `);
  } catch(err){
    console.error('[Reactivate] error:', err);
    window.toast?.('Error', err.message || 'No se pudo generar la sugerencia', 'err');
    window.electronAPI?.sentryCapture?.(err);
  }
};

// Confirma la creación: inserta ia_suggestion en pending para que el cliente apruebe en su drawer
window._confirmReactivation = async function(leadId, name, encodedMessage, confidence){
  try {
    const message = decodeURIComponent(encodedMessage);
    await sbInsert('ia_suggestions', {
      client_id: window.CLIENT_ID,
      type: 'send_whatsapp',
      title: `Reactivación: ${name}`,
      reasoning: message,
      payload: { lead_id: leadId, template: 'reactivation', message },
      confidence: confidence,
      source: 'manual',
      status: 'pending'
    });
    closeModal();
    window.toast?.('🔮 Sugerencia creada', 'Apruébala desde tu drawer ARIA cuando estés listo', 'aria');
    if(typeof window.openAria === 'function') window.openAria();
  } catch(err){
    console.error('[Reactivate confirm] error:', err);
    window.toast?.('Error', err.message || 'No se pudo crear', 'err');
    window.electronAPI?.sentryCapture?.(err);
  }
};

// Compat: viejos botones que llamen suggestNBA siguen funcionando
window.suggestNBA = window.reactivateClient;

// ============================================
// VIEW: CAMPAIGNS
// ============================================
let _campaignsRange = 30;
let _campaignsRefreshBusy = false;

window.campaignsRange = function(days){
  _campaignsRange = days;
  document.querySelectorAll('.ingresos-range-btn[data-crange-c]').forEach(b =>
    b.classList.toggle('active', Number(b.dataset.crangeC) === days));
  const labels = { 7: 'últimos 7 días', 30: 'últimos 30 días', 90: 'últimos 90 días', 365: 'año en curso' };
  const el = document.getElementById('campaigns-range-label');
  if(el) el.textContent = labels[days] || 'periodo seleccionado';
  loadCampaigns();
};

window.refreshCampaigns = async function(){
  if(_campaignsRefreshBusy) return;
  const btn = document.getElementById('campaigns-refresh-btn');
  _campaignsRefreshBusy = true;
  if(btn){ btn.disabled = true; btn.style.opacity = '0.5'; btn.textContent = '…'; }
  try {
    await loadCampaigns();
    window.toast && window.toast('✓ Campañas actualizadas', null, 'success');
  } catch(err){
    window.toast && window.toast('Error', err.message || 'No se pudo refrescar', 'err');
  } finally {
    setTimeout(() => {
      _campaignsRefreshBusy = false;
      if(btn){ btn.disabled = false; btn.style.opacity = ''; btn.textContent = '↻'; }
    }, 1200);
  }
};

async function loadCampaigns(){
  try {
    const days = _campaignsRange || 30;
    const startIso = new Date(Date.now() - days * 86400000).toISOString();
    const camps = await sbGet('whatsapp_campaigns',
      `client_id=eq.${window.CLIENT_ID}&created_at=gte.${startIso}&select=*&order=created_at.desc`);
    const tbody = document.getElementById('camp-tbody');
    if(!tbody) return; // FIX v2.1.20 P4 — defensive guard
    if(camps.length === 0){
      tbody.innerHTML = '<tr><td colspan="9" class="dim" style="text-align:center;padding:20px;">No hay campañas en este periodo</td></tr>';
      return;
    }
    tbody.innerHTML = camps.map(c => `
      <tr>
        <td style="font-size:18px;">${c.icono || '📨'}</td>
        <td><strong>${escapeHtml(c.nombre)}</strong><div class="dim" style="font-size:10px;">${escapeHtml(c.descripcion || '')}</div></td>
        <td class="dim">${c.tipo}</td>
        <td class="dim">${c.segmento}</td>
        <td class="num">${c.enviados || 0}</td>
        <td class="num">${c.leidos || 0}</td>
        <td class="num">${c.respuestas || 0}</td>
        <td class="num ok">${c.citas_generadas || 0}</td>
        <td><span class="chip chip-${c.status==='activo'?'ok':'off'}"><span class="chip-dot"></span>${c.status}</span></td>
      </tr>`).join('');
  } catch(err){
    // FIX v2.1.20 P2 — error visible al usuario
    console.error('[Camp] error:', err);
    window.toast?.('Campañas no se pudo cargar', err.message || 'Error de conexión', 'err');
    window.electronAPI?.sentryCapture?.(err);
  }
}
window.loadCampaigns = loadCampaigns;

// Filtros disponibles para audiencia (preset → query Supabase)
window._campAudienceFilter = 'birthday';

window.openNewCampaign = function(preset){
  // preset: 'birthday' | 'first15' | 'first30' | 'anniversary' | 'reactivate' | 'custom'
  window._campAudienceFilter = preset || 'birthday';
  const presetTitles = {
    birthday:    { name: '🎂 Cumpleaños del mes',           subject: '¡Feliz cumpleaños {nombre}! 🎉 Tenemos un regalo para ti' },
    first15:     { name: '📅 15 días desde primera visita',  subject: 'Hola {nombre}, te extrañamos · regalo de 2da visita' },
    first30:     { name: '🎉 1 mes desde primera visita',    subject: '{nombre}, gracias por elegirnos · oferta de fidelización' },
    anniversary: { name: '💎 Aniversario · 1 año',           subject: '¡Un año juntos {nombre}! 💎 Cupón especial dentro' },
    reactivate:  { name: '💤 Reactivación · 90+ días',       subject: 'Te extrañamos {nombre} · Volvé con un descuento exclusivo' },
    custom:      { name: '⚡ Filtro personalizado',           subject: 'Hola {nombre}, tenemos algo para ti' }
  };
  const tpl = presetTitles[window._campAudienceFilter] || presetTitles.custom;

  const body = `
    <!-- STEP 1: Audiencia -->
    <div class="camp-step">
      <div class="camp-step-title">1 · Audiencia · ¿A quién le envías?</div>
      <div class="field" style="margin-bottom:8px;">
        <div class="field-label">FILTRO</div>
        <select class="field-select" id="camp-audience-filter" onchange="campSetFilterFromSelect()">
          <option value="birthday"    ${preset==='birthday'?'selected':''}>🎂 Cumpleaños del mes</option>
          <option value="first15"     ${preset==='first15'?'selected':''}>📅 15 días desde la primera visita</option>
          <option value="first30"     ${preset==='first30'?'selected':''}>🎉 1 mes desde la primera visita</option>
          <option value="anniversary" ${preset==='anniversary'?'selected':''}>💎 Aniversario · 1 año</option>
          <option value="reactivate"  ${preset==='reactivate'?'selected':''}>💤 Inactivos 90+ días</option>
          <option value="custom"      ${preset==='custom'?'selected':''}>⚡ Personalizado · elegir leads manualmente</option>
        </select>
      </div>

      <!-- Preview cuando filtro NO es personalizado -->
      <div class="camp-audience-preview" id="camp-audience-preview" style="${preset==='custom'?'display:none;':''}">
        <strong id="camp-audience-count">—</strong> destinatarios coinciden con el filtro · <a onclick="campRefreshAudience()" style="color:var(--accent);cursor:pointer;text-decoration:underline;">recalcular</a>
      </div>

      <!-- Modo personalizado: lista de leads con búsqueda + checkboxes -->
      <div id="camp-custom-list" style="${preset==='custom'?'':'display:none;'}margin-top:8px;">
        <input type="search" class="field-input" id="camp-custom-search" placeholder="🔍 Buscar lead por nombre o email…" oninput="campFilterCustomList(this.value)" style="margin-bottom:8px;">
        <div id="camp-custom-leads" style="max-height:240px;overflow-y:auto;border:1px solid var(--border);border-radius:7px;background:var(--card);">
          <div style="padding:18px;text-align:center;color:var(--text3);font-size:11px;">Cargando lista de leads…</div>
        </div>
        <div style="padding:8px 10px;background:rgba(232,232,232,0.05);border:1px solid var(--border);border-radius:6px;font-size:11px;color:var(--text2);margin-top:8px;display:flex;justify-content:space-between;align-items:center;">
          <span><strong id="camp-custom-selected-count" style="color:var(--text);font-family:'Geist Mono',monospace;">0</strong> seleccionados</span>
          <span style="display:flex;gap:8px;">
            <a onclick="campCustomSelectAll(true)"  style="color:var(--accent);cursor:pointer;text-decoration:underline;font-size:10px;">Seleccionar todos</a>
            <a onclick="campCustomSelectAll(false)" style="color:var(--text3);cursor:pointer;text-decoration:underline;font-size:10px;">Limpiar</a>
          </span>
        </div>
      </div>
    </div>

    <!-- STEP 2: Email content -->
    <div class="camp-step">
      <div class="camp-step-title">2 · Mensaje · ¿Qué les decís?</div>
      <div class="field">
        <div class="field-label">NOMBRE INTERNO DE LA CAMPAÑA</div>
        <input class="field-input" id="camp-name" placeholder="${tpl.name.replace(/^[^\s]+\s/, '')}" value="${tpl.name.replace(/^[^\s]+\s/, '')}">
      </div>
      <div class="field">
        <div class="field-label">ASUNTO DEL EMAIL</div>
        <input class="field-input" id="camp-subject" placeholder="${tpl.subject}" value="${tpl.subject}">
      </div>
      <div class="field">
        <div class="field-label">CUERPO DEL EMAIL</div>
        <textarea class="field-input" id="camp-msg" rows="6" placeholder="Hola {nombre}, queremos invitarte a..." style="resize:vertical;font-family:inherit;">Hola {nombre}, queremos invitarte a aprovechar un descuento especial en {servicio}. Tu código: {codigo} — válido por 14 días.</textarea>
        <div style="font-size:10px;color:var(--text3);margin-top:4px;">Variables disponibles: <code style="color:var(--text2);">{nombre}</code> · <code style="color:var(--text2);">{servicio}</code> · <code style="color:var(--text2);">{descuento}</code> · <code style="color:var(--text2);">{codigo}</code></div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;">
        <button type="button" class="btn aria" style="font-size:11px;padding:7px 12px;" onclick="campAriaImprove()">
          Mejorar mensaje con ARIA
        </button>
      </div>
      <div id="camp-aria-feedback" style="display:none;margin-top:10px;padding:10px 12px;background:var(--aria-s);border:1px solid var(--aria-border);border-radius:7px;font-size:11px;color:var(--text2);line-height:1.55;"></div>
    </div>

    <!-- STEP 3: Descuento -->
    <div class="camp-step">
      <div class="camp-step-title">3 · Descuento · opcional</div>
      <div class="field" style="margin-bottom:10px;">
        <div class="field-label">TIPO DE DESCUENTO</div>
        <select class="field-select" id="camp-disc-type" onchange="campToggleDiscType()">
          <option value="none">Sin descuento</option>
          <option value="fixed" selected>Fijo (mismo % para todos)</option>
        </select>
      </div>
      <div id="camp-disc-fixed">
        <div class="camp-discount-row">
          <span style="font-size:12px;color:var(--text2);">Descuento fijo:</span>
          <input type="number" class="field-input" id="camp-disc-value" min="5" max="50" step="5" value="15" style="width:90px;">
          <span style="font-size:12px;color:var(--text2);">%</span>
        </div>
      </div>
      <div style="padding:10px 12px;background:rgba(232,232,232,0.05);border:1px solid var(--border);border-radius:7px;font-size:11px;color:var(--text2);margin-top:10px;line-height:1.55;">
        ✓ Cada email lleva un <strong style="color:var(--text);">código único</strong> personalizado (ej: <code style="font-family:'Geist Mono',monospace;color:var(--text2);">BIRTHDAY-CRISTINA-X9F2K</code>) válido por 14 días.<br>
        ✓ ARIA pregunta automáticamente por el código en cada chat → al detectarlo, aplica el descuento y atribuye la cita a esta campaña.<br>
        ✓ El descuento se ve reflejado en la cita en Agenda y al marcar pagado podrás ajustar el monto final.
      </div>
    </div>

  `;
  showModal('Nueva campaña de email', body, `
    <button class="btn ghost" onclick="closeModal()">Cancelar</button>
    <button class="btn ghost" onclick="saveCampaign('draft')">Guardar borrador</button>
    <button class="btn primary" onclick="saveCampaign('send')">✓ Aprobar y enviar</button>
  `);
  // Calcular audiencia inicial
  setTimeout(() => window.campRefreshAudience?.(), 50);
};

// Mapeo filtro → nombre interno + asunto del email
window._CAMP_FILTER_PRESETS = {
  birthday:    { name: 'Cumpleaños del mes',           subject: '¡Feliz cumpleaños {nombre}! 🎉 Tenemos un regalo para ti' },
  first15:     { name: '15 días desde primera visita',  subject: 'Hola {nombre}, te extrañamos · regalo de 2da visita' },
  first30:     { name: '1 mes desde primera visita',    subject: '{nombre}, gracias por elegirnos · oferta de fidelización' },
  anniversary: { name: 'Aniversario · 1 año',           subject: '¡Un año juntos {nombre}! Cupón especial dentro' },
  reactivate:  { name: 'Reactivación · 90+ días',       subject: 'Te extrañamos {nombre} · Volvé con un descuento exclusivo' },
  custom:      { name: 'Campaña personalizada',         subject: 'Hola {nombre}, tenemos algo para ti' }
};

// Cambio de filtro desde el dropdown
window.campSetFilterFromSelect = function(){
  const sel = document.getElementById('camp-audience-filter');
  if(!sel) return;
  window._campAudienceFilter = sel.value;
  const isCustom = sel.value === 'custom';
  const previewEl = document.getElementById('camp-audience-preview');
  const customEl = document.getElementById('camp-custom-list');
  if(previewEl) previewEl.style.display = isCustom ? 'none' : '';
  if(customEl) customEl.style.display = isCustom ? '' : 'none';

  // Auto-actualizar nombre interno + asunto según el filtro elegido
  const tpl = window._CAMP_FILTER_PRESETS[sel.value];
  if(tpl){
    const nameEl = document.getElementById('camp-name');
    const subjectEl = document.getElementById('camp-subject');
    if(nameEl) nameEl.value = tpl.name;
    if(subjectEl) subjectEl.value = tpl.subject;
  }

  if(isCustom){
    window.campLoadCustomList?.();
  } else {
    window.campRefreshAudience?.();
  }
};

// Cache local de leads para modo personalizado
window._campCustomLeads = [];
window._campCustomSelected = new Set();

window.campLoadCustomList = async function(){
  const container = document.getElementById('camp-custom-leads');
  if(!container) return;
  container.innerHTML = '<div style="padding:18px;text-align:center;color:var(--text3);font-size:11px;">Cargando lista de leads…</div>';
  try {
    const rows = await sbGet('leads', `client_id=eq.${window.CLIENT_ID}&email=not.is.null&select=id,nombre,email,whatsapp,intent_score,status&order=nombre.asc&limit=2000`);
    window._campCustomLeads = rows;
    window._campCustomSelected.clear();
    window.campRenderCustomList('');
  } catch(err){
    container.innerHTML = `<div style="padding:18px;text-align:center;color:var(--danger);font-size:11px;">Error al cargar: ${err.message}</div>`;
  }
};

window.campRenderCustomList = function(searchQuery){
  const container = document.getElementById('camp-custom-leads');
  if(!container) return;
  const q = (searchQuery || '').toLowerCase().trim();
  const list = q
    ? window._campCustomLeads.filter(l =>
        (l.nombre || '').toLowerCase().includes(q) ||
        (l.email  || '').toLowerCase().includes(q))
    : window._campCustomLeads;

  if(list.length === 0){
    container.innerHTML = '<div style="padding:18px;text-align:center;color:var(--text3);font-size:11px;">' +
      (window._campCustomLeads.length === 0 ? 'No hay leads con email guardados' : 'Ningún lead coincide con la búsqueda') +
      '</div>';
    return;
  }

  container.innerHTML = list.map(l => {
    const checked = window._campCustomSelected.has(l.id) ? 'checked' : '';
    return `
      <label style="display:flex;align-items:center;gap:10px;padding:9px 12px;border-bottom:1px solid var(--border);cursor:pointer;font-size:12px;">
        <input type="checkbox" data-leadid="${l.id}" ${checked} onchange="campToggleLead(this)" style="margin:0;">
        <div style="flex:1;min-width:0;">
          <div style="color:var(--text);font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(l.nombre || '—')}</div>
          <div style="color:var(--text3);font-size:10px;font-family:'Geist Mono',monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(l.email || '')}</div>
        </div>
      </label>
    `;
  }).join('');
};

window.campFilterCustomList = function(q){
  window.campRenderCustomList(q);
};

window.campToggleLead = function(checkbox){
  const id = checkbox.dataset.leadid;
  if(checkbox.checked) window._campCustomSelected.add(id);
  else window._campCustomSelected.delete(id);
  const countEl = document.getElementById('camp-custom-selected-count');
  if(countEl) countEl.textContent = window._campCustomSelected.size;
};

window.campCustomSelectAll = function(select){
  // Solo aplica a los leads visibles actualmente (filtrados)
  const visibleCheckboxes = document.querySelectorAll('#camp-custom-leads input[type="checkbox"]');
  visibleCheckboxes.forEach(cb => {
    cb.checked = select;
    const id = cb.dataset.leadid;
    if(select) window._campCustomSelected.add(id);
    else window._campCustomSelected.delete(id);
  });
  const countEl = document.getElementById('camp-custom-selected-count');
  if(countEl) countEl.textContent = window._campCustomSelected.size;
};

window.campToggleDiscType = function(){
  const type = document.getElementById('camp-disc-type')?.value;
  const fixedEl = document.getElementById('camp-disc-fixed');
  if(fixedEl) fixedEl.style.display = type === 'fixed' ? '' : 'none';
};

// ARIA opcional · mejora el copy del email (placeholder hasta integración con GPT)
window.campAriaImprove = async function(){
  const subjectEl = document.getElementById('camp-subject');
  const msgEl = document.getElementById('camp-msg');
  const fb = document.getElementById('camp-aria-feedback');
  if(!msgEl || !fb) return;
  fb.style.display = 'block';
  fb.innerHTML = '<span style="color:var(--aria);">ARIA está revisando…</span>';
  // TODO: en producción, llamar al endpoint que invoca GPT con contexto:
  //   - nombre del negocio
  //   - tipo de campaña (filtro seleccionado)
  //   - mensaje original
  // Hoy: placeholder con sugerencia genérica basada en heurísticas locales.
  setTimeout(() => {
    const empresa = window.currentClient?.empresa || 'tu negocio';
    const filterLabels = { birthday:'cumpleaños', first15:'segunda visita', first30:'fidelización', anniversary:'aniversario', reactivate:'reactivación', custom:'general' };
    const ctx = filterLabels[window._campAudienceFilter] || 'general';
    fb.innerHTML = `
      <div style="font-weight:600;color:var(--text);margin-bottom:6px;">🤖 ARIA sugiere:</div>
      <div style="font-style:italic;color:var(--text);background:var(--card2);padding:10px;border-radius:6px;margin-bottom:8px;">
        Hola {nombre} 👋<br>
        En ${empresa} queremos celebrarte con un detalle especial: tu código <strong>{codigo}</strong> tiene un <strong>{descuento}%</strong> de descuento en {servicio}, válido por 14 días.<br><br>
        Reserva tu cita por WhatsApp. Te esperamos.
      </div>
      <div style="display:flex;gap:6px;">
        <button class="btn aria" style="font-size:10px;padding:5px 10px;" onclick="document.getElementById('camp-msg').value=this.dataset.text;document.getElementById('camp-aria-feedback').style.display='none';" data-text="Hola {nombre} 👋\nEn ${empresa} queremos celebrarte con un detalle especial: tu código {codigo} tiene un {descuento}% de descuento en {servicio}, válido por 14 días.\n\nReserva tu cita por WhatsApp. Te esperamos.">✓ Aplicar sugerencia</button>
        <button class="btn ghost" style="font-size:10px;padding:5px 10px;" onclick="document.getElementById('camp-aria-feedback').style.display='none';">Mantener mi mensaje</button>
      </div>
    `;
  }, 800);
};

// Calcula cuántos leads/clientes coinciden con el filtro de audiencia
window.campRefreshAudience = async function(){
  const filter = window._campAudienceFilter || 'birthday';
  const countEl = document.getElementById('camp-audience-count');
  if(!countEl) return;
  countEl.textContent = '…';
  try {
    const now = new Date();
    let query = `client_id=eq.${window.CLIENT_ID}&email=not.is.null&select=id&limit=2000`;
    if(filter === 'birthday'){
      // Cumpleaños este mes — requiere columna `cumpleanos` en formato MM-DD
      const mm = String(now.getMonth() + 1).padStart(2, '0');
      query += `&cumpleanos=like.${mm}-*`;
    } else if(filter === 'first15'){
      // Primera visita hace ~15 días (12-18d)
      const min = new Date(now); min.setDate(min.getDate() - 18);
      const max = new Date(now); max.setDate(max.getDate() - 12);
      query += `&primera_visita=gte.${min.toISOString().slice(0,10)}&primera_visita=lte.${max.toISOString().slice(0,10)}`;
    } else if(filter === 'first30'){
      const min = new Date(now); min.setDate(min.getDate() - 35);
      const max = new Date(now); max.setDate(max.getDate() - 27);
      query += `&primera_visita=gte.${min.toISOString().slice(0,10)}&primera_visita=lte.${max.toISOString().slice(0,10)}`;
    } else if(filter === 'anniversary'){
      const min = new Date(now); min.setDate(min.getDate() - 370); min.setDate(min.getDate());
      const max = new Date(now); max.setDate(max.getDate() - 360);
      query += `&primera_visita=gte.${min.toISOString().slice(0,10)}&primera_visita=lte.${max.toISOString().slice(0,10)}`;
    } else if(filter === 'reactivate'){
      const cutoff = new Date(now); cutoff.setDate(cutoff.getDate() - 90);
      query += `&ultima_visita=lt.${cutoff.toISOString().slice(0,10)}`;
    }
    // 'custom' = sin filtro adicional, devuelve todos los con email
    const rows = await sbGet('leads', query);
    countEl.textContent = rows.length;
  } catch(err){
    console.warn('[campRefreshAudience]', err);
    countEl.textContent = '?';
  }
};

window.saveCampaign = async function(mode){
  // v2.3.3 — Accept 'draft' | 'send' explicitly.
  // ANTES: la función ignoraba el argumento y siempre guardaba como draft, sin importar
  // qué botón presionara el usuario ("Guardar borrador" vs "Aprobar y enviar").
  // AHORA: mode='draft' → status='draft' · mode='send' → status='scheduled' (en cola).
  // NOTA pendiente v2.3.4: Edge Function send-campaign que tome scheduled → sent
  // vía Resend API (hoy n8n DS2-CAMPAIGN-SENDER está pausado).
  const sendMode = (mode === 'send') ? 'send' : 'draft';

  const nombre  = (document.getElementById('camp-name')?.value || '').trim();
  const mensaje = (document.getElementById('camp-msg')?.value  || '').trim();
  const canal   = document.getElementById('camp-channel')?.value || 'whatsapp';
  const segmento = document.getElementById('camp-segment')?.value || 'todos';

  if(nombre.length < 3){
    window.toast('Nombre muy corto', 'Mínimo 3 caracteres', 'warn');
    return;
  }
  if(mensaje.length < 10){
    window.toast('Mensaje muy corto', 'Mínimo 10 caracteres — describe la promo claramente', 'warn');
    return;
  }
  if(mensaje.length > 1000){
    window.toast('Mensaje muy largo', 'Máximo 1000 caracteres (WhatsApp tiene límites)', 'warn');
    return;
  }

  // FIX v2.1.20 P3 — conteo REAL de destinatarios según segmento (no hardcoded)
  let recipientCount = 0;
  try {
    if(segmento === 'todos'){
      const all = await sbGet('leads', `client_id=eq.${window.CLIENT_ID}&select=id`);
      recipientCount = all.length;
    } else if(segmento === 'nuevos'){
      const since = new Date(Date.now() - 30 * 86400000).toISOString();
      const news = await sbGet('leads', `client_id=eq.${window.CLIENT_ID}&created_at=gte.${since}&select=id`);
      recipientCount = news.length;
    } else if(segmento === 'inactivos'){
      // "inactivos 3+ meses": leads sin actividad reciente (ultima_visita < hace 90d O sin ultima_visita pero >90d desde creación)
      const cutoff = new Date(Date.now() - 90 * 86400000).toISOString();
      const inact = await sbGet('leads', `client_id=eq.${window.CLIENT_ID}&or=(ultima_visita.lt.${cutoff},and(ultima_visita.is.null,created_at.lt.${cutoff}))&select=id`);
      recipientCount = inact.length;
    }
  } catch(_){ /* fallback a 0 si la query falla */ }

  const payload = {
    client_id: window.CLIENT_ID,
    nombre,
    tipo: canal === 'whatsapp' ? 'broadcast' : 'email',
    segmento,
    mensaje_template: mensaje,
    icono: '📣',
    status: sendMode === 'send' ? 'scheduled' : 'draft'
  };
  try {
    await sbInsert('whatsapp_campaigns', payload);
    // Sugerencia ARIA con conteo real
    await sbInsert('ia_suggestions', {
      client_id: window.CLIENT_ID,
      type: 'create_campaign',
      title: sendMode === 'send'
        ? `Campaña aprobada: ${payload.nombre}`
        : `Aprobar campaña: ${payload.nombre}`,
      reasoning: recipientCount > 0
        ? (sendMode === 'send'
            ? `Aprobada para envío · ${recipientCount} destinatarios. Pendiente activación del sender (n8n DS2-CAMPAIGN-SENDER / Edge Function send-campaign).`
            : `Destinatarios reales: ${recipientCount} ${segmento === 'todos' ? 'leads' : segmento === 'nuevos' ? 'leads nuevos (30d)' : 'inactivos (90d+)'}. Mensaje listo para envío.`)
        : `Sin destinatarios para el segmento "${segmento}". Considera otro segmento o esperar a tener más leads.`,
      payload: payload,
      confidence: 0.8,
      source: 'manual',
      status: 'pending'
    });
    closeModal();
    if(recipientCount === 0){
      window.toast('⚠ Campaña guardada sin destinatarios', `Segmento "${segmento}" tiene 0 leads — revisa antes de aprobar`, 'warn');
    } else if(sendMode === 'send'){
      window.toast('✓ Campaña aprobada', `${recipientCount} destinatarios · en cola para envío`, 'success');
    } else {
      window.toast('✓ Borrador guardado', `${recipientCount} destinatarios · queda como borrador hasta que la apruebes`, 'aria');
    }
    window.openAria();
  } catch(err){
    window.toast('Error', err.message || 'No se pudo guardar', 'err');
    window.electronAPI?.sentryCapture?.(err);
  }
};

// ============================================
// VIEW: INBOX WhatsApp (DEPRECATED en v2.1.6)
// ============================================
// La vista de Inbox standalone fue reemplazada por ARIA → Conversaciones.
// Ya no hay nav-item 'inbox' en el sidebar. Esta función se mantiene como
// no-op safe para que las llamadas legacy desde realtime.js no crasheen
// (ej: handleWhatsappMessage cuando currentView === 'inbox').
window.loadInbox = async function(){
  // Si la vista activa es 'aria' (donde vive el inbox real), redirigimos
  // al loader de conversaciones del ARIA section.
  if(window.currentView === 'aria' && typeof window.loadConversations === 'function'){
    return window.loadConversations();
  }
  // No-op: el contenedor #wa-messages ya no existe.
};

// VIEW: SLA — eliminado en v2.2.0 (rediseño mockup C eliminó el grupo Premium con Coach/Dindex/SLA).
// La función `window.loadSLA` se quitó como código muerto en v2.2.1.
// La tabla `kpi_snapshots` sigue activa para uso interno del backend (n8n DS2-MONTHLY-REPORT).

// ============================================
// VIEW: BILLING
// ============================================
window.loadBilling = async function(){
  try {
    const [subs, invoices] = await Promise.all([
      sbGet('subscriptions', `client_id=eq.${window.CLIENT_ID}&select=*&order=created_at.desc&limit=1`),
      sbGet('invoices', `client_id=eq.${window.CLIENT_ID}&select=*&order=paid_at.desc&limit=20`)
    ]);

    // v2.1.39 — usar moneda del cliente, no hardcoded $ USD
    const moneda = window.currentClient?.moneda || 'USD';
    const monedaSym = { USD:'$', MXN:'$', DOP:'RD$', EUR:'€', COP:'$' }[moneda] || '$';

    if(subs.length > 0){
      const s = subs[0];
      const planEl     = document.getElementById('bill-plan');
      const statusEl   = document.getElementById('bill-status');
      const amountEl   = document.getElementById('bill-amount');
      const intervalEl = document.getElementById('bill-interval');
      const nextEl     = document.getElementById('bill-next');
      if(planEl)     planEl.textContent     = (s.plan || '—').toUpperCase();
      if(statusEl)   statusEl.innerHTML     = `<span class="chip chip-${s.status==='active'?'ok':'warn'}"><span class="chip-dot"></span>${escapeHtml(s.status||'')}</span>`;
      if(amountEl)   amountEl.textContent   = monedaSym + (s.amount_cents/100).toLocaleString('en');
      if(intervalEl) intervalEl.textContent = '/ ' + (s.interval || 'month');
      if(nextEl)     nextEl.textContent     = s.current_period_end ? window.fmtDateTZ(s.current_period_end, {day:'numeric', month:'short'}) : '—';
    }

    const paidCount = invoices.filter(i => i.status === 'paid').length;
    const paidEl = document.getElementById('bill-paid');
    if(paidEl) paidEl.textContent = paidCount;

    const tbody = document.getElementById('bill-tbody');
    if(!tbody) return;
    if(invoices.length === 0){
      tbody.innerHTML = '<tr><td colspan="5" class="dim" style="text-align:center;padding:20px;">No hay facturas aún</td></tr>';
    } else {
      // v2.1.23 — sin botón Descargar (cliente recibe factura por email automático)
      // v2.1.39 — escapeHtml en number/status (datos de Supabase) + monedaSym dinámico
      tbody.innerHTML = invoices.map(i => `
        <tr>
          <td class="num">${escapeHtml(i.number || i.id.slice(0,8))}</td>
          <td class="num dim">${i.period_start ? window.fmtDateTZ(i.period_start, {month:'short', year:'numeric'}) : '—'}</td>
          <td class="num">${monedaSym}${(i.amount_due_cents/100).toLocaleString('en')}</td>
          <td><span class="chip chip-${i.status==='paid'?'ok':i.status==='open'?'warn':'off'}"><span class="chip-dot"></span>${escapeHtml(i.status||'')}</span></td>
          <td class="num dim">${i.paid_at ? window.fmtDateTZ(i.paid_at) : '—'}</td>
        </tr>`).join('');
    }
  } catch(err){
    console.error('[Billing] error:', err);
    window.toast?.('Facturación no se pudo cargar', err.message || 'Error de conexión', 'err');
    window.electronAPI?.sentryCapture?.(err);
  }
};

// ============================================
// VIEW: SETTINGS (con tabs)
// ============================================
window.loadSettings = async function(){
  const c = window.currentClient || {};
  // Perfil
  // v2.1.13: 'responsable' ahora editable (antes era read-only en DB → mostraba "Dr. Prueba" sin poder cambiar)
  const setResp = document.getElementById('set-responsable');
  if(setResp) setResp.value = c.responsable || '';
  const setRespTitulo = document.getElementById('set-responsable-titulo');
  if(setRespTitulo) setRespTitulo.value = c.responsable_titulo || '';
  document.getElementById('set-nombre').value = c.nombre || '';
  document.getElementById('set-empresa').value = c.empresa || '';
  document.getElementById('set-email').value = c.email || '';
  document.getElementById('set-whatsapp').value = c.whatsapp || '';
  document.getElementById('set-industria').value = c.industria || '';
  document.getElementById('set-moneda').value = c.moneda || 'USD';
  // Email config (auto-fallback al email de perfil)
  document.getElementById('set-from-email').value = c.confirmation_email_from || '';
  document.getElementById('set-from-email').placeholder = c.email ? `Default: ${c.email}` : 'citas@tumarca.com';
  document.getElementById('set-from-name').value = c.confirmation_email_from_name || c.empresa || '';
  document.getElementById('set-reply-to').value = c.confirmation_email_reply_to || '';

  // v2.2.3 — Notificaciones · cargar prefs persistidas (default todo true)
  const np = c.notification_prefs || {};
  const setNotif = (id, key, defaultVal) => {
    const el = document.getElementById(id);
    if (el) el.checked = (np[key] !== undefined) ? !!np[key] : defaultVal;
  };
  setNotif('notif-leads',   'leads_new',      true);
  setNotif('notif-confirm', 'appt_confirmed', true);
  setNotif('notif-aria',    'aria_actions',   true);
  setNotif('notif-report',  'monthly_report', true);
  // n8n webhook (legacy — el UI fue eliminado en Sprint integraciones, pero mantenemos
  // la columna por compat con clientes Enterprise que aún la usen para custom automations)
  // Theme buttons state
  const isLight = document.body.classList.contains('theme-light');
  document.getElementById('theme-dark-btn').className = isLight ? 'btn ghost' : 'btn primary';
  document.getElementById('theme-light-btn').className = isLight ? 'btn primary' : 'btn ghost';

  // Idle logout minutes — reflejar valor actual en el select
  // v2.2.3 — prioridad: BD (cross-device) > componente en memoria > default 30
  const idleSel = document.getElementById('set-idle-minutes');
  if(idleSel && window.idleLogout){
    const fromBD = (c.idle_logout_minutes != null) ? parseInt(c.idle_logout_minutes, 10) : null;
    if (fromBD && fromBD !== window.idleLogout.getMinutes()) {
      // Sincronizar componente con valor de BD (no genera otra escritura)
      window.idleLogout.setMinutes(fromBD);
    }
    const current = window.idleLogout.getMinutes();
    if(!Array.from(idleSel.options).some(o => Number(o.value) === current)){
      const opt = document.createElement('option');
      opt.value = String(current);
      opt.textContent = `${current} minutos`;
      idleSel.appendChild(opt);
    }
    idleSel.value = String(current);
  }

  // ── Ubicación ──
  document.getElementById('set-direccion').value       = c.direccion || '';
  document.getElementById('set-ciudad').value          = c.ciudad || '';
  document.getElementById('set-codigo-postal').value   = c.codigo_postal || '';
  document.getElementById('set-google-maps-url').value = c.google_maps_url || '';

  // Trigger validación Maps URL si ya hay valor
  const mapsInput = document.getElementById('set-google-maps-url');
  if(mapsInput && mapsInput.value) validateMapsUrl(mapsInput);

  // ── Horario de atención ──
  // v2.1.38 — el selector único de tz vive en "Datos del negocio".
  // En este panel solo mostramos el valor actual (read-only mirror) +
  // sincronizamos cuando el usuario cambia el dropdown sin recargar.
  const tzSel = document.getElementById('set-timezone');
  if(tzSel){
    tzSel.value = c.timezone || 'America/Mexico_City';
    // Mirror inicial
    const _disp = document.getElementById('set-timezone-display');
    if(_disp){
      const opt = tzSel.options[tzSel.selectedIndex];
      _disp.textContent = opt ? opt.textContent : (c.timezone || '—');
    }
    // Sync en vivo cuando el usuario cambia el dropdown (antes de guardar)
    if(!tzSel.dataset.mirrorWired){
      tzSel.addEventListener('change', () => {
        const d = document.getElementById('set-timezone-display');
        if(d){
          const o = tzSel.options[tzSel.selectedIndex];
          d.textContent = o ? o.textContent : tzSel.value;
        }
      });
      tzSel.dataset.mirrorWired = '1';
    }
  }
  renderHoursEditor(c.business_hours || _defaultBusinessHours());

  // Load services tab data
  await loadServices();
};

// ============================================
// UBICACIÓN + HORARIOS
// ============================================
const _DAYS = [
  { key: 'monday',    label: 'Lunes' },
  { key: 'tuesday',   label: 'Martes' },
  { key: 'wednesday', label: 'Miércoles' },
  { key: 'thursday',  label: 'Jueves' },
  { key: 'friday',    label: 'Viernes' },
  { key: 'saturday',  label: 'Sábado' },
  { key: 'sunday',    label: 'Domingo' },
];

function _defaultBusinessHours(){
  return {
    monday:    { open: '09:00', close: '19:00', closed: false },
    tuesday:   { open: '09:00', close: '19:00', closed: false },
    wednesday: { open: '09:00', close: '19:00', closed: false },
    thursday:  { open: '09:00', close: '19:00', closed: false },
    friday:    { open: '09:00', close: '19:00', closed: false },
    saturday:  { open: '10:00', close: '14:00', closed: false },
    sunday:    { closed: true }
  };
}

function renderHoursEditor(hours){
  const el = document.getElementById('hours-editor');
  if(!el) return;
  el.innerHTML = _DAYS.map(d => {
    const h = hours?.[d.key] || {};
    const closed = h.closed === true;
    const open  = h.open  || '09:00';
    const close = h.close || '19:00';
    return `
      <div class="hours-row" data-day="${d.key}" style="display:grid;grid-template-columns:100px 70px 1fr 1fr;gap:10px;align-items:center;padding:8px 0;border-bottom:1px dashed var(--border);">
        <div style="font-size:12px;font-weight:500;">${d.label}</div>
        <label class="switch" title="${closed?'Cerrado':'Abierto'}">
          <input type="checkbox" ${closed?'':'checked'} onchange="toggleDayOpen('${d.key}', this.checked)">
          <span class="slider"></span>
        </label>
        <input type="time" class="field-input hours-open" value="${open}" ${closed?'disabled':''} style="padding:6px 8px;font-size:12px;">
        <input type="time" class="field-input hours-close" value="${close}" ${closed?'disabled':''} style="padding:6px 8px;font-size:12px;">
      </div>`;
  }).join('');
}

window.toggleDayOpen = function(dayKey, isOpen){
  const row = document.querySelector(`.hours-row[data-day="${dayKey}"]`);
  if(!row) return;
  const openIn  = row.querySelector('.hours-open');
  const closeIn = row.querySelector('.hours-close');
  if(openIn)  openIn.disabled  = !isOpen;
  if(closeIn) closeIn.disabled = !isOpen;
};

function _collectBusinessHours(){
  const out = {};
  for(const d of _DAYS){
    const row = document.querySelector(`.hours-row[data-day="${d.key}"]`);
    if(!row) continue;
    const checkbox = row.querySelector('input[type="checkbox"]');
    const isOpen = checkbox?.checked === true;
    if(!isOpen){
      out[d.key] = { closed: true };
    } else {
      const open  = row.querySelector('.hours-open')?.value  || '09:00';
      const close = row.querySelector('.hours-close')?.value || '19:00';
      out[d.key] = { open, close, closed: false };
    }
  }
  return out;
}

// Validar + extraer lat/lng de URL Google Maps
window.validateMapsUrl = function(inputEl){
  const msgEl = document.getElementById('maps-validation-msg');
  if(!msgEl) return;
  const url = (inputEl.value || '').trim();
  if(!url){
    msgEl.textContent = '';
    msgEl.style.color = '';
    return { valid: true, lat: null, lng: null };
  }
  const isMaps = /^https?:\/\/(maps\.google|www\.google\.com\/maps|goo\.gl\/maps|maps\.app\.goo\.gl)/i.test(url);
  if(!isMaps){
    msgEl.textContent = '⚠ No parece un link de Google Maps válido';
    msgEl.style.color = 'var(--warn)';
    return { valid: false };
  }
  // Extraer lat,lng de patrones conocidos (best-effort)
  let lat = null, lng = null;
  const atMatch  = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);      // /maps/@lat,lng,zoom
  const qMatch   = url.match(/[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/); // ?q=lat,lng
  const llMatch  = url.match(/[?&]ll=(-?\d+\.\d+),(-?\d+\.\d+)/);
  const m = atMatch || qMatch || llMatch;
  if(m){
    lat = parseFloat(m[1]);
    lng = parseFloat(m[2]);
    msgEl.textContent = `✓ Detectado: ${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    msgEl.style.color = 'var(--success)';
  } else {
    msgEl.textContent = '✓ URL válida (sin coordenadas detectables, igual funciona)';
    msgEl.style.color = 'var(--text3)';
  }
  return { valid: true, lat, lng };
};

window.setIdleMinutes = async function(value){
  // v2.2.3 — persiste a BD además del componente en memoria + localStorage.
  // Antes el setting se perdía al recargar la app porque solo vivía en memory.
  if(!window.idleLogout){ return; }
  const n = window.idleLogout.setMinutes(value);
  window.toast && window.toast('✓ Timer actualizado', `Cierre de sesión tras ${n} min de inactividad`, 'success');
  // Persist a BD (no bloquea la UX si falla)
  try {
    await sbPatch('clients', window.CLIENT_ID, { idle_logout_minutes: parseInt(n, 10) });
    if (window.currentClient) window.currentClient.idle_logout_minutes = parseInt(n, 10);
  } catch(err) {
    console.warn('[setIdleMinutes] no se pudo persistir a BD:', err.message);
    window.electronAPI?.sentryCapture?.(err);
  }
};


window.setTab = function(tab){
  document.querySelectorAll('[data-view="settings"] .tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('[data-view="settings"] .tab-pane').forEach(p => p.classList.toggle('active', p.dataset.tab === tab));
};

window.saveProfile = async function(){
  // Validar Maps URL antes de guardar
  const mapsInput = document.getElementById('set-google-maps-url');
  const mapsVal   = validateMapsUrl(mapsInput);
  if(mapsInput?.value && !mapsVal?.valid){
    window.toast('URL de Maps inválida', 'Revisa el link antes de guardar', 'warn');
    return;
  }

  const payload = {
    // Datos del negocio
    // v2.1.13: incluir responsable + responsable_titulo (antes no editables)
    responsable: document.getElementById('set-responsable')?.value?.trim() || null,
    responsable_titulo: document.getElementById('set-responsable-titulo')?.value?.trim() || null,
    nombre: document.getElementById('set-nombre').value,
    empresa: document.getElementById('set-empresa').value,
    email: document.getElementById('set-email').value,
    whatsapp: document.getElementById('set-whatsapp').value,
    industria: document.getElementById('set-industria').value,
    moneda: document.getElementById('set-moneda').value,

    // Ubicación
    direccion: document.getElementById('set-direccion').value.trim() || null,
    ciudad: document.getElementById('set-ciudad').value.trim() || null,
    codigo_postal: document.getElementById('set-codigo-postal').value.trim() || null,
    google_maps_url: document.getElementById('set-google-maps-url').value.trim() || null,
    lat: mapsVal?.lat ?? null,
    lng: mapsVal?.lng ?? null,

    // Horarios
    timezone: document.getElementById('set-timezone').value,
    business_hours: _collectBusinessHours(),
  };

  try {
    // v2.1.36 — detectamos cambio de timezone para invalidar las vistas
    // que ya están renderizadas con la tz anterior (agenda, brief, ingresos…).
    const tzChanged = window.currentClient && window.currentClient.timezone !== payload.timezone;

    await sbPatch('clients', window.CLIENT_ID, payload);
    Object.assign(window.currentClient, payload);
    renderClientInfo();

    if(tzChanged){
      // Re-render de la vista actual para que los nuevos formatos
      // de fecha/hora se apliquen sin reload completo.
      const v = window.currentView;
      try {
        if(v === 'brief')          await window.loadBriefData?.();
        else if(v === 'agenda')    await window.loadAppointments?.();
        else if(v === 'ingresos')  await window.loadIngresos?.();
        else if(v === 'leads')     await window.loadLeads?.();
        else if(v === 'crm')       await window.loadCRM?.();
        else if(v === 'reports')   await window.loadReports?.();
        else if(v === 'billing')   await window.loadBilling?.();
        // ARIA drawer también refresca su feed (formatTimeAgo etc.)
        window.loadNotifications?.();
      } catch(_){}
      // v2.1.37 — toast con CTA de reload garantizado.
      // El re-render automático cubre 99% de los casos pero el breadcrumb
      // (mes/año en el header) y posibles datos cached solo se refrescan
      // con reload completo. Damos al usuario la opción explícita.
      _showReloadToast(
        '✓ Zona horaria actualizada',
        'Las vistas se reformatearon. Recarga para garantizar consistencia.'
      );
    } else {
      window.toast('✓ Perfil guardado', 'Cambios aplicados', 'success');
    }
  } catch(err){ window.toast('Error', err.message, 'err'); }
};

// v2.1.37 — Toast custom con botón de recarga (sticky hasta acción)
function _showReloadToast(title, body){
  const container = document.getElementById('toast-container');
  if(!container){ window.toast(title, body, 'success'); return; }
  const t = document.createElement('div');
  t.className = 'toast success';
  t.style.cursor = 'default';
  t.innerHTML = `
    <div class="toast-title">${escapeHtml(title)}</div>
    <div class="toast-body">${escapeHtml(body)}</div>
    <div style="margin-top:8px;display:flex;gap:6px;">
      <button class="btn primary" style="font-size:11px;padding:5px 12px;" data-act="reload">↻ Recargar dashboard</button>
      <button class="btn ghost" style="font-size:11px;padding:5px 12px;" data-act="dismiss">Más tarde</button>
    </div>`;
  container.appendChild(t);
  t.querySelector('[data-act="reload"]').addEventListener('click', () => {
    try { window.location.reload(); } catch(_){}
  });
  t.querySelector('[data-act="dismiss"]').addEventListener('click', () => t.remove());
  // No auto-remove: queda hasta acción del usuario (reload o dismiss)
}

window.saveEmailConfig = async function(){
  // v2.2.3 — incluir confirmation_email_reply_to (antes se cargaba pero no se guardaba)
  const payload = {
    confirmation_email_from:       document.getElementById('set-from-email')?.value?.trim() || null,
    confirmation_email_from_name:  document.getElementById('set-from-name')?.value?.trim() || null,
    confirmation_email_reply_to:   document.getElementById('set-reply-to')?.value?.trim() || null,
  };
  try {
    await sbPatch('clients', window.CLIENT_ID, payload);
    Object.assign(window.currentClient, payload);
    const fromEmail = payload.confirmation_email_from || window.currentClient.email;
    window.toast('✓ Email config guardada', `Los emails saldrán desde ${fromEmail}`, 'success');
  } catch(err){ window.toast('Error', err.message, 'err'); }
};

// v2.2.3 — Notificaciones · persistencia real (antes los 4 toggles eran fake)
window.saveNotificationPrefs = async function(){
  const payload = {
    notification_prefs: {
      leads_new:      document.getElementById('notif-leads')?.checked ?? true,
      appt_confirmed: document.getElementById('notif-confirm')?.checked ?? true,
      aria_actions:   document.getElementById('notif-aria')?.checked ?? true,
      monthly_report: document.getElementById('notif-report')?.checked ?? true,
    },
  };
  try {
    await sbPatch('clients', window.CLIENT_ID, payload);
    Object.assign(window.currentClient, payload);
    window.toast?.('✓ Preferencias guardadas', null, 'success');
  } catch(err){
    window.toast?.('Error', err.message, 'err');
    window.electronAPI?.sentryCapture?.(err);
  }
};

window.testConfirmationEmail = async function(){
  const from = document.getElementById('set-from-email').value || window.currentClient.email;
  window.toast('📧 Test email', `Se enviaría desde: ${from}. Función de envío en preparación.`, 'success');
};

// saveN8nWebhook removida del UI en Sprint integraciones.
// El webhook n8n se configura internamente via DS2-06/07/08 globales, no por cliente.
// Si Enterprise requiere webhook custom, se agrega manualmente vía Supabase.

// ============================================
// BRIEF CHART · CSS bars con month nav (Commit 6)
// ============================================
// Reemplaza Chart.js. Renderiza días del mes seleccionado,
// días futuros = empty, día actual = today (highlight blanco).

const MONTHS_LONG_ES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
const MONTHS_ABBR_ES = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];

function daysInMonth(year, month0){ // month0 = 0-11
  return new Date(year, month0 + 1, 0).getDate();
}

window.renderBriefBarChart = function(monthKey){
  const data = window._briefChartData;
  if(!data) return;
  const chart = document.getElementById('chart-brief');
  if(!chart) return;

  window._briefSelectedMonth = monthKey;
  const [y, m] = monthKey.split('-').map(n => parseInt(n, 10));
  const year = y, month0 = m - 1;
  const days = daysInMonth(year, month0);
  const monedaSym = data.monedaSym || '$';

  // Día actual del mes (solo aplica si monthKey = mes actual)
  const now = new Date();
  const isCurrentMonth = (year === now.getFullYear() && month0 === now.getMonth());
  const today = isCurrentMonth ? now.getDate() : 0;

  // Datos del mes seleccionado
  const dayData = data.revenueByMonthDay[monthKey] || {};
  const dayCounts = data.apptCountByMonthDay[monthKey] || {};
  const values = [];
  for(let d = 1; d <= days; d++) values.push(dayData[d] || 0);
  const max = Math.max(...values, 1);

  // Labels en sec-head
  const monthLabel = `${MONTHS_LONG_ES[month0]} ${year}`;
  const lbl1 = document.getElementById('brief-chart-month-label');
  const lbl2 = document.getElementById('brief-month-current');
  if(lbl1) lbl1.textContent = monthLabel;
  if(lbl2) lbl2.textContent = monthLabel;

  // Meta
  const totalCents = values.reduce((s,v) => s + v, 0);
  const withData = values.filter(v => v > 0).length;
  const meta = document.getElementById('brief-chart-meta');
  if(meta){
    const total = (totalCents / 100).toLocaleString('en', { maximumFractionDigits: 0 });
    meta.textContent = `${monedaSym}${total} · ${withData}/${days} días con cobro`;
  }

  // Disable nav prev/next según data disponible
  const allMonths = Object.keys(data.revenueByMonthDay).sort();
  const prevBtn = document.getElementById('brief-month-prev');
  const nextBtn = document.getElementById('brief-month-next');
  if(prevBtn){
    // Habilitar prev si hay algún mes anterior con data o si simplemente hay meses anteriores en el rango 180d
    const idx = allMonths.indexOf(monthKey);
    prevBtn.disabled = (allMonths.length === 0 || (idx === 0 && allMonths[0] === monthKey)) ? true : false;
    // Permitimos retroceder hasta 180d aunque no haya data en esos meses
    const oldestAllowed = new Date(now); oldestAllowed.setDate(oldestAllowed.getDate() - 180);
    const candidate = new Date(year, month0 - 1, 1);
    prevBtn.disabled = candidate < oldestAllowed;
  }
  if(nextBtn) nextBtn.disabled = !isCurrentMonth ? false : true;

  // Eje X labels (1, 15, último día)
  const monthAbbr = MONTHS_ABBR_ES[month0];
  const setEl = (id, v) => { const el = document.getElementById(id); if(el) el.textContent = v; };
  setEl('brief-axis-start', '1 ' + monthAbbr);
  setEl('brief-axis-mid',   '15 ' + monthAbbr);
  setEl('brief-axis-end',   days + ' ' + monthAbbr);

  // Render bars
  chart.innerHTML = '';
  for(let d = 1; d <= days; d++){
    const value = values[d - 1];
    const bar = document.createElement('div');
    bar.className = 'bar';
    const dateStr = `${d} ${monthAbbr}`;
    if(isCurrentMonth && d > today){
      // Día futuro = empty
      bar.classList.add('empty');
      bar.dataset.d = dateStr;
      bar.dataset.v = '—';
      bar.dataset.c = 'aún no transcurrido';
    } else if(value === 0){
      // Día sin ingresos
      bar.classList.add('dim');
      bar.style.height = '6%';
      bar.dataset.d = dateStr;
      bar.dataset.v = monedaSym + '0';
      bar.dataset.c = 'sin ingresos';
    } else {
      const pct = Math.max(8, Math.round((value / max) * 100));
      bar.style.height = pct + '%';
      if(isCurrentMonth && d === today) bar.classList.add('today');
      bar.dataset.d = dateStr;
      bar.dataset.v = monedaSym + (value / 100).toLocaleString('en', { maximumFractionDigits: 0 });
      const c = dayCounts[d] || 0;
      bar.dataset.c = c + (c === 1 ? ' cita pagada' : ' citas pagadas');
    }
    chart.appendChild(bar);
  }
  attachBriefBarTooltip();
};

function attachBriefBarTooltip(){
  const chart = document.getElementById('chart-brief');
  const ttp = document.getElementById('chart-brief-tooltip');
  if(!chart || !ttp) return;
  chart.querySelectorAll('.bar').forEach(bar => {
    bar.addEventListener('mouseenter', () => {
      const cr = chart.getBoundingClientRect();
      const r = bar.getBoundingClientRect();
      ttp.style.left = (r.left - cr.left + r.width / 2) + 'px';
      ttp.querySelector('.bt-date').textContent = bar.dataset.d;
      ttp.querySelector('.bt-value').textContent = bar.dataset.v;
      ttp.querySelector('.bt-meta').textContent = bar.dataset.c;
      ttp.classList.add('show');
    });
    bar.addEventListener('mouseleave', () => ttp.classList.remove('show'));
  });
}

window.briefChangeMonth = function(dir){
  const cur = window._briefSelectedMonth;
  if(!cur) return;
  const [y, m] = cur.split('-').map(n => parseInt(n, 10));
  const d = new Date(y, m - 1 + dir, 1);
  // No permitir avanzar más allá del mes actual
  const now = new Date();
  if(d.getFullYear() > now.getFullYear() || (d.getFullYear() === now.getFullYear() && d.getMonth() > now.getMonth())) return;
  // No permitir retroceder más de 180 días
  const oldestAllowed = new Date(now); oldestAllowed.setDate(oldestAllowed.getDate() - 180);
  if(d < oldestAllowed) return;
  const newKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  renderBriefBarChart(newKey);
};

window.briefGoToCurrentMonth = function(){
  const now = new Date();
  const k = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  renderBriefBarChart(k);
};

// ============================================
// INGRESOS CHART · CSS bars con month nav (alineado al mockup)
// ============================================
window.renderIngresosBarChart = function(monthKey){
  const data = window._ingresosChartData;
  if(!data) return;
  const chart = document.getElementById('chart-ingresos');
  if(!chart) return;

  window._ingresosSelectedMonth = monthKey;
  const [y, m] = monthKey.split('-').map(n => parseInt(n, 10));
  const year = y, month0 = m - 1;
  const days = new Date(year, month0 + 1, 0).getDate();
  const monedaSym = data.monedaSym || '$';

  const now = new Date();
  const isCurrentMonth = (year === now.getFullYear() && month0 === now.getMonth());
  const today = isCurrentMonth ? now.getDate() : 0;

  const dayData = data.revenueByMonthDay[monthKey] || {};
  const dayCounts = data.apptCountByMonthDay[monthKey] || {};
  const values = [];
  for(let d = 1; d <= days; d++) values.push(dayData[d] || 0);
  const max = Math.max(...values, 1);

  const monthLabel = `${MONTHS_LONG_ES[month0]} ${year}`;
  const setEl = (id, v) => { const el = document.getElementById(id); if(el) el.textContent = v; };
  setEl('ing-chart-month-label', monthLabel);
  setEl('ing-month-current', monthLabel);

  const totalCents = values.reduce((s,v) => s + v, 0);
  const withData = values.filter(v => v > 0).length;
  const total = (totalCents / 100).toLocaleString('en', { maximumFractionDigits: 0 });
  setEl('ing-chart-meta', `${monedaSym}${total} · ${withData}/${days} días con cobro`);

  // Disable nav at edges
  const prevBtn = document.getElementById('ing-month-prev');
  const nextBtn = document.getElementById('ing-month-next');
  if(prevBtn){
    const oldestAllowed = new Date(now); oldestAllowed.setDate(oldestAllowed.getDate() - 365);
    const candidate = new Date(year, month0 - 1, 1);
    prevBtn.disabled = candidate < oldestAllowed;
  }
  if(nextBtn) nextBtn.disabled = isCurrentMonth;

  // Axis labels
  const monthAbbr = MONTHS_ABBR_ES[month0];
  setEl('ing-axis-start', '1 ' + monthAbbr);
  setEl('ing-axis-mid',   '15 ' + monthAbbr);
  setEl('ing-axis-end',   days + ' ' + monthAbbr);

  // Render bars
  chart.innerHTML = '';
  for(let d = 1; d <= days; d++){
    const value = values[d - 1];
    const bar = document.createElement('div');
    bar.className = 'bar';
    const dateStr = `${d} ${monthAbbr}`;
    if(isCurrentMonth && d > today){
      bar.classList.add('empty');
      bar.dataset.d = dateStr;
      bar.dataset.v = '—';
      bar.dataset.c = 'aún no transcurrido';
    } else if(value === 0){
      bar.classList.add('dim');
      bar.style.height = '6%';
      bar.dataset.d = dateStr;
      bar.dataset.v = monedaSym + '0';
      bar.dataset.c = 'sin ingresos';
    } else {
      const pct = Math.max(8, Math.round((value / max) * 100));
      bar.style.height = pct + '%';
      if(isCurrentMonth && d === today) bar.classList.add('today');
      bar.dataset.d = dateStr;
      bar.dataset.v = monedaSym + (value / 100).toLocaleString('en', { maximumFractionDigits: 0 });
      const c = dayCounts[d] || 0;
      bar.dataset.c = c + (c === 1 ? ' cita pagada' : ' citas pagadas');
    }
    chart.appendChild(bar);
  }
  attachIngresosBarTooltip();

  // v2.2.5 — sincronizar KPIs por método de pago con el mes mostrado
  if(typeof window.updateIngresosKpisByMethod === 'function'){
    window.updateIngresosKpisByMethod(monthKey);
  }
};

// v2.2.5 — fix memory leak: event delegation en chart en lugar de listener por bar
let _ingresosTooltipBound = false;
function attachIngresosBarTooltip(){
  const chart = document.getElementById('chart-ingresos');
  const ttp = document.getElementById('chart-ingresos-tooltip');
  if(!chart || !ttp) return;
  if(_ingresosTooltipBound) return; // ya tiene listeners delegated
  _ingresosTooltipBound = true;

  chart.addEventListener('mouseover', (e) => {
    const bar = e.target.closest('.bar');
    if(!bar || !chart.contains(bar)) return;
    const cr = chart.getBoundingClientRect();
    const r = bar.getBoundingClientRect();
    ttp.style.left = (r.left - cr.left + r.width / 2) + 'px';
    const dEl = ttp.querySelector('.bt-date');   if(dEl) dEl.textContent = bar.dataset.d || '';
    const vEl = ttp.querySelector('.bt-value');  if(vEl) vEl.textContent = bar.dataset.v || '';
    const mEl = ttp.querySelector('.bt-meta');   if(mEl) mEl.textContent = bar.dataset.c || '';
    ttp.classList.add('show');
  });
  chart.addEventListener('mouseleave', () => ttp.classList.remove('show'));
}

window.ingresosChangeMonth = function(dir){
  const cur = window._ingresosSelectedMonth;
  if(!cur) return;
  const [y, m] = cur.split('-').map(n => parseInt(n, 10));
  const d = new Date(y, m - 1 + dir, 1);
  const now = new Date();
  if(d.getFullYear() > now.getFullYear() || (d.getFullYear() === now.getFullYear() && d.getMonth() > now.getMonth())) return;
  const oldestAllowed = new Date(now); oldestAllowed.setDate(oldestAllowed.getDate() - 365);
  if(d < oldestAllowed) return;
  const newKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  renderIngresosBarChart(newKey);
};

window.ingresosGoToCurrentMonth = function(){
  const now = new Date();
  const k = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  renderIngresosBarChart(k);
};

// ============================================
// AVATAR · Foto de perfil (Commit 5)
// ============================================
// Modal con 2 modos: file picker + cámara web. Crop circular 400×400 en canvas,
// compresión JPEG 0.85, upload a Supabase Storage bucket 'avatars',
// guarda URL en clients.avatar_url y refresca topbar + Settings.

const AVATAR_TARGET_PX = 400;
const AVATAR_JPEG_QUALITY = 0.85;
const AVATAR_MAX_BYTES = 2 * 1024 * 1024; // 2 MB
window._avatarStream = null;
window._avatarCanvasReady = false;

window.openAvatarModal = function(){
  document.getElementById('avatar-modal-overlay')?.classList.add('open');
  document.getElementById('avatar-modal')?.classList.add('open');
  // reset al estado inicial
  resetAvatarStage();
  avatarTab('file');
};

window.closeAvatarModal = function(){
  stopAvatarCamera();
  document.getElementById('avatar-modal-overlay')?.classList.remove('open');
  document.getElementById('avatar-modal')?.classList.remove('open');
  resetAvatarStage();
};

window.avatarTab = function(name){
  document.querySelectorAll('.avatar-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.atab === name));
  document.querySelectorAll('.avatar-tab-pane').forEach(p => p.classList.toggle('active', p.dataset.atab === name));
  if(name !== 'camera') stopAvatarCamera();
};

window.resetAvatarStage = function(){
  document.getElementById('avatar-preview-stage').style.display = 'none';
  document.getElementById('avatar-loading').style.display = 'none';
  window._avatarCanvasReady = false;
  // reset file input
  const fi = document.getElementById('avatar-file-input');
  if(fi) fi.value = '';
};

// ─────────── FILE PICKER ───────────
window.handleAvatarFile = function(file){
  if(!file) return;
  if(file.size > AVATAR_MAX_BYTES){
    window.toast('Archivo muy grande', 'Máximo 2 MB. Prueba otra foto.', 'err');
    return;
  }
  if(!['image/jpeg','image/png','image/webp'].includes(file.type)){
    window.toast('Formato no soportado', 'Usa JPG, PNG o WebP.', 'err');
    return;
  }
  const reader = new FileReader();
  reader.onload = e => {
    const img = new Image();
    img.onload = () => drawCroppedToCanvas(img);
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
};

// Drag & drop visual
(function(){
  const dz = document.getElementById('avatar-dropzone');
  if(!dz) return;
  ['dragover','dragenter'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('dragover'); }));
  ['dragleave','dragend','drop'].forEach(ev => dz.addEventListener(ev, () => dz.classList.remove('dragover')));
  dz.addEventListener('drop', e => {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if(f) window.handleAvatarFile(f);
  });
})();

// ─────────── CAMERA ───────────
window.startAvatarCamera = async function(){
  const status = document.getElementById('avatar-camera-status');
  const video = document.getElementById('avatar-video');
  if(!navigator.mediaDevices?.getUserMedia){
    status.textContent = 'Cámara no disponible en este navegador';
    return;
  }
  try {
    status.textContent = 'Pidiendo permiso…';
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 720 }, height: { ideal: 720 }, facingMode: 'user' },
      audio: false
    });
    window._avatarStream = stream;
    video.srcObject = stream;
    status.textContent = 'En vivo';
    document.getElementById('avatar-camera-start').style.display = 'none';
    document.getElementById('avatar-camera-shoot').style.display = '';
    document.getElementById('avatar-camera-stop').style.display = '';
  } catch(err) {
    console.error('Camera error:', err);
    if(err.name === 'NotAllowedError'){
      status.textContent = 'Permiso denegado. Habilitalo en Preferencias del Sistema.';
    } else if(err.name === 'NotFoundError'){
      status.textContent = 'No se detectó cámara';
    } else {
      status.textContent = 'Error: ' + err.message;
    }
    window.toast('Cámara', status.textContent, 'err');
  }
};

window.stopAvatarCamera = function(){
  if(window._avatarStream){
    window._avatarStream.getTracks().forEach(t => t.stop());
    window._avatarStream = null;
  }
  const video = document.getElementById('avatar-video');
  if(video) video.srcObject = null;
  const startBtn = document.getElementById('avatar-camera-start');
  const shootBtn = document.getElementById('avatar-camera-shoot');
  const stopBtn = document.getElementById('avatar-camera-stop');
  if(startBtn) startBtn.style.display = '';
  if(shootBtn) shootBtn.style.display = 'none';
  if(stopBtn) stopBtn.style.display = 'none';
  const status = document.getElementById('avatar-camera-status');
  if(status) status.textContent = 'Cámara detenida';
};

window.captureAvatarPhoto = function(){
  const video = document.getElementById('avatar-video');
  if(!video || !video.videoWidth){
    window.toast('Cámara', 'Esperá a que la cámara esté lista', 'err');
    return;
  }
  // Crear imagen del frame actual y pasarla al cropper
  const tmp = document.createElement('canvas');
  tmp.width = video.videoWidth;
  tmp.height = video.videoHeight;
  tmp.getContext('2d').drawImage(video, 0, 0);
  const img = new Image();
  img.onload = () => {
    drawCroppedToCanvas(img);
    stopAvatarCamera();
  };
  img.src = tmp.toDataURL('image/jpeg', 0.95);
};

// ─────────── CROP + DRAW al canvas final 400x400 ───────────
function drawCroppedToCanvas(img){
  const canvas = document.getElementById('avatar-canvas');
  const ctx = canvas.getContext('2d');
  // Crop centro al cuadrado más chico
  const side = Math.min(img.width, img.height);
  const sx = (img.width - side) / 2;
  const sy = (img.height - side) / 2;
  ctx.clearRect(0, 0, AVATAR_TARGET_PX, AVATAR_TARGET_PX);
  ctx.drawImage(img, sx, sy, side, side, 0, 0, AVATAR_TARGET_PX, AVATAR_TARGET_PX);
  window._avatarCanvasReady = true;
  // Mostrar stage de preview
  document.getElementById('avatar-preview-stage').style.display = 'block';
  // Calcular tamaño aprox del JPEG resultante
  canvas.toBlob(blob => {
    const meta = document.getElementById('avatar-preview-meta');
    if(meta && blob) meta.textContent = `${AVATAR_TARGET_PX}×${AVATAR_TARGET_PX} · ${(blob.size / 1024).toFixed(0)} KB · JPEG`;
  }, 'image/jpeg', AVATAR_JPEG_QUALITY);
}

// ─────────── UPLOAD a Supabase Storage ───────────
window.uploadAvatar = async function(){
  if(!window._avatarCanvasReady){
    window.toast('Avatar', 'No hay foto seleccionada', 'err');
    return;
  }
  if(!window.CLIENT_ID || !window.ACCESS_TOKEN){
    window.toast('Sesión', 'Tu sesión no está lista, refrescá la página', 'err');
    return;
  }
  const loading = document.getElementById('avatar-loading');
  const loadingText = document.getElementById('avatar-loading-text');
  const uploadBtn = document.getElementById('avatar-upload-btn');
  const canvas = document.getElementById('avatar-canvas');

  loading.style.display = 'flex';
  loadingText.textContent = 'Comprimiendo…';
  uploadBtn.disabled = true;

  // Canvas → Blob (JPEG 0.85)
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', AVATAR_JPEG_QUALITY));
  if(!blob){
    loading.style.display = 'none';
    uploadBtn.disabled = false;
    window.toast('Error', 'No se pudo procesar la imagen', 'err');
    return;
  }

  loadingText.textContent = `Subiendo ${(blob.size / 1024).toFixed(0)} KB…`;

  // Path: avatars/{client_id}/profile.jpg (sobreescribe en cada upload)
  const path = `${window.CLIENT_ID}/profile.jpg`;
  const SUPABASE_URL = window.SUPABASE_URL || 'https://ywlyuuddqitduqtdttgo.supabase.co';

  try {
    // Upload (PUT con upsert=true)
    const uploadRes = await fetch(`${SUPABASE_URL}/storage/v1/object/avatars/${path}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${window.ACCESS_TOKEN}`,
        'Content-Type': 'image/jpeg',
        'x-upsert': 'true',
        'Cache-Control': '3600'
      },
      body: blob
    });
    if(!uploadRes.ok){
      const errTxt = await uploadRes.text();
      throw new Error(`Storage ${uploadRes.status}: ${errTxt.slice(0, 200)}`);
    }

    // URL pública con cache-buster (para forzar refresh tras update)
    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/avatars/${path}?v=${Date.now()}`;

    loadingText.textContent = 'Guardando…';
    // Patch clients.avatar_url
    await sbPatch('clients', window.CLIENT_ID, { avatar_url: publicUrl });

    // Update in-memory
    if(window.currentClient) window.currentClient.avatar_url = publicUrl;

    // Refresh UI
    refreshAvatarUI(publicUrl);

    window.toast('✓ Foto actualizada', 'Tu foto de perfil se guardó correctamente.', 'success');
    closeAvatarModal();
  } catch(err){
    console.error('Avatar upload error:', err);
    window.toast('Error al subir', err.message || 'Intenta de nuevo', 'err');
    loading.style.display = 'none';
    uploadBtn.disabled = false;
  }
};

// ─────────── REMOVE ───────────
window.removeAvatar = async function(){
  if(!confirm('¿Quitar tu foto de perfil? Volverá a mostrar tus iniciales.')) return;
  if(!window.CLIENT_ID) return;
  try {
    const SUPABASE_URL = window.SUPABASE_URL || 'https://ywlyuuddqitduqtdttgo.supabase.co';
    // Borrar archivo del bucket (best-effort, si falla no rompe el flow)
    try {
      await fetch(`${SUPABASE_URL}/storage/v1/object/avatars/${window.CLIENT_ID}/profile.jpg`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${window.ACCESS_TOKEN}` }
      });
    } catch(_){}
    await sbPatch('clients', window.CLIENT_ID, { avatar_url: null });
    if(window.currentClient) window.currentClient.avatar_url = null;
    refreshAvatarUI(null);
    window.toast('Foto quitada', 'Volvimos a tus iniciales.', 'success');
  } catch(err){
    window.toast('Error', err.message, 'err');
  }
};

// ─────────── REFRESH UI tras cambio de avatar ───────────
window.refreshAvatarUI = function(url){
  const initial = (window.currentClient?.empresa?.[0] || window.currentClient?.nombre?.[0] || '?').toUpperCase();
  const name = window.currentClient?.responsable || window.currentClient?.nombre || window.currentClient?.empresa || '—';

  // Avatar grande en Settings → Perfil
  const previewImg = document.getElementById('avatar-image');
  const previewInitials = document.getElementById('avatar-initials');
  const removeBtn = document.getElementById('avatar-remove-btn');
  const infoName = document.getElementById('avatar-info-name');
  if(infoName) infoName.textContent = name;
  if(url){
    if(previewImg){ previewImg.src = url; previewImg.style.display = 'block'; }
    if(previewInitials) previewInitials.style.display = 'none';
    if(removeBtn) removeBtn.style.display = '';
  } else {
    if(previewImg){ previewImg.src = ''; previewImg.style.display = 'none'; }
    if(previewInitials){ previewInitials.style.display = ''; previewInitials.textContent = initial; }
    if(removeBtn) removeBtn.style.display = 'none';
  }

  // Avatar chico en topbar (botón con dropdown)
  const btn = document.getElementById('user-avatar-btn');
  if(btn){
    if(url){
      btn.innerHTML = `<img src="${url}" alt="Avatar">`;
    } else {
      btn.innerHTML = `<span id="client-initial">${initial}</span>`;
    }
  }
};

// Cerrar modal con ESC
document.addEventListener('keydown', e => {
  if(e.key === 'Escape' && document.getElementById('avatar-modal')?.classList.contains('open')){
    closeAvatarModal();
  }
});

// ============================================

window.setTheme = function(theme){
  if(theme === 'light'){
    document.body.classList.add('theme-light');
  } else {
    document.body.classList.remove('theme-light');
  }
  try { localStorage.setItem('theme', theme); } catch(e){}
  // Reinit charts if any (para que tomen colores correctos)
  Object.keys(window._chartBrief ? {brief:true} : {}).forEach(k => {
    // Reset charts
    window._chartBrief?.destroy();
    window._chartBrief = null;
  });
  if(window.currentView === 'brief') loadBriefData();
  // Update buttons if en settings
  if(window.currentView === 'settings'){
    const isLight = theme === 'light';
    document.getElementById('theme-dark-btn').className = isLight ? 'btn ghost' : 'btn primary';
    document.getElementById('theme-light-btn').className = isLight ? 'btn primary' : 'btn ghost';
  }
  window.toast('✓ Tema actualizado', theme === 'light' ? 'Modo claro' : 'Modo oscuro', 'success');
};

// ============================================
// SERVICES CRUD (tab Mis Servicios)
// ============================================
window.loadServices = async function(){
  try {
    const services = await sbGet('services', `client_id=eq.${window.CLIENT_ID}&select=*&order=orden.asc,created_at.desc`);
    window.CLIENT_SERVICES = services;
    const tbody = document.getElementById('svc-tbody');
    const count = document.getElementById('svc-count');
    if(!tbody) return;

    const activos = services.filter(s => s.activo).length;
    count.textContent = `${services.length} servicios · ${activos} activos`;

    if(services.length === 0){
      tbody.innerHTML = '<tr><td colspan="6" class="dim" style="text-align:center;padding:30px;">Aún no tienes servicios. Crea el primero para empezar.</td></tr>';
      return;
    }

    const moneda = window.currentClient?.moneda || 'USD';
    tbody.innerHTML = services.map(s => {
      const precio = (s.precio_cents / 100).toLocaleString('en', { minimumFractionDigits: 2 });
      return `
        <tr>
          <td><strong>${escapeHtml(s.nombre)}</strong>${s.descripcion ? `<div class="dim" style="font-size:10px;">${escapeHtml(s.descripcion)}</div>` : ''}</td>
          <td class="dim">${escapeHtml(s.categoria || '—')}</td>
          <td class="num">${moneda} ${precio}</td>
          <td class="num dim">${s.duracion_min} min</td>
          <td><span class="chip chip-${s.activo?'ok':'off'}"><span class="chip-dot"></span>${s.activo?'ACTIVO':'INACTIVO'}</span></td>
          <td style="text-align:right;"><button class="icon-btn" onclick="editService('${s.id}')" title="Editar">✎</button> <button class="icon-btn" onclick="toggleService('${s.id}')" title="${s.activo?'Desactivar':'Activar'}">${s.activo?'○':'●'}</button> <button class="icon-btn" onclick="deleteService('${s.id}')" title="Eliminar">✕</button></td>
        </tr>`;
    }).join('');
  } catch(err){ console.error('services error:', err); }
};

window.openNewService = function(){
  const moneda = window.currentClient?.moneda || 'USD';
  const body = `
    <div class="field"><div class="field-label">NOMBRE</div><input class="field-input" id="svc-nombre" placeholder="Ej: Limpieza facial"></div>
    <div class="field"><div class="field-label">DESCRIPCIÓN <span class="dim">(opcional)</span></div><textarea class="field-textarea" id="svc-desc" placeholder="Detalle del servicio..."></textarea></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
      <div class="field"><div class="field-label">CATEGORÍA</div><input class="field-input" id="svc-cat" placeholder="Estética, Consultas..."></div>
      <div class="field"><div class="field-label">DURACIÓN (min)</div><input class="field-input" id="svc-dur" type="number" value="60" min="5"></div>
    </div>
    <div class="field"><div class="field-label">PRECIO (${moneda})</div><input class="field-input" id="svc-precio" type="number" placeholder="45.00" step="0.01" min="0"></div>
  `;
  showModal('Nuevo servicio', body, '<button class="btn ghost" onclick="closeModal()">Cancelar</button><button class="btn primary" onclick="saveService()">Guardar</button>');
};

window.editService = function(id){
  const s = window.CLIENT_SERVICES.find(x => x.id === id);
  if(!s) return;
  const moneda = window.currentClient?.moneda || 'USD';
  const body = `
    <div class="field"><div class="field-label">NOMBRE</div><input class="field-input" id="svc-nombre" value="${escapeHtml(s.nombre)}"></div>
    <div class="field"><div class="field-label">DESCRIPCIÓN</div><textarea class="field-textarea" id="svc-desc">${escapeHtml(s.descripcion || '')}</textarea></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
      <div class="field"><div class="field-label">CATEGORÍA</div><input class="field-input" id="svc-cat" value="${escapeHtml(s.categoria || '')}"></div>
      <div class="field"><div class="field-label">DURACIÓN (min)</div><input class="field-input" id="svc-dur" type="number" value="${s.duracion_min}" min="5"></div>
    </div>
    <div class="field"><div class="field-label">PRECIO (${moneda})</div><input class="field-input" id="svc-precio" type="number" value="${(s.precio_cents/100).toFixed(2)}" step="0.01" min="0"></div>
  `;
  showModal('Editar servicio', body, `<button class="btn ghost" onclick="closeModal()">Cancelar</button><button class="btn primary" onclick="saveService('${id}')">Guardar cambios</button>`);
};

window.saveService = async function(id){
  const payload = {
    client_id: window.CLIENT_ID,
    nombre: document.getElementById('svc-nombre').value,
    descripcion: document.getElementById('svc-desc').value || null,
    categoria: document.getElementById('svc-cat').value || null,
    duracion_min: parseInt(document.getElementById('svc-dur').value) || 60,
    precio_cents: Math.round(parseFloat(document.getElementById('svc-precio').value) * 100) || 0,
    moneda: window.currentClient?.moneda || 'USD',
    activo: true
  };
  try {
    if(id) await sbPatch('services', id, payload);
    else await sbInsert('services', payload);
    closeModal();
    await loadServices();
    window.toast(id ? '✓ Servicio actualizado' : '✓ Servicio creado', payload.nombre, 'success');
  } catch(err){ window.toast('Error', err.message, 'err'); }
};

window.toggleService = async function(id){
  const s = window.CLIENT_SERVICES.find(x => x.id === id);
  if(!s) return;
  try {
    await sbPatch('services', id, { activo: !s.activo });
    await loadServices();
  } catch(err){ window.toast('Error', err.message, 'err'); }
};

window.deleteService = async function(id){
  const s = window.CLIENT_SERVICES.find(x => x.id === id);
  if(!s) return;
  if(!confirm(`¿Eliminar "${s.nombre}"? Esta acción no se puede deshacer.`)) return;
  try {
    const r = await sbFetch(`${SUPABASE_URL}/rest/v1/services?id=eq.${id}`, { method:'DELETE', headers: sbHeaders() });
    if(!r.ok) throw new Error('No se pudo eliminar');
    await loadServices();
    window.toast('✓ Servicio eliminado', s.nombre, 'success');
  } catch(err){ window.toast('Error', err.message, 'err'); }
};

// ============================================
// SOPORTE · Reportar un problema (form directo)
// v2.1.10: modal con 2 opciones (chatear / reportar)
// v2.1.13: simplificado a UNA sola opción "Reportar un problema" (decisión usuario)
// ============================================
window.openSupport = function(){
  const c = window.currentClient || {};
  const empresa = c.empresa || c.nombre || 'tu negocio';
  const placeholder = 'Ej: Al hacer click en "Marcar pagada" no pasa nada. Antes funcionaba.\n\nPasos para reproducir:\n1. ...\n2. ...';

  const body = `
    <div style="font-size:12px;color:var(--text2);margin-bottom:14px;line-height:1.5;">
      ¿Algo no funciona en <strong style="color:var(--text);">${escapeHtml(empresa)}</strong>?<br>
      Cuéntanos qué pasó. Te respondemos por email en menos de 24h.
    </div>
    <div class="field">
      <div class="field-label">ASUNTO</div>
      <input class="field-input" id="sup-subject" placeholder="Ej: Bug al confirmar cita" maxlength="200">
    </div>
    <div class="field">
      <div class="field-label">MENSAJE</div>
      <textarea class="field-textarea" id="sup-message" rows="6" placeholder="${escapeHtml(placeholder)}" maxlength="5000"></textarea>
    </div>
    <div style="padding:10px;background:var(--card2);border-radius:6px;font-size:10px;color:var(--text3);line-height:1.6;">
      📎 Adjuntamos automáticamente:<br>
      &nbsp;&nbsp;· Versión: <strong style="color:var(--text2);">v${escapeHtml(window._appVersion || '?')}</strong><br>
      &nbsp;&nbsp;· Vista actual: <strong style="color:var(--text2);">${escapeHtml(window.currentView || '?')}</strong><br>
      &nbsp;&nbsp;· Sistema: <strong style="color:var(--text2);">${escapeHtml((navigator.platform || '').slice(0, 30))}</strong><br>
      ${window._lastErrorMsg ? `&nbsp;&nbsp;· Último error: <strong style="color:var(--danger);">${escapeHtml(window._lastErrorMsg.slice(0,100))}</strong>` : ''}
    </div>
    <div style="padding:10px;background:var(--card2);border-radius:6px;font-size:10px;color:var(--text3);margin-top:10px;line-height:1.5;">
      📺 Tutoriales en video disponibles en <strong style="color:var(--text2);">dominiosystem.com</strong>
    </div>
  `;
  showModal('Reportar un problema', body, `
    <button class="btn ghost" onclick="closeModal()">Cancelar</button>
    <button class="btn primary" onclick="submitSupport('bug')">Enviar reporte</button>
  `);
};

// Compat: openSupportForm(kind) sigue exportado por si algún botón externo lo llama
window.openSupportForm = function(_kind){ window.openSupport(); };

window.submitSupport = async function(kind){
  const subjectEl = document.getElementById('sup-subject');
  const messageEl = document.getElementById('sup-message');
  const subject = (subjectEl?.value || '').trim();
  const message = (messageEl?.value || '').trim();

  if(subject.length < 3){ window.toast('Asunto requerido', 'Mínimo 3 caracteres', 'warn'); return; }
  if(message.length < 5){ window.toast('Mensaje muy corto', 'Cuéntanos un poco más', 'warn'); return; }

  // Disable submit button mientras enviamos
  const submitBtn = document.querySelector('.modal-foot .btn.primary');
  if(submitBtn){ submitBtn.disabled = true; submitBtn.textContent = 'Enviando…'; }

  try {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/support-ticket`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + window.ACCESS_TOKEN,
        'apikey': SUPABASE_ANON,
      },
      body: JSON.stringify({
        kind,
        subject,
        message,
        context: {
          app_version: window._appVersion || null,
          user_agent: navigator.userAgent,
          view: window.currentView || null,
          last_error: window._lastErrorMsg || null,
        }
      }),
    });
    const data = await r.json().catch(() => ({}));
    if(!r.ok || !data.success){
      throw new Error(data.error || `HTTP ${r.status}`);
    }
    closeModal();
    window.toast(
      kind === 'bug' ? '✓ Reporte enviado' : '✓ Mensaje enviado',
      'Te respondemos a tu email en menos de 24h',
      'success'
    );
  } catch(err){
    if(submitBtn){ submitBtn.disabled = false; submitBtn.textContent = kind === 'bug' ? 'Enviar reporte' : 'Enviar mensaje'; }
    window.toast('No se pudo enviar', err.message || 'Reintenta en un momento', 'err');
  }
};

// v2.1.39 — listener duplicado eliminado, ahora consolidado en _wireSentryHandlers
// arriba (línea ~7). _lastErrorMsg se setea ahí mismo.

// ============================================
// REPORTES EJECUTIVOS · v2.1.21 — lectura real + PDF on-demand
// ============================================
const _REPORT_COOLDOWN_MS = 10 * 60 * 1000; // 10 min entre generaciones manuales

window.loadReports = async function(){
  try {
    const tbody = document.getElementById('reports-tbody');
    if(!tbody) return;
    const reports = await sbGet('reports',
      `client_id=eq.${window.CLIENT_ID}&select=id,period,kind,status,file_path,size_bytes,generated_at,meta&order=period.desc&limit=24`);

    document.getElementById('reports-count').textContent =
      reports.length === 0
        ? 'Sin reportes generados aún'
        : `${reports.length} reporte${reports.length === 1 ? '' : 's'} disponible${reports.length === 1 ? '' : 's'}`;

    if(reports.length === 0){
      tbody.innerHTML = '<tr><td colspan="5" class="dim" style="text-align:center;padding:20px;">Aún no hay reportes generados.<br><span style="font-size:11px;color:var(--text3);">El primer reporte mensual se generará el día 1 del próximo mes y te llegará por email.</span></td></tr>';
      return;
    }
    tbody.innerHTML = reports.map(r => {
      const periodo = window.fmtPlainDateTZ(r.period, { month: 'long', year: 'numeric' });
      const periodoLbl = periodo.charAt(0).toUpperCase() + periodo.slice(1);
      const generado = r.generated_at
        ? window.fmtDateTZ(r.generated_at, { day: 'numeric', month: 'short' })
        : '—';
      const sizeMB = r.size_bytes ? (r.size_bytes / 1048576).toFixed(1) : '—';
      const tipoLbl = r.kind === 'monthly' ? 'Mensual' : r.kind === 'weekly' ? 'Semanal' : (r.kind || 'Mensual');
      return `
        <tr>
          <td><strong>${escapeHtml(periodoLbl)}</strong></td>
          <td class="dim">${generado}</td>
          <td>${tipoLbl}</td>
          <td class="num dim">${sizeMB} MB</td>
          <td><button class="btn ghost" style="font-size:11px;padding:5px 12px;" onclick="downloadReport('${r.id}')">📥 Descargar PDF</button></td>
        </tr>`;
    }).join('');
  } catch(err){
    console.error('[Reports] error:', err);
    window.toast?.('Reportes no se pudo cargar', err.message || 'Error de conexión', 'err');
    window.electronAPI?.sentryCapture?.(err);
  }
};

// Descarga real: genera PDF on-demand con jsPDF usando data del periodo
window.downloadReport = async function(reportId){
  try {
    const reports = await sbGet('reports', `id=eq.${reportId}&select=*`);
    if(!reports.length){ window.toast?.('Reporte no encontrado', null, 'warn'); return; }
    const r = reports[0];
    const meta = r.meta || {};
    const c = window.currentClient || {};
    const moneda = c.moneda || 'MXN';
    const monedaSym = { USD:'$', MXN:'$', DOP:'RD$', EUR:'€', COP:'$' }[moneda] || '$';
    const periodDate = new Date(r.period + 'T12:00:00');
    const periodLbl = window.fmtPlainDateTZ(r.period, { month: 'long', year: 'numeric' });
    const periodLblCap = periodLbl.charAt(0).toUpperCase() + periodLbl.slice(1);
    const periodIso = r.period;

    // Trae appointments + leads del mes para enriquecer el PDF
    const monthStart = `${periodIso}T00:00:00`;
    const nextMonth = new Date(periodDate.getFullYear(), periodDate.getMonth() + 1, 1).toISOString().split('T')[0] + 'T00:00:00';
    const [apts, paidApts, leadsArr] = await Promise.all([
      sbGet('appointments', `client_id=eq.${window.CLIENT_ID}&created_at=gte.${monthStart}&created_at=lt.${nextMonth}&select=id,estado,pagado,neto_cents,precio_cents,servicio,lead_id`),
      sbGet('appointments', `client_id=eq.${window.CLIENT_ID}&pagado=eq.true&paid_at=gte.${monthStart}&paid_at=lt.${nextMonth}&select=neto_cents,precio_cents,metodo_pago,servicio`),
      sbGet('leads', `client_id=eq.${window.CLIENT_ID}&created_at=gte.${monthStart}&created_at=lt.${nextMonth}&select=id,fuente`)
    ]);
    const totalCents = paidApts.reduce((s,a) => s + (a.neto_cents || a.precio_cents || 0), 0);
    const totalLbl = (totalCents / 100).toLocaleString('en', { minimumFractionDigits: 2 });
    const ariaCount = apts.filter(a => a.lead_id && ['confirmed','completed'].includes(a.estado)).length;
    const completedCount = apts.filter(a => a.estado === 'completed').length;
    const conversionRate = leadsArr.length > 0 ? ((apts.filter(a => a.estado !== 'cancelled' && a.estado !== 'no_show').length / leadsArr.length) * 100).toFixed(1) : '0.0';
    // Top servicios
    const svcRev = {};
    paidApts.forEach(a => {
      const k = a.servicio || '—';
      svcRev[k] = (svcRev[k] || 0) + (a.neto_cents || a.precio_cents || 0);
    });
    const topSvc = Object.entries(svcRev).sort((a,b) => b[1]-a[1]).slice(0,5);
    // Métodos
    const metodos = {};
    paidApts.forEach(a => { const m = a.metodo_pago || 'sin_metodo'; metodos[m] = (metodos[m] || 0) + 1; });

    if(typeof window.jspdf === 'undefined'){
      window.toast?.('PDF no disponible', 'Librería no cargada — reintenta', 'err');
      return;
    }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const C_TEXT = [20,20,20], C_DIM = [120,120,120], C_FAINT = [180,180,180],
          C_ACCENT = [12,12,12], C_SUCCESS = [50,150,95], C_BORDER = [220,220,220];
    const PAGE_W = doc.internal.pageSize.getWidth();
    const PAGE_H = doc.internal.pageSize.getHeight();
    const M = 15;

    // HEADER
    doc.setFont('helvetica','bold').setFontSize(15).setTextColor(...C_TEXT);
    doc.text('Dominio System', M, M + 4);
    doc.setFont('courier','normal').setFontSize(8).setTextColor(...C_DIM);
    doc.text('automation plattform', M, M + 9);
    doc.setFont('helvetica','bold').setFontSize(11).setTextColor(...C_TEXT);
    doc.text('REPORTE EJECUTIVO', PAGE_W - M, M + 4, { align: 'right' });
    doc.setFont('helvetica','normal').setFontSize(9).setTextColor(...C_DIM);
    doc.text(periodLblCap, PAGE_W - M, M + 9, { align: 'right' });
    doc.setDrawColor(...C_BORDER).setLineWidth(0.3);
    doc.line(M, M + 13, PAGE_W - M, M + 13);

    // Cliente
    doc.setFont('helvetica','normal').setFontSize(11).setTextColor(...C_TEXT);
    doc.text(c.empresa || '—', M, M + 22);
    doc.setFontSize(9).setTextColor(...C_DIM);
    if(c.industria) doc.text(c.industria, M, M + 27);

    // KPIs principales (3 columnas)
    let y = M + 38;
    doc.setFont('courier','normal').setFontSize(8).setTextColor(...C_FAINT);
    doc.text('RESUMEN EJECUTIVO', M, y); y += 8;

    const drawKpi = (x, label, value, color) => {
      doc.setFont('helvetica','normal').setFontSize(8).setTextColor(...C_DIM);
      doc.text(label, x, y);
      doc.setFont('helvetica','bold').setFontSize(14).setTextColor(...(color || C_TEXT));
      doc.text(value, x, y + 6);
    };
    const colW = (PAGE_W - 2*M) / 4;
    drawKpi(M,            'INGRESOS',     `${monedaSym}${totalLbl}`, C_SUCCESS);
    drawKpi(M + colW,     'CITAS',        String(completedCount + apts.filter(a => a.estado === 'confirmed').length));
    drawKpi(M + colW * 2, 'LEADS',        String(leadsArr.length));
    drawKpi(M + colW * 3, 'CONVERSIÓN',   `${conversionRate}%`);
    y += 14;

    // ARIA highlight
    doc.setDrawColor(...C_BORDER).setFillColor(248, 248, 248);
    doc.rect(M, y, PAGE_W - 2*M, 14, 'F');
    doc.setFont('helvetica','bold').setFontSize(10).setTextColor(...C_TEXT);
    doc.text('Automatización ARIA', M + 4, y + 6);
    doc.setFont('helvetica','normal').setFontSize(9).setTextColor(...C_DIM);
    doc.text(
      `${ariaCount} citas cerradas automáticamente por ARIA en ${periodLblCap}`,
      M + 4, y + 11
    );
    y += 20;

    // Top servicios
    if(topSvc.length > 0){
      doc.setFont('courier','normal').setFontSize(8).setTextColor(...C_FAINT);
      doc.text('TOP 5 SERVICIOS POR INGRESO', M, y); y += 6;
      doc.autoTable({
        startY: y,
        head: [['Servicio', `Ingreso (${moneda})`]],
        body: topSvc.map(([n, c]) => [n, `${monedaSym}${(c/100).toLocaleString('en',{minimumFractionDigits:2})}`]),
        theme: 'grid',
        styles: { font: 'helvetica', fontSize: 9, cellPadding: 2.5, textColor: C_TEXT, lineColor: C_BORDER, lineWidth: 0.2 },
        headStyles: { fillColor: C_ACCENT, textColor: [255,255,255], fontStyle: 'bold', fontSize: 8 },
        columnStyles: { 1: { halign: 'right', textColor: C_SUCCESS, fontStyle: 'bold', cellWidth: 40 } },
        margin: { left: M, right: M },
        didDrawPage: (data) => {
          doc.setFont('courier','normal').setFontSize(7).setTextColor(...C_FAINT);
          const today = window.fmtDateTZ(new Date(), { day:'2-digit', month:'short', year:'numeric' });
          doc.text(`Generado por Dominio System · ${today} · dominiosystem.com`, M, PAGE_H - 8);
          const pageNum = doc.internal.getNumberOfPages();
          doc.text(`Página ${data.pageNumber} de ${pageNum}`, PAGE_W - M, PAGE_H - 8, { align: 'right' });
        },
      });
      y = doc.lastAutoTable.finalY + 8;
    }

    // Métodos de pago
    if(Object.keys(metodos).length > 0){
      doc.setFont('courier','normal').setFontSize(8).setTextColor(...C_FAINT);
      doc.text('DESGLOSE DE PAGOS', M, y); y += 6;
      doc.setFont('helvetica','normal').setFontSize(10).setTextColor(...C_DIM);
      Object.entries(metodos).forEach(([m, n]) => {
        doc.text(`• ${m}: ${n} pago${n===1?'':'s'}`, M + 2, y);
        y += 5;
      });
      y += 4;
    }

    // Footer (si no se dibujó por autoTable)
    if(!doc.lastAutoTable){
      doc.setFont('courier','normal').setFontSize(7).setTextColor(...C_FAINT);
      const today = window.fmtDateTZ(new Date(), { day:'2-digit', month:'short', year:'numeric' });
      doc.text(`Generado por Dominio System · ${today} · dominiosystem.com`, M, PAGE_H - 8);
      doc.text('Página 1 de 1', PAGE_W - M, PAGE_H - 8, { align: 'right' });
    }

    const filename = `dominio-reporte-${periodIso.slice(0,7)}.pdf`;
    doc.save(filename);
    window.toast?.('✓ Reporte descargado', `${periodLblCap} · ${filename}`, 'success');
  } catch(err){
    console.error('[DownloadReport] error:', err);
    window.toast?.('Error al descargar', err.message || 'No se pudo generar el PDF', 'err');
    window.electronAPI?.sentryCapture?.(err);
  }
};

// `window.requestReport` eliminado en v2.2.2 — reportes solo se generan automáticamente
// el día 1 de cada mes via DS2-14 · monthly_report. El usuario ya no puede invocarlos
// manualmente desde el dashboard porque no aporta valor (los datos del mes en curso ya
// están disponibles en el dashboard real-time, y el PDF mensual cubre todo el mes pasado).

// Refresh manual de Ingresos (con cooldown visual 1.2s para evitar spam)
let _ingRefreshBusy = false;
window.refreshIngresos = async function(){
  if (_ingRefreshBusy) return;
  const btn = document.getElementById('ing-refresh-btn');
  _ingRefreshBusy = true;
  if (btn){
    btn.disabled = true;
    btn.style.opacity = '0.5';
    btn.textContent = '…';
  }
  try {
    await loadIngresos();
    window.toast && window.toast('✓ Ingresos actualizados', null, 'success');
  } catch(err){
    window.toast && window.toast('Error', err.message || 'No se pudo refrescar', 'err');
  } finally {
    setTimeout(() => {
      _ingRefreshBusy = false;
      if (btn){
        btn.disabled = false;
        btn.style.opacity = '';
        btn.textContent = '↻';
      }
    }, 1200);
  }
};

// ============================================
// AUTO-UPDATER (Fase 1: check-only sin auto-install)
// ============================================
// URL de descarga directa en el sitio. Cuando haya nueva versión, mostramos
// toast + botón que abre el DMG en el navegador (sin intentar auto-install,
// porque requiere cert Apple Developer firmado que aún no tenemos).
const UPDATE_DOWNLOAD_BASE = 'https://dominiosystem.com/downloads';

let _updateState = { currentVersion: null, latestVersion: null, hasUpdate: false };

async function _hydrateAppVersion(){
  try {
    if(window.electronAPI?.getAppVersion){
      _updateState.currentVersion = await window.electronAPI.getAppVersion();
      const el = document.getElementById('app-version-display');
      if(el) el.textContent = `v${_updateState.currentVersion}`;
    }
  } catch(e){ console.warn('[update] getAppVersion falló:', e.message); }
}

// Cache de arch obtenida del main process (process.arch es confiable, userAgent no lo es)
let _archCache = null;
async function _getArch(){
  if(_archCache) return _archCache;
  try {
    if(window.electronAPI?.getArch){
      _archCache = await window.electronAPI.getArch();
      return _archCache;
    }
  } catch(_){}
  // Fallback: userAgent (frágil, devuelve 'x64' aunque el binario sea arm64 en Mac)
  const isArmFallback = navigator.userAgent.includes('ARM64') || navigator.userAgent.includes('arm64');
  return isArmFallback ? 'arm64' : 'x64';
}

async function _buildDownloadUrl(){
  const arch = await _getArch();
  const suffix = arch === 'arm64' ? '-arm64.dmg' : '.dmg';
  const ver = _updateState.latestVersion;
  if(!ver) return UPDATE_DOWNLOAD_BASE;
  return `${UPDATE_DOWNLOAD_BASE}/Dominio-${ver}${suffix}`;
}

function _showUpdateAvailableToast(info){
  const ver = info?.version || 'nueva';
  const container = document.getElementById('toast-container');
  if(!container) return;
  const t = document.createElement('div');
  t.className = 'toast aria';
  t.style.cursor = 'pointer';
  t.innerHTML = `
    <div class="toast-title">📦 Actualización v${ver} disponible</div>
    <div class="toast-body">Tu versión: v${_updateState.currentVersion || '?'} · Click para descargar</div>
  `;
  t.addEventListener('click', async (e) => {
    e.stopPropagation();
    const url = await _buildDownloadUrl();
    if(window.electronAPI?.openExternal) window.electronAPI.openExternal(url);
    else window.open(url, '_blank');
  });
  container.appendChild(t);
  // El toast persiste 30s (más que los normales 4.5s)
  setTimeout(() => t.remove(), 30_000);
}

function _initUpdaterListeners(){
  if(!window.electronAPI?.onUpdateAvailable) return;

  window.electronAPI.onUpdateAvailable((info) => {
    _updateState.latestVersion = info?.version;
    _updateState.hasUpdate = true;
    _showUpdateAvailableToast(info);
    // Reflejar en el panel de Settings si está visible
    const btn = document.getElementById('check-update-btn');
    if(btn) btn.textContent = `📦 Actualizar a v${info?.version}`;
  });

  window.electronAPI.onUpdateNotAvailable?.((_info) => {
    _updateState.hasUpdate = false;
    const btn = document.getElementById('check-update-btn');
    if(btn){ btn.textContent = '✓ Última versión'; btn.disabled = true;
      setTimeout(() => { btn.disabled = false; btn.textContent = '🔍 Buscar actualizaciones'; }, 3000);
    }
  });

  window.electronAPI.onUpdateError?.((info) => {
    console.warn('[update] error:', info?.message);
    // No spameamos al usuario con errores transitorios de red.
    // Solo log. Si el user hace check manual sí le decimos.
  });

  window.electronAPI.onUpdateDownloaded?.((info) => {
    // Este path solo se usa si autoDownload=true (futuro, con cert)
    const container = document.getElementById('toast-container');
    if(!container) return;
    const t = document.createElement('div');
    t.className = 'toast success';
    t.innerHTML = `
      <div class="toast-title">✓ Actualización v${info?.version} lista</div>
      <div class="toast-body">Click para reiniciar e instalar</div>
    `;
    t.style.cursor = 'pointer';
    t.addEventListener('click', () => window.electronAPI.installUpdate?.());
    container.appendChild(t);
  });
}

window.checkForUpdatesManual = async function(){
  const btn = document.getElementById('check-update-btn');
  if(btn){ btn.disabled = true; btn.textContent = 'Buscando…'; }
  try {
    if(!window.electronAPI?.checkForUpdates){
      window.toast('No disponible', 'Auto-updater solo funciona en la app instalada', 'warn');
      return;
    }
    const result = await window.electronAPI.checkForUpdates();
    if(!result?.ok){
      const errStr = String(result?.error || '');
      // 404 = manifest no deployado todavía → tratar como "estás en última versión"
      const is404 = /\b404\b/.test(errStr) || /Cannot find channel/i.test(errStr) || /NOT_FOUND/i.test(errStr);
      if(is404){
        window.toast('✓ Última versión', `Estás en v${result.current || _updateState.currentVersion || '?'}`, 'success');
      } else {
        // Errores reales de red/servidor (no 404) los seguimos mostrando
        window.toast('Sin conexión', 'No se pudo verificar actualizaciones. Revisa tu conexión.', 'warn');
        console.warn('[update] check manual error:', errStr);
      }
      return;
    }
    if(result.updateInfo && result.updateInfo.version && result.updateInfo.version !== result.current){
      // _showUpdateAvailableToast ya se disparó via onUpdateAvailable
      // (electron-updater emite 'update-available' automáticamente)
    } else {
      window.toast('✓ Última versión', `Estás en v${result.current}`, 'success');
    }
  } catch(err){
    window.toast('Error', err.message || 'No se pudo verificar', 'err');
  } finally {
    setTimeout(() => {
      if(btn && !_updateState.hasUpdate){
        btn.disabled = false;
        btn.textContent = '🔍 Buscar actualizaciones';
      }
    }, 2000);
  }
};

// ============================================
// BOOT
// ============================================
document.addEventListener('DOMContentLoaded', async () => {
  _initUpdaterListeners();
  await _hydrateAppVersion();
  boot();
});
