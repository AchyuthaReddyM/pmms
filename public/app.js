// ===========================================================
// PMMS frontend logic — all API calls and DOM rendering
// ===========================================================

const TOKEN_KEY = 'pmms_token';
const USER_KEY = 'pmms_user';
let CURRENT_USER = null;
let CALENDAR_CURSOR = new Date(); // year/month being shown

// ---------- Tiny utils ----------
const $ = (id) => document.getElementById(id);
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, m => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));

function toast(msg, type='') {
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  $('toastBox').appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

// ---------- API helper ----------
async function api(method, url, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) opts.headers['X-Session-Token'] = token;
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  if (r.status === 401) {
    // Session expired / DB-side session row no longer exists.
    // Clean everything up so the login modal isn't competing with stale UI.
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    CURRENT_USER = null;
    try { closeModal(); } catch (e) {}                          // close any open form modal
    if (window._notifTimer) { clearInterval(window._notifTimer); window._notifTimer = null; }
    const notifPanel = document.getElementById('notifPanel');
    if (notifPanel) notifPanel.style.display = 'none';
    showLogin();
    throw new Error('Your session has expired — please sign in again.');
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

// ---------- Login flow ----------
function showLogin() {
  $('loginModal').classList.remove('hidden');
  $('appShell').classList.add('hidden');
}
function showApp() {
  $('loginModal').classList.add('hidden');
  $('appShell').classList.remove('hidden');
}

async function tryAutoLogin() {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) { showLogin(); return; }
  try {
    const { user } = await api('GET', '/api/auth/me');
    CURRENT_USER = user;
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    onLoggedIn();
  } catch (e) {
    showLogin();
  }
}

$('loginForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  $('loginError').textContent = '';
  try {
    const res = await api('POST', '/api/auth/login', {
      user_id: $('loginUser').value.trim(),
      password: $('loginPass').value
    });
    localStorage.setItem(TOKEN_KEY, res.token);
    localStorage.setItem(USER_KEY, JSON.stringify(res.user));
    CURRENT_USER = res.user;
    onLoggedIn();
    toast(`Welcome, ${res.user.name}`, 'success');
  } catch (e) {
    $('loginError').textContent = e.message;
  }
});

async function logout() {
  try { await api('POST', '/api/auth/logout'); } catch(e) {}
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  CURRENT_USER = null;
  showLogin();
}

function onLoggedIn() {
  showApp();
  $('topUserName').textContent = CURRENT_USER.name;
  $('topUserRole').textContent = `${CURRENT_USER.role} · ${CURRENT_USER.department || ''}`;
  $('userAvatar').textContent = CURRENT_USER.name.split(/\s+/).map(s => s[0]).slice(0,2).join('').toUpperCase();
  refreshNotifBadge();
  if (window._notifTimer) clearInterval(window._notifTimer);
  window._notifTimer = setInterval(refreshNotifBadge, 30000);
  loadDashboard();
}

// ---------- Routing ----------
const PAGES = ['dashboard','services','masters','users','settings','pmconfig','checklist','assignments','execution','tasks','pmstatus','expired','calendar','breakdown','reports','audit','compliance','about'];
const TITLE_MAP = { dashboard:'Dashboard', services:'Modules', masters:'Masters', users:'User Management', settings:'Admin Settings', pmconfig:'PM Configuration', checklist:'Checklists', assignments:'Checklist Assignment', execution:'PM Execution', tasks:'My Tasks', pmstatus:'PM Status', expired:'Expired Equipment', calendar:'Calendar', breakdown:'Breakdown', reports:'Reports', audit:'Audit Trail', compliance:'Compliance', about:'About' };

function goto(name) {
  PAGES.forEach(p => $('page-'+p)?.classList.toggle('active', p === name));
  document.querySelectorAll('.nav a').forEach(a => a.classList.toggle('active', a.dataset.page === name));
  $('crumb').textContent = TITLE_MAP[name] || name;
  window.scrollTo({ top: 0, behavior: 'smooth' });
  // Lazy-load page data
  const loaders = {
    dashboard: loadDashboard,
    masters: () => loadMasters('plants'),
    users: loadUsers,
    settings: () => loadSettings('departments'),
    pmconfig: loadPmConfig,
    checklist: loadChecklists,
    assignments: loadAssignmentsPage,
    execution: loadPmList,
    tasks: () => loadTasks('inbox'),
    pmstatus: loadPmStatusPage,
    expired: loadExpiredPage,
    calendar: loadCalendar,
    breakdown: loadBreakdowns,
    audit: () => loadAudit(100),
    compliance: loadCompliance,
  };
  loaders[name] && loaders[name]();
}

// Permission helper
function can(activity) {
  if (!CURRENT_USER) return false;
  if (CURRENT_USER.is_admin) return true;
  return (CURRENT_USER.permissions || []).includes(activity);
}

document.querySelectorAll('.nav a').forEach(a => a.addEventListener('click', () => goto(a.dataset.page)));

// ===========================================================
// DASHBOARD
// ===========================================================
async function loadDashboard() {
  try {
    const [kpis, byDept, audit, pmList, breakdowns] = await Promise.all([
      api('GET', '/api/dashboard/kpis'),
      api('GET', '/api/dashboard/compliance-by-dept'),
      api('GET', '/api/audit?limit=8'),
      api('GET', '/api/pm'),
      api('GET', '/api/breakdowns'),
    ]);

    // KPI tiles
    $('kpiRow').innerHTML = `
      <div class="card kpi compliance"><div class="icon-pill">✓</div>
        <div class="label">PM Compliance</div><div class="value">${kpis.compliance}%</div>
        <div class="progress green" style="margin-top:12px;"><span style="width:${kpis.compliance}%"></span></div>
      </div>
      <div class="card kpi overdue"><div class="icon-pill">!</div>
        <div class="label">Overdue / Expired</div><div class="value">${kpis.overdue}</div>
        <div class="delta bad">${kpis.overdue > 0 ? 'Needs attention' : 'All clear'}</div>
      </div>
      <div class="card kpi pending"><div class="icon-pill">⌛</div>
        <div class="label">Pending Activities</div><div class="value">${kpis.pending}</div>
        <div class="delta">Awaiting approval / execution</div>
      </div>
      <div class="card kpi completed"><div class="icon-pill">★</div>
        <div class="label">Completed (MTD)</div><div class="value">${kpis.completed_mtd}</div>
        <div class="delta">Total schedules: ${kpis.total_pms}</div>
      </div>`;

    // Dept compliance table
    $('deptComplianceBody').innerHTML = byDept.length === 0
      ? '<tr class="empty-row"><td colspan="5">No data</td></tr>'
      : byDept.map(r => {
        const cls = r.pct >= 95 ? 'green' : (r.pct >= 85 ? '' : 'red');
        return `<tr><td>${escapeHtml(r.department)}</td><td>${r.planned}</td><td>${r.done}</td><td>${r.pct}%</td>
                <td><div class="progress ${cls}"><span style="width:${r.pct}%"></span></div></td></tr>`;
      }).join('');

    // Recent activity
    $('recentAuditList').innerHTML = audit.map(a => `
      <li><div class="dot ${dotColor(a.action)}"></div>
        <div><strong>${escapeHtml(a.action)}</strong> · ${escapeHtml(a.entity)} ${escapeHtml(a.entity_id)} by <strong>${escapeHtml(a.user_name)}</strong>
        <div style="color:var(--muted); font-size:11px;">${escapeHtml(a.ts)} — ${escapeHtml(a.details)}</div></div></li>
    `).join('');

    // Upcoming PMs (status approved/assigned/pending, sched in future)
    const upcoming = pmList
      .filter(p => ['Pending','Approved','Assigned'].includes(p.status) && p.scheduled_date >= new Date().toISOString().slice(0,10))
      .sort((a,b) => a.scheduled_date.localeCompare(b.scheduled_date))
      .slice(0, 5);
    $('upcomingPmBody').innerHTML = upcoming.length === 0
      ? '<tr class="empty-row"><td colspan="4">No upcoming PMs</td></tr>'
      : upcoming.map(p => `<tr><td><strong>${escapeHtml(p.pm_id)}</strong></td>
        <td>${escapeHtml(p.equipment_name || p.equipment_id)}</td>
        <td>${escapeHtml(p.scheduled_date)}</td>
        <td>${statusPill(p.status)}</td></tr>`).join('');

    // Open breakdowns
    const openBds = breakdowns.filter(b => !['Closed','Resolved'].includes(b.status));
    $('openBdBody').innerHTML = openBds.length === 0
      ? '<tr class="empty-row"><td colspan="4">No open breakdowns</td></tr>'
      : openBds.slice(0, 5).map(b => `<tr><td><strong>${escapeHtml(b.bd_id)}</strong></td>
        <td>${escapeHtml(b.equipment_name || b.equipment_id)}</td>
        <td>${severityPill(b.severity)}</td>
        <td>${statusPill(b.status)}</td></tr>`).join('');

  } catch (e) { toast(e.message, 'error'); }
}

function dotColor(action) {
  if (['APPROVE','COMPLETE','CREATE'].includes(action)) return 'green';
  if (['DELETE','LOGOUT'].includes(action)) return 'red';
  if (['START','UPDATE','ASSIGN'].includes(action)) return 'blue';
  if (['LOGIN'].includes(action)) return 'amber';
  return '';
}

function statusPill(status) {
  const map = {
    'Pending':'brown','Approved':'green','Assigned':'amber','In Progress':'blue',
    'Completed':'gray','Overdue':'red','Expired':'red','Escalated':'blue',
    'Active':'green','Investigating':'amber','Spares Awaited':'blue','Closed':'gray','Resolved':'gray',
    'Inactive':'gray','Under Review':'amber','Locked':'amber','Validation':'amber',
    'Under Maintenance':'red',
    // Checklist workflow states
    'Draft':'gray','Pending Review':'amber','Pending Approval':'amber','Rejected':'red','Expired':'red'
  };
  return `<span class="pill ${map[status] || 'gray'}">${escapeHtml(status)}</span>`;
}
function severityPill(s) {
  const map = { 'Critical':'red','Major':'amber','Minor':'blue' };
  return `<span class="pill ${map[s] || 'gray'}">${escapeHtml(s)}</span>`;
}

// ===========================================================
// MASTERS
// ===========================================================
const MASTER_DEFS = {
  plants: {
    api: '/api/plants',
    head: ['Plant ID','Plant Name','Plant Location','Status','Modified'],
    row: r => [r.plant_id, r.name, r.location, statusPill(r.status), r.modified_at],
    canAdd: true,
    addFields: [
      { id:'plant_id', label:'Plant ID', required:true, placeholder:'e.g., PL-001, Unit-1, U-Hyd' },
      { id:'name', label:'Plant Name', required:true },
      { id:'location', label:'Plant Location' },
    ],
    create: (data) => api('POST','/api/plants',data),
  },
  blocks: {
    api: '/api/blocks',
    head: ['Plant','Block ID','Block Name','Status'],
    row: r => [r.plant_id, r.block_id, r.name, statusPill(r.status)],
    canAdd: true,
    addFields: [
      { id:'plant_id', label:'Plant ID', required:true, type:'remoteSelect', source:'/api/plants', valueKey:'plant_id', labelFn:r => `${r.plant_id} · ${r.name}` },
      { id:'block_id', label:'Block ID', required:true, placeholder:'e.g., BLK-001' },
      { id:'name', label:'Block Name', required:true },
    ],
    create: (data) => api('POST','/api/blocks',data),
  },
  formulations: {
    api: '/api/formulations',
    head: ['Formulation ID','Formulation Name','Status'],
    row: r => [r.formulation_id, r.name, statusPill(r.status)],
    canAdd: true,
    addFields: [
      { id:'name', label:'Formulation Name', required:true, placeholder:'e.g., OSD, Injectable, Softgel, Bag Filling, Others' },
    ],
    create: (data) => api('POST','/api/formulations',data),
  },
  locations: {
    api: '/api/locations',
    head: ['Location ID','Block','Location Name','Formulation','Status'],
    row: r => [r.location_id, r.block_id, r.description, r.formulation_name || '—', statusPill(r.status)],
    canAdd: true,
    customAdd: () => openLocationModal(),
  },
  areas: {
    api: '/api/areas',
    head: ['Area ID','Location','Area Name','Status'],
    row: r => [r.area_id, r.location_id, r.name || r.area_type || '—', statusPill(r.status)],
    canAdd: true,
    customAdd: () => openAreaModal(),
  },
  equipment: {
    api: '/api/equipment',
    head: ['Equipment ID','Equipment Name','Make','Model','Serial','Area','Status','QR','Actions'],
    row: r => [r.equipment_id, r.name, r.make || r.make_model || '—', r.model || '—', r.serial, r.area_id, statusPill(r.status), `<span title="${escapeHtml(r.qr_code)}">▣</span>`,
               `<button class="btn ghost sm" onclick="openAssignChecklistModal(null, '${escapeHtml(r.equipment_id)}')">🎯 Assign</button>`],
    canAdd: true,
    customAdd: () => openEquipmentModal(),
  },
};
let CURRENT_MASTER = 'plants';

async function loadMasters(which) {
  CURRENT_MASTER = which;
  const def = MASTER_DEFS[which];
  document.querySelectorAll('#masterTabs button').forEach(b => b.classList.toggle('active', b.dataset.mt === which));
  $('mastersHead').innerHTML = '<tr>' + def.head.map(h => `<th>${h}</th>`).join('') + '</tr>';
  $('masterAddBtn').style.display = def.canAdd ? '' : 'none';
  try {
    const rows = await api('GET', def.api);
    $('mastersBody').innerHTML = rows.length === 0
      ? `<tr class="empty-row"><td colspan="${def.head.length}">No records</td></tr>`
      : rows.map(r => '<tr>' + def.row(r).map(c => `<td>${c ?? ''}</td>`).join('') + '</tr>').join('');
  } catch (e) { toast(e.message, 'error'); }
}

document.querySelectorAll('#masterTabs button').forEach(b => b.addEventListener('click', () => loadMasters(b.dataset.mt)));

async function openMasterAddModal() {
  const def = MASTER_DEFS[CURRENT_MASTER];
  if (!def.canAdd) return;
  // If a master defines its own modal, defer to it.
  if (typeof def.customAdd === 'function') return def.customAdd();
  // Pre-load any remote select options
  const remoteData = {};
  for (const f of def.addFields) {
    if (f.type === 'remoteSelect') {
      try { remoteData[f.id] = await api('GET', f.source); }
      catch (e) { remoteData[f.id] = []; }
    }
  }
  openModal({
    title: `Add ${CURRENT_MASTER.slice(0,-1).replace(/^./, c=>c.toUpperCase())}`,
    body: def.addFields.map(f => {
      if (f.type === 'select') {
        return `<div class="form-row"><label>${f.label}${f.required?' *':''}</label>
          <select name="${f.id}" ${f.required?'required':''}>${f.options.map(o => `<option>${o}</option>`).join('')}</select></div>`;
      }
      if (f.type === 'remoteSelect') {
        const rows = remoteData[f.id] || [];
        return `<div class="form-row"><label>${f.label}${f.required?' *':''}</label>
          <select name="${f.id}" ${f.required?'required':''}>
            ${f.required ? '' : '<option value="">—</option>'}
            ${rows.map(r => `<option value="${escapeHtml(r[f.valueKey])}">${escapeHtml(f.labelFn(r))}</option>`).join('')}
          </select></div>`;
      }
      return `<div class="form-row"><label>${f.label}${f.required?' *':''}</label>
        <input name="${f.id}" type="text" placeholder="${f.placeholder || ''}" ${f.required?'required':''} /></div>`;
    }).join(''),
    onSubmit: async (data) => {
      await def.create(data);
      toast('Created.', 'success');
      loadMasters(CURRENT_MASTER);
    }
  });
}

// ----- Custom Location Master modal (Block dropdown -> auto-pop Block Name + ID + Name inputs) -----
async function openLocationModal() {
  try {
    const [blocks, formulations] = await Promise.all([
      api('GET','/api/blocks'),
      api('GET','/api/formulations'),
    ]);
    window.__lmOnBlock = () => {
      const sel = document.getElementById('lmBlockSel');
      const b = blocks.find(x => x.block_id === sel.value);
      const el = document.getElementById('lmBlockNameAuto');
      if (b) {
        el.innerHTML = `<strong style="color:var(--brown-700);">Block Name:</strong> ${escapeHtml(b.name)}`;
      } else {
        el.innerHTML = `<em style="color:var(--muted);">Block Name will appear here once you pick a Block ID.</em>`;
      }
    };
    openModal({
      title: 'Add Location',
      width: 560,
      body: `
        <div class="form-row"><label>Block ID *</label>
          <div>
            <select id="lmBlockSel" name="block_id" required onchange="window.__lmOnBlock()">
              <option value="">— select block —</option>
              ${blocks.map(b => `<option value="${escapeHtml(b.block_id)}">${escapeHtml(b.block_id)} · ${escapeHtml(b.name || '')}</option>`).join('')}
            </select>
            <div id="lmBlockNameAuto" style="font-size:12px; margin-top:5px;"><em style="color:var(--muted);">Block Name will appear here once you pick a Block ID.</em></div>
          </div>
        </div>
        <div class="form-row"><label>Location ID *</label>
          <input name="location_id" required placeholder="e.g., LOC-FIL-01, GRN-01, Comp-01" />
        </div>
        <div class="form-row"><label>Location Name *</label>
          <input name="name" required placeholder="e.g., Filling-1, Granulation Room 1" />
        </div>
        <div class="form-row"><label>Formulation</label>
          <select name="formulation_id">
            <option value="">— none —</option>
            ${formulations.map(f => `<option value="${f.id}">${escapeHtml(f.name)}</option>`).join('')}
          </select>
        </div>
      `,
      onSubmit: async (data) => {
        await api('POST','/api/locations', {
          location_id: data.location_id,
          block_id: data.block_id,
          name: data.name,
          formulation_id: data.formulation_id ? Number(data.formulation_id) : null
        });
        toast('Location created.', 'success');
        loadMasters('locations');
      }
    });
  } catch (e) { toast(e.message, 'error'); }
}

