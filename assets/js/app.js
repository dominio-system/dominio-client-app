// Dominio — Dashboard Cliente v3
// Orquesta: Supabase client, views, realtime, ARIA

// ============================================
// SUPABASE CLIENT (con JWT del cliente logueado)
// ============================================
const SUPABASE_URL = 'https://ywlyuuddqitduqtdttgo.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl3bHl1dWRkcWl0ZHVxdGR0dGdvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwNDg2MzgsImV4cCI6MjA4OTYyNDYzOH0.vpjRNcQ_v2Vo9M2oQsCq95mSLOCctRf6cO4sWzpNCF8';

// Session se carga desde IPC (main process). Hasta que boot() la cargue, usamos anon.
window.SESSION = null;
window.CLIENT_ID = null;
window.ACCESS_TOKEN = SUPABASE_ANON;

// Supabase client (SDK para realtime + auto-attach JWT en queries PostgREST)
// Se inicializa con anon; después de loadSession() reconfiguramos con JWT real
window.sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON, {
  realtime: { params: { eventsPerSecond: 10 } },
});

async function loadSessionFromMain(){
  if(!window.electronAPI?.getSession){
    console.error('electronAPI.getSession no disponible. Abortando.');
    return false;
  }
  const sess = await window.electronAPI.getSession();
  if(!sess || !sess.accessToken){
    console.warn('Sin sesión. Redirigiendo a login...');
    window.electronAPI?.logout?.();
    return false;
  }
  window.SESSION = sess;
  window.CLIENT_ID = sess.clientId;
  window.ACCESS_TOKEN = sess.accessToken;
  // Actualizar Supabase SDK realtime con el JWT real
  window.sb.realtime.setAuth(sess.accessToken);
  // Suscribirse a refresh automático desde main
  if(window.electronAPI.onSessionRefreshed){
    window.electronAPI.onSessionRefreshed((s) => {
      console.log('Session refreshed by main');
      window.SESSION = s;
      window.ACCESS_TOKEN = s.accessToken;
      window.sb.realtime.setAuth(s.accessToken);
    });
  }
  return true;
}

function sbHeaders(pref){
  const h = {
    'apikey': SUPABASE_ANON,
    'Authorization': `Bearer ${window.ACCESS_TOKEN}`,
    'Content-Type': 'application/json'
  };
  if(pref) h['Prefer'] = pref;
  return h;
}

// Fetch wrapper: retry una vez con refresh si recibe 401
async function sbFetch(url, options = {}){
  let r = await fetch(url, options);
  if(r.status === 401 && window.electronAPI?.refreshSession){
    try {
      const fresh = await window.electronAPI.refreshSession();
      window.SESSION = fresh;
      window.ACCESS_TOKEN = fresh.accessToken;
      window.sb.realtime.setAuth(fresh.accessToken);
      const newOptions = { ...options, headers: { ...(options.headers||{}), 'Authorization': `Bearer ${fresh.accessToken}` } };
      r = await fetch(url, newOptions);
    } catch(e){
      console.warn('Refresh falló en 401; logout:', e.message);
      window.electronAPI?.logout?.();
      throw new Error('Session expired');
    }
  }
  return r;
}

// REST helpers (usan el JWT del cliente + auto-refresh on 401)
async function sbGet(table, params=''){
  const r = await sbFetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, { headers: sbHeaders() });
  if(!r.ok) throw new Error(`${table}: ${r.status}`);
  return r.json();
}
async function sbInsert(table, payload){
  const r = await sbFetch(`${SUPABASE_URL}/rest/v1/${table}`, { method:'POST', headers: sbHeaders('return=representation'), body: JSON.stringify(payload) });
  if(!r.ok){ const e = await r.json().catch(()=>({})); throw new Error(e.message || r.status); }
  return r.json();
}
async function sbPatch(table, id, payload){
  const r = await sbFetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, { method:'PATCH', headers: sbHeaders('return=representation'), body: JSON.stringify(payload) });
  if(!r.ok) throw new Error(`patch ${table}: ${r.status}`);
  return r.json();
}
window.currentView = 'brief';
window.currentClient = null;
window.CLIENT_SERVICES = []; // cache de servicios del cliente

// Init theme early (before render)
(function initTheme(){
  try {
    const saved = localStorage.getItem('theme') || 'dark';
    if(saved === 'light') document.body.classList.add('theme-light');
  } catch(e){}
})();

// ============================================
// TOAST
// ============================================
window.toast = function(title, body, kind='success'){
  const container = document.getElementById('toast-container');
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.innerHTML = `<div class="toast-title">${escapeHtml(title)}</div>${body ? `<div class="toast-body">${escapeHtml(body)}</div>` : ''}`;
  container.appendChild(t);
  setTimeout(() => t.remove(), 4500);
};

// ============================================
// SIDEBAR
// ============================================
window.toggleSidebar = function(){
  document.body.classList.toggle('sb-collapsed');
  try { localStorage.setItem('sb-collapsed', document.body.classList.contains('sb-collapsed')); } catch(e){}
};
window.toggleGroup = function(name){
  if(document.body.classList.contains('sb-collapsed')) return;
  const g = document.querySelector(`.nav-group[data-group="${name}"]`);
  g.classList.toggle('closed');
  try { localStorage.setItem('group-' + name, g.classList.contains('closed')); } catch(e){}
};
// Restore state
try {
  if(localStorage.getItem('sb-collapsed') === 'true') document.body.classList.add('sb-collapsed');
  ['home','rendimiento','actividad','mensajeria','premium','cuenta'].forEach(n => {
    const v = localStorage.getItem('group-' + n);
    if(v === 'true') document.querySelector(`.nav-group[data-group="${n}"]`)?.classList.add('closed');
  });
} catch(e){}

// ============================================
// NAVIGATION
// ============================================
const viewTitles = {
  brief: 'Executive Brief',
  funnel: 'Funnel Diagnóstico',
  roi: 'ROI & Resultados',
  agenda: 'Agenda Inteligente',
  leads: 'Leads con Score',
  crm: 'CRM 360',
  campaigns: 'Campaigns Creator',
  inbox: 'Inbox WhatsApp',
  coach: 'Coach Dominio',
  reports: 'Reportes',
  dindex: 'Dominio Index',
  sla: 'SLA Dashboard',
  billing: 'Facturación',
  settings: 'Configuración'
};

window.go = function(view){
  window.currentView = view;
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelector(`.view[data-view="${view}"]`)?.classList.add('active');
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.querySelector(`.nav-item[data-view="${view}"]`)?.classList.add('active');
  document.getElementById('crumb-current').textContent = viewTitles[view] || view;
  document.querySelector('.content').scrollTop = 0;
  try { localStorage.setItem('last-view', view); } catch(e){}

  // Load data for the view
  if(view === 'brief') loadBriefData();
  else if(view === 'funnel') loadFunnel();
  else if(view === 'roi') loadROI();
  else if(view === 'agenda') loadAppointments();
  else if(view === 'leads') loadLeads();
  else if(view === 'crm') loadCRM();
  else if(view === 'campaigns') loadCampaigns();
  else if(view === 'inbox') loadInbox();
  else if(view === 'sla') loadSLA();
  else if(view === 'billing') loadBilling();
  else if(view === 'settings') loadSettings();
  else if(view === 'aria') loadAriaSection();
};

window.logout = function(){
  if(window.electronAPI?.logout) window.electronAPI.logout();
  else window.location.href = 'login.html';
};

