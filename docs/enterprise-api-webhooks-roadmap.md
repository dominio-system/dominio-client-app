# Enterprise · API Keys + Webhooks Roadmap

**Status**: Backlog · esperando primer cliente Enterprise que lo pida explícitamente
**Origen**: decisión arquitectónica `madre v1.0.30` (2026-05-07)

## Por qué NO está en `dominio-madre-app`

Las API keys y webhooks son **per-tenant** · cada cliente Pro/Enterprise gestiona los suyos. Tenerlos en madre = founder bottleneck (cada cliente nuevo le pide al founder que le cree key manualmente). NO escala.

Solución correcta: cliente self-service desde su propio dashboard.

## Estado actual

### Backend (DB) · ✅ parcialmente listo
- Tabla `api_keys` con `client_id` (RLS por client_id)
- Tabla `webhooks` con `client_id` (RLS por client_id)
- Edge Function `webhook-dispatcher` deployed (delivery con retry exponencial)

### Backend (REST API) · ❌ falta
- Endpoint `/v1/*` que valida `api_keys.client_id` = caller's API key
- Rate limiting per key
- HMAC signature en webhooks salientes

### Frontend (cliente app) · ❌ falta
- Sección "API & Webhooks" en dashboard cliente
- Generar/listar/revocar API keys con scopes
- Registrar/testear/desactivar webhooks

## Sprint Enterprise (cuando llegue trigger)

### Estimación · 1-2 semanas

**Día 1-2 · Edge Function `dominio-api-v1`**
- Endpoint público `https://api.dominiosystem.com/v1/*`
- Middleware: `Authorization: Bearer dom_live_xxx` valida en `api_keys` table
- Rate limiting: 1000 req/hora por key (Redis o tabla `rate_limits`)
- Endpoints disponibles:
  - `GET /v1/appointments` (con filtros fecha, estado)
  - `GET /v1/leads` (con filtros status, fuente)
  - `GET /v1/invoices`
  - `GET /v1/clients` (solo el suyo)
  - `POST /v1/leads` (insertar lead desde site externo)
  - `POST /v1/appointments` (insertar cita desde calendar externo)
  - `GET /v1/tickets`

**Día 3-4 · Webhook dispatcher v2**
- Eventos:
  - `lead.created`, `lead.converted`, `lead.qualified`
  - `appointment.created`, `appointment.confirmed`, `appointment.completed`, `appointment.canceled`, `appointment.paid`
  - `payment.received`, `payment.failed`
  - `ticket.created`, `ticket.resolved`, `ticket.closed`
- HMAC-SHA256 signature en header `X-Dominio-Signature`
- Retry: 5 intentos con backoff exponencial (1m, 5m, 30m, 2h, 12h)
- Disable after 5 consecutive 5xx (anti-spam)

**Día 5-6 · Frontend cliente app**
- Nueva sección sidebar "API & Integraciones"
- Tab "API Keys": crear (con scopes), listar, revocar, test request
- Tab "Webhooks": registrar URL + eventos, listar últimos deliveries (success/fail), test ping
- Tab "Logs": últimas 100 requests al API + últimos 100 webhook deliveries

**Día 7-8 · Documentación pública**
- `dominiosystem.com/docs/api` con OpenAPI spec
- Code samples (curl, Node.js, Python, PHP)
- Playground interactivo (Swagger UI o similar)

**Día 9-10 · Testing + Launch**
- E2E tests de cada endpoint
- Stripe-style webhook signature verification ejemplo
- Onboarding email para Enterprise: "Tu API key + cómo empezar"

## Pricing implícito

API access es **feature Enterprise tier**. NO incluido en Pro standard.
- Pro: dashboard + datos por UI
- Enterprise: + API access + webhooks + soporte SLA

Charge premium ($X/mes adicional) por la feature.

## Cuándo construirlo

- ✅ Cliente Enterprise lo pidió EXPLÍCITAMENTE en discovery call
- ✅ Tienes contrato firmado con esa feature como entrega
- ❌ Solo "creo que sería buena idea" (NO construir hasta tener demanda real)

## Histórico

- 2026-05-07 · `madre v1.0.30` ocultó webhooks + API keys del sidebar madre
  - Razón: per-tenant features no founder-level, no escala con +5 Enterprise
  - Plan: migrar a cliente app cuando llegue primer Enterprise que lo pida
