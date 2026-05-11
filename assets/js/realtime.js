// ═══════════════════════════════════════════════════════════════════
// Realtime subscriptions manager · Sprint 1B (2026-04-22)
// ═══════════════════════════════════════════════════════════════════
// Suscribe a cambios Supabase en vivo + reconexión automática +
// polling fallback + emite eventos globales para que cualquier vista
// que escuche se auto-refresque.
//
// Channels (11):
//   · ia_suggestions     → ARIA drawer + badge
//   · appointments       → Agenda + Brief + Funnel
//   · notifications      → toasts + bell
//   · whatsapp_messages  → Inbox + ARIA chat
//   · leads              → CRM + Leads view + Brief + Funnel
//   · aria_conversations → ARIA panel
//   · aria_rules         → ARIA automatización
//   · aria_messages      → ARIA chat inline
//   · invoices           → Billing view
//   · clients            → Settings + profile sync
//   · whatsapp_campaigns → Campaigns view (Sprint Fase A)
//
// Polling fallback: cuando la conexión WS cae >60s, activa polling
// 30s para vistas activas. Se auto-desactiva al recuperar WS.
//
// Depends on: window.sb, window.CLIENT_ID, window.ARIA, window.renderAriaList,
//             window.updateAriaBadge, window.toast
// ═══════════════════════════════════════════════════════════════════

const RT = {
  channels: [],              // {name, channel, status, lastSeenAt, reconnectTries}
  healthy: false,            // true si al menos N/2 canales SUBSCRIBED
  lastHealthyAt: 0,
  pollingInterval: null,     // setInterval id cuando estamos en fallback
  reconnectTimer: null,      // timer próximo intento de reconnect global
  pageVisible: true,
};

// Vistas que se benefician de polling fallback cuando WS cae.
// Llaves = window.currentView; valor = función(es) que refrescan la data.
// Uso optional chaining para no romper si alguna no existe en runtime.
const POLL_VIEWS = {
  brief:      () => window.loadBriefData?.(),
  agenda:     () => window.loadAppointments?.(),
  leads:      () => window.loadLeads?.(),
  crm:        () => window.loadCRM?.(),
  inbox:      () => window.loadInbox?.(),
  billing:    () => window.loadBilling?.(),
  aria:       () => { window.loadConversations?.(); window.loadRules?.(); },
  settings:   () => window.loadSettings?.(),
  funnel:     () => window.loadFunnel?.(),
  ingresos:   () => window.loadIngresosView?.(),
  publicidad: () => window.loadPublicidad?.(),
  campaigns:  () => window.loadCampaigns?.(),
  reports:    () => window.loadReports?.(),
};

const POLL_INTERVAL_MS = 30_000;
const UNHEALTHY_THRESHOLD_MS = 60_000;

// FIX v2.1.30 — Debounce per-handler para evitar 20 eventos rápidos = 20 fetches
const _DEBOUNCE_MS = 350;
const _debounceTimers = new Map();
function debounceCall(key, fn){
  const t = _debounceTimers.get(key);
  if(t) clearTimeout(t);
  _debounceTimers.set(key, setTimeout(() => {
    _debounceTimers.delete(key);
    try { fn(); } catch(e){ console.error(`[RT debounce ${key}]`, e); }
  }, _DEBOUNCE_MS));
}

// FIX v2.1.30 — Helper que valida que la función exista Y la vista esté activa
// antes de llamarla (evita TypeError null cuando handler dispara fuera de vista)
function callIfActive(viewName, fn){
  if(window.currentView !== viewName) return;
  if(typeof fn !== 'function') return;
  try { fn(); } catch(e){ console.error(`[RT callIfActive ${viewName}]`, e); }
}

