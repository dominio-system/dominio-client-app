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
window.ariaTab = function(tab){
  document.querySelectorAll('.aria-tab').forEach(b => b.classList.toggle('active', b.dataset.atab === tab));
  document.querySelectorAll('.aria-tab-pane').forEach(p => p.classList.toggle('active', p.dataset.atab === tab));
  if(tab === 'conv') loadConversations();
  if(tab === 'auto') { loadRules(); loadTemplates(); }
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

  // Default tab
  ariaTab('conv');
};

// ===========================================================
// CONVERSACIONES
// ===========================================================
window.loadConversations = async function(){
  try {
    const conversations = await sbGet('aria_conversations',
      `client_id=eq.${CLIENT_ID}&select=*&order=last_message_at.desc&limit=100`);

    ARIA_SECTION.conversations = conversations;
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
  document.getElementById('cf-all').textContent = conv.length;
  document.getElementById('cf-active').textContent = conv.filter(c => c.status === 'active').length;
  document.getElementById('cf-paused').textContent = conv.filter(c => c.status === 'paused').length;
  document.getElementById('cf-escalated').textContent = conv.filter(c => c.status === 'escalated').length;
  document.getElementById('cf-resolved').textContent = conv.filter(c => c.status === 'resolved').length;
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
  if(filter !== 'all') list = list.filter(c => c.status === filter);
  if(search){
    list = list.filter(c =>
      (c.nombre_contacto || '').toLowerCase().includes(search) ||
      (c.phone || '').toLowerCase().includes(search)
    );
  }

  const el = document.getElementById('conv-items');
  if(list.length === 0){
    el.innerHTML = `<div style="padding:30px 20px;text-align:center;color:var(--text3);font-size:11px;">Sin conversaciones para este filtro.</div>`;
    return;
  }

  el.innerHTML = list.map(c => {
    const name = c.nombre_contacto || c.phone || 'Sin nombre';
    const initials = (name[0] || '?').toUpperCase() + (name.split(' ')[1]?.[0] || '').toUpperCase();
    const isActive = ARIA_SECTION.activeConversation?.id === c.id;
    const dotClass = c.status === 'paused' ? 'paused' : c.status === 'escalated' ? 'escalated' : '';
    const timeAgo = window.formatTimeAgo ? window.formatTimeAgo(c.last_message_at) : '';
    const metaChip = c.status === 'escalated'
      ? '<span class="conv-meta-chip escalated">ESCALADA</span>'
      : c.status === 'paused'
      ? '<span class="conv-meta-chip human">MANUAL</span>'
      : '<span class="conv-meta-chip aria-c">ARIA</span>';
    return `
      <div class="conv-item ${isActive?'active':''}" onclick="openConversation('${c.id}')">
        <div class="conv-avatar">${initials}${c.status !== 'resolved' ? `<span class="conv-avatar-dot ${dotClass}"></span>` : ''}</div>
        <div class="conv-body">
          <div class="conv-top"><span class="conv-name">${escapeHtml(name)}</span><span class="conv-time">${timeAgo}</span></div>
          <div class="conv-preview">${escapeHtml((c.context?.last_preview || '').slice(0, 50))}</div>
          <div class="conv-meta">${metaChip}</div>
        </div>
      </div>`;
  }).join('');
}

window.openConversation = async function(convId){
  const conv = ARIA_SECTION.conversations.find(c => c.id === convId);
  if(!conv) return;
  ARIA_SECTION.activeConversation = conv;
  renderConversationsList();

  // Cargar mensajes
  try {
    const msgs = await sbGet('whatsapp_messages',
      `conversation_id=eq.${convId}&select=*&order=created_at.asc&limit=100`);
    ARIA_SECTION.messages = msgs;
    renderChatPanel();
  } catch(err){
    document.getElementById('chat-panel').innerHTML = `<div style="padding:20px;color:var(--danger);">Error cargando mensajes: ${err.message}</div>`;
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

  document.getElementById('chat-panel').innerHTML = `
    <div class="chat-head">
      <div class="conv-avatar">${initials}${conv.status !== 'resolved' ? `<span class="conv-avatar-dot ${statusDot}"></span>` : ''}</div>
      <div class="chat-who">
        <div class="chat-who-name">${escapeHtml(name)}</div>
        <div class="chat-who-meta">${escapeHtml(conv.phone)} · ${conv.source || 'direct'} · ${conv.messages_count || ARIA_SECTION.messages.length} mensajes</div>
      </div>
      ${toggleBtn}
    </div>
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

  document.getElementById('ar-active').textContent = active;
  document.getElementById('ar-exec24').textContent = totalExec;
  document.getElementById('ar-autoreply').textContent = totalExec > 0 ? Math.round((totalExec - escalations) / totalExec * 100) + '%' : '0%';
  document.getElementById('ar-esc').textContent = escalations;
  document.getElementById('ar-total').textContent = `${rules.length} reglas · ${active} activas`;

  const body = document.getElementById('ar-rules-body');
  if(rules.length === 0){
    body.innerHTML = '<div style="padding:30px 20px;text-align:center;color:var(--text3);font-size:11px;">Sin reglas aún. Agrega una desde plantillas abajo.</div>';
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
    return `
      <div class="rule-row">
        <div class="rule-count" style="color:${r.activo?'var(--success)':'var(--text3)'};font-weight:600;">${r.prioridad}</div>
        <div><div class="rule-name" style="${r.activo?'':'color:var(--text3);'}">${escapeHtml(r.nombre)}</div><div class="rule-desc">${escapeHtml(r.descripcion || '')}</div></div>
        <div><span class="rule-tag trigger">${triggerLabel[r.trigger_type] || r.trigger_type}</span>${trigKw ? `<span style="font-size:9px;color:var(--text3);margin-left:5px;">${escapeHtml(trigKw)}</span>` : ''}</div>
        <div><span class="rule-tag ${actionClass}">${actionLabel[r.action_type] || r.action_type}</span></div>
        <div class="rule-count">${r.ejecutada_count || 0}</div>
        <div><label class="switch"><input type="checkbox" ${r.activo?'checked':''} onchange="toggleRule('${r.id}', this.checked)"><span class="slider"></span></label></div>
      </div>`;
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
  const existingNames = new Set(ARIA_SECTION.rules.map(r => r.nombre));
  const pending = TEMPLATES_CLINICA.filter(t => !existingNames.has(t.nombre));

  const el = document.getElementById('ar-templates');
  if(pending.length === 0){
    el.innerHTML = '<div style="grid-column:1/-1;padding:30px;text-align:center;color:var(--text3);font-size:11px;">✓ Todas las plantillas están instaladas</div>';
    return;
  }

  el.innerHTML = pending.map((t, i) => `
    <div class="tpl-card" onclick="installTemplate(${i})">
      <div class="tpl-icon">${t.icon}</div>
      <div class="tpl-name">${t.nombre}</div>
      <div class="tpl-desc">${t.desc}</div>
      <div class="tpl-add">+ AGREGAR</div>
    </div>`).join('');
}

window.installTemplate = async function(idx){
  const t = TEMPLATES_CLINICA[idx];
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
    await loadRules();
    loadTemplates();
    window.toast('✓ Plantilla instalada', t.nombre, 'success');
  } catch(err){ window.toast('Error', err.message, 'err'); }
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
    // Wizard de setup
    el.innerHTML = `
      <div style="margin-bottom:6px;"><div class="conn-title">Conectar WhatsApp Cloud API</div><div class="conn-sub">Setup oficial con Meta for Developers · verificado, sin bans</div></div>
      <div class="wiz-steps">
        <div class="wiz-step active"><strong>1</strong> DATOS DE META</div>
        <div class="wiz-step">2 VERIFICAR</div>
        <div class="wiz-step">3 ACTIVAR</div>
      </div>
      <div style="font-size:11px;color:var(--text2);line-height:1.6;margin-bottom:14px;">
        Necesitas una cuenta de <strong style="color:var(--text);">Meta for Developers</strong> con tu número de WhatsApp Business verificado.
        Si aún no lo tienes, <a style="color:var(--accent);cursor:pointer;" onclick="showSetupGuide()">aquí la guía paso a paso</a>.
      </div>
      <div class="field"><div class="field-lbl">PHONE NUMBER ID</div><input class="field-input" id="wa-phone-id" placeholder="108913974••••••"></div>
      <div class="field"><div class="field-lbl">WABA ID (WhatsApp Business Account ID)</div><input class="field-input" id="wa-waba-id" placeholder="452184••••••"></div>
      <div class="field"><div class="field-lbl">ACCESS TOKEN (permanente)</div><input class="field-input" id="wa-token" type="password" placeholder="EAAFxxxxxxxxx..."></div>
      <div class="field"><div class="field-lbl">NÚMERO (display)</div><input class="field-input" id="wa-phone" placeholder="+1 809 555 1234"></div>
      <div class="field"><div class="field-lbl">BUSINESS NAME</div><input class="field-input" id="wa-bname" placeholder="Mi Clínica Estética"></div>
      <div class="conn-actions">
        <button class="btn ghost" onclick="testWaConnection()">Validar credenciales</button>
        <button class="btn primary" onclick="connectWa()" style="margin-left:auto;">Conectar</button>
      </div>`;
  }
};

function maskId(id){
  if(!id) return '—';
  if(id.length <= 8) return id;
  return id.slice(0, 4) + '•••••' + id.slice(-3);
}

window.connectWa = async function(){
  const payload = {
    wa_phone_number_id: document.getElementById('wa-phone-id').value.trim(),
    wa_waba_id: document.getElementById('wa-waba-id').value.trim(),
    wa_access_token_encrypted: document.getElementById('wa-token').value.trim(), // TODO encriptar real
    wa_display_phone: document.getElementById('wa-phone').value.trim(),
    wa_business_name: document.getElementById('wa-bname').value.trim(),
    wa_status: 'connected',
    wa_verified_at: new Date().toISOString(),
    wa_quality_rating: 'GREEN'
  };
  if(!payload.wa_phone_number_id || !payload.wa_access_token_encrypted){
    window.toast('Faltan datos', 'Phone Number ID y Access Token son requeridos', 'warn');
    return;
  }
  try {
    await sbPatch('clients', CLIENT_ID, payload);
    Object.assign(window.currentClient, payload);
    window.toast('✓ WhatsApp conectado', `${payload.wa_display_phone} · ARIA ya puede responder`, 'success');
    loadAriaSection();
    renderConnectionStatus();
  } catch(err){ window.toast('Error', err.message, 'err'); }
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