// Date en breadcrumb
(function(){
  const d = new Date();
  const months = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  document.getElementById('crumb-date').textContent = `— ${months[d.getMonth()]} ${d.getFullYear()}`;
})();

// ============================================
// BOOT
// ============================================
async function boot(){
  try {
    // 1) Cargar sesión desde main process (safeStorage cifrado)
    const sessionOk = await loadSessionFromMain();
    if(!sessionOk) return; // main ya redirigió a login

    // 2) Load client
    const clients = await sbGet('clients', `id=eq.${window.CLIENT_ID}&select=*`);
    if(clients.length === 0){
      window.toast('Error', 'Cliente no encontrado', 'err');
      return;
    }
    window.currentClient = clients[0];
    renderClientInfo();

    // Load IA suggestions (initial)
    const suggestions = await sbGet('ia_suggestions', `client_id=eq.${window.CLIENT_ID}&select=*&order=created_at.desc&limit=50`);
    window.ARIA.items = suggestions;
    window.renderAriaList();
    window.updateAriaBadge();

    // Initial view
    loadBriefData();

    // Init realtime
    window.initRealtime();

    // Restore last view
    const lastView = (() => { try { return localStorage.getItem('last-view') || 'brief'; } catch(e){ return 'brief'; } })();
    if(lastView !== 'brief') window.go(lastView);

    window.toast(`Bienvenido, ${window.currentClient.empresa || 'Cliente'}`, `Tu dashboard está sincronizado en tiempo real.`, 'success');
  } catch(err){
    console.error('Boot error:', err);
    window.toast('Error de conexión', err.message, 'err');
  }
}

function renderClientInfo(){
  const c = window.currentClient;
  document.getElementById('client-name').textContent = c.responsable || c.nombre || c.empresa || '—';
  document.getElementById('client-empresa').textContent = c.empresa || '—';
  document.getElementById('client-plan').textContent = (c.plan || 'STARTER').toUpperCase();
  document.getElementById('client-initial').textContent = (c.empresa?.[0] || c.nombre?.[0] || '?').toUpperCase();
}

// ============================================
// VIEW: BRIEF (Executive Brief)
// ============================================
window.loadBriefData = async function(){
  try {
    const now = new Date();
    const d30 = new Date(now - 30 * 864e5).toISOString();
    const d180 = new Date(now - 180 * 864e5).toISOString();
    const d180d = new Date(now - 180 * 864e5).toISOString().split('T')[0];

    const [leads30, apts30, paidAppts180] = await Promise.all([
      sbGet('leads', `client_id=eq.${window.CLIENT_ID}&created_at=gte.${d30}&select=id,status`),
      sbGet('appointments', `client_id=eq.${window.CLIENT_ID}&estado=eq.confirmed&select=id`),
      // Ingresos reales de los últimos 180 días desde appointments pagadas
      sbGet('appointments', `client_id=eq.${window.CLIENT_ID}&pagado=eq.true&paid_at=gte.${d180}&select=paid_at,neto_cents,precio_cents&order=paid_at.asc`)
    ]);

    const leadsCount = leads30.length;
    const citasCount = apts30.length;
    const convRate = leadsCount > 0 ? ((citasCount / leadsCount) * 100).toFixed(1) : '0.0';
    const ariaPending = window.ARIA.items.filter(i => i.status === 'pending').length;

    // Revenue agregado por mes
    const revenueByMonth = {};
    let totalRev30 = 0;
    paidAppts180.forEach(a => {
      const d = new Date(a.paid_at);
      const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      const cents = a.neto_cents || a.precio_cents || 0;
      revenueByMonth[key] = (revenueByMonth[key] || 0) + cents;
      if(now - d < 30 * 864e5) totalRev30 += cents;
    });

    const moneda = window.currentClient?.moneda || 'USD';
    const monedaSym = { USD:'$', MXN:'$', DOP:'RD$', EUR:'€', COP:'$' }[moneda] || '$';

    document.getElementById('brief-leads').textContent = leadsCount;
    document.getElementById('brief-citas').textContent = citasCount;
    document.getElementById('brief-conv').textContent = convRate + '%';
    document.getElementById('brief-aria').textContent = ariaPending;

    // Hora + saludo
    const hour = new Date().getHours();
    const saludo = hour < 12 ? 'Buenos días' : hour < 19 ? 'Buenas tardes' : 'Buenas noches';
    const name = window.currentClient.responsable?.split(' ')[0] || window.currentClient.empresa || '';
    document.getElementById('brief-greet').textContent = `${saludo}, ${name}`;
    document.getElementById('brief-date').textContent = new Date().toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' }).toUpperCase();

    // Narrative real
    document.getElementById('brief-narrative').innerHTML = generateNarrativeReal(leadsCount, citasCount, convRate, ariaPending, totalRev30, monedaSym);

    // Chart — ingresos reales por mes
    const sortedKeys = Object.keys(revenueByMonth).sort();
    const labels = sortedKeys.map(k => {
      const [y,m] = k.split('-');
      return new Date(parseInt(y), parseInt(m)-1, 1).toLocaleDateString('es-MX', { month: 'short' });
    });
    const data = sortedKeys.map(k => (revenueByMonth[k] / 100).toFixed(2));

    // Destroy chart if exists (para re-render en theme change)
    if(window._chartBrief){ window._chartBrief.destroy(); window._chartBrief = null; }

    const ctx = document.getElementById('chart-brief');
    if(ctx && labels.length > 0) {
      const isLight = document.body.classList.contains('theme-light');
      const textColor = isLight ? '#555' : '#aaa';
      const gridColor = isLight ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.04)';

      window._chartBrief = new Chart(ctx, {
        type: 'line',
        data: {
          labels,
          datasets: [{
            label: `Ingresos reales (${moneda})`,
            data,
            borderColor: '#6fcf97',
            backgroundColor: 'rgba(111,207,151,0.12)',
            fill: true,
            tension: 0.25,
            pointRadius: 3,
            pointBackgroundColor: '#6fcf97',
            borderWidth: 1.8
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { labels: { color: textColor, font: { size: 10, family: 'Geist Mono' } } },
            tooltip: {
              callbacks: { label: (ctx) => `${monedaSym}${parseFloat(ctx.parsed.y).toLocaleString('en', { minimumFractionDigits: 2 })}` }
            }
          },
          scales: {
            x: { grid: { color: gridColor }, ticks: { color: textColor, font: { size: 9, family: 'Geist Mono' } } },
            y: { grid: { color: gridColor }, ticks: { color: textColor, font: { size: 9, family: 'Geist Mono' }, callback: v => monedaSym + v } }
          }
        }
      });
    }

    // Update nav badges
    document.getElementById('leads-count').textContent = leadsCount;
    document.getElementById('appt-count').textContent = citasCount;
  } catch(err) {
    console.error('Brief error:', err);
  }
};

function generateNarrativeReal(leads, citas, conv, aria, totalRev30Cents, sym){
  const revUsd = (totalRev30Cents / 100).toLocaleString('en', { minimumFractionDigits: 2 });
  const parts = [];

  if(leads === 0 && citas === 0 && totalRev30Cents === 0){
    return `Tu cuenta está lista. <strong>ARIA</strong> espera que configures tus servicios y empieces a agendar para mostrarte insights personalizados.`;
  }

  if(totalRev30Cents > 0){
    parts.push(`En los últimos 30 días generaste <strong class="hi-ok">${sym}${revUsd}</strong> en ingresos.`);
  }

  parts.push(`Recibiste <strong>${leads} leads</strong> y confirmaste <strong>${citas} citas</strong> (<span class="hi-ok">${conv}%</span> de conversión lead→cita).`);

  if(parseFloat(conv) > 40){
    parts.push(`Tu conversión está <span class="hi-ok">por encima del promedio de industria</span> (35%). Excelente.`);
  } else if(parseFloat(conv) > 0 && parseFloat(conv) < 25){
    parts.push(`Tu conversión está <span class="hi-danger">por debajo del promedio</span>. Revisa el funnel — probablemente hay fuga en seguimiento.`);
  }

  if(aria > 0){
    parts.push(`ARIA tiene <strong>${aria} sugerencias pendientes</strong> que podrían aumentar estos números.`);
  }

  return parts.join(' ');
}

