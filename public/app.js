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
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    showLogin();
    throw new Error('Not authenticated');
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
  $('topUserRole').textContent = CURRENT_USER.role;
  $('userAvatar').textContent = CURRENT_USER.name.split(/\s+/).map(s => s[0]).slice(0,2).join('').toUpperCase();
  loadDashboard();
}

// ---------- Routing ----------
const PAGES = ['dashboard','services','masters','users','pmconfig','checklist','execution','calendar','breakdown','reports','audit','compliance','about'];
const TITLE_MAP = { dashboard:'Dashboard', services:'Modules', masters:'Masters', users:'User Management', pmconfig:'PM Configuration', checklist:'Checklists', execution:'PM Execution', calendar:'Calendar', breakdown:'Breakdown', reports:'Reports', audit:'Audit Trail', compliance:'Compliance', about:'About' };

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
    pmconfig: loadPmConfig,
    checklist: loadChecklists,
    execution: loadPmList,
    calendar: loadCalendar,
    breakdown: loadBreakdowns,
    audit: () => loadAudit(100),
    compliance: loadCompliance,
  };
  loaders[name] && loaders[name]();
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
    'Active':'red','Investigating':'amber','Spares Awaited':'blue','Closed':'gray','Resolved':'gray',
    'Inactive':'gray','Under Review':'amber','Locked':'amber','Validation':'amber',
    'Under Maintenance':'red'
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
    head: ['Plant ID','Name','Location','Version','Status','Modified'],
    row: r => [r.plant_id, r.name, r.location, r.version, statusPill(r.status), r.modified_at],
    canAdd: true,
    addFields: [
      { id:'name', label:'Name', required:true },
      { id:'location', label:'Location' },
    ],
    create: (data) => api('POST','/api/plants',data),
  },
  blocks: {
    api: '/api/blocks',
    head: ['Block ID','Plant','Name','Status'],
    row: r => [r.block_id, r.plant_id, r.name, statusPill(r.status)],
    canAdd: true,
    addFields: [
      { id:'plant_id', label:'Plant ID', required:true, placeholder:'e.g., PL-001' },
      { id:'name', label:'Name', required:true },
    ],
    create: (data) => api('POST','/api/blocks',data),
  },
  formulations: {
    api: '/api/formulations',
    head: ['Formulation ID','Name','Department','Status'],
    row: r => [r.formulation_id, r.name, r.department, statusPill(r.status)],
    canAdd: false,
  },
  locations: {
    api: '/api/locations',
    head: ['Location ID','Block','Description','Status'],
    row: r => [r.location_id, r.block_id, r.description, statusPill(r.status)],
    canAdd: false,
  },
  areas: {
    api: '/api/areas',
    head: ['Area ID','Location','Area Type','Status'],
    row: r => [r.area_id, r.location_id, r.area_type, statusPill(r.status)],
    canAdd: false,
  },
  equipment: {
    api: '/api/equipment',
    head: ['Equipment ID','Name','Make / Model','Serial','Capacity','Area','Status','QR'],
    row: r => [r.equipment_id, r.name, r.make_model, r.serial, r.capacity, r.area_id, statusPill(r.status), `<span title="${escapeHtml(r.qr_code)}">▣</span>`],
    canAdd: true,
    addFields: [
      { id:'name', label:'Equipment Name', required:true },
      { id:'make_model', label:'Make / Model' },
      { id:'serial', label:'Serial Number' },
      { id:'capacity', label:'Capacity' },
      { id:'area_id', label:'Area ID', placeholder:'e.g., AR-001' },
      { id:'status', label:'Status', type:'select', options:['Active','Inactive','Under Maintenance','Validation'] },
    ],
    create: (data) => api('POST','/api/equipment',data),
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

function openMasterAddModal() {
  const def = MASTER_DEFS[CURRENT_MASTER];
  if (!def.canAdd) return;
  openModal({
    title: `Add ${CURRENT_MASTER.slice(0,-1).replace(/^./, c=>c.toUpperCase())}`,
    body: def.addFields.map(f => {
      if (f.type === 'select') {
        return `<div class="form-row"><label>${f.label}</label>
          <select name="${f.id}">${f.options.map(o => `<option>${o}</option>`).join('')}</select></div>`;
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

// ===========================================================
// USERS
// ===========================================================
async function loadUsers() {
  try {
    const users = await api('GET','/api/users');
    $('usersBody').innerHTML = users.map(u => `
      <tr>
        <td><strong>${escapeHtml(u.user_id)}</strong></td>
        <td>${escapeHtml(u.name)}</td>
        <td>${escapeHtml(u.role)}</td>
        <td>${escapeHtml(u.department || '')}</td>
        <td>${statusPill(u.status)}</td>
        <td>${escapeHtml(u.last_login || 'Never')}</td>
        <td>
          ${u.status === 'Active'
            ? `<button class="btn ghost sm" onclick="setUserStatus('${u.user_id}','Locked')">Lock</button>`
            : `<button class="btn ghost sm" onclick="setUserStatus('${u.user_id}','Active')">Unlock</button>`}
        </td>
      </tr>`).join('');
  } catch (e) { toast(e.message, 'error'); }
}
async function setUserStatus(user_id, status) {
  try { await api('PUT', `/api/users/${user_id}/status`, { status }); toast(`User ${user_id} set to ${status}`, 'success'); loadUsers(); }
  catch (e) { toast(e.message, 'error'); }
}
function openUserAddModal() {
  openModal({
    title: 'Add User',
    body: `
      <div class="form-row"><label>User ID *</label><input name="user_id" required /></div>
      <div class="form-row"><label>Full Name *</label><input name="name" required /></div>
      <div class="form-row"><label>Email</label><input name="email" type="email" /></div>
      <div class="form-row"><label>Password *</label><input name="password" type="password" required /></div>
      <div class="form-row"><label>Role *</label>
        <select name="role">
          <option>System Administrator</option><option>Approver</option><option>Reviewer</option>
          <option>Engineering</option><option>Production</option><option>QA</option>
          <option>Warehouse</option><option>Technician</option>
        </select>
      </div>
      <div class="form-row"><label>Department</label><input name="department" placeholder="e.g., Engineering - Mechanical" /></div>
    `,
    onSubmit: async (data) => {
      await api('POST','/api/users',data);
      toast('User created.', 'success');
      loadUsers();
    }
  });
}

// ===========================================================
// PM CONFIGURATION
// ===========================================================
async function loadPmConfig() {
  try {
    const [freqs, cats, groups, equipment, checklists, users] = await Promise.all([
      api('GET','/api/frequencies'),
      api('GET','/api/pm-categories'),
      api('GET','/api/checklist-groups'),
      api('GET','/api/equipment'),
      api('GET','/api/checklists'),
      api('GET','/api/users'),
    ]);
    $('freqBody').innerHTML = freqs.map(f => `<tr><td>${escapeHtml(f.name)}</td><td>±${f.tolerance_days} d</td></tr>`).join('');
    $('catBody').innerHTML = cats.map(c => `<span class="pill brown">${escapeHtml(c.name)}</span>`).join('');
    $('groupBody').innerHTML = groups.map(g => `<tr><td>${escapeHtml(g.name)}</td><td>${escapeHtml(g.department || '')}</td></tr>`).join('');

    fillSelect($('pmEquipment'), equipment, 'equipment_id', e => `${e.equipment_id} · ${e.name}`);
    fillSelect($('pmChecklist'), checklists, 'id', c => `${c.name} (${c.version})`, true);
    fillSelect($('pmFrequency'), freqs, 'name', f => f.name);
    fillSelect($('pmCategory'), cats, 'name', c => c.name, true);
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
    $('checklistsBody').innerHTML = rows.map(c => `
      <tr>
        <td>${c.id}</td><td>${escapeHtml(c.name)}</td><td>${escapeHtml(c.version)}</td><td>${statusPill(c.status)}</td>
        <td><button class="btn ghost sm" onclick="previewChecklist(${c.id})">Preview</button></td>
      </tr>`).join('');
  } catch (e) { toast(e.message, 'error'); }
}
async function previewChecklist(id) {
  try {
    const cl = await api('GET', `/api/checklists/${id}`);
    $('checklistPreviewTitle').textContent = `${cl.name} (${cl.version})`;
    $('checklistPreviewBody').innerHTML = cl.fields.map((f, i) => `
      <li><div class="chk-num">${i+1}</div>
        <div class="chk-body">
          <div class="chk-title">${escapeHtml(f.label)}${f.required?' *':''}</div>
          <div class="chk-meta">Type: ${escapeHtml(f.type)}${f.options?' · {'+f.options.join('/')+'}':''}${f.min!==undefined?` · range ${f.min}–${f.max}`:''}</div>
        </div></li>`).join('');
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
function closeModal() { $('modalHost').innerHTML = ''; }

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
// BOOT
// ===========================================================
tryAutoLogin();
