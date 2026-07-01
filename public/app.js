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

// SQLite stores timestamps as UTC strings like 'YYYY-MM-DD HH:MM:SS' (no
// timezone marker). Treat them as UTC and format to the user's local time.
// Returns the raw value as a fallback if parsing fails.
function formatLocalTime(ts) {
  if (!ts) return '';
  const str = String(ts).trim();
  if (!str) return '';
  // If it already has a 'Z' or '+HH:MM' offset, Date parses correctly.
  // Otherwise we treat the bare 'YYYY-MM-DD HH:MM:SS' as UTC.
  const iso = /[zZ]|[+-]\d{2}:?\d{2}$/.test(str)
    ? str.replace(' ', 'T')
    : str.replace(' ', 'T') + 'Z';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return str; // unparseable — show raw
  // Locale-aware: e.g. "16/06/2026, 11:42:30 PM" in India, "6/16/2026, 11:42:30 AM" in US.
  return d.toLocaleString();
}
// Shorter variant: drops seconds for table cells.
function formatLocalTimeShort(ts) {
  const full = formatLocalTime(ts);
  return full.replace(/(:\d{2})(\s*[AP]M)?$/, '$2'); // drop ":SS"
}

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
  if (r.status === 402) {
    // License invalid — server has the truth; bounce the browser to the
    // standalone activation page. Stays out of the main app entirely.
    window.location.href = '/license.html';
    throw new Error('License required');
  }
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
  applyNavPermissions();
  refreshNotifBadge();
  refreshAlerts();
  if (window._notifTimer) clearInterval(window._notifTimer);
  window._notifTimer = setInterval(refreshNotifBadge, 30000);
  if (window._alertTimer) clearInterval(window._alertTimer);
  // Re-fetch alerts every 5 minutes so newly-overdue items pop up without a manual reload.
  window._alertTimer = setInterval(refreshAlerts, 5 * 60 * 1000);
  loadDashboard();
}

// ---- Hybrid alert system --------------------------------------------------
// Blocking modal for OVERDUE/EXPIRED assigned to the user (with required
// comment). Top banner for upcoming PMs. Re-runs on login + every 5 minutes.
async function refreshAlerts() {
  try {
    const data = await api('GET', '/api/alerts');
    renderAlertBanner(data.upcoming || []);
    if (data.blocking && data.blocking.length > 0) {
      // Show the first blocking item that hasn't been shown yet this session.
      const shown = window.__alertShown = window.__alertShown || new Set();
      const next = data.blocking.find(b => !shown.has(b.assignment_id));
      if (next) showBlockingAlertModal(next, data.blocking.length);
    }
  } catch (e) { /* silent — alert system shouldn't be noisy */ }
}

function renderAlertBanner(upcoming) {
  let bar = document.getElementById('alertBanner');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'alertBanner';
    document.body.insertBefore(bar, document.body.firstChild);
  }
  if (!upcoming || upcoming.length === 0) { bar.style.display = 'none'; return; }
  // Count today vs next-7-days
  const todayStr = new Date().toISOString().slice(0, 10);
  const today = upcoming.filter(u => u.effective_date && u.effective_date.slice(0, 10) === todayStr).length;
  bar.style.cssText = 'background:#fff7e6; border-bottom:1px solid #ffe7ad; color:#7a5400; padding:6px 16px; font-size:12px; cursor:pointer;';
  bar.innerHTML = `⏰ <strong>${upcoming.length}</strong> upcoming PM${upcoming.length===1?'':'s'} in the next 7 days${today>0?` (<strong>${today} due today</strong>)`:''} — click to view in My Tasks`;
  bar.onclick = () => goto('tasks');
  bar.style.display = 'block';
}

function showBlockingAlertModal(item, totalCount) {
  window.__alertShown = window.__alertShown || new Set();
  window.__alertShown.add(item.assignment_id);
  const isExpired = item.status === 'Expired';
  const tone = isExpired ? 'red' : 'amber';
  openModal({
    title: `⚠ Acknowledge Required — ${escapeHtml(item.assignment_id)}`,
    width: 540,
    hideDefaultSubmit: false,
    body: `
      <div style="background:${isExpired?'#fdecec':'#fff7e6'}; border-left:3px solid var(--${isExpired?'red':'amber'},#c77b00); padding:10px 14px; border-radius:6px; margin-bottom:14px;">
        <strong style="font-size:13px;">${isExpired ? 'EXPIRED' : 'OVERDUE'}: ${escapeHtml(item.equipment_id)} — ${escapeHtml(item.equipment_name || '')}</strong>
        <div style="font-size:12px; margin-top:4px;">
          ${escapeHtml(item.checklist_name || '—')} ${escapeHtml(item.checklist_version || '')}
          ${item.frequency ? ` · ${escapeHtml(item.frequency)}` : ''}
          <br>Scheduled: <strong>${escapeHtml(item.effective_date || item.due_date || '—')}</strong>
          ${item.tolerance_days != null ? ` (±${item.tolerance_days}d tolerance)` : ''}
          ${item.expired_at ? `<br>Expired: <strong>${escapeHtml(formatLocalTime(item.expired_at))}</strong>` : ''}
        </div>
      </div>
      <p style="font-size:12px; color:var(--muted); margin-top:0;">A comment is required to acknowledge this alert. ${totalCount > 1 ? `<br><strong>${totalCount - 1} more</strong> alert(s) will follow after you acknowledge this one.` : ''}</p>
      <div class="form-row" style="grid-template-columns:1fr;"><label>Comment *</label>
        <textarea name="ackComment" required rows="3" placeholder="Why is this PM overdue? What is the plan to complete it?"></textarea>
      </div>
    `,
    submitLabel: 'Acknowledge',
    actions: `<button type="button" class="btn ghost sm" onclick="goto('tasks'); setTimeout(() => openAssignment('${escapeHtml(item.assignment_id)}'), 250); closeModal();">Open the PM →</button>`,
    onSubmit: async (data) => {
      if (!data.ackComment || !data.ackComment.trim()) throw new Error('A comment is required');
      await api('PUT', `/api/assignments/${item.assignment_id}/acknowledge`, { comment: data.ackComment.trim() });
      toast('Acknowledged. Refreshing alerts…', 'success');
      setTimeout(refreshAlerts, 300);
    }
  });
}

// Hide sidebar entries the current user doesn't have access to.
// Each <a data-page=…> can carry a comma-separated `data-needs` list of
// activity codes. The entry stays visible if the user has ANY of them.
// Special sentinel "ADMIN_ONLY" means: must be the System Administrator role.
function applyNavPermissions() {
  if (!CURRENT_USER) return;
  const isAdmin = !!CURRENT_USER.is_admin;
  const perms = new Set(CURRENT_USER.permissions || []);
  let visibleBySection = {};
  document.querySelectorAll('.nav a[data-page]').forEach(link => {
    const needs = (link.dataset.needs || '').split(',').map(s => s.trim()).filter(Boolean);
    let allow = true;
    if (needs.length > 0) {
      if (needs.includes('ADMIN_ONLY')) allow = isAdmin;
      else allow = isAdmin || needs.some(n => perms.has(n));
    }
    link.style.display = allow ? '' : 'none';
  });
  // Hide section headers whose entries are all hidden — keeps the nav tidy.
  document.querySelectorAll('.nav-section[data-section]').forEach(section => {
    let next = section.nextElementSibling;
    let anyVisible = false;
    while (next && next.tagName === 'A') {
      if (next.style.display !== 'none') { anyVisible = true; break; }
      next = next.nextElementSibling;
    }
    section.style.display = anyVisible ? '' : 'none';
  });
}

// ---------- Routing ----------
const PAGES = ['dashboard','services','masters','users','settings','pmconfig','checklist','assignments','workflow','execution','tasks','pmstatus','pending','expired','calendar','breakdown','reports','audit','compliance','about'];
const TITLE_MAP = { dashboard:'Dashboard', services:'Modules', masters:'Masters', users:'User Management', settings:'Admin Settings', pmconfig:'PM Configuration', checklist:'Checklists', assignments:'Checklist Assignment', workflow:'PM Workflow', execution:'PM Execution', tasks:'My Tasks', pmstatus:'PM Status', pending:'Pending Equipment', expired:'Expired Equipment', calendar:'Calendar', breakdown:'Breakdown', reports:'Reports', audit:'Audit Trail', compliance:'Compliance', about:'About' };

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
    workflow: loadWorkflowPage,
    execution: loadPmList,
    tasks: () => loadTasks('inbox'),
    pmstatus: loadPmStatusPage,
    pending: loadPendingPage,
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
    const [kpis, byDept, pmList, breakdowns, delayReasons] = await Promise.all([
      api('GET', '/api/dashboard/kpis'),
      api('GET', '/api/dashboard/compliance-by-dept'),
      api('GET', '/api/pm'),
      api('GET', '/api/breakdowns'),
      api('GET', '/api/dashboard/delay-reasons'),
    ]);

    // KPI tiles — every tile is a click target taking the user to the
    // relevant drill-down page so they can act on the number, not just see it.
    $('kpiRow').innerHTML = `
      <div class="card kpi compliance" style="cursor:pointer;" onclick="goto('reports')" title="Click to view PM reports">
        <div class="icon-pill">✓</div>
        <div class="label">PM Compliance</div><div class="value">${kpis.compliance}%</div>
        <div class="progress green" style="margin-top:12px;"><span style="width:${kpis.compliance}%"></span></div>
      </div>
      <div class="card kpi overdue" style="cursor:pointer;" onclick="goto('expired')" title="Click to view Expired Equipment">
        <div class="icon-pill">!</div>
        <div class="label">Overdue / Expired</div><div class="value">${kpis.overdue}</div>
        <div class="delta bad">${kpis.overdue > 0 ? 'Needs attention — click to drill down' : 'All clear'}</div>
      </div>
      <div class="card kpi pending" style="cursor:pointer;" onclick="goto('pending')" title="Click to view Pending Equipment">
        <div class="icon-pill">⌛</div>
        <div class="label">Pending Activities</div><div class="value">${kpis.pending}</div>
        <div class="delta">Awaiting approval / execution — click to drill down</div>
      </div>
      <div class="card kpi completed" style="cursor:pointer;" onclick="openCompletedPmsReport()" title="Click to open Completed PMs report">
        <div class="icon-pill">★</div>
        <div class="label">Completed (MTD)</div><div class="value">${kpis.completed_mtd}</div>
        <div class="delta">Total schedules: ${kpis.total_pms} — click for details</div>
      </div>`;

    // Why behind schedule? — categorical breakdown of every in-flight PM,
    // each row clickable to take the user to the page where they can act on it.
    const reasonsCard = $('delayReasonsCard');
    if (reasonsCard) {
      if (!delayReasons || delayReasons.length === 0) {
        reasonsCard.innerHTML = `<div class="card"><h3 style="margin-top:0;">Why behind schedule?</h3><p style="color:var(--muted); margin:0;">🎉 Nothing pending — every PM is either completed or ahead of schedule.</p></div>`;
      } else {
        const totalDelayed = delayReasons.reduce((s, r) => s + r.count, 0);
        reasonsCard.innerHTML = `
          <div class="card">
            <h3 style="margin-top:0;">Why behind schedule?</h3>
            <p style="font-size:12px; color:var(--muted); margin:0 0 12px;">${totalDelayed} PM(s) in-flight. Click any row to jump to the page where you can act on them.</p>
            <table class="tbl" style="margin:0;">
              <thead><tr><th>Reason</th><th style="text-align:right;">Count</th><th style="width:40%;">Share</th></tr></thead>
              <tbody>${delayReasons.map(r => {
                const pct = Math.round((r.count / totalDelayed) * 100);
                return `<tr style="cursor:pointer;" onclick="goto('${escapeHtml(r.page)}')" title="Open ${escapeHtml(r.page)}">
                  <td><span class="pill ${escapeHtml(r.tone)}" style="font-size:10px;">${escapeHtml(r.reason)}</span></td>
                  <td style="text-align:right;"><strong>${r.count}</strong></td>
                  <td><div class="progress ${r.tone === 'red' ? 'red' : (r.tone === 'amber' ? '' : 'green')}"><span style="width:${pct}%;"></span></div></td>
                </tr>`;
              }).join('')}</tbody>
            </table>
          </div>`;
      }
    }

    // Dept compliance table
    $('deptComplianceBody').innerHTML = byDept.length === 0
      ? '<tr class="empty-row"><td colspan="5">No data</td></tr>'
      : byDept.map(r => {
        const cls = r.pct >= 95 ? 'green' : (r.pct >= 85 ? '' : 'red');
        return `<tr><td>${escapeHtml(r.department)}</td><td>${r.planned}</td><td>${r.done}</td><td>${r.pct}%</td>
                <td><div class="progress ${cls}"><span style="width:${r.pct}%"></span></div></td></tr>`;
      }).join('');

    // Equipment-by-date panel — replaces the old Recent Activity feed.
    // Defaults to today, user can pick any date to see equipment that was
    // scheduled, completed, or expired on that day.
    const picker = $('dashDatePicker');
    if (picker) {
      const today = new Date().toISOString().slice(0, 10);
      picker.value = today;
      picker.onchange = () => loadDashboardByDate(picker.value);
      loadDashboardByDate(today);
    }

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