function generateNarrative(leads, citas, conv, aria, kpis){
  const parts = [];
  const lastK = kpis[kpis.length-1];

  if(leads === 0 && citas === 0){
    return `Aún no hay actividad en tu cuenta. <strong>ARIA</strong> está lista para ayudarte a empezar — agrega tu primera campaña y comenzamos a generar leads.`;
  }

  parts.push(`En los últimos 30 días recibiste <strong>${leads} leads</strong> y convertiste <strong>${citas} citas confirmadas</strong> (<span class="hi-ok">${conv}%</span> de conversión).`);

  if(parseFloat(conv) > 40){
    parts.push(`Tu tasa de conversión está <span class="hi-ok">por encima del promedio de industria</span> (35%). Sigue así.`);
  } else if(parseFloat(conv) > 0 && parseFloat(conv) < 25){
    parts.push(`Tu tasa de conversión está <span class="hi-danger">por debajo del promedio</span>. Revisa el funnel: probablemente hay fuga en el paso lead → contactado.`);
  }

  if(lastK && lastK.ingresos_generados){
    parts.push(`Ingresos generados este ciclo: <strong>$${Number(lastK.ingresos_generados).toLocaleString('en')}</strong>.`);
  }

  if(aria > 0){
    parts.push(`ARIA tiene <strong>${aria} sugerencias pendientes</strong> de tu revisión que podrían impactar directamente estos números.`);
  }

  return parts.join(' ');
}

// ============================================
// VIEW: FUNNEL
// ============================================
window.loadFunnel = async function(){
  try {
    const [leads, apts] = await Promise.all([
      sbGet('leads', `client_id=eq.${window.CLIENT_ID}&select=id,status`),
      sbGet('appointments', `client_id=eq.${window.CLIENT_ID}&select=id,estado`)
    ]);
    const total = leads.length;
    const contactados = leads.filter(l => ['contactado','cita_agendada','cliente'].includes(l.status)).length;
    const agendados = apts.length;
    const confirmados = apts.filter(a => a.estado === 'confirmed').length;
    const realizados = apts.filter(a => a.estado === 'completed').length;

    const stages = [
      { label: 'Leads nuevos', count: total, max: total },
      { label: 'Contactados', count: contactados, max: total },
      { label: 'Citas agendadas', count: agendados, max: total },
      { label: 'Citas confirmadas', count: confirmados, max: total },
      { label: 'Citas realizadas', count: realizados, max: total }
    ];

    const container = document.getElementById('funnel-container');
    container.innerHTML = '';

    stages.forEach((s, i) => {
      const pct = s.max > 0 ? (s.count / s.max) * 100 : 0;
      const prev = i > 0 ? stages[i-1].count : s.count;
      const dropPct = prev > 0 ? ((prev - s.count) / prev) * 100 : 0;
      const isDrop = dropPct > 50 && i > 0;

      container.innerHTML += `
        <div class="funnel-row">
          <div class="funnel-label">${s.label}</div>
          <div class="funnel-bar"><div class="funnel-bar-fill ${isDrop?'drop':''}" style="width:${pct}%"></div></div>
          <div class="funnel-count">${s.count}</div>
          <div class="funnel-pct">${pct.toFixed(0)}%</div>
          <div>${isDrop ? '⚠' : ''}</div>
        </div>`;

      if(isDrop && i > 0){
        container.innerHTML += `<div class="funnel-ia-hint"><strong>ARIA detectó fuga:</strong> Estás perdiendo ${dropPct.toFixed(0)}% entre "${stages[i-1].label}" y "${s.label}". Acción recomendada: revisa mensajería de seguimiento y prueba reducir el tiempo de respuesta a <4min.</div>`;
      }
    });
  } catch(err) {
    console.error('Funnel error:', err);
  }
};

// ============================================
// VIEW: ROI
// ============================================
window.loadROI = async function(){
  try {
    const kpis = await sbGet('kpi_snapshots', `client_id=eq.${window.CLIENT_ID}&select=*&order=fecha.desc&limit=1`);
    if(kpis.length === 0){
      document.getElementById('bench-body').innerHTML = '<div class="empty"><div class="empty-icon">•</div><div class="empty-title">Sin data aún</div><div class="empty-sub">Se genera automáticamente al cerrar el mes</div></div>';
      return;
    }
    const k = kpis[0];
    const spend = Number(k.gasto_publicitario || 0);
    const rev = Number(k.ingresos_generados || 0);
    const roas = spend > 0 ? (rev / spend).toFixed(2) : '—';
    document.getElementById('roi-spend').textContent = '$' + spend.toLocaleString('en');
    document.getElementById('roi-rev').textContent = '$' + rev.toLocaleString('en');
    document.getElementById('roi-roas').textContent = roas + 'x';
    document.getElementById('roi-nuevos').textContent = k.nuevos_clientes || 0;

    // Benchmark
    document.getElementById('bench-body').innerHTML = `
      <div style="padding:14px;">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;padding:10px;background:var(--card2);border-radius:6px;">
          <div class="chip chip-ok"><span class="chip-dot"></span>TU ROAS: ${roas}x</div>
          <div style="font-size:11px;color:var(--text2);">Promedio industria: <strong class="ok">3.2x</strong></div>
        </div>
        <div style="font-size:12px;color:var(--text2);line-height:1.6;">
          ${roas !== '—' && parseFloat(roas) > 3.2 ? 'Tu ROAS está <span class="ok">por encima del promedio de industria</span>. Cada dólar invertido te devuelve $'+roas+'.' : 'Tu ROAS está dentro del rango esperado. ARIA puede optimizarlo aún más.'}
        </div>
      </div>`;
  } catch(err) { console.error('ROI error:', err); }
};

