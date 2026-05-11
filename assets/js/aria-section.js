// ARIA Section — Conversaciones + Automatización + Conexión
// Depends on: window.sb, window.CLIENT_ID, window.currentClient, window.toast, sbGet, sbPatch, sbInsert

window.ARIA_SECTION = {
  conversations: [],
  activeConversation: null,
  messages: [],
  filter: 'all',
  search: '',
  rules: [],
};

// Switch tab
window.ariaTab = async function(tab){
  document.querySelectorAll('.aria-tab').forEach(b => b.classList.toggle('active', b.dataset.atab === tab));
  document.querySelectorAll('.aria-tab-pane').forEach(p => p.classList.toggle('active', p.dataset.atab === tab));
  if(tab === 'conv') loadConversations();
  if(tab === 'contactos') loadContactos();
  if(tab === 'auto') {
    // IMPORTANT: await loadRules FIRST. loadTemplates filtra plantillas ya agregadas
    // usando ARIA_SECTION.rules. Si no esperamos, rules está vacío y muestra TODAS
    // las plantillas como pending → user puede crear duplicates.
    await loadRules();
    loadTemplates();
  }
  if(tab === 'conn') renderConnectionStatus();
};

// ===========================================================
// HEADER / STATUS
// ===========================================================
window.loadAriaSection = async function(){
  const c = window.currentClient || {};
  const isConnected = c.wa_status === 'connected';

  document.getElementById('aria-live-chip').style.display = isConnected ? 'inline-flex' : 'none';
  document.getElementById('aria-off-chip').style.display = isConnected ? 'none' : 'inline-flex';

  const phoneEl = document.getElementById('aria-phone-display');
  phoneEl.textContent = c.wa_display_phone || '';
  phoneEl.style.display = c.wa_display_phone ? 'inline' : 'none';

  const verEl = document.getElementById('aria-verified');
  verEl.style.display = isConnected ? 'inline-flex' : 'none';

  const qualEl = document.getElementById('aria-quality');
  if(isConnected && c.wa_quality_rating){
    qualEl.textContent = `QUALITY: ${c.wa_quality_rating}`;
    qualEl.style.display = 'inline-flex';
  } else {
    qualEl.style.display = 'none';
  }

  // Stats 24h
  try {
    const since = new Date(Date.now() - 86400000).toISOString();
    const [msgs24, apts24] = await Promise.all([
      sbGet('whatsapp_messages', `client_id=eq.${CLIENT_ID}&created_at=gte.${since}&select=id,sent_by`),
      sbGet('appointments', `client_id=eq.${CLIENT_ID}&created_at=gte.${since}&select=id`)
    ]);
    const total = msgs24.length;
    const autoReply = msgs24.filter(m => m.sent_by === 'aria').length;
    const pct = total > 0 ? Math.round(autoReply / total * 100) : 0;
    document.getElementById('aria-s-msgs').textContent = total;
    document.getElementById('aria-s-auto').textContent = pct + '%';
    document.getElementById('aria-s-citas').textContent = apts24.length;
  } catch(e){ console.warn('ARIA stats error:', e); }

  // v2.3.0 fix · pre-cargar badge de Contactos sin cargar lista completa
  try {
    const contactosCount = await sbGet('leads',
      `client_id=eq.${CLIENT_ID}&select=id&limit=1000`);
    const tabCount = document.getElementById('contactos-count');
    if(tabCount) tabCount.textContent = contactosCount.length;
  } catch(e){ console.warn('Contactos count error:', e); }

  // Default tab
  ariaTab('conv');
};

// ===========================================================
// CONVERSACIONES
// ===========================================================
window.loadConversations = async function(){
  try {
    const conversations = await sbGet('aria_conversations',
      `client_id=eq.${CLIENT_ID}&deleted_at=is.null&select=*&order=last_message_at.desc&limit=200`);

    ARIA_SECTION.conversations = conversations;

    // v2.1.51 — si hay una conversación activa abierta, actualizar su ref con la versión
    // fresca (nombre_contacto, status, etc.) y re-renderizar el panel del chat.
    // Antes: el panel quedaba con datos viejos (ej. "TDR") aunque la DB ya tenía el nombre real.
    if (ARIA_SECTION.activeConversation) {
      const refreshed = conversations.find(c => c.id === ARIA_SECTION.activeConversation.id);
      if (refreshed) {
        ARIA_SECTION.activeConversation = refreshed;
        if (typeof renderChatPanel === 'function') renderChatPanel();
      }
    }

    updateFilterCounts();
    renderConversationsList();
  } catch(err){
    console.warn('conv error:', err);
    document.getElementById('conv-items').innerHTML =
      `<div style="padding:30px 20px;text-align:center;color:var(--text3);font-size:11px;">Sin conversaciones aún. Conecta WhatsApp para empezar.</div>`;
  }
};

function updateFilterCounts(){
  const conv = ARIA_SECTION.conversations;
  // Activas (no archivadas) — base para los filtros all/active/paused/escalated/resolved
  const live = conv.filter(c => !c.archived_at);
  const archived = conv.filter(c => !!c.archived_at);

  const set = (id, n) => { const el = document.getElementById(id); if(el) el.textContent = n; };
  set('cf-all',       live.length);
  set('cf-active',    live.filter(c => c.status === 'active').length);
  set('cf-paused',    live.filter(c => c.status === 'paused').length);
  set('cf-escalated', live.filter(c => c.status === 'escalated').length);
  set('cf-resolved',  live.filter(c => c.status === 'resolved').length);
  set('cf-archived',  archived.length);
}

window.filterConversations = function(filter){
  ARIA_SECTION.filter = filter;
  document.querySelectorAll('.conv-filter-btn').forEach(b => b.classList.toggle('active', b.dataset.filter === filter));
  renderConversationsList();
};

window.searchConversations = function(q){
  ARIA_SECTION.search = q.toLowerCase();
  renderConversationsList();
};

function renderConversationsList(){
  const { conversations, filter, search } = ARIA_SECTION;
  let list = conversations;

  // Filtro especial: ARCHIVADAS — mostrar solo las que tienen archived_at
  if(filter === 'archived'){
    list = list.filter(c => !!c.archived_at);
  } else {
    // Resto de filtros: excluir archivadas siempre
    list = list.filter(c => !c.archived_at);
    if(filter !== 'all') list = list.filter(c => c.status === filter);
  }

  if(search){
    list = list.filter(c =>
      (c.nombre_contacto || '').toLowerCase().includes(search) ||
      (c.phone || '').toLowerCase().includes(search)
    );
  }

  const el = document.getElementById('conv-items');
  if(list.length === 0){
    const emptyMsg = filter === 'archived'
      ? '📥 No tienes conversaciones archivadas.'
      : 'Sin conversaciones para este filtro.';
    el.innerHTML = `<div style="padding:30px 20px;text-align:center;color:var(--text3);font-size:11px;">${emptyMsg}</div>`;
    return;
  }

  el.innerHTML = list.map(c => {
    const name = c.nombre_contacto || c.phone || 'Sin nombre';
    const initials = (name[0] || '?').toUpperCase() + (name.split(' ')[1]?.[0] || '').toUpperCase();
    const isActive = ARIA_SECTION.activeConversation?.id === c.id;
    const isArchived = !!c.archived_at;
    const dotClass = isArchived ? '' : (c.status === 'paused' ? 'paused' : c.status === 'escalated' ? 'escalated' : '');
    const timeAgo = window.formatTimeAgo ? window.formatTimeAgo(isArchived ? c.archived_at : c.last_message_at) : '';
    const metaChip = isArchived
      ? '<span class="conv-meta-chip" style="background:var(--card2);color:var(--text3);">ARCHIVADA</span>'
      : c.status === 'escalated'
      ? '<span class="conv-meta-chip escalated">ESCALADA</span>'
      : c.status === 'paused'
      ? '<span class="conv-meta-chip human">MANUAL</span>'
      : '<span class="conv-meta-chip aria-c">ARIA</span>';

    // Botón restaurar SOLO en filtro archived
    const restoreBtn = (filter === 'archived')
      ? `<button class="btn ghost" style="font-size:9px;padding:3px 6px;margin-top:4px;"
            onclick="event.stopPropagation(); restoreConversation('${c.id}')"
            title="Restaurar al Inbox">↺ Restaurar</button>`
      : '';

    return `
      <div class="conv-item ${isActive?'active':''} ${isArchived?'archived':''}" data-conv-id="${c.id}"
           onclick="openConversation('${c.id}')"
           ondblclick="event.preventDefault(); openConvContextMenu('${c.id}', '${escapeHtml(name).replace(/'/g, '&#39;')}')">
        <div class="conv-avatar">${initials}${(c.status !== 'resolved' && !isArchived) ? `<span class="conv-avatar-dot ${dotClass}"></span>` : ''}</div>
        <div class="conv-body">
          <div class="conv-top"><span class="conv-name">${escapeHtml(name)}</span><span class="conv-time">${timeAgo}</span></div>
          <div class="conv-preview">${escapeHtml((c.context?.last_preview || '').slice(0, 50))}</div>
          <div class="conv-meta">${metaChip} ${restoreBtn}</div>
        </div>
      </div>`;
  }).join('');
}

