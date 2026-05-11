// ═══════════════════════════════════════════════════════════════════
// Drawer de Notificaciones · feed read-only
// ═══════════════════════════════════════════════════════════════════
// v2.1.43: simplificado a UNA sola fuente de datos.
//
// Antes: mezclaba `notifications` + `ia_suggestions` (status='executed').
// Eso causaba duplicados (la cita agendada por ARIA aparecía dos veces:
// como notif de aria_action Y como ia_suggestion executed) y ruido (cada
// WhatsApp automático se mostraba como item).
//
// Ahora: SOLO `notifications`. Categorías que el cliente verá:
//   · 🎯 lead          — nuevo lead capturado (cualquier fuente)
//   · 📅 appointment   — cita confirmada por el cliente
//   · 📅 appointment   — cita cancelada / no_show
//   · 📱 aria_action   — ARIA agendó cita autónomamente
//   · 💰 payment       — pago cobrado
//
// Interacción:
//   · Click en card → navega a la view relevante (link field)
//   · Click en (x) → dismiss (soft: marca dismissed_at en DB → persistente)
//   · Botón "LEÍDAS" → marca todas como read
//   · Realtime refresca cuando llega nueva notif
// ═══════════════════════════════════════════════════════════════════

const ARIA = {
  items: [],                // unified list: notifications + executed suggestions
  categoryIcons: {
    appointment: '📅',
    lead: '🎯',
    payment: '💰',
    email: '✉',
    aria_action: '📱',
    whatsapp: '💬',
    report: '📄',
    alert: '⚠',
    system: '⚙',
    default: '🔔',
  },
  categoryLabels: {
    appointment: 'Cita',
    lead: 'Lead',
    payment: 'Pago',
    email: 'Email',
    aria_action: 'ARIA',
    whatsapp: 'WhatsApp',
    report: 'Reporte',
    alert: 'Alerta',
    system: 'Sistema',
  },
  // v2.1.43 — typeIconsLegacy eliminado (ia_suggestions ya no alimenta el feed)
};

// FIX v2.1.12: exponer ARIA al global scope para que app.js (loadBriefData)
// pueda leer window.ARIA.items sin crashear con TypeError.
window.ARIA = ARIA;

// v2.1.41 — al abrir el drawer, forzar refetch. Antes el feed solo se
// actualizaba en boot inicial o vía realtime. Si el realtime fallaba
// (JWT vencido, channel caído un instante, etc.) el drawer quedaba
// vacío para siempre. Ahora cada apertura = fetch fresco.
function openAria(){
  document.body.classList.add('aria-open');
  if(typeof window.loadNotifications === 'function' && window.CLIENT_ID){
    window.loadNotifications().catch(e => console.warn('[ARIA] reload on open:', e?.message));
  }
}
function closeAria(){ document.body.classList.remove('aria-open'); }
function toggleAria(){
  const wasOpen = document.body.classList.toggle('aria-open');
  if(wasOpen && typeof window.loadNotifications === 'function' && window.CLIENT_ID){
    window.loadNotifications().catch(e => console.warn('[ARIA] reload on toggle:', e?.message));
  }
}
window.openAria  = openAria;
window.closeAria = closeAria;
window.toggleAria = toggleAria;

// ═══════════════ Loader ═══════════════
// v2.1.43 — SOLO `notifications`. Eliminado el merge con ia_suggestions.
window.loadNotifications = async function(){
  if(!window.CLIENT_ID) return;
  try {
    const notifs = await sbGet('notifications',
      `recipient_type=eq.client&recipient_id=eq.${window.CLIENT_ID}&dismissed_at=is.null&select=*&order=created_at.desc&limit=50`);

    ARIA.items = notifs.map(n => ({
      id: `notif-${n.id}`,
      source: 'notification',
      source_id: n.id,
      icon: ARIA.categoryIcons[n.category] || ARIA.categoryIcons.default,
      category: n.category || 'system',
      categoryLabel: ARIA.categoryLabels[n.category] || 'Info',
      title: n.title,
      body: n.body,
      link: n.link,
      timestamp: n.created_at,
      unread: !n.read_at,
      severity: n.severity || 'info',
    }));

    renderAriaList();
    updateAriaBadge();
  } catch(err){
    console.error('[Notifs] loadNotifications error:', err);
  }
};

// ═══════════════ Render ═══════════════
function renderAriaList(){
  const list = document.getElementById('aria-list');
  if(!list) return;
  if(ARIA.items.length === 0){
    list.innerHTML = `
      <div class="aria-empty">
        <div class="aria-empty-icon">A</div>
        <div class="aria-empty-text">Sin actividad reciente.<br>ARIA te avisará cuando pase algo importante.</div>
      </div>`;
    return;
  }

  list.innerHTML = ARIA.items.map(item => {
    const time = formatTimeAgo(item.timestamp);
    const unreadClass = item.unread ? 'unread' : '';
    const hasLink = !!item.link;
    return `
      <div class="aria-card ${unreadClass}" data-id="${item.id}" ${hasLink ? `onclick="handleNotifClick('${item.id}')"` : ''}>
        <button class="aria-card-dismiss" onclick="event.stopPropagation(); dismissNotif('${item.id}');" title="Descartar">✕</button>
        <div class="aria-notif-row">
          <div class="aria-notif-icon">${item.icon}</div>
          <div class="aria-notif-body">
            <div class="aria-notif-title">${escapeHtml(item.title || '')}</div>
            <div class="aria-notif-meta">${escapeHtml(item.categoryLabel || '')} · ${time}</div>
            ${item.body ? `<div class="aria-notif-body-text">${escapeHtml(item.body)}</div>` : ''}
          </div>
        </div>
      </div>`;
  }).join('');
}