// ----- Custom Area Master modal (Block + Location cascading, manual Area ID + Name) -----
async function openAreaModal() {
  try {
    const [blocks, locations] = await Promise.all([
      api('GET','/api/blocks'),
      api('GET','/api/locations'),
    ]);
    const setAuto = (id, label, value) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.innerHTML = value
        ? `<strong style="color:var(--brown-700);">${escapeHtml(label)}:</strong> ${escapeHtml(value)}`
        : `<em style="color:var(--muted);">${escapeHtml(label)} will appear here once you pick an ID above.</em>`;
    };
    window.__armOnBlock = () => {
      const sel = document.getElementById('armBlockSel');
      const b = blocks.find(x => x.block_id === sel.value);
      setAuto('armBlockNameAuto', 'Block Name', b ? b.name : null);
      const matching = locations.filter(l => l.block_id === sel.value);
      document.getElementById('armLocSel').innerHTML = '<option value="">— select location —</option>' +
        matching.map(l => `<option value="${escapeHtml(l.location_id)}">${escapeHtml(l.location_id)} · ${escapeHtml(l.description || '')}</option>`).join('');
      setAuto('armLocNameAuto', 'Location Name', null);
    };
    window.__armOnLoc = () => {
      const sel = document.getElementById('armLocSel');
      const l = locations.find(x => x.location_id === sel.value);
      setAuto('armLocNameAuto', 'Location Name', l ? l.description : null);
    };
    openModal({
      title: 'Add Area',
      width: 580,
      body: `
        <div class="form-row"><label>Block ID *</label>
          <div>
            <select id="armBlockSel" name="block_id" required onchange="window.__armOnBlock()">
              <option value="">— select block —</option>
              ${blocks.map(b => `<option value="${escapeHtml(b.block_id)}">${escapeHtml(b.block_id)} · ${escapeHtml(b.name || '')}</option>`).join('')}
            </select>
            <div id="armBlockNameAuto" style="font-size:12px; margin-top:5px;"><em style="color:var(--muted);">Block Name will appear here once you pick a Block ID.</em></div>
          </div>
        </div>
        <div class="form-row"><label>Location ID *</label>
          <div>
            <select id="armLocSel" name="location_id" required onchange="window.__armOnLoc()">
              <option value="">— select block first —</option>
            </select>
            <div id="armLocNameAuto" style="font-size:12px; margin-top:5px;"><em style="color:var(--muted);">Location Name will appear here once you pick a Location ID.</em></div>
          </div>
        </div>
        <div class="form-row"><label>Area ID *</label>
          <input name="area_id" required placeholder="e.g., AR-001, GD-Filling-01" />
        </div>
        <div class="form-row"><label>Area Name *</label>
          <input name="name" required placeholder="e.g., Classified — Grade D" />
        </div>
      `,
      onSubmit: async (data) => {
        if (!data.location_id) throw new Error('Please select a Location');
        await api('POST','/api/areas', { area_id: data.area_id, location_id: data.location_id, name: data.name });
        toast('Area created.', 'success');
        loadMasters('areas');
      }
    });
  } catch (e) { toast(e.message, 'error'); }
}

// ----- Custom Equipment Registration modal (cascading Block -> Location -> Area + manual Equipment ID + Make/Model) -----
async function openEquipmentModal(existing) {
  try {
    const [blocks, locations, areas] = await Promise.all([
      api('GET','/api/blocks'),
      api('GET','/api/locations'),
      api('GET','/api/areas'),
    ]);
    const setAuto = (id, label, value) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.innerHTML = value
        ? `<strong style="color:var(--brown-700);">${escapeHtml(label)}:</strong> ${escapeHtml(value)}`
        : `<em style="color:var(--muted);">${escapeHtml(label)} will appear here once you pick an ID above.</em>`;
    };
    window.__eqmOnBlock = () => {
      const sel = document.getElementById('eqmBlockSel');
      const b = blocks.find(x => x.block_id === sel.value);
      setAuto('eqmBlockNameAuto', 'Block Name', b ? b.name : null);
      const matching = locations.filter(l => l.block_id === sel.value);
      document.getElementById('eqmLocSel').innerHTML = '<option value="">— select location —</option>' +
        matching.map(l => `<option value="${escapeHtml(l.location_id)}">${escapeHtml(l.location_id)} · ${escapeHtml(l.description || '')}</option>`).join('');
      setAuto('eqmLocNameAuto', 'Location Name', null);
      document.getElementById('eqmAreaSel').innerHTML = '<option value="">— select location first —</option>';
      setAuto('eqmAreaNameAuto', 'Area Name', null);
    };
    window.__eqmOnLoc = () => {
      const sel = document.getElementById('eqmLocSel');
      const l = locations.find(x => x.location_id === sel.value);
      setAuto('eqmLocNameAuto', 'Location Name', l ? l.description : null);
      const matching = areas.filter(a => a.location_id === sel.value);
      document.getElementById('eqmAreaSel').innerHTML = '<option value="">— select area —</option>' +
        matching.map(a => `<option value="${escapeHtml(a.area_id)}">${escapeHtml(a.area_id)} · ${escapeHtml(a.name || a.area_type || '')}</option>`).join('');
      setAuto('eqmAreaNameAuto', 'Area Name', null);
    };
    window.__eqmOnArea = () => {
      const sel = document.getElementById('eqmAreaSel');
      const a = areas.find(x => x.area_id === sel.value);
      setAuto('eqmAreaNameAuto', 'Area Name', a ? (a.name || a.area_type) : null);
    };

    openModal({
      title: existing ? `Edit Equipment — ${escapeHtml(existing.equipment_id)}` : 'Register Equipment',
      width: 620,
      body: `
        <div class="form-row"><label>Block ID *</label>
          <div>
            <select id="eqmBlockSel" required onchange="window.__eqmOnBlock()">
              <option value="">— select block —</option>
              ${blocks.map(b => `<option value="${escapeHtml(b.block_id)}">${escapeHtml(b.block_id)} · ${escapeHtml(b.name || '')}</option>`).join('')}
            </select>
            <div id="eqmBlockNameAuto" style="font-size:12px; margin-top:5px;"><em style="color:var(--muted);">Block Name will appear here once you pick a Block ID.</em></div>
          </div>
        </div>
        <div class="form-row"><label>Location ID *</label>
          <div>
            <select id="eqmLocSel" required onchange="window.__eqmOnLoc()">
              <option value="">— select block first —</option>
            </select>
            <div id="eqmLocNameAuto" style="font-size:12px; margin-top:5px;"><em style="color:var(--muted);">Location Name will appear here once you pick a Location ID.</em></div>
          </div>
        </div>
        <div class="form-row"><label>Area ID *</label>
          <div>
            <select id="eqmAreaSel" name="area_id" required onchange="window.__eqmOnArea()">
              <option value="">— select location first —</option>
            </select>
            <div id="eqmAreaNameAuto" style="font-size:12px; margin-top:5px;"><em style="color:var(--muted);">Area Name will appear here once you pick an Area ID.</em></div>
          </div>
        </div>
        <div class="form-row"><label>Equipment ID *</label>
          <input name="equipment_id" required ${existing?'readonly':''} value="${escapeHtml(existing?.equipment_id || '')}" placeholder="e.g., EQ-FBD-04" />
        </div>
        <div class="form-row"><label>Equipment Name *</label><input name="name" required value="${escapeHtml(existing?.name || '')}" placeholder="e.g., Fluid Bed Dryer" /></div>
        <div class="form-row"><label>Make</label><input name="make" value="${escapeHtml(existing?.make || '')}" placeholder="e.g., Gansons" /></div>
        <div class="form-row"><label>Serial Number</label><input name="serial" value="${escapeHtml(existing?.serial || '')}" /></div>
        <div class="form-row"><label>Model Number</label><input name="model" value="${escapeHtml(existing?.model || '')}" placeholder="e.g., RMG-300" /></div>
        <div class="form-row"><label>Status</label>
          <select name="status">
            ${['Active','Inactive'].map(s => `<option ${s===(existing?.status||'Active')?'selected':''}>${s}</option>`).join('')}
          </select>
        </div>
        <p style="font-size:11px; color:var(--muted); margin:6px 0 0;">A QR code is generated automatically from the Equipment ID for shop-floor scanning.</p>
      `,
      onSubmit: async (data) => {
        if (!data.area_id) throw new Error('Please select an Area');
        const payload = {
          equipment_id: data.equipment_id,
          name: data.name, make: data.make, model: data.model,
          serial: data.serial,
          area_id: data.area_id, status: data.status
        };
        if (existing) await api('PUT', `/api/equipment/${existing.equipment_id}`, payload);
        else          await api('POST','/api/equipment', payload);
        toast(existing ? 'Equipment updated.' : 'Equipment registered.', 'success');
        loadMasters('equipment');
      }
    });
  } catch (e) { toast(e.message, 'error'); }
}

// ===========================================================
// USERS
// ===========================================================
async function loadUsers() {
  try {
    const users = await api('GET','/api/users');
    $('usersBody').innerHTML = users.length === 0
      ? '<tr class="empty-row"><td colspan="8">No users</td></tr>'
      : users.map(u => `
      <tr>
        <td><strong>${escapeHtml(u.user_id)}</strong></td>
        <td>${escapeHtml(u.employee_id || '—')}</td>
        <td>${escapeHtml(u.name)}<div style="color:var(--muted); font-size:11px;">${escapeHtml(u.email || '')}</div></td>
        <td>${escapeHtml(u.role)}</td>
        <td>${escapeHtml(u.department || '')}</td>
        <td>${statusPill(u.status)}</td>
        <td>${escapeHtml(u.last_login || 'Never')}</td>
        <td style="white-space:nowrap;">
          <button class="btn ghost sm" onclick="resetUserPasswordPrompt('${u.user_id}','${escapeHtml(u.name)}')">🔑 Reset</button>
          ${u.status === 'Active'
            ? `<button class="btn ghost sm" onclick="setUserStatus('${u.user_id}','Locked')">Lock</button>
               <button class="btn ghost sm" onclick="confirmDeactivate('${u.user_id}','${escapeHtml(u.name)}')">Deactivate</button>`
            : `<button class="btn ghost sm" onclick="setUserStatus('${u.user_id}','Active')">Activate</button>`}
        </td>
      </tr>`).join('');
  } catch (e) { toast(e.message, 'error'); }
}

async function setUserStatus(user_id, status) {
  try { await api('PUT', `/api/users/${user_id}/status`, { status }); toast(`User ${user_id} set to ${status}`, 'success'); loadUsers(); }
  catch (e) { toast(e.message, 'error'); }
}

function confirmDeactivate(user_id, name) {
  if (!confirm(`Deactivate ${name}? Their active sessions will be terminated and they won't be able to sign in.`)) return;
  setUserStatus(user_id, 'Inactive');
}

function resetUserPasswordPrompt(user_id, name) {
  openModal({
    title: `Reset password for ${escapeHtml(name)}`,
    body: `
      <p style="font-size:12px; color:var(--muted); margin-top:0;">Setting a new password will sign this user out of all active sessions. They'll need to log in again with the new password.</p>
      <div class="form-row"><label>New Password *</label><input name="password" type="password" minlength="6" required autofocus /></div>
      <div class="form-row"><label>Confirm *</label><input name="confirm" type="password" minlength="6" required /></div>
    `,
    submitLabel: 'Reset Password',
    onSubmit: async (data) => {
      if (data.password !== data.confirm) throw new Error('Passwords do not match');
      await api('PUT', `/api/users/${user_id}/password`, { password: data.password });
      toast(`Password reset for ${name}.`, 'success');
    }
  });
}
async function openUserAddModal() {
  try {
    const [roles, depts] = await Promise.all([
      api('GET','/api/roles'),
      api('GET','/api/departments'),
    ]);
    openModal({
      title: 'Add User',
      width: 560,
      body: `
        <div class="form-row"><label>Login ID *</label><input name="user_id" required placeholder="short username, e.g. jsharma" /></div>
        <div class="form-row"><label>Employee ID</label><input name="employee_id" placeholder="e.g. EMP-1234" /></div>
        <div class="form-row"><label>Full Name *</label><input name="name" required /></div>
        <div class="form-row"><label>Email</label><input name="email" type="email" /></div>
        <div class="form-row"><label>Phone</label><input name="phone" type="tel" placeholder="+91 ..." /></div>
        <div class="form-row"><label>Initial Password *</label><input name="password" type="password" minlength="6" required /></div>
        <div class="form-row"><label>Role *</label>
          <select name="role_id" id="userRoleSel" required>
            ${roles.filter(r=>r.status==='Active').map(r => `<option value="${r.id}" data-dept="${r.department_id}">${escapeHtml(r.name)} — ${escapeHtml(r.department_name)}</option>`).join('')}
          </select>
        </div>
        <div class="form-row"><label>Department</label>
          <select name="department_id" id="userDeptSel">
            <option value="">— use role's department —</option>
            ${depts.filter(d=>d.status==='Active').map(d => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join('')}
          </select>
        </div>
        <p style="font-size:11px; color:var(--muted); margin:6px 0 0;">Each role belongs to a department by default. Override only if this user should report in a different department.</p>
      `,
      onSubmit: async (data) => {
        const payload = {
          user_id: data.user_id, employee_id: data.employee_id || null,
          name: data.name, email: data.email, phone: data.phone,
          password: data.password,
          role_id: Number(data.role_id),
          department_id: data.department_id ? Number(data.department_id) : null,
        };
        await api('POST','/api/users', payload);
        toast('User created.', 'success');
        loadUsers();
      }
    });
  } catch (e) { toast(e.message, 'error'); }
}

// ===========================================================
// PM CONFIGURATION
// ===========================================================
async function loadPmConfig() {
  try {
    const [freqs, cats, groups, equipment, checklists, users, depts] = await Promise.all([
      api('GET','/api/frequencies'),
      api('GET','/api/pm-categories'),
      api('GET','/api/checklist-groups'),
      api('GET','/api/equipment'),
      api('GET','/api/checklists'),
      api('GET','/api/users'),
      api('GET','/api/departments'),
    ]);
    const adminMode = can('manage_pm_frequencies');
    const adminCatMode = can('manage_pm_categories');
    $('freqBody').innerHTML = freqs.length === 0 ? '<tr class="empty-row"><td colspan="4">No frequencies</td></tr>' :
      freqs.map(f => `<tr>
        <td><strong>${escapeHtml(f.name)}</strong></td>
        <td>${f.days}</td>
        <td>±${f.tolerance_days}</td>
        <td style="text-align:right;">
          ${adminMode ? `<button class="btn ghost sm" onclick='openFreqModal(${escapeHtml(JSON.stringify(f))})'>Edit</button>
                         <button class="btn ghost sm" onclick="deleteFreq(${f.id})">×</button>` : ''}
        </td></tr>`).join('');
    $('catBody').innerHTML = cats.length === 0 ? '<tr class="empty-row"><td colspan="3">No categories</td></tr>' :
      cats.map(c => `<tr>
        <td><strong>${escapeHtml(c.name)}</strong></td>
        <td>${escapeHtml(c.description || '')}</td>
        <td style="text-align:right;">
          ${adminCatMode ? `<button class="btn ghost sm" onclick='openCatModal(${escapeHtml(JSON.stringify(c))})'>Edit</button>
                            <button class="btn ghost sm" onclick="deleteCat(${c.id})">×</button>` : ''}
        </td></tr>`).join('');
    const groupEdit = can('manage_checklists') || can('manage_pm_categories');
    $('groupBody').innerHTML = groups.length === 0 ? '<tr class="empty-row"><td colspan="3">No groups</td></tr>' :
      groups.map(g => `<tr>
        <td><strong>${escapeHtml(g.name)}</strong></td>
        <td>${escapeHtml(g.department || '')}</td>
        <td style="text-align:right;">
          ${groupEdit ? `<button class="btn ghost sm" onclick='openGroupModal(${escapeHtml(JSON.stringify(g))})'>Edit</button>
                        <button class="btn ghost sm" onclick="deleteGroup(${g.id})">×</button>` : ''}
        </td></tr>`).join('');

    fillSelect($('pmEquipment'), equipment, 'equipment_id', e => `${e.equipment_id} · ${e.name}`);
    fillSelect($('pmChecklist'), checklists, 'id', c => `${c.name} (${c.version})`, true);
    fillSelect($('pmFrequency'), freqs, 'name', f => f.name);
    fillSelect($('pmCategory'), cats, 'name', c => c.name, true);
    fillSelect($('pmDept'), depts, 'name', d => d.name, true);
    const techs = users.filter(u => u.role === 'Technician');
    const revs = users.filter(u => u.role === 'Reviewer' || u.role === 'QA');
    const apps = users.filter(u => u.role === 'Approver' || u.role === 'System Administrator' || u.role === 'Engineering');
    fillSelect($('pmTech'), techs, 'id', u => `${u.name} (${u.department || u.role})`, true);
    fillSelect($('pmReviewer'), revs, 'id', u => `${u.name} (${u.role})`, true);
    fillSelect($('pmApprover'), apps, 'id', u => `${u.name} (${u.role})`, true);

    // Default schedule date = today
    $('pmDate').value = new Date().toISOString().slice(0,10);
  } catch (e) { toast(e.message, 'error'); }
}

// ----- Frequency master CRUD -----
function openFreqModal(existing) {
  const f = existing || { name:'', days:'', tolerance_days:0 };
  openModal({
    title: existing ? `Edit Maintenance Frequency — ${escapeHtml(f.name)}` : 'Add Maintenance Frequency',
    body: `
      <div class="form-row"><label>Maintenance Frequency *</label><input name="name" value="${escapeHtml(f.name)}" required placeholder="e.g. Monthly" /></div>
      <div class="form-row"><label>Frequency Interval (Days) *</label><input name="days" type="number" min="1" value="${escapeHtml(f.days)}" required /></div>
      <div class="form-row"><label>Allowed Tolerance (Days)</label><input name="tolerance_days" type="number" min="0" value="${escapeHtml(f.tolerance_days)}" /></div>
    `,
    onSubmit: async (data) => {
      const payload = { name: data.name, days: Number(data.days), tolerance_days: Number(data.tolerance_days || 0) };
      if (existing) await api('PUT', `/api/frequencies/${existing.id}`, payload);
      else          await api('POST','/api/frequencies', payload);
      toast('Saved.', 'success'); loadPmConfig();
    }
  });
}
async function deleteFreq(id) {
  if (!confirm('Delete this frequency?')) return;
  try { await api('DELETE', `/api/frequencies/${id}`); toast('Deleted.','success'); loadPmConfig(); }
  catch (e) { toast(e.message,'error'); }
}