// ═══════════════════════════════════════════════════════════════════
// Archive / Delete de conversaciones (double-click)
// ═══════════════════════════════════════════════════════════════════
window.openConvContextMenu = function(convId, convName){
  const body = `
    <div style="font-size:12px;color:var(--text2);margin-bottom:14px;line-height:1.5;">
      Conversación: <strong style="color:var(--text);">${convName}</strong>
    </div>
    <div style="display:flex;flex-direction:column;gap:8px;">
      <button class="btn ghost" style="text-align:left;padding:10px 12px;" onclick="archiveConversation('${convId}')">
        <div style="font-size:13px;font-weight:500;">📥 Archivar</div>
        <div style="font-size:10px;color:var(--text3);margin-top:3px;">Se oculta del Inbox principal. Podés restaurarla después desde filtros.</div>
      </button>
      <button class="btn ghost" style="text-align:left;padding:10px 12px;border-color:rgba(235,87,87,0.3);" onclick="confirmDeleteConversation('${convId}', '${convName}')">
        <div style="font-size:13px;font-weight:500;color:var(--danger);">✕ Eliminar</div>
        <div style="font-size:10px;color:var(--text3);margin-top:3px;">Borra la conversación del dashboard (soft-delete). Los mensajes originales quedan en DB.</div>
      </button>
    </div>
    <div style="padding:10px;background:var(--card2);border-radius:6px;font-size:10px;color:var(--text3);margin-top:14px;line-height:1.5;">
      💡 Tip: usa <strong style="color:var(--text2);">Archivar</strong> para limpiar el Inbox sin perder el historial. Usa <strong style="color:var(--text2);">Eliminar</strong> solo para spam o conversaciones irrelevantes.
    </div>
  `;
  showModal('Opciones de conversación', body,
    '<button class="btn ghost" onclick="closeModal()">Cerrar</button>');
};

window.archiveConversation = async function(convId){
  try {
    const nowIso = new Date().toISOString();
    await sbPatch('aria_conversations', convId, { archived_at: nowIso });
    closeModal();
    // Marcar localmente (NO removerla — debe aparecer en filtro ARCHIVADAS)
    const c = ARIA_SECTION.conversations.find(x => x.id === convId);
    if(c) c.archived_at = nowIso;

    if(ARIA_SECTION.activeConversation?.id === convId){
      ARIA_SECTION.activeConversation = null;
      document.getElementById('chat-panel').innerHTML = '<div style="padding:40px 20px;text-align:center;color:var(--text3);font-size:12px;">Selecciona una conversación de la lista</div>';
    }
    updateFilterCounts();
    renderConversationsList();
    window.toast && window.toast('📥 Conversación archivada', 'Mirala en filtro "Archivadas"', 'success');
  } catch(err){ window.toast && window.toast('Error', err.message, 'err'); }
};

// Restaurar conversación archivada → vuelve al Inbox principal
window.restoreConversation = async function(convId){
  try {
    await sbPatch('aria_conversations', convId, { archived_at: null });
    const c = ARIA_SECTION.conversations.find(x => x.id === convId);
    if(c) c.archived_at = null;
    updateFilterCounts();
    renderConversationsList();
    window.toast && window.toast('↺ Conversación restaurada', 'Volvió al Inbox', 'success');
  } catch(err){ window.toast && window.toast('Error', err.message, 'err'); }
};

window.confirmDeleteConversation = function(convId, convName){
  const body = `
    <div style="padding:14px;background:var(--danger-s);border-radius:6px;border:1px solid rgba(235,87,87,0.3);font-size:12px;color:var(--text);line-height:1.5;margin-bottom:14px;">
      ⚠ ¿Seguro que quieres eliminar la conversación con <strong>${convName}</strong>?
      <div style="font-size:10px;color:var(--text3);margin-top:6px;">Esta acción hace soft-delete: la conversación se oculta pero los mensajes quedan en DB. Podemos hacer hard-delete después si lo pides.</div>
    </div>
  `;
  showModal('Eliminar conversación', body, `
    <button class="btn ghost" onclick="closeModal()">Cancelar</button>
    <button class="btn danger" onclick="deleteConversation('${convId}')">Eliminar</button>
  `);
};

window.deleteConversation = async function(convId){
  try {
    await sbPatch('aria_conversations', convId, {
      deleted_at: new Date().toISOString()
    });
    closeModal();
    ARIA_SECTION.conversations = ARIA_SECTION.conversations.filter(c => c.id !== convId);
    if(ARIA_SECTION.activeConversation?.id === convId){
      ARIA_SECTION.activeConversation = null;
      document.getElementById('chat-panel').innerHTML = '<div style="padding:40px 20px;text-align:center;color:var(--text3);font-size:12px;">Selecciona una conversación de la lista</div>';
    }
    renderConversationsList();
    window.toast && window.toast('✕ Conversación eliminada', 'Soft-delete aplicado', 'success');
  } catch(err){ window.toast && window.toast('Error', err.message, 'err'); }
};

// Refresca solo los mensajes de una conversación (usado por realtime cuando
// llega un nuevo aria_message · evita re-fetch de la lista completa)
window.loadAriaMessages = async function(convId){
  if(!convId || !ARIA_SECTION.activeConversation || ARIA_SECTION.activeConversation.id !== convId){
    // No estamos viendo esa conv — actualizamos la lista para que aparezca el badge unread
    return;
  }
  try {
    const msgs = await sbGet('whatsapp_messages',
      `conversation_id=eq.${convId}&select=*&order=created_at.asc&limit=100`);
    ARIA_SECTION.messages = msgs;
    renderChatPanel();
  } catch(err){ console.warn('[loadAriaMessages] error:', err.message); }
};

// Expose currentAriaConvId for realtime handler compatibility
Object.defineProperty(window, 'currentAriaConvId', {
  get: () => ARIA_SECTION.activeConversation?.id || null,
  configurable: true
});

window.openConversation = async function(convId){
  const conv = ARIA_SECTION.conversations.find(c => c.id === convId);
  if(!conv) return;
  ARIA_SECTION.activeConversation = conv;
  renderConversationsList();

  // Cargar mensajes + datos extra del lead para perfil enriquecido (Bonus v2.1.52)
  try {
    const [msgs, leadData, leadAppts] = await Promise.all([
      sbGet('whatsapp_messages',
        `conversation_id=eq.${convId}&select=*&order=created_at.asc&limit=100`),
      conv.lead_id
        ? sbGet('leads', `id=eq.${conv.lead_id}&select=nombre,email,whatsapp,intent_score,fuente,utm_campaign,visitas,notas`)
        : Promise.resolve([]),
      conv.lead_id
        ? sbGet('appointments', `lead_id=eq.${conv.lead_id}&select=id,fecha,hora,servicio,estado&order=fecha.desc&limit=5`)
        : Promise.resolve([]),
    ]);
    ARIA_SECTION.messages = msgs;
    ARIA_SECTION.activeLead = leadData[0] || null;
    ARIA_SECTION.activeLeadAppts = leadAppts || [];
    renderChatPanel();
  } catch(err){
    document.getElementById('chat-panel').innerHTML = `<div style="padding:20px;color:var(--danger);">Error cargando mensajes: ${window.escapeHtml?.(err.message || 'desconocido') || 'error'}</div>`;
  }
};

