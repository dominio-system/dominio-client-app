// Realtime subscriptions manager
// Subscribes to Supabase changes for: ia_suggestions, appointments, notifications, whatsapp_messages
// Depends on: window.sb, window.CLIENT_ID, window.ARIA, window.renderAriaList, window.updateAriaBadge, window.toast

const RT = {
  channels: []
};

function initRealtime(){
  if(!window.sb || !window.CLIENT_ID){
    console.warn('Realtime skipped: sb or CLIENT_ID not ready');
    return;
  }

  // ── ia_suggestions channel ─────────────────────────
  const iaChan = window.sb
    .channel(`ia-${window.CLIENT_ID}`)
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'ia_suggestions', filter: `client_id=eq.${window.CLIENT_ID}` },
      (payload) => handleIaChange(payload))
    .subscribe((status) => {
      if(status === 'SUBSCRIBED') console.log('✓ Realtime: ia_suggestions');
    });
  RT.channels.push(iaChan);

  // ── appointments channel ───────────────────────────
  const apptChan = window.sb
    .channel(`appt-${window.CLIENT_ID}`)
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'appointments', filter: `client_id=eq.${window.CLIENT_ID}` },
      (payload) => handleAppointmentChange(payload))
    .subscribe((status) => {
      if(status === 'SUBSCRIBED') console.log('✓ Realtime: appointments');
    });
  RT.channels.push(apptChan);

  // ── notifications channel ──────────────────────────
  const notifChan = window.sb
    .channel(`notif-${window.CLIENT_ID}`)
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'notifications' },
      (payload) => handleNotification(payload))
    .subscribe((status) => {
      if(status === 'SUBSCRIBED') console.log('✓ Realtime: notifications');
    });
  RT.channels.push(notifChan);

  // ── whatsapp_messages channel ──────────────────────
  const waChan = window.sb
    .channel(`wa-${window.CLIENT_ID}`)
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'whatsapp_messages', filter: `client_id=eq.${window.CLIENT_ID}` },
      (payload) => handleWhatsappMessage(payload))
    .subscribe((status) => {
      if(status === 'SUBSCRIBED') console.log('✓ Realtime: whatsapp_messages');
    });
  RT.channels.push(waChan);

  // ── leads channel ──────────────────────────────────
  const leadsChan = window.sb
    .channel(`leads-${window.CLIENT_ID}`)
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'leads', filter: `client_id=eq.${window.CLIENT_ID}` },
      (payload) => handleLeadChange(payload))
    .subscribe((status) => {
      if(status === 'SUBSCRIBED') console.log('✓ Realtime: leads');
    });
  RT.channels.push(leadsChan);
}

// ── IA suggestions handler ──
function handleIaChange(payload){
  const { eventType, new: newRow, old: oldRow } = payload;

  if(eventType === 'INSERT'){
    window.ARIA.items.unshift(newRow);
    window.renderAriaList();
    window.updateAriaBadge();
    if(newRow.status === 'pending'){
      window.toast('🔮 ARIA: nueva sugerencia', newRow.title, 'aria');
    }
  }
  else if(eventType === 'UPDATE'){
    const idx = window.ARIA.items.findIndex(i => i.id === newRow.id);
    if(idx >= 0){
      window.ARIA.items[idx] = newRow;
      window.renderAriaList();
      window.updateAriaBadge();
    }
  }
  else if(eventType === 'DELETE'){
    window.ARIA.items = window.ARIA.items.filter(i => i.id !== oldRow.id);
    window.renderAriaList();
    window.updateAriaBadge();
  }
}

// ── Appointment handler ──
function handleAppointmentChange(payload){
  const { eventType, new: newRow } = payload;
  if(eventType === 'INSERT'){
    window.toast('📅 Nueva cita', `${newRow.nombre} · ${newRow.fecha}`, 'success');
  } else if(eventType === 'UPDATE' && newRow.estado === 'confirmed'){
    window.toast('✓ Cita confirmada', newRow.nombre, 'success');
  }
  // Trigger reload de la vista de agenda si está activa
  if(window.currentView === 'agenda') window.loadAppointments?.();
  if(window.currentView === 'brief') window.loadBriefData?.();
}

// ── Notification handler ──
function handleNotification(payload){
  const { new: notif } = payload;
  if(notif.recipient_type === 'client' && notif.recipient_id !== window.CLIENT_ID) return;

  const severityMap = { info: 'success', warn: 'warn', err: 'err', success: 'success' };
  window.toast(notif.title, notif.body, severityMap[notif.severity] || 'success');

  // Bell indicator
  document.getElementById('bell-btn')?.classList.add('has-notif');
}

// ── WhatsApp message handler ──
function handleWhatsappMessage(payload){
  const { new: msg } = payload;
  if(msg.direction === 'inbound'){
    window.toast('💬 Nuevo WhatsApp', `De: ${msg.telefono}`, 'aria');
    // Reload inbox if active
    if(window.currentView === 'inbox') window.loadInbox?.();
  }
}

// ── Leads handler ──
function handleLeadChange(payload){
  const { eventType, new: newRow } = payload;
  if(eventType === 'INSERT'){
    window.toast('🎯 Nuevo lead', newRow.nombre, 'success');
  }
  if(window.currentView === 'leads') window.loadLeads?.();
  if(window.currentView === 'brief') window.loadBriefData?.();
}

function disconnectRealtime(){
  RT.channels.forEach(c => window.sb.removeChannel(c));
  RT.channels = [];
}

window.initRealtime = initRealtime;
window.disconnectRealtime = disconnectRealtime;