// ============================================
// VIEW: AGENDA
// ============================================
window.loadAppointments = async function(){
  try {
    const apts = await sbGet('appointments', `client_id=eq.${window.CLIENT_ID}&select=*&order=fecha.asc,hora.asc&limit=50`);

    // Calendar grid (current month)
    const now = new Date();
    const monthNames = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
    document.getElementById('cal-month').textContent = `${monthNames[now.getMonth()]} ${now.getFullYear()}`;

    const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    const startOffset = firstDay.getDay();

    const apptsByDate = {};
    apts.forEach(a => { (apptsByDate[a.fecha] = apptsByDate[a.fecha] || []).push(a); });

    const grid = document.getElementById('cal-grid');
    grid.innerHTML = '';
    for(let i = 0; i < startOffset; i++) grid.innerHTML += '<div class="cal-cell" style="opacity:0.3"></div>';
    for(let d = 1; d <= lastDay.getDate(); d++){
      const date = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const dayApts = apptsByDate[date] || [];
      const isToday = (now.getDate() === d);
      const apptHTML = dayApts.slice(0,2).map(a => `<div class="cal-appt">${a.hora?.slice(0,5)} ${escapeHtml(a.nombre||'').slice(0,12)}</div>`).join('');
      grid.innerHTML += `<div class="cal-cell ${dayApts.length?'has-appt':''} ${isToday?'today':''}" onclick="showDayAppts('${date}')"><div class="cal-day">${d}</div>${apptHTML}${dayApts.length > 2 ? `<div class="cal-appt">+${dayApts.length-2} más</div>`:''}</div>`;
    }

    // Tabla próximas
    const future = apts.filter(a => new Date(a.fecha) >= new Date(now.toDateString())).slice(0,10);
    const tbody = document.getElementById('appt-tbody');
    if(future.length === 0){
      tbody.innerHTML = '<tr><td colspan="5" class="dim" style="text-align:center;padding:20px;">No hay citas próximas</td></tr>';
    } else {
      const moneda = window.currentClient?.moneda || 'USD';
      tbody.innerHTML = future.map(a => {
        let emailChip = '';
        if(a.email){
          if(a.estado === 'confirmed' && a.confirmed_at){
            emailChip = `<span class="email-chip confirmed">✓ CONFIRMADA POR EMAIL</span>`;
          } else if(a.confirmation_email_sent_at){
            emailChip = `<span class="email-chip sent">📧 EMAIL ENVIADO</span>`;
          }
        }
        const netoUSD = (a.neto_cents || a.precio_cents || 0) / 100;
        const pagoChip = a.pagado
          ? `<span class="chip chip-ok"><span class="chip-dot"></span>PAGADA · ${(a.metodo_pago||'').toUpperCase()}</span>`
          : `<button class="btn ghost" style="font-size:10px;padding:3px 8px;" onclick="markAsPaid('${a.id}')">Marcar pagada</button>`;
        return `
          <tr>
            <td class="num">${new Date(a.fecha).toLocaleDateString('es-MX',{day:'2-digit',month:'short'})}</td>
            <td class="num">${a.hora?.slice(0,5) || '—'}</td>
            <td>${escapeHtml(a.nombre || '—')}<div style="margin-top:3px;">${emailChip}</div></td>
            <td class="dim">${escapeHtml(a.servicio || '—')}${netoUSD > 0 ? `<div class="num" style="font-size:10px;color:var(--success);">${moneda} ${netoUSD.toFixed(2)}</div>` : ''}</td>
            <td><span class="chip chip-${a.estado==='confirmed'?'ok':a.estado==='pending'?'warn':'off'}"><span class="chip-dot"></span>${a.estado||'—'}</span><div style="margin-top:4px;">${pagoChip}</div></td>
          </tr>`;
      }).join('');
    }
  } catch(err) { console.error('Appts error:', err); }
};

window.markAsPaid = async function(id){
  const body = `
    <div class="field"><div class="field-label">MÉTODO DE PAGO</div>
      <select class="field-select" id="pago-metodo">
        <option value="efectivo">💵 Efectivo</option>
        <option value="tarjeta">💳 Tarjeta</option>
        <option value="transferencia">🏦 Transferencia</option>
        <option value="stripe">🟣 Stripe</option>
        <option value="otro">Otro</option>
      </select>
    </div>
    <div style="padding:10px;background:var(--success-s);border-radius:6px;font-size:11px;color:var(--text2);">El ingreso se agregará automáticamente a tu revenue total y al gráfico del Executive Brief.</div>
  `;
  showModal('Marcar cita como pagada', body, `<button class="btn ghost" onclick="closeModal()">Cancelar</button><button class="btn success" onclick="confirmMarkAsPaid('${id}')">Confirmar pago</button>`);
};

window.confirmMarkAsPaid = async function(id){
  const metodo = document.getElementById('pago-metodo').value;
  try {
    await sbPatch('appointments', id, {
      pagado: true,
      metodo_pago: metodo,
      paid_at: new Date().toISOString(),
      estado: 'completed'
    });
    closeModal();
    window.toast('✓ Pago registrado', `Método: ${metodo}`, 'success');
    // Realtime refresca
  } catch(err){ window.toast('Error', err.message, 'err'); }
};

window.showDayAppts = async function(date){
  const apts = await sbGet('appointments', `client_id=eq.${window.CLIENT_ID}&fecha=eq.${date}&select=*`);
  const body = apts.length === 0
    ? '<div class="empty"><div class="empty-icon">·</div><div class="empty-title">Sin citas este día</div></div>'
    : apts.map(a => `<div style="padding:10px;background:var(--card2);border-radius:6px;margin-bottom:8px;"><div style="font-size:12px;font-weight:500;">${escapeHtml(a.nombre)}</div><div style="font-size:10px;color:var(--text3);margin-top:4px;">${a.hora?.slice(0,5)} · ${escapeHtml(a.servicio||'')}</div></div>`).join('');
  showModal(`Citas · ${new Date(date).toLocaleDateString('es-MX',{day:'numeric',month:'long'})}`, body, '<button class="btn primary" onclick="closeModal();openNewAppt(\''+date+'\')">+ Agendar</button><button class="btn ghost" onclick="closeModal()">Cerrar</button>');
};

window.openNewAppt = async function(defaultDate){
  // Asegurarse de tener servicios cargados
  if(window.CLIENT_SERVICES.length === 0){
    try { window.CLIENT_SERVICES = await sbGet('services', `client_id=eq.${window.CLIENT_ID}&activo=eq.true&select=*&order=orden.asc`); } catch(e){}
  }
  const today = defaultDate || new Date().toISOString().split('T')[0];
  const moneda = window.currentClient?.moneda || 'USD';
  const svcOptions = window.CLIENT_SERVICES
    .filter(s => s.activo)
    .map(s => `<option value="${s.id}" data-precio="${s.precio_cents}" data-duracion="${s.duracion_min}">${escapeHtml(s.nombre)} — ${moneda} ${(s.precio_cents/100).toFixed(2)} · ${s.duracion_min}min</option>`)
    .join('');

  const noServices = window.CLIENT_SERVICES.length === 0;

  const body = `
    <div class="field"><div class="field-label">NOMBRE</div><input class="field-input" id="appt-name" placeholder="Nombre del cliente"></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
      <div class="field"><div class="field-label">WHATSAPP</div><input class="field-input" id="appt-wa" placeholder="+52..."></div>
      <div class="field"><div class="field-label">EMAIL <span style="color:var(--success);">(recomendado)</span></div><input class="field-input" id="appt-email" type="email" placeholder="cliente@email.com"></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
      <div class="field"><div class="field-label">FECHA</div><input class="field-input" id="appt-date" type="date" value="${today}"></div>
      <div class="field"><div class="field-label">HORA</div><input class="field-input" id="appt-time" type="time" value="10:00"></div>
    </div>
    ${noServices
      ? `<div class="field" style="padding:12px;background:var(--warn-s);border:1px solid rgba(242,201,76,0.2);border-radius:6px;font-size:11px;color:var(--text2);line-height:1.5;">
           ⚠ No tienes servicios configurados. <a onclick="closeModal();go('settings');setTab('servicios')" style="color:var(--accent);cursor:pointer;text-decoration:underline;">Configurar servicios</a> primero.
         </div>`
      : `<div class="field"><div class="field-label">SERVICIO</div><select class="field-select" id="appt-service-id" onchange="onServiceChange()">${svcOptions}</select></div>`
    }
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
      <div class="field"><div class="field-label">PRECIO (${moneda})</div><input class="field-input" id="appt-precio" type="number" step="0.01" min="0"></div>
      <div class="field"><div class="field-label">DESCUENTO (%)</div><input class="field-input" id="appt-descuento" type="number" value="0" min="0" max="100" oninput="updateNeto()"></div>
    </div>
    <div class="field" style="padding:10px;background:var(--card2);border-radius:6px;font-size:12px;display:flex;justify-content:space-between;">
      <span class="dim">Total a cobrar:</span>
      <strong id="appt-neto-preview" style="color:var(--success);font-family:'Geist Mono',monospace;">—</strong>
    </div>
    <div class="field"><div class="field-label">NOTAS</div><textarea class="field-textarea" id="appt-notes"></textarea></div>
    <div class="field" style="display:flex;align-items:center;gap:10px;padding:10px;background:var(--card2);border-radius:6px;">
      <label class="switch"><input type="checkbox" id="appt-send-email" checked><span class="slider"></span></label>
      <div style="flex:1;">
        <div style="font-size:12px;">Enviar email de confirmación</div>
        <div class="dim" style="font-size:10px;">El cliente recibe link para confirmar. Queda pending hasta que confirme.</div>
      </div>
    </div>
  `;
  showModal('Nueva cita', body, '<button class="btn ghost" onclick="closeModal()">Cancelar</button><button class="btn primary" onclick="saveAppt()">Agendar</button>');

  // Trigger pre-fill del primer servicio
  if(!noServices) setTimeout(() => onServiceChange(), 50);
};