function renderChatPanel(){
  const conv = ARIA_SECTION.activeConversation;
  if(!conv) return;
  const name = conv.nombre_contacto || conv.phone;
  const initials = (name[0] || '?').toUpperCase() + (name.split(' ')[1]?.[0] || '').toUpperCase();
  const isPaused = conv.status === 'paused';
  const isEscalated = conv.status === 'escalated';
  const statusDot = isPaused ? 'paused' : isEscalated ? 'escalated' : '';

  const banner = isPaused
    ? '<div class="chat-status-banner paused"><span style="color:var(--warn);">⏸</span><span>ARIA pausada en esta conversación. Tus respuestas son manuales.</span></div>'
    : '<div class="chat-status-banner"><span style="color:var(--accent);">A</span><span>ARIA está respondiendo automáticamente. Cambia a manual con "Tomar control"</span></div>';

  const toggleBtn = isPaused
    ? `<button class="btn primary sm" onclick="resumeAria('${conv.id}')">Devolver a ARIA</button>`
    : `<button class="btn sm" onclick="takeControl('${conv.id}')">Tomar control</button>`;

  let msgsHtml = '';
  let lastDate = '';
  ARIA_SECTION.messages.forEach(m => {
    const date = new Date(m.created_at).toLocaleDateString('es-MX', { day: '2-digit', month: 'short' });
    if(date !== lastDate){
      msgsHtml += `<div class="msg-system">${date.toUpperCase()}</div>`;
      lastDate = date;
    }
    const isOut = m.direction === 'outbound';
    const time = new Date(m.created_at).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
    const byBadge = m.sent_by === 'aria' ? '<span class="msg-by-aria">ARIA</span>'
                  : m.sent_by === 'human' ? '<span class="msg-by-human">MANUAL</span>'
                  : m.sent_by === 'template' ? '<span class="msg-by-aria">TEMPLATE</span>'
                  : '';
    msgsHtml += `
      <div class="msg ${isOut ? 'out' : 'in'}">
        ${isOut ? byBadge : ''}${escapeHtml(m.mensaje || '')}
        <div class="msg-time">${time}</div>
      </div>`;
  });

  if(!msgsHtml){
    msgsHtml = '<div style="text-align:center;color:var(--text3);padding:40px 20px;font-size:11px;">Sin mensajes aún</div>';
  }

  const placeholder = isPaused
    ? 'Escribe tu respuesta manual...'
    : 'Escribe para tomar el control, o deja que ARIA responda...';

  // v2.1.52 Bonus — perfil real enriquecido
  const lead = ARIA_SECTION.activeLead;
  const appts = ARIA_SECTION.activeLeadAppts || [];
  const escalationSummary = (conv.context && conv.context.escalation_summary) || null;
  const longSummary = (conv.context && conv.context.summary) || null;

  // Score chip
  let scoreChip = '';
  if (lead && typeof lead.intent_score === 'number') {
    const sc = lead.intent_score;
    const cls = sc >= 70 ? 'hot' : sc >= 40 ? 'warm' : 'cold';
    const lbl = sc >= 70 ? 'HOT' : sc >= 40 ? 'WARM' : 'COLD';
    scoreChip = `<span class="score-pill score-${cls}" style="font-size:9px;padding:2px 6px;margin-left:6px;">${lbl} ${sc}</span>`;
  }

  // Bloque "perfil" arriba del chat
  let profileHtml = '';
  if (lead) {
    const apptsList = appts.length
      ? appts.slice(0, 3).map(a => {
          const stChip = a.estado === 'completed' ? '✅' : a.estado === 'cancelled' ? '✕' : a.estado === 'no_show' ? '⚠' : a.estado === 'confirmed' ? '📅' : '⏳';
          return `<div style="font-size:10px;color:var(--text2);">${stChip} ${a.fecha} ${String(a.hora||'').slice(0,5)} · ${escapeHtml(a.servicio||'—')}</div>`;
        }).join('')
      : '<div style="font-size:10px;color:var(--text3);">Sin citas previas</div>';

    profileHtml = `
      <div style="padding:10px 14px;background:var(--card2);border-bottom:1px solid var(--border);font-size:11px;">
        <div style="display:grid;grid-template-columns:repeat(3, 1fr);gap:8px;color:var(--text2);">
          <div><strong style="color:var(--text);">📧</strong> ${lead.email ? escapeHtml(lead.email) : '<span class="dim">sin email</span>'}</div>
          <div><strong style="color:var(--text);">📱</strong> ${escapeHtml(lead.whatsapp || conv.phone)}</div>
          <div><strong style="color:var(--text);">🎯</strong> ${escapeHtml(lead.fuente || '—')}${lead.utm_campaign ? ' · ' + escapeHtml(lead.utm_campaign) : ''}</div>
        </div>
        <div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border);">
          <div style="font-size:10px;color:var(--text3);font-family:'Geist Mono',monospace;letter-spacing:1px;margin-bottom:4px;">HISTORIAL DE CITAS</div>
          ${apptsList}
        </div>
      </div>`;
  }

  // Bloque resumen (memoria larga + escalation)
  let summaryHtml = '';
  if (escalationSummary) {
    summaryHtml = `
      <div style="padding:10px 14px;background:rgba(242,201,76,0.08);border-bottom:1px solid var(--border);font-size:11px;">
        <div style="font-size:9px;color:var(--warn);font-family:'Geist Mono',monospace;letter-spacing:1px;margin-bottom:4px;">⚠ ARIA ESCALÓ · RESUMEN</div>
        <div style="color:var(--text2);line-height:1.5;">${escapeHtml(escalationSummary)}</div>
      </div>`;
  } else if (longSummary) {
    summaryHtml = `
      <div style="padding:10px 14px;background:var(--card2);border-bottom:1px solid var(--border);font-size:11px;">
        <div style="font-size:9px;color:var(--accent);font-family:'Geist Mono',monospace;letter-spacing:1px;margin-bottom:4px;">📝 RESUMEN DE CONVERSACIONES PREVIAS</div>
        <div style="color:var(--text2);line-height:1.5;">${escapeHtml(longSummary.slice(0,300))}${longSummary.length > 300 ? '…' : ''}</div>
      </div>`;
  }

  document.getElementById('chat-panel').innerHTML = `
    <div class="chat-head">
      <div class="conv-avatar">${initials}${conv.status !== 'resolved' ? `<span class="conv-avatar-dot ${statusDot}"></span>` : ''}</div>
      <div class="chat-who">
        <div class="chat-who-name">${escapeHtml(name)}${scoreChip}</div>
        <div class="chat-who-meta">${escapeHtml(conv.phone)} · ${conv.source || 'direct'} · ${conv.messages_count || ARIA_SECTION.messages.length} mensajes</div>
      </div>
      ${toggleBtn}
    </div>
    ${profileHtml}
    ${summaryHtml}
    ${banner}
    <div class="chat-msgs" id="chat-msgs">${msgsHtml}</div>
    <div class="chat-compose">
      <input id="compose-input" placeholder="${placeholder}" onkeypress="if(event.key==='Enter') sendManualMessage()">
      <button class="btn primary sm" onclick="sendManualMessage()">Enviar</button>
    </div>`;

  // Scroll to bottom
  const msgsEl = document.getElementById('chat-msgs');
  if(msgsEl) msgsEl.scrollTop = msgsEl.scrollHeight;
}

window.takeControl = async function(convId){
  try {
    await sbPatch('aria_conversations', convId, { status: 'paused' });
    const c = ARIA_SECTION.conversations.find(x => x.id === convId);
    if(c) c.status = 'paused';
    ARIA_SECTION.activeConversation.status = 'paused';
    updateFilterCounts();
    renderConversationsList();
    renderChatPanel();
    window.toast('Control tomado', 'ARIA pausada en esta conversación. Responde manualmente.', 'warn');
  } catch(err){ window.toast('Error', err.message, 'err'); }
};

window.resumeAria = async function(convId){
  try {
    await sbPatch('aria_conversations', convId, { status: 'active' });
    const c = ARIA_SECTION.conversations.find(x => x.id === convId);
    if(c) c.status = 'active';
    ARIA_SECTION.activeConversation.status = 'active';
    updateFilterCounts();
    renderConversationsList();
    renderChatPanel();
    window.toast('ARIA reactivada', 'Las auto-respuestas vuelven a funcionar.', 'success');
  } catch(err){ window.toast('Error', err.message, 'err'); }
};

window.sendManualMessage = async function(){
  const input = document.getElementById('compose-input');
  const text = input.value.trim();
  if(!text || !ARIA_SECTION.activeConversation) return;

  const conv = ARIA_SECTION.activeConversation;
  const payload = {
    client_id: CLIENT_ID,
    conversation_id: conv.id,
    direction: 'outbound',
    telefono: conv.phone,
    mensaje: text,
    sent_by: 'human',
    status: 'sent'
  };

  try {
    await sbInsert('whatsapp_messages', payload);
    // Auto-pausa ARIA al mandar manual
    if(conv.status !== 'paused') await sbPatch('aria_conversations', conv.id, { status: 'paused' });

    input.value = '';
    // Reload
    openConversation(conv.id);
    window.toast('✓ Enviado', 'Mensaje enviado. ARIA pausada.', 'success');
  } catch(err){ window.toast('Error', err.message, 'err'); }
};

// ===========================================================
// AUTOMATIZACIÓN
// ===========================================================
window.loadRules = async function(){
  try {
    const rules = await sbGet('aria_rules',
      `client_id=eq.${CLIENT_ID}&select=*&order=prioridad.desc`);
    ARIA_SECTION.rules = rules;
    renderRules();
  } catch(err){ console.warn('rules error:', err); }
};