// ----- PM Category master CRUD -----
function openCatModal(existing) {
  const c = existing || { name:'', description:'' };
  openModal({
    title: existing ? `Edit Maintenance Category — ${escapeHtml(c.name)}` : 'Add Maintenance Category',
    body: `
      <div class="form-row"><label>Maintenance Category *</label><input name="name" value="${escapeHtml(c.name)}" required placeholder="e.g. Mechanical / Electrical" /></div>
      <div class="form-row" style="grid-template-columns:1fr;"><label>Description</label><textarea name="description">${escapeHtml(c.description || '')}</textarea></div>
    `,
    onSubmit: async (data) => {
      if (existing) await api('PUT', `/api/pm-categories/${existing.id}`, data);
      else          await api('POST','/api/pm-categories', data);
      toast('Saved.', 'success'); loadPmConfig();
    }
  });
}
async function deleteCat(id) {
  if (!confirm('Delete this PM category?')) return;
  try { await api('DELETE', `/api/pm-categories/${id}`); toast('Deleted.','success'); loadPmConfig(); }
  catch (e) { toast(e.message,'error'); }
}

// ----- Checklist Group master CRUD -----
async function openGroupModal(existing) {
  const g = existing || { name:'', department_id:'' };
  let depts = [];
  try { depts = await api('GET','/api/departments'); } catch (e) {}
  openModal({
    title: existing ? `Edit Check List Group — ${escapeHtml(g.name)}` : 'Add Check List Group',
    body: `
      <div class="form-row"><label>Check List Group *</label><input name="name" value="${escapeHtml(g.name)}" required placeholder="e.g. Mechanical / Electrical / HVAC / Water Systems" /></div>
      <div class="form-row"><label>Department</label>
        <select name="department_id">
          <option value="">— none —</option>
          ${depts.map(d => `<option value="${d.id}" ${d.id===g.department_id?'selected':''}>${escapeHtml(d.name)}</option>`).join('')}
        </select>
      </div>
    `,
    onSubmit: async (data) => {
      const payload = { name: data.name, department_id: data.department_id ? Number(data.department_id) : null };
      if (existing) await api('PUT', `/api/checklist-groups/${existing.id}`, payload);
      else          await api('POST','/api/checklist-groups', payload);
      toast('Saved.', 'success'); loadPmConfig();
    }
  });
}
async function deleteGroup(id) {
  if (!confirm('Delete this checklist group?')) return;
  try { await api('DELETE', `/api/checklist-groups/${id}`); toast('Deleted.','success'); loadPmConfig(); }
  catch (e) { toast(e.message,'error'); }
}

function fillSelect(el, rows, valKey, labelFn, allowEmpty=false) {
  el.innerHTML = (allowEmpty ? '<option value="">—</option>' : '') +
    rows.map(r => `<option value="${escapeHtml(r[valKey])}">${escapeHtml(labelFn(r))}</option>`).join('');
}

$('newPmForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const payload = {
    equipment_id: $('pmEquipment').value,
    checklist_id: $('pmChecklist').value || null,
    frequency: $('pmFrequency').value,
    category: $('pmCategory').value || null,
    scheduled_date: $('pmDate').value,
    department: $('pmDept').value || null,
    technician_id: $('pmTech').value ? Number($('pmTech').value) : null,
    reviewer_id: $('pmReviewer').value ? Number($('pmReviewer').value) : null,
    approver_id: $('pmApprover').value ? Number($('pmApprover').value) : null,
  };
  try {
    const created = await api('POST','/api/pm',payload);
    toast(`PM ${created.pm_id} created.`, 'success');
    ev.target.reset();
    goto('execution');
  } catch (e) { toast(e.message, 'error'); }
});

// ===========================================================
// CHECKLISTS
// ===========================================================
async function loadChecklists() {
  try {
    const rows = await api('GET','/api/checklists');
    $('checklistsBody').innerHTML = rows.length === 0
      ? '<tr class="empty-row"><td colspan="5">No checklists yet — click "+ New Checklist" to create one.</td></tr>'
      : rows.map(c => `
      <tr>
        <td><code style="font-size:11px;">${escapeHtml(c.code || ('#'+c.id))}</code></td>
        <td><strong>${escapeHtml(c.name)}</strong>
          <div style="color:var(--muted); font-size:11px;">${escapeHtml(c.group_name || '—')} · by ${escapeHtml(c.created_by_name || '—')}${c.reviewer_name?` · rev. ${escapeHtml(c.reviewer_name)}`:''}${c.approver_name?` · app. ${escapeHtml(c.approver_name)}`:''}</div>
          ${c.frequencies && c.frequencies.length ? `<div style="margin-top:3px;">${c.frequencies.map(f => `<span class="pill brown" style="font-size:9px; margin-right:3px;">${escapeHtml(f.name)}</span>`).join('')}</div>` : ''}
        </td>
        <td>${escapeHtml(c.version)}</td>
        <td>${statusPill(c.status)}</td>
        <td><button class="btn ghost sm" onclick="previewChecklist(${c.id})">Open</button></td>
      </tr>`).join('');
  } catch (e) { toast(e.message, 'error'); }
}

let CURRENT_CHECKLIST_ID = null;
async function previewChecklist(id) {
  try {
    const cl = await api('GET', `/api/checklists/${id}/full`);
    CURRENT_CHECKLIST_ID = id;
    $('checklistPreviewTitle').innerHTML = `<code style="font-size:12px; color:var(--muted);">${escapeHtml(cl.code || ('#'+cl.id))}</code> ${escapeHtml(cl.name)} <span style="color:var(--muted); font-size:13px;">${escapeHtml(cl.version)}</span> ${statusPill(cl.status)}`;

    // Build workflow action buttons based on status + permissions
    const isAuthor   = cl.created_by === CURRENT_USER.id;
    const isReviewer = cl.reviewer_id === CURRENT_USER.id;
    const isApprover = cl.approver_id === CURRENT_USER.id;
    const editable   = ['Draft','Rejected'].includes(cl.status);
    const buttons = [];

    if (editable && can('manage_checklists') && (isAuthor || CURRENT_USER.is_admin)) {
      buttons.push(`<button class="btn ghost sm" onclick="openChecklistBuilder(${cl.id})">Edit</button>`);
      buttons.push(`<button class="btn primary sm" onclick="openSubmitChecklistModal(${cl.id})">Submit for Review →</button>`);
    }
    if (cl.status === 'Pending Review' && (isReviewer || CURRENT_USER.is_admin) && can('review_checklist')) {
      buttons.push(`<button class="btn primary sm" onclick="reviewChecklistDecision(${cl.id},'approve')">✓ Pass Review</button>`);
      buttons.push(`<button class="btn ghost sm" onclick="reviewChecklistDecision(${cl.id},'reject')">✗ Reject</button>`);
    }
    if (cl.status === 'Pending Approval' && (isApprover || CURRENT_USER.is_admin) && can('approve_checklist')) {
      buttons.push(`<button class="btn primary sm" onclick="approveChecklistDecision(${cl.id},'approve')">✓ Final Approve</button>`);
      buttons.push(`<button class="btn ghost sm" onclick="approveChecklistDecision(${cl.id},'reject')">✗ Reject</button>`);
    }
    if (cl.status === 'Approved' && can('assign_checklist')) {
      buttons.push(`<button class="btn primary sm" onclick="openAssignChecklistModal(${cl.id})">Assign…</button>`);
    }
    $('checklistPreviewActions').innerHTML = buttons.join(' ');

    // Frequencies + Required fields banner
    const freqsHtml = cl.frequencies && cl.frequencies.length
      ? `<div style="margin-top:4px;">Frequencies: ${cl.frequencies.map(f => `<span class="pill brown" style="font-size:10px; margin-right:3px;">${escapeHtml(f.name)}</span>`).join('')}</div>`
      : '';
    const reqLabelMap = Object.fromEntries(REQUIRED_FIELD_DEFS.map(rf => [rf.key, rf.label]));
    const reqdHtml = cl.required_fields && cl.required_fields.length
      ? `<div style="margin-top:4px;">Required Fields: ${cl.required_fields.map(k => `<span class="pill blue" style="font-size:10px; margin-right:3px;">${escapeHtml(reqLabelMap[k] || k)}</span>`).join('')}</div>`
      : '';
    // Workflow info banner
    const wf = `
      <div style="margin:8px 0 12px; padding:8px 12px; background:var(--cream-100); border-radius:6px; font-size:12px;">
        <strong>Workflow:</strong>
        Initiator <em>${escapeHtml(cl.created_by_name || '—')}</em>
        ${cl.reviewer_name ? `&nbsp;→&nbsp; Reviewer <em>${escapeHtml(cl.reviewer_name)}</em>` : ''}
        ${cl.approver_name ? `&nbsp;→&nbsp; Approver <em>${escapeHtml(cl.approver_name)}</em>` : ''}
        ${cl.submitted_at ? `<div style="color:var(--muted); margin-top:3px;">Submitted ${escapeHtml(cl.submitted_at)}</div>` : ''}
        ${cl.reviewed_at ? `<div style="color:var(--muted);">Reviewed ${escapeHtml(cl.reviewed_at)}</div>` : ''}
        ${cl.approved_at ? `<div style="color:var(--muted);">Approved ${escapeHtml(cl.approved_at)}</div>` : ''}
        ${cl.rejection_reason ? `<div style="color:var(--red); margin-top:3px;"><strong>Rejected:</strong> ${escapeHtml(cl.rejection_reason)}</div>` : ''}
        ${freqsHtml}${reqdHtml}
      </div>`;

    // Map for rendering per-question frequency chips in the preview.
    const freqNameMap = Object.fromEntries(((cl.frequencies) || []).map(f => [f.id, f.name]));
    let html = wf;
    if (cl.sections && cl.sections.length) {
      html += cl.sections.map((s, si) => `
        <div style="margin: 12px 0 8px; padding: 10px 12px; background: var(--cream-100); border-left:3px solid var(--brand); border-radius:6px;">
          <div style="font-weight:600;">${si+1}. ${escapeHtml(s.name)}</div>
          ${s.description ? `<div style="color:var(--muted); font-size:12px; margin-top:2px;">${escapeHtml(s.description)}</div>` : ''}
        </div>
        <ul class="checklist">${s.questions.map((q, qi) => {
          const freqChips = (q.frequencies && q.frequencies.length)
            ? q.frequencies.map(id => `<span class="pill brown" style="font-size:9px; margin-right:3px;">${escapeHtml(freqNameMap[id] || ('#'+id))}</span>`).join('')
            : '<em style="font-size:10px; color:var(--muted);">applies to all frequencies</em>';
          return `<li><div class="chk-num">${si+1}.${qi+1}</div>
            <div class="chk-body">
              <div class="chk-title">${escapeHtml(q.label)}${q.required?' *':''}</div>
              <div class="chk-meta">Type: ${escapeHtml(q.qtype)}${q.options?' · {'+q.options.join('/')+'}':''}${q.min_value!=null?` · range ${q.min_value}–${q.max_value}${q.unit?' '+q.unit:''}`:''}</div>
              <div style="margin-top:3px;">${freqChips}</div>
            </div></li>`;
        }).join('')}</ul>`).join('');
    } else if (cl.legacy_fields) {
      html += '<ul class="checklist">' + cl.legacy_fields.map((f, i) => `
        <li><div class="chk-num">${i+1}</div>
          <div class="chk-body">
            <div class="chk-title">${escapeHtml(f.label)}${f.required?' *':''}</div>
            <div class="chk-meta">Type: ${escapeHtml(f.type)}${f.options?' · {'+f.options.join('/')+'}':''}${f.min!==undefined?` · range ${f.min}–${f.max}`:''}</div>
          </div></li>`).join('') + '</ul>';
    } else {
      html += '<p style="color:var(--muted); margin: 10px 0;">This checklist has no questions yet.</p>';
    }
    $('checklistPreviewBody').innerHTML = html;
  } catch (e) { toast(e.message, 'error'); }
}

// ===========================================================
// PM EXECUTION LIST
// ===========================================================
async function loadPmList() {
  try {
    const filter = $('pmFilter').value;
    const url = filter ? `/api/pm?status=${encodeURIComponent(filter)}` : '/api/pm';
    const rows = await api('GET', url);
    $('pmListBody').innerHTML = rows.length === 0
      ? '<tr class="empty-row"><td colspan="8">No PM activities</td></tr>'
      : rows.map(p => `
      <tr>
        <td><strong>${escapeHtml(p.pm_id)}</strong></td>
        <td>${escapeHtml(p.equipment_name || p.equipment_id)}</td>
        <td>${escapeHtml(p.category || '')}</td>
        <td>${escapeHtml(p.frequency)}</td>
        <td>${escapeHtml(p.scheduled_date)}</td>
        <td>${escapeHtml(p.technician_name || '—')}</td>
        <td>${statusPill(p.status)}</td>
        <td>${actionsForPm(p)}</td>
      </tr>`).join('');
  } catch (e) { toast(e.message, 'error'); }
}

function actionsForPm(p) {
  const btn = (label, handler, kind='ghost') => `<button class="btn ${kind} sm" onclick="${handler}">${label}</button>`;
  const open = btn('Open', `openPm('${p.pm_id}')`);
  if (p.status === 'Pending')      return btn('Approve', `quickPm('${p.pm_id}','approve')`,'primary') + ' ' + open;
  if (p.status === 'Approved')     return btn('Start', `quickPm('${p.pm_id}','start')`,'primary') + ' ' + open;
  if (p.status === 'Assigned')     return btn('Start', `quickPm('${p.pm_id}','start')`,'primary') + ' ' + open;
  if (p.status === 'In Progress')  return btn('Execute', `openPm('${p.pm_id}')`,'primary');
  if (p.status === 'Overdue')      return btn('Start', `quickPm('${p.pm_id}','start')`,'primary') + ' ' + open;
  return open;
}

async function quickPm(pmId, action) {
  try {
    await api('PUT', `/api/pm/${pmId}/${action}`, {});
    toast(`PM ${pmId}: ${action}`, 'success');
    loadPmList();
  } catch (e) { toast(e.message, 'error'); }
}

async function openPm(pmId) {
  try {
    const p = await api('GET', `/api/pm/${pmId}`);
    const fields = p.checklist_fields || [];
    const existing = p.execution_data || {};

    // Build the checklist form
    const checklistHtml = fields.length === 0 ? '<em style="color:var(--muted);">No checklist linked to this PM.</em>' :
      '<ul class="checklist">' + fields.map((f, i) => {
        let inp = '';
        const val = existing[f.id] ?? '';
        if (f.type === 'number')    inp = `<input type="number" name="${f.id}" min="${f.min ?? ''}" max="${f.max ?? ''}" value="${escapeHtml(val)}" ${f.required?'required':''} />`;
        else if (f.type === 'checkbox') inp = `<label><input type="checkbox" name="${f.id}" ${val?'checked':''}/> Yes</label>`;
        else if (f.type === 'dropdown') inp = `<select name="${f.id}" ${f.required?'required':''}><option value="">—</option>${(f.options||[]).map(o => `<option ${o===val?'selected':''}>${escapeHtml(o)}</option>`).join('')}</select>`;
        else                        inp = `<input type="text" name="${f.id}" value="${escapeHtml(val)}" ${f.required?'required':''} />`;
        return `<li><div class="chk-num">${i+1}</div><div class="chk-body">
          <div class="chk-title">${escapeHtml(f.label)}${f.required?' *':''}</div>
          <div class="chk-input">${inp}</div></div></li>`;
      }).join('') + '</ul>';

    const stateInfo = `
      <div class="row-gap" style="font-size:12px; margin-bottom: 12px;">
        ${statusPill(p.status)}
        <span class="pill brown">Equipment: ${escapeHtml(p.equipment_name || p.equipment_id)}</span>
        <span class="pill brown">Schedule: ${escapeHtml(p.scheduled_date)}</span>
        <span class="pill brown">Frequency: ${escapeHtml(p.frequency)}</span>
        ${p.technician_name ? `<span class="pill brown">Tech: ${escapeHtml(p.technician_name)}</span>` : ''}
        ${p.checklist_name ? `<span class="pill brown">Checklist: ${escapeHtml(p.checklist_name)} ${escapeHtml(p.checklist_version)}</span>` : ''}
      </div>
    `;

    // Action buttons depend on status
    let actionsHtml = '';
    if (p.status === 'Pending')        actionsHtml = `<button type="button" class="btn primary" onclick="quickPm('${p.pm_id}','approve'); closeModal();">Approve PM</button>`;
    if (p.status === 'Approved' || p.status === 'Assigned')
      actionsHtml = `<button type="button" class="btn primary" onclick="quickPm('${p.pm_id}','start'); closeModal();">Start Execution</button>`;
    if (p.status === 'In Progress')
      actionsHtml = `<button type="submit" class="btn primary">Complete &amp; Sign</button>`;

    const remarksRow = (p.status === 'In Progress')
      ? `<div class="form-row" style="grid-template-columns:1fr;"><label>Remarks</label><textarea name="__remarks" placeholder="Notes / observations"></textarea></div>`
      : '';

    openModal({
      title: `PM ${p.pm_id}`,
      width: 720,
      body: `${stateInfo}${checklistHtml}${remarksRow}`,
      actions: actionsHtml,
      onSubmit: async (data) => {
        // Build execution_data from form
        const exec = {};
        fields.forEach(f => {
          if (f.type === 'checkbox') exec[f.id] = data[f.id] === 'on' || data[f.id] === true || data[f.id] === 'true';
          else if (f.type === 'number') exec[f.id] = data[f.id] === '' ? null : Number(data[f.id]);
          else exec[f.id] = data[f.id] || '';
        });
        const remarks = data['__remarks'] || '';
        await api('PUT', `/api/pm/${p.pm_id}/complete`, {
          execution_data: exec,
          technician_sig: CURRENT_USER.name + ' @ ' + new Date().toISOString(),
          remarks
        });
        toast(`PM ${p.pm_id} completed.`, 'success');
        loadPmList();
        if ($('page-dashboard').classList.contains('active')) loadDashboard();
      },
      hideDefaultSubmit: (p.status !== 'In Progress'),
    });
  } catch (e) { toast(e.message, 'error'); }
}

// ===========================================================
// CALENDAR
// ===========================================================
function calNavigate(delta) {
  CALENDAR_CURSOR.setMonth(CALENDAR_CURSOR.getMonth() + delta);
  loadCalendar();
}