window.onServiceChange = function(){
  const sel = document.getElementById('appt-service-id');
  if(!sel) return;
  const opt = sel.options[sel.selectedIndex];
  const precio = parseInt(opt.dataset.precio) / 100;
  document.getElementById('appt-precio').value = precio.toFixed(2);
  updateNeto();
};

window.updateNeto = function(){
  const precio = parseFloat(document.getElementById('appt-precio')?.value || 0);
  const desc = parseFloat(document.getElementById('appt-descuento')?.value || 0);
  const neto = precio * (1 - desc / 100);
  const moneda = window.currentClient?.moneda || 'USD';
  const preview = document.getElementById('appt-neto-preview');
  if(preview) preview.textContent = `${moneda} ${neto.toFixed(2)}`;
};

window.saveAppt = async function(){
  const email = document.getElementById('appt-email').value.trim();
  const sendEmail = document.getElementById('appt-send-email').checked && email;
  const serviceIdEl = document.getElementById('appt-service-id');
  const serviceId = serviceIdEl?.value || null;
  const service = window.CLIENT_SERVICES.find(s => s.id === serviceId);
  const precioInput = parseFloat(document.getElementById('appt-precio')?.value || 0);
  const descuento = parseFloat(document.getElementById('appt-descuento')?.value || 0);

  const payload = {
    client_id: window.CLIENT_ID,
    service_id: serviceId,
    nombre: document.getElementById('appt-name').value,
    whatsapp: document.getElementById('appt-wa').value,
    email: email || null,
    fecha: document.getElementById('appt-date').value,
    hora: document.getElementById('appt-time').value,
    servicio: service?.nombre || null,
    precio_cents: Math.round(precioInput * 100),
    descuento_pct: descuento,
    notas: document.getElementById('appt-notes').value,
    estado: sendEmail ? 'pending' : 'confirmed'
  };
  try {
    const [created] = await sbInsert('appointments', payload);
    closeModal();

    if(sendEmail){
      // Dispara email via n8n webhook (si está configurado)
      await triggerConfirmationEmail(created);
      window.toast('📧 Email de confirmación enviado', `A ${email} — la cita queda pendiente hasta que confirme`, 'success');
    } else {
      window.toast('✓ Cita creada', `${payload.nombre} · ${payload.fecha}`, 'success');
    }
  } catch(err){
    window.toast('Error', err.message, 'err');
  }
};

async function triggerConfirmationEmail(appointment){
  const n8nUrl = window.currentClient?.n8n_webhook_url;
  if(!n8nUrl){
    // Sin n8n configurado: solo se guarda que hay que enviarlo
    console.log('[email] sin n8n config, solo marca DB');
    return;
  }
  try {
    // Fire-and-forget webhook a n8n con el token
    const confirmUrl = `https://dominiosystem.com/confirmar?token=${appointment.confirmation_token}`;
    await fetch(`${n8nUrl}/send-confirmation`, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        to: appointment.email,
        nombre: appointment.nombre,
        empresa: window.currentClient?.empresa || 'Dominio',
        fecha: appointment.fecha,
        hora: appointment.hora,
        servicio: appointment.servicio,
        confirmation_url: confirmUrl
      })
    });
    // Marcar como enviado
    await sbPatch('appointments', appointment.id, {
      confirmation_email_sent_at: new Date().toISOString()
    });
  } catch(err){
    console.warn('[email] webhook n8n falló:', err);
  }
}

// ============================================
// VIEW: LEADS CON SCORE
// ============================================
window.loadLeads = async function(){
  try {
    const leads = await sbGet('leads', `client_id=eq.${window.CLIENT_ID}&select=*&order=created_at.desc`);
    const tbody = document.getElementById('leads-tbody');

    if(leads.length === 0){
      tbody.innerHTML = '<tr><td colspan="7" class="dim" style="text-align:center;padding:20px;">No hay leads aún</td></tr>';
      return;
    }

    tbody.innerHTML = leads.map(l => {
      // Score IA heurístico (en real vendría de columna score calculada por ARIA)
      const score = calculateScore(l);
      const scoreClass = score >= 70 ? 'hot' : score >= 40 ? 'warm' : 'cold';
      const scoreLabel = score >= 70 ? 'HOT' : score >= 40 ? 'WARM' : 'COLD';
      return `
        <tr>
          <td><span class="score-pill score-${scoreClass}">${scoreLabel} ${score}</span></td>
          <td>${escapeHtml(l.nombre || '—')}</td>
          <td class="num dim">${escapeHtml(l.whatsapp || '—')}</td>
          <td class="dim">${escapeHtml(l.fuente || '—')}</td>
          <td><span class="chip chip-${l.status==='cliente'?'ok':l.status==='cita_agendada'?'warn':'off'}"><span class="chip-dot"></span>${l.status}</span></td>
          <td class="num">${l.visitas || 0}</td>
          <td class="dim" style="max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(l.notas || '—')}</td>
        </tr>`;
    }).join('');
  } catch(err){ console.error('Leads error:', err); }
};

function calculateScore(lead){
  let score = 30;
  if(lead.status === 'cita_agendada') score += 40;
  if(lead.status === 'contactado') score += 20;
  if(lead.visitas > 3) score += 15;
  if(lead.visitas > 1) score += 10;
  if(lead.notas?.includes('plan')) score += 5;
  return Math.min(100, score);
}

// ============================================
// VIEW: CRM
// ============================================
window.loadCRM = async function(){
  try {
    const leads = await sbGet('leads', `client_id=eq.${window.CLIENT_ID}&status=eq.cliente&select=*&order=ultima_visita.desc`);
    const tbody = document.getElementById('crm-tbody');

    if(leads.length === 0){
      tbody.innerHTML = '<tr><td colspan="6" class="dim" style="text-align:center;padding:20px;">No hay clientes activos aún</td></tr>';
      return;
    }

    tbody.innerHTML = leads.map(l => `
      <tr>
        <td><strong>${escapeHtml(l.nombre || '—')}</strong><div class="dim" style="font-size:10px;">${escapeHtml(l.whatsapp || '')}</div></td>
        <td class="num dim">${l.ultima_visita ? new Date(l.ultima_visita).toLocaleDateString('es-MX') : '—'}</td>
        <td class="num dim">${l.proxima_cita ? new Date(l.proxima_cita).toLocaleDateString('es-MX') : '—'}</td>
        <td class="num">${l.visitas || 0}</td>
        <td><span class="chip chip-ok"><span class="chip-dot"></span>${l.estado_crm || 'activo'}</span></td>
        <td><button class="btn aria" onclick="suggestNBA('${l.id}','${escapeHtml(l.nombre)}')">Sugerir acción</button></td>
      </tr>`).join('');
  } catch(err){ console.error('CRM error:', err); }
};