function renderRules(){
  const rules = ARIA_SECTION.rules;
  const active = rules.filter(r => r.activo).length;
  const totalExec = rules.reduce((s, r) => s + (r.ejecutada_count || 0), 0);
  const escalations = rules.filter(r => r.action_type === 'escalate_human').reduce((s, r) => s + (r.ejecutada_count || 0), 0);

  const setTxt = (id, v) => { const el = document.getElementById(id); if(el) el.textContent = v; };
  setTxt('ar-active', active);
  setTxt('ar-active-sub', `de ${rules.length} totales`);
  setTxt('ar-exec24', totalExec);
  setTxt('ar-autoreply', totalExec > 0 ? Math.round((totalExec - escalations) / totalExec * 100) + '%' : '0%');
  setTxt('ar-esc', escalations);
  setTxt('ar-total', `${rules.length} reglas · ${active} activas`);

  const body = document.getElementById('ar-rules-body');
  if(!body) return;
  if(rules.length === 0){
    body.innerHTML = '<tr><td colspan="6" class="dim" style="text-align:center;padding:30px 20px;font-size:11px;">Sin reglas aún. Agregá una desde plantillas abajo.</td></tr>';
    return;
  }

  const triggerLabel = {
    first_message: 'FIRST MSG',
    keyword: 'KEYWORD',
    intent: 'INTENT',
    no_response: 'NO RESPONSE',
    schedule: 'SCHEDULE',
    appointment_created: 'ON APPT',
    appointment_tomorrow: 'APPT -24H',
    after_appointment: 'AFTER APPT'
  };
  const actionLabel = {
    reply_text: 'TEXT',
    reply_template: 'TEMPLATE',
    send_service_list: 'SERVICE LIST',
    send_buttons: 'BUTTONS',
    create_appointment: 'CREATE APPT',
    create_lead: 'CREATE LEAD',
    tag_conversation: 'TAG',
    escalate_human: 'ESCALATE',
    pause_aria: 'PAUSE',
    notify_owner: 'NOTIFY'
  };

  body.innerHTML = rules.map(r => {
    const trigKw = r.trigger_config?.keywords?.slice(0,3).join(', ') || '';
    const actionClass = r.action_type === 'escalate_human' ? 'escalate' : 'action';
    const opacity = r.activo ? '' : 'opacity:0.55;';
    return `
      <tr style="${opacity}">
        <td class="mono" style="color:${r.activo?'var(--text)':'var(--text3)'};font-weight:600;">${r.prioridad}</td>
        <td><strong>${escapeHtml(r.nombre)}</strong>${r.descripcion ? `<div class="dim" style="font-size:10px;margin-top:2px;">${escapeHtml(r.descripcion)}</div>` : ''}</td>
        <td><span class="rule-tag trigger">${triggerLabel[r.trigger_type] || r.trigger_type}</span>${trigKw ? `<div class="dim" style="font-size:10px;margin-top:3px;">${escapeHtml(trigKw)}</div>` : ''}</td>
        <td><span class="rule-tag ${actionClass}">${actionLabel[r.action_type] || r.action_type}</span></td>
        <td class="mono dim">${r.ejecutada_count || 0}</td>
        <td><label class="switch"><input type="checkbox" ${r.activo?'checked':''} onchange="toggleRule('${r.id}', this.checked)"><span class="slider"></span></label></td>
      </tr>`;
  }).join('');
}

window.toggleRule = async function(id, active){
  try {
    await sbPatch('aria_rules', id, { activo: active });
    const r = ARIA_SECTION.rules.find(x => x.id === id);
    if(r) r.activo = active;
    renderRules();
  } catch(err){ window.toast('Error', err.message, 'err'); }
};

window.openNewRule = function(){
  const body = `
    <div class="field"><div class="field-label">NOMBRE</div><input class="field-input" id="nr-nombre" placeholder="Ej: Saludo nuevo cliente"></div>
    <div class="field"><div class="field-label">DESCRIPCIÓN</div><input class="field-input" id="nr-desc" placeholder="Qué hace esta regla"></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
      <div class="field"><div class="field-label">TRIGGER</div>
        <select class="field-select" id="nr-trigger">
          <option value="first_message">Primera vez que escribe</option>
          <option value="keyword">Contiene palabra clave</option>
          <option value="intent">Intención detectada</option>
          <option value="schedule">Horario programado</option>
          <option value="appointment_created">Cita creada</option>
          <option value="appointment_tomorrow">Día antes de cita</option>
          <option value="after_appointment">Después de cita</option>
          <option value="no_response">Sin respuesta X tiempo</option>
        </select></div>
      <div class="field"><div class="field-label">ACCIÓN</div>
        <select class="field-select" id="nr-action">
          <option value="reply_text">Responder con texto</option>
          <option value="reply_template">Enviar template</option>
          <option value="send_service_list">Enviar lista de servicios</option>
          <option value="send_buttons">Enviar botones</option>
          <option value="create_appointment">Crear cita</option>
          <option value="escalate_human">Escalar a humano</option>
          <option value="notify_owner">Notificar al dueño</option>
        </select></div>
    </div>
    <div class="field"><div class="field-label">PALABRAS CLAVE (si aplica, separadas por coma)</div><input class="field-input" id="nr-keywords" placeholder="hola, buenas, saludos"></div>
    <div class="field"><div class="field-label">MENSAJE / TEMPLATE</div><textarea class="field-textarea" id="nr-message" placeholder="Hola {nombre}, bienvenido..."></textarea></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
      <div class="field"><div class="field-label">PRIORIDAD (0-100)</div><input class="field-input" id="nr-prio" type="number" value="50" min="0" max="100"></div>
      <div class="field"><div class="field-label">ACTIVA</div>
        <label style="display:flex;align-items:center;gap:10px;padding:8px 0;"><input type="checkbox" id="nr-activo" checked>Sí</label></div>
    </div>
  `;
  showModal('Nueva regla ARIA', body,
    '<button class="btn ghost" onclick="closeModal()">Cancelar</button><button class="btn primary" onclick="saveRule()">Guardar</button>');
};

window.saveRule = async function(){
  const payload = {
    client_id: CLIENT_ID,
    nombre: document.getElementById('nr-nombre').value,
    descripcion: document.getElementById('nr-desc').value,
    trigger_type: document.getElementById('nr-trigger').value,
    trigger_config: { keywords: document.getElementById('nr-keywords').value.split(',').map(s => s.trim()).filter(Boolean) },
    action_type: document.getElementById('nr-action').value,
    action_config: { message: document.getElementById('nr-message').value },
    prioridad: parseInt(document.getElementById('nr-prio').value) || 50,
    activo: document.getElementById('nr-activo').checked
  };
  try {
    await sbInsert('aria_rules', payload);
    closeModal();
    await loadRules();
    window.toast('✓ Regla creada', payload.nombre, 'success');
  } catch(err){ window.toast('Error', err.message, 'err'); }
};

// Templates sugeridas (hardcoded por vertical clinica_estetica)
const TEMPLATES_CLINICA = [
  { icon: '👋', nombre: 'Saludo nuevo contacto', desc: 'Primera vez que escribe un número', trigger_type: 'first_message', action_type: 'reply_template', prio: 100,
    action_config: { message: '¡Hola! 👋 Bienvenida a {empresa}. Cuéntame en qué puedo ayudarte.' }},
  { icon: '💰', nombre: 'Pregunta por precios', desc: 'Responde con lista de servicios', trigger_type: 'keyword', prio: 95,
    trigger_config: { keywords: ['precio','costo','cuánto','valor'] },
    action_type: 'send_service_list' },
  { icon: '📅', nombre: 'Pide agendar cita', desc: 'Ofrece slots disponibles', trigger_type: 'keyword', prio: 90,
    trigger_config: { keywords: ['cita','agenda','turno','reservar'] },
    action_type: 'create_appointment' },
  { icon: '📍', nombre: 'Pregunta por ubicación', desc: 'Envía dirección y Google Maps', trigger_type: 'keyword', prio: 85,
    trigger_config: { keywords: ['dónde','ubicación','dirección','llegar'] },
    action_type: 'reply_text',
    action_config: { message: 'Estamos en {direccion}. Aquí el mapa: {google_maps_link}' }},
  { icon: '⏰', nombre: 'Recordatorio 24h antes', desc: 'Auto 24h antes de cita', trigger_type: 'appointment_tomorrow', prio: 80,
    action_type: 'reply_template',
    action_config: { message: 'Hola {nombre}, te recordamos tu cita mañana a las {hora}. ¿Confirmas?' }},
  { icon: '🌙', nombre: 'Fuera de horario', desc: '22h-8h: auto-respuesta', trigger_type: 'schedule', prio: 75,
    trigger_config: { hours: '22:00-08:00' },
    action_type: 'reply_template',
    action_config: { message: 'Hola, nuestro horario es de 8am a 10pm. Te respondemos mañana temprano.' }},
  { icon: '🚨', nombre: 'Escalar urgencias', desc: 'Alergia, dolor fuerte → humano', trigger_type: 'keyword', prio: 70,
    trigger_config: { keywords: ['alergia','dolor fuerte','urgente','emergencia'] },
    action_type: 'escalate_human' },
  { icon: '⭐', nombre: 'Post-cita: pedir reseña', desc: '48h después de appointment completed', trigger_type: 'after_appointment', prio: 60,
    trigger_config: { hours_after: 48 },
    action_type: 'reply_template',
    action_config: { message: '¡Hola {nombre}! ¿Cómo te fue con tu {servicio}? Nos encantaría tu reseña.' }},
  { icon: '💤', nombre: 'Reactivación 30d inactivos', desc: 'Sin contacto 30d → promo', trigger_type: 'no_response', prio: 40,
    trigger_config: { days: 30 },
    action_type: 'reply_template',
    action_config: { message: '{nombre}, te extrañamos. Tenemos 15% de descuento si reservas esta semana.' }},
  { icon: '🎂', nombre: 'Felicitación cumpleaños', desc: 'Día del cumpleaños del cliente', trigger_type: 'schedule', prio: 50,
    trigger_config: { birthday: true },
    action_type: 'reply_template',
    action_config: { message: '¡Feliz cumpleaños {nombre}! 🎂 Regalo: 20% descuento este mes.' }},
  { icon: '👥', nombre: 'Cliente recurrente detectado', desc: 'Saludo personalizado 3+ visitas', trigger_type: 'first_message', prio: 98,
    action_type: 'reply_template',
    action_config: { message: '¡Hola de nuevo {nombre}! Qué gusto verte. ¿En qué te ayudamos hoy?' }},
  { icon: '💊', nombre: 'Cuidados post-tratamiento', desc: 'Guía 2h después', trigger_type: 'after_appointment', prio: 65,
    trigger_config: { hours_after: 2 },
    action_type: 'reply_template',
    action_config: { message: 'Cuidados post-{servicio}: {instrucciones}. Cualquier duda escríbenos.' }},
];