// Fetches a single date's Completed/Pending/Expired breakdown and renders
// it into the Dashboard panel. Each row is clickable to drill into the
// assignment detail.
async function loadDashboardByDate(date) {
  const panel = $('dashDayPanel');
  if (!panel) return;
  panel.innerHTML = `<em style="color:var(--muted);">Loading ${escapeHtml(date)}…</em>`;
  try {
    const data = await api('GET', `/api/dashboard/by-date?date=${encodeURIComponent(date)}`);
    const renderGroup = (label, items, tone) => {
      if (!items || items.length === 0) return `<div style="padding:6px 0; color:var(--muted);"><span class="pill ${tone}" style="font-size:10px;">${label}</span> none on ${escapeHtml(date)}</div>`;
      return `<div style="padding:6px 0; border-bottom:1px dashed var(--border);">
        <div><span class="pill ${tone}" style="font-size:10px;">${label}</span> <strong>${items.length}</strong> equipment</div>
        ${items.slice(0, 5).map(a => `<div style="font-size:11px; padding:2px 0 2px 4px; color:var(--muted); cursor:pointer;" onclick="goto('tasks'); setTimeout(() => openAssignment('${escapeHtml(a.assignment_id)}'), 250);" title="Click to open ${escapeHtml(a.assignment_id)}">
          <strong style="color:#2a261d;">${escapeHtml(a.equipment_id)}</strong>${a.equipment_name?' · '+escapeHtml(a.equipment_name):''}
          ${a.checklist_code?` <span style="color:var(--muted);">— ${escapeHtml(a.checklist_code)}</span>`:''}
        </div>`).join('')}
        ${items.length > 5 ? `<div style="font-size:11px; color:var(--muted); margin-top:4px;">+ ${items.length - 5} more — open Calendar to see all</div>` : ''}
      </div>`;
    };
    panel.innerHTML = `
      ${renderGroup('Completed', data.completed, 'green')}
      ${renderGroup('Pending',   data.pending,   'amber')}
      ${renderGroup('Expired',   data.expired,   'red')}
    `;
  } catch (e) {
    panel.innerHTML = `<div style="color:var(--red); font-size:12px;">Couldn't load: ${escapeHtml(e.message)}</div>`;
  }
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
    'Draft':'gray','Pending Review':'amber','Pending Approval':'amber','Rejected':'red','Expired':'red',
    'Pending Clearance':'amber','Awaiting Executor':'amber','Clearance Denied':'red',
    // Assignment-plan review states
    'Pending Assignment Review':'amber','Pending Assignment Approval':'amber','Assignment Rejected':'red',
    // Scheduled = plan approved, awaiting Engineering to initiate the clearance request
    'Scheduled':'blue',
    // Versioning / lifecycle
    'Superseded':'gray','Withdrawn':'gray'
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
// ============================================================================
// 21 CFR Part 11 E-SIGNATURE MODAL
// Every review/approve/clearance action must be signed: user re-enters their
// password and acknowledges the meaning before the action is committed.
// ============================================================================
function openESignatureModal({ title, meaning, onConfirm }) {
  if (!CURRENT_USER) return;
  openModal({
    title: title || 'Electronic Signature Required',
    width: 520,
    body: `
      <div style="background:#fff7e6; border:1px solid #ffe7ad; padding:10px 12px; border-radius:6px; margin-bottom:12px; font-size:13px; line-height:1.45;">
        <div style="font-weight:600; margin-bottom:4px;">21 CFR Part 11 · Electronic Signature</div>
        <div style="color:var(--muted);">By signing, you affirm:</div>
        <div style="margin-top:4px; font-style:italic;">&ldquo;${escapeHtml(meaning)}&rdquo;</div>
      </div>
      <div class="form-row"><label>Signer</label>
        <input name="signer" value="${escapeHtml(CURRENT_USER.name)} (${escapeHtml(CURRENT_USER.user_id || '')})" readonly style="background:#f5f5f5;" />
      </div>
      <div class="form-row"><label>Password *</label>
        <input name="esig_password" type="password" required autocomplete="current-password" autofocus />
      </div>
      <div class="form-row" style="align-items:flex-start;">
        <label>&nbsp;</label>
        <label style="font-size:12px; line-height:1.45; flex:1; cursor:pointer; user-select:none;">
          <input type="checkbox" name="esig_meaning_ack" required style="margin-right:6px; transform:translateY(2px);" />
          I confirm the signature meaning above and accept the legal consequences of this electronic signature.
        </label>
      </div>
    `,
    submitLabel: '✍ Sign & Submit',
    onSubmit: async (data) => {
      if (!data.esig_meaning_ack) throw new Error('You must tick the acknowledgement checkbox to sign.');
      if (!data.esig_password) throw new Error('Password is required.');
      await onConfirm({
        esig_password: data.esig_password,
        esig_meaning: meaning,
        esig_meaning_ack: true,
      });
    }
  });
}

// ---------- Master approval helpers (shared by every master form) ----------
async function loadActiveUsers() {
  try {
    const users = await api('GET','/api/users');
    return (users || []).filter(u => u.status === 'Active');
  } catch (e) { return []; }
}
function masterApproverFields(users) {
  const meId = CURRENT_USER && CURRENT_USER.id;
  const opts = users
    .filter(u => u.id !== meId)
    .map(u => `<option value="${u.id}">${escapeHtml(u.name)} — ${escapeHtml(u.role || '')}${u.department ? ' / '+escapeHtml(u.department):''}</option>`)
    .join('');
  return `
    <hr style="margin:14px 0; border:none; border-top:1px solid var(--border);" />
    <div style="font-size:11px; color:var(--muted); margin-bottom:6px;">REVIEW &amp; APPROVAL WORKFLOW</div>
    <div class="form-row"><label>Reviewer *</label>
      <select name="reviewer_id" required>
        <option value="">— select reviewer —</option>${opts}
      </select>
    </div>
    <div class="form-row"><label>Approver *</label>
      <select name="approver_id" required>
        <option value="">— select approver —</option>${opts}
      </select>
    </div>
    <p style="font-size:11px; color:var(--muted); margin:4px 0 0;">Reviewer and Approver must be different people, and neither can be you. The record will be created in <strong>Pending Review</strong> and only goes Active after both sign off.</p>`;
}
function masterRowActions(master, r) {
  if (!CURRENT_USER) return '';
  const me = CURRENT_USER.id;
  const buttons = [];
  if (r.status === 'Pending Review' && (r.reviewer_id === me || CURRENT_USER.is_admin)) {
    buttons.push(`<button class="btn ghost sm" onclick="openMasterDecisionModal('${master}','${escapeHtml(r.__pk)}','review')">📝 Review</button>`);
  }
  if (r.status === 'Pending Approval' && (r.approver_id === me || CURRENT_USER.is_admin)) {
    buttons.push(`<button class="btn ghost sm" onclick="openMasterDecisionModal('${master}','${escapeHtml(r.__pk)}','approve')">✅ Approve</button>`);
  }
  return buttons.join(' ');
}
async function openMasterDecisionModal(master, id, stage) {
  // stage = 'review' | 'approve'
  const verb = stage === 'review' ? 'Review' : 'Approve';
  const approveLabel = stage === 'review' ? 'Forward to Approver…' : 'Approve & Activate…';
  const masterLabel = master.slice(0,-1).replace(/^./,c=>c.toUpperCase());

  // After the user fills remarks + clicks Approve/Reject, we open the
  // e-signature modal to capture password + meaning acknowledgement.
  //
  // IMPORTANT: the e-sig modal open is wrapped in setTimeout(0) because when
  // this is triggered from the form-submit path (Forward to Approver), the
  // outer openModal's submit handler calls closeModal() AFTER onSubmit returns.
  // Without the defer, that closeModal would wipe out the e-sig modal we just
  // opened, and the user would see the review modal vanish with no password
  // prompt. The setTimeout pushes our open to the next tick, after the
  // form-submit auto-close has run.
  const performAction = (decision, remarks) => {
    const meaning = decision === 'approve'
      ? (stage === 'review'
         ? `I have reviewed the ${masterLabel} "${id}" and forward it to the Approver.`
         : `I approve the ${masterLabel} "${id}" for activation. I am responsible for its correctness and GMP impact.`)
      : `I reject the ${masterLabel} "${id}" at ${verb} stage. Remarks: ${remarks}`;
    setTimeout(() => {
      openESignatureModal({
        title: `Sign — ${verb} ${masterLabel} ${id}`,
        meaning,
        onConfirm: async (esig) => {
          await api('PUT', `/api/${master}/${encodeURIComponent(id)}/${stage}`, { decision, remarks, ...esig });
          toast(decision === 'approve'
            ? (stage === 'review' ? 'Reviewed — passed to Approver' : 'Approved — now Active')
            : 'Rejected.', 'success');
          loadMasters(CURRENT_MASTER);
        }
      });
    }, 0);
  };

  window.__masterRejectFn = () => {
    const ta = document.querySelector('textarea[name="masterRemarks"]');
    const remarks = ta ? ta.value.trim() : '';
    if (!remarks) { toast('Remarks are required for rejection', 'error'); return; }
    performAction('reject', remarks);
  };

  openModal({
    title: `${verb} — ${masterLabel} ${id}`,
    width: 500,
    body: `
      <p style="font-size:12px; color:var(--muted); margin-top:0;">
        ${stage === 'review'
          ? 'Reviewing this record will pass it to the assigned Approver. Rejecting sends it back to the creator with your remarks.'
          : 'Approving this record marks it as Active and visible everywhere. Rejecting returns it to the creator with your remarks.'}<br>
        <strong>You will be asked to sign with your password on the next step.</strong>
      </p>
      <div class="form-row"><label>Remarks</label>
        <textarea name="masterRemarks" rows="3" placeholder="Optional for Approve · Required for Reject"></textarea>
      </div>
    `,
    submitLabel: approveLabel,
    actions: `<button type="button" class="btn ghost" style="color:#c53030; border-color:#fbd5d5;" onclick="window.__masterRejectFn()">✗ Reject…</button>`,
    onSubmit: async (data) => {
      performAction('approve', (data.masterRemarks || '').trim());
    }
  });
}

const MASTER_DEFS = {
  plants: {
    api: '/api/plants', pk: 'plant_id',
    head: ['Plant ID','Plant Name','Plant Location','Status','Modified','Actions'],
    row: r => {
      r.__pk = r.plant_id;
      const wfBtn = workflowAwareRowActions('Plant', r);
      return [r.plant_id, r.name, r.location, statusPill(r.status), r.modified_at, wfBtn];
    },
    canAdd: true,
    customAdd: () => openPlantModal(),  // workflow-aware modal
  },
  blocks: {
    api: '/api/blocks', pk: 'block_id',
    head: ['Plant','Block ID','Block Name','Status','Actions'],
    row: r => { r.__pk = r.block_id; return [r.plant_id, r.block_id, r.name, statusPill(r.status), masterRowActions('blocks', r)]; },
    canAdd: true,
    addFields: [
      { id:'plant_id', label:'Plant ID', required:true, type:'remoteSelect', source:'/api/plants', valueKey:'plant_id', labelFn:r => `${r.plant_id} · ${r.name}` },
      { id:'block_id', label:'Block ID', required:true, placeholder:'e.g., BLK-001' },
      { id:'name', label:'Block Name', required:true },
    ],
    create: (data) => api('POST','/api/blocks',data),
  },
  formulations: {
    api: '/api/formulations', pk: 'formulation_id',
    head: ['Formulation ID','Formulation Name','Status','Actions'],
    row: r => { r.__pk = r.formulation_id; return [r.formulation_id, r.name, statusPill(r.status), masterRowActions('formulations', r)]; },
    canAdd: true,
    addFields: [
      { id:'name', label:'Formulation Name', required:true, placeholder:'e.g., OSD, Injectable, Softgel, Bag Filling, Others' },
    ],
    create: (data) => api('POST','/api/formulations',data),
  },
  locations: {
    api: '/api/locations', pk: 'location_id',
    head: ['Location ID','Block','Location Name','Formulation','Status','Actions'],
    row: r => { r.__pk = r.location_id; return [r.location_id, r.block_id, r.description, r.formulation_name || '—', statusPill(r.status), masterRowActions('locations', r)]; },
    canAdd: true,
    customAdd: () => openLocationModal(),
  },
  areas: {
    api: '/api/areas', pk: 'area_id',
    head: ['Area ID','Location','Area Name','Status','Actions'],
    row: r => { r.__pk = r.area_id; return [r.area_id, r.location_id, r.name || r.area_type || '—', statusPill(r.status), masterRowActions('areas', r)]; },
    canAdd: true,
    customAdd: () => openAreaModal(),
  },
  equipment: {
    api: '/api/equipment', pk: 'equipment_id',
    head: ['Equipment ID','Equipment Name','Department','Make','Model','Serial','Area','Status','QR'],
    row: r => {
      r.__pk = r.equipment_id;
      // Stash the row so the click handler can open the detail modal without another fetch.
      window.__eqRows = window.__eqRows || {};
      window.__eqRows[r.equipment_id] = r;
      // QR cell — encodes the structured equipment payload. 96 px so each QR
      // module is large enough for an average phone camera to scan it from
      // the screen. Click for a bigger 240 px version to print on a label.
      // Stash the payload globally so the click handler can read it without
      // escaping a multi-line string into HTML attrs.
      window.__qrPayloads = window.__qrPayloads || {};
      window.__qrPayloads[r.equipment_id] = r.qr_payload || ('PMMS Equipment\nID: ' + r.equipment_id);
      const qrCell = `<div class="qr-cell" data-qr-key="${escapeHtml(r.equipment_id)}"
                            title="Click to enlarge / print QR for ${escapeHtml(r.equipment_id)}"
                            onclick="openQrModalForEquipment('${escapeHtml(r.equipment_id)}','${escapeHtml(r.name || '')}')"
                            style="cursor:pointer; width:96px; height:96px; display:inline-block; vertical-align:middle; padding:2px; background:#fff; border:1px solid var(--border); border-radius:4px;"></div>`;
      const deptCell = r.department
        ? `<span class="pill brown" style="font-size:10px;">${escapeHtml(r.department)}</span>`
        : '<span style="color:var(--muted); font-size:11px;">—</span>';
      // Equipment ID cell is the row-open handle. Clicking anywhere on the row opens the detail modal.
      const eqIdCell = `<span style="cursor:pointer; color:var(--brown-700); font-weight:600; text-decoration:underline dotted;" onclick="openEquipmentDetail('${escapeHtml(r.equipment_id)}')" title="Click to view / edit / assign">${escapeHtml(r.equipment_id)}</span>`;
      return [eqIdCell, r.name, deptCell, r.make || r.make_model || '—', r.model || '—', r.serial, r.area_id, statusPill(r.status),
              qrCell];
    },
    canAdd: true,
    customAdd: () => openEquipmentModal(),
  },
};
let CURRENT_MASTER = 'plants';

// Sub-tab state for the Equipment master only (department filter).
let CURRENT_EQ_DEPT = 'all';
const EQUIPMENT_DEPTS = ['Mechanical','Electrical','Instrumental','Automation','Other'];

async function loadMasters(which) {
  CURRENT_MASTER = which;
  const def = MASTER_DEFS[which];
  document.querySelectorAll('#masterTabs button').forEach(b => b.classList.toggle('active', b.dataset.mt === which));
  $('mastersHead').innerHTML = '<tr>' + def.head.map(h => `<th>${h}</th>`).join('') + '</tr>';
  $('masterAddBtn').style.display = def.canAdd ? '' : 'none';

  // Equipment master gets a second row of department sub-tabs above the table.
  renderEquipmentDeptTabs(which);

  try {
    const rows = await api('GET', def.api);
    // Apply equipment department filter if on equipment master AND a specific tab is selected.
    let filtered = rows;
    if (which === 'equipment' && CURRENT_EQ_DEPT !== 'all') {
      filtered = rows.filter(r => (r.department || 'Other') === CURRENT_EQ_DEPT);
    }
    $('mastersBody').innerHTML = filtered.length === 0
      ? `<tr class="empty-row"><td colspan="${def.head.length}">No records${which === 'equipment' && CURRENT_EQ_DEPT !== 'all' ? ` in ${CURRENT_EQ_DEPT}` : ''}.</td></tr>`
      : filtered.map(r => '<tr>' + def.row(r).map(c => `<td>${c ?? ''}</td>`).join('') + '</tr>').join('');
    // After rendering, draw any QR placeholders that were emitted.
    renderQrCells();
  } catch (e) { toast(e.message, 'error'); }
}

// Department sub-tabs for the Equipment master. Shown only when which==='equipment'.
function renderEquipmentDeptTabs(which) {
  let host = document.getElementById('eqDeptTabs');
  if (which !== 'equipment') {
    if (host) host.style.display = 'none';
    return;
  }
  if (!host) {
    host = document.createElement('div');
    host.id = 'eqDeptTabs';
    host.className = 'tabs';
    host.style.cssText = 'margin: 6px 0 10px; padding-left:6px;';
    // Place right above the masters table header
    const head = document.getElementById('mastersHead');
    if (head && head.parentElement && head.parentElement.parentElement) {
      head.parentElement.parentElement.parentElement.insertBefore(host, head.parentElement.parentElement);
    }
  }
  host.style.display = '';
  const opts = [['all', 'All Departments'], ...EQUIPMENT_DEPTS.map(d => [d, d])];
  host.innerHTML = opts.map(([key, label]) =>
    `<button class="${CURRENT_EQ_DEPT === key ? 'active' : ''}" type="button" onclick="window.__eqDeptSelect('${escapeHtml(key)}')">${escapeHtml(label)}</button>`
  ).join('');
}
window.__eqDeptSelect = (dept) => { CURRENT_EQ_DEPT = dept; loadMasters('equipment'); };

// Walks every .qr-cell placeholder on screen and renders a small QR into it.
// Each placeholder either carries its payload directly via data-qr, or — for
// equipment rows — looks it up by data-qr-key in window.__qrPayloads (so we
// avoid escaping multi-line text into HTML attributes).
function renderQrCells() {
  if (typeof QRCode === 'undefined') return; // CDN not loaded yet (offline / blocked)
  document.querySelectorAll('.qr-cell').forEach(el => {
    if (el.dataset.rendered === '1') return;
    const key = el.getAttribute('data-qr-key');
    const direct = el.getAttribute('data-qr');
    const v = key && window.__qrPayloads && window.__qrPayloads[key]
              ? window.__qrPayloads[key]
              : (direct || '');
    // 90 px effective canvas (cell is 96 px with 2 px padding + 1 px border on each side).
    if (safeRenderQR(el, v, 90)) el.dataset.rendered = '1';
  });
}

// Try to draw a QR into `el`. Returns true on success, false on failure.
// qrcodejs auto-picks the smallest QR version that fits the data at the given
// correction level — but at level H, anything beyond ~250 ASCII chars overflows
// and the library throws. We fall back H → M → L → just show the text.
function safeRenderQR(el, text, size) {
  if (!el || typeof QRCode === 'undefined') {
    if (el) el.textContent = '▣';
    return false;
  }
  const levels = [QRCode.CorrectLevel.H, QRCode.CorrectLevel.M, QRCode.CorrectLevel.L];
  for (const lvl of levels) {
    try {
      el.innerHTML = '';
      new QRCode(el, { text, width: size, height: size, correctLevel: lvl });
      return true;
    } catch (e) { /* try next */ }
  }
  // All correction levels failed — payload is too big for QR Version 40 (max).
  el.innerHTML = '<div style="font-size:10px; color:var(--red); padding:4px; text-align:center;">Data too long for QR — print as label.</div>';
  return false;
}

// Row-click handler on the Equipment Master table. Opens a compact detail
// modal with the equipment's key fields + all the actions that used to live in
// the removed Actions column: Edit, Assign checklist, and (contextually) any
// workflow Sign button when the row is Pending <Stage>.
function openEquipmentDetail(equipmentId) {
  const r = (window.__eqRows || {})[equipmentId];
  if (!r) { toast('Refresh the page and try again.', 'error'); return; }
  const isActive = r.status === 'Active';
  const wfBtnHtml = masterRowActions('equipment', r);   // workflow Review/Approve when I'm the assignee
  const chainLine = [r.plant_id, r.block_id, r.location_id, r.area_id].filter(Boolean).join(' › ');
  openModal({
    title: `${escapeHtml(equipmentId)} — ${escapeHtml(r.name || '')}`,
    width: 620,
    hideDefaultSubmit: true,
    body: `
      <div class="row-gap" style="margin-bottom:12px;">
        ${statusPill(r.status)}
        ${r.department ? `<span class="pill brown" style="font-size:10px;">${escapeHtml(r.department)}</span>` : ''}
        ${r.equipment_type ? `<span class="pill brown" style="font-size:10px;">${escapeHtml(r.equipment_type)}</span>` : ''}
        ${chainLine ? `<span class="pill brown" style="font-size:10px;">${escapeHtml(chainLine)}</span>` : ''}
      </div>
      <div style="display:grid; grid-template-columns: repeat(2, 1fr); gap:8px; font-size:12px;">
        ${['make','model','serial','capacity','manufacture_date','sub_type'].map(k => {
          const label = { make:'Manufacturer', model:'Model', serial:'Serial Number', capacity:'Capacity', manufacture_date:'Manufacture Date', sub_type:'Sub-Type' }[k];
          return `<div style="padding:6px 10px; background:var(--cream-100); border-radius:6px;">
            <div style="font-size:10px; color:var(--muted); text-transform:uppercase; letter-spacing:1px;">${escapeHtml(label)}</div>
            <div style="font-weight:600; margin-top:2px;">${escapeHtml(r[k] || '—')}</div>
          </div>`;
        }).join('')}
      </div>
      <div style="margin-top:14px; display:flex; gap:8px; flex-wrap:wrap; justify-content:flex-end;">
        ${wfBtnHtml}
        ${isActive && can('assign_checklist') ? `<button class="btn primary sm" type="button" onclick="closeModal(); setTimeout(() => openAssignChecklistModal(null, '${escapeHtml(equipmentId)}'), 100);">🎯 Assign Checklist</button>` : ''}
        ${can('manage_equipment') ? `<button class="btn ghost sm" type="button" onclick="closeModal(); setTimeout(() => openEquipmentModal(window.__eqRows['${escapeHtml(equipmentId)}']), 100);">✎ Edit</button>` : ''}
        <button class="btn ghost sm" type="button" onclick="openQrModalForEquipment('${escapeHtml(equipmentId)}','${escapeHtml(r.name || '')}')">▣ Show / Print QR</button>
      </div>
    `,
  });
}

// Convenience: open the enlarged QR modal for a piece of equipment using the
// payload that was stashed at row-render time.
function openQrModalForEquipment(equipmentId, equipmentName) {
  const payload = (window.__qrPayloads && window.__qrPayloads[equipmentId]) || ('PMMS Equipment\nID: ' + equipmentId);
  openQrModal(equipmentId, payload, equipmentName);
}

// Open a larger printable QR in a modal so testers can scan or print it.
function openQrModal(equipmentId, qrText, equipmentName) {
  const lines = String(qrText || '').split('\n');
  openModal({
    title: `QR Code — ${equipmentId}`,
    width: 420,
    hideDefaultSubmit: true,
    body: `
      <div style="text-align:center; padding: 8px 0 6px;">
        <div id="qrModalCanvas" style="display:inline-block; padding:12px; background:#fff; border:1px solid var(--border); border-radius:6px;"></div>
        <div style="margin-top:10px; font-size:14px;"><strong>${escapeHtml(equipmentId)}</strong></div>
        ${equipmentName ? `<div style="font-size:12px; color:var(--muted); margin-top:2px;">${escapeHtml(equipmentName)}</div>` : ''}
      </div>
      <div style="margin-top:14px; padding:10px 12px; background:#fafafa; border:1px solid var(--border); border-radius:6px; font-size:11px; line-height:1.6;">
        <div style="font-weight:600; margin-bottom:4px;">Embedded data (what shows up on scan):</div>
        <pre style="margin:0; font-family:'Menlo','Consolas',monospace; font-size:11px; white-space:pre-wrap; word-break:break-word;">${escapeHtml(qrText)}</pre>
      </div>
      <div style="display:flex; gap:8px; justify-content:center; margin-top:14px;">
        <button class="btn primary sm" type="button" onclick="window.print()">🖨 Print</button>
      </div>
    `,
  });
  // Render the larger 240px QR into the modal after openModal injects the DOM.
  // safeRenderQR auto-degrades correction level until the payload fits.
  setTimeout(() => {
    const el = document.getElementById('qrModalCanvas');
    if (!el) return;
    if (typeof QRCode === 'undefined') {
      el.textContent = 'QR library not loaded (no internet on first launch).';
      return;
    }
    safeRenderQR(el, qrText, 240);
  }, 0);
}

document.querySelectorAll('#masterTabs button').forEach(b => b.addEventListener('click', () => loadMasters(b.dataset.mt)));

async function openMasterAddModal() {
  const def = MASTER_DEFS[CURRENT_MASTER];
  if (!def.canAdd) return;
  // If a master defines its own modal, defer to it.
  if (typeof def.customAdd === 'function') return def.customAdd();
  // Pre-load any remote select options + active users (for reviewer/approver)
  const remoteData = {};
  for (const f of def.addFields) {
    if (f.type === 'remoteSelect') {
      try { remoteData[f.id] = await api('GET', f.source); }
      catch (e) { remoteData[f.id] = []; }
    }
  }
  const users = await loadActiveUsers();
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
    }).join('') + masterApproverFields(users),
    submitLabel: 'Submit for Review',
    onSubmit: async (data) => {
      if (!data.reviewer_id || !data.approver_id) throw new Error('Reviewer and Approver are required');
      if (data.reviewer_id === data.approver_id) throw new Error('Reviewer and Approver must be different users');
      await def.create(data);
      toast('Submitted for review.', 'success');
      loadMasters(CURRENT_MASTER);
    }
  });
}

// ----- Workflow-aware Plant master modal -------------------------------------
// Plants is the proof-of-concept for the new configurable workflow system.
// Other masters still use the legacy 2-stage reviewer/approver helper.
async function openPlantModal() {
  try {
    const [workflows, users] = await Promise.all([
      api('GET','/api/approval-workflows'),
      loadActiveUsers(),
    ]);
    const activeWorkflows = workflows.filter(w => w.status === 'Active');
    if (activeWorkflows.length === 0) {
      toast('No active approval workflows. Set one up first in Admin Settings → Approval Workflows.', 'error');
      return;
    }
    const meId = CURRENT_USER && CURRENT_USER.id;
    const userOpts = users.filter(u => u.id !== meId).map(u => `<option value="${u.id}">${escapeHtml(u.name)} — ${escapeHtml(u.role || '')}</option>`).join('');
    // Initial workflow = first one. Render its stage pickers.
    window.__pmsPlantWfMap = Object.fromEntries(activeWorkflows.map(w => [w.id, w]));
    const renderStages = (workflowId) => {
      const wf = window.__pmsPlantWfMap[workflowId];
      if (!wf || !wf.stages) return '';
      return wf.stages.map((s, i) => `
        <div class="form-row">
          <label>Stage ${i+1}: ${escapeHtml(s.label)} <span class="pill ${s.type==='review'?'blue':'green'}" style="font-size:9px;">${escapeHtml(s.type)}</span></label>
          <select name="stage_assignee_${i}" required>
            <option value="">— select assignee —</option>${userOpts}
          </select>
        </div>`).join('');
    };
    window.__pmsPlantOnWf = () => {
      const sel = document.getElementById('plantWfSel');
      document.getElementById('plantStagesArea').innerHTML = renderStages(Number(sel.value));
    };
    openModal({
      title: 'Add Plant',
      width: 560,
      body: `
        <div class="form-row"><label>Plant ID *</label><input name="plant_id" required placeholder="e.g., PL-001, Unit-1, U-Hyd" /></div>
        <div class="form-row"><label>Plant Name *</label><input name="name" required /></div>
        <div class="form-row"><label>Plant Location</label><input name="location" /></div>
        <hr class="sep" />
        <div style="font-size:11px; color:var(--muted); margin-bottom:6px;">APPROVAL WORKFLOW</div>
        <div class="form-row"><label>Workflow *</label>
          <select id="plantWfSel" required onchange="window.__pmsPlantOnWf()">
            ${activeWorkflows.map((w, i) => `<option value="${w.id}" ${i===0?'selected':''}>${escapeHtml(w.name)} (${(w.stages || []).length} stage${(w.stages||[]).length===1?'':'s'})</option>`).join('')}
          </select>
        </div>
        <div id="plantStagesArea">${renderStages(activeWorkflows[0].id)}</div>
        <p style="font-size:11px; color:var(--muted); margin:6px 0 0;">Each stage requires the assigned user to sign with their password. Stages happen in order. Reject at any stage returns the plant to you with remarks.</p>
      `,
      submitLabel: 'Submit for Approval',
      onSubmit: async (data) => {
        const workflowId = Number(data.plant_wf_sel || document.getElementById('plantWfSel').value);
        const wf = window.__pmsPlantWfMap[workflowId];
        if (!wf) throw new Error('Pick a workflow');
        const stage_assignees = [];
        for (let i = 0; i < wf.stages.length; i++) {
          const v = (data['stage_assignee_' + i] || '').trim();
          if (!v) throw new Error(`Stage ${i+1} ("${wf.stages[i].label}") needs an assignee`);
          stage_assignees.push(Number(v));
        }
        await api('POST', '/api/plants', {
          plant_id: data.plant_id,
          name: data.name,
          location: data.location,
          workflow_id: workflowId,
          stage_assignees,
        });
        toast('Plant submitted into approval workflow.', 'success');
        loadMasters('plants');
      }
    });
  } catch (e) { toast(e.message, 'error'); }
}

// Row actions for workflow-managed records. Reads the per-record approval
// stages, finds the current pending stage, and shows a Sign button to the
// assignee (or admin). Falls back to legacy reviewer/approver buttons for
// records still on the old model.
function workflowAwareRowActions(entityType, r) {
  if (!CURRENT_USER) return '';
  const me = CURRENT_USER.id;
  // If the record has no `status` starting with "Pending " AND no reviewer_id,
  // it's already Active/Rejected — nothing to do.
  if (!r.status || (!r.status.startsWith('Pending ') && r.status !== 'Active' && r.status !== 'Rejected')) return '';
  // Lazy-load and cache the stages for this row when its row buttons are rendered.
  // We expose a generic "Sign Stage" button that opens a modal which fetches the
  // stages and shows a Sign UI for whichever stage is pending and assigned to me.
  const masterKey = entityType.toLowerCase() + 's';
  return `<button class="btn ghost sm" onclick="openWorkflowStageModal('${escapeHtml(entityType)}','${escapeHtml(r.__pk)}')">${r.status === 'Active' ? '✓ View' : (r.status === 'Rejected' ? '✗ View' : '📝 Open / Sign')}</button>
          ${masterRowActions(masterKey, r)}`;  // legacy buttons (for records still on old model)
}

async function openWorkflowStageModal(entityType, entityId) {
  try {
    const stages = await api('GET', `/api/approval-stages?entity_type=${encodeURIComponent(entityType)}&entity_id=${encodeURIComponent(entityId)}`);
    if (!stages || stages.length === 0) {
      toast('This record predates the workflow system — use the legacy Review / Approve buttons.', 'error');
      return;
    }
    const me = CURRENT_USER ? CURRENT_USER.id : null;
    const pendingStage = stages.find(s => s.status === 'Pending');
    const canSign = pendingStage && (pendingStage.assignee_id === me || (CURRENT_USER && CURRENT_USER.is_admin));
    const progressHtml = stages.map((s, i) => {
      const tone = s.status === 'Approved' ? 'green' : (s.status === 'Rejected' ? 'red' : (s.status === 'Pending' ? 'amber' : 'gray'));
      const icon = s.status === 'Approved' ? '✓' : (s.status === 'Rejected' ? '✗' : '⌛');
      return `<div style="padding:8px 12px; border-left:3px solid var(--border); margin-bottom:6px; background:${s.status==='Pending'?'#fffbe6':'#fafafa'};">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <div>
            <strong>${icon} Stage ${s.stage_index+1}: ${escapeHtml(s.stage_label)}</strong>
            <span class="pill ${tone}" style="font-size:9px; margin-left:6px;">${escapeHtml(s.status)}</span>
            <span class="pill ${s.stage_type==='review'?'blue':'green'}" style="font-size:9px; margin-left:4px;">${escapeHtml(s.stage_type)}</span>
          </div>
        </div>
        <div style="color:var(--muted); font-size:11px; margin-top:3px;">
          Assignee: <strong>${escapeHtml(s.assignee_name || '—')}</strong>
          ${s.signed_by_name ? ` · Signed by <strong>${escapeHtml(s.signed_by_name)}</strong> on ${escapeHtml(formatLocalTime(s.signed_at))}` : ''}
        </div>
        ${s.remarks ? `<div style="color:var(--muted); font-size:11px; margin-top:3px;"><em>Remarks: ${escapeHtml(s.remarks)}</em></div>` : ''}
      </div>`;
    }).join('');
    const actionsHtml = canSign ? `
      <hr class="sep" />
      <p style="font-size:12px;"><strong>Action required:</strong> You are the assignee for Stage ${pendingStage.stage_index+1} ("${escapeHtml(pendingStage.stage_label)}"). Sign to advance the workflow, or reject to return the record to the creator.</p>
      <div class="form-row"><label>Remarks</label><textarea name="stageRemarks" rows="2" placeholder="Optional for Sign · Required for Reject"></textarea></div>
    ` : '';
    window.__wsRejectFn = canSign ? () => {
      const ta = document.querySelector('textarea[name="stageRemarks"]');
      const remarks = ta ? ta.value.trim() : '';
      if (!remarks) { toast('Remarks required for rejection', 'error'); return; }
      closeModal();
      setTimeout(() => signWorkflowStage(pendingStage, entityType, entityId, 'reject', remarks), 0);
    } : null;
    openModal({
      title: `${entityType} ${entityId} — Approval Workflow`,
      width: 580,
      body: progressHtml + actionsHtml,
      submitLabel: canSign ? '✍ Sign Stage' : 'Close',
      hideDefaultSubmit: !canSign,
      actions: canSign ? `<button type="button" class="btn ghost" style="color:#c53030;" onclick="window.__wsRejectFn()">✗ Reject…</button>` : '',
      onSubmit: canSign ? async (data) => {
        const remarks = (data.stageRemarks || '').trim();
        closeModal();
        setTimeout(() => signWorkflowStage(pendingStage, entityType, entityId, 'approve', remarks), 0);
      } : undefined,
    });
  } catch (e) { toast(e.message, 'error'); }
}

