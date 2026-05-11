// ═══════════════════════════════════════════════════════════════════
// Idle auto-logout · Sprint seguridad (2026-04-23)
// ═══════════════════════════════════════════════════════════════════
// Cierra sesión automáticamente tras N minutos de inactividad del usuario.
//
// Qué cuenta como actividad:
//   · mousemove, keydown, click, wheel, touchstart, scroll (cualquier
//     panel del dashboard)
//
// Comportamiento:
//   · Si el usuario no hace nada por IDLE_MINUTES → 60s antes muestra toast
//     warning con botón "Seguir conectado". Si ignora, limpia sesión y
//     vuelve a login.
//   · Configurable desde localStorage.idleMinutes (default 30, rango 5-120).
//   · Se expone window.idleLogout.setMinutes(n) para Settings.
//
// Depends on: window.electronAPI?.logout (main.js), window.toast
// ═══════════════════════════════════════════════════════════════════

const IDLE = {
  minutes: 30,
  warnLeadSec: 60,        // avisar 60s antes
  lastActivity: Date.now(),
  warningShown: false,
  warningToastEl: null,
  logoutTimer: null,
  warningTimer: null,
  checkInterval: null,
};

const _MIN_MINUTES = 5;
const _MAX_MINUTES = 120;

function _resetActivity(){
  IDLE.lastActivity = Date.now();
  if(IDLE.warningShown){
    // Si ya había warning visible, cancelarlo
    _dismissWarning();
  }
  _scheduleChecks();
}

function _dismissWarning(){
  IDLE.warningShown = false;
  if(IDLE.warningToastEl && IDLE.warningToastEl.parentNode){
    IDLE.warningToastEl.remove();
  }
  IDLE.warningToastEl = null;
  if(IDLE.logoutTimer){ clearTimeout(IDLE.logoutTimer); IDLE.logoutTimer = null; }
  if(IDLE.warningTimer){ clearTimeout(IDLE.warningTimer); IDLE.warningTimer = null; }
}

function _showWarningToast(secondsLeft){
  IDLE.warningShown = true;
  const container = document.getElementById('toast-container');
  if(!container){
    // Sin contenedor → fallback directo: hacer logout al vencer
    console.warn('[idleLogout] No toast-container, usando fallback');
    return;
  }
  const t = document.createElement('div');
  t.className = 'toast warn';
  t.style.cursor = 'pointer';
  t.innerHTML = `
    <div class="toast-title">⏱ Sesión por cerrar</div>
    <div class="toast-body">Inactividad detectada. Cerraremos en <span id="idle-countdown">${secondsLeft}</span>s. Click aquí para continuar.</div>
  `;
  t.addEventListener('click', (e) => {
    e.stopPropagation();
    _resetActivity();
    window.toast?.('✓ Sesión activa', 'Timer reiniciado', 'success');
  });
  container.appendChild(t);
  IDLE.warningToastEl = t;

  // Cuenta regresiva visual
  let remaining = secondsLeft;
  const cd = setInterval(() => {
    remaining -= 1;
    const el = document.getElementById('idle-countdown');
    if(el) el.textContent = remaining;
    if(remaining <= 0) clearInterval(cd);
  }, 1000);
}

async function _performLogout(){
  console.log('[idleLogout] Ejecutando logout por inactividad');
  try {
    window.toast?.('🔒 Sesión cerrada', 'Cierre por inactividad', 'warn');
  } catch(_){}
  // Esperar un beat para que el toast aparezca antes de redirect
  setTimeout(() => {
    if(window.electronAPI?.logout){
      window.electronAPI.logout();
    } else {
      try { localStorage.removeItem('last-view'); } catch(_){}
      window.location.href = 'login.html';
    }
  }, 400);
}

function _scheduleChecks(){
  // Limpiar timers previos
  if(IDLE.logoutTimer){ clearTimeout(IDLE.logoutTimer); IDLE.logoutTimer = null; }
  if(IDLE.warningTimer){ clearTimeout(IDLE.warningTimer); IDLE.warningTimer = null; }

  const totalMs = IDLE.minutes * 60 * 1000;
  const warnAtMs = Math.max(0, totalMs - IDLE.warnLeadSec * 1000);

  IDLE.warningTimer = setTimeout(() => {
    if(IDLE.warningShown) return;
    _showWarningToast(IDLE.warnLeadSec);
  }, warnAtMs);

  IDLE.logoutTimer = setTimeout(() => {
    _performLogout();
  }, totalMs);
}

function _clampMinutes(n){
  const x = parseInt(n, 10);
  if(!Number.isFinite(x)) return 30;
  return Math.max(_MIN_MINUTES, Math.min(_MAX_MINUTES, x));
}

function _loadPreference(){
  try {
    const stored = localStorage.getItem('idleMinutes');
    if(stored != null){
      IDLE.minutes = _clampMinutes(stored);
    }
  } catch(_){ /* localStorage bloqueado */ }
}

function setMinutes(n){
  IDLE.minutes = _clampMinutes(n);
  try { localStorage.setItem('idleMinutes', String(IDLE.minutes)); } catch(_){}
  _resetActivity(); // aplica nuevo timer
  console.log(`[idleLogout] Minutos actualizados: ${IDLE.minutes}`);
  return IDLE.minutes;
}

function getMinutes(){ return IDLE.minutes; }

function start(){
  _loadPreference();

  // Escuchar actividad — throttled por activity reset en 1s mínimo
  let lastReset = 0;
  const handler = () => {
    const now = Date.now();
    if(now - lastReset < 1000) return; // throttle 1s
    lastReset = now;
    _resetActivity();
  };

  ['mousemove','keydown','click','wheel','touchstart','scroll'].forEach(ev => {
    document.addEventListener(ev, handler, { passive: true, capture: true });
  });

  // Primer timer
  _scheduleChecks();

  console.log(`[idleLogout] Auto-logout activo: ${IDLE.minutes} min`);
}

function stop(){
  if(IDLE.logoutTimer){ clearTimeout(IDLE.logoutTimer); IDLE.logoutTimer = null; }
  if(IDLE.warningTimer){ clearTimeout(IDLE.warningTimer); IDLE.warningTimer = null; }
  _dismissWarning();
}

// API pública
window.idleLogout = { start, stop, setMinutes, getMinutes };