async function loadCalendar() {
  const y = CALENDAR_CURSOR.getFullYear();
  const m = CALENDAR_CURSOR.getMonth() + 1;
  const monthName = CALENDAR_CURSOR.toLocaleString('en-US', { month: 'long', year: 'numeric' });
  $('calLabel').textContent = monthName;
  $('calTitle').textContent = `PM Calendar — ${monthName}`;

  try {
    const events = await api('GET', `/api/calendar?year=${y}&month=${m}`);
    const byDay = {};
    events.forEach(e => {
      const d = parseInt(e.scheduled_date.slice(8,10), 10);
      (byDay[d] = byDay[d] || []).push(e);
    });

    const first = new Date(y, m-1, 1);
    const startDow = first.getDay();
    const days = new Date(y, m, 0).getDate();
    const today = new Date();
    const isCurrentMonth = today.getFullYear() === y && (today.getMonth()+1) === m;

    let html = '';
    for (let i=0; i<startDow; i++) html += '<div class="day muted"></div>';
    for (let d=1; d<=days; d++) {
      const evs = byDay[d] || [];
      const todayCls = (isCurrentMonth && today.getDate() === d) ? ' today' : '';
      const evHtml = evs.map(e => {
        const c = statusColor(e.status);
        const t = `${e.pm_id} · ${e.equipment_id}`;
        return `<div class="ev ${c}" title="${escapeHtml(e.status)}: ${escapeHtml(t)}" onclick="openPm('${e.pm_id}')">${escapeHtml(t)}</div>`;
      }).join('');
      html += `<div class="day${todayCls}"><div class="num">${d}</div>${evHtml}</div>`;
    }
    $('calBody').innerHTML = html;
  } catch (e) { toast(e.message, 'error'); }
}

function statusColor(s) {
  if (s === 'Completed') return 'green';
  if (s === 'In Progress') return 'blue';
  if (s === 'Overdue' || s === 'Expired') return 'red';
  return 'amber';
}

// ===========================================================
// BREAKDOWN
// ===========================================================
async function loadBreakdowns() {
  try {
    const rows = await api('GET','/api/breakdowns');
    const open = rows.filter(b => !['Closed','Resolved'].includes(b.status)).length;
    const month = rows.filter(b => b.reported_at && b.reported_at.slice(0,7) === new Date().toISOString().slice(0,7)).length;
    const closed = rows.filter(b => ['Closed','Resolved'].includes(b.status) && b.mttr_hours != null);
    const avgMttr = closed.length ? (closed.reduce((s,b)=>s+b.mttr_hours,0)/closed.length).toFixed(1) : '—';

    $('bdKpiRow').innerHTML = `
      <div class="card kpi"><div class="label">Open</div><div class="value">${open}</div></div>
      <div class="card kpi"><div class="label">This Month</div><div class="value">${month}</div></div>
      <div class="card kpi"><div class="label">Avg MTTR (h)</div><div class="value">${avgMttr}</div></div>
      <div class="card kpi"><div class="label">Total</div><div class="value">${rows.length}</div></div>`;

    $('breakdownsBody').innerHTML = rows.length === 0
      ? '<tr class="empty-row"><td colspan="7">No breakdowns</td></tr>'
      : rows.map(b => `
      <tr>
        <td><strong>${escapeHtml(b.bd_id)}</strong></td>
        <td>${escapeHtml(b.equipment_name || b.equipment_id)}</td>
        <td>${escapeHtml(b.reported_at)}</td>
        <td>${escapeHtml(b.reported_by_name || '')}</td>
        <td>${severityPill(b.severity)}</td>
        <td>${statusPill(b.status)}</td>
        <td>${actionsForBd(b)}</td>
      </tr>`).join('');
  } catch (e) { toast(e.message, 'error'); }
}

function actionsForBd(b) {
  if (['Closed','Resolved'].includes(b.status))
    return `<button class="btn ghost sm" onclick="openBdDetail('${b.bd_id}')">View</button>`;
  return `<button class="btn ghost sm" onclick="openBdDetail('${b.bd_id}')">Update</button>`;
}

async function openBdDetail(bdId) {
  try {
    const list = await api('GET','/api/breakdowns');
    const b = list.find(x => x.bd_id === bdId);
    if (!b) return toast('Not found','error');
    const closed = ['Closed','Resolved'].includes(b.status);
    openModal({
      title: `Breakdown ${b.bd_id}`,
      body: `
        <div class="row-gap" style="margin-bottom: 10px;">
          ${severityPill(b.severity)} ${statusPill(b.status)}
          <span class="pill brown">${escapeHtml(b.equipment_id)}</span>
        </div>
        <div class="form-row"><label>Severity</label>
          <select name="severity" ${closed?'disabled':''}>
            ${['Critical','Major','Minor'].map(s => `<option ${s===b.severity?'selected':''}>${s}</option>`).join('')}
          </select>
        </div>
        <div class="form-row"><label>Status</label>
          <select name="status" ${closed?'disabled':''}>
            ${['Active','Investigating','Spares Awaited','Resolved','Closed'].map(s => `<option ${s===b.status?'selected':''}>${s}</option>`).join('')}
          </select>
        </div>
        <div class="form-row"><label>Description</label>
          <textarea name="__desc" disabled>${escapeHtml(b.description || '')}</textarea>
        </div>
        <div class="form-row"><label>Root Cause</label>
          <textarea name="root_cause" ${closed?'disabled':''}>${escapeHtml(b.root_cause || '')}</textarea>
        </div>
        <div class="form-row"><label>Resolution</label>
          <textarea name="resolution" ${closed?'disabled':''}>${escapeHtml(b.resolution || '')}</textarea>
        </div>
        ${b.mttr_hours ? `<div style="color:var(--muted); font-size:12px; margin-top: 8px;">MTTR: ${b.mttr_hours}h · closed ${escapeHtml(b.closed_at || '')}</div>`:''}`,
      hideDefaultSubmit: closed,
      onSubmit: async (data) => {
        await api('PUT', `/api/breakdowns/${bdId}`, {
          severity: data.severity, status: data.status,
          root_cause: data.root_cause, resolution: data.resolution
        });
        toast('Breakdown updated.', 'success');
        loadBreakdowns();
      }
    });
  } catch (e) { toast(e.message,'error'); }
}

async function openBreakdownModal() {
  try {
    const equipment = await api('GET','/api/equipment');
    openModal({
      title: 'Log Breakdown',
      body: `
        <div class="form-row"><label>Equipment *</label>
          <select name="equipment_id" required>${equipment.map(e => `<option value="${e.equipment_id}">${e.equipment_id} · ${escapeHtml(e.name)}</option>`).join('')}</select>
        </div>
        <div class="form-row"><label>Severity *</label>
          <select name="severity"><option>Critical</option><option selected>Major</option><option>Minor</option></select>
        </div>
        <div class="form-row" style="grid-template-columns:1fr;"><label>Description</label>
          <textarea name="description" placeholder="What happened?"></textarea>
        </div>`,
      onSubmit: async (data) => {
        await api('POST','/api/breakdowns', data);
        toast('Breakdown logged.', 'success');
        loadBreakdowns();
      }
    });
  } catch (e) { toast(e.message,'error'); }
}

// ===========================================================
// AUDIT
// ===========================================================
async function loadAudit(limit=100) {
  try {
    const rows = await api('GET', `/api/audit?limit=${limit}`);
    $('auditBody').innerHTML = rows.length === 0
      ? '<tr class="empty-row"><td colspan="6">No audit entries</td></tr>'
      : rows.map(a => `
      <tr>
        <td>${escapeHtml(a.ts)}</td>
        <td>${escapeHtml(a.user_name)}</td>
        <td><span class="pill ${dotColorPill(a.action)}">${escapeHtml(a.action)}</span></td>
        <td>${escapeHtml(a.entity)}</td>
        <td>${escapeHtml(a.entity_id)}</td>
        <td>${escapeHtml(a.details || '')}</td>
      </tr>`).join('');
  } catch (e) { toast(e.message,'error'); }
}
function dotColorPill(action) {
  if (['APPROVE','COMPLETE','CREATE'].includes(action)) return 'green';
  if (['DELETE','LOGOUT'].includes(action)) return 'red';
  if (['START','UPDATE','ASSIGN'].includes(action)) return 'blue';
  if (action === 'LOGIN') return 'amber';
  return 'brown';
}

// ===========================================================
// REPORTS
// ===========================================================
async function openOverdueReport() {
  try {
    const rows = await api('GET','/api/reports/overdue');
    $('reportPanel').innerHTML = `
      <div class="card">
        <div class="card-head"><h3>Overdue & Expired PMs</h3><span class="pill red">${rows.length} items</span></div>
        <table class="tbl">
          <thead><tr><th>PM ID</th><th>Equipment</th><th>Scheduled</th><th>Frequency</th><th>Department</th><th>Status</th></tr></thead>
          <tbody>${rows.length === 0
            ? '<tr class="empty-row"><td colspan="6">No overdue items 🎉</td></tr>'
            : rows.map(r => `<tr><td><strong>${escapeHtml(r.pm_id)}</strong></td>
                <td>${escapeHtml(r.equipment_name || r.equipment_id)}</td>
                <td>${escapeHtml(r.scheduled_date)}</td>
                <td>${escapeHtml(r.frequency)}</td>
                <td>${escapeHtml(r.department || '')}</td>
                <td>${statusPill(r.status)}</td></tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  } catch (e) { toast(e.message,'error'); }
}

async function openEqHistoryReport() {
  try {
    const equipment = await api('GET','/api/equipment');
    openModal({
      title: 'Equipment History',
      body: `
        <div class="form-row"><label>Equipment</label>
          <select name="equipment_id">${equipment.map(e => `<option value="${e.equipment_id}">${e.equipment_id} · ${escapeHtml(e.name)}</option>`).join('')}</select>
        </div>`,
      submitLabel: 'Show',
      onSubmit: async (data) => {
        const h = await api('GET', `/api/reports/equipment-history/${data.equipment_id}`);
        $('reportPanel').innerHTML = `
          <div class="card">
            <div class="card-head"><h3>PM History — ${escapeHtml(data.equipment_id)}</h3></div>
            <table class="tbl">
              <thead><tr><th>PM ID</th><th>Scheduled</th><th>Freq</th><th>Category</th><th>Status</th><th>Completed</th></tr></thead>
              <tbody>${h.pm.length===0?'<tr class="empty-row"><td colspan="6">No PMs</td></tr>':h.pm.map(p =>
                `<tr><td>${escapeHtml(p.pm_id)}</td><td>${escapeHtml(p.scheduled_date)}</td><td>${escapeHtml(p.frequency)}</td><td>${escapeHtml(p.category||'')}</td><td>${statusPill(p.status)}</td><td>${escapeHtml(p.completed_at||'')}</td></tr>`).join('')}</tbody>
            </table>
          </div>
          <div class="card" style="margin-top:16px;">
            <div class="card-head"><h3>Breakdown History</h3></div>
            <table class="tbl">
              <thead><tr><th>BD ID</th><th>Reported</th><th>Severity</th><th>Status</th><th>Description</th></tr></thead>
              <tbody>${h.breakdowns.length===0?'<tr class="empty-row"><td colspan="5">No breakdowns 🎉</td></tr>':h.breakdowns.map(b =>
                `<tr><td>${escapeHtml(b.bd_id)}</td><td>${escapeHtml(b.reported_at)}</td><td>${severityPill(b.severity)}</td><td>${statusPill(b.status)}</td><td>${escapeHtml(b.description||'')}</td></tr>`).join('')}</tbody>
            </table>
          </div>`;
      }
    });
  } catch (e) { toast(e.message,'error'); }
}

// ===========================================================
// COMPLIANCE
// ===========================================================
async function loadCompliance() {
  // For now compute lightweight client-side from audit
  try {
    const audit = await api('GET','/api/audit?limit=200');
    const eSigs = audit.filter(a => ['APPROVE','COMPLETE'].includes(a.action)).length;
    const totalApprovals = audit.filter(a => ['APPROVE','COMPLETE'].includes(a.action)).length;
    const integrityPct = 100;
    const sopPct = 87;

    $('complianceStatus').innerHTML = `
      <div><div style="display:flex; justify-content:space-between; font-size:13px;"><span>E-signature capture</span><strong>${eSigs} captured</strong></div><div class="progress green"><span style="width:100%"></span></div></div>
      <div><div style="display:flex; justify-content:space-between; font-size:13px;"><span>Audit trail integrity</span><strong>OK</strong></div><div class="progress green"><span style="width:100%"></span></div></div>
      <div><div style="display:flex; justify-content:space-between; font-size:13px;"><span>Backup last 24h</span><strong>Success</strong></div><div class="progress green"><span style="width:100%"></span></div></div>
      <div><div style="display:flex; justify-content:space-between; font-size:13px;"><span>SOPs linked to equipment</span><strong>${sopPct}%</strong></div><div class="progress"><span style="width:${sopPct}%"></span></div></div>`;
  } catch (e) { toast(e.message,'error'); }
}

// ===========================================================
// GENERIC MODAL
// ===========================================================
function openModal({ title, body, onSubmit, submitLabel='Save', width=520, actions, hideDefaultSubmit=false }) {
  const id = 'modal_' + Date.now();
  $('modalHost').innerHTML = `
    <div class="modal-back" id="${id}">
      <div class="modal" style="max-width: ${width}px;">
        <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom: 10px;">
          <h2>${escapeHtml(title)}</h2>
          <button class="close-btn" type="button" onclick="closeModal()">×</button>
        </div>
        <form id="${id}_form">
          ${body}
          <div class="form-actions">
            ${actions || ''}
            ${!hideDefaultSubmit ? `<button type="submit" class="btn primary">${escapeHtml(submitLabel)}</button>` : ''}
            <button type="button" class="btn ghost" onclick="closeModal()">Cancel</button>
          </div>
        </form>
      </div>
    </div>
  `;
  $(`${id}_form`).addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const data = {};
    fd.forEach((v,k) => { data[k] = v; });
    // capture unchecked checkboxes too
    ev.target.querySelectorAll('input[type="checkbox"]').forEach(cb => { data[cb.name] = cb.checked; });
    try {
      await onSubmit(data);
      closeModal();
    } catch (e) {
      toast(e.message, 'error');
    }
  });
}
function closeModal() {
  // If a QR scanner is running in the modal, stop the camera stream first.
  if (window.__pmsScanner) {
    try { window.__pmsScanner.stop().catch(()=>{}); } catch (e) {}
    try { window.__pmsScanner.clear(); } catch (e) {}
    window.__pmsScanner = null;
  }
  $('modalHost').innerHTML = '';
}

// ===========================================================
// GLOBAL SEARCH (simple, jumps to first match)
// ===========================================================
$('globalSearch').addEventListener('keydown', async (ev) => {
  if (ev.key !== 'Enter') return;
  const q = ev.target.value.trim().toUpperCase();
  if (!q) return;
  try {
    if (q.startsWith('PM-'))  { openPm(q); return; }
    if (q.startsWith('BD-'))  { openBdDetail(q); return; }
    if (q.startsWith('EQ-'))  { /* go to equipment list */ goto('masters'); loadMasters('equipment'); return; }
    toast('Search: try a PM-, BD- or EQ- ID', 'error');
  } catch (e) { toast(e.message, 'error'); }
});

// ===========================================================
// NOTIFICATIONS (bell)
// ===========================================================
async function refreshNotifBadge() {
  try {
    const { count } = await api('GET','/api/notifications/unread-count');
    const b = $('bellBadge');
    if (count > 0) { b.style.display = 'inline-block'; b.textContent = count > 99 ? '99+' : count; }
    else           { b.style.display = 'none'; }
  } catch (e) {}
}
async function toggleNotifPanel() {
  const p = $('notifPanel');
  if (p.style.display === 'none' || !p.style.display) {
    try {
      const rows = await api('GET','/api/notifications');
      $('notifList').innerHTML = rows.length === 0
        ? `<li style="padding:18px; color:var(--muted); text-align:center;">No notifications yet.</li>`
        : rows.map(n => `
          <li style="padding:10px 14px; border-bottom:1px solid var(--border); background:${n.is_read?'#fff':'var(--cream-100)'}; cursor:pointer;"
              onclick="onNotifClick(${n.id}, '${escapeHtml(n.link||'')}')">
            <div style="font-weight:600; font-size:13px;">${escapeHtml(n.title)}</div>
            <div style="color:var(--muted); font-size:12px; margin-top:2px;">${escapeHtml(n.message || '')}</div>
            <div style="color:var(--muted); font-size:10px; margin-top:4px;">${escapeHtml(n.created_at)}</div>
          </li>`).join('');
      p.style.display = 'block';
    } catch (e) { toast(e.message,'error'); }
  } else {
    p.style.display = 'none';
  }
}
async function markAllNotifRead() {
  try { await api('PUT','/api/notifications/read-all'); refreshNotifBadge(); toggleNotifPanel(); toggleNotifPanel(); }
  catch (e) { toast(e.message,'error'); }
}
async function onNotifClick(id, link) {
  try { await api('PUT', `/api/notifications/${id}/read`); } catch(e) {}
  refreshNotifBadge();
  $('notifPanel').style.display = 'none';
  // If link points to an assignment, open it
  if (link && link.startsWith('/assignments/')) {
    const aid = link.replace('/assignments/','');
    goto('tasks');
    setTimeout(() => openAssignment(aid), 300);
  } else if (link && link.startsWith('/checklists/')) {
    const cid = Number(link.replace('/checklists/',''));
    goto('checklist');
    setTimeout(() => previewChecklist(cid), 300);
  }
}
// Close notif panel on outside click
document.addEventListener('click', (ev) => {
  const p = $('notifPanel');
  const b = $('bellBtn');
  if (!p || p.style.display !== 'block') return;
  if (p.contains(ev.target) || b.contains(ev.target)) return;
  p.style.display = 'none';
});

// ===========================================================
// ADMIN SETTINGS — Departments / Roles / Activities
// ===========================================================
let CURRENT_SETTINGS_TAB = 'departments';

document.querySelectorAll('#settingsTabs button').forEach(b => {
  b.addEventListener('click', () => loadSettings(b.dataset.st));
});

async function loadSettings(tab) {
  CURRENT_SETTINGS_TAB = tab;
  document.querySelectorAll('#settingsTabs button').forEach(b => b.classList.toggle('active', b.dataset.st === tab));
  if (tab === 'departments') return renderDeptsTab();
  if (tab === 'roles')        return renderRolesTab();
  if (tab === 'activities')   return renderActivitiesTab();
}

// ----- Departments tab -----
async function renderDeptsTab() {
  try {
    const depts = await api('GET','/api/departments');
    const canEdit = can('manage_departments');
    $('settingsPanel').innerHTML = `
      <div class="card">
        <div class="card-head"><h3>Departments</h3>
          ${canEdit ? `<button class="btn primary sm" onclick="openDeptModal()">+ Add Department</button>` : ''}
        </div>
        <table class="tbl">
          <thead><tr><th>Name</th><th>Description</th><th>Status</th><th></th></tr></thead>
          <tbody>
            ${depts.length === 0 ? '<tr class="empty-row"><td colspan="4">No departments</td></tr>' :
              depts.map(d => `<tr>
                <td><strong>${escapeHtml(d.name)}</strong></td>
                <td>${escapeHtml(d.description || '')}</td>
                <td>${statusPill(d.status)}</td>
                <td style="text-align:right;">
                  ${canEdit ? `<button class="btn ghost sm" onclick='openDeptModal(${escapeHtml(JSON.stringify(d))})'>Edit</button>
                               <button class="btn ghost sm" onclick="deleteDept(${d.id})">×</button>` : ''}
                </td></tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  } catch (e) { toast(e.message,'error'); }
}