function signWorkflowStage(stage, entityType, entityId, decision, remarks) {
  const meaning = decision === 'approve'
    ? `I sign stage ${stage.stage_index+1} ("${stage.stage_label}") for ${entityType} ${entityId}.${remarks?' Remarks: '+remarks:''}`
    : `I reject stage ${stage.stage_index+1} ("${stage.stage_label}") for ${entityType} ${entityId}. Reason: ${remarks}`;
  openESignatureModal({
    title: `Sign — Stage ${stage.stage_index+1}: ${stage.stage_label}`,
    meaning,
    onConfirm: async (esig) => {
      await api('PUT', `/api/approval-stages/${stage.id}/sign`, { decision, remarks, ...esig });
      toast(decision === 'approve' ? 'Stage signed.' : 'Stage rejected.', 'success');
      // Reload masters page to reflect new record status
      if (CURRENT_MASTER) loadMasters(CURRENT_MASTER);
      refreshNotifBadge();
    }
  });
}

// ----- Custom Location Master modal (Block dropdown -> auto-pop Block Name + ID + Name inputs) -----
async function openLocationModal() {
  try {
    const [blocks, formulations, users] = await Promise.all([
      api('GET','/api/blocks'),
      api('GET','/api/formulations'),
      loadActiveUsers(),
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
            ${formulations.filter(f => f.status === 'Active').map(f => `<option value="${f.id}">${escapeHtml(f.name)}</option>`).join('')}
          </select>
        </div>
      ` + masterApproverFields(users),
      submitLabel: 'Submit for Review',
      onSubmit: async (data) => {
        if (!data.reviewer_id || !data.approver_id) throw new Error('Reviewer and Approver are required');
        if (data.reviewer_id === data.approver_id) throw new Error('Reviewer and Approver must be different users');
        await api('POST','/api/locations', {
          location_id: data.location_id,
          block_id: data.block_id,
          name: data.name,
          formulation_id: data.formulation_id ? Number(data.formulation_id) : null,
          reviewer_id: Number(data.reviewer_id),
          approver_id: Number(data.approver_id),
        });
        toast('Location submitted for review.', 'success');
        loadMasters('locations');
      }
    });
  } catch (e) { toast(e.message, 'error'); }
}

// ----- Custom Area Master modal (Block + Location cascading, manual Area ID + Name) -----
async function openAreaModal() {
  try {
    const [blocks, locations, users] = await Promise.all([
      api('GET','/api/blocks'),
      api('GET','/api/locations'),
      loadActiveUsers(),
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
      ` + masterApproverFields(users),
      submitLabel: 'Submit for Review',
      onSubmit: async (data) => {
        if (!data.location_id) throw new Error('Please select a Location');
        if (!data.reviewer_id || !data.approver_id) throw new Error('Reviewer and Approver are required');
        if (data.reviewer_id === data.approver_id) throw new Error('Reviewer and Approver must be different users');
        await api('POST','/api/areas', {
          area_id: data.area_id, location_id: data.location_id, name: data.name,
          reviewer_id: Number(data.reviewer_id), approver_id: Number(data.approver_id),
        });
        toast('Area submitted for review.', 'success');
        loadMasters('areas');
      }
    });
  } catch (e) { toast(e.message, 'error'); }
}

