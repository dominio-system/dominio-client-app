const { app, BrowserWindow, ipcMain, shell, nativeTheme, safeStorage } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');

// ── Config ──────────────────────────────────────────────────────────────────
app.setName('Dominio');
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
  // Ya NO se pasa token vía URL (patrón inseguro). Renderer lee via IPC getSession().
  dashboardWindow.loadFile('dashboard.html');
  if (process.argv.includes('--dev')) dashboardWindow.webContents.openDevTools({ mode: 'detach' });
  dashboardWindow.on('closed', () => { dashboardWindow = null; });
  dashboardWindow.once('ready-to-show', () => dashboardWindow.show());
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
async function tryAutoLogin() {
  const persisted = loadPersistedSession();
  if (!persisted) return false;

  const now = Math.floor(Date.now() / 1000);
  if (persisted.expiresAt && persisted.expiresAt <= now + 30) {
    try {
      const fresh = await refreshAccessToken(persisted.refreshToken);
      currentSession = {
        ...persisted,
        accessToken: fresh.access_token,
        refreshToken: fresh.refresh_token || persisted.refreshToken,
        expiresAt: fresh.expires_at || (Math.floor(Date.now() / 1000) + (fresh.expires_in || 3600)),
      };
      persistSession(currentSession);
    } catch (e) {
      console.warn('Auto-login refresh failed:', e.message);
      clearPersistedSession();
      return false;
    }
  } else {
    currentSession = persisted;
  }

  createDashboardWindow();
  scheduleRefresh();
  return true;
}

// ── IPC handlers ────────────────────────────────────────────────────────────
ipcMain.on('login-success', (event, session) => {
  if (!session || typeof session !== 'object' || !session.accessToken) {
    console.error('login-success: payload inválido. Se esperaba objeto con accessToken, refreshToken, etc.');
    return;
  }
  currentSession = session;
  persistSession(session);
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
    currentSession = {
      ...currentSession,
      accessToken: fresh.access_token,
      refreshToken: fresh.refresh_token || currentSession.refreshToken,
      expiresAt: fresh.expires_at || (Math.floor(Date.now() / 1000) + (fresh.expires_in || 3600)),
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
  // Stub: abrir ventana WhatsApp Web Business (futuro)
  shell.openExternal('https://web.whatsapp.com');
});

ipcMain.on('open-external', (event, url) => {
  if (url && url.startsWith('https://')) shell.openExternal(url);
});

ipcMain.on('window-minimize', () => { if (loginWindow) loginWindow.minimize(); });
ipcMain.on('window-close', () => { app.quit(); });
ipcMain.on('install-update', () => { autoUpdater.quitAndInstall(); });

// ── App lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  const autoLoggedIn = await tryAutoLogin();
  if (!autoLoggedIn) createLoginWindow();
  // autoUpdater.checkForUpdatesAndNotify(); // activar con GitHub Releases
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
autoUpdater.on('update-available', () => {
  if (dashboardWindow) dashboardWindow.webContents.send('update-available');
});
autoUpdater.on('update-downloaded', () => {
  if (dashboardWindow) dashboardWindow.webContents.send('update-downloaded');
});
