// ARIA Drawer — UI + approve/reject/edit flow
// Depends on window.sb (Supabase client), window.CLIENT_ID, window.toast()

const ARIA = {
  currentFilter: 'pending',
  items: [],
  typeIcons: {
    send_whatsapp: '💬',
    send_email: '✉',
    schedule_appointment: '📅',
    create_campaign: '📢',
    update_lead_status: '🔄',
    reassign_lead: '👤',
    flag_churn_risk: '⚠',
    content_suggestion: '✨',
    pricing_adjustment: '💰',
    workflow_trigger: '⚙'
  },
  typeLabels: {
    send_whatsapp: 'Enviar WhatsApp',
    send_email: 'Enviar Email',
    schedule_appointment: 'Agendar cita',
    create_campaign: 'Crear campaña',
    update_lead_status: 'Actualizar lead',
    reassign_lead: 'Reasignar lead',
    flag_churn_risk: 'Riesgo de churn',
    content_suggestion: 'Contenido',
    pricing_adjustment: 'Precio',
    workflow_trigger: 'Workflow'
  },
  // Policy: auto-ejecuta sin aprobación (solo muestra ejecutadas)
  autoExecuteTypes: ['send_whatsapp','send_email','update_lead_status','content_suggestion']
};

function openAria(){
  document.body.classList.add('aria-open');
}
function closeAria(){
  document.body.classList.remove('aria-open');
}
function toggleAria(){
  document.body.classList.toggle('aria-open');
}

function filterAria(filter){
  ARIA.currentFilter = filter;
  document.querySelectorAll('.aria-filter-btn').forEach(b=>{
    b.classList.toggle('active', b.dataset.filter === filter);
  });
  renderAriaList();
}

function renderAriaList(){
  const list = document.getElementById('aria-list');
  const filtered = ARIA.items.filter(i => i.status === ARIA.currentFilter);

  if(filtered.length === 0){
    list.innerHTML = `
      <div class="aria-empty">
        <div class="aria-empty-icon">A</div>
        <div class="aria-empty-text">Sin sugerencias <strong>${ARIA.currentFilter === 'pending' ? 'pendientes' : ARIA.currentFilter}</strong><br>ARIA las genera analizando tu negocio continuamente.</div>
      </div>`;
    return;
  }

  list.innerHTML = filtered.map(item => {
    const icon = ARIA.typeIcons[item.type] || '•';
    const label = ARIA.typeLabels[item.type] || item.type;
    const conf = item.confidence ? Math.round(item.confidence * 100) + '%' : '—';
    const timeAgo = formatTimeAgo(item.created_at);
    const payloadStr = typeof item.payload === 'object' ? JSON.stringify(item.payload, null, 2) : item.payload;

    let actions = '';
    if(item.status === 'pending'){
      actions = `
        <button class="btn danger" onclick="rejectSuggestion('${item.id}')">Rechazar</button>
        <button class="btn ghost" onclick="editSuggestion('${item.id}')">Editar</button>
        <button class="btn success" onclick="approveSuggestion('${item.id}')">Aprobar</button>`;
    } else if(item.status === 'approved'){
      actions = `<button class="btn ghost" style="flex:1;justify-content:center;">En cola para ejecutar...</button>`;
    } else if(item.status === 'rejected'){
      actions = `<button class="btn ghost" style="flex:1;justify-content:center;" onclick="unrejectSuggestion('${item.id}')">Restaurar</button>`;
    } else if(item.status === 'executed'){
      const result = item.execution_result ? JSON.stringify(item.execution_result) : '—';
      actions = `<span class="chip chip-ok" style="flex:1;justify-content:center;"><span class="chip-dot"></span>EJECUTADA ${timeAgo}</span>`;
    }

    return `
      <div class="aria-card" data-id="${item.id}">
        <div class="aria-card-head">
          <div class="aria-type-icon">${icon}</div>
          <div style="flex:1;min-width:0;">
            <div class="aria-card-title">${escapeHtml(item.title)}</div>
            <div class="aria-card-meta">${label} · ${timeAgo}</div>
          </div>
          <span class="aria-confidence">${conf}</span>
        </div>
        ${item.reasoning ? `<div class="aria-reasoning">${escapeHtml(item.reasoning)}</div>` : ''}
        ${payloadStr && payloadStr !== '{}' ? `<div class="aria-payload">${escapeHtml(payloadStr)}</div>` : ''}
        <div class="aria-actions">${actions}</div>
      </div>`;
  }).join('');
}

async function approveSuggestion(id){
  const item = ARIA.items.find(i => i.id === id);
  if(!item) return;

  try{
    // Update status to 'approved' en Supabase
    const { data, error } = await window.sb
      .from('ia_suggestions')
      .update({
        status: 'approved',
        approved_at: new Date().toISOString()
      })
      .eq('id', id)
      .select();

    if(error) throw error;

    // Si es tipo auto-execute, marcar ejecutado inmediato
    if(ARIA.autoExecuteTypes.includes(item.type)){
      await window.sb
        .from('ia_suggestions')
        .update({
          status: 'executed',
          executed_at: new Date().toISOString(),
          execution_result: { auto_executed: true, by: 'client' }
        })
        .eq('id', id);
      window.toast('✓ Ejecutada automáticamente', `${ARIA.typeLabels[item.type]}: ${item.title}`, 'success');
    } else {
      window.toast('✓ Aprobada', `n8n ejecutará: ${item.title}`, 'success');
    }
    // Realtime se encarga del update UI
  } catch(err){
    console.error('approve error:', err);
    window.toast('Error', 'No se pudo aprobar: ' + err.message, 'err');
  }
}