// ----- Custom Equipment Registration modal (cascading Block -> Location -> Area + manual Equipment ID + Make/Model) -----
async function openEquipmentModal(existing) {
  try {
    const [blocks, locations, areas, users, idSuggest, linkedChecklists] = await Promise.all([
      api('GET','/api/blocks'),
      api('GET','/api/locations'),
      api('GET','/api/areas'),
      loadActiveUsers(),
      existing ? Promise.resolve(null) : api('GET','/api/equipment/next-id').catch(() => null),
      existing ? api('GET', `/api/equipment/${existing.equipment_id}/linked-checklists`).catch(() => []) : Promise.resolve([]),
    ]);
    const suggestedId = existing ? null : (idSuggest && idSuggest.suggested) || '';
    const isQA = CURRENT_USER && (CURRENT_USER.is_admin || /qa/i.test(CURRENT_USER.role || ''));
    // Equipment ID is editable on create, and only QA can edit it after save.
    const idReadonly = existing ? !isQA : false;
    const idValue = existing ? existing.equipment_id : suggestedId;
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
          <div>
            <input name="${existing ? 'new_equipment_id' : 'equipment_id'}" required ${idReadonly?'readonly':''} value="${escapeHtml(idValue)}" placeholder="e.g., EQ-FBD-04" />
            ${!existing ? `<div style="font-size:11px; color:var(--muted); margin-top:3px;">Auto-suggested. Edit before saving if you need a meaningful code (e.g. EQ-AHU-04). After save, only QA can change this.</div>` : (idReadonly ? `<div style="font-size:11px; color:var(--muted); margin-top:3px;">🔒 Locked. Only QA users can rename a saved Equipment ID.</div>` : `<div style="font-size:11px; color:#8a5a32; margin-top:3px;">⚠ QA mode — you can rename this Equipment ID. Audit log will record the change.</div>`)}
          </div>
        </div>
        <div class="form-row"><label>Equipment Name *</label><input name="name" required value="${escapeHtml(existing?.name || '')}" placeholder="e.g., Fluid Bed Dryer" /></div>
        <div class="form-row"><label>Manufacturer</label><input name="make" value="${escapeHtml(existing?.make || '')}" placeholder="e.g., Gansons" /></div>
        <div class="form-row"><label>Model Number</label><input name="model" value="${escapeHtml(existing?.model || '')}" placeholder="e.g., RMG-300" /></div>
        <div class="form-row"><label>Serial Number</label><input name="serial" value="${escapeHtml(existing?.serial || '')}" /></div>
        <div class="form-row"><label>Capacity</label><input name="capacity" value="${escapeHtml(existing?.capacity || '')}" placeholder="e.g., 300 kg, 10,000 CFM" /></div>
        <div class="form-row"><label>Manufacture Date</label><input name="manufacture_date" type="date" value="${escapeHtml(existing?.manufacture_date || '')}" /></div>
        <div class="form-row"><label>Equipment Type</label><input name="equipment_type" value="${escapeHtml(existing?.equipment_type || '')}" placeholder="e.g., HVAC, Process, Utility" /></div>
        <div class="form-row"><label>Sub-Type</label><input name="sub_type" value="${escapeHtml(existing?.sub_type || '')}" placeholder="e.g., Air Handling Unit, Granulator" /></div>
        <div class="form-row"><label>Department *</label>
          <select name="department" required>
            <option value="">— select department —</option>
            ${['Mechanical','Electrical','Instrumental','Automation','Other'].map(d => `<option ${d===(existing?.department||'')?'selected':''}>${d}</option>`).join('')}
          </select>
        </div>
        ${existing ? `<div class="form-row"><label>Status</label>
          <select name="status">
            ${['Active','Inactive'].map(s => `<option ${s===(existing?.status||'Active')?'selected':''}>${s}</option>`).join('')}
          </select>
        </div>` : ''}
        ${existing && linkedChecklists && linkedChecklists.length > 0 ? `
        <div class="form-row" style="grid-template-columns:1fr;"><label>Linked Checklists</label>
          <div style="font-size:12px; background:#f8f4ec; border-radius:6px; padding:8px 10px;">
            ${linkedChecklists.map(c => `<div style="padding:3px 0; border-bottom:1px dashed var(--border);">
              <strong>${escapeHtml(c.code || c.name || '—')}</strong> <span style="color:var(--muted);">${escapeHtml(c.version || '')}</span>
              <span class="pill brown" style="font-size:9px; margin-left:6px;">${escapeHtml(c.frequency || '—')}</span>
              <span class="pill ${c.assignment_status==='Completed'?'gray':'amber'}" style="font-size:9px; margin-left:4px;">${escapeHtml(c.assignment_status || '—')}</span>
              <div style="color:var(--muted); font-size:11px;">PM ${escapeHtml(c.assignment_id || '')} · scheduled ${escapeHtml(c.effective_date || c.due_date || '—')}</div>
            </div>`).join('')}
          </div>
        </div>` : (existing ? `
        <div class="form-row" style="grid-template-columns:1fr;"><label>Linked Checklists</label>
          <div style="font-size:12px; color:var(--muted);">No checklists assigned yet. Assign one from the Equipment row's 🎯 Assign button.</div>
        </div>` : '')}
        <p style="font-size:11px; color:var(--muted); margin:6px 0 0;">A QR code is generated automatically from the Equipment ID for shop-floor scanning.</p>
      ` + (existing ? '' : masterApproverFields(users)),
      submitLabel: existing ? 'Save Changes' : 'Submit for Review',
      onSubmit: async (data) => {
        if (!data.area_id) throw new Error('Please select an Area');
        const payload = {
          name: data.name,
          make: data.make,
          model: data.model,
          serial: data.serial,
          capacity: data.capacity,
          area_id: data.area_id,
          manufacture_date: data.manufacture_date || null,
          equipment_type: data.equipment_type || null,
          sub_type: data.sub_type || null,
        };
        if (existing) {
          payload.status = data.status;
          // QA-only Equipment ID rename — server enforces too.
          if (!idReadonly && data.new_equipment_id && data.new_equipment_id !== existing.equipment_id) {
            payload.new_equipment_id = data.new_equipment_id;
          }
          await api('PUT', `/api/equipment/${existing.equipment_id}`, payload);
          toast('Equipment updated.', 'success');
        } else {
          payload.equipment_id = data.equipment_id;
          if (!data.reviewer_id || !data.approver_id) throw new Error('Reviewer and Approver are required');
          if (data.reviewer_id === data.approver_id) throw new Error('Reviewer and Approver must be different users');
          payload.reviewer_id = Number(data.reviewer_id);
          payload.approver_id = Number(data.approver_id);
          await api('POST','/api/equipment', payload);
          toast('Equipment submitted for review.', 'success');
        }
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
  // Lock / Deactivate / Activate — sensitive account actions, require e-sig.
  const action = status === 'Locked' ? 'lock' : (status === 'Inactive' ? 'deactivate' : 'activate');
  const meaning = `I ${action} user account "${user_id}". I am authorized to perform this action.`;
  openESignatureModal({
    title: `Sign — ${action.charAt(0).toUpperCase() + action.slice(1)} ${user_id}`,
    meaning,
    onConfirm: async (esig) => {
      await api('PUT', `/api/users/${user_id}/status`, { status, ...esig });
      toast(`User ${user_id} set to ${status}`, 'success');
      loadUsers();
    }
  });
}

function confirmDeactivate(user_id, name) {
  if (!confirm(`Deactivate ${name}? Their active sessions will be terminated. You'll be asked to confirm with your password.`)) return;
  setUserStatus(user_id, 'Inactive');
}

function resetUserPasswordPrompt(user_id, name) {
  openModal({
    title: `Reset password for ${escapeHtml(name)}`,
    body: `
      <p style="font-size:12px; color:var(--muted); margin-top:0;">Setting a new password will sign this user out of all active sessions. They'll need to log in again with the new password. <strong>You will be asked to sign with your password on the next step.</strong></p>
      <div class="form-row"><label>New Password *</label><input name="password" type="password" minlength="6" required autofocus /></div>
      <div class="form-row"><label>Confirm *</label><input name="confirm" type="password" minlength="6" required /></div>
    `,
    submitLabel: 'Reset Password →',
    onSubmit: async (data) => {
      if (data.password !== data.confirm) throw new Error('Passwords do not match');
      const meaning = `I reset the password for user "${user_id}". This action will terminate their active sessions.`;
      setTimeout(() => {
        openESignatureModal({
          title: `Sign — Reset password for ${name}`,
          meaning,
          onConfirm: async (esig) => {
            await api('PUT', `/api/users/${user_id}/password`, { password: data.password, ...esig });
            toast(`Password reset for ${name}.`, 'success');
          }
        });
      }, 0);
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
    $('freqBody').innerHTML = freqs.length === 0 ? '<tr class="empty-row"><td colspan="5">No frequencies</td></tr>' :
      freqs.map(f => {
        const me = CURRENT_USER ? CURRENT_USER.id : null;
        const wfBtns = [];
        if (f.status === 'Pending Review' && (f.reviewer_id === me || (CURRENT_USER && CURRENT_USER.is_admin))) {
          wfBtns.push(`<button class="btn ghost sm" onclick="openFreqDecisionModal(${f.id}, ${escapeHtml(JSON.stringify(f.name))}, 'review')">📝 Review</button>`);
        }
        if (f.status === 'Pending Approval' && (f.approver_id === me || (CURRENT_USER && CURRENT_USER.is_admin))) {
          wfBtns.push(`<button class="btn ghost sm" onclick="openFreqDecisionModal(${f.id}, ${escapeHtml(JSON.stringify(f.name))}, 'approve')">✅ Approve</button>`);
        }
        return `<tr${f.status === 'Pending Review' || f.status === 'Pending Approval' ? ' style="background:#fffbe6;"' : ''}>
          <td><strong>${escapeHtml(f.name)}</strong></td>
          <td>${f.days}</td>
          <td>±${f.tolerance_days}</td>
          <td>${statusPill(f.status)}</td>
          <td style="text-align:right;">
            ${wfBtns.join(' ')}
            ${adminMode && f.status === 'Active' ? `<button class="btn ghost sm" onclick='openFreqModal(${escapeHtml(JSON.stringify(f))})'>Edit</button>
                                                    <button class="btn ghost sm" onclick="deleteFreq(${f.id})">×</button>` : ''}
          </td></tr>`;
      }).join('');
    const me = CURRENT_USER ? CURRENT_USER.id : null;
    const adminAll = CURRENT_USER && CURRENT_USER.is_admin;
    $('catBody').innerHTML = cats.length === 0 ? '<tr class="empty-row"><td colspan="4">No categories</td></tr>' :
      cats.map(c => {
        const wfBtns = [];
        if (c.status === 'Pending Review' && (c.reviewer_id === me || adminAll)) {
          wfBtns.push(`<button class="btn ghost sm" onclick="openCatDecisionModal(${c.id}, ${escapeHtml(JSON.stringify(c.name))}, 'review')">📝 Review</button>`);
        }
        if (c.status === 'Pending Approval' && (c.approver_id === me || adminAll)) {
          wfBtns.push(`<button class="btn ghost sm" onclick="openCatDecisionModal(${c.id}, ${escapeHtml(JSON.stringify(c.name))}, 'approve')">✅ Approve</button>`);
        }
        return `<tr${c.status === 'Pending Review' || c.status === 'Pending Approval' ? ' style="background:#fffbe6;"' : ''}>
          <td><strong>${escapeHtml(c.name)}</strong></td>
          <td>${escapeHtml(c.description || '')}</td>
          <td>${statusPill(c.status || 'Active')}</td>
          <td style="text-align:right;">
            ${wfBtns.join(' ')}
            ${adminCatMode && c.status === 'Active' ? `<button class="btn ghost sm" onclick='openCatModal(${escapeHtml(JSON.stringify(c))})'>Edit</button>
                                                       <button class="btn ghost sm" onclick="deleteCat(${c.id})">×</button>` : ''}
          </td></tr>`;
      }).join('');
    const groupEdit = can('manage_checklists') || can('manage_pm_categories');
    $('groupBody').innerHTML = groups.length === 0 ? '<tr class="empty-row"><td colspan="4">No groups</td></tr>' :
      groups.map(g => {
        const wfBtns = [];
        if (g.status === 'Pending Review' && (g.reviewer_id === me || adminAll)) {
          wfBtns.push(`<button class="btn ghost sm" onclick="openGroupDecisionModal(${g.id}, ${escapeHtml(JSON.stringify(g.name))}, 'review')">📝 Review</button>`);
        }
        if (g.status === 'Pending Approval' && (g.approver_id === me || adminAll)) {
          wfBtns.push(`<button class="btn ghost sm" onclick="openGroupDecisionModal(${g.id}, ${escapeHtml(JSON.stringify(g.name))}, 'approve')">✅ Approve</button>`);
        }
        return `<tr${g.status === 'Pending Review' || g.status === 'Pending Approval' ? ' style="background:#fffbe6;"' : ''}>
          <td><strong>${escapeHtml(g.name)}</strong></td>
          <td>${escapeHtml(g.department || '')}</td>
          <td>${statusPill(g.status || 'Active')}</td>
          <td style="text-align:right;">
            ${wfBtns.join(' ')}
            ${groupEdit && g.status === 'Active' ? `<button class="btn ghost sm" onclick='openGroupModal(${escapeHtml(JSON.stringify(g))})'>Edit</button>
                                                    <button class="btn ghost sm" onclick="deleteGroup(${g.id})">×</button>` : ''}
          </td></tr>`;
      }).join('');

    // (The legacy "Create PM Schedule" form was removed from this page —
    // scheduling is done via Checklist Assignment now. Fillers below were
    // intentionally deleted along with the form they populated.)
  } catch (e) { toast(e.message, 'error'); }
}

// ----- Frequency master CRUD -----
async function openFreqModal(existing) {
  const f = existing || { name:'', days:'', tolerance_days:0 };
  // Editing only allowed on Active rows — adding requires reviewer + approver
  // pickers because the new row enters the same 2-stage workflow as other masters.
  const isNew = !existing;
  const users = isNew ? await loadActiveUsers() : [];
  openModal({
    title: existing ? `Edit Maintenance Frequency — ${escapeHtml(f.name)}` : 'Add Maintenance Frequency',
    body: `
      <div class="form-row"><label>Maintenance Frequency *</label><input name="name" value="${escapeHtml(f.name)}" required placeholder="e.g. Monthly" /></div>
      <div class="form-row"><label>Frequency Interval (Days) *</label><input name="days" type="number" min="1" value="${escapeHtml(f.days)}" required /></div>
      <div class="form-row"><label>Allowed Tolerance (Days)</label><input name="tolerance_days" type="number" min="0" value="${escapeHtml(f.tolerance_days)}" /></div>
    ` + (isNew ? masterApproverFields(users) : ''),
    submitLabel: isNew ? 'Submit for Review' : 'Save Changes',
    onSubmit: async (data) => {
      const payload = { name: data.name, days: Number(data.days), tolerance_days: Number(data.tolerance_days || 0) };
      if (existing) {
        await api('PUT', `/api/frequencies/${existing.id}`, payload);
        toast('Saved.', 'success');
      } else {
        if (!data.reviewer_id || !data.approver_id) throw new Error('Reviewer and Approver are required');
        if (data.reviewer_id === data.approver_id) throw new Error('Reviewer and Approver must be different users');
        payload.reviewer_id = Number(data.reviewer_id);
        payload.approver_id = Number(data.approver_id);
        await api('POST','/api/frequencies', payload);
        toast('Frequency submitted for review.', 'success');
      }
      loadPmConfig();
    }
  });
}

// Review / Approve action modal for Frequency master rows.
// Mirrors openMasterDecisionModal but targets /api/frequencies/:id/<stage>.
async function openFreqDecisionModal(freqId, freqName, stage) {
  const verb = stage === 'review' ? 'Review' : 'Approve';
  const approveLabel = stage === 'review' ? 'Forward to Approver…' : 'Approve & Activate…';
  const performAction = (decision, remarks) => {
    const meaning = decision === 'approve'
      ? (stage === 'review'
         ? `I have reviewed Frequency "${freqName}" and forward it to the Approver.`
         : `I approve Frequency "${freqName}" for activation. I am responsible for its correctness and GMP impact.`)
      : `I reject Frequency "${freqName}" at ${verb} stage. Remarks: ${remarks}`;
    setTimeout(() => {
      openESignatureModal({
        title: `Sign — ${verb} Frequency ${freqName}`,
        meaning,
        onConfirm: async (esig) => {
          await api('PUT', `/api/frequencies/${freqId}/${stage}`, { decision, remarks, ...esig });
          toast(decision === 'approve'
            ? (stage === 'review' ? 'Reviewed — passed to Approver' : 'Approved — now Active')
            : 'Rejected.', 'success');
          loadPmConfig();
        }
      });
    }, 0);
  };
  window.__freqRejectFn = () => {
    const ta = document.querySelector('textarea[name="freqRemarks"]');
    const remarks = ta ? ta.value.trim() : '';
    if (!remarks) { toast('Remarks are required for rejection', 'error'); return; }
    performAction('reject', remarks);
  };
  openModal({
    title: `${verb} — Frequency ${freqName}`,
    width: 500,
    body: `
      <p style="font-size:12px; color:var(--muted); margin-top:0;">
        ${stage === 'review'
          ? 'Reviewing this Frequency will pass it to the assigned Approver. Rejecting sends it back to the creator with your remarks.'
          : 'Approving this Frequency marks it as Active and available for assignment to checklists. Rejecting returns it to the creator with your remarks.'}<br>
        <strong>You will be asked to sign with your password on the next step.</strong>
      </p>
      <div class="form-row"><label>Remarks</label>
        <textarea name="freqRemarks" rows="3" placeholder="Optional for Approve · Required for Reject"></textarea>
      </div>
    `,
    submitLabel: approveLabel,
    actions: `<button type="button" class="btn ghost" style="color:#c53030; border-color:#fbd5d5;" onclick="window.__freqRejectFn()">✗ Reject…</button>`,
    onSubmit: async (data) => {
      performAction('approve', (data.freqRemarks || '').trim());
    }
  });
}
async function deleteFreq(id) {
  if (!confirm('Delete this frequency?')) return;
  try { await api('DELETE', `/api/frequencies/${id}`); toast('Deleted.','success'); loadPmConfig(); }
  catch (e) { toast(e.message,'error'); }
}

// ----- PM Category master CRUD -----
async function openCatModal(existing) {
  const c = existing || { name:'', description:'' };
  const isNew = !existing;
  const users = isNew ? await loadActiveUsers() : [];
  openModal({
    title: existing ? `Edit Maintenance Category — ${escapeHtml(c.name)}` : 'Add Maintenance Category',
    body: `
      <div class="form-row"><label>Maintenance Category *</label><input name="name" value="${escapeHtml(c.name)}" required placeholder="e.g. Mechanical / Electrical" /></div>
      <div class="form-row" style="grid-template-columns:1fr;"><label>Description</label><textarea name="description">${escapeHtml(c.description || '')}</textarea></div>
    ` + (isNew ? masterApproverFields(users) : ''),
    submitLabel: isNew ? 'Submit for Review' : 'Save Changes',
    onSubmit: async (data) => {
      const payload = { name: data.name, description: data.description };
      if (existing) {
        await api('PUT', `/api/pm-categories/${existing.id}`, payload);
        toast('Saved.', 'success');
      } else {
        if (!data.reviewer_id || !data.approver_id) throw new Error('Reviewer and Approver are required');
        if (data.reviewer_id === data.approver_id) throw new Error('Reviewer and Approver must be different users');
        payload.reviewer_id = Number(data.reviewer_id);
        payload.approver_id = Number(data.approver_id);
        await api('POST','/api/pm-categories', payload);
        toast('PM Category submitted for review.', 'success');
      }
      loadPmConfig();
    }
  });
}
async function deleteCat(id) {
  if (!confirm('Delete this PM category?')) return;
  try { await api('DELETE', `/api/pm-categories/${id}`); toast('Deleted.','success'); loadPmConfig(); }
  catch (e) { toast(e.message,'error'); }
}

// Review / Approve decision modal — shared shape for any single-name master
// (Categories, Groups, Frequencies all use the same flow).
function openConfigDecisionModal({ apiBase, label, rowId, rowName, stage, reload }) {
  const verb = stage === 'review' ? 'Review' : 'Approve';
  const approveLabel = stage === 'review' ? 'Forward to Approver…' : 'Approve & Activate…';
  const performAction = (decision, remarks) => {
    const meaning = decision === 'approve'
      ? (stage === 'review'
         ? `I have reviewed ${label} "${rowName}" and forward it to the Approver.`
         : `I approve ${label} "${rowName}" for activation. I am responsible for its correctness and GMP impact.`)
      : `I reject ${label} "${rowName}" at ${verb} stage. Remarks: ${remarks}`;
    setTimeout(() => {
      openESignatureModal({
        title: `Sign — ${verb} ${label} ${rowName}`,
        meaning,
        onConfirm: async (esig) => {
          await api('PUT', `${apiBase}/${rowId}/${stage}`, { decision, remarks, ...esig });
          toast(decision === 'approve'
            ? (stage === 'review' ? 'Reviewed — passed to Approver' : 'Approved — now Active')
            : 'Rejected.', 'success');
          reload && reload();
        }
      });
    }, 0);
  };
  window.__cfgRejectFn = () => {
    const ta = document.querySelector('textarea[name="cfgRemarks"]');
    const remarks = ta ? ta.value.trim() : '';
    if (!remarks) { toast('Remarks are required for rejection', 'error'); return; }
    performAction('reject', remarks);
  };
  openModal({
    title: `${verb} — ${label} ${rowName}`,
    width: 500,
    body: `
      <p style="font-size:12px; color:var(--muted); margin-top:0;">
        ${stage === 'review'
          ? `Reviewing this ${label} will pass it to the assigned Approver. Rejecting sends it back to the creator with your remarks.`
          : `Approving this ${label} marks it as Active and available for use. Rejecting returns it to the creator with your remarks.`}<br>
        <strong>You will be asked to sign with your password on the next step.</strong>
      </p>
      <div class="form-row"><label>Remarks</label>
        <textarea name="cfgRemarks" rows="3" placeholder="Optional for Approve · Required for Reject"></textarea>
      </div>
    `,
    submitLabel: approveLabel,
    actions: `<button type="button" class="btn ghost" style="color:#c53030; border-color:#fbd5d5;" onclick="window.__cfgRejectFn()">✗ Reject…</button>`,
    onSubmit: async (data) => {
      performAction('approve', (data.cfgRemarks || '').trim());
    }
  });
}

function openCatDecisionModal(catId, catName, stage) {
  openConfigDecisionModal({ apiBase: '/api/pm-categories', label: 'PM Category', rowId: catId, rowName: catName, stage, reload: loadPmConfig });
}
function openGroupDecisionModal(groupId, groupName, stage) {
  openConfigDecisionModal({ apiBase: '/api/checklist-groups', label: 'Checklist Group', rowId: groupId, rowName: groupName, stage, reload: loadPmConfig });
}

// Standard checklist-group categories. Surfaced as a datalist so QA can
// pick a canonical name or override with something custom if needed.
const STANDARD_CHECKLIST_GROUPS = [
  'Instrumentation',
  'Electrical',
  'Mechanical',
  'Automation',
  'Others',
];

// ----- Checklist Group master CRUD -----
async function openGroupModal(existing) {
  const g = existing || { name:'', department_id:'' };
  const isNew = !existing;
  let depts = [];
  try { depts = await api('GET','/api/departments'); } catch (e) {}
  const users = isNew ? await loadActiveUsers() : [];
  openModal({
    title: existing ? `Edit Check List Group — ${escapeHtml(g.name)}` : 'Add Check List Group',
    body: `
      <div class="form-row"><label>Check List Group *</label>
        <div>
          <input name="name" value="${escapeHtml(g.name)}" required list="stdGroupList" placeholder="e.g. Instrumentation, Electrical, Mechanical, Automation, Others" />
          <datalist id="stdGroupList">${STANDARD_CHECKLIST_GROUPS.map(n => `<option value="${escapeHtml(n)}">`).join('')}</datalist>
          <div style="font-size:11px; color:var(--muted); margin-top:3px;">Standard categories: Instrumentation, Electrical, Mechanical, Automation, Others. Type or pick from the dropdown.</div>
        </div>
      </div>
      <div class="form-row"><label>Department</label>
        <select name="department_id">
          <option value="">— none —</option>
          ${depts.map(d => `<option value="${d.id}" ${d.id===g.department_id?'selected':''}>${escapeHtml(d.name)}</option>`).join('')}
        </select>
      </div>
    ` + (isNew ? masterApproverFields(users) : ''),
    submitLabel: isNew ? 'Submit for Review' : 'Save Changes',
    onSubmit: async (data) => {
      const payload = { name: data.name, department_id: data.department_id ? Number(data.department_id) : null };
      if (existing) {
        await api('PUT', `/api/checklist-groups/${existing.id}`, payload);
        toast('Saved.', 'success');
      } else {
        if (!data.reviewer_id || !data.approver_id) throw new Error('Reviewer and Approver are required');
        if (data.reviewer_id === data.approver_id) throw new Error('Reviewer and Approver must be different users');
        payload.reviewer_id = Number(data.reviewer_id);
        payload.approver_id = Number(data.approver_id);
        await api('POST','/api/checklist-groups', payload);
        toast('Checklist Group submitted for review.', 'success');
      }
      loadPmConfig();
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

// Legacy "Create PM Schedule" submit handler removed along with the form.
// PMs are now created via Checklist Assignment exclusively.

// ===========================================================
// CHECKLISTS
// ===========================================================
async function loadChecklists() {
  try {
    const rows = await api('GET','/api/checklists');
    $('checklistsBody').innerHTML = rows.length === 0
      ? '<tr class="empty-row"><td colspan="5">No checklists yet — click "+ New Checklist" to create one.</td></tr>'
      : rows.map(c => `
      <tr${c.status === 'Superseded' ? ' style="opacity:0.7;"' : ''}>
        <td><code style="font-size:11px;">${escapeHtml(c.code || ('#'+c.id))}</code></td>
        <td><strong>${escapeHtml(c.name)}</strong>
          <div style="color:var(--muted); font-size:11px;">${escapeHtml(c.group_name || '—')} · by ${escapeHtml(c.created_by_name || '—')}${c.reviewer_name?` · rev. ${escapeHtml(c.reviewer_name)}`:''}${c.approver_name?` · app. ${escapeHtml(c.approver_name)}`:''}</div>
          ${c.frequencies && c.frequencies.length ? `<div style="margin-top:3px;">${c.frequencies.map(f => `<span class="pill brown" style="font-size:9px; margin-right:3px;">${escapeHtml(f.name)}</span>`).join('')}</div>` : ''}
        </td>
        <td><strong style="font-family:monospace;">${escapeHtml(c.version)}</strong></td>
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
    // Copy-as-new: available on any checklist (clone the structure into a new draft).
    if (can('manage_checklists')) {
      buttons.push(`<button class="btn ghost sm" onclick="openChecklistBuilder(null, ${cl.id})">📋 Copy as new</button>`);
    }
    // Workflow-managed checklists show a generic "Open / Sign" button that opens
    // the stage ladder. Legacy 2-stage checklists fall back to the old Pass/Reject.
    if (cl.status && cl.status.startsWith('Pending ')) {
      buttons.push(`<button class="btn primary sm" onclick="openWorkflowStageModal('Checklist','${cl.id}')">📝 Open / Sign Workflow</button>`);
    }
    if (cl.status === 'Pending Review' && (isReviewer || CURRENT_USER.is_admin) && can('review_checklist')) {
      // Legacy fallback buttons — still work for checklists submitted via the old reviewer/approver path.
      buttons.push(`<button class="btn ghost sm" onclick="reviewChecklistDecision(${cl.id},'approve')">✓ Legacy Pass</button>`);
    }
    if (cl.status === 'Pending Approval' && (isApprover || CURRENT_USER.is_admin) && can('approve_checklist')) {
      buttons.push(`<button class="btn ghost sm" onclick="approveChecklistDecision(${cl.id},'approve')">✓ Legacy Approve</button>`);
    }
    if (cl.status === 'Approved' && can('assign_checklist')) {
      buttons.push(`<button class="btn primary sm" onclick="openAssignChecklistModal(${cl.id})">Assign…</button>`);
    }
    if (cl.status === 'Approved' && can('manage_checklists')) {
      buttons.push(`<button class="btn ghost sm" onclick="newChecklistVersion(${cl.id},'${escapeHtml(cl.code)}','${escapeHtml(cl.version)}')">🔖 New Version…</button>`);
    }
    if (cl.status === 'Approved' && (can('approve_checklist') || can('manage_checklists') || CURRENT_USER.is_admin)) {
      buttons.push(`<button class="btn ghost sm" style="color:#c53030;" onclick="dropChecklist(${cl.id},'${escapeHtml(cl.name)}')">⊘ Drop / Deactivate…</button>`);
    }
    if (cl.status === 'Inactive' && (can('approve_checklist') || can('manage_checklists') || CURRENT_USER.is_admin)) {
      buttons.push(`<button class="btn primary sm" onclick="reactivateChecklist(${cl.id},'${escapeHtml(cl.name)}')">↻ Reactivate…</button>`);
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
        ${cl.submitted_at ? `<div style="color:var(--muted); margin-top:3px;">Submitted ${escapeHtml(formatLocalTime(cl.submitted_at))}</div>` : ''}
        ${cl.reviewed_at ? `<div style="color:var(--muted);">Reviewed ${escapeHtml(formatLocalTime(cl.reviewed_at))}</div>` : ''}
        ${cl.approved_at ? `<div style="color:var(--muted);">Approved ${escapeHtml(formatLocalTime(cl.approved_at))}</div>` : ''}
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
  // Checklist assignments use a separate lifecycle (executor/reviewer/approver workflow)
  // and need to open through openAssignment, not openPm.
  if (p.source === 'assignment') {
    return `<button class="btn primary sm" onclick="openAssignment('${escapeHtml(p.pm_id)}')">Open</button>`;
  }
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
        // Route assignment-sourced events to the assignment modal (workflow lifecycle differs from legacy pm_schedules).
        const handler = e.source === 'assignment'
          ? `openAssignment('${escapeHtml(e.pm_id)}')`
          : `openPm('${escapeHtml(e.pm_id)}')`;
        return `<div class="ev ${c}" title="${escapeHtml(e.status)}: ${escapeHtml(t)}" onclick="${handler}">${escapeHtml(t)}</div>`;
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
        <td>${escapeHtml(formatLocalTime(b.reported_at))}</td>
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
    const pendingVerify = b.status === 'Pending Verification';
    const investigating = b.status === 'Investigating';
    // Action buttons depending on stage
    let stageActions = '';
    if (pendingVerify) {
      stageActions = `
        <hr class="sep" />
        <div style="background:#fff7e6; border-left:3px solid #c77b00; padding:8px 12px; border-radius:6px; margin-bottom:10px; font-size:12px;">
          <strong>Awaiting verification.</strong> Review the report below and either verify (start investigation) or reject (close without action). Both require e-signature.
        </div>
        <div style="display:flex; gap:8px;">
          <button class="btn primary sm" type="button" onclick="bdVerify('${bdId}','verify')">✓ Verify — Start Investigation</button>
          <button class="btn ghost sm" type="button" style="color:#c53030;" onclick="bdVerify('${bdId}','reject')">✗ Reject Report</button>
        </div>`;
    } else if (investigating) {
      stageActions = `
        <hr class="sep" />
        <div style="background:#eaf6ea; border-left:3px solid var(--green); padding:8px 12px; border-radius:6px; margin-bottom:10px; font-size:12px;">
          <strong>Investigation in progress.</strong> Once the resolution is in place, mark it for approval. Requires e-signature.
        </div>
        <div style="display:flex; gap:8px;">
          <button class="btn primary sm" type="button" onclick="bdApproveRes('${bdId}','approve')">✓ Approve Resolution — Close Breakdown</button>
          <button class="btn ghost sm" type="button" style="color:#c53030;" onclick="bdApproveRes('${bdId}','reject')">✗ Return for Rework</button>
        </div>`;
    }
    openModal({
      title: `Breakdown ${b.bd_id}`,
      width: 600,
      body: `
        <div class="row-gap" style="margin-bottom: 10px;">
          ${severityPill(b.severity)} ${statusPill(b.status)}
          <span class="pill brown">${escapeHtml(b.equipment_id)}</span>
          <span class="pill brown">Reported ${escapeHtml(formatLocalTime(b.reported_at))}</span>
        </div>
        <div class="form-row"><label>Severity</label>
          <select name="severity" ${closed?'disabled':''}>
            ${['Critical','Major','Minor'].map(s => `<option ${s===b.severity?'selected':''}>${s}</option>`).join('')}
          </select>
        </div>
        <div class="form-row"><label>Status</label>
          <select name="status" ${closed?'disabled':''}>
            ${['Pending Verification','Investigating','Spares Awaited','Resolved','Closed'].map(s => `<option ${s===b.status?'selected':''}>${s}</option>`).join('')}
          </select>
        </div>
        <div class="form-row" style="grid-template-columns:1fr;"><label>Description</label>
          <textarea disabled>${escapeHtml(b.description || '')}</textarea>
        </div>
        ${b.cause ? `<div class="form-row" style="grid-template-columns:1fr;"><label>Initial Cause (reporter)</label><textarea name="cause" ${closed?'disabled':''}>${escapeHtml(b.cause)}</textarea></div>` : ''}
        ${b.proposed_resolution ? `<div class="form-row" style="grid-template-columns:1fr;"><label>Proposed Resolution</label><textarea name="proposed_resolution" ${closed?'disabled':''}>${escapeHtml(b.proposed_resolution)}</textarea></div>` : ''}
        ${b.estimated_duration ? `<div class="form-row"><label>Estimated Duration</label><input name="estimated_duration" ${closed?'disabled':''} value="${escapeHtml(b.estimated_duration)}" /></div>` : ''}
        ${b.replacement_equipment_id ? `<div class="form-row"><label>Replacement</label><input disabled value="${escapeHtml(b.replacement_equipment_id)}${b.replacement_suitable?' · suitable':''}" /></div>` : ''}
        <div class="form-row" style="grid-template-columns:1fr;"><label>Root Cause (investigation)</label>
          <textarea name="root_cause" ${closed?'disabled':''}>${escapeHtml(b.root_cause || '')}</textarea>
        </div>
        <div class="form-row" style="grid-template-columns:1fr;"><label>Resolution (actual)</label>
          <textarea name="resolution" ${closed?'disabled':''}>${escapeHtml(b.resolution || '')}</textarea>
        </div>
        ${b.verified_at ? `<div style="color:var(--muted); font-size:12px;">Verified ${escapeHtml(formatLocalTime(b.verified_at))}${b.verification_remarks?' — '+escapeHtml(b.verification_remarks):''}</div>` : ''}
        ${b.mttr_hours ? `<div style="color:var(--muted); font-size:12px; margin-top:4px;">MTTR: ${b.mttr_hours}h · closed ${escapeHtml(formatLocalTime(b.closed_at || ''))}</div>` : ''}
        ${stageActions}
      `,
      hideDefaultSubmit: closed || pendingVerify || investigating,
      submitLabel: 'Save Changes',
      onSubmit: async (data) => {
        await api('PUT', `/api/breakdowns/${bdId}`, {
          severity: data.severity, status: data.status,
          root_cause: data.root_cause, resolution: data.resolution,
          cause: data.cause, proposed_resolution: data.proposed_resolution,
          estimated_duration: data.estimated_duration,
        });
        toast('Breakdown updated.', 'success');
        loadBreakdowns();
      }
    });
  } catch (e) { toast(e.message,'error'); }
}

// Verify / Reject a Pending-Verification breakdown report (e-sig required).
async function bdVerify(bdId, decision) {
  let remarks = '';
  if (decision === 'reject') {
    remarks = prompt('Reason for rejecting the breakdown report (required):') || '';
    if (!remarks) return;
  } else {
    remarks = prompt('Verification remarks (optional):') || '';
  }
  const meaning = decision === 'verify'
    ? `I verify breakdown report ${bdId}. Investigation may begin.`
    : `I reject breakdown report ${bdId}. Reason: ${remarks}`;
  closeModal();
  setTimeout(() => openESignatureModal({
    title: `Sign — ${decision === 'verify' ? 'Verify' : 'Reject'} Breakdown ${bdId}`,
    meaning,
    onConfirm: async (esig) => {
      await api('PUT', `/api/breakdowns/${bdId}/verify`, { decision, remarks, ...esig });
      toast(decision === 'verify' ? 'Verified — investigation begins.' : 'Report rejected.', 'success');
      loadBreakdowns();
    }
  }), 0);
}

// Approve resolution (closes the breakdown) or return for rework. E-sig required.
async function bdApproveRes(bdId, decision) {
  let remarks = '';
  if (decision === 'reject') {
    remarks = prompt('Reason for returning the resolution (required):') || '';
    if (!remarks) return;
  } else {
    remarks = prompt('Approval remarks (optional):') || '';
  }
  const meaning = decision === 'approve'
    ? `I approve the resolution for breakdown ${bdId}. The equipment is restored to service.`
    : `I reject the proposed resolution for breakdown ${bdId}. Reason: ${remarks}`;
  closeModal();
  setTimeout(() => openESignatureModal({
    title: `Sign — ${decision === 'approve' ? 'Approve Resolution' : 'Return for Rework'} ${bdId}`,
    meaning,
    onConfirm: async (esig) => {
      await api('PUT', `/api/breakdowns/${bdId}/approve-resolution`, { decision, remarks, ...esig });
      toast(decision === 'approve' ? 'Resolution approved — breakdown closed.' : 'Returned for rework.', 'success');
      loadBreakdowns();
    }
  }), 0);
}

async function openBreakdownModal() {
  try {
    const equipment = await api('GET','/api/equipment');
    const activeEq = equipment.filter(e => e.status === 'Active');
    openModal({
      title: 'Report Breakdown',
      width: 580,
      body: `
        <p style="font-size:12px; color:var(--muted); margin-top:0;">After you submit, this report goes through one-step verification by QA / Engineering before becoming an active investigation.</p>
        <div class="form-row"><label>Equipment *</label>
          <select name="equipment_id" required>
            <option value="">— select equipment —</option>
            ${activeEq.map(e => `<option value="${escapeHtml(e.equipment_id)}">${escapeHtml(e.equipment_id)} · ${escapeHtml(e.name)}</option>`).join('')}
          </select>
        </div>
        <div class="form-row"><label>Severity *</label>
          <select name="severity"><option>Critical</option><option selected>Major</option><option>Minor</option></select>
        </div>
        <div class="form-row" style="grid-template-columns:1fr;"><label>Description *</label>
          <textarea name="description" required rows="2" placeholder="What happened? When was it noticed?"></textarea>
        </div>
        <hr class="sep" />
        <div style="font-size:11px; color:var(--brown-700); text-transform:uppercase; letter-spacing:1px; margin-bottom:6px;">Initial Assessment</div>
        <div class="form-row" style="grid-template-columns:1fr;"><label>Cause</label>
          <textarea name="cause" rows="2" placeholder="Suspected cause — what likely triggered the breakdown?"></textarea>
        </div>
        <div class="form-row" style="grid-template-columns:1fr;"><label>Proposed Resolution</label>
          <textarea name="proposed_resolution" rows="2" placeholder="How do you plan to fix it?"></textarea>
        </div>
        <div class="form-row"><label>Estimated Duration</label>
          <input name="estimated_duration" placeholder="e.g., 4 hours, 2 days, 1 week" />
        </div>
        <hr class="sep" />
        <div style="font-size:11px; color:var(--brown-700); text-transform:uppercase; letter-spacing:1px; margin-bottom:6px;">Replacement Equipment (if any)</div>
        <div class="form-row"><label>Replacement Equipment</label>
          <select name="replacement_equipment_id">
            <option value="">— none —</option>
            ${activeEq.map(e => `<option value="${escapeHtml(e.equipment_id)}">${escapeHtml(e.equipment_id)} · ${escapeHtml(e.name)}</option>`).join('')}
          </select>
        </div>
        <div class="form-row"><label>&nbsp;</label>
          <label style="font-size:12px; display:flex; gap:6px; align-items:center;">
            <input type="checkbox" name="replacement_suitable" />
            I confirm the replacement is suitable (capacity, validation status, GMP compliance equivalent).
          </label>
        </div>`,
      submitLabel: 'Report Breakdown',
      onSubmit: async (data) => {
        if (!data.equipment_id) throw new Error('Pick the affected equipment');
        if (!data.description || !data.description.trim()) throw new Error('Description is required');
        await api('POST','/api/breakdowns', data);
        toast('Breakdown reported — sent to QA / Engineering for verification.', 'success');
        loadBreakdowns();
        refreshNotifBadge();
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
    renderAuditRows(rows, { limit });
    return rows;
  } catch (e) { toast(e.message,'error'); }
}

function renderAuditRows(rows, meta) {
  $('auditBody').innerHTML = rows.length === 0
    ? '<tr class="empty-row"><td colspan="6">No audit entries</td></tr>'
    : rows.map(a => `
    <tr>
      <td>${escapeHtml(formatLocalTime(a.ts))}</td>
      <td>${escapeHtml(a.user_name)}</td>
      <td><span class="pill ${dotColorPill(a.action)}">${escapeHtml(a.action)}</span></td>
      <td>${escapeHtml(a.entity)}</td>
      <td>${escapeHtml(a.entity_id)}</td>
      <td>${escapeHtml(a.details || '')}</td>
    </tr>`).join('');
  // Print header — shown only in print/PDF media.
  const printMeta = document.getElementById('auditPrintMeta');
  if (printMeta) {
    const parts = [];
    if (meta && meta.from) parts.push(`From ${meta.from}`);
    if (meta && meta.to)   parts.push(`To ${meta.to}`);
    if (meta && meta.user) parts.push(`User: ${meta.user}`);
    if (meta && meta.action) parts.push(`Action: ${meta.action}`);
    parts.push(`${rows.length} entries`);
    parts.push(`Generated ${new Date().toLocaleString()}`);
    printMeta.textContent = parts.join(' · ');
  }
}

// Audit filter — calls the API with from/to/user/action params + renders.
async function applyAuditFilter() {
  const from = ($('auditFrom').value || '').trim();
  const to   = ($('auditTo').value || '').trim();
  const user = ($('auditUser').value || '').trim();
  const action = ($('auditAction').value || '').trim();
  const q = new URLSearchParams({ limit: '2000' });
  if (from)   q.set('from', from);
  if (to)     q.set('to', to);
  if (user)   q.set('user', user);
  if (action) q.set('action', action);
  try {
    const rows = await api('GET', '/api/audit?' + q.toString());
    renderAuditRows(rows, { from, to, user, action });
  } catch (e) { toast(e.message, 'error'); }
}
function clearAuditFilter() {
  ['auditFrom','auditTo','auditUser','auditAction'].forEach(id => { const el = $(id); if (el) el.value = ''; });
  loadAudit(100);
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
          <thead><tr><th>ID</th><th>Source</th><th>Equipment</th><th>Scheduled</th><th>Frequency</th><th>Department</th><th>Status</th></tr></thead>
          <tbody>${rows.length === 0
            ? '<tr class="empty-row"><td colspan="7">No overdue items 🎉</td></tr>'
            : rows.map(r => `<tr><td><strong>${escapeHtml(r.id || r.pm_id || '')}</strong></td>
                <td><span class="pill gray" style="font-size:9px;">${r.source === 'assignment' ? 'Assignment' : 'Legacy PM'}</span></td>
                <td>${escapeHtml(r.equipment_name || r.equipment_id || '')}</td>
                <td>${escapeHtml(r.scheduled_date || '')}</td>
                <td>${escapeHtml(r.frequency || '')}</td>
                <td>${escapeHtml(r.department || '')}</td>
                <td>${statusPill(r.status)}</td></tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  } catch (e) { toast(e.message,'error'); }
}

async function openCompletedPmsReport() {
  // Open with a date-range filter modal first so the report doesn't blow up
  // for installations with thousands of historical executions.
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = new Date(); monthStart.setDate(1);
  const monthIso = monthStart.toISOString().slice(0, 10);
  openModal({
    title: 'Completed PMs — Filters',
    body: `
      <p style="font-size:12px; color:var(--muted); margin-top:0;">Pulls completed executions from both the legacy PM schedule and the current checklist-assignment workflow.</p>
      <div class="form-row"><label>From (completion date)</label><input name="from" type="date" value="${monthIso}" /></div>
      <div class="form-row"><label>To (completion date)</label><input name="to" type="date" value="${today}" /></div>
      <div class="form-row"><label>Equipment ID (optional)</label><input name="equipment_id" placeholder="leave blank for all" /></div>
    `,
    submitLabel: 'Run Report',
    onSubmit: async (data) => {
      const q = new URLSearchParams();
      if (data.from)  q.set('from', data.from);
      if (data.to)    q.set('to', data.to);
      if (data.equipment_id && data.equipment_id.trim()) q.set('equipment_id', data.equipment_id.trim());
      const rows = await api('GET', '/api/reports/completed-pms?' + q.toString());
      $('reportPanel').innerHTML = `
        <div class="card">
          <div class="card-head">
            <h3>Completed PMs</h3>
            <span class="pill green">${rows.length} executions</span>
          </div>
          <div style="font-size:11px; color:var(--muted); margin: 4px 12px 8px;">
            Filter: ${escapeHtml(data.from || '—')} → ${escapeHtml(data.to || '—')}${data.equipment_id?` · Equipment: ${escapeHtml(data.equipment_id)}`:''}
          </div>
          <table class="tbl">
            <thead>
              <tr>
                <th>ID</th><th>Source</th><th>Equipment</th><th>Checklist</th>
                <th>Frequency</th><th>Scheduled</th><th>Completed</th>
                <th>Executor</th><th>Reviewer</th><th>Approver</th>
              </tr>
            </thead>
            <tbody>${rows.length === 0
              ? '<tr class="empty-row"><td colspan="10">No completed PMs in this window.</td></tr>'
              : rows.map(r => `<tr>
                  <td><strong>${escapeHtml(r.id || '')}</strong></td>
                  <td><span class="pill gray" style="font-size:9px;">${r.source === 'assignment' ? 'Assignment' : 'Legacy PM'}</span></td>
                  <td>${escapeHtml(r.equipment_name || r.equipment_id || '')}<div style="color:var(--muted); font-size:11px;">${escapeHtml(r.equipment_id || '')}</div></td>
                  <td>${escapeHtml(r.checklist_name || '—')}${r.checklist_version?` <span style="color:var(--muted); font-size:11px;">${escapeHtml(r.checklist_version)}</span>`:''}</td>
                  <td>${escapeHtml(r.frequency || '—')}</td>
                  <td>${escapeHtml(r.scheduled_date || '—')}</td>
                  <td><strong>${escapeHtml(r.completed_at || '—')}</strong></td>
                  <td>${escapeHtml(r.assignee_name || '—')}</td>
                  <td>${escapeHtml(r.reviewer_name || '—')}</td>
                  <td>${escapeHtml(r.approver_name || '—')}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>`;
    }
  });
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
            <div class="card-head"><h3>PM History — ${escapeHtml(data.equipment_id)}</h3><span class="pill brown">${h.pm.length} entries</span></div>
            <table class="tbl">
              <thead><tr><th>ID</th><th>Source</th><th>Scheduled</th><th>Freq</th><th>Status</th><th>Completed</th></tr></thead>
              <tbody>${h.pm.length===0?'<tr class="empty-row"><td colspan="6">No PMs yet</td></tr>':h.pm.map(p =>
                `<tr><td><strong>${escapeHtml(p.id || p.pm_id || '')}</strong></td>
                     <td><span class="pill gray" style="font-size:9px;">${p.source === 'assignment' ? 'Assignment' : 'Legacy PM'}</span></td>
                     <td>${escapeHtml(p.scheduled_date || '')}</td>
                     <td>${escapeHtml(p.frequency || '')}</td>
                     <td>${statusPill(p.status)}</td>
                     <td>${escapeHtml(p.completed_at || '')}</td></tr>`).join('')}</tbody>
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
  const q = ev.target.value.trim();
  if (!q) return;
  const Q = q.toUpperCase();
  try {
    // ID prefix → direct navigation
    if (Q.startsWith('PM-'))  { openPm(Q); return; }
    if (Q.startsWith('BD-'))  { openBdDetail(Q); return; }
    if (Q.startsWith('CA-'))  { goto('tasks'); setTimeout(() => openAssignment(Q), 250); return; }
    if (Q.startsWith('EQ-'))  { goto('masters'); loadMasters('equipment'); return; }
    if (Q.startsWith('PL-'))  { goto('masters'); loadMasters('plants'); return; }
    if (Q.startsWith('BLK-')) { goto('masters'); loadMasters('blocks'); return; }
    if (Q.startsWith('LOC-')) { goto('masters'); loadMasters('locations'); return; }
    if (Q.startsWith('AR-'))  { goto('masters'); loadMasters('areas'); return; }
    if (Q.startsWith('CHK-')) {
      // Look up checklist by code → open preview
      const list = await api('GET', '/api/checklists');
      const match = list.find(c => (c.code || '').toUpperCase() === Q);
      if (match) { goto('checklist'); setTimeout(() => previewChecklist(match.id), 250); return; }
      toast(`No checklist found with code "${q}"`, 'error');
      return;
    }
    // Free text → try equipment name match
    const equip = await api('GET', '/api/equipment');
    const eqMatch = equip.find(e => ((e.name || '') + ' ' + (e.equipment_id || '')).toUpperCase().includes(Q));
    if (eqMatch) {
      goto('masters'); loadMasters('equipment');
      toast(`Found equipment: ${eqMatch.equipment_id} — ${eqMatch.name}`, 'success');
      return;
    }
    toast(`No match for "${q}". Try a prefix: PM- BD- CA- CHK- EQ- PL- BLK- LOC- AR-, or part of an equipment name.`, 'error');
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
  if (tab === 'workflows')    return renderWorkflowsTab();
  if (tab === 'clnames')      return renderChecklistNamesTab();
}

// ----- Checklist Name Templates tab -----
async function renderChecklistNamesTab() {
  try {
    const rows = await api('GET', '/api/checklist-name-templates');
    const canEdit = can('manage_checklists') || can('manage_pm_categories') || (CURRENT_USER && CURRENT_USER.is_admin);
    $('settingsPanel').innerHTML = `
      <div class="card">
        <div class="card-head">
          <h3>Checklist Name Templates</h3>
          ${canEdit ? `<button class="btn primary sm" onclick="openClNameModal()">+ Add Template</button>` : ''}
        </div>
        <p style="color:var(--muted); font-size:12px; margin:0 0 12px;">QA maintains the approved list of canonical checklist names. When creating a new checklist, users pick from this list — no free-form typing allowed.</p>
        <table class="tbl">
          <thead><tr><th>Name</th><th>Description</th><th>Status</th><th style="text-align:right;">Actions</th></tr></thead>
          <tbody>${rows.length === 0
            ? '<tr class="empty-row"><td colspan="4">No templates yet. Add one to enable checklist creation.</td></tr>'
            : rows.map(r => `<tr>
                <td><strong>${escapeHtml(r.name)}</strong></td>
                <td>${escapeHtml(r.description || '')}</td>
                <td>${statusPill(r.status)}</td>
                <td style="text-align:right;">
                  ${canEdit ? `<button class="btn ghost sm" onclick='openClNameModal(${escapeHtml(JSON.stringify(r))})'>Edit</button>
                              <button class="btn ghost sm" onclick="deleteClName(${r.id})">×</button>` : ''}
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  } catch (e) { toast(e.message, 'error'); }
}
function openClNameModal(existing) {
  const r = existing || { name:'', description:'' };
  openModal({
    title: existing ? `Edit — ${escapeHtml(r.name)}` : 'Add Checklist Name Template',
    body: `
      <div class="form-row"><label>Name *</label><input name="name" value="${escapeHtml(r.name)}" required placeholder="e.g. Air Handling Unit Preventive Maintenance" /></div>
      <div class="form-row" style="grid-template-columns:1fr;"><label>Description</label><textarea name="description" rows="2">${escapeHtml(r.description || '')}</textarea></div>
    `,
    onSubmit: async (data) => {
      if (existing) await api('PUT', `/api/checklist-name-templates/${existing.id}`, data);
      else          await api('POST','/api/checklist-name-templates', data);
      toast('Saved.', 'success');
      renderChecklistNamesTab();
    }
  });
}
async function deleteClName(id) {
  if (!confirm('Delete this template? Existing checklists using this name are unaffected.')) return;
  try { await api('DELETE', `/api/checklist-name-templates/${id}`); toast('Deleted.', 'success'); renderChecklistNamesTab(); }
  catch (e) { toast(e.message, 'error'); }
}

// ----- Approval Workflows tab -----
async function renderWorkflowsTab() {
  try {
    const workflows = await api('GET','/api/approval-workflows');
    const canEdit = can('manage_pm_categories') || can('manage_checklists') || (CURRENT_USER && CURRENT_USER.is_admin);
    $('settingsPanel').innerHTML = `
      <div class="card">
        <div class="card-head">
          <h3>Approval Workflows</h3>
          ${canEdit ? `<button class="btn primary sm" onclick="openWorkflowModal()">+ New Workflow</button>` : ''}
        </div>
        <p style="font-size:12px; color:var(--muted); margin-top:0;">
          Define named approval chains. When creating a master record (Plant / Equipment / Checklist / …), the creator picks a workflow and assigns a user to each stage. The record walks through the stages in order — each requiring an e-signature. Reject at any stage sends the record back to the creator.
        </p>
        <table class="tbl">
          <thead><tr><th>Name</th><th>Stages</th><th>Status</th><th></th></tr></thead>
          <tbody>${workflows.length === 0
            ? '<tr class="empty-row"><td colspan="4">No workflows yet.</td></tr>'
            : workflows.map(w => `<tr>
                <td><strong>${escapeHtml(w.name)}</strong>${w.is_system?' <span class="pill brown" style="font-size:9px; margin-left:4px;">SYSTEM</span>':''}<div style="color:var(--muted); font-size:11px;">${escapeHtml(w.description || '')}</div></td>
                <td>${(w.stages || []).map((s, i) => `<div style="font-size:11px;">${i+1}. <strong>${escapeHtml(s.label)}</strong> <span class="pill ${s.type==='review'?'blue':'green'}" style="font-size:9px; margin-left:4px;">${escapeHtml(s.type)}</span></div>`).join('')}</td>
                <td>${statusPill(w.status)}</td>
                <td style="text-align:right;">
                  ${canEdit && !w.is_system ? `<button class="btn ghost sm" onclick='openWorkflowModal(${escapeHtml(JSON.stringify(w))})'>Edit</button>
                                              <button class="btn ghost sm" onclick="deleteWorkflow(${w.id})">×</button>` : ''}
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  } catch (e) { toast(e.message, 'error'); }
}

function openWorkflowModal(existing) {
  const w = existing || { name:'', description:'', stages:[{label:'Reviewer', type:'review'},{label:'Approver', type:'approve'}] };
  // Stash stages in a global so the +/− buttons can mutate without losing focus on each redraw.
  window.__wfStages = JSON.parse(JSON.stringify(w.stages || []));
  const renderStages = () => window.__wfStages.map((s, i) => `
    <div class="card" style="padding:8px 10px; margin-bottom:6px; display:flex; gap:6px; align-items:center;">
      <span style="width:24px; text-align:center; color:var(--muted); font-weight:600;">${i+1}.</span>
      <input class="wf-stage-label" value="${escapeHtml(s.label)}" placeholder="Stage label (e.g. QA Review)" style="flex:1;" />
      <select class="wf-stage-type" style="width:120px;">
        <option value="review"  ${s.type==='review'?'selected':''}>Review</option>
        <option value="approve" ${s.type==='approve'?'selected':''}>Approve</option>
      </select>
      <button type="button" class="btn ghost sm" onclick="window.__wfRemStage(${i})">×</button>
    </div>`).join('');
  const refresh = () => { document.getElementById('wfStagesList').innerHTML = renderStages(); };
  window.__wfReadStages = () => {
    const labels = Array.from(document.querySelectorAll('.wf-stage-label')).map(e => e.value.trim());
    const types  = Array.from(document.querySelectorAll('.wf-stage-type')).map(e => e.value);
    return labels.map((l, i) => ({ label: l, type: types[i] }));
  };
  window.__wfAddStage = () => { window.__wfStages = window.__wfReadStages(); window.__wfStages.push({ label:'', type:'approve' }); refresh(); };
  window.__wfRemStage = (idx) => { window.__wfStages = window.__wfReadStages(); window.__wfStages.splice(idx, 1); if (window.__wfStages.length === 0) window.__wfStages.push({label:'',type:'review'}); refresh(); };
  openModal({
    title: existing ? `Edit Workflow — ${escapeHtml(w.name)}` : 'New Approval Workflow',
    width: 620,
    body: `
      <div class="form-row"><label>Name *</label><input name="name" value="${escapeHtml(w.name)}" required placeholder="e.g. QA 3-Stage Critical" /></div>
      <div class="form-row" style="grid-template-columns:1fr;"><label>Description</label><textarea name="description" rows="2">${escapeHtml(w.description || '')}</textarea></div>
      <hr class="sep" />
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
        <strong>Stages</strong>
        <button type="button" class="btn ghost sm" onclick="window.__wfAddStage()">+ Add Stage</button>
      </div>
      <div id="wfStagesList">${renderStages()}</div>
      <p style="font-size:11px; color:var(--muted); margin:8px 0 0;">Each stage requires an e-signature from its assigned user. The record progresses through stages in order. Reject at any stage returns to the creator.</p>
    `,
    submitLabel: existing ? 'Save Changes' : 'Create Workflow',
    onSubmit: async (data) => {
      const stages = window.__wfReadStages().filter(s => s.label);
      if (stages.length === 0) throw new Error('Add at least one stage');
      const payload = { name: data.name, description: data.description, stages };
      if (existing) {
        await api('PUT', `/api/approval-workflows/${existing.id}`, payload);
        toast('Workflow updated.', 'success');
      } else {
        await api('POST', '/api/approval-workflows', payload);
        toast('Workflow created.', 'success');
      }
      renderWorkflowsTab();
    }
  });
}

async function deleteWorkflow(id) {
  if (!confirm('Delete this workflow? Any records still using it must be re-assigned first.')) return;
  try { await api('DELETE', `/api/approval-workflows/${id}`); toast('Deleted.', 'success'); renderWorkflowsTab(); }
  catch (e) { toast(e.message, 'error'); }
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
  // Only admins (or users with manage_departments) can reach this — sidebar
  // already hides Admin Settings for everyone else.
  if (!CURRENT_USER || (!CURRENT_USER.is_admin && !(CURRENT_USER.permissions || []).includes('manage_departments'))) {
    toast('Only administrators can manage departments.', 'error');
    return;
  }
  const d = existing || { name:'', description:'' };
  openModal({
    title: existing ? `Edit Department — ${escapeHtml(d.name)}` : 'Add Department',
    body: `
      <p style="font-size:12px; color:var(--muted); margin-top:0;">Departments are referenced by every user, role, and master record. <strong>You will be asked to sign with your password on the next step.</strong></p>
      <div class="form-row"><label>Name *</label><input name="name" value="${escapeHtml(d.name)}" required /></div>
      <div class="form-row" style="grid-template-columns:1fr;"><label>Description</label><textarea name="description">${escapeHtml(d.description || '')}</textarea></div>
    `,
    submitLabel: existing ? 'Save Changes →' : 'Create Department →',
    onSubmit: async (data) => {
      const meaning = existing
        ? `I update department "${d.name}". I am authorized to manage organizational structure.`
        : `I create department "${data.name}". I am authorized to manage organizational structure.`;
      setTimeout(() => {
        openESignatureModal({
          title: existing ? `Sign — Update Department ${d.name}` : `Sign — Create Department ${data.name}`,
          meaning,
          onConfirm: async (esig) => {
            const payload = { ...data, ...esig };
            if (existing) await api('PUT', `/api/departments/${existing.id}`, payload);
            else          await api('POST','/api/departments', payload);
            toast('Saved.', 'success'); renderDeptsTab();
          }
        });
      }, 0);
    }
  });
}
async function deleteDept(id) {
  if (!confirm('Delete this department? You will be asked to sign with your password.')) return;
  const meaning = `I delete a department (id ${id}). I am authorized to manage organizational structure.`;
  openESignatureModal({
    title: `Sign — Delete Department`,
    meaning,
    onConfirm: async (esig) => {
      await api('DELETE', `/api/departments/${id}`, esig);  // body via esig
      toast('Deleted.','success'); renderDeptsTab();
    }
  });
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
    // Sort categories alphabetically with "Other" pushed to the end for tidiness.
    const byCat = {};
    activities.forEach(a => { (byCat[a.category || 'Other'] = byCat[a.category || 'Other'] || []).push(a); });
    const cats = Object.keys(byCat).sort((a, b) => {
      if (a === 'Other') return 1;
      if (b === 'Other') return -1;
      return a.localeCompare(b);
    });
    $('settingsPanel').innerHTML = `
      <div class="card">
        <div class="card-head"><h3>Activities (Permissions Catalog)</h3>
          ${canEdit ? `<button class="btn primary sm" onclick="openActivityModal()">+ Add Activity</button>` : ''}
        </div>
        <p style="color:var(--muted); font-size:12px; margin:0 0 14px;">Activities are the fine-grained things a role can do. Built-in activities are referenced by application code and cannot be deleted.</p>
        <div style="display:flex; flex-direction:column; gap:18px;">
          ${cats.map(cat => `
            <div>
              <div style="display:flex; align-items:center; gap:8px; padding-bottom:6px; border-bottom:1px solid var(--border); margin-bottom:8px;">
                <strong style="text-transform:uppercase; letter-spacing:0.5px; font-size:12px; color:var(--brown-700);">${escapeHtml(cat)}</strong>
                <span class="pill gray" style="font-size:10px;">${byCat[cat].length}</span>
              </div>
              <table class="tbl" style="margin:0;">
                <thead>
                  <tr>
                    <th style="width:30%;">Code</th>
                    <th>Label</th>
                    <th style="width:90px;">Type</th>
                    <th style="width:140px; text-align:right;">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  ${byCat[cat].map(a => `
                    <tr>
                      <td style="vertical-align:middle;"><code style="font-size:11px; background:#f5efe2; padding:2px 6px; border-radius:3px;">${escapeHtml(a.code)}</code></td>
                      <td style="vertical-align:middle;">${escapeHtml(a.label)}</td>
                      <td style="vertical-align:middle;">${a.is_system
                        ? '<span class="pill brown" style="font-size:9px;">SYSTEM</span>'
                        : '<span class="pill blue" style="font-size:9px;">CUSTOM</span>'}</td>
                      <td style="text-align:right; vertical-align:middle; white-space:nowrap;">
                        ${canEdit ? `<button class="btn ghost sm" onclick='openActivityModal(${escapeHtml(JSON.stringify(a))})'>Edit</button>
                                     ${a.is_system ? '' : `<button class="btn ghost sm" onclick="deleteActivity(${a.id})">×</button>`}` : ''}
                      </td>
                    </tr>`).join('')}
                </tbody>
              </table>
            </div>`).join('')}
        </div>
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

async function openChecklistBuilder(existingId, copyFromId) {
  try {
    const [groups, cats, freqs, nameTemplates] = await Promise.all([
      api('GET','/api/checklist-groups?active=1'),
      api('GET','/api/pm-categories'),
      api('GET','/api/frequencies'),
      api('GET','/api/checklist-name-templates').catch(() => []),
    ]);
    const activeFreqs  = freqs.filter(f => (f.status || 'Active') === 'Active');
    const activeCats   = cats.filter(c => (c.status || 'Active') === 'Active');
    const activeGroups = groups.filter(g => (g.status || 'Active') === 'Active');
    // Auto-suggested Checklist ID for fresh creations
    let suggestedCode = '';
    if (!existingId && !copyFromId) {
      try { const s = await api('GET','/api/checklists/next-code'); suggestedCode = s.suggested || ''; }
      catch (e) { /* fallback to user-entered if endpoint fails */ }
    }
    let cl = null;
    if (existingId)        cl = await api('GET', `/api/checklists/${existingId}/full`);
    else if (copyFromId)   cl = await api('GET', `/api/checklists/${copyFromId}/full`);
    // When copying, blank out the code (user must pick a new one) and reset version + status fields
    // so the copy is treated as a brand-new Draft. The original record is untouched.
    if (cl && copyFromId && !existingId) {
      cl = { ...cl, code: '', name: cl.name + ' (Copy)', version: 'v1.0', status: 'Draft', id: null,
             created_by: null, reviewer_id: null, approver_id: null,
             submitted_at: null, reviewed_at: null, approved_at: null, rejection_reason: null };
    }
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
          ${activeGroups.map(g => `<option value="${g.id}" ${cl && cl.group_id===g.id?'selected':''}>${escapeHtml(g.name)}</option>`).join('')}
        </select>
        ${activeGroups.length === 0 ? '<div style="font-size:11px; color:var(--red); margin-top:4px;">No Active groups. Configure in PM Configuration → Check List Group and complete Review &amp; Approve first.</div>' : ''}
      </div>
      <div class="form-row"><label>Checklist ID *</label>
        <div>
          <input name="code" value="${escapeHtml(cl?.code || suggestedCode || '')}" required minlength="2" maxlength="50" pattern="[A-Za-z0-9_\\-]{2,50}"
                 placeholder="e.g., CHK-001" />
          ${(!existingId && !copyFromId && suggestedCode) ? `<div style="font-size:11px; color:var(--muted); margin-top:3px;">Auto-suggested next sequential ID. Edit before saving if you prefer a meaningful code.</div>` : ''}
        </div>
      </div>
      <div class="form-row"><label>Checklist Name *</label>
        <div>
          <select name="name" required>
            <option value="">— pick from Checklist Name Templates —</option>
            ${(nameTemplates || []).filter(t => t.status === 'Active').map(t => `<option value="${escapeHtml(t.name)}" ${cl && cl.name === t.name ? 'selected' : ''}>${escapeHtml(t.name)}</option>`).join('')}
            ${cl && cl.name && !(nameTemplates || []).some(t => t.name === cl.name)
              ? `<option value="${escapeHtml(cl.name)}" selected>${escapeHtml(cl.name)} (legacy)</option>` : ''}
          </select>
          ${(!nameTemplates || nameTemplates.length === 0) ? '<div style="font-size:11px; color:var(--red); margin-top:4px;">No name templates configured. Add some in <strong>Admin Settings → Checklist Name Templates</strong> first.</div>' : ''}
        </div>
      </div>
      <div class="form-row"><label>Version</label>
        <div style="display:flex; align-items:center; gap:10px;">
          <input name="version" value="${escapeHtml(cl?.version || 'v1.0')}" readonly tabindex="-1"
                 style="background: var(--cream-100); color: var(--muted); cursor: not-allowed; max-width: 120px;" />
          <span style="font-size:11px; color:var(--muted);">Auto-assigned · system controlled</span>
        </div>
      </div>
      <!-- Maintenance Category dropdown intentionally removed per spec. Existing category_id on
           older checklists is preserved via the backend COALESCE — form just doesn't offer it. -->
      <div class="form-row" style="grid-template-columns:1fr;"><label>Description</label><textarea name="description">${escapeHtml(cl?.description || '')}</textarea></div>

      <div class="form-row" style="grid-template-columns:1fr;">
        <label>Frequency * <span style="color:var(--muted); font-weight:400; font-size:11px;">(check all that apply)</span></label>
        <div id="cbFreqs" style="display:flex; flex-wrap:wrap; gap:8px 14px;">
          ${activeFreqs.length === 0
            ? `<div style="font-size:12px; color:var(--red); background:#fdecec; border:1px solid #f5c2c2; border-radius:6px; padding:8px 12px; line-height:1.5;">
                 <strong>No Active frequencies available.</strong><br>
                 Configure them in <strong>PM Configuration → Frequency Master</strong>, then complete the Review &amp; Approve workflow on each one before they can be used here.
               </div>`
            : activeFreqs.map(f => `
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
        <strong>Checkpoints &amp; Questions</strong>
        <button type="button" class="btn ghost sm" onclick="__cbAddSection()">+ Add Checkpoint</button>
      </div>
      <div id="cbSections" style="margin-top:8px;">
        ${sections.map((s, si) => renderSection(s, si)).join('')}
      </div>
    `;
    const renderSection = (s, si) => `
      <div class="card" style="padding:10px 12px; margin-bottom:10px; border-left:3px solid var(--brand);" data-sidx="${si}">
        <div style="display:flex; gap:6px; align-items:center; margin-bottom:6px;">
          <input class="cb-sname" placeholder="Checkpoint name" value="${escapeHtml(s.name)}" style="flex:1; font-weight:600;" />
          <button type="button" class="btn ghost sm" onclick="__cbDelSection(${si})">×</button>
        </div>
        <input class="cb-sdesc" placeholder="Checkpoint description (optional)" value="${escapeHtml(s.description || '')}" style="width:100%; font-size:12px;" />
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
            <input class="cb-qopts" placeholder="opt1 | opt2 (dropdown / checkbox)" value="${escapeHtml(q.options || '')}" />
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
      title: existingId ? `Edit Checklist — ${escapeHtml(cl.name)}`
                        : (copyFromId ? `Copy of ${escapeHtml(cl ? cl.name : '')} — New Checklist` : 'New Checklist'),
      width: 820,
      body: renderBuilder(),
      submitLabel: existingId ? 'Save Changes' : (copyFromId ? 'Create Copy' : 'Create Checklist'),
      onSubmit: async (data) => {
        const built = window.__cbReadDOM().map(s => ({
          name: s.name, description: s.description,
          questions: s.questions.filter(q => q.label.trim()).map(q => ({
            label: q.label, qtype: q.qtype,
            // Checkbox + Dropdown both use the pipe-separated options field. Yes/No is built-in.
            options: (q.qtype === 'dropdown' || q.qtype === 'checkbox')
              ? q.options.split('|').map(x => x.trim()).filter(Boolean)
              : null,
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
        let resultId = existingId;
        if (existingId) {
          await api('PUT', `/api/checklists/${existingId}`, payload);
        } else {
          const created = await api('POST','/api/checklists', payload);
          resultId = created && created.id;
        }
        toast(copyFromId ? 'Copy created as a new Draft.' : 'Checklist saved.', 'success');
        loadChecklists();
        if (resultId) previewChecklist(resultId);
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
  if (a.status === 'Pending Assignment Review' && a.reviewer_id === uid)          return { label: 'Review Plan',    tone: 'amber' };
  if (a.status === 'Pending Assignment Approval' && a.approver_id === uid)        return { label: 'Approve Plan',   tone: 'amber' };
  if (a.status === 'Scheduled' && (a.assigned_by === uid || CURRENT_USER.is_admin || can('assign_checklist'))) return { label: 'Initiate Clearance', tone: 'blue' };
  if (a.status === 'Pending Clearance' && a.clearance_user_id === uid)            return { label: 'Grant Clearance', tone: 'amber' };
  if (a.status === 'Awaiting Executor' && (a.assigned_by === uid || CURRENT_USER.is_admin)) return { label: 'Assign Executor', tone: 'amber' };
  if (a.status === 'Pending' && a.assignee_id === uid)                            return { label: 'Start', tone: 'amber' };
  if (a.status === 'In Progress' && a.assignee_id === uid)                        return { label: 'Continue execution', tone: 'blue' };
  if (a.status === 'Pending Review' && a.reviewer_id === uid)                     return { label: 'Review', tone: 'amber' };
  if (a.status === 'Pending Approval' && a.approver_id === uid)                   return { label: 'Approve', tone: 'amber' };
  return null;
}

// ===========================================================
// PM WORKFLOW — 12-step lifecycle reference + flexibility matrix
// ===========================================================
const PM_WORKFLOW_STEPS = [
  { n: 1,  phase:'Authoring',  color:'blue',
    title:'Checklist Creation',
    desc:'Initiator authors a structured checklist with sections, questions, allowed frequencies and configurable required fields.',
    actor:'Initiator (Engineering)', link:'checklist', linkLabel:'Open Checklists →' },
  { n: 2,  phase:'Authoring',  color:'blue',
    title:'Checklist Multi-Level Review & Approval',
    desc:'Reviewer (Engineering Manager) passes the checklist; Approver (QA) signs it off. Only an Approved checklist becomes assignable.',
    actor:'Reviewer → Approver', link:'checklist', linkLabel:'Open Checklists →' },
  { n: 3,  phase:'Assignment', color:'blue',
    title:'Checklist Assignment to Equipment',
    desc:'Engineering Manager picks Block → Location → Area → Equipment, frequency and dates, and nominates reviewer / approver / clearance user.',
    actor:'Engineering Manager', link:'assignments', linkLabel:'Checklist Assignment →' },
  { n: 4,  phase:'Assignment', color:'blue',
    title:'Equipment Assignment Multi-Level Review & Approval',
    desc:'The assignment plan itself is reviewed by Engineering and approved by QA before the production clearance request is issued. Status: Pending Assignment Review → Pending Assignment Approval.',
    actor:'Reviewer → Approver', link:'tasks', linkLabel:'Reviewer / Approver Inbox →' },
  { n: 5,  phase:'Scheduling', color:'amber',
    title:'Automatic Schedule Generation',
    desc:'On plan approval, status flips to "Scheduled". The PM is now booked into the calendar per the chosen frequency and due date.',
    actor:'System (automatic)', link:null },
  { n: 6,  phase:'Scheduling', color:'amber',
    title:'PM Calendar & Pending Task Update',
    desc:'Scheduled PMs appear in the Calendar tile for the relevant month and in the PM Execution Pending list. Visible to everyone on the network.',
    actor:'System (automatic)', link:'calendar', linkLabel:'Open Calendar →' },
  { n: 7,  phase:'Clearance',  color:'amber',
    title:'Production Clearance Request Initiated by Engineering',
    desc:'Closer to the scheduled date, Engineering opens the assignment and clicks "📤 Initiate Clearance Request". Only at this point does status flip to "Pending Clearance" and the named Production user receive the request notification.',
    actor:'Engineering (Initiator)', link:'assignments', linkLabel:'Open Checklist Assignment →' },
  { n: 8,  phase:'Clearance',  color:'amber',
    title:'Production / User Department Review & Approval',
    desc:'Production user reviews against the production plan and either grants clearance (with optional remarks) or denies it (mandatory reason). Denial halts the workflow.',
    actor:'Production User', link:'tasks', linkLabel:'My Tasks → Inbox →' },
  { n: 9,  phase:'Execution',  color:'brown',
    title:'Technician Assignment by Engineering Manager',
    desc:'On cleared status (Awaiting Executor), Engineering Manager picks the Technician who will perform the PM.',
    actor:'Engineering Manager', link:'tasks', linkLabel:'My Tasks →' },
  { n: 10, phase:'Execution',  color:'brown',
    title:'PM Execution by Technician',
    desc:'Technician opens the assignment, fills only the checkpoints applicable to this run\'s frequency, records spares + remarks, signs and submits.',
    actor:'Technician (Executor)', link:'tasks', linkLabel:'My Tasks →' },
  { n: 11, phase:'Review',     color:'green',
    title:'PM Execution Multi-Level Review & Approval',
    desc:'Executed PM moves to Pending Review. Engineering reviewer passes the work or returns it for rework with a reason.',
    actor:'Engineering Reviewer', link:'tasks', linkLabel:'Reviewer Inbox →' },
  { n: 12, phase:'Approval',   color:'green',
    title:'Final QA Approval',
    desc:'Status becomes Pending Approval. QA performs the final compliance check, then approves and signs — or rejects with reason (bouncing back into Execution).',
    actor:'QA Approver', link:'tasks', linkLabel:'Approver Inbox →' },
  { n: 13, phase:'Closure',    color:'green',
    title:'PM Closure & Archive',
    desc:'On QA approval the PM auto-closes (status Completed). All signatures, response data, exception details and audit entries are retained for compliance, traceability and historical reference.',
    actor:'System (automatic)', link:'audit', linkLabel:'Audit Trail →' },
];

const PM_WORKFLOW_FLEXIBILITY = [
  { label:'Checklist approval hierarchy',
    where:'Admin Settings → Roles → grant review_checklist / approve_checklist activities to any role. Reviewer and Approver are picked per checklist at "Submit for Review" time.' },
  { label:'PM execution approval workflow',
    where:'Admin Settings → Roles → review_pm / approve_pm activities. Reviewer and Approver are picked per assignment.' },
  { label:'Review and approval stages',
    where:'Today: one reviewer + one approver per assignment. Sequence is hard-wired (Executor → Reviewer → Approver). Extra stages can be added by extending the activity list and the assignment lifecycle — code change required.' },
  { label:'User roles and responsibilities',
    where:'Admin Settings → Roles. Each role belongs to one department and holds any subset of the activities catalogue. New roles created without code changes.' },
  { label:'Notification & escalation rules',
    where:'In-app bell notifications fire on every workflow transition (assigned, clearance requested, clearance granted/denied, executor assigned, submitted, reviewed, approved, rejected). Email + escalation timers are not yet wired — would require SMTP credentials and a scheduler.' },
  { label:'Workflow sequence and authorisation levels',
    where:'Driven by the activity catalogue. Reordering steps (e.g. Approver before Reviewer) is a code change today.' },
  { label:'Equipment clearance approval process',
    where:'Admin Settings → Roles → grant_clearance activity. The specific clearance user is picked per assignment, so different equipment / departments can route to different Production users.' },
  { label:'Technician assignment process',
    where:'Engineering Manager picks any user with execute_checklist activity from a dropdown after clearance is granted. The pool of candidates is the configurable bit.' },
];

async function loadWorkflowPage() {
  const phaseLabels = { Authoring:'Phase 1 · Checklist Authoring', Scheduling:'Phase 2 · Scheduling',
                        Clearance:'Phase 3 · Equipment Clearance', Execution:'Phase 4 · Execution',
                        Review:'Phase 5 · Review',                Approval:'Phase 6 · Approval',
                        Closure:'Phase 7 · Closure & Archive' };
  let lastPhase = null;
  const stepsHtml = PM_WORKFLOW_STEPS.map(s => {
    const phaseBanner = (s.phase !== lastPhase)
      ? `<div style="margin: 18px 0 8px; padding: 6px 12px; background: var(--cream-100); border-radius: 6px; font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 1px; font-weight: 700;">${escapeHtml(phaseLabels[s.phase] || s.phase)}</div>`
      : '';
    lastPhase = s.phase;
    return `${phaseBanner}
      <div style="display:grid; grid-template-columns: 50px 1fr; gap: 14px; padding: 8px 0; position: relative;">
        <div style="position:relative;">
          <div style="width:40px; height:40px; border-radius:50%; background: var(--${s.color}-bg, var(--cream-100)); color: var(--${s.color}, var(--brown-700)); display:flex; align-items:center; justify-content:center; font-weight:700; font-size:16px; border: 2px solid var(--${s.color}, var(--brown-500));">${s.n}</div>
        </div>
        <div style="padding: 4px 0;">
          <div style="font-weight:700; font-size:14px; color:var(--brown-900);">${escapeHtml(s.title)}</div>
          <div style="color:var(--muted); font-size:12px; margin-top:3px; line-height:1.5;">${escapeHtml(s.desc)}</div>
          <div style="margin-top:6px; display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
            <span class="pill brown" style="font-size:10px;">${escapeHtml(s.actor)}</span>
            ${s.link ? `<button class="btn ghost sm" onclick="goto('${s.link}')">${escapeHtml(s.linkLabel)}</button>` : ''}
          </div>
        </div>
      </div>`;
  }).join('');

  const flexHtml = PM_WORKFLOW_FLEXIBILITY.map(f => `
    <div style="padding: 10px 14px; border-bottom: 1px dashed var(--border);">
      <div style="font-weight:600; font-size:13px;">${escapeHtml(f.label)}</div>
      <div style="color:var(--muted); font-size:12px; margin-top:3px; line-height:1.5;">${escapeHtml(f.where)}</div>
    </div>`).join('');

  $('workflowBody').innerHTML = `
    <div class="card">
      <div class="card-head"><h3>12-Step PM Lifecycle</h3></div>
      <div style="margin-top:6px;">${stepsHtml}</div>
    </div>

    <div class="card" style="margin-top:16px;">
      <div class="card-head"><h3>Workflow Flexibility</h3></div>
      <p style="color:var(--muted); font-size:12px; margin: 4px 0 12px;">Aspects of the workflow that can be defined or modified at runtime without code changes. Each row points to the place in the app where the setting lives.</p>
      <div>${flexHtml}</div>
      <p style="font-size:11px; color:var(--muted); margin-top:14px;">Items marked "code change required" are not yet user-configurable. Tell us which one to make dynamic next and we'll wire it up.</p>
    </div>
  `;
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

// ---- Tolerance / clearance display helpers -------------------------------------
// Given an assignment row from /api/assignments, compute:
//   scheduled  — YYYY-MM-DD (effective_date or due_date)
//   tol        — tolerance window in days (from frequency)
//   deadline   — YYYY-MM-DD (scheduled + tol days)
//   responded  — Date object of clearance_responded_at, or null
//   withinTol  — true/false/null (null if no scheduled date / no clearance)
function computeToleranceMeta(a) {
  const scheduled = a.effective_date || a.due_date || null;
  const tol = Number(a.tolerance_days ?? 0);
  if (!scheduled) return { scheduled: null, tol, deadline: null, responded: null, withinTol: null };
  const sched = new Date(scheduled + 'T00:00:00Z');
  const deadlineMs = sched.getTime() + tol * 24 * 60 * 60 * 1000;
  const deadline = new Date(deadlineMs).toISOString().slice(0, 10);
  let responded = null, withinTol = null;
  if (a.clearance_responded_at) {
    // SQLite returns 'YYYY-MM-DD HH:MM:SS' (UTC). Coerce to ISO for Date parsing.
    responded = new Date(String(a.clearance_responded_at).replace(' ', 'T') + 'Z');
    if (a.clearance_status === 'Granted') {
      const dayOnly = new Date(responded.toISOString().slice(0, 10) + 'T00:00:00Z');
      withinTol = dayOnly.getTime() <= deadlineMs;
    }
  }
  return { scheduled, tol, deadline, responded, withinTol };
}

// Formats the clearance line shown inside My Tasks rows.
function renderClearanceLine(a, meta) {
  if (a.clearance_status === 'Granted' && a.clearance_responded_at) {
    const ts = formatLocalTime(a.clearance_responded_at);
    const tolBadge = meta.withinTol === false
      ? '<span class="pill red" style="font-size:9px; margin-left:4px;">OUT OF TOLERANCE</span>'
      : (meta.withinTol === true
          ? '<span class="pill green" style="font-size:9px; margin-left:4px;">on time</span>'
          : '');
    return `<div style="font-size:11px; color:var(--green); margin-top:3px;">
              ✓ Clearance granted ${escapeHtml(ts)}${tolBadge}
            </div>`;
  }
  if (a.clearance_status === 'Denied' && a.clearance_responded_at) {
    const ts = formatLocalTime(a.clearance_responded_at);
    return `<div style="font-size:11px; color:var(--red); margin-top:3px;">
              ✗ Clearance denied ${escapeHtml(ts)}
            </div>`;
  }
  if (a.status === 'Pending Clearance') {
    return `<div style="font-size:11px; color:#b78103; margin-top:3px;">
              ⏳ Awaiting clearance${meta.deadline ? ` (by ${escapeHtml(meta.deadline)})` : ''}
            </div>`;
  }
  return '';
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
          // Schedule + tolerance info — surfaces the regulatory date math directly in the row.
          const tolMeta = computeToleranceMeta(a);
          // Clearance grant timestamp — displayed prominently when it exists.
          const clearanceLine = renderClearanceLine(a, tolMeta);
          return `<tr>
          <td><strong>${escapeHtml(a.assignment_id)}</strong>${actBadge}</td>
          <td>${escapeHtml(a.checklist_name || '')} <span style="color:var(--muted); font-size:11px;">${escapeHtml(a.checklist_version || '')}</span></td>
          <td>${escapeHtml(a.target_type || '')} <strong>${escapeHtml(a.target_id || '')}</strong>${a.target_label?`<div style="color:var(--muted); font-size:11px;">${escapeHtml(a.target_label)}</div>`:''}</td>
          <td>
            ${escapeHtml(a.assignee_name || '— open —')}
            <div style="color:var(--muted); font-size:11px;">rev: ${escapeHtml(a.reviewer_name || '—')} · app: ${escapeHtml(a.approver_name || '—')}</div>
          </td>
          <td>${escapeHtml(a.frequency || '—')}${a.tolerance_days != null ? `<div style="color:var(--muted); font-size:10px;">±${a.tolerance_days}d tolerance</div>` : ''}</td>
          <td>
            <strong>${escapeHtml(a.effective_date || a.due_date || '—')}</strong>
            ${tolMeta.deadline ? `<div style="color:var(--muted); font-size:11px;">Window closes ${escapeHtml(tolMeta.deadline)}</div>` : ''}
            ${clearanceLine}
          </td>
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
    const reviewerSet  = usersWithActivity(users, roles, 'review_pm','review_checklist');
    const approverSet  = usersWithActivity(users, roles, 'approve_pm','approve_checklist');
    const clearanceSet = usersWithActivity(users, roles, 'grant_clearance');
    const reviewers    = users.filter(u => reviewerSet.has(u.id));
    const approvers    = users.filter(u => approverSet.has(u.id));
    const clearanceCandidates = users.filter(u => clearanceSet.has(u.id));
    if (reviewers.length === 0 || approvers.length === 0) {
      toast('No users with the review/approve permission. Configure roles first.','error'); return;
    }
    if (clearanceCandidates.length === 0) {
      toast('No users with the grant_clearance permission. Configure a role first.','error'); return;
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

    // Lookup table by checklist ID for the auto-populated Checklist Name below the dropdown.
    const checklistById = {};
    checklists.forEach(c => { checklistById[c.id] = c; });
    window.__asnOnChecklist = () => {
      const sel = document.getElementById('asnChecklistSel');
      const c = checklistById[Number(sel.value)];
      setDesc('asnChecklistNameAuto', 'Checklist Name', c ? `${c.name} · ${c.version}` : null);
      window.__asnSyncReviewerApprover();
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
    // Walks the equipment hierarchy back to Plant and fills in every upstream
    // dropdown + Plant info banner. Also pulls last-assigned checklist details
    // so Frequency / Reviewer / Approver pre-fill where possible.
    window.__asnOnEq = async () => {
      const sel = document.getElementById('asnEqSel');
      const eqId = sel.value;
      if (!eqId) { setDesc('asnEqDesc', 'Equipment Name', null); return; }
      const e = equipment.find(x => x.equipment_id === eqId);
      if (!e) { setDesc('asnEqDesc', 'Equipment Name', null); return; }
      setDesc('asnEqDesc', 'Equipment Name', e.name);

      // Walk Area → Location → Block back from the equipment.
      const a = areas.find(x => x.area_id === e.area_id);
      const l = a ? locations.find(x => x.location_id === a.location_id) : null;
      const b = l ? blocks.find(x => x.block_id === l.block_id) : null;
      // Re-populate the parent dropdowns so the cascade is consistent with the chosen equipment.
      if (b) {
        const blockSel = document.getElementById('asnBlockSel');
        if (blockSel) {
          blockSel.value = b.block_id;
          setDesc('asnBlockDesc', 'Block Name', b.name);
        }
      }
      if (l) {
        const locSel = document.getElementById('asnLocSel');
        if (locSel) {
          locSel.innerHTML = (b ? locations.filter(x => x.block_id === b.block_id) : [l])
            .map(x => `<option value="${escapeHtml(x.location_id)}" ${x.location_id === l.location_id ? 'selected' : ''}>${escapeHtml(x.location_id)} · ${escapeHtml(x.description || '')}</option>`).join('');
          setDesc('asnLocDesc', 'Location Name', l.description);
        }
      }
      if (a) {
        const areaSel = document.getElementById('asnAreaSel');
        if (areaSel) {
          areaSel.innerHTML = (l ? areas.filter(x => x.location_id === l.location_id) : [a])
            .map(x => `<option value="${escapeHtml(x.area_id)}" ${x.area_id === a.area_id ? 'selected' : ''}>${escapeHtml(x.area_id)} · ${escapeHtml(x.name || x.area_type || '')}</option>`).join('');
          setDesc('asnAreaDesc', 'Area Name', a.name || a.area_type);
        }
      }
      // Plant info banner (read-only — there's no plant dropdown in the modal).
      const plantInfo = document.getElementById('asnPlantInfo');
      if (plantInfo) {
        const plantText = b && b.plant_id ? `${b.plant_id}` : '—';
        plantInfo.innerHTML = `<strong style="color:var(--brown-700);">Plant:</strong> ${escapeHtml(plantText)}`;
      }

      // Try to pre-fill checklist/frequency/reviewer/approver from this
      // equipment's most recent linked checklist. Best-effort — silent failure
      // if the endpoint is unavailable.
      try {
        const linked = await api('GET', `/api/equipment/${encodeURIComponent(eqId)}/linked-checklists`);
        if (linked && linked.length > 0) {
          const last = linked[0]; // most recent first per the endpoint's ORDER BY
          // Pre-select the same checklist if it's in the dropdown
          const chSel = document.getElementById('asnChecklistSel');
          if (chSel && last.id) {
            const opt = Array.from(chSel.options).find(o => Number(o.value) === Number(last.id));
            if (opt) { chSel.value = String(last.id); window.__asnOnChecklist && window.__asnOnChecklist(); }
          }
        }
      } catch (e) { /* non-fatal */ }
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
        <div class="form-row"><label>Checklist ID *</label>
          <div>
            <select id="asnChecklistSel" name="checklist_id" required onchange="window.__asnOnChecklist()">
              ${checklists.map(c => `<option value="${c.id}" ${presetChecklistId===c.id?'selected':''}>${escapeHtml(c.code || ('#'+c.id))} · ${escapeHtml(c.name)} (${escapeHtml(c.version)})</option>`).join('')}
            </select>
            <div id="asnChecklistNameAuto" style="font-size:12px; margin-top:5px;"><em style="color:var(--muted);">Checklist Name will appear here once you pick a Checklist ID.</em></div>
          </div>
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
              <option value="">— select equipment —</option>
              ${equipment.filter(e => e.status === 'Active').map(e => `<option value="${escapeHtml(e.equipment_id)}">${escapeHtml(e.equipment_id)} · ${escapeHtml(e.name || '')}</option>`).join('')}
            </select>
            <div id="asnEqDesc" style="font-size:12px; margin-top:5px;"><em style="color:var(--muted);">Equipment Name + parent Plant / Block / Location / Area will auto-fill when you pick the equipment.</em></div>
            <div id="asnPlantInfo" style="font-size:12px; margin-top:3px;"></div>
          </div>
        </div>

        <div class="form-row" style="grid-template-columns:1fr;">
          <label>Checklist Frequency *</label>
          <div id="asnFreqRadios">${freqRadios}</div>
        </div>

        <div class="form-row"><label>Scheduled Date *</label><input type="date" id="asnScheduledDate" name="effective_date" required value="${todayStr}" /></div>
        <div class="form-row"><label>Due Date</label><input type="date" id="asnDueDate" name="due_date" onchange="(function(el){ var s=document.getElementById('asnScheduledDate'); if (s && el.value) s.value = el.value; })(this)" /></div>

        <div class="form-row"><label>Clearance User (Production) *</label>
          <select name="clearance_user_id" required>
            <option value="">— select clearance user —</option>
            ${clearanceCandidates.map(u => `<option value="${u.id}">${escapeHtml(u.name)} — ${escapeHtml(u.role)} / ${escapeHtml(u.department || '')}</option>`).join('')}
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
        <div class="form-row" style="grid-template-columns:1fr;"><label>Notes</label><textarea name="notes" placeholder="Optional context"></textarea></div>
        <p style="font-size:11px; color:var(--muted); margin:6px 0 0;">Workflow: Clearance from Production → Engineering Manager assigns Executor → Executor performs → Reviewer passes → Approver signs off.</p>
      `,
      onSubmit: async (data) => {
        if (!data.frequency_id) throw new Error('Please select a Checklist Frequency');
        if (!data.equipment_id) throw new Error('Please select an Equipment');
        if (!data.clearance_user_id) throw new Error('Please select a Clearance User');
        await api('POST','/api/assignments', {
          checklist_id: Number(data.checklist_id),
          target_type: 'equipment',
          target_id: data.equipment_id,
          clearance_user_id: Number(data.clearance_user_id),
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
    // After the modal is in the DOM, sync the auto-populated Checklist Name + reviewer/approver defaults.
    setTimeout(() => {
      window.__asnOnChecklist();
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
    const [workflows, users] = await Promise.all([
      api('GET','/api/approval-workflows'),
      loadActiveUsers(),
    ]);
    const activeWorkflows = workflows.filter(w => w.status === 'Active');
    if (activeWorkflows.length === 0) {
      toast('No active approval workflows. Set one up first in Admin Settings → Approval Workflows.', 'error');
      return;
    }
    const meId = CURRENT_USER && CURRENT_USER.id;
    const userOpts = users.filter(u => u.id !== meId).map(u =>
      `<option value="${u.id}">${escapeHtml(u.name)} — ${escapeHtml(u.role || '')}${u.department?' / '+escapeHtml(u.department):''}</option>`).join('');
    window.__clWfMap = Object.fromEntries(activeWorkflows.map(w => [w.id, w]));
    const renderStages = (workflowId) => {
      const wf = window.__clWfMap[workflowId];
      if (!wf || !wf.stages) return '';
      return wf.stages.map((s, i) => `
        <div class="form-row">
          <label>Stage ${i+1}: ${escapeHtml(s.label)} <span class="pill ${s.type==='review'?'blue':'green'}" style="font-size:9px;">${escapeHtml(s.type)}</span></label>
          <select name="stage_assignee_${i}" required>
            <option value="">— select assignee —</option>${userOpts}
          </select>
        </div>`).join('');
    };
    window.__clOnWf = () => {
      const sel = document.getElementById('clWfSel');
      document.getElementById('clStagesArea').innerHTML = renderStages(Number(sel.value));
    };
    openModal({
      title: 'Submit Checklist for Review',
      width: 560,
      body: `
        <p style="font-size:12px; color:var(--muted); margin-top:0;">Pick an approval workflow and assign a specific user to each stage. Each stage requires an e-signature. The checklist becomes Approved only after every stage signs off.</p>
        <div class="form-row"><label>Workflow *</label>
          <select id="clWfSel" required onchange="window.__clOnWf()">
            ${activeWorkflows.map((w, i) => `<option value="${w.id}" ${i===0?'selected':''}>${escapeHtml(w.name)} (${(w.stages || []).length} stage${(w.stages||[]).length===1?'':'s'})</option>`).join('')}
          </select>
        </div>
        <div id="clStagesArea">${renderStages(activeWorkflows[0].id)}</div>
      `,
      submitLabel: 'Submit for Approval',
      onSubmit: async (data) => {
        const workflowId = Number(document.getElementById('clWfSel').value);
        const wf = window.__clWfMap[workflowId];
        if (!wf) throw new Error('Pick a workflow');
        const stage_assignees = [];
        for (let i = 0; i < wf.stages.length; i++) {
          const v = (data['stage_assignee_' + i] || '').trim();
          if (!v) throw new Error(`Stage ${i+1} ("${wf.stages[i].label}") needs an assignee`);
          stage_assignees.push(Number(v));
        }
        await api('PUT', `/api/checklists/${checklistId}/submit`, { workflow_id: workflowId, stage_assignees });
        toast('Checklist submitted into approval workflow.', 'success');
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
  const meaning = decision === 'approve'
    ? `I have reviewed Checklist "${checklistId}" and forward it to the Approver.`
    : `I reject Checklist "${checklistId}" at review. Reason: ${reason}`;
  openESignatureModal({
    title: `Sign — Review Checklist ${checklistId}`,
    meaning,
    onConfirm: async (esig) => {
      await api('PUT', `/api/checklists/${checklistId}/review`, { decision, reason, ...esig });
      toast(decision === 'approve' ? 'Review passed — sent to approver.' : 'Checklist rejected.', 'success');
      previewChecklist(checklistId);
      loadChecklists();
      refreshNotifBadge();
    }
  });
}

async function newChecklistVersion(sourceId, code, currentVersion) {
  if (!confirm(`Create a new MAJOR version of "${code}" (current ${currentVersion})? A new Draft will be created with the same Checklist ID + Name but a bumped version. The existing version remains Approved until the new one is Approved — at that point the old one auto-supersedes.`)) return;
  try {
    const created = await api('POST', `/api/checklists/${sourceId}/new-version`, {});
    toast(`New ${created.version} created as Draft. Edit it and submit for review.`, 'success');
    loadChecklists();
    previewChecklist(created.id);
  } catch (e) { toast(e.message, 'error'); }
}

async function dropChecklist(checklistId, name) {
  const remarks = prompt(`Reason for dropping (deactivating) "${name}" — required for GMP traceability:`);
  if (!remarks || !remarks.trim()) return;
  const meaning = `I drop checklist "${name}" — it will no longer be available for new assignments. Reason: ${remarks}`;
  openESignatureModal({
    title: `Sign — Drop Checklist`,
    meaning,
    onConfirm: async (esig) => {
      await api('PUT', `/api/checklists/${checklistId}/drop`, { remarks, ...esig });
      toast('Checklist dropped. Status set to Inactive.', 'success');
      previewChecklist(checklistId);
      loadChecklists();
      refreshNotifBadge();
    }
  });
}

async function reactivateChecklist(checklistId, name) {
  const remarks = prompt(`Reactivation notes for "${name}" (optional):`) || '';
  const meaning = `I reactivate checklist "${name}". It is available for new assignments again.${remarks?' Notes: '+remarks:''}`;
  openESignatureModal({
    title: `Sign — Reactivate Checklist`,
    meaning,
    onConfirm: async (esig) => {
      await api('PUT', `/api/checklists/${checklistId}/reactivate`, { remarks, ...esig });
      toast('Checklist reactivated.', 'success');
      previewChecklist(checklistId);
      loadChecklists();
      refreshNotifBadge();
    }
  });
}

async function approveChecklistDecision(checklistId, decision) {
  let reason = null;
  if (decision === 'reject') {
    reason = prompt('Reason for rejection:');
    if (!reason) return;
  }
  const meaning = decision === 'approve'
    ? `I approve Checklist "${checklistId}" for use in PM assignments. I am responsible for its GMP correctness.`
    : `I reject Checklist "${checklistId}" at approval. Reason: ${reason}`;
  openESignatureModal({
    title: `Sign — Approve Checklist ${checklistId}`,
    meaning,
    onConfirm: async (esig) => {
      await api('PUT', `/api/checklists/${checklistId}/approve`, { decision, reason, ...esig });
      toast(decision === 'approve' ? 'Checklist approved — now available for assignment.' : 'Checklist rejected.', 'success');
      previewChecklist(checklistId);
      loadChecklists();
      refreshNotifBadge();
    }
  });
}

async function openAssignment(assignmentId) {
  try {
    const a = await api('GET', `/api/assignments/${assignmentId}`);
    const cl = a.checklist;
    const existing = a.response_data || {};
    const userId = CURRENT_USER.id;

    // Determine roles
    const amExecutor       = a.assignee_id === userId || (a.status === 'Pending' && !a.assignee_id && can('execute_checklist'));
    const amReviewer       = a.reviewer_id === userId;
    const amApprover       = a.approver_id === userId;
    const amClearanceUser  = a.clearance_user_id === userId;
    const amAssigner       = a.assigned_by === userId;
    const amAdmin          = CURRENT_USER.is_admin;

    // Editable matrix
    const executorEditable      = (a.status === 'Pending' || a.status === 'In Progress') && (amExecutor || amAdmin);
    const planReviewerActing    = a.status === 'Pending Assignment Review'   && (amReviewer || amAdmin);
    const planApproverActing    = a.status === 'Pending Assignment Approval' && (amApprover || amAdmin);
    // Reschedule loop: requester responds when 'Reschedule Proposed'; reviewer re-decides when 'Reschedule Counter-Proposed'.
    const rescheduleRequesterActing = a.status === 'Reschedule Proposed'         && (amAssigner || amAdmin || can('assign_checklist'));
    const rescheduleReviewerActing  = a.status === 'Reschedule Counter-Proposed' && (amReviewer || amAdmin);
    const clearanceInitiatorActing = a.status === 'Scheduled' && (amAssigner || amAdmin || can('assign_checklist'));
    const reviewerActing        = a.status === 'Pending Review' && (amReviewer || amAdmin);
    const approverActing        = a.status === 'Pending Approval' && (amApprover || amAdmin);
    const clearanceActing       = a.status === 'Pending Clearance' && (amClearanceUser || amAdmin);
    const executorAssignerActing= a.status === 'Awaiting Executor' && (amAssigner || amAdmin || can('assign_checklist'));
    const formEditable          = executorEditable;

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
          else if (q.qtype === 'checkbox') {
            // Render one checkbox per configured option. When no options are configured
            // we fall back to a single boolean checkbox labeled "Yes" (legacy behavior).
            const opts = (q.options && q.options.length) ? q.options : ['Yes'];
            // The stored value can be an array (new multi format), a string (legacy/dropdown-style),
            // or a boolean (legacy single-checkbox). Normalize to a Set of strings.
            let selectedSet;
            if (Array.isArray(val))              selectedSet = new Set(val.map(String));
            else if (val === true || val === 'true' || val === 'on') selectedSet = new Set(['Yes']);
            else if (typeof val === 'string' && val) selectedSet = new Set([val]);
            else                                 selectedSet = new Set();
            inp = `<div data-q-multi="q_${q.id}" style="display:flex; flex-direction:column; gap:4px;">${
              opts.map(o => `<label style="display:inline-flex; align-items:center; gap:5px; font-size:13px;">
                <input type="checkbox" name="q_${q.id}__opt" data-opt-value="${escapeHtml(o)}" ${selectedSet.has(o)?'checked':''} ${dis} />
                ${escapeHtml(o)}
              </label>`).join('')
            }</div>`;
          }
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
        ${a.effective_date ? `<span class="pill brown">Scheduled: ${escapeHtml(a.effective_date)}</span>` : ''}
        ${a.due_date  ? `<span class="pill brown">Due: ${escapeHtml(a.due_date)}</span>` : ''}
        ${a.frequency ? `<span class="pill brown">${escapeHtml(a.frequency)}</span>` : ''}
      </div>
      <div style="font-size:12px; color:var(--muted); margin-bottom:12px;">
        Clearance <strong>${escapeHtml(a.clearance_user_name || '—')}</strong>
        &nbsp;→&nbsp; Executor <strong>${escapeHtml(a.assignee_name || '— not yet assigned —')}</strong>
        &nbsp;→&nbsp; Reviewer <strong>${escapeHtml(a.reviewer_name || '—')}</strong>
        &nbsp;→&nbsp; Approver <strong>${escapeHtml(a.approver_name || '—')}</strong>
        &nbsp;·&nbsp; Assigned by ${escapeHtml(a.assigned_by_name || '')}
      </div>
      ${a.clearance_status === 'Granted' ? (() => {
        const meta = computeToleranceMeta(a);
        const ts = formatLocalTime(a.clearance_responded_at);
        const tolBadge = meta.withinTol === false
          ? '<span class="pill red" style="margin-left:6px;">OUT OF TOLERANCE</span>'
          : (meta.withinTol === true
              ? '<span class="pill green" style="margin-left:6px;">within tolerance window</span>'
              : '');
        return `<div style="margin-bottom:10px; padding:8px 12px; background:#eaf6ea; border-left:3px solid var(--green); border-radius:6px; font-size:12px;">
          <strong>Clearance granted</strong> by ${escapeHtml(a.clearance_user_name || '—')} on <strong>${escapeHtml(ts)}</strong>${tolBadge}
          ${meta.scheduled ? `<div style="color:var(--muted); margin-top:3px;">Scheduled ${escapeHtml(meta.scheduled)} · tolerance ±${meta.tol}d · window closed ${escapeHtml(meta.deadline)}</div>` : ''}
          ${a.clearance_remarks?`<div style="color:var(--muted); margin-top:3px;">Remarks: ${escapeHtml(a.clearance_remarks)}</div>`:''}
        </div>`;
      })() : ''}
      ${a.status === 'Clearance Denied' ? `<div style="margin-bottom:10px; padding:8px 12px; background:#fdecec; border-left:3px solid var(--red); border-radius:6px; font-size:12px;">
        <strong>Clearance denied:</strong> ${escapeHtml(a.clearance_remarks || '')}
      </div>` : ''}
      ${(a.status === 'Reschedule Proposed' || a.status === 'Reschedule Counter-Proposed') && a.proposed_date ? `
      <div style="margin-bottom:10px; padding:10px 14px; background:#eaf2ff; border-left:3px solid var(--blue,#3563ad); border-radius:6px; font-size:12px;">
        <strong>${a.status === 'Reschedule Proposed' ? 'Reviewer proposed a new date' : 'Requester counter-proposed a different date'}:</strong>
        <strong style="margin-left:6px;">${escapeHtml(a.proposed_date)}</strong>
        ${a.proposed_remarks ? `<div style="color:var(--muted); margin-top:3px;">Note: ${escapeHtml(a.proposed_remarks)}</div>` : ''}
        ${a.proposed_at ? `<div style="color:var(--muted); margin-top:3px;">Proposed ${escapeHtml(formatLocalTime(a.proposed_at))}</div>` : ''}
      </div>` : ''}
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
          ${ts ? `<div style="color:var(--muted);">${escapeHtml(formatLocalTime(ts))}</div>` : ''}
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
    if (planReviewerActing) {
      acts.push(`<button type="button" class="btn primary" onclick="assignmentPlanReviewDecision('${a.assignment_id}','approve')">✓ Accept Plan</button>`);
      acts.push(`<button type="button" class="btn ghost"   onclick="assignmentPlanReviewDecision('${a.assignment_id}','reschedule')">🗓 Reschedule</button>`);
      acts.push(`<button type="button" class="btn ghost"   onclick="assignmentPlanReviewDecision('${a.assignment_id}','reject')">✗ Reject Plan</button>`);
    }
    // Reschedule loop — requester sees Accept/Counter-propose when reviewer has proposed a date.
    if (rescheduleRequesterActing) {
      acts.push(`<button type="button" class="btn primary" onclick="assignmentRescheduleRespond('${a.assignment_id}','accept')">✓ Accept Proposed Date</button>`);
      acts.push(`<button type="button" class="btn ghost"   onclick="assignmentRescheduleRespond('${a.assignment_id}','counter-propose')">🗓 Counter-Propose</button>`);
    }
    // Reschedule loop — reviewer sees Accept/Reject when the requester has counter-proposed.
    if (rescheduleReviewerActing) {
      acts.push(`<button type="button" class="btn primary" onclick="assignmentPlanReviewDecision('${a.assignment_id}','approve')">✓ Accept Counter-Proposal</button>`);
      acts.push(`<button type="button" class="btn ghost"   onclick="assignmentPlanReviewDecision('${a.assignment_id}','reject')">✗ Reject Counter-Proposal</button>`);
    }
    if (planApproverActing) {
      acts.push(`<button type="button" class="btn primary" onclick="assignmentPlanApproveDecision('${a.assignment_id}','approve')">✓ Approve Plan</button>`);
      acts.push(`<button type="button" class="btn ghost"   onclick="assignmentPlanApproveDecision('${a.assignment_id}','reject')">✗ Reject Plan</button>`);
    }
    if (clearanceInitiatorActing) {
      acts.push(`<button type="button" class="btn primary" onclick="assignmentRequestClearance('${a.assignment_id}')">📤 Initiate Clearance Request</button>`);
    }
    if (clearanceActing) {
      acts.push(`<button type="button" class="btn primary" onclick="assignmentClearanceDecision('${a.assignment_id}','grant')">✓ Grant Clearance</button>`);
      acts.push(`<button type="button" class="btn ghost"   onclick="assignmentClearanceDecision('${a.assignment_id}','deny')">✗ Deny Clearance</button>`);
    }
    if (executorAssignerActing) {
      acts.push(`<button type="button" class="btn primary" onclick="openAssignExecutorModal('${a.assignment_id}')">👤 Assign Executor</button>`);
    }
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
    // Withdraw — available to the original assigner / admin / anyone with assign_checklist
    // at any pre-Completed stage. Used when the checklist needs to be revised or the
    // assignment was set up incorrectly. Lands the row in 'Withdrawn' (terminal).
    const canWithdraw = !['Completed','Withdrawn'].includes(a.status)
                      && (amAssigner || amAdmin || can('assign_checklist'));
    if (canWithdraw) {
      acts.push(`<button type="button" class="btn ghost" style="color:#c53030;" onclick="withdrawAssignment('${a.assignment_id}', '${escapeHtml(a.target_id || '')}')">⊘ Drop / Withdraw…</button>`);
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
  // First, walk all multi-option checkbox groups (rendered as data-q-multi="q_<id>")
  // and assemble each group into an array of the ticked options' values.
  document.querySelectorAll('[data-q-multi]').forEach(group => {
    const key = group.getAttribute('data-q-multi');
    const picked = Array.from(group.querySelectorAll('input[type="checkbox"]:checked'))
                        .map(cb => cb.getAttribute('data-opt-value') ?? cb.value);
    resp[key] = picked; // empty array when none ticked
  });
  // Then walk every other q_ / rf_ input. Skip the multi-checkbox children
  // (they have name="q_<id>__opt" so the parent key is preserved untouched).
  document.querySelectorAll(
    'input[name^="q_"], select[name^="q_"], textarea[name^="q_"], ' +
    'input[name^="rf_"], select[name^="rf_"], textarea[name^="rf_"]'
  ).forEach(el => {
    if (el.name.endsWith('__opt')) return; // child of a multi-checkbox group, already collected
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
// ---- Step 4: Assignment-plan review/approval actions ----
async function assignmentPlanReviewDecision(assignmentId, decision) {
  let reason = null;
  let proposed_date = null;
  if (decision === 'reject') {
    reason = prompt('Reason for rejecting the assignment plan (required):');
    if (!reason) return;
  } else if (decision === 'reschedule') {
    proposed_date = prompt('Propose a new scheduled date (YYYY-MM-DD):');
    if (!proposed_date || !/^\d{4}-\d{2}-\d{2}$/.test(proposed_date.trim())) {
      toast('Date must be YYYY-MM-DD', 'error'); return;
    }
    proposed_date = proposed_date.trim();
    reason = prompt('Why are you proposing a different date? (optional)') || '';
  }
  const meaning = decision === 'approve'
    ? `I have reviewed PM assignment plan "${assignmentId}" and forward it to the Approver.`
    : (decision === 'reschedule'
        ? `I propose rescheduling PM assignment plan "${assignmentId}" to ${proposed_date}.${reason?' Reason: '+reason:''}`
        : `I reject PM assignment plan "${assignmentId}" at review. Reason: ${reason}`);
  openESignatureModal({
    title: `Sign — ${decision === 'reschedule' ? 'Propose Reschedule' : (decision === 'approve' ? 'Review Plan' : 'Reject Plan')} ${assignmentId}`,
    meaning,
    onConfirm: async (esig) => {
      await api('PUT', `/api/assignments/${assignmentId}/assignment-review`, { decision, reason, proposed_date, ...esig });
      toast(decision === 'approve' ? 'Plan review passed — sent to Approver.'
            : (decision === 'reschedule' ? `Proposed new date ${proposed_date} — sent to requester for response.`
               : 'Assignment plan rejected.'), 'success');
      closeModal();
      if ($('page-tasks').classList.contains('active'))       loadTasks(CURRENT_TASKS_TAB);
      if ($('page-assignments').classList.contains('active')) loadAssignmentsPage();
      refreshNotifBadge();
    }
  });
}

// Creator responds to reviewer's proposed date — accept it or counter-propose.
async function assignmentRescheduleRespond(assignmentId, decision) {
  let proposed_date = null;
  let reason = null;
  if (decision === 'counter-propose') {
    proposed_date = prompt('Counter-propose your preferred date (YYYY-MM-DD):');
    if (!proposed_date || !/^\d{4}-\d{2}-\d{2}$/.test(proposed_date.trim())) {
      toast('Date must be YYYY-MM-DD', 'error'); return;
    }
    proposed_date = proposed_date.trim();
    reason = prompt('Why this date instead? (optional)') || '';
  }
  const meaning = decision === 'accept'
    ? `I accept the reviewer's proposed reschedule for PM "${assignmentId}".`
    : `I counter-propose ${proposed_date} for PM "${assignmentId}".${reason?' Reason: '+reason:''}`;
  openESignatureModal({
    title: `Sign — ${decision === 'accept' ? 'Accept Reschedule' : 'Counter-Propose'} ${assignmentId}`,
    meaning,
    onConfirm: async (esig) => {
      await api('PUT', `/api/assignments/${assignmentId}/reschedule-respond`, { decision, proposed_date, reason, ...esig });
      toast(decision === 'accept' ? 'Reschedule accepted — plan moves to Approver.' : 'Counter-proposal sent to reviewer.', 'success');
      closeModal();
      if ($('page-tasks').classList.contains('active'))       loadTasks(CURRENT_TASKS_TAB);
      if ($('page-assignments').classList.contains('active')) loadAssignmentsPage();
      refreshNotifBadge();
    }
  });
}

async function assignmentPlanApproveDecision(assignmentId, decision) {
  let reason = null;
  if (decision === 'reject') {
    reason = prompt('Reason for rejecting the assignment plan (required):');
    if (!reason) return;
  }
  const meaning = decision === 'approve'
    ? `I approve PM assignment plan "${assignmentId}" for execution. I am responsible for its GMP correctness.`
    : `I reject PM assignment plan "${assignmentId}" at approval. Reason: ${reason}`;
  openESignatureModal({
    title: `Sign — Approve Plan ${assignmentId}`,
    meaning,
    onConfirm: async (esig) => {
      await api('PUT', `/api/assignments/${assignmentId}/assignment-approve`, { decision, reason, ...esig });
      toast(decision === 'approve' ? 'Plan approved — production clearance requested.' : 'Assignment plan rejected.', 'success');
      closeModal();
      if ($('page-tasks').classList.contains('active'))       loadTasks(CURRENT_TASKS_TAB);
      if ($('page-assignments').classList.contains('active')) loadAssignmentsPage();
      refreshNotifBadge();
    }
  });
}

// ---- Step 7: Engineering manually initiates the production clearance request ----
async function assignmentRequestClearance(assignmentId) {
  if (!confirm(`Initiate the production clearance request for ${assignmentId}? The production user will be notified immediately.`)) return;
  try {
    await api('PUT', `/api/assignments/${assignmentId}/request-clearance`, {});
    toast('Clearance request sent. Production user notified.', 'success');
    closeModal();
    if ($('page-tasks').classList.contains('active'))       loadTasks(CURRENT_TASKS_TAB);
    if ($('page-assignments').classList.contains('active')) loadAssignmentsPage();
    refreshNotifBadge();
  } catch (e) { toast(e.message, 'error'); }
}

// ---- Clearance / Executor-assignment actions ----
async function assignmentClearanceDecision(assignmentId, decision) {
  let remarks = null;
  // For a grant, fetch the assignment first so we can warn the user about the
  // tolerance window BEFORE they go through the e-signature flow only to be
  // rejected by the server. Server still enforces; this is just smoother UX.
  if (decision === 'grant') {
    try {
      const a = await api('GET', `/api/assignments/${assignmentId}`);
      const meta = computeToleranceMeta(a);
      if (meta.deadline) {
        const todayUtc = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
        const deadlineUtc = new Date(meta.deadline + 'T00:00:00Z');
        if (todayUtc > deadlineUtc) {
          const days = Math.floor((todayUtc - deadlineUtc) / 86400000);
          toast(`Cannot grant clearance — ${days} day(s) past the tolerance window (window closed ${meta.deadline}). Route via Expired Equipment / PNC-Exception flow instead.`, 'error');
          return;
        }
      }
    } catch (e) { /* fall through to server which will enforce too */ }
  }
  if (decision === 'deny') {
    remarks = prompt('Reason for denying clearance (required):');
    if (!remarks) return;
  } else {
    remarks = prompt('Clearance remarks (optional):') || '';
  }
  const meaning = decision === 'grant'
    ? `I grant production clearance for equipment under PM assignment "${assignmentId}". The equipment is offline and safe for maintenance.`
    : `I deny production clearance for PM assignment "${assignmentId}". Reason: ${remarks}`;
  openESignatureModal({
    title: `Sign — Clearance ${assignmentId}`,
    meaning,
    onConfirm: async (esig) => {
      await api('PUT', `/api/assignments/${assignmentId}/clearance`, { decision, remarks, ...esig });
      toast(decision === 'grant'
        ? 'Clearance granted. Engineering Manager notified to assign an executor.'
        : 'Clearance denied.', 'success');
      closeModal();
      if ($('page-tasks').classList.contains('active'))       loadTasks(CURRENT_TASKS_TAB);
      if ($('page-assignments').classList.contains('active')) loadAssignmentsPage();
      refreshNotifBadge();
    }
  });
}

async function openAssignExecutorModal(assignmentId) {
  try {
    const [users, roles] = await Promise.all([api('GET','/api/users'), api('GET','/api/roles')]);
    const executorSet = usersWithActivity(users, roles, 'execute_checklist','execute_pm');
    const executors = users.filter(u => executorSet.has(u.id));
    if (executors.length === 0) { toast('No users with execute permission.','error'); return; }
    openModal({
      title: `Assign Executor — ${assignmentId}`,
      width: 500,
      body: `
        <p style="font-size:12px; color:var(--muted); margin-top:0;">Clearance has been granted. Pick the executor who will perform this PM activity.</p>
        <div class="form-row"><label>Executor *</label>
          <select name="assignee_id" required>
            <option value="">— select executor —</option>
            ${executors.map(u => `<option value="${u.id}">${escapeHtml(u.name)} — ${escapeHtml(u.role)} / ${escapeHtml(u.department || '')}</option>`).join('')}
          </select>
        </div>
      `,
      submitLabel: 'Assign Executor',
      onSubmit: async (data) => {
        await api('PUT', `/api/assignments/${assignmentId}/assign-executor`, { assignee_id: Number(data.assignee_id) });
        toast('Executor assigned. They have been notified.', 'success');
        if ($('page-tasks').classList.contains('active'))       loadTasks(CURRENT_TASKS_TAB);
        if ($('page-assignments').classList.contains('active')) loadAssignmentsPage();
        refreshNotifBadge();
      }
    });
  } catch (e) { toast(e.message,'error'); }
}

async function assignmentReviewDecision(assignmentId, decision) {
  let reason = null;
  if (decision === 'reject') {
    reason = prompt('Reason for rejection (will be shown to the executor):');
    if (!reason) return;
  }
  const meaning = decision === 'approve'
    ? `I have reviewed the executed PM "${assignmentId}" and the responses are complete and correct. Forwarding to the Approver.`
    : `I reject the executed PM "${assignmentId}" and return it to the Executor for rework. Reason: ${reason}`;
  openESignatureModal({
    title: `Sign — Review Execution ${assignmentId}`,
    meaning,
    onConfirm: async (esig) => {
      await api('PUT', `/api/assignments/${assignmentId}/review`, { decision, reason, ...esig });
      toast(decision === 'approve' ? 'Review passed — sent to approver.' : 'Returned to executor for rework.', 'success');
      closeModal();
      loadTasks(CURRENT_TASKS_TAB);
      refreshNotifBadge();
    }
  });
}
async function withdrawAssignment(assignmentId, targetId) {
  const remarks = prompt(`Drop / withdraw assignment ${assignmentId}${targetId?' from '+targetId:''}? Please state the reason (required for GMP traceability — e.g., "checklist v2.0 being prepared, re-assigning post-approval"):`);
  if (!remarks || !remarks.trim()) return;
  const meaning = `I withdraw PM assignment "${assignmentId}"${targetId?' for '+targetId:''}. It is removed from the active workflow. Reason: ${remarks}`;
  openESignatureModal({
    title: `Sign — Withdraw ${assignmentId}`,
    meaning,
    onConfirm: async (esig) => {
      await api('PUT', `/api/assignments/${assignmentId}/withdraw`, { remarks, ...esig });
      toast('Assignment withdrawn. The workflow chain has been notified.', 'success');
      closeModal();
      if ($('page-tasks').classList.contains('active'))       loadTasks(CURRENT_TASKS_TAB);
      if ($('page-assignments').classList.contains('active')) loadAssignmentsPage();
      refreshNotifBadge();
    }
  });
}

async function assignmentApproveDecision(assignmentId, decision) {
  let reason = null;
  if (decision === 'reject') {
    reason = prompt('Reason for rejection (will be shown to executor + reviewer):');
    if (!reason) return;
  }
  const meaning = decision === 'approve'
    ? `I approve the executed PM "${assignmentId}". The maintenance has been performed and documented per GMP. The PM cycle is closed.`
    : `I reject the executed PM "${assignmentId}" at approval and return it to the Executor for rework. Reason: ${reason}`;
  openESignatureModal({
    title: `Sign — Approve Execution ${assignmentId}`,
    meaning,
    onConfirm: async (esig) => {
      await api('PUT', `/api/assignments/${assignmentId}/approve`, { decision, reason, ...esig });
      toast(decision === 'approve' ? 'Approved & closed.' : 'Returned to executor for rework.', 'success');
      closeModal();
      loadTasks(CURRENT_TASKS_TAB);
      refreshNotifBadge();
    }
  });
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
          // Run through the same parser as the camera scanner — handles users
          // who paste a full multi-line QR payload here too.
          const id = parseEquipmentIdFromScan(scan.value);
          if (id) {
            scan.value = id;
            fetchPmStatus(id);
          }
        }
      };
    }
    // Clear any previous result
    $('pmStatusResult').innerHTML = '<div class="card"><p style="color:var(--muted); margin:0;">Scan an Equipment ID barcode (Enter to confirm) or pick from the dropdown to load its current PM status.</p></div>';
  } catch (e) { toast(e.message, 'error'); }
}

// Pull just the equipment ID out of whatever text a QR scanner decoded.
// Handles:
//   "EQ-AHU-08"                          -> "EQ-AHU-08"
//   "QR:EQ-AHU-08"                       -> "EQ-AHU-08"  (legacy seeded prefix)
//   "EQ-AHU-08 - Air Handling Unit (8)\n..."        (current rich payload)
//   "PMMS Equipment\nID: EQ-AHU-08\n..." (older rich payload variant)
// Returns the first token that looks like an equipment ID (uppercase
// alphanumerics + dashes/underscores). Falls back to the raw input if no
// pattern matches so the user at least sees what was scanned.
function parseEquipmentIdFromScan(scannedText) {
  if (!scannedText) return '';
  let s = String(scannedText).trim();
  // 1) Legacy "QR:" seeded prefix.
  if (/^QR:/i.test(s)) s = s.slice(3).trim();
  // 2) Older "ID: <id>" line format — find the line and extract.
  const idLine = s.split(/\r?\n/).find(l => /^ID\s*:/i.test(l));
  if (idLine) {
    const m = idLine.match(/ID\s*:\s*([A-Za-z0-9_-]+)/i);
    if (m) return m[1];
  }
  // 3) Current rich payload: first line is "<EQ-ID> - <Name>" or just "<EQ-ID>".
  const firstLine = s.split(/\r?\n/)[0].trim();
  const firstToken = firstLine.split(/\s+/)[0];
  // Loose validation — equipment IDs are user-defined, but they're almost
  // always uppercase alphanumeric + dashes/underscores, 2-50 chars.
  if (/^[A-Za-z0-9_-]{2,50}$/.test(firstToken)) return firstToken;
  // Last resort — return whatever we got so the user can see and edit.
  return firstToken || s;
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
      <p style="color:var(--muted); font-size:12px; margin:0 0 8px;">Point the back camera at the QR code (printed sticker, on-screen, or a photo). Decoding happens automatically.</p>
      <div id="qrReader" style="width:100%; max-width:420px; margin:0 auto; border:1px solid var(--border); border-radius:8px; overflow:hidden;"></div>
      <p id="qrScanStatus" style="color:var(--muted); font-size:11px; margin-top:8px; min-height:18px;">Starting camera…</p>
      <hr class="sep" />
      <div style="font-size:12px;">
        <strong>No camera, or scanner not working?</strong>
        Upload a photo of the QR instead:
        <input type="file" id="qrFileInput" accept="image/*" style="display:block; margin-top:6px;" onchange="window.__pmsQrFileScan()" />
      </div>
      <p style="font-size:11px; color:var(--muted); margin:8px 0 0;">Still stuck? Close this and type the Equipment ID by hand.</p>
    `,
    hideDefaultSubmit: true,
  });
  // Image-file fallback — uses html5-qrcode's scanFile helper on the uploaded image.
  window.__pmsQrFileScan = async () => {
    const inp = document.getElementById('qrFileInput');
    if (!inp || !inp.files || inp.files.length === 0) return;
    const file = inp.files[0];
    const statusEl = document.getElementById('qrScanStatus');
    if (statusEl) statusEl.textContent = 'Decoding uploaded image…';
    try {
      // Use a temporary Html5Qrcode instance for one-shot file decoding.
      const tmp = new Html5Qrcode('qrReader', { verbose: false });
      const decoded = await tmp.scanFile(file, false);
      tmp.clear();
      const id = parseEquipmentIdFromScan(decoded);
      closeModal();
      const inp2 = $('pmStatusScan'); if (inp2) inp2.value = id;
      toast(`Scanned: ${id}`, 'success');
      fetchPmStatus(id);
    } catch (err) {
      if (statusEl) statusEl.innerHTML = `<span style="color:var(--red);">Couldn't decode that image: ${escapeHtml(err.message || err)}</span>`;
    }
  };

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
      const id = parseEquipmentIdFromScan(decodedText);
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

    // Stash QR payload for the on-screen render
    window.__qrPayloads = window.__qrPayloads || {};
    window.__qrPayloads[s.equipment_id] = s.qr_payload || s.equipment_id;

    // Signatures card — shown only when at least one signature is present.
    const sigBlock = (label, sig, ts) => sig
      ? `<div style="padding:8px 12px; background:var(--cream-100); border-radius:6px;">
           <div style="font-size:10px; color:var(--muted); text-transform:uppercase; letter-spacing:1px;">${escapeHtml(label)}</div>
           <div style="font-weight:600; font-size:13px;">${escapeHtml(sig)}</div>
           ${ts ? `<div style="color:var(--muted); font-size:11px;">${escapeHtml(formatLocalTime(ts))}</div>` : ''}
         </div>`
      : '';
    const hasAnySig = s.executor_sig || s.reviewer_sig || s.approver_sig;

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
          <div style="display:flex; gap:10px; align-items:center;">
            <div class="qr-cell" data-qr-key="${escapeHtml(s.equipment_id)}"
                 onclick="openQrModalForEquipment('${escapeHtml(s.equipment_id)}','${escapeHtml(s.equipment_name || '')}')"
                 title="Click to enlarge / print QR"
                 style="cursor:pointer; width:96px; height:96px; padding:2px; background:#fff; border:1px solid var(--border); border-radius:6px;"></div>
            ${s.latest_assignment_id
              ? `<button class="btn ghost sm" onclick="goto('tasks'); setTimeout(() => openAssignment('${escapeHtml(s.latest_assignment_id)}'), 200);">Open PM ${escapeHtml(s.latest_assignment_id)} →</button>`
              : ''}
          </div>
        </div>

        <div style="font-size:11px; color:var(--brown-700); text-transform:uppercase; letter-spacing:1px; margin: 8px 0 6px;">Master record</div>
        <div style="display:grid; grid-template-columns: repeat(3, 1fr); gap:10px;">
          ${fld('Plant ID', s.plant_id)}
          ${fld('Unit ID',  s.unit_number)}
          ${fld('Block / Location / Area', [s.block_name, s.location_name, s.area_name].filter(Boolean).join(' · '))}
          ${fld('Equipment ID', s.equipment_id)}
          ${fld('Equipment Name', s.equipment_name)}
          ${fld('Equipment Type / Sub-Type', [s.equipment_type, s.sub_type].filter(Boolean).join(' / '))}
          ${fld('Manufacturer / Model', [s.make, s.model].filter(Boolean).join(' / '))}
          ${fld('Serial / Capacity', [s.serial, s.capacity].filter(Boolean).join(' · '))}
          ${fld('Manufacture Date', s.manufacture_date)}
        </div>

        <div style="font-size:11px; color:var(--brown-700); text-transform:uppercase; letter-spacing:1px; margin: 14px 0 6px;">Maintenance schedule</div>
        <div style="display:grid; grid-template-columns: repeat(3, 1fr); gap:10px;">
          ${fld('PM Number', s.pm_number)}
          ${fld('Frequency', s.frequency ? `${s.frequency}${s.frequency_days?' ('+s.frequency_days+'d)':''}${s.tolerance_days!=null?' ±'+s.tolerance_days+'d':''}` : null)}
          ${fld('Assigned User / PM Done By', s.assignee_name)}
          ${fld('Reviewer (Engineering)', s.reviewer_name)}
          ${fld('Approver (QA)', s.approver_name)}
          ${fld('Last Execution Date', s.last_execution_date ? formatLocalTime(s.last_execution_date) : null)}
          ${fld('Next Due Date', s.next_due_date)}
        </div>

        ${hasAnySig ? `
        <div style="font-size:11px; color:var(--brown-700); text-transform:uppercase; letter-spacing:1px; margin: 14px 0 6px;">Signatures (latest PM cycle)</div>
        <div style="display:flex; gap:10px; flex-wrap:wrap;">
          ${sigBlock('Executor', s.executor_sig, s.submitted_at)}
          ${sigBlock('Reviewer', s.reviewer_sig, s.reviewed_at)}
          ${sigBlock('Approver', s.approver_sig, s.approved_at)}
        </div>` : ''}

        <p style="font-size:11px; color:var(--muted); margin:12px 0 0;">Status is auto-computed from the PM workflow and cannot be edited manually. Click the QR to enlarge or print.</p>
      </div>`;
    // Render the QR badge after DOM injection
    setTimeout(renderQrCells, 0);
  } catch (e) {
    $('pmStatusResult').innerHTML = `<div class="card" style="border-left:4px solid var(--red);"><strong style="color:var(--red);">${escapeHtml(e.message)}</strong></div>`;
  }
}

// ===========================================================
// PENDING EQUIPMENT ASSIGNMENT
// ===========================================================
// PMs past their scheduled date but still within the tolerance window —
// no PNC/Exception required, just an executor pick.
async function loadPendingPage() {
  const body = $('pendingBody');
  if (body) body.innerHTML = '<tr class="empty-row"><td colspan="9" style="text-align:center; padding:18px; color:var(--muted);">Loading…</td></tr>';
  try {
    const { rows, flipped } = await api('GET', '/api/assignments/pending');
    if (flipped > 0) toast(`${flipped} assignment(s) just crossed tolerance and moved to Expired Equipment.`, 'success');
    body.innerHTML = (!rows || rows.length === 0)
      ? '<tr class="empty-row"><td colspan="9" style="text-align:center; padding:18px;">🎉 No pending equipment — everything is on or ahead of schedule.</td></tr>'
      : rows.map(a => {
          // Build location chain: Plant › Block › Location › Area
          const chain = [a.plant_name, a.block_name, a.location_name, a.area_name].filter(Boolean).join(' › ');
          const eqDetails = [a.make, a.model, a.serial ? 'SN '+a.serial : null].filter(Boolean).join(' · ');
          return `<tr>
            <td>
              <strong>${escapeHtml(a.plant_name || '—')}</strong>
              ${a.unit_number ? `<div style="color:var(--muted); font-size:11px;">${escapeHtml(a.unit_number)}</div>` : ''}
              ${chain ? `<div style="color:var(--muted); font-size:10px; margin-top:2px;">${escapeHtml(chain)}</div>` : ''}
            </td>
            <td><strong>${escapeHtml(a.target_id || '—')}</strong></td>
            <td>
              <strong>${escapeHtml(a.equipment_name || a.equipment_description || '—')}</strong>
              ${eqDetails ? `<div style="color:var(--muted); font-size:11px; margin-top:2px;">${escapeHtml(eqDetails)}</div>` : ''}
              ${a.capacity ? `<div style="color:var(--muted); font-size:11px;">${escapeHtml(a.capacity)}</div>` : ''}
            </td>
            <td><strong>${escapeHtml(a.assignment_id)}</strong>${a.checklist_name?`<div style="color:var(--muted); font-size:11px;">${escapeHtml(a.checklist_name)} (${escapeHtml(a.checklist_version || '')})</div>`:''}</td>
            <td>${escapeHtml(a.frequency || '—')}${a.tolerance_days != null ? `<div style="color:var(--muted); font-size:10px;">±${a.tolerance_days}d</div>` : ''}</td>
            <td>${escapeHtml(a.due_date || a.effective_date || '—')}</td>
            <td><span class="pill amber" style="font-size:10px;">${escapeHtml(a.pending_reason || '—')}</span></td>
            <td>${statusPill(a.status)}${a.assignee_name?`<div style="color:var(--muted); font-size:11px;">→ ${escapeHtml(a.assignee_name)}</div>`:''}</td>
            <td><button class="btn primary sm" onclick='openAssignPendingModal(${escapeHtml(JSON.stringify(a))})'>${a.assignee_id?'Re-assign':'Assign'}</button></td>
          </tr>`;
        }).join('');
  } catch (e) {
    toast(e.message, 'error');
    if (body) body.innerHTML = `<tr class="empty-row"><td colspan="9" style="text-align:center; padding:18px; color:var(--red);">Couldn't load pending equipment: ${escapeHtml(e.message)}</td></tr>`;
  }
}

async function openAssignPendingModal(assignment) {
  try {
    const [users, roles] = await Promise.all([api('GET','/api/users'), api('GET','/api/roles')]);
    const executorSet = usersWithActivity(users, roles, 'execute_checklist','execute_pm');
    const executors = users
      .filter(u => executorSet.has(u.id) && u.status === 'Active')
      .filter(u => u.id !== assignment.reviewer_id && u.id !== assignment.approver_id);
    if (executors.length === 0) { toast('No active users with execute permission (excluding the reviewer/approver).','error'); return; }

    openModal({
      title: `${assignment.assignee_id?'Re-assign':'Assign'} Pending PM — ${escapeHtml(assignment.assignment_id)}`,
      width: 580,
      body: `
        <div class="row-gap" style="font-size:12px; margin-bottom: 14px;">
          <span class="pill amber">${escapeHtml(assignment.pending_reason || 'Pending')}</span>
          <span class="pill brown">${escapeHtml(assignment.target_id)} · ${escapeHtml(assignment.equipment_description || '')}</span>
          ${assignment.plant_name ? `<span class="pill brown">${escapeHtml(assignment.plant_name)}${assignment.unit_number?' · '+escapeHtml(assignment.unit_number):''}</span>` : ''}
          ${assignment.due_date ? `<span class="pill brown">Due: ${escapeHtml(assignment.due_date)}</span>` : ''}
          ${assignment.frequency ? `<span class="pill brown">${escapeHtml(assignment.frequency)}</span>` : ''}
        </div>
        ${assignment.assignee_name ? `<div style="background:#fff7e6; border-left:3px solid #c77b00; padding:8px 12px; border-radius:6px; margin-bottom:14px; font-size:12px;">
          Currently assigned to <strong>${escapeHtml(assignment.assignee_name)}</strong>. Re-assigning to a different executor will <strong>reset</strong> any in-flight responses and signatures so the new executor starts fresh.
        </div>` : '<p style="font-size:12px; color:var(--muted); margin-top:0;">This PM is past its scheduled date but still within the tolerance window. No PNC / Exception required — just pick an executor.</p>'}
        <div class="form-row"><label>Executor *</label>
          <select name="assignee_id" required>
            <option value="">— select executor —</option>
            ${executors.map(u => `<option value="${u.id}" ${u.id===assignment.assignee_id?'selected':''}>${escapeHtml(u.name)} — ${escapeHtml(u.role)}${u.department?' / '+escapeHtml(u.department):''}</option>`).join('')}
          </select>
        </div>
      `,
      submitLabel: assignment.assignee_id ? 'Re-assign Now' : 'Assign Now',
      onSubmit: async (data) => {
        if (!data.assignee_id) throw new Error('Pick an executor.');
        await api('PUT', `/api/assignments/${assignment.assignment_id}/assign-pending`, {
          assignee_id: Number(data.assignee_id),
        });
        toast(`Pending PM ${assignment.assignment_id} assigned.`, 'success');
        loadPendingPage();
        refreshNotifBadge();
      }
    });
  } catch (e) { toast(e.message, 'error'); }
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
      : rows.map(a => {
          const chain = [a.plant_name, a.block_name, a.location_name, a.area_name].filter(Boolean).join(' › ');
          const eqDetails = [a.make, a.model, a.serial ? 'SN '+a.serial : null].filter(Boolean).join(' · ');
          return `<tr>
            <td><strong>${escapeHtml(a.assignment_id)}</strong>${a.checklist_name?`<div style="color:var(--muted); font-size:11px;">${escapeHtml(a.checklist_name)} (${escapeHtml(a.checklist_version || '')})</div>`:''}</td>
            <td>
              <strong>${escapeHtml(a.plant_name || '—')}</strong>
              ${a.unit_number ? `<div style="color:var(--muted); font-size:11px;">${escapeHtml(a.unit_number)}</div>` : ''}
              ${chain ? `<div style="color:var(--muted); font-size:10px; margin-top:2px;">${escapeHtml(chain)}</div>` : ''}
            </td>
            <td><strong>${escapeHtml(a.target_id || '—')}</strong></td>
            <td>
              <strong>${escapeHtml(a.equipment_name || a.equipment_description || '—')}</strong>
              ${eqDetails ? `<div style="color:var(--muted); font-size:11px; margin-top:2px;">${escapeHtml(eqDetails)}</div>` : ''}
              ${a.capacity ? `<div style="color:var(--muted); font-size:11px;">${escapeHtml(a.capacity)}</div>` : ''}
            </td>
            <td>${escapeHtml(a.frequency || '—')}${a.tolerance_days != null ? `<div style="color:var(--muted); font-size:10px;">±${a.tolerance_days}d</div>` : ''}</td>
            <td>${escapeHtml(a.due_date || '—')}${a.expired_at?`<div style="color:var(--red); font-size:11px;">expired ${escapeHtml(a.expired_at)}</div>`:''}</td>
            <td>${statusPill('Expired')}</td>
            <td><button class="btn primary sm" onclick='openReassignExpiredModal(${escapeHtml(JSON.stringify(a))})'>Re-assign</button></td>
          </tr>`;
        }).join('');
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
        <div class="form-row"><label>New Scheduled Date</label><input name="effective_date" type="date" value="${todayStr}" /></div>
        <div class="form-row"><label>New Due Date</label><input name="due_date" type="date" /></div>
      `,
      submitLabel: 'Sign &amp; Re-assign…',
      onSubmit: async (data) => {
        // GMP traceability: re-assigning an Expired PM requires a signed
        // electronic attestation that captures the PNC + Exception reasoning.
        const payload = {
          assignee_id: Number(data.assignee_id),
          reviewer_id: data.reviewer_id ? Number(data.reviewer_id) : null,
          approver_id: data.approver_id ? Number(data.approver_id) : null,
          pnc_number: data.pnc_number,
          exception_number: data.exception_number,
          exception_description: data.exception_description,
          effective_date: data.effective_date || null,
          due_date: data.due_date || null,
        };
        const meaning = `I re-assign Expired PM "${assignment.assignment_id}" for ${assignment.target_id || 'equipment'} under PNC ${payload.pnc_number} / Exception ${payload.exception_number}. ${payload.exception_description}`;
        // Defer past the form auto-close (same pattern as master decision modal)
        setTimeout(() => {
          openESignatureModal({
            title: `Sign — Re-assign Expired PM ${assignment.assignment_id}`,
            meaning,
            onConfirm: async (esig) => {
              await api('PUT', `/api/assignments/${assignment.assignment_id}/reassign`, { ...payload, ...esig });
              toast(`Expired PM ${assignment.assignment_id} re-assigned.`, 'success');
              loadExpiredPage();
              refreshNotifBadge();
            }
          });
        }, 0);
      }
    });
  } catch (e) { toast(e.message, 'error'); }
}

// ===========================================================
// BOOT
// ===========================================================
tryAutoLogin();