function loadTemplates(){
  // Dedup contra rules existentes (por nombre). Solo mostramos las que NO están ya.
  const existingNames = new Set((ARIA_SECTION.rules || []).map(r => (r.nombre || '').trim()));
  const pending = TEMPLATES_CLINICA.filter(t => !existingNames.has(t.nombre));

  const el = document.getElementById('ar-templates');
  if(!el) return;
  if(pending.length === 0){
    el.innerHTML = '<div style="grid-column:1/-1;padding:30px;text-align:center;color:var(--text3);font-size:11px;">✓ Todas las plantillas están instaladas</div>';
    return;
  }

  // Usamos el índice REAL de TEMPLATES_CLINICA (no el del array filtrado)
  // para que installTemplate(idx) reciba siempre el índice correcto.
  el.innerHTML = pending.map(t => {
    const realIdx = TEMPLATES_CLINICA.indexOf(t);
    return `
    <div class="tpl-card" data-tpl-idx="${realIdx}" onclick="installTemplate(${realIdx}, this)">
      <div class="tpl-icon">${t.icon}</div>
      <div class="tpl-name">${escapeHtml(t.nombre)}</div>
      <div class="tpl-desc">${escapeHtml(t.desc)}</div>
      <div class="tpl-add">+ AGREGAR</div>
    </div>`;
  }).join('');
}

// Flag para prevenir double-click global mientras un install está en curso.
let _installBusy = false;

window.installTemplate = async function(idx, cardEl){
  if(_installBusy) return; // double-click guard global
  const t = TEMPLATES_CLINICA[idx];
  if(!t){ console.warn('[installTemplate] idx inválido:', idx); return; }

  // Dedup defensivo: si el nombre ya existe en ARIA_SECTION.rules, abortamos.
  // Esto protege contra race conditions donde el UI mostró la card pero
  // la DB ya tiene la rule (ej: el user cambió de tab y volvió rápido).
  const existing = (ARIA_SECTION.rules || []).find(r => (r.nombre || '').trim() === t.nombre);
  if(existing){
    window.toast && window.toast('Ya instalada', `"${t.nombre}" ya está en tus reglas`, 'warn');
    loadTemplates(); // refresca UI para sacarla de "pendientes"
    return;
  }

  // Disable visual de la card (feedback inmediato)
  _installBusy = true;
  if(cardEl){
    cardEl.style.opacity = '0.4';
    cardEl.style.pointerEvents = 'none';
    const addLabel = cardEl.querySelector('.tpl-add');
    if(addLabel) addLabel.textContent = '⏳ INSTALANDO…';
  }

  const payload = {
    client_id: CLIENT_ID,
    nombre: t.nombre,
    descripcion: t.desc,
    trigger_type: t.trigger_type,
    trigger_config: t.trigger_config || {},
    action_type: t.action_type,
    action_config: t.action_config || {},
    prioridad: t.prio,
    activo: true
  };

  try {
    await sbInsert('aria_rules', payload);
    // Recargar rules ANTES de re-renderizar templates → filtro correcto
    await loadRules();
    loadTemplates();
    window.toast && window.toast('✓ Plantilla instalada', t.nombre, 'success');
  } catch(err){
    // Si es UNIQUE violation (DB protege contra duplicate), manejamos graceful
    const msg = String(err?.message || err || '');
    if(/unique|duplicate|aria_rules_client_nombre_uq/i.test(msg)){
      window.toast && window.toast('Ya instalada', `"${t.nombre}" ya existía en tus reglas`, 'warn');
      await loadRules();
      loadTemplates();
    } else {
      window.toast && window.toast('Error al instalar', msg.slice(0, 120) || 'desconocido', 'err');
      // Revertir estado visual de la card
      if(cardEl){
        cardEl.style.opacity = '';
        cardEl.style.pointerEvents = '';
        const addLabel = cardEl.querySelector('.tpl-add');
        if(addLabel) addLabel.textContent = '+ AGREGAR';
      }
    }
  } finally {
    _installBusy = false;
  }
};

// ===========================================================
// CONEXIÓN
// ===========================================================
window.renderConnectionStatus = function(){
  const c = window.currentClient || {};
  const el = document.getElementById('conn-status-card');
  const isConnected = c.wa_status === 'connected';

  if(isConnected){
    el.innerHTML = `
      <div class="conn-status-header">
        <div class="conn-icon">
          <svg width="22" height="22" viewBox="0 0 18 18" fill="currentColor"><path d="M9 1.5a7.5 7.5 0 00-6.4 11.3L1.5 16.5l3.8-1.1A7.5 7.5 0 109 1.5z"/></svg>
        </div>
        <div style="flex:1;">
          <div class="conn-title">WhatsApp Cloud API conectado</div>
          <div class="conn-sub">Meta for Developers · Verified Business</div>
        </div>
        <span class="live-chip"><span class="live-dot"></span>LIVE</span>
      </div>
      <div class="conn-field"><div class="conn-field-lbl">Número verificado</div><div class="conn-field-val">${c.wa_display_phone || '—'} <span class="verified-chip" style="margin-left:6px;">VERIFIED</span></div></div>
      <div class="conn-field"><div class="conn-field-lbl">Business Name</div><div class="conn-field-val">${c.wa_business_name || '—'}</div></div>
      <div class="conn-field"><div class="conn-field-lbl">Phone Number ID</div><div class="conn-field-val conn-field-mask">${maskId(c.wa_phone_number_id)}</div></div>
      <div class="conn-field"><div class="conn-field-lbl">WABA ID</div><div class="conn-field-val conn-field-mask">${maskId(c.wa_waba_id)}</div></div>
      <div class="conn-field"><div class="conn-field-lbl">Access Token</div><div class="conn-field-val conn-field-mask">•••••••••••••</div></div>
      <div class="conn-field"><div class="conn-field-lbl">Quality Rating</div><div class="conn-field-val"><span class="quality-chip" style="color:var(--success);">${c.wa_quality_rating || 'GREEN'}</span></div></div>
      <div class="conn-actions">
        <button class="btn ghost" onclick="testWaConnection()">Probar conexión</button>
        <button class="btn ghost" style="margin-left:auto;color:var(--danger);border-color:rgba(235,87,87,0.3);" onclick="disconnectWa()">Desconectar</button>
      </div>`;
  } else {
    // v2.3.0 · Wizard simplificado · UNA sola opción (migración del número actual)
    // El requisito de número exclusivo se valida en checkout Stripe + welcome email.
    el.innerHTML = `
      <!-- Hero card -->
      <div style="background:linear-gradient(135deg,var(--card),var(--card2));border:1px solid var(--border);border-radius:12px;padding:22px 24px;margin-bottom:14px;display:flex;align-items:center;gap:18px;">
        <div style="width:48px;height:48px;border-radius:12px;background:var(--warn-s);border:1px solid rgba(201,168,120,0.25);color:var(--warn);display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:700;font-family:'Geist Mono',monospace;flex-shrink:0;">!</div>
        <div style="flex:1;">
          <div style="font-size:16px;font-weight:600;">ARIA está desconectada</div>
          <div style="font-size:12px;color:var(--text2);margin-top:4px;line-height:1.5;">Conecta tu número de WhatsApp Business para activar ARIA · proceso oficial Meta · 3 minutos · cero riesgo de ban.</div>
        </div>
      </div>

      <!-- Card única · Conectar mi número -->
      <div style="background:var(--card);border:1px solid rgba(111,207,151,0.35);border-radius:12px;padding:24px;margin-bottom:14px;max-width:600px;margin-left:auto;margin-right:auto;">
        <div style="width:42px;height:42px;border-radius:10px;background:var(--card2);border:1px solid var(--border2);display:flex;align-items:center;justify-content:center;font-size:18px;margin-bottom:14px;">📱</div>
        <div style="font-size:15px;font-weight:600;margin-bottom:6px;letter-spacing:-0.2px;">Conectar mi número de WhatsApp Business</div>
        <div style="font-size:12px;color:var(--text2);line-height:1.6;margin-bottom:16px;">Tu número del negocio pasa a la API oficial de Meta. Mantienes el mismo número y tus pacientes te siguen escribiendo igual · ARIA responde automáticamente desde el dashboard.</div>

        <ul style="list-style:none;padding:0;margin:0 0 18px;font-size:11px;color:var(--text2);line-height:1.8;">
          <li style="padding:4px 0;border-bottom:1px dashed var(--border);"><span style="color:var(--success);margin-right:6px;">✓</span> Mismo número · sin cambios para tus pacientes</li>
          <li style="padding:4px 0;border-bottom:1px dashed var(--border);"><span style="color:var(--success);margin-right:6px;">✓</span> Setup en 3 minutos · proceso oficial Meta</li>
          <li style="padding:4px 0;border-bottom:1px dashed var(--border);"><span style="color:var(--success);margin-right:6px;">✓</span> ARIA responde al instante</li>
          <li style="padding:4px 0;border-bottom:1px dashed var(--border);"><span style="color:var(--success);margin-right:6px;">✓</span> Cero riesgo de ban · 100% legal</li>
          <li style="padding:4px 0;"><span style="color:var(--success);margin-right:6px;">✓</span> Multi-agente · varias personas pueden atender</li>
        </ul>

        <button class="btn primary" style="width:100%;padding:10px;font-weight:600;" onclick="openConnectWizard()">Conectar mi número</button>
      </div>

      <!-- Help section -->
      <div class="panel" style="padding:18px;max-width:600px;margin:0 auto;">
        <div style="font-size:13px;font-weight:600;margin-bottom:14px;">¿Cómo funciona la conexión?</div>

        <div style="display:flex;gap:10px;padding:10px 0;border-bottom:1px dashed var(--border);">
          <div style="width:22px;height:22px;border-radius:11px;background:var(--card2);border:1px solid var(--border2);display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:600;flex-shrink:0;font-family:'Geist Mono',monospace;color:var(--text2);">1</div>
          <div style="flex:1;font-size:11px;color:var(--text2);line-height:1.5;"><strong style="color:var(--text);">Click "Conectar mi número"</strong> · Te guiamos por el proceso oficial de Meta · login con Facebook.</div>
        </div>

        <div style="display:flex;gap:10px;padding:10px 0;border-bottom:1px dashed var(--border);">
          <div style="width:22px;height:22px;border-radius:11px;background:var(--card2);border:1px solid var(--border2);display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:600;flex-shrink:0;font-family:'Geist Mono',monospace;color:var(--text2);">2</div>
          <div style="flex:1;font-size:11px;color:var(--text2);line-height:1.5;"><strong style="color:var(--text);">Verificas tu número por SMS</strong> · Meta envía un código a tu celular · lo ingresas en el popup.</div>
        </div>

        <div style="display:flex;gap:10px;padding:10px 0;border-bottom:1px dashed var(--border);">
          <div style="width:22px;height:22px;border-radius:11px;background:var(--card2);border:1px solid var(--border2);display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:600;flex-shrink:0;font-family:'Geist Mono',monospace;color:var(--text2);">3</div>
          <div style="flex:1;font-size:11px;color:var(--text2);line-height:1.5;"><strong style="color:var(--text);">Tu número migra a Cloud API</strong> · Proceso automático · la app WhatsApp Business del teléfono se desactiva.</div>
        </div>

        <div style="display:flex;gap:10px;padding:10px 0;">
          <div style="width:22px;height:22px;border-radius:11px;background:var(--card2);border:1px solid var(--border2);display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:600;flex-shrink:0;font-family:'Geist Mono',monospace;color:var(--text2);">4</div>
          <div style="flex:1;font-size:11px;color:var(--text2);line-height:1.5;"><strong style="color:var(--text);">ARIA queda activa</strong> · Empieza a responder · cada paciente que escriba se captura automáticamente como contacto.</div>
        </div>

        <div style="margin-top:14px;padding:10px 12px;background:var(--info-s);border:1px solid rgba(138,154,168,0.18);border-radius:6px;font-size:10px;color:var(--text2);line-height:1.5;">
          <strong style="color:var(--accent);">Recordatorio:</strong> Como confirmaste al registrarte, tu número debe ser exclusivo del negocio. Si tienes mensajes personales mezclados, profesionaliza tu operación antes de continuar.
        </div>
      </div>`;
  }
};