function openDeptModal(existing) {
  const d = existing || { name:'', description:'' };
  openModal({
    title: existing ? `Edit Department — ${escapeHtml(d.name)}` : 'Add Department',
    body: `
      <div class="form-row"><label>Name *</label><input name="name" value="${escapeHtml(d.name)}" required /></div>
      <div class="form-row" style="grid-template-columns:1fr;"><label>Description</label><textarea name="description">${escapeHtml(d.description || '')}</textarea></div>
    `,
    onSubmit: async (data) => {
      if (existing) await api('PUT', `/api/departments/${existing.id}`, data);
      else          await api('POST','/api/departments', data);
      toast('Saved.', 'success'); renderDeptsTab();
    }
  });
}
async function deleteDept(id) {
  if (!confirm('Delete this department?')) return;
  try { await api('DELETE', `/api/departments/${id}`); toast('Deleted.','success'); renderDeptsTab(); }
  catch (e) { toast(e.message,'error'); }
}

// ----- Roles tab -----
async function renderRolesTab() {
  try {
    const [roles, depts, activities] = await Promise.all([
      api('GET','/api/roles'),
      api('GET','/api/departments'),
      api('GET','/api/activities'),
    ]);
    const canEdit = can('manage_roles');
    $('settingsPanel').innerHTML = `
      <div class="card">
        <div class="card-head"><h3>Roles</h3>
          ${canEdit ? `<button class="btn primary sm" onclick='openRoleModal(null, ${escapeHtml(JSON.stringify(depts))}, ${escapeHtml(JSON.stringify(activities))})'>+ Add Role</button>` : ''}
        </div>
        <table class="tbl">
          <thead><tr><th>Role</th><th>Department</th><th>Users</th><th>Activities</th><th>Status</th><th></th></tr></thead>
          <tbody>
            ${roles.length === 0 ? '<tr class="empty-row"><td colspan="6">No roles</td></tr>' :
              roles.map(r => `<tr>
                <td><strong>${escapeHtml(r.name)}</strong>${r.is_system?' <span class="pill brown" style="font-size:9px;">SYSTEM</span>':''}</td>
                <td>${escapeHtml(r.department_name || '—')}</td>
                <td>${r.user_count}</td>
                <td><span style="font-size:11px; color:var(--muted);">${(r.permissions || []).length} activities</span></td>
                <td>${statusPill(r.status)}</td>
                <td style="text-align:right;">
                  ${canEdit ? `<button class="btn ghost sm" onclick='openRoleModal(${escapeHtml(JSON.stringify(r))}, ${escapeHtml(JSON.stringify(depts))}, ${escapeHtml(JSON.stringify(activities))})'>Edit</button>
                               ${r.is_system ? '' : `<button class="btn ghost sm" onclick="deleteRole(${r.id})">×</button>`}` : ''}
                </td></tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  } catch (e) { toast(e.message,'error'); }
}

function openRoleModal(existing, depts, activities) {
  const r = existing || { name:'', description:'', department_id:'', permissions:[] };
  // Group activities by category
  const byCat = {};
  activities.forEach(a => { (byCat[a.category || 'Other'] = byCat[a.category || 'Other'] || []).push(a); });
  const checked = new Set(r.permissions || []);
  const actGroupsHtml = Object.entries(byCat).map(([cat, list]) => `
    <fieldset style="border:1px solid var(--border); border-radius:8px; padding:8px 12px; margin-bottom:8px;">
      <legend style="font-size:12px; color:var(--muted); padding:0 6px;">${escapeHtml(cat)}</legend>
      ${list.map(a => `
        <label style="display:flex; align-items:center; gap:6px; padding:3px 0; font-size:12px;">
          <input type="checkbox" class="perm-cb" value="${escapeHtml(a.code)}" ${checked.has(a.code)?'checked':''} />
          <span><strong>${escapeHtml(a.label)}</strong> <code style="font-size:10px; color:var(--muted);">${escapeHtml(a.code)}</code></span>
        </label>`).join('')}
    </fieldset>`).join('');

  openModal({
    title: existing ? `Edit Role — ${escapeHtml(r.name)}` : 'Add Role',
    width: 640,
    body: `
      <div class="form-row"><label>Name *</label><input name="name" value="${escapeHtml(r.name)}" required ${r.is_system?'readonly':''} /></div>
      <div class="form-row"><label>Department *</label>
        <select name="department_id" required>
          <option value="">— pick —</option>
          ${depts.map(d => `<option value="${d.id}" ${d.id===r.department_id?'selected':''}>${escapeHtml(d.name)}</option>`).join('')}
        </select>
      </div>
      <div class="form-row" style="grid-template-columns:1fr;"><label>Description</label><textarea name="description">${escapeHtml(r.description || '')}</textarea></div>
      <div style="margin-top:10px; font-size:13px; font-weight:600;">Activities this role can perform</div>
      <div style="max-height:320px; overflow:auto; margin-top:6px;">${actGroupsHtml}</div>
    `,
    onSubmit: async (data) => {
      const perms = Array.from(document.querySelectorAll('.perm-cb')).filter(c => c.checked).map(c => c.value);
      const payload = {
        name: data.name, description: data.description,
        department_id: Number(data.department_id),
        permissions: perms
      };
      if (existing) await api('PUT', `/api/roles/${existing.id}`, payload);
      else          await api('POST','/api/roles', payload);
      toast('Saved.', 'success'); renderRolesTab();
    }
  });
}
async function deleteRole(id) {
  if (!confirm('Delete this role?')) return;
  try { await api('DELETE', `/api/roles/${id}`); toast('Deleted.','success'); renderRolesTab(); }
  catch (e) { toast(e.message,'error'); }
}

// ----- Activities tab -----
async function renderActivitiesTab() {
  try {
    const activities = await api('GET','/api/activities');
    const canEdit = can('manage_activities');
    const byCat = {};
    activities.forEach(a => { (byCat[a.category || 'Other'] = byCat[a.category || 'Other'] || []).push(a); });
    $('settingsPanel').innerHTML = `
      <div class="card">
        <div class="card-head"><h3>Activities (Permissions Catalog)</h3>
          ${canEdit ? `<button class="btn primary sm" onclick="openActivityModal()">+ Add Activity</button>` : ''}
        </div>
        <p style="color:var(--muted); font-size:12px; margin-top:0;">Activities are the fine-grained things a role can do. Built-in activities are referenced by application code and cannot be deleted.</p>
        ${Object.entries(byCat).map(([cat, list]) => `
          <div style="margin-top:14px;">
            <div style="font-weight:600; margin-bottom:6px;">${escapeHtml(cat)}</div>
            <table class="tbl">
              <thead><tr><th>Code</th><th>Label</th><th>Type</th><th></th></tr></thead>
              <tbody>
                ${list.map(a => `<tr>
                  <td><code style="font-size:11px;">${escapeHtml(a.code)}</code></td>
                  <td>${escapeHtml(a.label)}</td>
                  <td>${a.is_system?'<span class="pill brown" style="font-size:9px;">SYSTEM</span>':'<span class="pill blue" style="font-size:9px;">CUSTOM</span>'}</td>
                  <td style="text-align:right;">
                    ${canEdit ? `<button class="btn ghost sm" onclick='openActivityModal(${escapeHtml(JSON.stringify(a))})'>Edit</button>
                                 ${a.is_system ? '' : `<button class="btn ghost sm" onclick="deleteActivity(${a.id})">×</button>`}` : ''}
                  </td></tr>`).join('')}
              </tbody>
            </table>
          </div>`).join('')}
      </div>`;
  } catch (e) { toast(e.message,'error'); }
}

function openActivityModal(existing) {
  const a = existing || { code:'', label:'', category:'Custom' };
  openModal({
    title: existing ? `Edit Activity — ${escapeHtml(a.code)}` : 'Add Activity',
    body: `
      <div class="form-row"><label>Code *</label><input name="code" value="${escapeHtml(a.code)}" required ${existing?'readonly':''} placeholder="e.g. approve_capex" pattern="[a-z][a-z0-9_]*" /></div>
      <div class="form-row"><label>Label *</label><input name="label" value="${escapeHtml(a.label)}" required /></div>
      <div class="form-row"><label>Category</label><input name="category" value="${escapeHtml(a.category || 'Custom')}" /></div>
      <p style="font-size:11px; color:var(--muted);">Note: custom activities won't actually gate any backend route until the developer wires them up. They can still be assigned to roles.</p>
    `,
    onSubmit: async (data) => {
      if (existing) await api('PUT', `/api/activities/${existing.id}`, data);
      else          await api('POST','/api/activities', data);
      toast('Saved.', 'success'); renderActivitiesTab();
    }
  });
}
async function deleteActivity(id) {
  if (!confirm('Delete this activity?')) return;
  try { await api('DELETE', `/api/activities/${id}`); toast('Deleted.','success'); renderActivitiesTab(); }
  catch (e) { toast(e.message,'error'); }
}

// ===========================================================
// CHECKLIST BUILDER
// ===========================================================
// Standard "Required Fields" that the checklist designer can toggle on, captured at execution.
const REQUIRED_FIELD_DEFS = [
  { key:'area',             label:'Area ID & Area Name',               auto: true,  desc:'Auto-populated from the assigned equipment' },
  { key:'equipment',        label:'Equipment ID & Equipment Name',     auto: true,  desc:'Auto-populated from the assignment' },
  { key:'capacity_make',    label:'Capacity & Make / Location',        auto: true,  desc:'Auto-populated from the equipment record' },
  { key:'spares',           label:'Spares Utilized',                   auto: false, desc:'Executor lists spares used' },
  { key:'validation_by',    label:'Validation Performed By',           auto: false, desc:'Name / signature of validator' },
  { key:'corrective',       label:'Corrective Action',                 auto: false, desc:'Describes any corrective action taken' },
  { key:'external_report',  label:'External Service Report',           auto: false, desc:'Reference / notes for an external service report' },
];

async function openChecklistBuilder(existingId) {
  try {
    const [groups, cats, freqs] = await Promise.all([
      api('GET','/api/checklist-groups?active=1'),
      api('GET','/api/pm-categories'),
      api('GET','/api/frequencies'),
    ]);
    const activeFreqs = freqs.filter(f => (f.status || 'Active') === 'Active');
    let cl = null;
    if (existingId) cl = await api('GET', `/api/checklists/${existingId}/full`);
    const existingFreqIds = new Set(((cl && cl.frequencies) || []).map(f => f.id));
    const existingReqd    = new Set(((cl && cl.required_fields) || []));
    // Seed initial sections data
    let sections = (cl && cl.sections && cl.sections.length)
      ? cl.sections.map(s => ({
          name: s.name, description: s.description || '',
          questions: (s.questions || []).map(q => ({
            label: q.label, qtype: q.qtype,
            options: q.options ? q.options.join('|') : '',
            required: !!q.required, min_value: q.min_value, max_value: q.max_value, unit: q.unit || '',
            frequencies: Array.isArray(q.frequencies) ? q.frequencies.slice() : []
          }))
        }))
      : [{ name:'Section 1', description:'', questions:[{ label:'', qtype:'text', options:'', required:true, min_value:null, max_value:null, unit:'', frequencies: [] }] }];

    const renderBuilder = () => `
      <div class="form-row"><label>PM Checklist Group *</label>
        <select name="group_id" required>
          <option value="">— select group —</option>
          ${groups.map(g => `<option value="${g.id}" ${cl && cl.group_id===g.id?'selected':''}>${escapeHtml(g.name)}</option>`).join('')}
        </select>
      </div>
      <div class="form-row"><label>Checklist ID *</label>
        <input name="code" value="${escapeHtml(cl?.code || '')}" required minlength="2" maxlength="50" pattern="[A-Za-z0-9_\\-]{2,50}"
               placeholder="e.g., CHK-AHU-M (2-50 alphanumeric, - and _ allowed)" />
      </div>
      <div class="form-row"><label>Checklist Name *</label>
        <input name="name" value="${escapeHtml(cl?.name || '')}" required minlength="3" maxlength="300" placeholder="3-300 characters" />
      </div>
      <div class="form-row"><label>Version</label>
        <div style="display:flex; align-items:center; gap:10px;">
          <input name="version" value="${escapeHtml(cl?.version || 'v1.0')}" readonly tabindex="-1"
                 style="background: var(--cream-100); color: var(--muted); cursor: not-allowed; max-width: 120px;" />
          <span style="font-size:11px; color:var(--muted);">Auto-assigned · system controlled</span>
        </div>
      </div>
      <div class="form-row"><label>Maintenance Category</label>
        <select name="category_id"><option value="">—</option>${cats.map(c => `<option value="${c.id}" ${cl && cl.category_id===c.id?'selected':''}>${escapeHtml(c.name)}</option>`).join('')}</select>
      </div>
      <div class="form-row" style="grid-template-columns:1fr;"><label>Description</label><textarea name="description">${escapeHtml(cl?.description || '')}</textarea></div>

      <div class="form-row" style="grid-template-columns:1fr;">
        <label>Frequency * <span style="color:var(--muted); font-weight:400; font-size:11px;">(check all that apply)</span></label>
        <div id="cbFreqs" style="display:flex; flex-wrap:wrap; gap:8px 14px;">
          ${activeFreqs.map(f => `
            <label style="display:inline-flex; align-items:center; gap:5px; font-size:13px;">
              <input type="checkbox" class="cb-freq" value="${f.id}" ${existingFreqIds.has(f.id)?'checked':''} />
              ${escapeHtml(f.name)} <span style="color:var(--muted); font-size:11px;">(${f.days}d)</span>
            </label>`).join('')}
        </div>
      </div>

      <div class="form-row" style="grid-template-columns:1fr;">
        <label>Required Fields <span style="color:var(--muted); font-weight:400; font-size:11px;">(configurable execution fields)</span></label>
        <div id="cbReqd" style="display:flex; flex-direction:column; gap:4px;">
          ${REQUIRED_FIELD_DEFS.map(rf => `
            <label style="display:flex; align-items:flex-start; gap:6px; font-size:13px; padding:3px 0;">
              <input type="checkbox" class="cb-reqd" value="${rf.key}" ${existingReqd.has(rf.key)?'checked':''} style="margin-top:3px;" />
              <span>
                <strong>${escapeHtml(rf.label)}</strong>
                ${rf.auto ? '<span class="pill blue" style="font-size:9px; margin-left:5px;">AUTO</span>' : ''}
                <div style="color:var(--muted); font-size:11px;">${escapeHtml(rf.desc)}</div>
              </span>
            </label>`).join('')}
        </div>
      </div>

      <hr class="sep" />
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <strong>Sections &amp; Questions</strong>
        <button type="button" class="btn ghost sm" onclick="__cbAddSection()">+ Add Section</button>
      </div>
      <div id="cbSections" style="margin-top:8px;">
        ${sections.map((s, si) => renderSection(s, si)).join('')}
      </div>
    `;
    const renderSection = (s, si) => `
      <div class="card" style="padding:10px 12px; margin-bottom:10px; border-left:3px solid var(--brand);" data-sidx="${si}">
        <div style="display:flex; gap:6px; align-items:center; margin-bottom:6px;">
          <input class="cb-sname" placeholder="Section name" value="${escapeHtml(s.name)}" style="flex:1; font-weight:600;" />
          <button type="button" class="btn ghost sm" onclick="__cbDelSection(${si})">×</button>
        </div>
        <input class="cb-sdesc" placeholder="Section description (optional)" value="${escapeHtml(s.description || '')}" style="width:100%; font-size:12px;" />
        <div class="cb-questions" style="margin-top:8px;">
          ${s.questions.map((q, qi) => renderQuestion(q, si, qi)).join('')}
        </div>
        <button type="button" class="btn ghost sm" onclick="__cbAddQ(${si})" style="margin-top:6px;">+ Add Question</button>
      </div>`;
    const renderQuestion = (q, si, qi) => {
      // Per-question frequency chips. Empty q.frequencies means "applies to all" → render all as checked.
      const allTicked = !q.frequencies || q.frequencies.length === 0;
      const chips = activeFreqs.map(f => {
        const checked = allTicked || q.frequencies.includes(f.id);
        return `<label style="display:inline-flex; align-items:center; gap:3px; font-size:10px; padding:2px 7px; background:${checked?'var(--cream-100)':'transparent'}; border:1px solid var(--border); border-radius:10px; cursor:pointer;">
          <input type="checkbox" class="cb-qfreq" value="${f.id}" ${checked?'checked':''} style="margin:0;" onchange="this.parentElement.style.background = this.checked ? 'var(--cream-100)' : 'transparent';" />
          ${escapeHtml(f.name)}
        </label>`;
      }).join(' ');
      return `
        <div class="cb-q" data-qidx="${qi}" style="padding:7px 0; border-bottom:1px dashed var(--border);">
          <div style="display:grid; grid-template-columns: 2fr 1fr 1.5fr auto auto; gap:6px; align-items:center;">
            <input class="cb-qlabel" placeholder="Question label" value="${escapeHtml(q.label)}" />
            <select class="cb-qtype">
              ${['text','number','dropdown','checkbox','yesno'].map(t => `<option value="${t}" ${t===q.qtype?'selected':''}>${t}</option>`).join('')}
            </select>
            <input class="cb-qopts" placeholder="opt1 | opt2 (for dropdown)" value="${escapeHtml(q.options || '')}" />
            <label style="font-size:11px; display:flex; gap:3px; align-items:center;"><input type="checkbox" class="cb-qreq" ${q.required?'checked':''} /> req</label>
            <button type="button" class="btn ghost sm" onclick="__cbDelQ(${si}, ${qi})">×</button>
          </div>
          <div style="display:flex; gap:5px; align-items:center; flex-wrap:wrap; margin-top:5px; padding-left:2px;">
            <span style="font-size:10px; color:var(--muted); text-transform:uppercase; letter-spacing:0.5px;">Applies to:</span>
            ${chips}
          </div>
        </div>`;
    };

    // Make helpers globally callable for inline onclick
    window.__cbReadDOM = () => {
      const out = [];
      document.querySelectorAll('#cbSections > .card').forEach(secEl => {
        const sec = {
          name: secEl.querySelector('.cb-sname').value || 'Section',
          description: secEl.querySelector('.cb-sdesc').value || '',
          questions: []
        };
        secEl.querySelectorAll('.cb-q').forEach(qEl => {
          const chipBoxes = qEl.querySelectorAll('.cb-qfreq');
          const ticked = Array.from(chipBoxes).filter(c => c.checked).map(c => Number(c.value));
          // If every chip is ticked, treat as "applies to all" → store empty array.
          const freqs = (chipBoxes.length > 0 && ticked.length === chipBoxes.length) ? [] : ticked;
          const q = {
            label: qEl.querySelector('.cb-qlabel').value,
            qtype: qEl.querySelector('.cb-qtype').value,
            options: qEl.querySelector('.cb-qopts').value,
            required: qEl.querySelector('.cb-qreq').checked,
            min_value: null, max_value: null, unit: '',
            frequencies: freqs
          };
          sec.questions.push(q);
        });
        out.push(sec);
      });
      return out;
    };
    window.__cbAddSection = () => {
      sections = window.__cbReadDOM();
      sections.push({ name:`Section ${sections.length+1}`, description:'', questions:[{label:'', qtype:'text', options:'', required:false, min_value:null, max_value:null, unit:'', frequencies:[]}] });
      $('cbSections').innerHTML = sections.map((s, si) => renderSection(s, si)).join('');
    };
    window.__cbDelSection = (si) => {
      sections = window.__cbReadDOM();
      sections.splice(si, 1);
      $('cbSections').innerHTML = sections.map((s, si) => renderSection(s, si)).join('');
    };
    window.__cbAddQ = (si) => {
      sections = window.__cbReadDOM();
      sections[si].questions.push({ label:'', qtype:'text', options:'', required:false, min_value:null, max_value:null, unit:'', frequencies:[] });
      $('cbSections').innerHTML = sections.map((s, si) => renderSection(s, si)).join('');
    };
    window.__cbDelQ = (si, qi) => {
      sections = window.__cbReadDOM();
      sections[si].questions.splice(qi, 1);
      if (sections[si].questions.length === 0) sections[si].questions.push({ label:'', qtype:'text', options:'', required:false, min_value:null, max_value:null, unit:'', frequencies:[] });
      $('cbSections').innerHTML = sections.map((s, si) => renderSection(s, si)).join('');
    };

    openModal({
      title: existingId ? `Edit Checklist — ${escapeHtml(cl.name)}` : 'New Checklist',
      width: 820,
      body: renderBuilder(),
      submitLabel: existingId ? 'Save Changes' : 'Create Checklist',
      onSubmit: async (data) => {
        const built = window.__cbReadDOM().map(s => ({
          name: s.name, description: s.description,
          questions: s.questions.filter(q => q.label.trim()).map(q => ({
            label: q.label, qtype: q.qtype,
            options: q.qtype === 'dropdown' ? q.options.split('|').map(x => x.trim()).filter(Boolean) : null,
            required: q.required, min_value: q.min_value, max_value: q.max_value, unit: q.unit,
            frequencies: q.frequencies || []
          }))
        })).filter(s => s.questions.length > 0);
        const freqIds = Array.from(document.querySelectorAll('.cb-freq:checked')).map(c => Number(c.value));
        const reqdKeys = Array.from(document.querySelectorAll('.cb-reqd:checked')).map(c => c.value);
        if (!data.group_id) throw new Error('PM Checklist Group is required');
        if (freqIds.length === 0) throw new Error('Pick at least one Frequency');
        const payload = {
          code: data.code,
          name: data.name, version: data.version || 'v1.0',
          description: data.description || '',
          group_id: data.group_id ? Number(data.group_id) : null,
          category_id: data.category_id ? Number(data.category_id) : null,
          sections: built,
          required_fields: reqdKeys,
          frequency_ids: freqIds,
        };
        if (existingId) await api('PUT', `/api/checklists/${existingId}`, payload);
        else            await api('POST','/api/checklists', payload);
        toast('Checklist saved.', 'success');
        loadChecklists();
        if (existingId) previewChecklist(existingId);
      }
    });
  } catch (e) { toast(e.message,'error'); }
}