// ═══════════════ Channel factory ═══════════════
function makeChannel(name, tableFilter, handler, events = '*') {
  if(!window.sb || !window.CLIENT_ID) return null;

  const entry = {
    name,
    channel: null,
    status: 'CLOSED',
    lastSeenAt: 0,
    reconnectTries: 0,
  };

  const build = () => {
    const ch = window.sb
      .channel(`${name}-${window.CLIENT_ID}-${Date.now()}`)
      .on('postgres_changes', { event: events, schema: 'public', ...tableFilter }, (payload) => {
        entry.lastSeenAt = Date.now();
        try { handler(payload); }
        catch(e){ console.error(`[RT:${name}] handler error:`, e); }
      })
      .subscribe((status) => {
        entry.status = status;
        if(status === 'SUBSCRIBED'){
          entry.reconnectTries = 0;
          entry.lastSeenAt = Date.now();
          console.log(`✓ RT:${name} subscribed`);
          updateHealth();
          return;
        }
        if(status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED'){
          console.warn(`✗ RT:${name} ${status}`);
          updateHealth();
          scheduleReconnect(entry);
        }
      });
    entry.channel = ch;
  };

  build();
  return entry;
}

// ═══════════════ Reconnect con exponential backoff ═══════════════
function scheduleReconnect(entry) {
  if(!entry) return;
  const tries = ++entry.reconnectTries;
  const delay = Math.min(1000 * Math.pow(2, Math.min(tries, 6)), 30_000);
  console.log(`[RT:${entry.name}] reconnect en ${delay}ms (intento ${tries})`);

  setTimeout(() => {
    if(!RT.pageVisible || !window.sb || !window.CLIENT_ID) return;
    try {
      if(entry.channel) window.sb.removeChannel(entry.channel);
    } catch(e) {}
    // Re-construye el channel desde cero (n8n SDK no tiene .resubscribe limpio)
    const rebuilder = RT._rebuilders[entry.name];
    if(rebuilder) rebuilder(entry);
  }, delay);
}

// Guardamos rebuilders para cada canal (evita closure spaghetti)
RT._rebuilders = {};

function registerChannel(entry, rebuildFn) {
  if(!entry) return;
  RT.channels.push(entry);
  RT._rebuilders[entry.name] = rebuildFn;
}

// ═══════════════ Health + polling fallback ═══════════════
function updateHealth() {
  const total = RT.channels.length;
  const active = RT.channels.filter(c => c.status === 'SUBSCRIBED').length;
  const newHealthy = total > 0 && active >= Math.ceil(total / 2);

  if(newHealthy !== RT.healthy){
    RT.healthy = newHealthy;
    if(newHealthy){
      RT.lastHealthyAt = Date.now();
      stopPollingFallback();
      console.log(`✓ RT healthy (${active}/${total} canales activos)`);
    } else {
      console.warn(`✗ RT unhealthy (${active}/${total} canales activos)`);
      // Si lleva más de 60s caído, activar polling
      setTimeout(() => {
        if(!RT.healthy && Date.now() - RT.lastHealthyAt > UNHEALTHY_THRESHOLD_MS){
          startPollingFallback();
        }
      }, UNHEALTHY_THRESHOLD_MS);
    }
  }
}

function startPollingFallback() {
  if(RT.pollingInterval) return;
  console.warn('[RT] Activando polling fallback 30s');
  window.toast?.('Conexión lenta', 'Cambios se sincronizarán cada 30s', 'warn');
  RT.pollingInterval = setInterval(() => {
    // v2.1.42 — además de la vista activa, SIEMPRE refrescar
    // notificaciones para que el FAB ARIA mantenga el badge correcto
    // incluso cuando el drawer está cerrado y el WS está caído.
    if(typeof window.loadNotifications === 'function' && window.CLIENT_ID){
      window.loadNotifications().catch(() => {});
    }
    const view = window.currentView;
    const loader = POLL_VIEWS[view];
    if(loader) loader();
  }, POLL_INTERVAL_MS);
}

function stopPollingFallback() {
  if(!RT.pollingInterval) return;
  console.log('[RT] Desactivando polling fallback (WS recuperado)');
  clearInterval(RT.pollingInterval);
  RT.pollingInterval = null;
}

// ═══════════════ Handlers por tabla ═══════════════
function emitChange(table, payload){
  // Broadcast a cualquier vista que escuche
  window.dispatchEvent(new CustomEvent(`rt:${table}`, { detail: payload }));
}

