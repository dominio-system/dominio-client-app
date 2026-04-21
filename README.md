# Dominio (Client App)

App nativa de Dominio System para **clientes finales** (clínicas, spas, gyms, restaurantes, servicios).

Este es el **producto SaaS distribuible** — Mac .dmg + Windows .nsis.

## Stack
- Electron 41.x
- Vanilla JS + HTML + Supabase JS SDK v2 (para Realtime)
- safeStorage (Keychain macOS / DPAPI Windows)
- electron-updater (auto-updates desde GitHub Releases)

## Features
- Login Supabase Auth + validación `clients` table (por email o id)
- Auto-refresh de JWT + persistencia encriptada
- Retry automático en 401
- WhatsApp embebido (webviewTag)
- ARIA drawer (sugerencias IA con aprobación humana)
- Realtime: ia_suggestions, appointments, notifications, whatsapp_messages
- Multi-view: Brief, Agenda, Leads, Clientes, Campañas, Billing, Mensajes, Ajustes

## Ejecutar en desarrollo
```bash
npm install
npm start          # normal
npm run dev        # con DevTools abierto
```

## Build para distribución
```bash
npm run build:mac    # .dmg universal (x64 + arm64)
npm run build:win    # .nsis x64
```

## Arquitectura
- `main.js` — Electron main (auth + windows + refresh timer + auto-updater)
- `preload.js` — bridge seguro
- `login.html` — login con validación client record
- `dashboard.html` — dashboard cliente multi-view
- `assets/js/app.js` — inicializador + session loader + helpers REST
- `assets/js/aria-drawer.js` — drawer IA con aprobar/rechazar/ejecutar
- `assets/js/realtime.js` — suscripciones Supabase Realtime
- `assets/js/aria-section.js` — panel ARIA en dashboard principal

## Distribución
Releases publicados en GitHub Releases → `electron-updater` notifica al usuario
y descarga actualizaciones en background.

## Dependencias externas
- Supabase project: `ywlyuuddqitduqtdttgo`
- Client record en tabla `clients` (activo + email válido)
- n8n production para triggers: `https://n8n-production-d3a5.up.railway.app`