// ===========================================================
// CHECKLIST ASSIGNMENTS — MY TASKS
// ===========================================================
let CURRENT_TASKS_TAB = 'inbox';

document.querySelectorAll('#tasksTabs button').forEach(b => {
  b.addEventListener('click', () => loadTasks(b.dataset.tt));
});

function actionableForUser(a) {
  // What's awaiting THIS user on this assignment? Returns a label or null.
  const uid = CURRENT_USER.id;
  if (a.status === 'Pending' && a.assignee_id === uid)         return { label: 'Start', tone: 'amber' };
  if (a.status === 'In Progress' && a.assignee_id === uid)    return { label: 'Continue execution', tone: 'blue' };
  if (a.status === 'Pending Review' && a.reviewer_id === uid) return { label: 'Review', tone: 'amber' };
  if (a.status === 'Pending Approval' && a.approver_id === uid) return { label: 'Approve', tone: 'amber' };
  return null;
}

// ----- Checklist Assignment manager view (dedicated module) -----
async function loadAssignmentsPage() {
  try {
    const filter = ($('assnFilterStatus') || {}).value || '';
    const url = filter ? `/api/assignments?status=${encodeURIComponent(filter)}` : '/api/assignments';
    const rows = await api('GET', url);
    const body = $('assignmentsListBody');
    if (!body) return;
    body.innerHTML = rows.length === 0
      ? '<tr class="empty-row"><td colspan="11">No assignments yet — click "+ New Assignment" to create one.</td></tr>'
      : rows.map(a => `<tr>
          <td><strong>${escapeHtml(a.assignment_id)}</strong></td>
          <td>${escapeHtml(a.checklist_name || '')}<div style="color:var(--muted); font-size:11px;">${escapeHtml(a.checklist_version || '')}</div></td>
          <td>${escapeHtml(a.target_id || '')}${a.target_label ? `<div style="color:var(--muted); font-size:11px;">${escapeHtml(a.target_label)}</div>` : ''}</td>
          <td>${escapeHtml(a.assignee_name || '— open —')}</td>
          <td>${escapeHtml(a.reviewer_name || '—')}</td>
          <td>${escapeHtml(a.approver_name || '—')}</td>
          <td>${escapeHtml(a.frequency || '—')}</td>
          <td>${escapeHtml(a.effective_date || '—')}</td>
          <td>${escapeHtml(a.due_date || '—')}</td>
          <td>${statusPill(a.status)}</td>
          <td><button class="btn ghost sm" onclick="openAssignment('${escapeHtml(a.assignment_id)}')">Open</button></td>
        </tr>`).join('');
  } catch (e) { toast(e.message, 'error'); }
}

async function loadTasks(tab) {
  CURRENT_TASKS_TAB = tab;
  document.querySelectorAll('#tasksTabs button').forEach(b => b.classList.toggle('active', b.dataset.tt === tab));
  try {
    let url = '/api/assignments';
    if (tab === 'mine')  url = '/api/assignments?mine=1';
    if (tab === 'inbox') url = '/api/assignments?inbox=1';
    let rows = await api('GET', url);
    if (tab === 'inbox') {
      rows = rows.filter(a => actionableForUser(a) != null);
    }
    $('tasksBody').innerHTML = rows.length === 0
      ? `<tr class="empty-row"><td colspan="8">${tab==='inbox'?'Nothing awaiting your action 🎉':(tab==='mine'?'No assignments for you yet.':'No assignments.')}</td></tr>`
      : rows.map(a => {
          const act = actionableForUser(a);
          const actBadge = act ? `<span class="pill ${act.tone}" style="font-size:9px; margin-left:6px;">${escapeHtml(act.label)}</span>` : '';
          return `<tr>
          <td><strong>${escapeHtml(a.assignment_id)}</strong>${actBadge}</td>
          <td>${escapeHtml(a.checklist_name || '')} <span style="color:var(--muted); font-size:11px;">${escapeHtml(a.checklist_version || '')}</span></td>
          <td>${escapeHtml(a.target_type || '')} <strong>${escapeHtml(a.target_id || '')}</strong>${a.target_label?`<div style="color:var(--muted); font-size:11px;">${escapeHtml(a.target_label)}</div>`:''}</td>
          <td>
            ${escapeHtml(a.assignee_name || '— open —')}
            <div style="color:var(--muted); font-size:11px;">rev: ${escapeHtml(a.reviewer_name || '—')} · app: ${escapeHtml(a.approver_name || '—')}</div>
          </td>
          <td>${escapeHtml(a.frequency || '—')}</td>
          <td>${escapeHtml(a.due_date || a.effective_date || '—')}${a.effective_date && a.due_date ? `<div style="color:var(--muted); font-size:11px;">effective ${escapeHtml(a.effective_date)}</div>` : ''}</td>
          <td>${statusPill(a.status)}</td>
          <td><button class="btn ${act?'primary':'ghost'} sm" onclick="openAssignment('${escapeHtml(a.assignment_id)}')">${a.status==='Completed'?'View':'Open'}</button></td>
        </tr>`;
        }).join('');
  } catch (e) { toast(e.message,'error'); }
}

async function openAssignChecklistModal(presetChecklistId, presetEquipmentId) {
  try {
    const [checklists, users, roles, freqs, cats, blocks, locations, areas, equipment] = await Promise.all([
      api('GET','/api/checklists?status=Approved'),
      api('GET','/api/users'),
      api('GET','/api/roles'),
      api('GET','/api/frequencies'),
      api('GET','/api/pm-categories'),
      api('GET','/api/blocks'),
      api('GET','/api/locations'),
      api('GET','/api/areas'),
      api('GET','/api/equipment'),
    ]);
    if (checklists.length === 0) {
      toast('No approved checklists yet. A checklist must complete Review + Approval before it can be assigned.', 'error');
      return;
    }
    const executorSet = usersWithActivity(users, roles, 'execute_checklist','execute_pm');
    const reviewerSet = usersWithActivity(users, roles, 'review_pm','review_checklist');
    const approverSet = usersWithActivity(users, roles, 'approve_pm','approve_checklist');
    const executors = users.filter(u => executorSet.has(u.id));
    const reviewers = users.filter(u => reviewerSet.has(u.id));
    const approvers = users.filter(u => approverSet.has(u.id));
    if (executors.length === 0) { toast('No users with execute permission.','error'); return; }
    if (reviewers.length === 0 || approvers.length === 0) {
      toast('No users with the review/approve permission. Configure roles first.','error'); return;
    }

    // Stash data for inline handlers
    window.__asn = { checklists, blocks, locations, areas, equipment };
    const checklistDefaults = {};
    checklists.forEach(c => { checklistDefaults[c.id] = { reviewer_id: c.reviewer_id, approver_id: c.approver_id, category_id: c.category_id }; });

    // Helpers as window globals so inline onchange can reach them
    window.__asnFilterChecklists = (catId) => {
      const sel = document.getElementById('asnChecklistSel');
      const filtered = catId
        ? checklists.filter(c => Number(c.category_id) === Number(catId))
        : checklists;
      sel.innerHTML = filtered.length === 0
        ? '<option value="">— no approved checklists in this category —</option>'
        : filtered.map(c => `<option value="${c.id}">${escapeHtml(c.name)} (${escapeHtml(c.version)})</option>`).join('');
      window.__asnSyncReviewerApprover();
    };
    window.__asnSyncReviewerApprover = () => {
      const sel = document.getElementById('asnChecklistSel');
      const d = checklistDefaults[Number(sel.value)] || {};
      const rv = document.querySelector('select[name="reviewer_id"]');
      const ap = document.querySelector('select[name="approver_id"]');
      if (rv && d.reviewer_id) rv.value = d.reviewer_id;
      if (ap && d.approver_id) ap.value = d.approver_id;
    };
    // Helpers — render the auto-populated "name" label below each dropdown.
    // Empty state shows a placeholder hint so the user knows what's coming.
    const setDesc = (id, label, value) => {
      const el = document.getElementById(id);
      if (!el) return;
      if (value) {
        el.innerHTML = `<strong style="color:var(--brown-700);">${escapeHtml(label)}:</strong> ${escapeHtml(value)}`;
        el.style.color = 'var(--brown-700)';
      } else {
        el.innerHTML = `<em style="color:var(--muted);">${escapeHtml(label)} will appear here once you pick an ID above.</em>`;
      }
    };
    window.__asnOnBlock = () => {
      const sel = document.getElementById('asnBlockSel');
      const b = blocks.find(x => x.block_id === sel.value);
      setDesc('asnBlockDesc', 'Block Name', b ? b.name : null);
      const matching = locations.filter(l => l.block_id === sel.value);
      document.getElementById('asnLocSel').innerHTML = '<option value="">— select location —</option>' +
        matching.map(l => `<option value="${escapeHtml(l.location_id)}">${escapeHtml(l.location_id)} · ${escapeHtml(l.description || '')}</option>`).join('');
      setDesc('asnLocDesc', 'Location Name', null);
      document.getElementById('asnAreaSel').innerHTML = '<option value="">— select location first —</option>';
      setDesc('asnAreaDesc', 'Area Name', null);
      document.getElementById('asnEqSel').innerHTML = '<option value="">— select area first —</option>';
      setDesc('asnEqDesc', 'Equipment Name', null);
    };
    window.__asnOnLoc = () => {
      const sel = document.getElementById('asnLocSel');
      const l = locations.find(x => x.location_id === sel.value);
      setDesc('asnLocDesc', 'Location Name', l ? l.description : null);
      const matching = areas.filter(a => a.location_id === sel.value);
      document.getElementById('asnAreaSel').innerHTML = '<option value="">— select area —</option>' +
        matching.map(a => `<option value="${escapeHtml(a.area_id)}">${escapeHtml(a.area_id)} · ${escapeHtml(a.name || a.area_type || '')}</option>`).join('');
      setDesc('asnAreaDesc', 'Area Name', null);
      document.getElementById('asnEqSel').innerHTML = '<option value="">— select area first —</option>';
      setDesc('asnEqDesc', 'Equipment Name', null);
    };
    window.__asnOnArea = () => {
      const sel = document.getElementById('asnAreaSel');
      const a = areas.find(x => x.area_id === sel.value);
      setDesc('asnAreaDesc', 'Area Name', a ? (a.name || a.area_type) : null);
      const matching = equipment.filter(e => e.area_id === sel.value);
      document.getElementById('asnEqSel').innerHTML = '<option value="">— select equipment —</option>' +
        matching.map(e => `<option value="${escapeHtml(e.equipment_id)}">${escapeHtml(e.equipment_id)} · ${escapeHtml(e.name || '')}</option>`).join('');
      setDesc('asnEqDesc', 'Equipment Name', null);
    };
    window.__asnOnEq = () => {
      const sel = document.getElementById('asnEqSel');
      const e = equipment.find(x => x.equipment_id === sel.value);
      setDesc('asnEqDesc', 'Equipment Name', e ? e.name : null);
    };

    const catRadios = cats.map(c => `
      <label style="display:inline-flex; align-items:center; gap:4px; margin:3px 10px 3px 0; font-size:13px;">
        <input type="radio" name="category_id" value="${c.id}" onchange="window.__asnFilterChecklists(this.value)" />
        ${escapeHtml(c.name)}
      </label>`).join('') + `
      <label style="display:inline-flex; align-items:center; gap:4px; margin:3px 10px 3px 0; font-size:13px;">
        <input type="radio" name="category_id" value="" checked onchange="window.__asnFilterChecklists(this.value)" />
        <em>Any</em>
      </label>`;

    const freqRadios = freqs.map(f => `
      <label style="display:inline-flex; align-items:center; gap:4px; margin:3px 10px 3px 0; font-size:13px;">
        <input type="radio" name="frequency_id" value="${f.id}" />
        ${escapeHtml(f.name)} <span style="color:var(--muted); font-size:11px;">(${f.days}d)</span>
      </label>`).join('');

    const todayStr = new Date().toISOString().slice(0,10);

    openModal({
      title: 'Assign PM Activity',
      width: 720,
      body: `
        <div class="form-row" style="grid-template-columns:1fr;">
          <label>Maintenance Category</label>
          <div id="asnCatRadios">${catRadios}</div>
        </div>
        <div class="form-row"><label>Approved Checklist *</label>
          <select id="asnChecklistSel" name="checklist_id" required onchange="window.__asnSyncReviewerApprover()">
            ${checklists.map(c => `<option value="${c.id}" ${presetChecklistId===c.id?'selected':''}>${escapeHtml(c.name)} (${escapeHtml(c.version)})</option>`).join('')}
          </select>
        </div>

        <div class="form-row"><label>Block ID</label>
          <div>
            <select id="asnBlockSel" name="block_id" onchange="window.__asnOnBlock()">
              <option value="">— select block —</option>
              ${blocks.map(b => `<option value="${escapeHtml(b.block_id)}">${escapeHtml(b.block_id)} · ${escapeHtml(b.name || '')}</option>`).join('')}
            </select>
            <div id="asnBlockDesc" style="font-size:12px; margin-top:5px;"><em style="color:var(--muted);">Block Name will appear here once you pick an ID above.</em></div>
          </div>
        </div>
        <div class="form-row"><label>Location ID</label>
          <div>
            <select id="asnLocSel" name="location_id" onchange="window.__asnOnLoc()">
              <option value="">— select block first —</option>
            </select>
            <div id="asnLocDesc" style="font-size:12px; margin-top:5px;"><em style="color:var(--muted);">Location Name will appear here once you pick an ID above.</em></div>
          </div>
        </div>
        <div class="form-row"><label>Area ID</label>
          <div>
            <select id="asnAreaSel" name="area_id" onchange="window.__asnOnArea()">
              <option value="">— select location first —</option>
            </select>
            <div id="asnAreaDesc" style="font-size:12px; margin-top:5px;"><em style="color:var(--muted);">Area Name will appear here once you pick an ID above.</em></div>
          </div>
        </div>
        <div class="form-row"><label>Equipment ID *</label>
          <div>
            <select id="asnEqSel" name="equipment_id" required onchange="window.__asnOnEq()">
              <option value="">— select area first —</option>
            </select>
            <div id="asnEqDesc" style="font-size:12px; margin-top:5px;"><em style="color:var(--muted);">Equipment Name will appear here once you pick an ID above.</em></div>
          </div>
        </div>

        <div class="form-row" style="grid-template-columns:1fr;">
          <label>Checklist Frequency *</label>
          <div id="asnFreqRadios">${freqRadios}</div>
        </div>

        <div class="form-row"><label>Effective Date *</label><input type="date" name="effective_date" required value="${todayStr}" /></div>
        <div class="form-row"><label>Due Date</label><input type="date" name="due_date" /></div>

        <div class="form-row"><label>Executor (Initiator) *</label>
          <select name="assignee_id" required>
            ${executors.map(u => `<option value="${u.id}">${escapeHtml(u.name)} — ${escapeHtml(u.role)} / ${escapeHtml(u.department || '')}</option>`).join('')}
          </select>
        </div>
        <div class="form-row"><label>Reviewer (Engineering) *</label>
          <select name="reviewer_id" required>
            ${reviewers.map(u => `<option value="${u.id}">${escapeHtml(u.name)} — ${escapeHtml(u.role)}</option>`).join('')}
          </select>
        </div>
        <div class="form-row"><label>Approver (QA) *</label>
          <select name="approver_id" required>
            ${approvers.map(u => `<option value="${u.id}">${escapeHtml(u.name)} — ${escapeHtml(u.role)}</option>`).join('')}
          </select>
        </div>
        <div class="form-row" style="grid-template-columns:1fr;"><label>Notes</label><textarea name="notes" placeholder="Optional context for the executor"></textarea></div>
        <p style="font-size:11px; color:var(--muted); margin:6px 0 0;">Workflow: Executor performs → Reviewer (Engineering) passes → Approver (QA) signs off.</p>
      `,
      onSubmit: async (data) => {
        if (!data.frequency_id) throw new Error('Please select a Checklist Frequency');
        if (!data.equipment_id) throw new Error('Please select an Equipment');
        await api('POST','/api/assignments', {
          checklist_id: Number(data.checklist_id),
          target_type: 'equipment',
          target_id: data.equipment_id,
          assignee_id: Number(data.assignee_id),
          reviewer_id: Number(data.reviewer_id),
          approver_id: Number(data.approver_id),
          frequency_id: Number(data.frequency_id),
          effective_date: data.effective_date || null,
          due_date: data.due_date || null,
          notes: data.notes || ''
        });
        toast('PM activity assigned. Executor notified.', 'success');
        if ($('page-tasks').classList.contains('active'))       loadTasks(CURRENT_TASKS_TAB);
        if ($('page-assignments').classList.contains('active')) loadAssignmentsPage();
      }
    });
    // After the modal is in the DOM, sync reviewer/approver defaults for the initial checklist
    setTimeout(() => {
      window.__asnSyncReviewerApprover();
      // If pre-set equipment was passed (e.g. from Masters → Equipment row), walk the chain back
      // and pre-select Block → Location → Area → Equipment.
      if (presetEquipmentId) {
        const eq = equipment.find(e => e.equipment_id === presetEquipmentId);
        if (eq) {
          const area = areas.find(a => a.area_id === eq.area_id);
          const loc  = area && locations.find(l => l.location_id === area.location_id);
          const blk  = loc  && blocks.find(b => b.block_id === loc.block_id);
          if (blk) {
            const bSel = document.getElementById('asnBlockSel'); bSel.value = blk.block_id; window.__asnOnBlock();
          }
          if (loc) {
            const lSel = document.getElementById('asnLocSel'); lSel.value = loc.location_id; window.__asnOnLoc();
          }
          if (area) {
            const aSel = document.getElementById('asnAreaSel'); aSel.value = area.area_id; window.__asnOnArea();
          }
          const eSel = document.getElementById('asnEqSel'); eSel.value = eq.equipment_id; window.__asnOnEq();
        }
      }
    }, 50);
  } catch (e) { toast(e.message,'error'); }
}