function handleIaChange(payload){
  emitChange('ia_suggestions', payload);
  const { eventType, new: newRow, old: oldRow } = payload;

  if(!window.ARIA) return;
  if(eventType === 'INSERT'){
    window.ARIA.items.unshift(newRow);
    window.renderAriaList?.();
    window.updateAriaBadge?.();
    if(newRow.status === 'pending'){
      window.toast?.('🔮 ARIA: nueva sugerencia', newRow.title, 'aria');
    }
  } else if(eventType === 'UPDATE'){
    const idx = window.ARIA.items.findIndex(i => i.id === newRow.id);
    if(idx >= 0){
      window.ARIA.items[idx] = newRow;
      window.renderAriaList?.();
      window.updateAriaBadge?.();
    }
  } else if(eventType === 'DELETE'){
    window.ARIA.items = window.ARIA.items.filter(i => i.id !== oldRow.id);
    window.renderAriaList?.();
    window.updateAriaBadge?.();
  }
}

// Evita re-notificar el mismo cambio 2 veces (Postgres puede disparar UPDATE múltiples
// veces en la misma transacción). Cache simple de IDs ya toasted en últimos 30s.
const _apptToastSeen = new Map();
function _wasToastedRecently(key, windowMs = 30_000){
  const now = Date.now();
  // limpieza perezosa
  for(const [k, t] of _apptToastSeen){ if(now - t > windowMs) _apptToastSeen.delete(k); }
  if(_apptToastSeen.has(key)) return true;
  _apptToastSeen.set(key, now);
  return false;
}

function handleAppointmentChange(payload){
  emitChange('appointments', payload);
  const { eventType, new: newRow } = payload;
  if(eventType === 'INSERT'){
    window.toast?.('📅 Nueva cita', `${newRow.nombre} · ${newRow.fecha}`, 'success');
  } else if(eventType === 'UPDATE'){
    // Sprint FIX audit: detectamos eventos "frescos" por timestamp porque Postgres
    // realtime con REPLICA IDENTITY DEFAULT no envía oldRow completo.
    const now = Date.now();
    const paidAt = newRow.paid_at ? new Date(newRow.paid_at).getTime() : 0;
    const confAt = newRow.confirmed_at ? new Date(newRow.confirmed_at).getTime() : 0;

    if(newRow.pagado === true && paidAt && (now - paidAt) < 10_000 && !_wasToastedRecently(`pay-${newRow.id}`)){
      const monto = ((newRow.neto_cents || newRow.precio_cents || 0) / 100).toLocaleString('es-MX', { minimumFractionDigits: 2 });
      const moneda = window.currentClient?.moneda || '$';
      const metodo = newRow.metodo_pago ? ' · ' + newRow.metodo_pago : '';
      window.toast?.('💰 Pago registrado', `${newRow.nombre} · ${moneda}${monto}${metodo}`, 'success');
    } else if(newRow.estado === 'confirmed' && confAt && (now - confAt) < 10_000 && !_wasToastedRecently(`conf-${newRow.id}`)){
      window.toast?.('✓ Cita confirmada', newRow.nombre, 'success');
    } else if(newRow.estado === 'cancelled' && !_wasToastedRecently(`canc-${newRow.id}`)){
      window.toast?.('✕ Cita cancelada', newRow.nombre, 'warn');
    }
  }
  // FIX v2.1.30 — debounce + DOM validation (callIfActive)
  debounceCall('appt-agenda',  () => callIfActive('agenda',     window.loadAppointments));
  debounceCall('appt-brief',   () => callIfActive('brief',      window.loadBriefData));
  debounceCall('appt-ingresos',() => callIfActive('ingresos',   window.loadIngresosView));
  debounceCall('appt-publi',   () => callIfActive('publicidad', window.loadPublicidad));
  debounceCall('appt-funnel',  () => callIfActive('funnel',     window.loadFunnel));
}

