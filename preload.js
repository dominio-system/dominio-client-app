/**
 * preload.js — Secure bridge between Electron main process and renderer
 * Exposes only specific, safe APIs to the dashboard/login HTML pages.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Platform info
  platform: process.platform,

  // Auth — login window → main
  // Acepta objeto session completo: { accessToken, refreshToken, expiresAt, userId, clientId, email, empresa }
  loginSuccess: (session) => ipcRenderer.send('login-success', session),
  logout: () => ipcRenderer.send('logout'),

  // Dashboard — leer sesión del main (después de auto-login o login manual)
  getSession: () => ipcRenderer.invoke('get-session'),

  // Dashboard — solicitar refresh manual (usado por wrapper en 401)
  refreshSession: () => ipcRenderer.invoke('refresh-session'),

  // Dashboard — escuchar refresh automático de main
  onSessionRefreshed: (callback) => {
    ipcRenderer.on('session-refreshed', (_, session) => callback(session));
  },

  // WhatsApp — abre ventana dedicada (igual que WhatsApp Desktop)
  openWhatsApp: (clientId) => ipcRenderer.send('open-whatsapp', clientId),

  // Window controls (login screen)
  minimize: () => ipcRenderer.send('window-minimize'),
  close:    () => ipcRenderer.send('window-close'),

  // Open links in system browser (not in Electron window)
  openExternal: (url) => ipcRenderer.send('open-external', url),

  // Auto-updater
  onUpdateAvailable:    (cb) => ipcRenderer.on('update-available',     (_, info) => cb(info)),
  onUpdateNotAvailable: (cb) => ipcRenderer.on('update-not-available', (_, info) => cb(info)),
  onUpdateDownloaded:   (cb) => ipcRenderer.on('update-downloaded',    (_, info) => cb(info)),
  onUpdateProgress:     (cb) => ipcRenderer.on('update-progress',      (_, info) => cb(info)),
  onUpdateError:        (cb) => ipcRenderer.on('update-error',         (_, info) => cb(info)),
  installUpdate: () => ipcRenderer.send('install-update'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  getArch: () => ipcRenderer.invoke('get-arch'),

  // Sentry bridge (capturar errores de renderer vía main process)
  sentryCapture: (err) => {
    try {
      // Reduce Error a payload serializable (Error objects no pasan bien por IPC)
      const payload = err instanceof Error
        ? { name: err.name, message: err.message, stack: err.stack }
        : { name: 'Error', message: String(err), stack: null };
      ipcRenderer.send('sentry:capture-exception', payload);
    } catch (_) { /* noop */ }
  },
  sentryMessage: (msg, level = 'info') => {
    try { ipcRenderer.send('sentry:capture-message', { message: msg, level }); }
    catch (_) { /* noop */ }
  },
  sentrySetUser: (user) => {
    try { ipcRenderer.send('sentry:set-user', user); }
    catch (_) { /* noop */ }
  },
  sentrySetTag: (key, value) => {
    try { ipcRenderer.send('sentry:set-tag', { key, value }); }
    catch (_) { /* noop */ }
  },
});