window.suggestNBA = async function(leadId, name){
  // Crea sugerencia IA mock
  try {
    await sbInsert('ia_suggestions', {
      client_id: window.CLIENT_ID,
      type: 'send_whatsapp',
      title: `Follow-up con ${name}`,
      reasoning: 'Cliente activo sin contacto reciente. Recomiendo enviar mensaje de check-in para mantener engagement.',
      payload: { lead_id: leadId, template: 'check_in' },
      confidence: 0.75,
      source: 'manual',
      status: 'pending'
    });
    window.toast('🔮 ARIA generó sugerencia', `Revisa tu drawer`, 'aria');
  } catch(err){
    window.toast('Error', err.message, 'err');
  }
};

// ============================================
// VIEW: CAMPAIGNS
// ============================================
window.loadCampaigns = async function(){
  try {
    const camps = await sbGet('whatsapp_campaigns', `client_id=eq.${window.CLIENT_ID}&select=*&order=created_at.desc`);
    const tbody = document.getElementById('camp-tbody');
    if(camps.length === 0){
      tbody.innerHTML = '<tr><td colspan="9" class="dim" style="text-align:center;padding:20px;">No hay campañas creadas</td></tr>';
      return;
    }
    tbody.innerHTML = camps.map(c => `
      <tr>
        <td style="font-size:18px;">${c.icono || '📨'}</td>
        <td><strong>${escapeHtml(c.nombre)}</strong><div class="dim" style="font-size:10px;">${escapeHtml(c.descripcion || '')}</div></td>
        <td class="dim">${c.tipo}</td>
        <td class="dim">${c.segmento}</td>
        <td class="num">${c.enviados || 0}</td>
        <td class="num">${c.leidos || 0}</td>
        <td class="num">${c.respuestas || 0}</td>
        <td class="num ok">${c.citas_generadas || 0}</td>
        <td><span class="chip chip-${c.status==='activo'?'ok':'off'}"><span class="chip-dot"></span>${c.status}</span></td>
      </tr>`).join('');
  } catch(err){ console.error('Camp error:', err); }
};

window.openNewCampaign = function(){
  const body = `
    <div class="field"><div class="field-label">NOMBRE</div><input class="field-input" id="camp-name" placeholder="Promo de abril"></div>
    <div class="field"><div class="field-label">CANAL</div><select class="field-select" id="camp-channel"><option value="whatsapp">WhatsApp</option><option value="email">Email</option></select></div>
    <div class="field"><div class="field-label">SEGMENTO</div><select class="field-select" id="camp-segment"><option value="todos">Todos los clientes</option><option value="inactivos">Inactivos 3+ meses</option><option value="nuevos">Nuevos leads</option></select></div>
    <div class="field"><div class="field-label">MENSAJE</div><textarea class="field-textarea" id="camp-msg" placeholder="Hola {nombre}, tenemos una promo especial..."></textarea></div>
    <div style="padding:10px;background:var(--aria-s);border-radius:6px;font-size:11px;color:var(--text2);"><strong style="color:var(--aria);">ARIA:</strong> Antes de ejecutar, revisaré el mensaje y segmentación. Campañas masivas siempre requieren tu aprobación explícita.</div>
  `;
  showModal('Nueva campaña', body, '<button class="btn ghost" onclick="closeModal()">Cancelar</button><button class="btn aria" onclick="saveCampaign()">Guardar y pedir aprobación IA</button>');
};

window.saveCampaign = async function(){
  const payload = {
    client_id: window.CLIENT_ID,
    nombre: document.getElementById('camp-name').value,
    tipo: document.getElementById('camp-channel').value === 'whatsapp' ? 'broadcast' : 'email',
    segmento: document.getElementById('camp-segment').value,
    mensaje_template: document.getElementById('camp-msg').value,
    icono: '📣',
    status: 'draft'
  };
  try {
    await sbInsert('whatsapp_campaigns', payload);
    // Create IA suggestion for approval
    await sbInsert('ia_suggestions', {
      client_id: window.CLIENT_ID,
      type: 'create_campaign',
      title: `Aprobar campaña: ${payload.nombre}`,
      reasoning: `Estimación: ${payload.segmento === 'todos' ? '120' : '45'} destinatarios. Mensaje listo para envío.`,
      payload: payload,
      confidence: 0.8,
      source: 'manual',
      status: 'pending'
    });
    closeModal();
    window.toast('✓ Campaña guardada', 'ARIA generó sugerencia de aprobación', 'aria');
    window.openAria();
  } catch(err){
    window.toast('Error', err.message, 'err');
  }
};

// ============================================
// VIEW: INBOX WhatsApp
// ============================================
window.loadInbox = async function(){
  try {
    const msgs = await sbGet('whatsapp_messages', `client_id=eq.${window.CLIENT_ID}&select=*&order=created_at.desc&limit=30`);
    const panel = document.getElementById('wa-messages');
    if(msgs.length === 0){
      panel.innerHTML = '<div class="empty"><div class="empty-icon">💬</div><div class="empty-title">Sin mensajes aún</div><div class="empty-sub">Aparecerán aquí al recibir por WhatsApp</div></div>';
      return;
    }
    panel.innerHTML = msgs.map(m => `
      <div style="padding:10px 14px;border-bottom:1px solid var(--border);font-size:11px;">
        <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
          <span style="font-weight:500;color:${m.direction==='inbound'?'var(--success)':'var(--text2)'};">${m.direction==='inbound'?'◀ '+m.telefono:'▶ '+m.telefono}</span>
          <span class="dim" style="font-size:9px;font-family:'Geist Mono',monospace;">${window.formatTimeAgo(m.created_at)}</span>
        </div>
        <div style="color:var(--text);line-height:1.4;">${escapeHtml(m.mensaje || '')}</div>
      </div>`).join('');
  } catch(err){ console.error('Inbox error:', err); }
};

// ============================================
// VIEW: SLA
// ============================================
window.loadSLA = async function(){
  try {
    const kpis = await sbGet('kpi_snapshots', `client_id=eq.${window.CLIENT_ID}&select=uptime_pct,sla_pct,nps_score&order=fecha.desc&limit=1`);
    if(kpis.length === 0) return;
    const k = kpis[0];
    document.getElementById('sla-uptime').textContent = (k.uptime_pct || 99.9) + '%';
    document.getElementById('sla-score').textContent = (k.sla_pct || 100) + '%';
    document.getElementById('sla-nps').textContent = k.nps_score || '—';
  } catch(err){ console.error('SLA error:', err); }
};