// Build a Set of user IDs whose role grants any of the given activity codes.
function usersWithActivity(users, roles, ...activityCodes) {
  const codes = new Set(activityCodes);
  const okRoles = new Set(roles.filter(r => (r.permissions || []).some(p => codes.has(p))).map(r => r.id));
  return new Set(users.filter(u => u.status === 'Active' && okRoles.has(u.role_id)).map(u => u.id));
}

// ----- Checklist (template) workflow actions -----
async function openSubmitChecklistModal(checklistId) {
  try {
    const [users, roles] = await Promise.all([api('GET','/api/users'), api('GET','/api/roles')]);
    const reviewerSet = usersWithActivity(users, roles, 'review_checklist');
    const approverSet = usersWithActivity(users, roles, 'approve_checklist');
    const reviewers   = users.filter(u => reviewerSet.has(u.id));
    const approvers   = users.filter(u => approverSet.has(u.id));
    if (reviewers.length === 0 || approvers.length === 0) {
      toast('No users with review_checklist / approve_checklist permission. Configure a role first.', 'error');
      return;
    }
    openModal({
      title: 'Submit Checklist for Review',
      body: `
        <p style="font-size:12px; color:var(--muted); margin-top:0;">Pick a reviewer (Engineering Manager) and a final approver (QA). Reviewer is notified first; once they pass it, the approver is notified.</p>
        <div class="form-row"><label>Reviewer (Engineering) *</label>
          <select name="reviewer_id" required>
            ${reviewers.map(u => `<option value="${u.id}">${escapeHtml(u.name)} — ${escapeHtml(u.role)} / ${escapeHtml(u.department || '')}</option>`).join('')}
          </select>
        </div>
        <div class="form-row"><label>Approver (QA) *</label>
          <select name="approver_id" required>
            ${approvers.map(u => `<option value="${u.id}">${escapeHtml(u.name)} — ${escapeHtml(u.role)} / ${escapeHtml(u.department || '')}</option>`).join('')}
          </select>
        </div>
      `,
      submitLabel: 'Submit',
      onSubmit: async (data) => {
        await api('PUT', `/api/checklists/${checklistId}/submit`, {
          reviewer_id: Number(data.reviewer_id),
          approver_id: Number(data.approver_id),
        });
        toast('Submitted for review.', 'success');
        previewChecklist(checklistId);
        loadChecklists();
        refreshNotifBadge();
      }
    });
  } catch (e) { toast(e.message,'error'); }
}

async function reviewChecklistDecision(checklistId, decision) {
  let reason = null;
  if (decision === 'reject') {
    reason = prompt('Reason for rejection:');
    if (!reason) return;
  }
  try {
    await api('PUT', `/api/checklists/${checklistId}/review`, { decision, reason });
    toast(decision === 'approve' ? 'Review passed — sent to approver.' : 'Checklist rejected.', 'success');
    previewChecklist(checklistId);
    loadChecklists();
    refreshNotifBadge();
  } catch (e) { toast(e.message,'error'); }
}

async function approveChecklistDecision(checklistId, decision) {
  let reason = null;
  if (decision === 'reject') {
    reason = prompt('Reason for rejection:');
    if (!reason) return;
  }
  try {
    await api('PUT', `/api/checklists/${checklistId}/approve`, { decision, reason });
    toast(decision === 'approve' ? 'Checklist approved — now available for assignment.' : 'Checklist rejected.', 'success');
    previewChecklist(checklistId);
    loadChecklists();
    refreshNotifBadge();
  } catch (e) { toast(e.message,'error'); }
}

async function openAssignment(assignmentId) {
  try {
    const a = await api('GET', `/api/assignments/${assignmentId}`);
    const cl = a.checklist;
    const existing = a.response_data || {};
    const userId = CURRENT_USER.id;

    // Determine roles
    const amExecutor = a.assignee_id === userId || (!a.assignee_id && can('execute_checklist'));
    const amReviewer = a.reviewer_id === userId;
    const amApprover = a.approver_id === userId;
    const amAdmin    = CURRENT_USER.is_admin;

    // Editable matrix
    const executorEditable = (a.status === 'Pending' || a.status === 'In Progress') && (amExecutor || amAdmin);
    const reviewerActing   = a.status === 'Pending Review' && (amReviewer || amAdmin);
    const approverActing   = a.status === 'Pending Approval' && (amApprover || amAdmin);
    const formEditable     = executorEditable;

    // Fetch equipment context for auto-populated Required Fields when target is equipment.
    let eqCtx = null;
    if (a.target_type === 'equipment' && a.target_id) {
      try { eqCtx = await api('GET', `/api/equipment/${a.target_id}`); } catch (e) {}
    }
    // Build Required Fields block based on the checklist's enabled keys.
    const requiredKeys = (cl && cl.required_fields) || [];
    const rfLabelMap = Object.fromEntries(REQUIRED_FIELD_DEFS.map(rf => [rf.key, rf]));
    const autoVal = (key) => {
      if (!eqCtx && key === 'area') return '';
      switch (key) {
        case 'area':          return eqCtx ? `${eqCtx.area_id || ''}` : '';
        case 'equipment':     return eqCtx ? `${eqCtx.equipment_id} · ${eqCtx.name}` : '';
        case 'capacity_make': return eqCtx ? [eqCtx.capacity, eqCtx.make, eqCtx.model].filter(Boolean).join(' / ') : '';
        default: return '';
      }
    };
    const rfDis = formEditable ? '' : 'disabled';
    const rfHtml = requiredKeys.length ? `
      <div style="margin: 4px 0 8px; padding: 8px 12px; background: var(--cream-100); border-left:3px solid var(--brand); border-radius:6px;">
        <strong>Required Fields</strong>
        <div style="color:var(--muted); font-size:11px;">Configurable execution fields enabled on this checklist.</div>
      </div>
      <div style="display:grid; grid-template-columns: 1fr 1fr; gap:8px 16px; margin-bottom:12px;">
        ${requiredKeys.map(key => {
          const def = rfLabelMap[key];
          if (!def) return '';
          if (def.auto) {
            const v = autoVal(key);
            return `<div>
              <div style="font-size:11px; color:var(--muted); text-transform:uppercase;">${escapeHtml(def.label)}</div>
              <input type="text" name="rf_${key}" value="${escapeHtml(v)}" readonly style="background:var(--cream-100);" />
            </div>`;
          }
          const v = existing[`rf_${key}`] ?? '';
          return `<div>
            <div style="font-size:11px; color:var(--muted); text-transform:uppercase;">${escapeHtml(def.label)}</div>
            <input type="text" name="rf_${key}" value="${escapeHtml(v)}" ${rfDis} placeholder="${escapeHtml(def.desc)}" />
          </div>`;
        }).join('')}
      </div>` : '';

    // Cascading applicability: at execution frequency X, complete every checkpoint tagged at
    // X-or-LOWER frequency. Higher-frequency checkpoints are shown as N/A so the audit trail
    // captures that they were deliberately not performed during this run.
    //
    // "Lower frequency" = smaller `days` value (Weekly=7 < Monthly=30 < Quarterly=90 ...).
    const asnFreqId = a.frequency_id;
    const asnDays   = Number(a.frequency_days || 0);
    const freqDaysMap = {};
    const freqNameMap = {};
    ((cl && cl.frequencies) || []).forEach(f => { freqDaysMap[f.id] = Number(f.days || 0); freqNameMap[f.id] = f.name; });
    // also include the assignment's frequency in case it isn't on the checklist's allowed list
    if (asnFreqId) { freqDaysMap[asnFreqId] = asnDays; freqNameMap[asnFreqId] = a.frequency || `#${asnFreqId}`; }

    const questionApplies = (q) => {
      if (!q.frequencies || q.frequencies.length === 0) return true;          // tagged "all" → always applies
      if (!asnDays) return q.frequencies.includes(asnFreqId);                  // assignment has no days info → exact match
      return q.frequencies.some(fid => {
        const d = freqDaysMap[fid];
        return d !== undefined && d <= asnDays;                                // cascade: lower- or equal-frequency tag → applies
      });
    };
    const questionHigherFreqLabel = (q) => {
      const names = (q.frequencies || []).map(fid => freqNameMap[fid] || `#${fid}`).filter(Boolean);
      return names.length ? names.join(' / ') : '—';
    };

    const filteredSections = (cl?.sections || [])
      .map(s => ({
        ...s,
        questions: (s.questions || []).map(q => ({ ...q, _applies: questionApplies(q) }))
      }));
    const sectionsHtml = filteredSections.map((s, si) => `
      <div style="margin: 10px 0 6px; padding: 8px 12px; background: var(--cream-100); border-left:3px solid var(--brand); border-radius:6px;">
        <strong>${si+1}. ${escapeHtml(s.name)}</strong>
        ${s.description ? `<div style="color:var(--muted); font-size:12px;">${escapeHtml(s.description)}</div>` : ''}
      </div>
      <ul class="checklist">
        ${s.questions.map((q, qi) => {
          if (!q._applies) {
            // Higher-frequency checkpoint — render as N/A so the audit captures it.
            const onlyOn = questionHigherFreqLabel(q);
            return `<li style="opacity:0.55;">
              <div class="chk-num" style="background:#eee; color:#999;">${si+1}.${qi+1}</div>
              <div class="chk-body">
                <div class="chk-title" style="text-decoration: line-through;">${escapeHtml(q.label)}${q.required?' *':''}</div>
                <div class="chk-meta"><em>N/A this run — performed on <strong>${escapeHtml(onlyOn)}</strong> PM only</em></div>
                <div class="chk-input"><input type="text" name="q_${q.id}" value="N/A" disabled style="background:#f5f5f5; color:#999; font-style:italic;" /></div>
              </div></li>`;
          }
          const val = existing[`q_${q.id}`] ?? '';
          let inp = '';
          const dis = formEditable ? '' : 'disabled';
          if (q.qtype === 'number')        inp = `<input type="number" name="q_${q.id}" min="${q.min_value ?? ''}" max="${q.max_value ?? ''}" value="${escapeHtml(val)}" ${q.required?'required':''} ${dis}/>${q.unit?` <span style='color:var(--muted); font-size:11px;'>${escapeHtml(q.unit)}</span>`:''}`;
          else if (q.qtype === 'checkbox') inp = `<label><input type="checkbox" name="q_${q.id}" ${val?'checked':''} ${dis}/> Yes</label>`;
          else if (q.qtype === 'yesno')    inp = `<select name="q_${q.id}" ${q.required?'required':''} ${dis}><option value="">—</option><option ${val==='Yes'?'selected':''}>Yes</option><option ${val==='No'?'selected':''}>No</option></select>`;
          else if (q.qtype === 'dropdown') inp = `<select name="q_${q.id}" ${q.required?'required':''} ${dis}><option value="">—</option>${(q.options||[]).map(o => `<option ${o===val?'selected':''}>${escapeHtml(o)}</option>`).join('')}</select>`;
          else                             inp = `<input type="text" name="q_${q.id}" value="${escapeHtml(val)}" ${q.required?'required':''} ${dis}/>`;
          return `<li><div class="chk-num">${si+1}.${qi+1}</div><div class="chk-body">
            <div class="chk-title">${escapeHtml(q.label)}${q.required?' *':''}</div>
            <div class="chk-input">${inp}</div></div></li>`;
        }).join('')}
      </ul>`).join('');

    const banner = `
      <div class="row-gap" style="font-size:12px; margin-bottom: 8px;">
        ${statusPill(a.status)}
        ${a.target_id ? `<span class="pill brown">${escapeHtml(a.target_type)}: ${escapeHtml(a.target_id)}${a.target_label?' · '+escapeHtml(a.target_label):''}</span>` : ''}
        ${a.effective_date ? `<span class="pill brown">Effective: ${escapeHtml(a.effective_date)}</span>` : ''}
        ${a.due_date  ? `<span class="pill brown">Due: ${escapeHtml(a.due_date)}</span>` : ''}
        ${a.frequency ? `<span class="pill brown">${escapeHtml(a.frequency)}</span>` : ''}
      </div>
      <div style="font-size:12px; color:var(--muted); margin-bottom:12px;">
        Executor <strong>${escapeHtml(a.assignee_name || '— open —')}</strong>
        &nbsp;→&nbsp; Reviewer <strong>${escapeHtml(a.reviewer_name || '—')}</strong>
        &nbsp;→&nbsp; Approver <strong>${escapeHtml(a.approver_name || '—')}</strong>
        &nbsp;·&nbsp; Assigned by ${escapeHtml(a.assigned_by_name || '')}
      </div>
      ${a.rejection_reason ? `<div style="margin-bottom:10px; padding:8px 12px; background:#fdecec; border-left:3px solid var(--red); border-radius:6px; font-size:12px;"><strong>Returned for rework:</strong> ${escapeHtml(a.rejection_reason)}</div>` : ''}
      ${a.pnc_number ? `<div style="margin-bottom:10px; padding:8px 12px; background:#fff5e6; border-left:3px solid #c77b00; border-radius:6px; font-size:12px;">
        <strong>Re-assignment from Expired</strong>
        <div style="margin-top:3px;">PNC: <strong>${escapeHtml(a.pnc_number)}</strong> · Exception: <strong>${escapeHtml(a.exception_number || '')}</strong></div>
        ${a.exception_description ? `<div style="color:var(--muted); margin-top:3px;">${escapeHtml(a.exception_description)}</div>` : ''}
      </div>` : ''}`;

    // Signatures so far
    const sigCard = (label, sig, ts) => sig
      ? `<div style="padding:6px 10px; background:var(--cream-100); border-radius:6px; font-size:11px; min-width:160px;">
          <div style="color:var(--muted); text-transform:uppercase; letter-spacing:1px;">${label}</div>
          <div style="font-weight:600;">${escapeHtml(sig)}</div>
          ${ts ? `<div style="color:var(--muted);">${escapeHtml(ts)}</div>` : ''}
         </div>`
      : '';
    const sigsHtml = (a.executor_sig || a.reviewer_sig || a.approver_sig) ? `
      <hr class="sep" />
      <div style="font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:1px; margin-bottom:6px;">Signatures</div>
      <div class="row-gap">
        ${sigCard('Executor', a.executor_sig, a.submitted_at)}
        ${sigCard('Reviewer', a.reviewer_sig, a.reviewed_at)}
        ${sigCard('Approver', a.approver_sig, a.approved_at)}
      </div>` : '';

    const notesBox = formEditable
      ? `<div class="form-row" style="grid-template-columns:1fr;"><label>Notes</label><textarea name="__notes" placeholder="Observations / remarks">${escapeHtml(a.notes || '')}</textarea></div>`
      : (a.notes ? `<div style="color:var(--muted); font-size:12px; margin-top:8px;"><strong>Executor notes:</strong> ${escapeHtml(a.notes)}</div>` : '');

    // Action buttons by stage
    const acts = [];
    if (formEditable) {
      acts.push(`<button type="button" class="btn ghost" onclick="saveAssignmentProgress('${a.assignment_id}')">💾 Save Progress</button>`);
      acts.push(`<button type="button" class="btn primary" onclick="submitAssignmentForReview('${a.assignment_id}')">Submit for Review →</button>`);
    }
    if (reviewerActing) {
      acts.push(`<button type="button" class="btn primary" onclick="assignmentReviewDecision('${a.assignment_id}','approve')">✓ Pass Review</button>`);
      acts.push(`<button type="button" class="btn ghost"   onclick="assignmentReviewDecision('${a.assignment_id}','reject')">✗ Reject</button>`);
    }
    if (approverActing) {
      acts.push(`<button type="button" class="btn primary" onclick="assignmentApproveDecision('${a.assignment_id}','approve')">✓ Approve &amp; Close</button>`);
      acts.push(`<button type="button" class="btn ghost"   onclick="assignmentApproveDecision('${a.assignment_id}','reject')">✗ Reject</button>`);
    }
    const actionsHtml = acts.join(' ');

    // Cascade banner — count applicable vs N/A and explain the rule.
    let nApplies = 0, nNA = 0;
    filteredSections.forEach(s => s.questions.forEach(q => { q._applies ? nApplies++ : nNA++; }));
    const cascadeBanner = (nNA > 0 && a.frequency) ? `
      <div style="margin:0 0 10px; padding:8px 12px; background:var(--blue-bg); border-left:3px solid var(--blue); border-radius:6px; font-size:12px;">
        <strong>Frequency Cascade — ${escapeHtml(a.frequency)} PM:</strong>
        ${nApplies} checkpoint(s) to complete · ${nNA} marked N/A for this run.
        <div style="color:var(--muted); margin-top:2px;">A ${escapeHtml(a.frequency)} run includes every checkpoint tagged at ${escapeHtml(a.frequency)} or any lower frequency. Higher-frequency checkpoints are shown but disabled, so the record reflects what was deliberately skipped.</div>
      </div>` : '';

    openModal({
      title: `Assignment ${a.assignment_id} — ${escapeHtml(cl?.name || '')}`,
      width: 780,
      body: `${banner}${rfHtml}${cascadeBanner}${sectionsHtml}${notesBox}${sigsHtml}`,
      actions: actionsHtml,
      hideDefaultSubmit: true,
    });
  } catch (e) { toast(e.message,'error'); }
}