// v2.3.0 · Wizard de conexión (proceso oficial Meta) · launcher
window.openConnectWizard = function(){
  // Por ahora, mientras no tengamos Tech Provider de Meta, el wizard usa el form manual
  // (Phone Number ID + WABA ID + Token). Post-Tech Provider lo reemplazamos por Embedded Signup.
  const body = `
    <div style="padding:14px;background:var(--info-s);border:1px solid rgba(138,154,168,0.18);border-radius:8px;margin-bottom:14px;font-size:11px;color:var(--text2);line-height:1.5;">
      <strong style="color:var(--accent);">Setup oficial Meta:</strong> necesitas tu Phone Number ID, WABA ID y Access Token de Meta for Developers. Si aún no los tienes, <a style="color:var(--info);cursor:pointer;" onclick="closeModal();showSetupGuide()">aquí la guía paso a paso</a>.
    </div>
    <div class="field"><div class="field-label">PHONE NUMBER ID</div><input class="field-input" id="wa-phone-id" placeholder="108913974••••••"></div>
    <div class="field" style="margin-top:10px;"><div class="field-label">WABA ID (WhatsApp Business Account ID)</div><input class="field-input" id="wa-waba-id" placeholder="452184••••••"></div>
    <div class="field" style="margin-top:10px;"><div class="field-label">ACCESS TOKEN (permanente)</div><input class="field-input" id="wa-token" type="password" placeholder="EAAFxxxxxxxxx..."></div>
    <div class="field" style="margin-top:10px;"><div class="field-label">NÚMERO (display)</div><input class="field-input" id="wa-phone" placeholder="+52 998 555 1234"></div>
    <div class="field" style="margin-top:10px;"><div class="field-label">BUSINESS NAME</div><input class="field-input" id="wa-bname" placeholder="Mi Clínica Estética"></div>
  `;
  showModal('Conectar mi número a WhatsApp Cloud API', body,
    '<button class="btn ghost" onclick="closeModal()">Cancelar</button>'+
    '<button class="btn primary" onclick="connectWa()">Conectar</button>'
  );
};

function maskId(id){
  if(!id) return '—';
  if(id.length <= 8) return id;
  return id.slice(0, 4) + '•••••' + id.slice(-3);
}