function handleNotification(payload){
  emitChange('notifications', payload);
  const { new: notif } = payload;
  if(notif.recipient_type === 'client' && notif.recipient_id !== window.CLIENT_ID) return;
  const severityMap = { info: 'success', warn: 'warn', err: 'err', success: 'success' };
  window.toast?.(notif.title, notif.body, severityMap[notif.severity] || 'success');

  // v2.1.42 — empujar la notif al feed local INMEDIATAMENTE. Antes
  // dependíamos solo de loadNotifications() (que se dispara via
  // rt:notifications listener); si esa función fallaba por cualquier
  // motivo el badge nunca subía. Ahora actualizamos optimistically
  // y el refetch acaba de sincronizar.
  if(window.ARIA && Array.isArray(window.ARIA.items)){
    const ariaItem = {
      id: `notif-${notif.id}`,
      source: 'notification',
      source_id: notif.id,
      icon: (window.ARIA.categoryIcons && window.ARIA.categoryIcons[notif.category]) || '🔔',
      category: notif.category || 'system',
      categoryLabel: (window.ARIA.categoryLabels && window.ARIA.categoryLabels[notif.category]) || 'Info',
      title: notif.title,
      body: notif.body,
      link: notif.link,
      timestamp: notif.created_at || new Date().toISOString(),
      unread: !notif.read_at,
      severity: notif.severity || 'info',
    };
    // Solo agregar si no existe ya (evita duplicado vs refetch concurrente)
    if(!window.ARIA.items.some(i => i.id === ariaItem.id)){
      window.ARIA.items.unshift(ariaItem);
      window.renderAriaList?.();
      window.updateAriaBadge?.();
    }
  }
}

function handleWhatsappMessage(payload){
  emitChange('whatsapp_messages', payload);
  const { new: msg } = payload;
  if(msg.direction === 'inbound' && !_wasToastedRecently(`wa-${msg.id}`)){
    window.toast?.('💬 Nuevo WhatsApp', `De: ${msg.telefono}`, 'aria');
  }
  debounceCall('wa-inbox', () => callIfActive('inbox', window.loadInbox));
  debounceCall('wa-aria',  () => callIfActive('aria',  window.loadConversations));
}

function handleLeadChange(payload){
  emitChange('leads', payload);
  const { eventType, new: newRow } = payload;
  if(eventType === 'INSERT' && !_wasToastedRecently(`lead-${newRow.id}`)){
    window.toast?.('🎯 Nuevo lead', newRow.nombre, 'success');
  }
  debounceCall('lead-leads',     () => callIfActive('leads',      window.loadLeads));
  debounceCall('lead-crm',       () => callIfActive('crm',        window.loadCRM));
  debounceCall('lead-brief',     () => callIfActive('brief',      window.loadBriefData));
  debounceCall('lead-funnel',    () => callIfActive('funnel',     window.loadFunnel));
  debounceCall('lead-publi',     () => callIfActive('publicidad', window.loadPublicidad));
}

function handleAriaConvChange(payload){
  emitChange('aria_conversations', payload);
  debounceCall('ariaconv', () => callIfActive('aria', window.loadConversations));
}

function handleAriaMsgChange(payload){
  emitChange('aria_messages', payload);
  const { new: msg } = payload;
  if(window.currentView === 'aria' && window.currentAriaConvId === msg?.conversation_id){
    debounceCall(`ariamsg-${msg.conversation_id}`, () => window.loadAriaMessages?.(msg.conversation_id));
  }
}

function handleAriaRuleChange(payload){
  emitChange('aria_rules', payload);
  debounceCall('ariarule', () => callIfActive('aria', window.loadRules));
}

function handleInvoiceChange(payload){
  emitChange('invoices', payload);
  const { eventType, new: newRow } = payload;
  // Guard: en INSERT events Postgres puede emitir newRow null (cuando RLS oculta la fila
  // post-trigger pero el evento ya se disparó). v2.2.0 crasheaba por acceso a .status sin guard.
  if(eventType === 'INSERT' && newRow?.status === 'paid' && newRow.id && !_wasToastedRecently(`inv-${newRow.id}`)){
    window.toast?.('💰 Factura pagada', `${newRow.numero || '#' + newRow.id.slice(0,8)}`, 'success');
  }
  debounceCall('inv-billing', () => callIfActive('billing', window.loadBilling));
  debounceCall('inv-brief',   () => callIfActive('brief',   window.loadBriefData));
}