async function rejectSuggestion(id){
  try{
    const { error } = await window.sb
      .from('ia_suggestions')
      .update({ status: 'rejected', approved_at: new Date().toISOString() })
      .eq('id', id);
    if(error) throw error;
    window.toast('Rechazada', 'Sugerencia archivada', 'warn');
  } catch(err){
    window.toast('Error', err.message, 'err');
  }
}

async function unrejectSuggestion(id){
  try{
    const { error } = await window.sb
      .from('ia_suggestions')
      .update({ status: 'pending', approved_at: null })
      .eq('id', id);
    if(error) throw error;
    window.toast('Restaurada', 'Vuelve a pendientes', 'success');
  } catch(err){
    window.toast('Error', err.message, 'err');
  }
}

function editSuggestion(id){
  const item = ARIA.items.find(i => i.id === id);
  if(!item) return;

  const body = `
    <div class="field">
      <div class="field-label">TÍTULO</div>
      <input class="field-input" id="edit-title" value="${escapeHtml(item.title)}">
    </div>
    <div class="field">
      <div class="field-label">PAYLOAD (JSON)</div>
      <textarea class="field-textarea" id="edit-payload" style="min-height:120px;font-family:'Geist Mono',monospace;">${escapeHtml(JSON.stringify(item.payload, null, 2))}</textarea>
    </div>
    <div class="field">
      <div class="field-label">REASONING</div>
      <textarea class="field-textarea" id="edit-reasoning">${escapeHtml(item.reasoning || '')}</textarea>
    </div>
  `;

  const foot = `
    <button class="btn ghost" onclick="closeModal()">Cancelar</button>
    <button class="btn primary" onclick="saveSuggestionEdit('${id}')">Guardar y aprobar</button>
  `;

  showModal('Editar sugerencia', body, foot);
}

async function saveSuggestionEdit(id){
  const title = document.getElementById('edit-title').value;
  const payloadRaw = document.getElementById('edit-payload').value;
  const reasoning = document.getElementById('edit-reasoning').value;

  let payload;
  try { payload = JSON.parse(payloadRaw); }
  catch(e){ window.toast('Error', 'JSON inválido', 'err'); return; }

  try{
    const { error } = await window.sb
      .from('ia_suggestions')
      .update({
        title, payload, reasoning,
        status: 'approved',
        approved_at: new Date().toISOString()
      })
      .eq('id', id);
    if(error) throw error;
    closeModal();
    window.toast('✓ Editada y aprobada', title, 'success');
  } catch(err){
    window.toast('Error', err.message, 'err');
  }
}

function updateAriaBadge(){
  const pending = ARIA.items.filter(i => i.status === 'pending').length;
  const fab = document.getElementById('aria-fab');
  const badge = document.getElementById('aria-badge');
  const countEl = document.getElementById('aria-count');
  const briefAria = document.getElementById('brief-aria');

  if(pending > 0){
    badge.textContent = pending;
    badge.style.display = 'flex';
  } else {
    badge.style.display = 'none';
  }
  countEl.textContent = pending;
  if(briefAria) briefAria.textContent = pending;
}

// Utility
function formatTimeAgo(iso){
  const now = new Date();
  const then = new Date(iso);
  const diff = Math.floor((now - then) / 1000);
  if(diff < 60) return 'ahora';
  if(diff < 3600) return Math.floor(diff / 60) + 'm';
  if(diff < 86400) return Math.floor(diff / 3600) + 'h';
  return Math.floor(diff / 86400) + 'd';
}

function escapeHtml(s){
  if(s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

// MODAL helpers
function showModal(title, bodyHTML, footHTML){
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = bodyHTML;
  document.getElementById('modal-foot').innerHTML = footHTML || '<button class="btn ghost" onclick="closeModal()">Cerrar</button>';
  document.getElementById('modal-overlay').classList.add('show');
}
function closeModal(){
  document.getElementById('modal-overlay').classList.remove('show');
}
document.getElementById('modal-overlay')?.addEventListener('click', (e) => {
  if(e.target.id === 'modal-overlay') closeModal();
});

// Expose
window.ARIA = ARIA;
window.openAria = openAria;
window.closeAria = closeAria;
window.filterAria = filterAria;
window.renderAriaList = renderAriaList;
window.updateAriaBadge = updateAriaBadge;
window.approveSuggestion = approveSuggestion;
window.rejectSuggestion = rejectSuggestion;
window.unrejectSuggestion = unrejectSuggestion;
window.editSuggestion = editSuggestion;
window.saveSuggestionEdit = saveSuggestionEdit;
window.showModal = showModal;
window.closeModal = closeModal;
window.escapeHtml = escapeHtml;
window.formatTimeAgo = formatTimeAgo;