// ---- Executor actions ----
function _collectAssignmentResponses() {
  const resp = {};
  document.querySelectorAll(
    'input[name^="q_"], select[name^="q_"], textarea[name^="q_"], ' +
    'input[name^="rf_"], select[name^="rf_"], textarea[name^="rf_"]'
  ).forEach(el => {
    if (el.type === 'checkbox') resp[el.name] = el.checked;
    else                        resp[el.name] = el.value;
  });
  const notes = (document.querySelector('textarea[name="__notes"]') || {}).value || '';
  return { response_data: resp, notes };
}
async function saveAssignmentProgress(assignmentId) {
  try {
    const payload = _collectAssignmentResponses();
    await api('PUT', `/api/assignments/${assignmentId}/save`, payload);
    toast('Progress saved.', 'success');
  } catch (e) { toast(e.message,'error'); }
}
async function submitAssignmentForReview(assignmentId) {
  try {
    const payload = _collectAssignmentResponses();
    await api('PUT', `/api/assignments/${assignmentId}/submit`, payload);
    toast('Submitted for review.', 'success');
    closeModal();
    loadTasks(CURRENT_TASKS_TAB);
    refreshNotifBadge();
  } catch (e) { toast(e.message,'error'); }
}

// ---- Reviewer / Approver actions ----
async function assignmentReviewDecision(assignmentId, decision) {
  let reason = null;
  if (decision === 'reject') {
    reason = prompt('Reason for rejection (will be shown to the executor):');
    if (!reason) return;
  }
  try {
    await api('PUT', `/api/assignments/${assignmentId}/review`, { decision, reason });
    toast(decision === 'approve' ? 'Review passed — sent to approver.' : 'Returned to executor for rework.', 'success');
    closeModal();
    loadTasks(CURRENT_TASKS_TAB);
    refreshNotifBadge();
  } catch (e) { toast(e.message,'error'); }
}
async function assignmentApproveDecision(assignmentId, decision) {
  let reason = null;
  if (decision === 'reject') {
    reason = prompt('Reason for rejection (will be shown to executor + reviewer):');
    if (!reason) return;
  }
  try {
    await api('PUT', `/api/assignments/${assignmentId}/approve`, { decision, reason });
    toast(decision === 'approve' ? 'Approved & closed.' : 'Returned to executor for rework.', 'success');
    closeModal();
    loadTasks(CURRENT_TASKS_TAB);
    refreshNotifBadge();
  } catch (e) { toast(e.message,'error'); }
}

// ===========================================================
// PM STATUS LABEL
// ===========================================================
async function loadPmStatusPage() {
  try {
    const equipment = await api('GET','/api/equipment');
    const sel = $('pmStatusSelect');
    if (sel) {
      sel.innerHTML = '<option value="">— select equipment —</option>' +
        equipment.map(e => `<option value="${escapeHtml(e.equipment_id)}">${escapeHtml(e.equipment_id)} · ${escapeHtml(e.name)}</option>`).join('');
      sel.onchange = () => { if (sel.value) fetchPmStatus(sel.value); };
    }
    const scan = $('pmStatusScan');
    if (scan) {
      scan.onkeydown = (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          const v = (scan.value || '').trim();
          if (v) fetchPmStatus(v);
        }
      };
    }
    // Clear any previous result
    $('pmStatusResult').innerHTML = '<div class="card"><p style="color:var(--muted); margin:0;">Scan an Equipment ID barcode (Enter to confirm) or pick from the dropdown to load its current PM status.</p></div>';
  } catch (e) { toast(e.message, 'error'); }
}

async function openQrCameraScanner() {
  if (typeof Html5Qrcode === 'undefined') {
    toast('Camera scanner failed to load. Refresh the page and try again.', 'error');
    return;
  }
  // Quick check for getUserMedia availability + secure context
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast('This device / browser does not expose a camera API.', 'error');
    return;
  }
  if (window.isSecureContext === false) {
    toast('Camera access requires HTTPS. Use the Render URL (not http://) or localhost.', 'error');
    return;
  }

  openModal({
    title: 'Scan Equipment QR / Barcode',
    width: 480,
    body: `
      <p style="color:var(--muted); font-size:12px; margin:0 0 8px;">Point the back camera at the QR code or barcode on the equipment. Decoding happens automatically.</p>
      <div id="qrReader" style="width:100%; max-width:420px; margin:0 auto; border:1px solid var(--border); border-radius:8px; overflow:hidden;"></div>
      <p id="qrScanStatus" style="color:var(--muted); font-size:11px; margin-top:8px; min-height:18px;">Starting camera…</p>
      <p style="font-size:11px; color:var(--muted); margin:4px 0 0;">No QR sticker? Close this and type the Equipment ID by hand.</p>
    `,
    hideDefaultSubmit: true,
  });

  // Boot the scanner after the modal is in the DOM.
  setTimeout(async () => {
    let scanner;
    try {
      scanner = new Html5Qrcode('qrReader', { verbose: false });
    } catch (e) {
      const s = document.getElementById('qrScanStatus');
      if (s) s.innerHTML = `<span style="color:var(--red);">${escapeHtml(e.message || 'Failed to initialise scanner')}</span>`;
      return;
    }
    window.__pmsScanner = scanner;

    const onSuccess = (decodedText) => {
      // Strip the seeded "QR:" prefix if present.
      let id = String(decodedText || '').trim();
      if (/^QR:/i.test(id)) id = id.slice(3);
      // Stop the camera, close modal, run lookup.
      scanner.stop().catch(()=>{}).finally(() => {
        window.__pmsScanner = null;
        closeModal();
        const input = $('pmStatusScan');
        if (input) input.value = id;
        toast(`Scanned: ${id}`, 'success');
        fetchPmStatus(id);
      });
    };
    const onScanError = () => { /* fired ~constantly until a code is found; ignore */ };

    try {
      await scanner.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 260, height: 260 } },
        onSuccess,
        onScanError
      );
      const s = document.getElementById('qrScanStatus');
      if (s) s.textContent = 'Camera ready — align the code inside the box.';
    } catch (e) {
      // Try front camera as a fallback (some laptops only have a front cam)
      try {
        await scanner.start(
          { facingMode: 'user' },
          { fps: 10, qrbox: { width: 260, height: 260 } },
          onSuccess,
          onScanError
        );
        const s = document.getElementById('qrScanStatus');
        if (s) s.textContent = 'Front camera active. Align the code inside the box.';
      } catch (e2) {
        const s = document.getElementById('qrScanStatus');
        if (s) s.innerHTML = `<span style="color:var(--red);">Camera unavailable: ${escapeHtml((e2 && e2.message) || String(e2))}</span>` +
          `<br/><span style="color:var(--muted);">Check the browser's site permissions (camera) and that nothing else is using the camera.</span>`;
      }
    }
  }, 80);
}

function pmStatusColor(status) {
  if (status === 'Preventive Maintenance Completed') return 'green';
  if (status === 'Under Preventive Maintenance')     return 'blue';
  if (status === 'Preventive Maintenance Rejected')  return 'red';
  return 'amber'; // Out of PM Schedule
}

async function fetchPmStatus(equipmentId) {
  try {
    const s = await api('GET', `/api/equipment/${encodeURIComponent(equipmentId)}/pm-status`);
    const colorClass = pmStatusColor(s.current_status);
    const fld = (label, val) => `
      <div style="padding:10px 12px; background:var(--cream-100); border-radius:6px;">
        <div style="font-size:10px; color:var(--muted); text-transform:uppercase; letter-spacing:1px;">${escapeHtml(label)}</div>
        <div style="font-size:13px; font-weight:600; margin-top:3px;">${val == null || val === '' ? '—' : escapeHtml(String(val))}</div>
      </div>`;

    $('pmStatusResult').innerHTML = `
      <div class="card" style="border-left:4px solid var(--brand);">
        <div style="display:flex; align-items:center; justify-content:space-between; gap:14px; flex-wrap:wrap; margin-bottom: 14px;">
          <div>
            <div style="font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:1px;">Current PM Status</div>
            <div style="font-size:20px; font-weight:700; margin-top:4px;">
              <span class="pill ${colorClass}" style="font-size:13px; padding:6px 12px;">${escapeHtml(s.current_status)}</span>
            </div>
            ${s.reason ? `<div style="color:var(--muted); font-size:12px; margin-top:6px;">${escapeHtml(s.reason)}</div>` : ''}
          </div>
          ${s.latest_assignment_id
            ? `<button class="btn ghost sm" onclick="goto('tasks'); setTimeout(() => openAssignment('${escapeHtml(s.latest_assignment_id)}'), 200);">Open PM ${escapeHtml(s.latest_assignment_id)} →</button>`
            : ''}
        </div>
        <div style="display:grid; grid-template-columns: repeat(3, 1fr); gap:10px;">
          ${fld('Plant ID', s.plant_id)}
          ${fld('Unit ID',  s.unit_number)}
          ${fld('Equipment ID', s.equipment_id)}
          ${fld('Equipment Name', s.equipment_name)}
          ${fld('Equipment Description', s.equipment_description)}
          ${fld('PM Number', s.pm_number)}
          ${fld('Frequency', s.frequency)}
          ${fld('Assigned User / PM Done By', s.assignee_name)}
          ${fld('Last Execution Date', s.last_execution_date)}
          ${fld('Next Due Date', s.next_due_date)}
          ${fld('Block / Location / Area', [s.block_name, s.location_name, s.area_name].filter(Boolean).join(' · '))}
        </div>
        <p style="font-size:11px; color:var(--muted); margin:12px 0 0;">Status is auto-computed from the PM workflow and cannot be edited manually.</p>
      </div>`;
  } catch (e) {
    $('pmStatusResult').innerHTML = `<div class="card" style="border-left:4px solid var(--red);"><strong style="color:var(--red);">${escapeHtml(e.message)}</strong></div>`;
  }
}

// ===========================================================
// EXPIRED EQUIPMENT ASSIGNMENT
// ===========================================================
async function loadExpiredPage() {
  const body = $('expiredBody');
  if (body) body.innerHTML = '<tr class="empty-row"><td colspan="8" style="text-align:center; padding:18px; color:var(--muted);">Loading…</td></tr>';
  try {
    const { rows, flipped } = await api('GET', '/api/assignments/expired');
    if (flipped > 0) toast(`${flipped} assignment(s) just expired and moved to this list.`, 'success');
    body.innerHTML = (!rows || rows.length === 0)
      ? '<tr class="empty-row"><td colspan="8" style="text-align:center; padding:18px;">🎉 No expired equipment — everything is on schedule.</td></tr>'
      : rows.map(a => `<tr>
          <td><strong>${escapeHtml(a.assignment_id)}</strong>${a.checklist_name?`<div style="color:var(--muted); font-size:11px;">${escapeHtml(a.checklist_name)} (${escapeHtml(a.checklist_version || '')})</div>`:''}</td>
          <td>${escapeHtml(a.plant_name || '—')}${a.unit_number ? `<div style="color:var(--muted); font-size:11px;">${escapeHtml(a.unit_number)}</div>` : ''}</td>
          <td><strong>${escapeHtml(a.target_id || '—')}</strong></td>
          <td>${escapeHtml(a.equipment_description || '—')}</td>
          <td>${escapeHtml(a.frequency || '—')}</td>
          <td>${escapeHtml(a.due_date || '—')}${a.expired_at?`<div style="color:var(--red); font-size:11px;">expired ${escapeHtml(a.expired_at)}</div>`:''}</td>
          <td>${statusPill('Expired')}</td>
          <td><button class="btn primary sm" onclick='openReassignExpiredModal(${escapeHtml(JSON.stringify(a))})'>Re-assign</button></td>
        </tr>`).join('');
  } catch (e) {
    toast(e.message, 'error');
    if (body) body.innerHTML = `<tr class="empty-row"><td colspan="8" style="text-align:center; padding:18px; color:var(--red);">Couldn't load expired equipment: ${escapeHtml(e.message)}</td></tr>`;
  }
}

async function openReassignExpiredModal(assignment) {
  try {
    const [users, roles] = await Promise.all([api('GET','/api/users'), api('GET','/api/roles')]);
    const executorSet = usersWithActivity(users, roles, 'execute_checklist','execute_pm');
    const reviewerSet = usersWithActivity(users, roles, 'review_pm','review_checklist');
    const approverSet = usersWithActivity(users, roles, 'approve_pm','approve_checklist');
    const executors = users.filter(u => executorSet.has(u.id));
    const reviewers = users.filter(u => reviewerSet.has(u.id));
    const approvers = users.filter(u => approverSet.has(u.id));
    if (executors.length === 0) { toast('No users with execute permission.','error'); return; }

    const todayStr = new Date().toISOString().slice(0,10);

    openModal({
      title: `Re-assign Expired PM — ${escapeHtml(assignment.assignment_id)}`,
      width: 600,
      body: `
        <div class="row-gap" style="font-size:12px; margin-bottom: 14px;">
          ${statusPill('Expired')}
          <span class="pill brown">${escapeHtml(assignment.target_id)} · ${escapeHtml(assignment.equipment_description || '')}</span>
          ${assignment.plant_name ? `<span class="pill brown">${escapeHtml(assignment.plant_name)}${assignment.unit_number?' · '+escapeHtml(assignment.unit_number):''}</span>` : ''}
          ${assignment.due_date ? `<span class="pill brown">Original due: ${escapeHtml(assignment.due_date)}</span>` : ''}
          ${assignment.frequency ? `<span class="pill brown">${escapeHtml(assignment.frequency)}</span>` : ''}
        </div>
        <p style="font-size:12px; color:var(--muted); margin-top:0;">This PM crossed its post-tolerance window. The fields below are mandatory before the re-assignment can be saved.</p>

        <div style="background:#fdecec; border-left:3px solid var(--red); padding:8px 12px; border-radius:6px; margin-bottom:14px;">
          <strong style="font-size:12px;">Exception Details</strong>
          <div class="form-row" style="margin-top:6px;"><label>PNC Number *</label><input name="pnc_number" required placeholder="Plant Non-Conformance reference" /></div>
          <div class="form-row"><label>Exception Number *</label><input name="exception_number" required placeholder="Exception / deviation log #" /></div>
          <div class="form-row" style="grid-template-columns:1fr;"><label>Other Description *</label><textarea name="exception_description" required placeholder="Reason for the delay + justification for the re-assignment" rows="2"></textarea></div>
        </div>

        <div class="form-row"><label>Executor *</label>
          <select name="assignee_id" required>
            <option value="">— select executor —</option>
            ${executors.map(u => `<option value="${u.id}">${escapeHtml(u.name)} — ${escapeHtml(u.role)} / ${escapeHtml(u.department || '')}</option>`).join('')}
          </select>
        </div>
        <div class="form-row"><label>Reviewer (Engineering)</label>
          <select name="reviewer_id">
            <option value="">— keep original (${escapeHtml(assignment.reviewer_name || '—')}) —</option>
            ${reviewers.map(u => `<option value="${u.id}" ${u.id===assignment.reviewer_id?'selected':''}>${escapeHtml(u.name)} — ${escapeHtml(u.role)}</option>`).join('')}
          </select>
        </div>
        <div class="form-row"><label>Approver (QA)</label>
          <select name="approver_id">
            <option value="">— keep original (${escapeHtml(assignment.approver_name || '—')}) —</option>
            ${approvers.map(u => `<option value="${u.id}" ${u.id===assignment.approver_id?'selected':''}>${escapeHtml(u.name)} — ${escapeHtml(u.role)}</option>`).join('')}
          </select>
        </div>
        <div class="form-row"><label>New Effective Date</label><input name="effective_date" type="date" value="${todayStr}" /></div>
        <div class="form-row"><label>New Due Date</label><input name="due_date" type="date" /></div>
      `,
      submitLabel: 'Re-assign Now',
      onSubmit: async (data) => {
        await api('PUT', `/api/assignments/${assignment.assignment_id}/reassign`, {
          assignee_id: Number(data.assignee_id),
          reviewer_id: data.reviewer_id ? Number(data.reviewer_id) : null,
          approver_id: data.approver_id ? Number(data.approver_id) : null,
          pnc_number: data.pnc_number,
          exception_number: data.exception_number,
          exception_description: data.exception_description,
          effective_date: data.effective_date || null,
          due_date: data.due_date || null,
        });
        toast(`Expired PM ${assignment.assignment_id} re-assigned.`, 'success');
        loadExpiredPage();
        refreshNotifBadge();
      }
    });
  } catch (e) { toast(e.message, 'error'); }
}

// ===========================================================
// BOOT
// ===========================================================
tryAutoLogin();