// ═══════════════ Interactions ═══════════════
// Click en card → navega según link
window.handleNotifClick = function(id){
  const item = ARIA.items.find(i => i.id === id);
  if(!item) return;

  // Marcar como read (si es notification y está unread)
  if(item.source === 'notification' && item.unread){
    _markNotifRead(item.source_id).catch(e => console.warn('[ARIA] markRead:', e.message));
    item.unread = false;
    renderAriaList();
    updateAriaBadge();
  }

  // Navegar
  if(item.link){
    const viewMap = {
      '/agenda': 'agenda',
      '/leads': 'leads',
      '/inbox': 'aria', // ARIA section tab Conversaciones
      '/crm': 'crm',
      '/brief': 'brief',
      '/billing': 'billing',
      '/reports': 'reports',
      '/funnel': 'funnel',
      '/roi': 'roi',
      '/settings': 'settings',
    };
    const path = (item.link || '').split('?')[0];
    const view = viewMap[path];
    if(view && window.go) window.go(view);
  }
};

// Dismiss individual — v2.1.43: solo notifications, dismissed_at persistido
window.dismissNotif = async function(id){
  const item = ARIA.items.find(i => i.id === id);
  if(!item) return;
  try {
    await sbPatch('notifications', item.source_id, {
      dismissed_at: new Date().toISOString()
    });
    ARIA.items = ARIA.items.filter(i => i.id !== id);
    renderAriaList();
    updateAriaBadge();
  } catch(err){
    console.error('[Notifs] dismiss error:', err);
    window.toast && window.toast('Error', 'No se pudo descartar', 'err');
  }
};

async function _markNotifRead(notifId){
  await sbPatch('notifications', notifId, { read_at: new Date().toISOString() });
}

window.markAllNotifRead = async function(){
  try {
    const unread = ARIA.items.filter(i => i.source === 'notification' && i.unread);
    if(unread.length === 0){
      window.toast && window.toast('✓ Al día', 'No hay notificaciones sin leer', 'success');
      return;
    }
    // Mark all read en paralelo
    await Promise.all(unread.map(i => _markNotifRead(i.source_id).catch(() => null)));
    unread.forEach(i => { i.unread = false; });
    renderAriaList();
    updateAriaBadge();
    window.toast && window.toast('✓ Todas leídas', `${unread.length} notificaciones`, 'success');
  } catch(err){
    console.error('[ARIA] markAllRead error:', err);
  }
};

// ═══════════════ Badge (FAB + counter del drawer) ═══════════════
// v2.1.14: ya NO toca brief-aria. Ese KPI ahora es "Citas cerradas por ARIA"
// y lo gestiona exclusivamente loadBriefData() en app.js.
function updateAriaBadge(){
  const unreadCount = ARIA.items.filter(i => i.unread).length;
  const totalCount = ARIA.items.length;

  const badge = document.getElementById('aria-badge');
  const countEl = document.getElementById('aria-count');
  const bell = document.getElementById('notif-bell');

  if(unreadCount > 0 && badge){
    badge.textContent = unreadCount;
    badge.style.display = 'flex';
  } else if(badge) {
    badge.style.display = 'none';
  }
  if(countEl) countEl.textContent = totalCount;

  // v2.1.55 — toggle has-notif en el bell del topbar (dispara wiggle animation)
  if(bell){
    if(unreadCount > 0) bell.classList.add('has-notif');
    else bell.classList.remove('has-notif');
  }
}

// ═══════════════ Utilities ═══════════════
// v2.1.36 — delega en window.fmtTimeAgoTZ (helper global con timezone del cliente).
// Mantenemos este wrapper para no romper si app.js tarda en exponer el helper.
function formatTimeAgo(iso){
  if(typeof window.fmtTimeAgoTZ === 'function') return window.fmtTimeAgoTZ(iso);
  // Fallback (no debería entrar): mismo comportamiento que antes
  if(!iso) return '—';
  const then = new Date(iso);
  const diff = Math.floor((Date.now() - then.getTime()) / 1000);
  if(diff < 0)      return 'ahora';
  if(diff < 60)     return 'ahora';
  if(diff < 3600)   return Math.floor(diff / 60) + ' min';
  if(diff < 86400)  return Math.floor(diff / 3600) + ' h';
  if(diff < 604800) return Math.floor(diff / 86400) + ' d';
  return then.toLocaleDateString('es-MX', { day: 'numeric', month: 'short' });
}

function escapeHtml(s){
  if(s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ═══════════════ Legacy bridges (otros archivos llaman) ═══════════════
// Estos wrappers mantienen compatibilidad con app.js + realtime.js
window.renderAriaList = renderAriaList;
window.updateAriaBadge = updateAriaBadge;
window.escapeHtml = escapeHtml;

// v2.1.43 — solo escuchamos rt:notifications. ia_suggestions ya no
// alimenta el drawer (vive solo en panel ARIA Inbox / Reglas).
const _onRtNotifications = () => { loadNotifications(); };
const _onRtDisconnect = () => {
  window.removeEventListener('rt:notifications', _onRtNotifications);
  window.removeEventListener('rt:disconnect',    _onRtDisconnect);
};
window.addEventListener('rt:notifications', _onRtNotifications);
window.addEventListener('rt:disconnect',    _onRtDisconnect);