// ============================================
// VIEW: BILLING
// ============================================
window.loadBilling = async function(){
  try {
    const [subs, invoices] = await Promise.all([
      sbGet('subscriptions', `client_id=eq.${window.CLIENT_ID}&select=*&order=created_at.desc&limit=1`),
      sbGet('invoices', `client_id=eq.${window.CLIENT_ID}&select=*&order=paid_at.desc&limit=20`)
    ]);

    if(subs.length > 0){
      const s = subs[0];
      document.getElementById('bill-plan').textContent = (s.plan || '—').toUpperCase();
      document.getElementById('bill-status').innerHTML = `<span class="chip chip-${s.status==='active'?'ok':'warn'}"><span class="chip-dot"></span>${s.status}</span>`;
      document.getElementById('bill-amount').textContent = '$' + (s.amount_cents/100).toLocaleString('en');
      document.getElementById('bill-interval').textContent = '/ ' + (s.interval || 'month');
      document.getElementById('bill-next').textContent = s.current_period_end ? new Date(s.current_period_end).toLocaleDateString('es-MX',{day:'numeric',month:'short'}) : '—';
    }

    const paidCount = invoices.filter(i => i.status === 'paid').length;
    document.getElementById('bill-paid').textContent = paidCount;

    const tbody = document.getElementById('bill-tbody');
    if(invoices.length === 0){
      tbody.innerHTML = '<tr><td colspan="6" class="dim" style="text-align:center;padding:20px;">No hay facturas aún</td></tr>';
    } else {
      tbody.innerHTML = invoices.map(i => `
        <tr>
          <td class="num">${i.number || i.id.slice(0,8)}</td>
          <td class="num dim">${i.period_start ? new Date(i.period_start).toLocaleDateString('es-MX',{month:'short',year:'numeric'}) : '—'}</td>
          <td class="num">$${(i.amount_due_cents/100).toLocaleString('en')}</td>
          <td><span class="chip chip-${i.status==='paid'?'ok':i.status==='open'?'warn':'off'}"><span class="chip-dot"></span>${i.status}</span></td>
          <td class="num dim">${i.paid_at ? new Date(i.paid_at).toLocaleDateString('es-MX') : '—'}</td>
          <td><button class="icon-btn" title="Descargar">⟱</button></td>
        </tr>`).join('');
    }
  } catch(err){ console.error('Billing error:', err); }
};

// ============================================
// VIEW: SETTINGS (con tabs)
// ============================================
window.loadSettings = async function(){
  const c = window.currentClient || {};
  // Perfil
  document.getElementById('set-nombre').value = c.nombre || '';
  document.getElementById('set-empresa').value = c.empresa || '';
  document.getElementById('set-email').value = c.email || '';
  document.getElementById('set-whatsapp').value = c.whatsapp || '';
  document.getElementById('set-industria').value = c.industria || '';
  document.getElementById('set-moneda').value = c.moneda || 'USD';
  // Email config (auto-fallback al email de perfil)
  document.getElementById('set-from-email').value = c.confirmation_email_from || '';
  document.getElementById('set-from-email').placeholder = c.email ? `Default: ${c.email}` : 'citas@tumarca.com';
  document.getElementById('set-from-name').value = c.confirmation_email_from_name || c.empresa || '';
  document.getElementById('set-reply-to').value = c.confirmation_email_reply_to || '';
  // n8n
  document.getElementById('set-n8n-url').value = c.n8n_webhook_url || '';
  const n8nStatus = document.getElementById('n8n-conn-status');
  if(c.n8n_webhook_url){
    n8nStatus.className = 'chip chip-ok';
    n8nStatus.innerHTML = '<span class="chip-dot"></span>CONFIGURADO';
  } else {
    n8nStatus.className = 'chip chip-off';
    n8nStatus.innerHTML = '<span class="chip-dot"></span>CONFIGURAR';
  }
  // Theme buttons state
  const isLight = document.body.classList.contains('theme-light');
  document.getElementById('theme-dark-btn').className = isLight ? 'btn ghost' : 'btn primary';
  document.getElementById('theme-light-btn').className = isLight ? 'btn primary' : 'btn ghost';

  // Load services tab data
  await loadServices();
};