function handleClientChange(payload){
  emitChange('clients', payload);
  const { new: newRow, old: oldRow } = payload;
  if(newRow?.id !== window.CLIENT_ID) return;
  window.currentClient = newRow;
  // FIX v2.1.34 — refrescar logo header (Plan PRO/ENTERPRISE) cuando cambia el plan en vivo.
  // Antes: si el cliente paga upgrade en sesión activa, el badge no se actualizaba hasta
  // re-login. Ahora: realtime detecta UPDATE → renderClientInfo redibuja el badge en vivo.
  try { window.renderClientInfo?.(); } catch(_){}
  // Toast informativo si el plan cambió (upgrade/downgrade)
  if(oldRow && newRow.plan !== oldRow.plan){
    const planLabel = (newRow.plan || 'pro').toUpperCase();
    window.toast?.(`✓ Plan actualizado a ${planLabel}`, 'Tu dashboard ya refleja el nuevo plan', 'success');
  }
  debounceCall('client-settings', () => callIfActive('settings', window.loadSettings));
}

function handleCampaignChange(payload){
  emitChange('whatsapp_campaigns', payload);
  const { eventType, new: newRow } = payload;
  if(eventType === 'INSERT' && newRow?.nombre && !_wasToastedRecently(`camp-${newRow.id}`)){
    window.toast?.('📨 Nueva campaña', newRow.nombre, 'success');
  }
  debounceCall('camp-campaigns', () => callIfActive('campaigns', window.loadCampaigns));
}

// FIX v2.1.30 — handler nuevo para ad_campaigns (tabla nueva v2.1.24)
function handleAdCampaignChange(payload){
  emitChange('ad_campaigns', payload);
  debounceCall('adcamp-publi', () => callIfActive('publicidad', window.loadPublicidad));
}

// ═══════════════ Init / disconnect ═══════════════
function initRealtime(){
  if(!window.sb || !window.CLIENT_ID){
    console.warn('Realtime skipped: sb or CLIENT_ID not ready');
    return;
  }

  disconnectRealtime();

  const cid = window.CLIENT_ID;
  const clientFilter = { filter: `client_id=eq.${cid}` };

  // Registro de los 9 canales con rebuilders
  const configs = [
    { name: 'ia',       table: 'ia_suggestions',     filter: clientFilter, handler: handleIaChange },
    { name: 'appt',     table: 'appointments',       filter: clientFilter, handler: handleAppointmentChange },
    // v2.1.42 — filtro server-side por recipient_id. Antes era filter:{}
    // (sin filtro) y dependíamos solo de RLS para entregar al cliente.
    // El filtro recipient_id reduce tráfico WS y mejora reliability.
    { name: 'notif',    table: 'notifications',      filter: { filter: `recipient_id=eq.${cid}` }, handler: handleNotification, events: 'INSERT' },
    { name: 'wa',       table: 'whatsapp_messages',  filter: clientFilter, handler: handleWhatsappMessage, events: 'INSERT' },
    { name: 'leads',    table: 'leads',              filter: clientFilter, handler: handleLeadChange },
    { name: 'ariaconv', table: 'aria_conversations', filter: clientFilter, handler: handleAriaConvChange },
    { name: 'ariamsg',  table: 'aria_messages',      filter: {},           handler: handleAriaMsgChange },
    { name: 'ariarule', table: 'aria_rules',         filter: clientFilter, handler: handleAriaRuleChange },
    { name: 'invoice',  table: 'invoices',           filter: clientFilter, handler: handleInvoiceChange },
    { name: 'client',   table: 'clients',            filter: { filter: `id=eq.${cid}` }, handler: handleClientChange },
    { name: 'camp',     table: 'whatsapp_campaigns', filter: clientFilter, handler: handleCampaignChange },
    { name: 'adcamp',   table: 'ad_campaigns',       filter: clientFilter, handler: handleAdCampaignChange },
  ];

  configs.forEach(cfg => {
    const rebuilder = (entry) => {
      const ch = window.sb
        .channel(`${cfg.name}-${cid}-${Date.now()}`)
        .on('postgres_changes',
          { event: cfg.events || '*', schema: 'public', table: cfg.table, ...cfg.filter },
          (payload) => {
            entry.lastSeenAt = Date.now();
            try { cfg.handler(payload); }
            catch(e){ console.error(`[RT:${cfg.name}] handler error:`, e); }
          })
        .subscribe((status) => {
          entry.status = status;
          if(status === 'SUBSCRIBED'){
            entry.reconnectTries = 0;
            entry.lastSeenAt = Date.now();
            console.log(`✓ RT:${cfg.name} subscribed`);
            updateHealth();
          } else if(['CHANNEL_ERROR','TIMED_OUT','CLOSED'].includes(status)){
            console.warn(`✗ RT:${cfg.name} ${status}`);
            updateHealth();
            scheduleReconnect(entry);
          }
        });
      entry.channel = ch;
    };

    const entry = { name: cfg.name, channel: null, status: 'CLOSED', lastSeenAt: 0, reconnectTries: 0 };
    rebuilder(entry);
    registerChannel(entry, rebuilder);
  });

  // FIX v2.1.39 — guardar refs para poder removerlos en disconnectRealtime.
  // Antes los handlers anónimos quedaban registrados en document/window forever.
  // En logout/relogin se acumulaban → memory leak progresivo.
  RT._onVisibilityChange = () => {
    RT.pageVisible = document.visibilityState === 'visible';
    if(RT.pageVisible){
      const unhealthyChannels = RT.channels.filter(c => c.status !== 'SUBSCRIBED');
      if(unhealthyChannels.length > 0){
        console.log(`[RT] Page visible, reconectando ${unhealthyChannels.length} canales`);
        unhealthyChannels.forEach(c => scheduleReconnect(c));
      }
    }
  };
  RT._onOnline = () => {
    console.log('[RT] Back online, reconectando todos los canales');
    RT.channels.forEach(c => scheduleReconnect(c));
  };

  // Reconectar al volver a foco (cuando el usuario suspende/retoma app Electron)
  document.addEventListener('visibilitychange', RT._onVisibilityChange);
  // Online listener (Electron puede perder conexión temporalmente)
  window.addEventListener('online', RT._onOnline);
}

