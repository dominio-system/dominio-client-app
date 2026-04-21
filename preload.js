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
  onUpdateAvailable:  (cb) => ipcRenderer.on('update-available',  () => cb()),
  onUpdateDownloaded: (cb) => ipcRenderer.on('update-downloaded',  () => cb()),
  installUpdate: () => ipcRenderer.send('install-update'),
});
