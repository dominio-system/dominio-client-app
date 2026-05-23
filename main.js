const { app, BrowserWindow, ipcMain, shell, nativeTheme, safeStorage } = require('electron');
const { autoUpdater } = require('electron-updater');
const Sentry = require('@sentry/electron/main');
const path = require('path');
const fs = require('fs');

// ── Sentry (error tracking) ─────────────────────────────────────────────────
// Debe inicializarse lo antes posible para capturar errores de arranque.
// El DSN es semi-público (queda en el binario); NO es secret como el service_role.
const SENTRY_DSN = 'https://fe808b6a8002aed80b9893cd68ed72c5@o4511273677422592.ingest.us.sentry.io/4511273688170496';

// Patrón regex para sanear claves sensibles (case-insensitive)
const _PII_KEY_RE = /(token|jwt|password|apikey|api[_-]?key|secret|authorization|session|refresh|credentials|bearer)/i;

function _scrubObject(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 5) return obj;
  if (Array.isArray(obj)) return obj.map(v => _scrubObject(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (_PII_KEY_RE.test(k)) { out[k] = '[REDACTED]'; continue; }
    if (v && typeof v === 'object') { out[k] = _scrubObject(v, depth + 1); continue; }
    if (typeof v === 'string' && /^[\w-]+\.[\w-]+\.[\w-]+$/.test(v) && v.length > 40) {
      // Parece un JWT sin que el key lo indique (heurística)
      out[k] = '[JWT-REDACTED]';
      continue;
    }
    out[k] = v;
  }
  return out;
}

Sentry.init({
  dsn: SENTRY_DSN,
  release: `dominio-client@${app.getVersion()}`,
  environment: process.env.NODE_ENV === 'development' ? 'development' : 'production',
  // No queremos tracing ni profiling (come quota del free plan).
  tracesSampleRate: 0,
  profilesSampleRate: 0,
  // PII scrubbing global antes de enviar cualquier evento.
  beforeSend(event) {
    try {
      if (event.request?.headers) event.request.headers = _scrubObject(event.request.headers);
      if (event.request?.data)    event.request.data    = _scrubObject(event.request.data);
      if (event.extra)            event.extra           = _scrubObject(event.extra);
      if (event.contexts)         event.contexts        = _scrubObject(event.contexts);
      if (event.breadcrumbs) {
        event.breadcrumbs = event.breadcrumbs.map(b => {
          if (b.data)    b.data    = _scrubObject(b.data);
          if (b.message) b.message = String(b.message).replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[JWT-REDACTED]');
          return b;
        });
      }
      // Evitar enviar el email del usuario aún si está en context
      if (event.user) {
        delete event.user.email;
        delete event.user.username;
        delete event.user.ip_address;
      }
    } catch (e) { console.warn('[Sentry] scrub error:', e.message); }
    return event;
  },
  // Filtrar ruido conocido (no útil, come quota)
  ignoreErrors: [
    'ResizeObserver loop limit exceeded',
    'ResizeObserver loop completed with undelivered notifications',
    'Non-Error promise rejection captured',
    'AbortError',
    'The operation was aborted',
    'Network request failed',
    'NetworkError',
    'Failed to fetch',
    /net::ERR_INTERNET_DISCONNECTED/,
    /net::ERR_NAME_NOT_RESOLVED/,
    /net::ERR_CONNECTION_/,
    /net::ERR_TIMED_OUT/,
  ],
});

console.log('[Sentry] inicializado · release:', `dominio-client@${app.getVersion()}`);

// ── Config ──────────────────────────────────────────────────────────────────
app.setName('Dominio System');
nativeTheme.themeSource = 'dark';

if (process.platform === 'darwin') {
  try {
    app.dock.setIcon(path.join(__dirname, 'assets', 'icon.png'));
  } catch (e) { console.warn('dock icon:', e.message); }
}

const SUPABASE_URL = 'https://ywlyuuddqitduqtdttgo.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl3bHl1dWRkcWl0ZHVxdGR0dGdvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwNDg2MzgsImV4cCI6MjA4OTYyNDYzOH0.vpjRNcQ_v2Vo9M2oQsCq95mSLOCctRf6cO4sWzpNCF8';