function disconnectRealtime(){
  RT.channels.forEach(entry => {
    try { if(entry.channel) window.sb.removeChannel(entry.channel); } catch(e){
      console.warn('[RT] removeChannel error:', e?.message);
    }
  });
  RT.channels = [];
  RT._rebuilders = {};
  stopPollingFallback();
  RT.healthy = false;
  // FIX v2.1.30 — limpiar timers de debounce + cache de toasts dedupe
  for(const t of _debounceTimers.values()){ clearTimeout(t); }
  _debounceTimers.clear();
  _apptToastSeen.clear();
  // FIX v2.1.39 — remover listeners globales para evitar acumulación post-logout
  if(RT._onVisibilityChange){
    document.removeEventListener('visibilitychange', RT._onVisibilityChange);
    RT._onVisibilityChange = null;
  }
  if(RT._onOnline){
    window.removeEventListener('online', RT._onOnline);
    RT._onOnline = null;
  }
  // Notify aria-drawer to remove its listeners
  try { window.dispatchEvent(new CustomEvent('rt:disconnect')); } catch(_){}
}

// FIX v2.1.30 — JWT refresh hook: cuando main.js dispara session-refreshed, reconectamos
// los canales para que usen el nuevo JWT. Sin esto, tras 1h el realtime queda con
// JWT viejo y los handlers ya no reciben events porque Supabase rechaza la auth.
if(window.electronAPI?.onSessionRefreshed){
  window.electronAPI.onSessionRefreshed((newSession) => {
    try {
      if(newSession?.accessToken && window.sb?.realtime?.setAuth){
        window.sb.realtime.setAuth(newSession.accessToken);
        console.log('[RT] Auth token refrescado en realtime client');
      }
      // Force reconnect de canales que estaban unhealthy
      RT.channels.forEach(c => {
        if(c.status !== 'SUBSCRIBED') scheduleReconnect(c);
      });
    } catch(e){ console.error('[RT] onSessionRefreshed error:', e); }
  });
}

// Exponer API pública
window.initRealtime = initRealtime;
window.disconnectRealtime = disconnectRealtime;
window.getRealtimeHealth = () => ({
  healthy: RT.healthy,
  channels: RT.channels.map(c => ({ name: c.name, status: c.status, reconnectTries: c.reconnectTries })),
  pollingActive: !!RT.pollingInterval,
});