window.connectWa = async function(){
  // Sprint 1C: el token se encripta en edge function (AES-256-GCM) antes de persistir.
  // Nunca guardamos plaintext en la DB.
  const tokenInput = document.getElementById('wa-token');
  const token = (tokenInput?.value || '').trim();

  const payload = {
    wa_phone_number_id: document.getElementById('wa-phone-id').value.trim(),
    wa_waba_id: document.getElementById('wa-waba-id').value.trim(),
    wa_display_phone: document.getElementById('wa-phone').value.trim(),
    wa_business_name: document.getElementById('wa-bname').value.trim(),
    wa_status: 'connected',
    wa_verified_at: new Date().toISOString(),
    wa_quality_rating: 'GREEN'
  };

  if(!payload.wa_phone_number_id || !token){
    window.toast('Faltan datos', 'Phone Number ID y Access Token son requeridos', 'warn');
    return;
  }
  if(token.length < 20){
    window.toast('Token inválido', 'El token de Meta debe tener al menos 20 caracteres', 'warn');
    return;
  }

  try {
    // 1) Campos no-sensibles: patch directo vía PostgREST (RLS protege)
    await sbPatch('clients', CLIENT_ID, payload);

    // 2) Token sensible: edge function encrypt-wa-token (AES-256-GCM con master key en secrets)
    const encResp = await fetch(`${SUPABASE_URL}/functions/v1/encrypt-wa-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + window.ACCESS_TOKEN,
        'apikey': SUPABASE_ANON,
      },
      body: JSON.stringify({ token, client_id: CLIENT_ID }),
    });
    const encData = await encResp.json().catch(() => ({}));
    if(!encResp.ok || !encData.success){
      throw new Error('No pudimos encriptar el token: ' + (encData.error || `HTTP ${encResp.status}`));
    }

    // 3) Higiene: limpiar el input del DOM para que el plaintext no quede en memoria
    if(tokenInput){ tokenInput.value = ''; tokenInput.placeholder = '••••••• (token encriptado y guardado)'; }

    Object.assign(window.currentClient, payload);
    window.toast('✓ WhatsApp conectado', `${payload.wa_display_phone} · token encriptado AES-256-GCM`, 'success');
    if(typeof closeModal === 'function') closeModal();
    loadAriaSection();
    renderConnectionStatus();
  } catch(err){ window.toast('Error', err.message || String(err), 'err'); }
};

window.disconnectWa = async function(){
  if(!confirm('¿Desconectar WhatsApp? ARIA dejará de responder mensajes.')) return;
  try {
    await sbPatch('clients', CLIENT_ID, { wa_status: 'disconnected', wa_verified_at: null });
    window.currentClient.wa_status = 'disconnected';
    loadAriaSection();
    renderConnectionStatus();
    window.toast('Desconectado', 'WhatsApp desvinculado', 'warn');
  } catch(err){ window.toast('Error', err.message, 'err'); }
};

window.testWaConnection = function(){
  window.toast('🔍 Probando conexión...', 'En producción esto llamaría Meta Graph API', 'success');
};

window.showSetupGuide = function(){
  const body = `
    <div style="font-size:12px;line-height:1.7;color:var(--text2);">
      <ol style="padding-left:20px;">
        <li style="margin-bottom:10px;">Ve a <a href="https://developers.facebook.com" target="_blank" style="color:var(--accent);">developers.facebook.com</a> y crea una cuenta business</li>
        <li style="margin-bottom:10px;">En <strong style="color:var(--text);">My Apps</strong> → crea una nueva app tipo <strong>Business</strong></li>
        <li style="margin-bottom:10px;">Agrega el producto <strong style="color:var(--text);">WhatsApp</strong></li>
        <li style="margin-bottom:10px;">En WhatsApp → API Setup, obtén:<ul><li><strong>Phone number ID</strong></li><li><strong>WABA ID</strong></li><li><strong>Temporary access token</strong> (genera uno permanente después)</li></ul></li>
        <li style="margin-bottom:10px;">Agrega tu número de WhatsApp Business y verifícalo vía SMS/llamada</li>
        <li style="margin-bottom:10px;">Configura el webhook apuntando a: <code style="background:var(--card2);padding:2px 6px;border-radius:3px;font-size:10px;">api.dominiosystem.com/wa/webhook</code></li>
        <li style="margin-bottom:10px;">Copia las credenciales aquí y listo</li>
      </ol>
      <div style="padding:12px;background:var(--success-s);border-radius:6px;margin-top:14px;font-size:11px;">
        <strong style="color:var(--success);">💡 Tip:</strong> El proceso toma 1-3 días por la verificación de Meta. Si necesitas ayuda, contáctanos y lo hacemos contigo.
      </div>
    </div>`;
  showModal('Guía: Conectar WhatsApp Cloud API', body,
    '<button class="btn ghost" onclick="closeModal()">Cerrar</button><button class="btn primary" onclick="closeModal();go(\'settings\')">Contactar soporte</button>');
};

// ===========================================================
// CONTACTOS (v2.3.0 · Sprint Contactos en ARIA)
// Lee de la tabla `leads` · NO migra datos · solo renombra UI
// ===========================================================
window.CONTACTOS = { items: [], filter: 'all', search: '' };

window.loadContactos = async function(){
  try {
    const items = await sbGet(
      'leads',
      `client_id=eq.${CLIENT_ID}&select=id,nombre,whatsapp,email,fuente,status,tags,created_at,ultima_visita,proxima_cita,visitas&order=created_at.desc&limit=500`
    );
    window.CONTACTOS.items = Array.isArray(items) ? items : [];
    renderContactos();
  } catch(err){
    console.error('[Contactos] error:', err);
    document.getElementById('contactos-tbody').innerHTML =
      '<tr><td colspan="7" class="dim" style="text-align:center;padding:30px 20px;font-size:11px;color:var(--danger);">Error al cargar contactos · ' + (err.message || '') + '</td></tr>';
  }
};

function _contactosFiltered(){
  const { items, filter, search } = window.CONTACTOS;
  const q = (search || '').trim().toLowerCase();

  return items.filter(c => {
    // Filter by status bucket
    if(filter === 'recurrente' && c.status !== 'cliente') return false;
    if(filter === 'nuevo' && !['nuevo','contactado','calificado'].includes(c.status || 'nuevo')) return false;
    if(filter === 'inactivo'){
      const last = c.ultima_visita ? new Date(c.ultima_visita).getTime() : 0;
      const ninetyDaysAgo = Date.now() - 90*86400000;
      if(last >= ninetyDaysAgo) return false;
    }
    // Filter by search
    if(q){
      const haystack = [c.nombre, c.whatsapp, c.email, ...(c.tags || [])]
        .filter(Boolean).join(' ').toLowerCase();
      if(!haystack.includes(q)) return false;
    }
    return true;
  });
}

function _statusBucketCount(items, bucket){
  return items.filter(c => {
    if(bucket === 'recurrente') return c.status === 'cliente';
    if(bucket === 'nuevo') return ['nuevo','contactado','calificado'].includes(c.status || 'nuevo');
    if(bucket === 'inactivo'){
      const last = c.ultima_visita ? new Date(c.ultima_visita).getTime() : 0;
      return last < (Date.now() - 90*86400000);
    }
    return true;
  }).length;
}

function renderContactos(){
  const items = _contactosFiltered();
  const all = window.CONTACTOS.items;
  const tbody = document.getElementById('contactos-tbody');
  if(!tbody) return;

  // Counters
  const setText = (id, v) => { const el = document.getElementById(id); if(el) el.textContent = '(' + v + ')'; };
  setText('contactos-count-all', all.length);
  setText('contactos-count-rec', _statusBucketCount(all, 'recurrente'));
  setText('contactos-count-new', _statusBucketCount(all, 'nuevo'));
  setText('contactos-count-inact', _statusBucketCount(all, 'inactivo'));

  // Summary text
  const summary = document.getElementById('contactos-summary');
  if(summary) summary.textContent = items.length + ' contactos';

  // Tab count
  const tabCount = document.getElementById('contactos-count');
  if(tabCount) tabCount.textContent = all.length;

  if(items.length === 0){
    tbody.innerHTML = '<tr><td colspan="7" class="dim" style="text-align:center;padding:30px 20px;font-size:11px;">Aún no tienes contactos. Cuando un paciente te escriba, ARIA lo agrega aquí automáticamente.</td></tr>';
    return;
  }

  // Determine origen (auto if from ARIA / WA / landing, manual otherwise)
  const fmtDate = (iso) => {
    if(!iso) return '—';
    try {
      const d = new Date(iso);
      const today = new Date(); today.setHours(0,0,0,0);
      const dayMs = 86400000;
      const diff = Math.floor((today.getTime() - d.setHours(0,0,0,0)) / dayMs);
      if(diff === 0) return 'Hoy';
      if(diff === 1) return 'Ayer';
      if(diff < 7) return diff + 'd';
      return d.toLocaleDateString('es', { day:'2-digit', month:'short' });
    } catch(e){ return '—'; }
  };

  tbody.innerHTML = items.map(c => {
    const tagsHtml = (c.tags && c.tags.length)
      ? c.tags.slice(0, 3).map(t => '<span class="contacto-tag-chip">' + escapeHtml(t) + '</span>').join('')
        + (c.tags.length > 3 ? '<span class="contacto-tag-chip">+' + (c.tags.length - 3) + '</span>' : '')
      : '<span class="dim" style="font-size:10px;">—</span>';

    const origen = ['aria','whatsapp','wa_webhook','landing_page'].includes((c.fuente || '').toLowerCase())
      ? '<span class="contacto-source-badge auto">Auto</span>'
      : '<span class="contacto-source-badge manual">Manual</span>';

    const lastActivity = c.ultima_visita || c.proxima_cita || c.created_at;

    return `
      <tr>
        <td><strong>${escapeHtml(c.nombre || '—')}</strong></td>
        <td><span style="font-family:'Geist Mono',monospace;font-size:11px;color:var(--text2);">${escapeHtml(c.whatsapp || '—')}</span></td>
        <td>${c.email ? '<a href="mailto:'+escapeHtml(c.email)+'" style="color:var(--info);text-decoration:none;font-size:11px;">'+escapeHtml(c.email)+'</a>' : '<span class="dim" style="font-size:10px;">—</span>'}</td>
        <td>${tagsHtml}</td>
        <td>${origen}</td>
        <td><span style="font-family:'Geist Mono',monospace;font-size:10px;color:var(--text3);">${fmtDate(lastActivity)}</span></td>
        <td>
          <button class="btn ghost" style="font-size:10px;padding:4px 8px;" onclick="openContactoDetail && openContactoDetail('${c.id}')">Ver</button>
          <button class="btn ghost" style="font-size:10px;padding:4px 8px;" onclick="ariaTab('conv'); window.toast && window.toast('Abre la conversación desde la lista','','info');">Chat</button>
        </td>
      </tr>
    `;
  }).join('');
}

window.contactosSearch = function(value){
  window.CONTACTOS.search = value || '';
  renderContactos();
};

window.contactosFilter = function(filter){
  window.CONTACTOS.filter = filter;
  document.querySelectorAll('[data-cfilter]').forEach(b => {
    b.classList.toggle('active', b.dataset.cfilter === filter);
  });
  renderContactos();
};

// Helper escape (si ya existe global, no overrider)
if(typeof escapeHtml !== 'function'){
  window.escapeHtml = function(s){
    if(s == null) return '';
    return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  };
}

// Modal Nuevo Contacto · v2.3.0
window.openNewContactModal = function(){
  const tagsCommon = ['Recurrente','Botox','Limpieza facial','Acné','Anti-edad','Primera visita','Embarazada','Alérgica','VIP'];
  const body = `
    <div style="padding:14px 16px;background:var(--info-s);border:1px solid rgba(138,154,168,0.2);border-radius:8px;margin-bottom:14px;font-size:11px;color:var(--text2);line-height:1.5;">
      <strong style="color:var(--accent);">Tip:</strong> Cuando un paciente te escribe, ARIA lo agrega solo. Solo agrega manual a los pacientes que ya conoces.
    </div>
    <div class="field"><div class="field-label">NOMBRE COMPLETO *</div><input class="field-input" id="nc-nombre" placeholder="María García"></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px;">
      <div class="field"><div class="field-label">TELÉFONO *</div><input class="field-input" id="nc-whatsapp" placeholder="+52 998 555 1234"></div>
      <div class="field"><div class="field-label">EMAIL</div><input class="field-input" id="nc-email" placeholder="maria@gmail.com"></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px;">
      <div class="field"><div class="field-label">ESTADO</div>
        <select class="field-select" id="nc-status">
          <option value="nuevo">Nuevo</option>
          <option value="cliente">Recurrente</option>
          <option value="perdido">Inactivo</option>
        </select>
      </div>
      <div class="field"><div class="field-label">ORIGEN</div>
        <select class="field-select" id="nc-fuente">
          <option value="manual">Walk-in</option>
          <option value="recomendacion">Recomendación</option>
          <option value="instagram">Instagram</option>
          <option value="otro">Otro</option>
        </select>
      </div>
    </div>
    <div class="field" style="margin-top:10px;">
      <div class="field-label">ETIQUETAS · TÚ LAS DEFINES (ARIA NO ETIQUETA SOLA)</div>
      <div id="nc-tags-selected" style="display:flex;flex-wrap:wrap;gap:5px;min-height:28px;padding:6px;background:var(--card2);border:1px solid var(--border);border-radius:6px;margin-bottom:8px;"></div>
      <div style="display:flex;gap:6px;align-items:center;">
        <input class="field-input" id="nc-tag-input" placeholder="Escribe etiqueta y presiona Enter" onkeypress="if(event.key==='Enter'){event.preventDefault();ncAddTag()}">
        <button class="btn" style="padding:6px 12px;font-size:11px;" onclick="ncAddTag()">+ Agregar</button>
      </div>
      <div style="margin-top:10px;font-size:9px;color:var(--text3);font-family:'Geist Mono',monospace;letter-spacing:1px;text-transform:uppercase;">SUGERIDAS</div>
      <div id="nc-tags-suggested" style="display:flex;flex-wrap:wrap;gap:5px;margin-top:6px;">
        ${tagsCommon.map(t => `<span class="contacto-tag-chip" style="cursor:pointer;border-style:dashed;" onclick="ncSuggestTag(this,'${t}')">${t}</span>`).join('')}
      </div>
    </div>
    <div class="field" style="margin-top:10px;">
      <div class="field-label">NOTAS INTERNAS</div>
      <textarea class="field-input" id="nc-notas" rows="3" placeholder="Preferencias, alergias, información relevante..."></textarea>
    </div>
  `;
  showModal('Nuevo contacto', body,
    '<button class="btn ghost" onclick="closeModal()">Cancelar</button>'+
    '<button class="btn primary" onclick="saveNewContact()">Guardar contacto</button>'
  );
  // init tags state
  window._ncTags = [];
};

window.ncAddTag = function(){
  const input = document.getElementById('nc-tag-input');
  if(!input) return;
  const v = (input.value || '').trim();
  if(!v) return;
  if(!window._ncTags) window._ncTags = [];
  if(window._ncTags.includes(v)) return;
  window._ncTags.push(v);
  ncRenderSelectedTags();
  input.value = '';
  input.focus();
};

window.ncSuggestTag = function(el, name){
  if(!window._ncTags) window._ncTags = [];
  if(window._ncTags.includes(name)) return;
  window._ncTags.push(name);
  ncRenderSelectedTags();
  if(el){ el.style.opacity = '0.4'; el.style.pointerEvents = 'none'; }
};

function ncRenderSelectedTags(){
  const c = document.getElementById('nc-tags-selected');
  if(!c) return;
  if(!window._ncTags || !window._ncTags.length){
    c.innerHTML = '<span class="dim" style="font-size:11px;font-style:italic;padding:2px 4px;">Sin etiquetas aún</span>';
    return;
  }
  c.innerHTML = window._ncTags.map((t, i) =>
    '<span class="contacto-tag-chip" style="display:inline-flex;align-items:center;gap:4px;">' + escapeHtml(t) +
    ' <span style="cursor:pointer;color:var(--text3);" onclick="ncRemoveTag('+i+')">×</span></span>'
  ).join('');
}

window.ncRemoveTag = function(idx){
  if(!window._ncTags) return;
  window._ncTags.splice(idx, 1);
  ncRenderSelectedTags();
};

window.saveNewContact = async function(){
  const nombre = document.getElementById('nc-nombre').value.trim();
  const whatsapp = document.getElementById('nc-whatsapp').value.trim();
  const email = document.getElementById('nc-email').value.trim();
  const status = document.getElementById('nc-status').value;
  const fuente = document.getElementById('nc-fuente').value;
  const notas = document.getElementById('nc-notas').value.trim();
  const tags = window._ncTags || [];

  if(!nombre || !whatsapp){
    window.toast && window.toast('Faltan datos', 'Nombre y teléfono son requeridos', 'warn');
    return;
  }

  try {
    await sbInsert('leads', {
      client_id: CLIENT_ID,
      nombre,
      whatsapp,
      email: email || null,
      fuente,
      status,
      notas: notas || null,
      tags
    });
    window.toast && window.toast('Contacto agregado', nombre, 'ok');
    closeModal();
    loadContactos();
  } catch(err){
    console.error('[saveNewContact]', err);
    window.toast && window.toast('Error', err.message || 'No se pudo guardar', 'err');
  }
};

window.openContactoDetail = function(id){
  const c = (window.CONTACTOS.items || []).find(x => x.id === id);
  if(!c) return;
  const tagsHtml = (c.tags && c.tags.length)
    ? c.tags.map(t => '<span class="contacto-tag-chip">' + escapeHtml(t) + '</span>').join(' ')
    : '<span class="dim" style="font-size:10px;">Sin etiquetas</span>';

  const body = `
    <div style="display:flex;gap:14px;align-items:center;padding-bottom:14px;border-bottom:1px solid var(--border);margin-bottom:14px;">
      <div class="conv-avatar" style="width:48px;height:48px;font-size:14px;">${escapeHtml((c.nombre || '?').slice(0,2).toUpperCase())}</div>
      <div style="flex:1;">
        <div style="font-size:15px;font-weight:600;">${escapeHtml(c.nombre || '—')}</div>
        <div style="font-size:11px;color:var(--text2);font-family:'Geist Mono',monospace;margin-top:3px;">${escapeHtml(c.whatsapp || '—')}</div>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:120px 1fr;gap:10px;font-size:12px;">
      <div style="color:var(--text3);font-family:'Geist Mono',monospace;font-size:10px;letter-spacing:0.5px;">EMAIL</div>
      <div>${c.email ? escapeHtml(c.email) : '<span class="dim">—</span>'}</div>
      <div style="color:var(--text3);font-family:'Geist Mono',monospace;font-size:10px;letter-spacing:0.5px;">ORIGEN</div>
      <div>${escapeHtml(c.fuente || '—')}</div>
      <div style="color:var(--text3);font-family:'Geist Mono',monospace;font-size:10px;letter-spacing:0.5px;">ESTADO</div>
      <div>${escapeHtml(c.status || 'nuevo')}</div>
      <div style="color:var(--text3);font-family:'Geist Mono',monospace;font-size:10px;letter-spacing:0.5px;">VISITAS</div>
      <div>${c.visitas || 0}</div>
      <div style="color:var(--text3);font-family:'Geist Mono',monospace;font-size:10px;letter-spacing:0.5px;">ÚLTIMA VISITA</div>
      <div>${c.ultima_visita ? new Date(c.ultima_visita).toLocaleDateString('es') : '<span class="dim">—</span>'}</div>
      <div style="color:var(--text3);font-family:'Geist Mono',monospace;font-size:10px;letter-spacing:0.5px;">PRÓXIMA CITA</div>
      <div>${c.proxima_cita ? new Date(c.proxima_cita).toLocaleDateString('es') : '<span class="dim">—</span>'}</div>
      <div style="color:var(--text3);font-family:'Geist Mono',monospace;font-size:10px;letter-spacing:0.5px;">ETIQUETAS</div>
      <div>${tagsHtml}</div>
    </div>
    ${c.notas ? '<div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border);"><div style="font-size:9px;color:var(--text3);font-family:\'Geist Mono\',monospace;letter-spacing:1px;text-transform:uppercase;margin-bottom:6px;">NOTAS</div><div style="font-size:12px;color:var(--text2);line-height:1.6;">'+escapeHtml(c.notas)+'</div></div>' : ''}
  `;
  showModal('Detalle del contacto', body,
    '<button class="btn ghost" onclick="closeModal()">Cerrar</button>');
};