let loginWindow     = null;
let dashboardWindow = null;
let currentSession  = null;
let refreshTimer    = null;

// ── Session persistence (Keychain macOS / DPAPI Windows via safeStorage) ─────
function getSessionPath() {
  return path.join(app.getPath('userData'), 'session.bin');
}

function persistSession(session) {
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      console.warn('safeStorage not available; skipping persistence');
      return false;
    }
    const encrypted = safeStorage.encryptString(JSON.stringify(session));
    fs.writeFileSync(getSessionPath(), encrypted, { mode: 0o600 });
    return true;
  } catch (e) {
    console.error('persistSession failed:', e.message);
    return false;
  }
}

function loadPersistedSession() {
  try {
    const p = getSessionPath();
    if (!fs.existsSync(p)) return null;
    if (!safeStorage.isEncryptionAvailable()) return null;
    const session = JSON.parse(safeStorage.decryptString(fs.readFileSync(p)));
    const now = Math.floor(Date.now() / 1000);
    if (session.refreshTokenExpiresAt && session.refreshTokenExpiresAt < now) {
      clearPersistedSession();
      return null;
    }
    return session;
  } catch (e) {
    console.warn('loadPersistedSession failed:', e.message);
    return null;
  }
}

function clearPersistedSession() {
  try {
    const p = getSessionPath();
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch (e) {}
}

// ── Supabase Auth helpers ────────────────────────────────────────────────────
async function refreshAccessToken(refreshToken) {
  const resp = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { 'apikey': SUPABASE_ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Refresh failed: ${resp.status} ${err}`);
  }
  return resp.json();
}

async function signOutSupabase(accessToken) {
  try {
    await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
      method: 'POST',
      headers: { 'apikey': SUPABASE_ANON, 'Authorization': `Bearer ${accessToken}` },
    });
  } catch (e) {
    console.warn('signOutSupabase failed (ignoring):', e.message);
  }
}

// ── Auto-refresh timer ───────────────────────────────────────────────────────
function scheduleRefresh() {
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
  if (!currentSession || !currentSession.expiresAt) return;

  const now = Math.floor(Date.now() / 1000);
  const msUntilRefresh = Math.max((currentSession.expiresAt - now - 5 * 60) * 1000, 10 * 1000);
  console.log(`Next token refresh in ${Math.round(msUntilRefresh / 1000)}s`);

  refreshTimer = setTimeout(async () => {
    try {
      const fresh = await refreshAccessToken(currentSession.refreshToken);
      currentSession = {
        ...currentSession,
        accessToken: fresh.access_token,
        refreshToken: fresh.refresh_token || currentSession.refreshToken,
        expiresAt: fresh.expires_at || (Math.floor(Date.now() / 1000) + (fresh.expires_in || 3600)),
      };
      persistSession(currentSession);
      if (dashboardWindow) dashboardWindow.webContents.send('session-refreshed', currentSession);
      scheduleRefresh();
    } catch (e) {
      console.error('Auto-refresh failed, logging out:', e.message);
      doLogout();
    }
  }, msUntilRefresh);
}

// ── Ventanas ────────────────────────────────────────────────────────────────
function createLoginWindow() {
  if (loginWindow) { loginWindow.focus(); return; }
  loginWindow = new BrowserWindow({
    width: 460, height: 580,
    resizable: false, center: true,
    frame: false, transparent: false,
    backgroundColor: '#0c0c0c',
    titleBarStyle: 'hidden',
    icon: path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  loginWindow.loadFile('login.html');
  if (process.argv.includes('--dev')) loginWindow.webContents.openDevTools({ mode: 'detach' });
  loginWindow.on('closed', () => { loginWindow = null; });
}

function createDashboardWindow() {
  if (dashboardWindow) { dashboardWindow.focus(); return; }
  dashboardWindow = new BrowserWindow({
    width: 1280, height: 820,
    minWidth: 900, minHeight: 600,
    center: true,
    backgroundColor: '#0c0c0c',
    titleBarStyle: 'hiddenInset',
    icon: path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webviewTag: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // ── Permission handler: cámara para captura de foto de perfil (avatar modal) ──
  // macOS muestra el popup nativo "Dominio System quiere acceder a la cámara"
  // la primera vez. El texto del popup viene de NSCameraUsageDescription en
  // Info.plist (configurado en package.json → build.mac.extendInfo).
  // Solo permitimos "media" (cámara/mic). Cualquier otra petición (geolocation,
  // notifications, etc) la rechazamos por defecto.
  dashboardWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media') return callback(true);
    return callback(false);
  });
  dashboardWindow.webContents.session.setPermissionCheckHandler((webContents, permission) => {
    return permission === 'media';
  });

  // Ya NO se pasa token vía URL (patrón inseguro). Renderer lee via IPC getSession().
  dashboardWindow.loadFile('dashboard.html');
  if (process.argv.includes('--dev')) dashboardWindow.webContents.openDevTools({ mode: 'detach' });
  dashboardWindow.on('closed', () => { dashboardWindow = null; });
  dashboardWindow.once('ready-to-show', () => dashboardWindow.show());

  // ── Sleep-wake recovery (ELECTRON-9 fix · v2.3.12) ────────────────────
  // macOS suspende setTimeout durante deep sleep / app backgrounded por horas.
  // Al volver a focus, si expiresAt - now < 60s, refrescamos inmediato y
  // re-arrancamos scheduleRefresh para no caer en 401s en el próximo fetch.
  dashboardWindow.on('focus', async () => {
    if (!currentSession || !currentSession.expiresAt) return;
    const now = Math.floor(Date.now() / 1000);
    if ((currentSession.expiresAt - now) > 60) return; // token aún válido
    try {
      const fresh = await refreshAccessToken(currentSession.refreshToken);
      const nextAccess = typeof fresh.access_token === 'string' && JWT_RE.test(fresh.access_token) ? fresh.access_token : null;
      if (!nextAccess) throw new Error('invalid_refresh_response');
      currentSession = {
        ...currentSession,
        accessToken: nextAccess,
        refreshToken: (typeof fresh.refresh_token === 'string' && fresh.refresh_token.length > 10)
          ? fresh.refresh_token : currentSession.refreshToken,
        expiresAt: (typeof fresh.expires_at === 'number' && Number.isFinite(fresh.expires_at))
          ? fresh.expires_at : (Math.floor(Date.now() / 1000) + (fresh.expires_in || 3600)),
      };
      persistSession(currentSession);
      if (dashboardWindow && !dashboardWindow.isDestroyed()) {
        dashboardWindow.webContents.send('session-refreshed', currentSession);
      }
      scheduleRefresh();
      console.log('[Auth] focus-refresh ok · expiresAt:', currentSession.expiresAt);
    } catch (e) {
      console.warn('[Auth] focus-refresh failed, logout:', e.message);
      try { Sentry.captureException(e, { tags: { source: 'focus-refresh' } }); } catch(_){}
      doLogout();
    }
  });
}

async function doLogout() {
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
  if (currentSession && currentSession.accessToken) {
    await signOutSupabase(currentSession.accessToken);
  }
  currentSession = null;
  clearPersistedSession();
  if (dashboardWindow) { dashboardWindow.destroy(); dashboardWindow = null; }
  if (!loginWindow) createLoginWindow();
}

// ── Auto-login ──────────────────────────────────────────────────────────────
// Fix 2026-04-23: validación robusta de la sesión persistida. Si viene de una
// versión antigua con shape distinto, o está corrupta, la limpiamos y abrimos
// login en vez de entrar al dashboard con data basura (causa error 400).
const _JWT_RE_AUTOLOGIN = /^[\w-]+\.[\w-]+\.[\w-]+$/;

function isValidPersistedSession(s) {
  if (!s || typeof s !== 'object') return false;
  if (typeof s.accessToken !== 'string' || !_JWT_RE_AUTOLOGIN.test(s.accessToken)) return false;
  if (typeof s.refreshToken !== 'string' || s.refreshToken.length < 10) return false;
  // expiresAt es opcional (si no está, forzamos refresh al arrancar)
  if (s.expiresAt != null && !Number.isFinite(s.expiresAt)) return false;
  return true;
}

async function tryAutoLogin() {
  const persisted = loadPersistedSession();
  if (!persisted) {
    console.log('[autoLogin] Sin sesión persistida, abriendo login');
    return false;
  }

  if (!isValidPersistedSession(persisted)) {
    console.warn('[autoLogin] Sesión persistida corrupta o con shape viejo, limpiando');
    clearPersistedSession();
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  // Si el token está expirado o por vencer en 30s, intentar refresh
  if (!persisted.expiresAt || persisted.expiresAt <= now + 30) {
    try {
      const fresh = await refreshAccessToken(persisted.refreshToken);
      if (!fresh || typeof fresh.access_token !== 'string' || !_JWT_RE_AUTOLOGIN.test(fresh.access_token)) {
        throw new Error('invalid_refresh_response');
      }
      currentSession = {
        ...persisted,
        accessToken: fresh.access_token,
        refreshToken: fresh.refresh_token || persisted.refreshToken,
        expiresAt: fresh.expires_at || (Math.floor(Date.now() / 1000) + (fresh.expires_in || 3600)),
      };
      persistSession(currentSession);
      // v2.2.6 — no log PII (email). Sentry recibe user.id via setUser().
      console.log('[autoLogin] Refresh OK, entrando al dashboard');
    } catch (e) {
      console.warn('[autoLogin] Refresh falló (posible token revocado o user eliminado):', e.message);
      clearPersistedSession();
      return false;
    }
  } else {
    currentSession = persisted;
    // v2.2.6 — no log PII (email). Sentry recibe user.id via setUser().
    console.log('[autoLogin] Sesión válida, entrando al dashboard');
  }

  createDashboardWindow();
  scheduleRefresh();
  return true;
}

// ── Sprint 1D · Seguridad IPC ────────────────────────────────────────────────
// Validación estricta de payloads (evita que un renderer comprometido persista
// basura en session o redirija a dominios arbitrarios vía openExternal).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JWT_RE  = /^[\w-]+\.[\w-]+\.[\w-]+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Valida y sanitiza un payload de session. Retorna null si no cumple el schema.
 * No confiar en campos que no estén explícitamente listados aquí: se descartan.
 */
function validateSessionPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const { accessToken, refreshToken, expiresAt, clientId, empresa, email, nombre } = payload;

  if (typeof accessToken !== 'string' || accessToken.length < 20 || accessToken.length > 4000) return null;
  if (!JWT_RE.test(accessToken)) return null;
  if (typeof refreshToken !== 'string' || refreshToken.length < 10 || refreshToken.length > 4000) return null;

  const exp = (typeof expiresAt === 'number' && Number.isFinite(expiresAt) && expiresAt > 0) ? expiresAt : null;

  return {
    accessToken,
    refreshToken,
    expiresAt: exp,
    clientId: (typeof clientId === 'string' && UUID_RE.test(clientId)) ? clientId : null,
    empresa:  typeof empresa === 'string' ? empresa.slice(0, 200) : '',
    email:    (typeof email === 'string' && EMAIL_RE.test(email) && email.length < 200) ? email : '',
    nombre:   typeof nombre === 'string' ? nombre.slice(0, 200) : '',
  };
}

/**
 * Allowlist para shell.openExternal. Previene phishing si un atacante inyecta
 * un link arbitrario. Solo se permiten dominios propios + proveedores verificados.
 */
const ALLOWED_EXTERNAL_HOSTS = new Set([
  // Dominios propios
  'dominiosystem.com', 'www.dominiosystem.com', 'app.dominiosystem.com', 'demo.dominiosystem.com',
  // Supabase dashboard + project
  'supabase.com', 'app.supabase.com', 'ywlyuuddqitduqtdttgo.supabase.co',
  // Meta / WhatsApp
  'web.whatsapp.com', 'business.whatsapp.com', 'business.facebook.com', 'developers.facebook.com', 'wa.me',
  // Proveedores frecuentes
  'cal.com', 'app.cal.com',
  'stripe.com', 'dashboard.stripe.com', 'checkout.stripe.com',
  'resend.com',
  'github.com',
]);
const ALLOWED_EXTERNAL_SUFFIXES = ['.dominiosystem.com', '.supabase.co'];

function isExternalUrlAllowed(raw) {
  if (typeof raw !== 'string' || raw.length > 2000) return false;
  let u;
  try { u = new URL(raw); } catch { return false; }
  // v2.1.48 — permitir mailto: para que botones de email del dashboard
  // (ej. "Enviar email" en Leads) abran el cliente de correo default del OS.
  if (u.protocol === 'mailto:') {
    // Validar que el address tenga forma básica de email
    return /^[^\s@]+@[^\s@]+\.[^\s@]+/.test(u.pathname || '');
  }
  if (u.protocol !== 'https:') return false;
  if (ALLOWED_EXTERNAL_HOSTS.has(u.hostname)) return true;
  return ALLOWED_EXTERNAL_SUFFIXES.some(s => u.hostname.endsWith(s));
}

// ── IPC handlers ────────────────────────────────────────────────────────────
ipcMain.on('login-success', (event, session) => {
  const safe = validateSessionPayload(session);
  if (!safe) {
    console.error('[IPC] login-success: payload inválido o malformado. Rechazado.');
    return;
  }
  currentSession = safe;
  persistSession(safe);
  scheduleRefresh();
  createDashboardWindow();
  if (loginWindow) { loginWindow.destroy(); loginWindow = null; }
});

ipcMain.on('logout', () => doLogout());

ipcMain.handle('get-session', () => currentSession);

ipcMain.handle('refresh-session', async () => {
  if (!currentSession || !currentSession.refreshToken) throw new Error('No session to refresh');
  try {
    const fresh = await refreshAccessToken(currentSession.refreshToken);
    const nextAccess = typeof fresh.access_token === 'string' && JWT_RE.test(fresh.access_token) ? fresh.access_token : null;
    if (!nextAccess) throw new Error('invalid_refresh_response');

    currentSession = {
      ...currentSession,
      accessToken: nextAccess,
      refreshToken: (typeof fresh.refresh_token === 'string' && fresh.refresh_token.length > 10)
        ? fresh.refresh_token
        : currentSession.refreshToken,
      expiresAt: (typeof fresh.expires_at === 'number' && Number.isFinite(fresh.expires_at))
        ? fresh.expires_at
        : (Math.floor(Date.now() / 1000) + (fresh.expires_in || 3600)),
    };
    persistSession(currentSession);
    scheduleRefresh();
    return currentSession;
  } catch (e) {
    doLogout();
    throw e;
  }
});

ipcMain.on('open-whatsapp', (event, clientId) => {
  // clientId es opcional (stub para futuro multi-cliente). No afecta el shell.openExternal.
  shell.openExternal('https://web.whatsapp.com');
});

ipcMain.on('open-external', (event, url) => {
  if (isExternalUrlAllowed(url)) {
    shell.openExternal(url);
  } else {
    console.warn('[IPC] open-external bloqueado (dominio no permitido):', typeof url === 'string' ? url.slice(0, 200) : typeof url);
  }
});

ipcMain.on('window-minimize', () => { if (loginWindow) loginWindow.minimize(); });
ipcMain.on('window-close', () => { app.quit(); });
ipcMain.on('install-update', () => {
  // Solo funciona con app firmada (cert Apple Developer).
  // Sin cert, fallará silencioso en macOS.
  try { autoUpdater.quitAndInstall(); }
  catch (e) { console.error('[Updater] quitAndInstall falló:', e.message); }
});

// ── Sentry bridge para renderer ─────────────────────────────────────────────
// El renderer (dashboard/login) no tiene Node.js, así que nos pasa errores
// por IPC y nosotros los capturamos desde el main process.
ipcMain.on('sentry:capture-exception', (_evt, payload) => {
  try {
    const err = new Error(payload?.message || 'Unknown renderer error');
    if (payload?.stack) err.stack = payload.stack;
    if (payload?.name)  err.name  = payload.name;
    Sentry.captureException(err, {
      tags: { source: 'renderer', ...(payload?.tags || {}) },
      extra: payload?.extra || {},
    });
  } catch (e) { console.warn('[Sentry] capture-exception falló:', e.message); }
});

ipcMain.on('sentry:capture-message', (_evt, payload) => {
  try {
    Sentry.captureMessage(String(payload?.message || '').slice(0, 500), {
      level: ['fatal','error','warning','info','debug'].includes(payload?.level) ? payload.level : 'info',
      tags: { source: 'renderer', ...(payload?.tags || {}) },
    });
  } catch (e) { console.warn('[Sentry] capture-message falló:', e.message); }
});

ipcMain.on('sentry:set-user', (_evt, user) => {
  try {
    // Solo UUID del cliente, nunca email/nombre.
    Sentry.setUser(user && user.id ? { id: String(user.id) } : null);
  } catch (e) { console.warn('[Sentry] set-user falló:', e.message); }
});

ipcMain.on('sentry:set-tag', (_evt, { key, value } = {}) => {
  try {
    if (typeof key === 'string' && key.length < 40 && !_PII_KEY_RE.test(key)) {
      Sentry.setTag(key, String(value).slice(0, 200));
    }
  } catch (e) { console.warn('[Sentry] set-tag falló:', e.message); }
});

// Reportar arquitectura nativa al renderer (process.arch es la fuente confiable;
// navigator.userAgent en Electron Mac dice "Intel" aunque el binario sea arm64,
// causando que la app descargara DMG x64 incorrecto en Apple Silicon — bug v2.2.0).
ipcMain.handle('get-arch', () => process.arch);

// Check manual (botón "Buscar actualizaciones" en Settings)
ipcMain.handle('check-for-updates', async () => {
  try {
    const result = await autoUpdater.checkForUpdates();
    return {
      ok: true,
      updateInfo: result?.updateInfo || null,
      current: app.getVersion(),
    };
  } catch (e) {
    console.error('[Updater] check manual falló:', e.message);
    return { ok: false, error: e.message, current: app.getVersion() };
  }
});

ipcMain.handle('get-app-version', () => app.getVersion());

// ── App lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  const autoLoggedIn = await tryAutoLogin();
  if (!autoLoggedIn) createLoginWindow();

  // Auto-update check: 10s tras arranque + cada 4h
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(e =>
      console.warn('[Updater] check inicial falló:', e.message));
  }, 10_000);

  setInterval(() => {
    autoUpdater.checkForUpdates().catch(e =>
      console.warn('[Updater] check periódico falló:', e.message));
  }, 4 * 60 * 60 * 1000); // 4 horas
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!loginWindow && !dashboardWindow) {
    if (currentSession) createDashboardWindow();
    else createLoginWindow();
  }
});

app.on('before-quit', () => {
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
});

// ── Auto-updater ────────────────────────────────────────────────────────────
// Sin cert Apple, autoDownload=true falla silencioso en macOS porque el binario
// descargado no se puede verificar. Mejor: solo check + notificamos al usuario
// que abra el link de descarga en el navegador.
// Cuando tengamos cert Apple Developer, cambiar autoDownload=true + re-activar quitAndInstall.
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;

autoUpdater.on('update-available', (info) => {
  console.log('[Updater] actualización disponible:', info?.version);
  if (dashboardWindow) {
    dashboardWindow.webContents.send('update-available', {
      version: info?.version,
      releaseNotes: info?.releaseNotes,
      releaseDate: info?.releaseDate,
    });
  }
});

autoUpdater.on('update-not-available', (info) => {
  console.log('[Updater] ya estás en la última versión:', info?.version);
  if (dashboardWindow) {
    dashboardWindow.webContents.send('update-not-available', { version: info?.version });
  }
});

autoUpdater.on('error', (err) => {
  console.warn('[Updater] error:', err?.message || err);
  if (dashboardWindow) {
    dashboardWindow.webContents.send('update-error', { message: err?.message || String(err) });
  }
});

autoUpdater.on('download-progress', (progress) => {
  if (dashboardWindow) {
    dashboardWindow.webContents.send('update-progress', {
      percent: progress?.percent || 0,
      transferred: progress?.transferred || 0,
      total: progress?.total || 0,
    });
  }
});

autoUpdater.on('update-downloaded', (info) => {
  console.log('[Updater] actualización descargada:', info?.version);
  if (dashboardWindow) {
    dashboardWindow.webContents.send('update-downloaded', {
      version: info?.version,
      releaseNotes: info?.releaseNotes,
    });
  }
});