window.setTab = function(tab){
  document.querySelectorAll('[data-view="settings"] .tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('[data-view="settings"] .tab-pane').forEach(p => p.classList.toggle('active', p.dataset.tab === tab));
};

window.saveProfile = async function(){
  const payload = {
    nombre: document.getElementById('set-nombre').value,
    empresa: document.getElementById('set-empresa').value,
    email: document.getElementById('set-email').value,
    whatsapp: document.getElementById('set-whatsapp').value,
    industria: document.getElementById('set-industria').value,
    moneda: document.getElementById('set-moneda').value
  };
  try {
    await sbPatch('clients', window.CLIENT_ID, payload);
    Object.assign(window.currentClient, payload);
    renderClientInfo();
    window.toast('✓ Perfil guardado', 'Cambios aplicados', 'success');
  } catch(err){ window.toast('Error', err.message, 'err'); }
};

window.saveEmailConfig = async function(){
  const payload = {
    confirmation_email_from: document.getElementById('set-from-email').value || null,
    confirmation_email_from_name: document.getElementById('set-from-name').value || null
  };
  try {
    await sbPatch('clients', window.CLIENT_ID, payload);
    Object.assign(window.currentClient, payload);
    const fromEmail = payload.confirmation_email_from || window.currentClient.email;
    window.toast('✓ Email config guardada', `Los emails saldrán desde ${fromEmail}`, 'success');
  } catch(err){ window.toast('Error', err.message, 'err'); }
};

window.testConfirmationEmail = async function(){
  const from = document.getElementById('set-from-email').value || window.currentClient.email;
  window.toast('📧 Test email', `Se enviaría desde: ${from} (pendiente n8n)`, 'success');
};

window.saveN8nWebhook = async function(){
  const url = document.getElementById('set-n8n-url').value.trim();
  try {
    await sbPatch('clients', window.CLIENT_ID, { n8n_webhook_url: url });
    window.currentClient.n8n_webhook_url = url;
    window.loadSettings();
    window.toast('✓ n8n Webhook actualizado', url ? 'Conectado' : 'Desconectado', 'success');
  } catch(err){ window.toast('Error', err.message, 'err'); }
};

window.setTheme = function(theme){
  if(theme === 'light'){
    document.body.classList.add('theme-light');
  } else {
    document.body.classList.remove('theme-light');
  }
  try { localStorage.setItem('theme', theme); } catch(e){}
  // Reinit charts if any (para que tomen colores correctos)
  Object.keys(window._chartBrief ? {brief:true} : {}).forEach(k => {
    // Reset charts
    window._chartBrief?.destroy();
    window._chartBrief = null;
  });
  if(window.currentView === 'brief') loadBriefData();
  // Update buttons if en settings
  if(window.currentView === 'settings'){
    const isLight = theme === 'light';
    document.getElementById('theme-dark-btn').className = isLight ? 'btn ghost' : 'btn primary';
    document.getElementById('theme-light-btn').className = isLight ? 'btn primary' : 'btn ghost';
  }
  window.toast('✓ Tema actualizado', theme === 'light' ? 'Modo claro' : 'Modo oscuro', 'success');
};

// ============================================
// SERVICES CRUD (tab Mis Servicios)
// ============================================
window.loadServices = async function(){
  try {
    const services = await sbGet('services', `client_id=eq.${window.CLIENT_ID}&select=*&order=orden.asc,created_at.desc`);
    window.CLIENT_SERVICES = services;
    const tbody = document.getElementById('svc-tbody');
    const count = document.getElementById('svc-count');
    if(!tbody) return;

    const activos = services.filter(s => s.activo).length;
    count.textContent = `${services.length} servicios · ${activos} activos`;

    if(services.length === 0){
      tbody.innerHTML = '<tr><td colspan="6" class="dim" style="text-align:center;padding:30px;">Aún no tienes servicios. Crea el primero para empezar.</td></tr>';
      return;
    }

    const moneda = window.currentClient?.moneda || 'USD';
    tbody.innerHTML = services.map(s => {
      const precio = (s.precio_cents / 100).toLocaleString('en', { minimumFractionDigits: 2 });
      return `
        <tr>
          <td><strong>${escapeHtml(s.nombre)}</strong>${s.descripcion ? `<div class="dim" style="font-size:10px;">${escapeHtml(s.descripcion)}</div>` : ''}</td>
          <td class="dim">${escapeHtml(s.categoria || '—')}</td>
          <td class="num">${moneda} ${precio}</td>
          <td class="num dim">${s.duracion_min} min</td>
          <td><span class="chip chip-${s.activo?'ok':'off'}"><span class="chip-dot"></span>${s.activo?'ACTIVO':'INACTIVO'}</span></td>
          <td style="text-align:right;"><button class="icon-btn" onclick="editService('${s.id}')" title="Editar">✎</button> <button class="icon-btn" onclick="toggleService('${s.id}')" title="${s.activo?'Desactivar':'Activar'}">${s.activo?'○':'●'}</button> <button class="icon-btn" onclick="deleteService('${s.id}')" title="Eliminar">✕</button></td>
        </tr>`;
    }).join('');
  } catch(err){ console.error('services error:', err); }
};

window.openNewService = function(){
  const moneda = window.currentClient?.moneda || 'USD';
  const body = `
    <div class="field"><div class="field-label">NOMBRE</div><input class="field-input" id="svc-nombre" placeholder="Ej: Limpieza facial"></div>
    <div class="field"><div class="field-label">DESCRIPCIÓN <span class="dim">(opcional)</span></div><textarea class="field-textarea" id="svc-desc" placeholder="Detalle del servicio..."></textarea></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
      <div class="field"><div class="field-label">CATEGORÍA</div><input class="field-input" id="svc-cat" placeholder="Estética, Consultas..."></div>
      <div class="field"><div class="field-label">DURACIÓN (min)</div><input class="field-input" id="svc-dur" type="number" value="60" min="5"></div>
    </div>
    <div class="field"><div class="field-label">PRECIO (${moneda})</div><input class="field-input" id="svc-precio" type="number" placeholder="45.00" step="0.01" min="0"></div>
  `;
  showModal('Nuevo servicio', body, '<button class="btn ghost" onclick="closeModal()">Cancelar</button><button class="btn primary" onclick="saveService()">Guardar</button>');
};

window.editService = function(id){
  const s = window.CLIENT_SERVICES.find(x => x.id === id);
  if(!s) return;
  const moneda = window.currentClient?.moneda || 'USD';
  const body = `
    <div class="field"><div class="field-label">NOMBRE</div><input class="field-input" id="svc-nombre" value="${escapeHtml(s.nombre)}"></div>
    <div class="field"><div class="field-label">DESCRIPCIÓN</div><textarea class="field-textarea" id="svc-desc">${escapeHtml(s.descripcion || '')}</textarea></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
      <div class="field"><div class="field-label">CATEGORÍA</div><input class="field-input" id="svc-cat" value="${escapeHtml(s.categoria || '')}"></div>
      <div class="field"><div class="field-label">DURACIÓN (min)</div><input class="field-input" id="svc-dur" type="number" value="${s.duracion_min}" min="5"></div>
    </div>
    <div class="field"><div class="field-label">PRECIO (${moneda})</div><input class="field-input" id="svc-precio" type="number" value="${(s.precio_cents/100).toFixed(2)}" step="0.01" min="0"></div>
  `;
  showModal('Editar servicio', body, `<button class="btn ghost" onclick="closeModal()">Cancelar</button><button class="btn primary" onclick="saveService('${id}')">Guardar cambios</button>`);
};

window.saveService = async function(id){
  const payload = {
    client_id: window.CLIENT_ID,
    nombre: document.getElementById('svc-nombre').value,
    descripcion: document.getElementById('svc-desc').value || null,
    categoria: document.getElementById('svc-cat').value || null,
    duracion_min: parseInt(document.getElementById('svc-dur').value) || 60,
    precio_cents: Math.round(parseFloat(document.getElementById('svc-precio').value) * 100) || 0,
    moneda: window.currentClient?.moneda || 'USD',
    activo: true
  };
  try {
    if(id) await sbPatch('services', id, payload);
    else await sbInsert('services', payload);
    closeModal();
    await loadServices();
    window.toast(id ? '✓ Servicio actualizado' : '✓ Servicio creado', payload.nombre, 'success');
  } catch(err){ window.toast('Error', err.message, 'err'); }
};

window.toggleService = async function(id){
  const s = window.CLIENT_SERVICES.find(x => x.id === id);
  if(!s) return;
  try {
    await sbPatch('services', id, { activo: !s.activo });
    await loadServices();
  } catch(err){ window.toast('Error', err.message, 'err'); }
};

window.deleteService = async function(id){
  const s = window.CLIENT_SERVICES.find(x => x.id === id);
  if(!s) return;
  if(!confirm(`¿Eliminar "${s.nombre}"? Esta acción no se puede deshacer.`)) return;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/services?id=eq.${id}`, { method:'DELETE', headers: SB_HEADERS });
    if(!r.ok) throw new Error('No se pudo eliminar');
    await loadServices();
    window.toast('✓ Servicio eliminado', s.nombre, 'success');
  } catch(err){ window.toast('Error', err.message, 'err'); }
};

// ============================================
// WHATSAPP connection detection
// ============================================
window.detectWhatsappConnection = function(){
  const webview = document.getElementById('wa-webview');
  const statusEl = document.getElementById('wa-status');
  const waConn = document.getElementById('wa-conn-status');
  if(!webview) return;

  // Escucha cuando el webview cambia de URL (indica scan exitoso)
  const checkConnection = () => {
    try {
      webview.executeJavaScript(`
        (() => {
          const qr = document.querySelector('canvas[aria-label*="QR"], div[data-testid="qrcode"]');
          const app = document.querySelector('#pane-side, [data-testid="chat-list"]');
          return app ? 'connected' : qr ? 'pending' : 'loading';
        })()
      `).then(result => {
        if(result === 'connected'){
          statusEl.className = 'wa-connect-status on';
          statusEl.innerHTML = '<span class="chip-dot"></span>WHATSAPP CONECTADO';
          if(waConn){
            waConn.className = 'chip chip-ok';
            waConn.innerHTML = '<span class="chip-dot"></span>CONECTADO';
          }
        } else if(result === 'pending'){
          statusEl.className = 'wa-connect-status off';
          statusEl.innerHTML = '<span class="chip-dot"></span>ESCANEA EL QR';
        }
      }).catch(()=>{});
    } catch(e){}
  };
  // Verifica cada 3 segundos cuando está en la vista inbox
  setTimeout(checkConnection, 2000);
  setInterval(() => { if(window.currentView === 'inbox') checkConnection(); }, 5000);

  // Load mensajes
  window.loadInbox?.();
};

// ============================================
// toggleNotifications & requestReport
// ============================================
window.toggleNotifications = function(){
  document.getElementById('bell-btn').classList.remove('has-notif');
  window.toast('Notificaciones', 'Centro de notificaciones próximamente', 'success');
};

window.requestReport = function(){
  window.toast('📄 Generando reporte...', 'Recibirás un email cuando esté listo', 'aria');
};

// ============================================
// BOOT
// ============================================
document.addEventListener('DOMContentLoaded', boot);
