// server.js — PMMS API + static server
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { db, hashPassword, verifyPassword } = require('./db');
const license = require('./license');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust the platform's load balancer (Render, Railway, Fly etc. terminate TLS upstream).
// Lets req.ip and secure cookies work correctly when we add them.
app.set('trust proxy', 1);

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// ---------- Licensing ----------
// Print the license state once at boot so the operator can tell at a glance.
(() => {
  const s = license.getState();
  if (s.mode === 'unconfigured') {
    console.log('[license] !  Public key not configured - running unrestricted. Run lictool/make_keypair.py and paste the public key into license.js.');
  } else if (s.mode === 'dev') {
    console.log('[license] ℹ  Dev mode — license enforcement skipped.');
  } else if (s.valid) {
    console.log(`[license] ✓ Active${s.expiry?` until ${s.expiry}`:''}${s.customer?` for "${s.customer}"`:''}${s.days_remaining!=null?` · ${s.days_remaining} days remaining`:''}`);
  } else {
    console.log(`[license] ✗ Invalid: ${s.reason} · fingerprint ${s.fingerprint}`);
  }
})();

// License info + upload endpoints — public (no auth) so a fresh install can
// see the fingerprint and accept a key BEFORE any user has signed in.
app.get('/api/license/info', (req, res) => {
  const s = license.getState();
  res.json(s);
});

app.post('/api/license/upload', (req, res) => {
  const { license: licStr } = req.body || {};
  if (!licStr) return res.status(400).json({ error: 'license string required in body.license' });
  try {
    const s = license.saveLicense(licStr);
    audit({ id: null, name: 'License upload' }, 'LICENSE_UPDATE', 'License', '-',
      `Activated${s.expiry?` until ${s.expiry}`:''}${s.customer?` for "${s.customer}"`:''}`);
    res.json(s);
  } catch (e) {
    audit({ id: null, name: 'License upload' }, 'LICENSE_REJECTED', 'License', '-', e.message);
    res.status(400).json({ error: e.message });
  }
});

// Gate every other /api/* route on a valid license. The middleware short-
// circuits to allow /api/license/* through unconditionally.
app.use('/api/', license.requireValidLicense);

// When the browser asks for the app root (index.html) AND the license is
// invalid, send it straight to the standalone activation page instead. This
// matches the WaysApp pattern — main app.js doesn't know anything about
// licensing; the gate is purely server-side.
app.get(['/', '/index.html'], (req, res, next) => {
  const s = license.getState();
  if (!s.valid) {
    return res.redirect('/license.html');
  }
  next();
});

// ---------- Helpers ----------
function audit(user, action, entity, entity_id, details = '') {
  db.prepare('INSERT INTO audit_log(user_id,user_name,action,entity,entity_id,details) VALUES (?,?,?,?,?,?)')
    .run(user?.id || null, user?.name || 'System', action, entity, String(entity_id || '-'), details);
}

function nextId(prefix, table, col) {
  const row = db.prepare(`SELECT ${col} FROM ${table} WHERE ${col} LIKE ? ORDER BY id DESC LIMIT 1`).get(prefix + '%');
  if (!row) return prefix + '001';
  const m = row[col].match(/(\d+)$/);
  const n = m ? (parseInt(m[1], 10) + 1) : 1;
  return prefix + String(n).padStart(3, '0');
}

function nextPmId() {
  const row = db.prepare("SELECT pm_id FROM pm_schedules ORDER BY id DESC LIMIT 1").get();
  if (!row) return 'PM-2700';
  const m = row.pm_id.match(/(\d+)$/);
  const n = m ? parseInt(m[1], 10) + 1 : 2700;
  return 'PM-' + n;
}

function nextBdId() {
  const row = db.prepare("SELECT bd_id FROM breakdowns ORDER BY id DESC LIMIT 1").get();
  if (!row) return 'BD-200';
  const m = row.bd_id.match(/(\d+)$/);
  const n = m ? parseInt(m[1], 10) + 1 : 200;
  return 'BD-' + n;
}

// ---------- Auth middleware ----------
function authFromReq(req) {
  const token = req.headers['x-session-token'] || req.cookies?.token;
  if (!token) return null;
  const row = db.prepare(`
    SELECT s.token, s.expires_at,
           u.id, u.user_id, u.name, u.email, u.status,
           u.role_id, u.department_id,
           COALESCE(r.name, u.role) AS role,
           COALESCE(d.name, u.department) AS department,
           r.permissions_json AS permissions_json
    FROM sessions s JOIN users u ON u.id = s.user_id
    LEFT JOIN roles r ON r.id = u.role_id
    LEFT JOIN departments d ON d.id = u.department_id
    WHERE s.token = ? AND s.expires_at > datetime('now')
  `).get(token);
  if (!row) return null;
  try { row.permissions = JSON.parse(row.permissions_json || '[]'); }
  catch (e) { row.permissions = []; }
  // System Administrator role has implicit "*" — all activities. We mark it.
  row.is_admin = (row.role === 'System Administrator');
  return row;
}

function requireAuth(req, res, next) {
  const u = authFromReq(req);
  if (!u) return res.status(401).json({ error: 'Not authenticated' });
  req.user = u;
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: `Forbidden — requires one of: ${roles.join(', ')}` });
    }
    next();
  };
}

// Permission-based middleware — preferred over requireRole for new code.
function requireActivity(...codes) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (req.user.is_admin) return next(); // sysadmin gets everything
    const perms = req.user.permissions || [];
    const ok = codes.some(c => perms.includes(c));
    if (!ok) return res.status(403).json({ error: `Forbidden — requires activity: ${codes.join(' or ')}` });
    next();
  };
}

function userHasActivity(user, code) {
  if (!user) return false;
  if (user.is_admin) return true;
  return (user.permissions || []).includes(code);
}

// ============================================================================
// E-SIGNATURE MIDDLEWARE — 21 CFR Part 11 §11.50/11.70/11.200/11.300
// ----------------------------------------------------------------------------
// Required on every review / approve action across the system. The request
// body must include:
//   esig_password   — the current user's password (re-entered at action time)
//   esig_meaning    — non-empty string describing what the signature attests
//                     (e.g. "I have reviewed and approve this Plant master")
//   esig_meaning_ack — true / 'on' — the user must tick the meaning checkbox
//
// On success: writes an ESIGNATURE audit entry, exposes req.esig, calls next().
// On failure: writes ESIGNATURE_FAIL audit, returns 401 with a clear message.
//
// The middleware does NOT log the password — only the meaning + outcome.
// ============================================================================
function requireESignature(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  const { esig_password, esig_meaning, esig_meaning_ack } = req.body || {};
  const actionLabel = `${req.method} ${req.originalUrl}`;

  // IMPORTANT: e-signature validation failures use HTTP 403, NOT 401.
  // The user IS authenticated (their session is valid) — they just failed the
  // per-action identity challenge. Returning 401 would make the frontend
  // force-log-them-out, masking the real error and corrupting the workflow.

  // 1) Acknowledgement of meaning is mandatory.
  if (!esig_meaning_ack || (esig_meaning_ack !== true && esig_meaning_ack !== 'true' && esig_meaning_ack !== 'on')) {
    audit(req.user, 'ESIGNATURE_FAIL', 'E-Signature', actionLabel, 'Meaning checkbox not acknowledged');
    return res.status(403).json({ error: 'You must acknowledge the meaning of your signature to proceed.' });
  }

  // 2) Meaning text must be present (frontend supplies a default per action).
  if (!esig_meaning || !String(esig_meaning).trim()) {
    audit(req.user, 'ESIGNATURE_FAIL', 'E-Signature', actionLabel, 'Meaning text missing');
    return res.status(403).json({ error: 'Signature meaning is required.' });
  }

  // 3) Password must be present.
  if (!esig_password) {
    audit(req.user, 'ESIGNATURE_FAIL', 'E-Signature', actionLabel, 'No password supplied');
    return res.status(403).json({ error: 'Please re-enter your password to sign this action.' });
  }

  // 4) Verify against the live password_hash for THIS user (not a stale copy).
  const row = db.prepare('SELECT password_hash, status FROM users WHERE id=?').get(req.user.id);
  if (!row || row.status !== 'Active') {
    audit(req.user, 'ESIGNATURE_FAIL', 'E-Signature', actionLabel, `User not active (${row?.status || 'missing'})`);
    return res.status(403).json({ error: 'Your account is not active. Cannot sign.' });
  }
  if (!verifyPassword(esig_password, row.password_hash)) {
    audit(req.user, 'ESIGNATURE_FAIL', 'E-Signature', actionLabel, 'Wrong password');
    return res.status(403).json({ error: 'Password incorrect. Signature rejected. Please retype your password.' });
  }

  // 5) Success — record the signature, then proceed.
  req.esig = { meaning: String(esig_meaning).trim(), signed_at: new Date().toISOString() };
  audit(req.user, 'ESIGNATURE', 'E-Signature', actionLabel, req.esig.meaning);
  next();
}

function notify(userId, title, message, kind = 'info', link = null) {
  db.prepare('INSERT INTO notifications(user_id,title,message,kind,link) VALUES (?,?,?,?,?)')
    .run(userId, title, message || '', kind, link);
}

// =============================================================
// AUTH
// =============================================================
app.post('/api/auth/login', (req, res) => {
  const { user_id, password } = req.body || {};
  if (!user_id || !password) {
    audit({ name: 'Anonymous' }, 'LOGIN_FAILED', 'User', user_id || '-', `Missing credentials from ${req.ip || 'unknown'}`);
    return res.status(400).json({ error: 'user_id and password required' });
  }
  const u = db.prepare(`
    SELECT u.*, r.name AS role_name, r.permissions_json, d.name AS dept_name
    FROM users u
    LEFT JOIN roles r ON r.id = u.role_id
    LEFT JOIN departments d ON d.id = u.department_id
    WHERE u.user_id = ?
  `).get(user_id);
  if (!u) {
    audit({ name: 'Anonymous' }, 'LOGIN_FAILED', 'User', user_id, `Unknown user from ${req.ip || 'unknown'}`);
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  if (u.status !== 'Active') {
    audit({ id: u.id, name: u.name }, 'LOGIN_FAILED', 'User', user_id, `Account ${u.status} from ${req.ip || 'unknown'}`);
    return res.status(403).json({ error: 'User is locked or inactive' });
  }
  if (!verifyPassword(password, u.password_hash)) {
    audit({ id: u.id, name: u.name }, 'LOGIN_FAILED', 'User', user_id, `Wrong password from ${req.ip || 'unknown'}`);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = crypto.randomBytes(24).toString('hex');
  const expires = new Date(Date.now() + 8 * 3600 * 1000).toISOString();
  db.prepare('INSERT INTO sessions(token,user_id,expires_at) VALUES (?,?,?)').run(token, u.id, expires);
  db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(u.id);

  let permissions = [];
  try { permissions = JSON.parse(u.permissions_json || '[]'); } catch (e) {}
  const roleName = u.role_name || u.role;
  const deptName = u.dept_name || u.department;

  audit({ id: u.id, name: u.name }, 'LOGIN', 'User', u.user_id, `Role: ${roleName}`);

  res.json({
    token,
    user: {
      id: u.id, user_id: u.user_id, name: u.name, email: u.email,
      role: roleName, department: deptName,
      role_id: u.role_id, department_id: u.department_id,
      permissions,
      is_admin: roleName === 'System Administrator'
    }
  });
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  const token = req.headers['x-session-token'];
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  audit(req.user, 'LOGOUT', 'User', req.user.user_id, '');
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({
    user: {
      id: req.user.id, user_id: req.user.user_id, name: req.user.name,
      email: req.user.email,
      role: req.user.role, department: req.user.department,
      role_id: req.user.role_id, department_id: req.user.department_id,
      permissions: req.user.permissions,
      is_admin: req.user.is_admin
    }
  });
});

// =============================================================
// DASHBOARD
// =============================================================
app.get('/api/dashboard/kpis', requireAuth, (req, res) => {
  // Auto-expire any assignments that crossed the tolerance window — keeps the
  // Overdue/Expired count fresh whenever the dashboard is opened.
  try { markExpiredAssignments(); } catch (e) { /* table may not exist yet on first boot */ }
  // KPIs union pm_schedules (legacy module) + checklist_assignments (current module).
  // Withdrawn / Rejected assignments don't count toward planned totals.
  // Pending = anything still in the active workflow (not Completed / Withdrawn / Rejected / Superseded).
  const totalPm  = db.prepare("SELECT COUNT(*) n FROM pm_schedules").get().n;
  const totalCa  = db.prepare("SELECT COUNT(*) n FROM checklist_assignments WHERE status NOT IN ('Withdrawn','Rejected')").get().n;
  const total    = totalPm + totalCa;

  const completedPm = db.prepare("SELECT COUNT(*) n FROM pm_schedules WHERE status='Completed'").get().n;
  const completedCa = db.prepare("SELECT COUNT(*) n FROM checklist_assignments WHERE status='Completed'").get().n;
  const completed   = completedPm + completedCa;

  const overduePm = db.prepare("SELECT COUNT(*) n FROM pm_schedules WHERE status IN ('Overdue','Expired')").get().n;
  const overdueCa = db.prepare("SELECT COUNT(*) n FROM checklist_assignments WHERE status IN ('Overdue','Expired')").get().n;
  const overdue   = overduePm + overdueCa;

  const pendingPm = db.prepare("SELECT COUNT(*) n FROM pm_schedules WHERE status IN ('Pending','Approved','Assigned','In Progress')").get().n;
  const pendingCa = db.prepare(`
    SELECT COUNT(*) n FROM checklist_assignments
    WHERE status NOT IN ('Completed','Withdrawn','Rejected','Expired','Overdue')
  `).get().n;
  const pending   = pendingPm + pendingCa;

  const compliance = total === 0 ? 0 : Math.round((completed / total) * 1000) / 10;

  const monthStart = new Date(); monthStart.setDate(1);
  const monthIso = monthStart.toISOString().slice(0, 10);
  const mtdPm = db.prepare("SELECT COUNT(*) n FROM pm_schedules WHERE status='Completed' AND completed_at >= ?").get(monthIso).n;
  const mtdCa = db.prepare("SELECT COUNT(*) n FROM checklist_assignments WHERE status='Completed' AND completed_at >= ?").get(monthIso).n;
  const mtd   = mtdPm + mtdCa;

  const openBd = db.prepare("SELECT COUNT(*) n FROM breakdowns WHERE status NOT IN ('Closed','Resolved')").get().n;

  res.json({ compliance, overdue, pending, completed_mtd: mtd, total_pms: total, open_breakdowns: openBd });
});

app.get('/api/dashboard/compliance-by-dept', requireAuth, (req, res) => {
  // Pull rows from BOTH tables. checklist_assignments doesn't carry a department
  // column directly — derive it from the assignee's department.
  const rows = db.prepare(`
    SELECT department,
      COUNT(*) AS planned,
      SUM(CASE WHEN status='Completed' THEN 1 ELSE 0 END) AS done
    FROM (
      SELECT department, status FROM pm_schedules
      UNION ALL
      SELECT COALESCE(d.name, u.department, 'Unassigned') AS department, ca.status
      FROM checklist_assignments ca
      LEFT JOIN users u   ON u.id = ca.assignee_id
      LEFT JOIN departments d ON d.id = u.department_id
      WHERE ca.status NOT IN ('Withdrawn','Rejected')
    )
    GROUP BY department
    ORDER BY department
  `).all();
  res.json(rows.map(r => ({
    department: r.department || 'Unassigned',
    planned: r.planned,
    done: r.done || 0,
    pct: r.planned ? Math.round((r.done / r.planned) * 1000) / 10 : 0
  })));
});

// =============================================================
// MASTERS — PLANTS
// =============================================================
app.get('/api/plants', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM plants ORDER BY plant_id').all());
});
// Common ID validation: 1-50 chars of letters / digits / dash / underscore.
const ID_PATTERN = /^[A-Za-z0-9_\-]{1,50}$/;
function checkId(label, value) {
  if (!value || !String(value).trim()) return `${label} is required`;
  if (!ID_PATTERN.test(String(value).trim())) return `${label} must be 1-50 alphanumeric characters (- and _ allowed)`;
  return null;
}

// Master-data approval helpers — every Plants/Blocks/Locations/Areas/Formulations/Equipment
// creation now requires a Reviewer and an Approver picked at creation time, and goes through:
//   Pending Review (reviewer signs)  →  Pending Approval (approver signs)  →  Active
//   or  →  Rejected (with remarks) at any stage.
function validateMasterApprovers(creatorId, reviewer_id, approver_id) {
  if (!reviewer_id) return 'Reviewer is required';
  if (!approver_id) return 'Approver is required';
  reviewer_id = Number(reviewer_id);
  approver_id = Number(approver_id);
  if (reviewer_id === approver_id) return 'Reviewer and Approver must be different users';
  if (creatorId && reviewer_id === creatorId) return 'Creator cannot also be the Reviewer';
  if (creatorId && approver_id === creatorId) return 'Creator cannot also be the Approver';
  const rv = db.prepare('SELECT id, name FROM users WHERE id=?').get(reviewer_id);
  const ap = db.prepare('SELECT id, name FROM users WHERE id=?').get(approver_id);
  if (!rv) return 'Unknown reviewer';
  if (!ap) return 'Unknown approver';
  return null;
}

// addMasterApprovalRoutes — generates /review and /approve endpoints for a master table.
//   masterName  = URL segment, e.g. 'plants'
//   tableName   = SQL table, e.g. 'plants'
//   pkCol       = string PK column, e.g. 'plant_id'
//   displayName = audit entity label, e.g. 'Plant'
function addMasterApprovalRoutes(masterName, tableName, pkCol, displayName) {
  // Pick the most human-readable identifier on this row for notify/audit text.
  // Tries `name` first (every master has one), falls back to the row's PK value.
  const friendlyId = (row) => {
    const pk = row[pkCol];
    const nm = row.name || row.description || row.area_type;
    return nm ? `${pk} — ${nm}` : String(pk);
  };

  app.put(`/api/${masterName}/:id/review`, requireAuth, requireActivity('review_master'), requireESignature, (req, res) => {
    const { decision, remarks } = req.body || {};
    const row = db.prepare(`SELECT * FROM ${tableName} WHERE ${pkCol}=?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.status !== 'Pending Review') return res.status(409).json({ error: `Not in Pending Review (currently ${row.status})` });
    if (row.reviewer_id !== req.user.id && !req.user.is_admin) {
      return res.status(403).json({ error: `Only the assigned reviewer can review this ${displayName.toLowerCase()}` });
    }
    if (!['approve','reject'].includes(decision)) return res.status(400).json({ error: 'decision must be "approve" or "reject"' });
    const friendly = friendlyId(row);

    if (decision === 'approve') {
      db.prepare(`UPDATE ${tableName} SET status='Pending Approval', reviewed_at=datetime('now'), review_remarks=? WHERE ${pkCol}=?`)
        .run(remarks || null, req.params.id);
      if (row.approver_id) {
        notify(row.approver_id, `${displayName} awaiting your approval`,
          `${friendly} reviewed by ${req.user.name}.`, 'master_approve', `/masters/${masterName}/${row[pkCol]}`);
      }
      audit(req.user, 'REVIEW', displayName, row[pkCol], `Reviewed ${friendly}${remarks ? ': ' + remarks : ''} — passed to approver`);
    } else {
      if (!remarks || !remarks.trim()) return res.status(400).json({ error: 'remarks required for rejection' });
      db.prepare(`UPDATE ${tableName} SET status='Rejected', review_remarks=?, reviewed_at=datetime('now') WHERE ${pkCol}=?`)
        .run(remarks, req.params.id);
      if (row.created_by) {
        notify(row.created_by, `${displayName} rejected at review`,
          `${friendly}: ${remarks}`, 'master_rejected', `/masters/${masterName}/${row[pkCol]}`);
      }
      audit(req.user, 'REJECT', displayName, row[pkCol], `Rejected ${friendly} at review: ${remarks}`);
    }
    res.json({ ok: true });
  });

  app.put(`/api/${masterName}/:id/approve`, requireAuth, requireActivity('approve_master'), requireESignature, (req, res) => {
    const { decision, remarks } = req.body || {};
    const row = db.prepare(`SELECT * FROM ${tableName} WHERE ${pkCol}=?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.status !== 'Pending Approval') return res.status(409).json({ error: `Not in Pending Approval (currently ${row.status})` });
    if (row.approver_id !== req.user.id && !req.user.is_admin) {
      return res.status(403).json({ error: `Only the assigned approver can approve this ${displayName.toLowerCase()}` });
    }
    const friendly = friendlyId(row);

    if (decision === 'reject') {
      if (!remarks || !remarks.trim()) return res.status(400).json({ error: 'remarks required for rejection' });
      db.prepare(`UPDATE ${tableName} SET status='Rejected', approval_remarks=?, approved_at=datetime('now') WHERE ${pkCol}=?`)
        .run(remarks, req.params.id);
      if (row.created_by) {
        notify(row.created_by, `${displayName} rejected at approval`,
          `${friendly}: ${remarks}`, 'master_rejected', `/masters/${masterName}/${row[pkCol]}`);
      }
      if (row.reviewer_id && row.reviewer_id !== req.user.id) {
        notify(row.reviewer_id, `${displayName} rejected by approver`,
          `${friendly}: ${remarks}`, 'master_rejected', `/masters/${masterName}/${row[pkCol]}`);
      }
      audit(req.user, 'REJECT', displayName, row[pkCol], `Rejected ${friendly} at approval: ${remarks}`);
    } else {
      db.prepare(`UPDATE ${tableName} SET status='Active', approval_remarks=?, approved_at=datetime('now') WHERE ${pkCol}=?`)
        .run(remarks || null, req.params.id);
      if (row.created_by) {
        notify(row.created_by, `${displayName} approved`,
          `${friendly} is now Active.`, 'master_approved', `/masters/${masterName}/${row[pkCol]}`);
      }
      if (row.reviewer_id && row.reviewer_id !== req.user.id) {
        notify(row.reviewer_id, `${displayName} approved`,
          `${friendly} has been approved.`, 'master_approved', `/masters/${masterName}/${row[pkCol]}`);
      }
      audit(req.user, 'APPROVE', displayName, row[pkCol], `Approved ${friendly}${remarks ? ' — ' + remarks : ''} — now Active`);
    }
    res.json({ ok: true });
  });
}

app.post('/api/plants', requireAuth, requireActivity('manage_plants'), (req, res) => {
  const { plant_id, name, location, reviewer_id, approver_id } = req.body || {};
  const idErr = checkId('Plant ID', plant_id); if (idErr) return res.status(400).json({ error: idErr });
  if (!name) return res.status(400).json({ error: 'Plant Name is required' });
  const apErr = validateMasterApprovers(req.user.id, reviewer_id, approver_id);
  if (apErr) return res.status(400).json({ error: apErr });
  if (db.prepare('SELECT 1 FROM plants WHERE plant_id=?').get(plant_id)) {
    return res.status(409).json({ error: `Plant ID "${plant_id}" already exists` });
  }
  db.prepare(`INSERT INTO plants(plant_id,name,location,status,created_by,reviewer_id,approver_id)
              VALUES (?,?,?,'Pending Review',?,?,?)`)
    .run(plant_id, name, location || '', req.user.id, Number(reviewer_id), Number(approver_id));
  audit(req.user, 'CREATE', 'Plant', plant_id, `Plant "${name}" at ${location || '-'} — submitted for review`);
  notify(Number(reviewer_id), 'Plant awaiting your review',
    `${plant_id} — "${name}" submitted by ${req.user.name}`, 'master_review', `/masters/plants/${plant_id}`);
  res.json(db.prepare('SELECT * FROM plants WHERE plant_id=?').get(plant_id));
});
app.put('/api/plants/:plant_id', requireAuth, requireActivity('manage_plants'), (req, res) => {
  const { name, unit_number, location, version, status } = req.body || {};
  const before = db.prepare('SELECT * FROM plants WHERE plant_id=?').get(req.params.plant_id);
  if (!before) return res.status(404).json({ error: 'Not found' });
  db.prepare(`UPDATE plants SET
      unit_number=COALESCE(?,unit_number),
      name=COALESCE(?,name),
      location=COALESCE(?,location),
      version=COALESCE(?,version),
      status=COALESCE(?,status),
      modified_at=datetime('now')
    WHERE plant_id=?`).run(unit_number, name, location, version, status, req.params.plant_id);
  const changes = [];
  if (name && name !== before.name)                       changes.push(`name "${before.name}" -> "${name}"`);
  if (unit_number && unit_number !== before.unit_number)  changes.push(`unit "${before.unit_number||'-'}" -> "${unit_number}"`);
  if (location && location !== before.location)           changes.push(`location "${before.location||'-'}" -> "${location}"`);
  if (status && status !== before.status)                 changes.push(`status "${before.status}" -> "${status}"`);
  audit(req.user, 'UPDATE', 'Plant', req.params.plant_id, changes.length ? changes.join('; ') : 'Plant touched');
  res.json(db.prepare('SELECT * FROM plants WHERE plant_id=?').get(req.params.plant_id));
});

// BLOCKS
app.get('/api/blocks', requireAuth, (req, res) => {
  const { plantId } = req.query;
  const rows = plantId
    ? db.prepare('SELECT * FROM blocks WHERE plant_id=? ORDER BY block_id').all(plantId)
    : db.prepare('SELECT * FROM blocks ORDER BY block_id').all();
  res.json(rows);
});
app.post('/api/blocks', requireAuth, requireActivity('manage_plants'), (req, res) => {
  const { block_id, plant_id, name, reviewer_id, approver_id } = req.body || {};
  const idErr = checkId('Block ID', block_id); if (idErr) return res.status(400).json({ error: idErr });
  if (!plant_id) return res.status(400).json({ error: 'Plant is required' });
  if (!name) return res.status(400).json({ error: 'Block Name is required' });
  const apErr = validateMasterApprovers(req.user.id, reviewer_id, approver_id);
  if (apErr) return res.status(400).json({ error: apErr });
  const plant = db.prepare('SELECT name, status FROM plants WHERE plant_id=?').get(plant_id);
  if (!plant) return res.status(400).json({ error: 'Unknown plant_id' });
  if (plant.status !== 'Active') return res.status(400).json({ error: `Parent plant is "${plant.status}" — only Active plants accept blocks` });
  if (db.prepare('SELECT 1 FROM blocks WHERE block_id=?').get(block_id)) {
    return res.status(409).json({ error: `Block ID "${block_id}" already exists` });
  }
  db.prepare(`INSERT INTO blocks(block_id,plant_id,name,status,created_by,reviewer_id,approver_id)
              VALUES (?,?,?,'Pending Review',?,?,?)`)
    .run(block_id, plant_id, name, req.user.id, Number(reviewer_id), Number(approver_id));
  audit(req.user, 'CREATE', 'Block', block_id, `Block "${name}" under plant ${plant_id} (${plant.name}) — submitted for review`);
  notify(Number(reviewer_id), 'Block awaiting your review',
    `${block_id} — "${name}" submitted by ${req.user.name}`, 'master_review', `/masters/blocks/${block_id}`);
  res.json(db.prepare('SELECT * FROM blocks WHERE block_id=?').get(block_id));
});

// FORMULATIONS
app.get('/api/formulations', requireAuth, (req,res) => res.json(db.prepare('SELECT * FROM formulations ORDER BY formulation_id').all()));
app.post('/api/formulations', requireAuth, requireActivity('manage_plants'), (req, res) => {
  const { name, department, reviewer_id, approver_id } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const apErr = validateMasterApprovers(req.user.id, reviewer_id, approver_id);
  if (apErr) return res.status(400).json({ error: apErr });
  const formulation_id = nextId('FRM-', 'formulations', 'formulation_id');
  db.prepare(`INSERT INTO formulations(formulation_id,name,department,status,created_by,reviewer_id,approver_id)
              VALUES (?,?,?,'Pending Review',?,?,?)`)
    .run(formulation_id, name, department || '', req.user.id, Number(reviewer_id), Number(approver_id));
  audit(req.user, 'CREATE', 'Formulation', formulation_id, `"${name}" under "${department || '—'}" — submitted for review`);
  notify(Number(reviewer_id), 'Formulation awaiting your review',
    `${formulation_id} — "${name}" submitted by ${req.user.name}`, 'master_review', `/masters/formulations/${formulation_id}`);
  res.json(db.prepare('SELECT * FROM formulations WHERE formulation_id=?').get(formulation_id));
});
app.put('/api/formulations/:formulation_id', requireAuth, requireActivity('manage_plants'), (req, res) => {
  const { name, department, status } = req.body || {};
  const r = db.prepare('UPDATE formulations SET name=COALESCE(?,name), department=COALESCE(?,department), status=COALESCE(?,status) WHERE formulation_id=?')
    .run(name, department, status, req.params.formulation_id);
  if (r.changes === 0) return res.status(404).json({ error: 'Not found' });
  audit(req.user, 'UPDATE', 'Formulation', req.params.formulation_id, `Updated formulation: ${name || ''}`);
  res.json(db.prepare('SELECT * FROM formulations WHERE formulation_id=?').get(req.params.formulation_id));
});

// LOCATIONS
app.get('/api/locations', requireAuth, (req,res) => res.json(db.prepare(`
  SELECT l.*, f.name AS formulation_name
  FROM locations l
  LEFT JOIN formulations f ON f.id = l.formulation_id
  ORDER BY l.location_id
`).all()));
app.post('/api/locations', requireAuth, requireActivity('manage_plants'), (req, res) => {
  // 'description' is the Location Name in our schema (renamed in the UI).
  // Accept both 'name' and 'description' for forward-compat.
  const { location_id, block_id, name, description, formulation_id, reviewer_id, approver_id } = req.body || {};
  const locName = name || description;
  const idErr = checkId('Location ID', location_id); if (idErr) return res.status(400).json({ error: idErr });
  if (!block_id) return res.status(400).json({ error: 'Block is required' });
  if (!locName) return res.status(400).json({ error: 'Location Name is required' });
  const apErr = validateMasterApprovers(req.user.id, reviewer_id, approver_id);
  if (apErr) return res.status(400).json({ error: apErr });
  const block = db.prepare('SELECT name, status FROM blocks WHERE block_id=?').get(block_id);
  if (!block) return res.status(400).json({ error: 'Unknown block_id' });
  if (block.status !== 'Active') return res.status(400).json({ error: `Parent block is "${block.status}" — only Active blocks accept locations` });
  let formName = null;
  if (formulation_id) {
    const f = db.prepare('SELECT name, status FROM formulations WHERE id=?').get(formulation_id);
    if (!f) return res.status(400).json({ error: 'Unknown formulation_id' });
    if (f.status !== 'Active') return res.status(400).json({ error: `Selected formulation is "${f.status}" — only Active formulations may be linked` });
    formName = f.name;
  }
  if (db.prepare('SELECT 1 FROM locations WHERE location_id=?').get(location_id)) {
    return res.status(409).json({ error: `Location ID "${location_id}" already exists` });
  }
  db.prepare(`INSERT INTO locations(location_id,block_id,description,formulation_id,status,created_by,reviewer_id,approver_id)
              VALUES (?,?,?,?,'Pending Review',?,?,?)`)
    .run(location_id, block_id, locName, formulation_id || null, req.user.id, Number(reviewer_id), Number(approver_id));
  audit(req.user, 'CREATE', 'Location', location_id, `"${locName}" under block ${block_id} (${block.name})${formName?` [${formName}]`:''} — submitted for review`);
  notify(Number(reviewer_id), 'Location awaiting your review',
    `${location_id} — "${locName}" submitted by ${req.user.name}`, 'master_review', `/masters/locations/${location_id}`);
  res.json(db.prepare('SELECT * FROM locations WHERE location_id=?').get(location_id));
});
app.put('/api/locations/:location_id', requireAuth, requireActivity('manage_plants'), (req, res) => {
  const { block_id, description, formulation_id, status } = req.body || {};
  const r = db.prepare(`UPDATE locations SET
      block_id=COALESCE(?,block_id),
      description=COALESCE(?,description),
      formulation_id=COALESCE(?,formulation_id),
      status=COALESCE(?,status)
    WHERE location_id=?`).run(block_id, description, formulation_id, status, req.params.location_id);
  if (r.changes === 0) return res.status(404).json({ error: 'Not found' });
  audit(req.user, 'UPDATE', 'Location', req.params.location_id, 'Location modified');
  res.json(db.prepare('SELECT * FROM locations WHERE location_id=?').get(req.params.location_id));
});

// AREAS
app.get('/api/areas', requireAuth, (req,res) => res.json(db.prepare('SELECT * FROM areas ORDER BY area_id').all()));
app.post('/api/areas', requireAuth, requireActivity('manage_plants'), (req, res) => {
  // Accept both 'name' (new) and 'area_type' (legacy) from the client.
  const { area_id, location_id, name, area_type, reviewer_id, approver_id } = req.body || {};
  const areaName = name || area_type;
  const idErr = checkId('Area ID', area_id); if (idErr) return res.status(400).json({ error: idErr });
  if (!location_id) return res.status(400).json({ error: 'Location is required' });
  if (!areaName) return res.status(400).json({ error: 'Area Name is required' });
  const apErr = validateMasterApprovers(req.user.id, reviewer_id, approver_id);
  if (apErr) return res.status(400).json({ error: apErr });
  const loc = db.prepare('SELECT description, status FROM locations WHERE location_id=?').get(location_id);
  if (!loc) return res.status(400).json({ error: 'Unknown location_id' });
  if (loc.status !== 'Active') return res.status(400).json({ error: `Parent location is "${loc.status}" — only Active locations accept areas` });
  if (db.prepare('SELECT 1 FROM areas WHERE area_id=?').get(area_id)) {
    return res.status(409).json({ error: `Area ID "${area_id}" already exists` });
  }
  db.prepare(`INSERT INTO areas(area_id,location_id,name,status,created_by,reviewer_id,approver_id)
              VALUES (?,?,?,'Pending Review',?,?,?)`)
    .run(area_id, location_id, areaName, req.user.id, Number(reviewer_id), Number(approver_id));
  audit(req.user, 'CREATE', 'Area', area_id, `"${areaName}" under location ${location_id} (${loc.description}) — submitted for review`);
  notify(Number(reviewer_id), 'Area awaiting your review',
    `${area_id} — "${areaName}" submitted by ${req.user.name}`, 'master_review', `/masters/areas/${area_id}`);
  res.json(db.prepare('SELECT * FROM areas WHERE area_id=?').get(area_id));
});
app.put('/api/areas/:area_id', requireAuth, requireActivity('manage_plants'), (req, res) => {
  const { location_id, name, area_type, status } = req.body || {};
  const areaName = name || area_type;
  const r = db.prepare('UPDATE areas SET location_id=COALESCE(?,location_id), name=COALESCE(?,name), status=COALESCE(?,status) WHERE area_id=?')
    .run(location_id, areaName, status, req.params.area_id);
  if (r.changes === 0) return res.status(404).json({ error: 'Not found' });
  audit(req.user, 'UPDATE', 'Area', req.params.area_id, 'Area modified');
  res.json(db.prepare('SELECT * FROM areas WHERE area_id=?').get(req.params.area_id));
});

// EQUIPMENT
app.get('/api/equipment', requireAuth, (req,res) => res.json(db.prepare('SELECT * FROM equipment ORDER BY equipment_id').all()));
app.get('/api/equipment/:equipment_id', requireAuth, (req,res) => {
  const row = db.prepare('SELECT * FROM equipment WHERE equipment_id=?').get(req.params.equipment_id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});
app.post('/api/equipment', requireAuth, requireActivity('manage_equipment'), (req, res) => {
  let { equipment_id, name, make, model, make_model, serial, capacity, area_id, reviewer_id, approver_id } = req.body || {};
  const idErr = checkId('Equipment ID', equipment_id); if (idErr) return res.status(400).json({ error: idErr });
  if (!name) return res.status(400).json({ error: 'Equipment Name is required' });
  if (!area_id) return res.status(400).json({ error: 'Area is required' });
  const apErr = validateMasterApprovers(req.user.id, reviewer_id, approver_id);
  if (apErr) return res.status(400).json({ error: apErr });
  const area = db.prepare('SELECT name, status FROM areas WHERE area_id=?').get(area_id);
  if (!area) return res.status(400).json({ error: 'Unknown area_id' });
  if (area.status !== 'Active') return res.status(400).json({ error: `Parent area is "${area.status}" — only Active areas accept equipment` });
  // Backwards compat: if legacy make_model passed, split into make/model.
  if (!make && !model && make_model) {
    const parts = String(make_model).split('/').map(s => s.trim());
    make = parts[0] || ''; model = parts.slice(1).join(' / ');
  }
  if (db.prepare('SELECT 1 FROM equipment WHERE equipment_id=?').get(equipment_id)) {
    return res.status(409).json({ error: `Equipment ID "${equipment_id}" already exists` });
  }
  db.prepare(`INSERT INTO equipment(equipment_id,name,make,model,serial,capacity,area_id,status,qr_code,created_by,reviewer_id,approver_id)
              VALUES (?,?,?,?,?,?,?,'Pending Review',?,?,?,?)`)
    .run(equipment_id, name, make||'', model||'', serial||'', capacity||'', area_id, `QR:${equipment_id}`,
         req.user.id, Number(reviewer_id), Number(approver_id));
  audit(req.user, 'CREATE', 'Equipment', equipment_id, `Registered: ${name} — ${make||'—'} ${model||''}${serial?` (SN ${serial})`:''} @ ${area_id} — submitted for review`);
  notify(Number(reviewer_id), 'Equipment awaiting your review',
    `${equipment_id} — "${name}" submitted by ${req.user.name}`, 'master_review', `/masters/equipment/${equipment_id}`);
  res.json(db.prepare('SELECT * FROM equipment WHERE equipment_id=?').get(equipment_id));
});
app.put('/api/equipment/:equipment_id', requireAuth, requireActivity('manage_equipment'), (req, res) => {
  const f = req.body || {};
  // Backwards compat for legacy make_model
  if (!f.make && !f.model && f.make_model) {
    const parts = String(f.make_model).split('/').map(s => s.trim());
    f.make = parts[0] || ''; f.model = parts.slice(1).join(' / ');
  }
  const r = db.prepare(`UPDATE equipment SET
      name=COALESCE(?,name),
      make=COALESCE(?,make),
      model=COALESCE(?,model),
      serial=COALESCE(?,serial),
      capacity=COALESCE(?,capacity),
      area_id=COALESCE(?,area_id),
      status=COALESCE(?,status)
    WHERE equipment_id=?`)
    .run(f.name, f.make, f.model, f.serial, f.capacity, f.area_id, f.status, req.params.equipment_id);
  if (r.changes === 0) return res.status(404).json({ error: 'Not found' });
  audit(req.user, 'UPDATE', 'Equipment', req.params.equipment_id, 'Equipment modified');
  res.json(db.prepare('SELECT * FROM equipment WHERE equipment_id=?').get(req.params.equipment_id));
});

// Master-data review/approve endpoints (Plants / Blocks / Locations / Areas / Formulations / Equipment).
// Every master listed here gets:
//   PUT /api/<master>/:id/review   { decision:'approve'|'reject', remarks }
//   PUT /api/<master>/:id/approve  { decision:'approve'|'reject', remarks }
addMasterApprovalRoutes('plants',       'plants',       'plant_id',       'Plant');
addMasterApprovalRoutes('blocks',       'blocks',       'block_id',       'Block');
addMasterApprovalRoutes('locations',    'locations',    'location_id',    'Location');
addMasterApprovalRoutes('areas',        'areas',        'area_id',        'Area');
addMasterApprovalRoutes('formulations', 'formulations', 'formulation_id', 'Formulation');
addMasterApprovalRoutes('equipment',    'equipment',    'equipment_id',   'Equipment');
addMasterApprovalRoutes('frequencies',  'frequencies',  'id',             'Frequency');
addMasterApprovalRoutes('pm-categories','pm_categories','id',             'PM Category');
addMasterApprovalRoutes('checklist-groups','checklist_groups','id',       'Checklist Group');

// Per-user "what masters are waiting on me?" — pulled into the bell + dashboard.
app.get('/api/masters/my-queue', requireAuth, (req, res) => {
  const out = { review: [], approve: [] };
  const masters = [
    { name: 'plants',       table: 'plants',       pk: 'plant_id',       label: 'Plant' },
    { name: 'blocks',       table: 'blocks',       pk: 'block_id',       label: 'Block' },
    { name: 'locations',    table: 'locations',    pk: 'location_id',    label: 'Location' },
    { name: 'areas',        table: 'areas',        pk: 'area_id',        label: 'Area' },
    { name: 'formulations', table: 'formulations', pk: 'formulation_id', label: 'Formulation' },
    { name: 'equipment',    table: 'equipment',    pk: 'equipment_id',   'label': 'Equipment' },
  ];
  for (const m of masters) {
    const r = db.prepare(`SELECT ${m.pk} AS id, status FROM ${m.table} WHERE status='Pending Review' AND reviewer_id=?`).all(req.user.id);
    const a = db.prepare(`SELECT ${m.pk} AS id, status FROM ${m.table} WHERE status='Pending Approval' AND approver_id=?`).all(req.user.id);
    for (const x of r) out.review.push({ master: m.name, label: m.label, id: x.id });
    for (const x of a) out.approve.push({ master: m.name, label: m.label, id: x.id });
  }
  res.json(out);
});

// =============================================================
// EQUIPMENT PM STATUS — read-only, auto-computed from assignment workflow
// =============================================================
//   Completed   → latest assignment Completed AND within tolerance
//   Under PM    → latest assignment is Pending / In Progress / Pending Review / Pending Approval
//   Rejected    → latest assignment is Rejected
//   Out of PM   → no assignment, OR latest Completed but past (next_due + tolerance), OR latest is Rejected/stale and past due
app.get('/api/equipment/:equipment_id/pm-status', requireAuth, (req, res) => {
  const eqId = req.params.equipment_id;
  const eq = db.prepare('SELECT * FROM equipment WHERE equipment_id=?').get(eqId);
  if (!eq) return res.status(404).json({ error: 'Equipment not found' });

  // Walk Equipment → Area → Location → Block → Plant
  const chain = db.prepare(`
    SELECT a.area_id, a.name AS area_name,
           l.location_id, l.description AS location_name,
           b.block_id, b.name AS block_name,
           p.plant_id, p.unit_number, p.name AS plant_name
    FROM equipment e
    LEFT JOIN areas a     ON a.area_id     = e.area_id
    LEFT JOIN locations l ON l.location_id = a.location_id
    LEFT JOIN blocks b    ON b.block_id    = l.block_id
    LEFT JOIN plants p    ON p.plant_id    = b.plant_id
    WHERE e.equipment_id = ?
  `).get(eqId) || {};

  // Latest assignment for this equipment (any status)
  const latest = db.prepare(`
    SELECT ca.*, f.name AS frequency_name, f.days AS frequency_days, f.tolerance_days,
           u.name AS assignee_name
    FROM checklist_assignments ca
    LEFT JOIN frequencies f ON f.id = ca.frequency_id
    LEFT JOIN users u ON u.id = ca.assignee_id
    WHERE ca.target_type='equipment' AND ca.target_id=?
    ORDER BY ca.id DESC
    LIMIT 1
  `).get(eqId);

  // Most recent COMPLETED assignment — for last execution date + computed next due
  const lastCompleted = db.prepare(`
    SELECT ca.completed_at, f.days AS frequency_days, f.tolerance_days
    FROM checklist_assignments ca
    LEFT JOIN frequencies f ON f.id = ca.frequency_id
    WHERE ca.target_type='equipment' AND ca.target_id=? AND ca.status='Completed'
    ORDER BY datetime(ca.completed_at) DESC
    LIMIT 1
  `).get(eqId);

  // Compute next due date
  let nextDue = null;
  if (lastCompleted && lastCompleted.completed_at && lastCompleted.frequency_days) {
    const d = new Date(lastCompleted.completed_at);
    d.setDate(d.getDate() + Number(lastCompleted.frequency_days));
    nextDue = d.toISOString().slice(0, 10);
  } else if (latest) {
    nextDue = latest.due_date || latest.effective_date || null;
  }

  // Determine status
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const toleranceDays = (lastCompleted?.tolerance_days ?? latest?.tolerance_days ?? 0);
  const dueWithTolerance = (dateStr) => {
    if (!dateStr) return null;
    const d = new Date(dateStr); d.setDate(d.getDate() + Number(toleranceDays || 0));
    return d;
  };

  let status = 'Out of PM Schedule';
  let reason = null;

  if (!latest) {
    status = 'Out of PM Schedule';
    reason = 'No PM has ever been assigned to this equipment.';
  } else if (latest.status === 'Expired') {
    status = 'Out of PM Schedule';
    reason = 'PM crossed its post-tolerance window and is awaiting re-assignment with exception details.';
  } else if (latest.status === 'Rejected') {
    status = 'Preventive Maintenance Rejected';
    reason = latest.rejection_reason || 'PM execution was rejected.';
  } else if (['Pending','In Progress','Pending Review','Pending Approval'].includes(latest.status)) {
    // Active assignment: Under PM, unless it's overdue past tolerance — then Out of Schedule.
    const dt = dueWithTolerance(latest.due_date || latest.effective_date);
    if (dt && today > dt && latest.status === 'Pending') {
      status = 'Out of PM Schedule';
      reason = 'PM was not assigned/started within the scheduled date + tolerance window.';
    } else {
      status = 'Under Preventive Maintenance';
      reason = `Current step: ${latest.status}`;
    }
  } else if (latest.status === 'Completed') {
    const dt = dueWithTolerance(nextDue);
    if (dt && today > dt) {
      status = 'Out of PM Schedule';
      reason = 'Last PM was completed but the next due date + tolerance has lapsed without a new assignment.';
    } else {
      status = 'Preventive Maintenance Completed';
      reason = `Last execution ${lastCompleted.completed_at}.`;
    }
  }

  res.json({
    plant_id: chain.plant_id || null,
    plant_name: chain.plant_name || null,
    unit_number: chain.unit_number || null,
    block_name: chain.block_name || null,
    location_name: chain.location_name || null,
    area_name: chain.area_name || null,
    equipment_id: eq.equipment_id,
    equipment_name: eq.name,
    equipment_description: [eq.make, eq.model, eq.capacity].filter(Boolean).join(' / ') || eq.name,
    pm_number: latest ? latest.assignment_id : null,
    frequency: latest ? latest.frequency_name : null,
    assignee_name: latest ? latest.assignee_name : null,
    last_execution_date: lastCompleted ? lastCompleted.completed_at : null,
    next_due_date: nextDue,
    current_status: status,
    reason,
    latest_assignment_id: latest ? latest.assignment_id : null,
    latest_assignment_status: latest ? latest.status : null,
  });
});

// =============================================================
// USERS
// =============================================================
app.get('/api/users', requireAuth, (req, res) => {
  res.json(db.prepare(`
    SELECT u.id, u.user_id, u.employee_id, u.name, u.email, u.phone,
           u.role_id, u.department_id,
           COALESCE(r.name, u.role)        AS role,
           COALESCE(d.name, u.department)  AS department,
           u.status, u.last_login
    FROM users u
    LEFT JOIN roles r ON r.id = u.role_id
    LEFT JOIN departments d ON d.id = u.department_id
    ORDER BY u.id
  `).all());
});

app.post('/api/users', requireAuth, requireActivity('manage_users'), (req, res) => {
  const { user_id, employee_id, name, email, phone, password, role_id, department_id } = req.body || {};
  if (!user_id || !name || !password || !role_id) {
    return res.status(400).json({ error: 'user_id, name, password and role_id required' });
  }
  const role = db.prepare("SELECT id, name, department_id FROM roles WHERE id=? AND status='Active'").get(role_id);
  if (!role) return res.status(400).json({ error: 'Unknown role_id' });
  const finalDeptId = department_id || role.department_id;
  const dept = db.prepare('SELECT id, name FROM departments WHERE id=?').get(finalDeptId);
  if (!dept) return res.status(400).json({ error: 'Unknown department_id' });
  const exists = db.prepare('SELECT 1 FROM users WHERE user_id=?').get(user_id);
  if (exists) return res.status(409).json({ error: 'user_id already exists' });
  if (employee_id) {
    const dupEmp = db.prepare('SELECT 1 FROM users WHERE employee_id=?').get(employee_id);
    if (dupEmp) return res.status(409).json({ error: 'employee_id already exists' });
  }

  const hash = hashPassword(password);
  const r = db.prepare(`INSERT INTO users(user_id,employee_id,name,email,phone,password_hash,role_id,department_id,role,department)
                        VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(user_id, employee_id || null, name, email||'', phone||'', hash, role.id, dept.id, role.name, dept.name);
  audit(req.user, 'CREATE', 'User', user_id, `Created ${name} (${employee_id || 'no emp id'}) — Role: ${role.name}, Dept: ${dept.name}`);
  res.json({ id: r.lastInsertRowid, user_id, employee_id, name, role: role.name, department: dept.name });
});

app.put('/api/users/:user_id', requireAuth, requireActivity('manage_users'), (req, res) => {
  const { employee_id, name, email, phone, role_id, department_id, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE user_id=?').get(req.params.user_id);
  if (!u) return res.status(404).json({ error: 'Not found' });

  let role = null, dept = null;
  if (role_id) {
    role = db.prepare('SELECT id,name,department_id FROM roles WHERE id=?').get(role_id);
    if (!role) return res.status(400).json({ error: 'Unknown role_id' });
  }
  if (department_id || role) {
    const dId = department_id || (role && role.department_id);
    dept = db.prepare('SELECT id,name FROM departments WHERE id=?').get(dId);
    if (!dept) return res.status(400).json({ error: 'Unknown department_id' });
  }
  if (employee_id && employee_id !== u.employee_id) {
    const dup = db.prepare('SELECT 1 FROM users WHERE employee_id=? AND user_id!=?').get(employee_id, req.params.user_id);
    if (dup) return res.status(409).json({ error: 'employee_id already exists' });
  }

  const changes = [];
  if (name && name !== u.name)             changes.push(`name "${u.name}" -> "${name}"`);
  if (email && email !== u.email)          changes.push('email updated');
  if (phone && phone !== u.phone)          changes.push('phone updated');
  if (employee_id && employee_id !== u.employee_id) changes.push(`emp_id "${u.employee_id||'-'}" -> "${employee_id}"`);
  if (role && role.id !== u.role_id)       changes.push(`role "${u.role}" -> "${role.name}"`);
  if (dept && dept.id !== u.department_id) changes.push(`dept "${u.department}" -> "${dept.name}"`);
  if (password)                            changes.push('password changed');

  db.prepare(`UPDATE users SET
      employee_id = COALESCE(?,employee_id),
      name = COALESCE(?,name),
      email = COALESCE(?,email),
      phone = COALESCE(?,phone),
      role_id = COALESCE(?,role_id),
      department_id = COALESCE(?,department_id),
      role = COALESCE(?,role),
      department = COALESCE(?,department),
      password_hash = COALESCE(?,password_hash)
    WHERE user_id=?`)
    .run(employee_id, name, email, phone, role?.id || null, dept?.id || null,
         role?.name || null, dept?.name || null,
         password ? hashPassword(password) : null,
         req.params.user_id);
  audit(req.user, 'UPDATE', 'User', req.params.user_id, changes.length ? changes.join('; ') : 'User profile touched');
  res.json({ ok: true });
});

app.put('/api/users/:user_id/status', requireAuth, requireActivity('manage_users'), (req, res) => {
  const { status } = req.body;
  if (!['Active','Locked','Inactive'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const before = db.prepare('SELECT status FROM users WHERE user_id=?').get(req.params.user_id);
  if (!before) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE users SET status=? WHERE user_id=?').run(status, req.params.user_id);
  // Kill active sessions if deactivating/locking
  if (status !== 'Active') {
    db.prepare('DELETE FROM sessions WHERE user_id=(SELECT id FROM users WHERE user_id=?)').run(req.params.user_id);
  }
  audit(req.user, 'UPDATE', 'User', req.params.user_id, `Status changed: ${before.status} -> ${status}`);
  res.json({ ok: true });
});

// Admin-driven password reset
app.put('/api/users/:user_id/password', requireAuth, requireActivity('manage_users'), (req, res) => {
  const { password } = req.body || {};
  if (!password || password.length < 6) return res.status(400).json({ error: 'password must be at least 6 characters' });
  const u = db.prepare('SELECT id, name FROM users WHERE user_id=?').get(req.params.user_id);
  if (!u) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE users SET password_hash=? WHERE user_id=?').run(hashPassword(password), req.params.user_id);
  // Invalidate sessions so the user must re-login with the new password
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
  audit(req.user, 'RESET_PASSWORD', 'User', req.params.user_id, `Password reset for ${u.name}; sessions invalidated`);
  res.json({ ok: true });
});

// =============================================================
// PM CONFIG
// =============================================================
app.get('/api/frequencies', requireAuth, (req,res) => res.json(db.prepare('SELECT * FROM frequencies ORDER BY days').all()));
app.get('/api/pm-categories', requireAuth, (req,res) => res.json(db.prepare('SELECT * FROM pm_categories ORDER BY name').all()));
app.get('/api/checklist-groups', requireAuth, (req,res) => {
  const { active } = req.query;
  // Active is the only status used in seed; we don't have a status column on groups yet,
  // so 'active' parameter is accepted for forward-compat and simply returns all groups for now.
  res.json(db.prepare(`
    SELECT cg.id, cg.name, cg.department_id, COALESCE(d.name, cg.department) AS department
    FROM checklist_groups cg LEFT JOIN departments d ON d.id = cg.department_id
    ORDER BY cg.name`).all());
});

app.post('/api/checklist-groups', requireAuth, requireActivity('manage_pm_categories','manage_checklists'), (req, res) => {
  const { name, department_id, reviewer_id, approver_id } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const apErr = validateMasterApprovers(req.user.id, reviewer_id, approver_id);
  if (apErr) return res.status(400).json({ error: apErr });
  const exists = db.prepare('SELECT 1 FROM checklist_groups WHERE name=?').get(name);
  if (exists) return res.status(409).json({ error: 'group already exists' });
  let dName = null;
  if (department_id) {
    const d = db.prepare('SELECT name FROM departments WHERE id=?').get(department_id);
    if (!d) return res.status(400).json({ error: 'Unknown department_id' });
    dName = d.name;
  }
  const r = db.prepare(`INSERT INTO checklist_groups(name,department_id,department,status,created_by,reviewer_id,approver_id)
                        VALUES (?,?,?,'Pending Review',?,?,?)`)
    .run(name, department_id || null, dName, req.user.id, Number(reviewer_id), Number(approver_id));
  audit(req.user, 'CREATE', 'ChecklistGroup', r.lastInsertRowid, `"${name}"${dName ? ' under ' + dName : ''} — submitted for review`);
  notify(Number(reviewer_id), 'Checklist Group awaiting your review',
    `"${name}" submitted by ${req.user.name}`, 'master_review', `/pmconfig/groups/${r.lastInsertRowid}`);
  res.json({ id: r.lastInsertRowid, name, department_id, department: dName, status: 'Pending Review' });
});

app.put('/api/checklist-groups/:id', requireAuth, requireActivity('manage_pm_categories','manage_checklists'), (req, res) => {
  const { name, department_id } = req.body || {};
  let dName = null;
  if (department_id) {
    const d = db.prepare('SELECT name FROM departments WHERE id=?').get(department_id);
    if (!d) return res.status(400).json({ error: 'Unknown department_id' });
    dName = d.name;
  }
  const r = db.prepare('UPDATE checklist_groups SET name=COALESCE(?,name), department_id=COALESCE(?,department_id), department=COALESCE(?,department) WHERE id=?')
    .run(name, department_id || null, dName, req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Not found' });
  audit(req.user, 'UPDATE', 'ChecklistGroup', req.params.id, `Updated`);
  res.json({ ok: true });
});

app.delete('/api/checklist-groups/:id', requireAuth, requireActivity('manage_pm_categories','manage_checklists'), (req, res) => {
  const inUse = db.prepare('SELECT COUNT(*) n FROM checklists WHERE group_id=?').get(req.params.id).n;
  if (inUse > 0) return res.status(409).json({ error: `Cannot delete — ${inUse} checklist(s) belong to this group.` });
  const r = db.prepare('DELETE FROM checklist_groups WHERE id=?').run(req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Not found' });
  audit(req.user, 'DELETE', 'ChecklistGroup', req.params.id, 'Group deleted');
  res.json({ ok: true });
});
app.get('/api/checklists', requireAuth, (req,res) => {
  const { status, category_id, group_id } = req.query;
  const where = [];
  const args = [];
  if (status)      { where.push('cl.status = ?');      args.push(status); }
  if (category_id) { where.push('cl.category_id = ?'); args.push(Number(category_id)); }
  if (group_id)    { where.push('cl.group_id = ?');    args.push(Number(group_id)); }
  const rows = db.prepare(`
    SELECT cl.id, cl.code, cl.name, cl.group_id, cl.category_id, cl.version, cl.status,
           cl.reviewer_id, cl.approver_id, cl.created_by,
           cg.name AS group_name,
           cb.name AS created_by_name, rv.name AS reviewer_name, ap.name AS approver_name
    FROM checklists cl
    LEFT JOIN checklist_groups cg ON cg.id = cl.group_id
    LEFT JOIN users cb ON cb.id = cl.created_by
    LEFT JOIN users rv ON rv.id = cl.reviewer_id
    LEFT JOIN users ap ON ap.id = cl.approver_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY cl.id
  `).all(...args);
  // Attach the list of allowed frequencies for each checklist (lightweight).
  const freqMap = {};
  db.prepare(`SELECT cf.checklist_id, f.id, f.name FROM checklist_frequencies cf JOIN frequencies f ON f.id = cf.frequency_id`).all()
    .forEach(r => { (freqMap[r.checklist_id] = freqMap[r.checklist_id] || []).push({ id: r.id, name: r.name }); });
  rows.forEach(r => { r.frequencies = freqMap[r.id] || []; });
  res.json(rows);
});
app.get('/api/checklists/:id', requireAuth, (req,res) => {
  const row = db.prepare('SELECT * FROM checklists WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  row.fields = JSON.parse(row.fields_json);
  delete row.fields_json;
  res.json(row);
});

// =============================================================
// PM SCHEDULES (lifecycle)
// =============================================================
function loadSchedule(pm_id) {
  const s = db.prepare(`
    SELECT s.*, e.name AS equipment_name,
      tech.name AS technician_name, rev.name AS reviewer_name, app.name AS approver_name,
      cl.name AS checklist_name, cl.version AS checklist_version
    FROM pm_schedules s
    LEFT JOIN equipment e ON e.equipment_id = s.equipment_id
    LEFT JOIN users tech  ON tech.id = s.technician_id
    LEFT JOIN users rev   ON rev.id  = s.reviewer_id
    LEFT JOIN users app   ON app.id  = s.approver_id
    LEFT JOIN checklists cl ON cl.id = s.checklist_id
    WHERE s.pm_id = ?
  `).get(pm_id);
  return s;
}

app.get('/api/pm', requireAuth, (req, res) => {
  const { status } = req.query;
  // Union legacy pm_schedules with the new checklist_assignments so the PM Execution view
  // shows EVERY PM in flight — regardless of which subsystem created it.
  const pmSql = `
    SELECT s.pm_id, s.equipment_id, e.name AS equipment_name,
      s.category, s.frequency, s.scheduled_date, s.status, s.department,
      tech.name AS technician_name,
      'pm_schedule' AS source
    FROM pm_schedules s
    LEFT JOIN equipment e ON e.equipment_id = s.equipment_id
    LEFT JOIN users tech  ON tech.id = s.technician_id
    ${status ? 'WHERE s.status = ?' : ''}
  `;
  const caSql = `
    SELECT ca.assignment_id AS pm_id, ca.target_id AS equipment_id, e.name AS equipment_name,
      NULL AS category,
      f.name AS frequency,
      COALESCE(ca.due_date, ca.effective_date) AS scheduled_date,
      ca.status,
      NULL AS department,
      u.name AS technician_name,
      'assignment' AS source
    FROM checklist_assignments ca
    LEFT JOIN equipment e   ON e.equipment_id = ca.target_id
    LEFT JOIN frequencies f ON f.id = ca.frequency_id
    LEFT JOIN users u       ON u.id = ca.assignee_id
    WHERE ca.target_type='equipment'
    ${status ? 'AND ca.status = ?' : ''}
  `;
  const args = status ? [status, status] : [];
  const rows = db.prepare(`${pmSql} UNION ALL ${caSql} ORDER BY scheduled_date DESC`).all(...args);
  res.json(rows);
});

app.get('/api/pm/:pm_id', requireAuth, (req, res) => {
  const s = loadSchedule(req.params.pm_id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  if (s.execution_data) s.execution_data = JSON.parse(s.execution_data);
  // attach checklist fields
  if (s.checklist_id) {
    const cl = db.prepare('SELECT fields_json FROM checklists WHERE id=?').get(s.checklist_id);
    if (cl) s.checklist_fields = JSON.parse(cl.fields_json);
  }
  res.json(s);
});

app.post('/api/pm', requireAuth, requireActivity('create_pm'), (req, res) => {
  const f = req.body;
  if (!f.equipment_id || !f.frequency || !f.scheduled_date)
    return res.status(400).json({ error: 'equipment_id, frequency, scheduled_date required' });

  const pm_id = nextPmId();
  const freqRow = db.prepare('SELECT tolerance_days FROM frequencies WHERE name=?').get(f.frequency);
  const tol = freqRow?.tolerance_days ?? 5;

  db.prepare(`INSERT INTO pm_schedules
    (pm_id,equipment_id,checklist_id,frequency,category,scheduled_date,tolerance_days,department,
     technician_id,reviewer_id,approver_id,status,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      pm_id, f.equipment_id, f.checklist_id || null, f.frequency, f.category || null,
      f.scheduled_date, tol, f.department || null,
      f.technician_id || null, f.reviewer_id || null, f.approver_id || null,
      'Pending', req.user.id
    );

  audit(req.user, 'CREATE', 'PM', pm_id, `Equipment ${f.equipment_id}, scheduled ${f.scheduled_date}`);
  res.json(loadSchedule(pm_id));
});

// Approve PM
app.put('/api/pm/:pm_id/approve', requireAuth, requireActivity('approve_pm'), (req, res) => {
  const s = db.prepare('SELECT * FROM pm_schedules WHERE pm_id=?').get(req.params.pm_id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  if (s.status !== 'Pending') return res.status(409).json({ error: `Cannot approve from status ${s.status}` });
  db.prepare('UPDATE pm_schedules SET status=?, approver_sig=? WHERE pm_id=?')
    .run('Approved', req.user.name + ' @ ' + new Date().toISOString(), req.params.pm_id);
  audit(req.user, 'APPROVE', 'PM', req.params.pm_id, 'PM approved for execution');
  res.json(loadSchedule(req.params.pm_id));
});

// Assign technician
app.put('/api/pm/:pm_id/assign', requireAuth, requireActivity('assign_pm'), (req, res) => {
  const { technician_id } = req.body;
  if (!technician_id) return res.status(400).json({ error: 'technician_id required' });
  const tech = db.prepare('SELECT name FROM users WHERE id=?').get(technician_id);
  if (!tech) return res.status(404).json({ error: 'Technician not found' });
  const s = db.prepare('SELECT * FROM pm_schedules WHERE pm_id=?').get(req.params.pm_id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  if (!['Approved','Assigned'].includes(s.status)) return res.status(409).json({ error: `Cannot assign from status ${s.status}` });
  db.prepare('UPDATE pm_schedules SET technician_id=?, status=? WHERE pm_id=?')
    .run(technician_id, 'Assigned', req.params.pm_id);
  audit(req.user, 'ASSIGN', 'PM', req.params.pm_id, `Assigned to ${tech.name}`);
  res.json(loadSchedule(req.params.pm_id));
});

// Start execution
app.put('/api/pm/:pm_id/start', requireAuth, (req, res) => {
  const s = db.prepare('SELECT * FROM pm_schedules WHERE pm_id=?').get(req.params.pm_id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  if (!['Approved','Assigned'].includes(s.status)) return res.status(409).json({ error: `Cannot start from status ${s.status}` });
  db.prepare("UPDATE pm_schedules SET status='In Progress', started_at=datetime('now'), technician_id=? WHERE pm_id=?")
    .run(s.technician_id || req.user.id, req.params.pm_id);
  audit(req.user, 'START', 'PM', req.params.pm_id, 'PM execution started');
  res.json(loadSchedule(req.params.pm_id));
});

// Complete (submit checklist data + signatures)
app.put('/api/pm/:pm_id/complete', requireAuth, (req, res) => {
  const { execution_data, technician_sig, reviewer_sig, remarks } = req.body || {};
  const s = db.prepare('SELECT * FROM pm_schedules WHERE pm_id=?').get(req.params.pm_id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  if (s.status !== 'In Progress') return res.status(409).json({ error: `Cannot complete from status ${s.status}` });

  db.prepare(`UPDATE pm_schedules SET
      status='Completed',
      completed_at=datetime('now'),
      execution_data=?,
      technician_sig=COALESCE(?,technician_sig),
      reviewer_sig=COALESCE(?,reviewer_sig),
      remarks=COALESCE(?,remarks)
    WHERE pm_id=?`)
    .run(JSON.stringify(execution_data || {}), technician_sig || req.user.name, reviewer_sig || null, remarks || null, req.params.pm_id);

  audit(req.user, 'COMPLETE', 'PM', req.params.pm_id, 'PM completed with checklist data');
  res.json(loadSchedule(req.params.pm_id));
});

// =============================================================
// BREAKDOWNS
// =============================================================
app.get('/api/breakdowns', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT b.bd_id, b.equipment_id, e.name AS equipment_name,
           b.reported_at, u.name AS reported_by_name,
           b.severity, b.status, b.description, b.mttr_hours, b.closed_at
    FROM breakdowns b
    LEFT JOIN equipment e ON e.equipment_id = b.equipment_id
    LEFT JOIN users u ON u.id = b.reported_by
    ORDER BY b.reported_at DESC
  `).all();
  res.json(rows);
});

app.post('/api/breakdowns', requireAuth, (req, res) => {
  const { equipment_id, severity, description } = req.body;
  if (!equipment_id || !severity) return res.status(400).json({ error: 'equipment_id and severity required' });
  const bd_id = nextBdId();
  db.prepare('INSERT INTO breakdowns(bd_id,equipment_id,reported_by,severity,description,status) VALUES (?,?,?,?,?,?)')
    .run(bd_id, equipment_id, req.user.id, severity, description || '', 'Active');
  audit(req.user, 'CREATE', 'Breakdown', bd_id, `${severity} on ${equipment_id}`);
  res.json(db.prepare('SELECT * FROM breakdowns WHERE bd_id=?').get(bd_id));
});

app.put('/api/breakdowns/:bd_id', requireAuth, (req, res) => {
  const f = req.body;
  const s = db.prepare('SELECT * FROM breakdowns WHERE bd_id=?').get(req.params.bd_id);
  if (!s) return res.status(404).json({ error: 'Not found' });

  let closedClause = '';
  let mttrClause = '';
  if (f.status === 'Closed' || f.status === 'Resolved') {
    closedClause = ', closed_at = datetime(\'now\')';
    if (!s.mttr_hours) {
      const hrs = (Date.now() - new Date(s.reported_at).getTime()) / 3600000;
      mttrClause = `, mttr_hours = ${Math.round(hrs * 10) / 10}`;
    }
  }

  db.prepare(`UPDATE breakdowns SET
      status = COALESCE(?, status),
      root_cause = COALESCE(?, root_cause),
      resolution = COALESCE(?, resolution),
      severity = COALESCE(?, severity)
      ${closedClause}${mttrClause}
    WHERE bd_id=?`)
    .run(f.status, f.root_cause, f.resolution, f.severity, req.params.bd_id);
  audit(req.user, 'UPDATE', 'Breakdown', req.params.bd_id, `Status: ${f.status || s.status}`);
  res.json(db.prepare('SELECT * FROM breakdowns WHERE bd_id=?').get(req.params.bd_id));
});

// =============================================================
// AUDIT LOG
// =============================================================
app.get('/api/audit', requireAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
  const rows = db.prepare(`
    SELECT id, ts, user_name, action, entity, entity_id, details
    FROM audit_log
    ORDER BY id DESC
    LIMIT ?
  `).all(limit);
  res.json(rows);
});

// =============================================================
// REPORTS
// =============================================================
app.get('/api/reports/equipment-history/:equipment_id', requireAuth, (req, res) => {
  // Union legacy pm_schedules + current checklist_assignments so the equipment
  // history reflects every PM cycle this asset has been through.
  const pmLegacy = db.prepare(`
    SELECT pm_id AS id, scheduled_date, frequency, category, status, completed_at,
           'pm_schedule' AS source
    FROM pm_schedules WHERE equipment_id=?
  `).all(req.params.equipment_id);
  const pmCa = db.prepare(`
    SELECT ca.assignment_id AS id,
           COALESCE(ca.effective_date, ca.due_date) AS scheduled_date,
           f.name AS frequency, NULL AS category,
           ca.status, ca.completed_at,
           'assignment' AS source
    FROM checklist_assignments ca
    LEFT JOIN frequencies f ON f.id = ca.frequency_id
    WHERE ca.target_type='equipment' AND ca.target_id=?
  `).all(req.params.equipment_id);
  const pm = [...pmLegacy, ...pmCa]
    .sort((a, b) => String(b.scheduled_date || '').localeCompare(String(a.scheduled_date || '')));
  const bd = db.prepare(`SELECT bd_id, reported_at, severity, status, description, closed_at FROM breakdowns WHERE equipment_id=? ORDER BY reported_at DESC`).all(req.params.equipment_id);
  res.json({ pm, breakdowns: bd });
});

app.get('/api/reports/overdue', requireAuth, (req, res) => {
  // Combine overdue/expired from both pm_schedules and checklist_assignments.
  const legacy = db.prepare(`
    SELECT s.pm_id AS id, s.equipment_id, e.name AS equipment_name,
           s.scheduled_date, s.frequency, s.status, s.department,
           'pm_schedule' AS source
    FROM pm_schedules s LEFT JOIN equipment e ON e.equipment_id = s.equipment_id
    WHERE s.status IN ('Overdue','Expired')
  `).all();
  const ca = db.prepare(`
    SELECT ca.assignment_id AS id, ca.target_id AS equipment_id, e.name AS equipment_name,
           COALESCE(ca.effective_date, ca.due_date) AS scheduled_date,
           f.name AS frequency, ca.status,
           COALESCE(d.name, u.department, '') AS department,
           'assignment' AS source
    FROM checklist_assignments ca
    LEFT JOIN equipment e ON e.equipment_id = ca.target_id AND ca.target_type='equipment'
    LEFT JOIN frequencies f ON f.id = ca.frequency_id
    LEFT JOIN users u  ON u.id = ca.assignee_id
    LEFT JOIN departments d ON d.id = u.department_id
    WHERE ca.status IN ('Overdue','Expired')
  `).all();
  const merged = [...legacy, ...ca].sort((a, b) =>
    String(a.scheduled_date || '').localeCompare(String(b.scheduled_date || '')));
  res.json(merged);
});

// Completed PMs report — every PM that has actually been executed and signed off.
// Optional ?from=YYYY-MM-DD&to=YYYY-MM-DD filters by completion date.
// Unions pm_schedules + checklist_assignments so it reflects everything completed
// under either workflow.
app.get('/api/reports/completed-pms', requireAuth, (req, res) => {
  const { from, to, equipment_id } = req.query;
  const legacyFilter = [];
  const caFilter = [];
  const legacyArgs = [];
  const caArgs = [];
  if (from) { legacyFilter.push('s.completed_at >= ?'); legacyArgs.push(from); caFilter.push('ca.completed_at >= ?'); caArgs.push(from); }
  if (to)   { legacyFilter.push('s.completed_at <= ?'); legacyArgs.push(to + ' 23:59:59'); caFilter.push('ca.completed_at <= ?'); caArgs.push(to + ' 23:59:59'); }
  if (equipment_id) { legacyFilter.push('s.equipment_id = ?'); legacyArgs.push(equipment_id); caFilter.push("ca.target_type='equipment' AND ca.target_id = ?"); caArgs.push(equipment_id); }

  const legacy = db.prepare(`
    SELECT s.pm_id AS id, s.equipment_id, e.name AS equipment_name,
           s.scheduled_date, s.completed_at,
           s.frequency, s.category, s.department,
           NULL AS checklist_name, NULL AS checklist_version,
           NULL AS assignee_name, NULL AS reviewer_name, NULL AS approver_name,
           'pm_schedule' AS source
    FROM pm_schedules s
    LEFT JOIN equipment e ON e.equipment_id = s.equipment_id
    WHERE s.status='Completed' ${legacyFilter.length ? 'AND ' + legacyFilter.join(' AND ') : ''}
  `).all(...legacyArgs);

  const ca = db.prepare(`
    SELECT ca.assignment_id AS id,
           ca.target_id AS equipment_id, e.name AS equipment_name,
           COALESCE(ca.effective_date, ca.due_date) AS scheduled_date,
           ca.completed_at,
           f.name AS frequency, NULL AS category,
           COALESCE(d.name, u.department, '') AS department,
           cl.name AS checklist_name, cl.version AS checklist_version,
           u.name AS assignee_name, rv.name AS reviewer_name, ap.name AS approver_name,
           'assignment' AS source
    FROM checklist_assignments ca
    LEFT JOIN equipment e ON e.equipment_id = ca.target_id AND ca.target_type='equipment'
    LEFT JOIN frequencies f ON f.id = ca.frequency_id
    LEFT JOIN checklists cl ON cl.id = ca.checklist_id
    LEFT JOIN users u   ON u.id = ca.assignee_id
    LEFT JOIN users rv  ON rv.id = ca.reviewer_id
    LEFT JOIN users ap  ON ap.id = ca.approver_id
    LEFT JOIN departments d ON d.id = u.department_id
    WHERE ca.status='Completed' ${caFilter.length ? 'AND ' + caFilter.join(' AND ') : ''}
  `).all(...caArgs);

  const merged = [...legacy, ...ca].sort((a, b) =>
    String(b.completed_at || '').localeCompare(String(a.completed_at || '')));
  res.json(merged);
});

// =============================================================
// CALENDAR
// =============================================================
app.get('/api/calendar', requireAuth, (req, res) => {
  // Auto-expire so the monthly + user calendars never show a PM that's silently
  // crossed its tolerance window (per spec: "Monthly Calendar / User Calendar
  // page – Post tolerance crossed" triggers Expired flip).
  try { markExpiredAssignments(); } catch (e) {}
  const { year, month } = req.query; // month is 1-12
  // Union pm_schedules + checklist_assignments — calendar shows EVERY scheduled PM.
  const pmCols = `
    s.pm_id, s.equipment_id, e.name AS equipment_name,
    s.frequency, s.category, s.scheduled_date, s.status,
    'pm_schedule' AS source
  `;
  const caCols = `
    ca.assignment_id AS pm_id, ca.target_id AS equipment_id, e.name AS equipment_name,
    f.name AS frequency, NULL AS category,
    COALESCE(ca.due_date, ca.effective_date) AS scheduled_date,
    ca.status,
    'assignment' AS source
  `;
  let rows;
  if (year && month) {
    const yyyy = String(year).padStart(4,'0');
    const mm = String(month).padStart(2,'0');
    rows = db.prepare(`
      SELECT ${pmCols}
      FROM pm_schedules s LEFT JOIN equipment e ON e.equipment_id = s.equipment_id
      WHERE strftime('%Y', s.scheduled_date)=? AND strftime('%m', s.scheduled_date)=?
      UNION ALL
      SELECT ${caCols}
      FROM checklist_assignments ca
      LEFT JOIN equipment e   ON e.equipment_id = ca.target_id
      LEFT JOIN frequencies f ON f.id = ca.frequency_id
      WHERE ca.target_type='equipment'
        AND strftime('%Y', COALESCE(ca.due_date, ca.effective_date))=?
        AND strftime('%m', COALESCE(ca.due_date, ca.effective_date))=?
      ORDER BY scheduled_date
    `).all(yyyy, mm, yyyy, mm);
  } else {
    rows = db.prepare(`
      SELECT ${pmCols}
      FROM pm_schedules s LEFT JOIN equipment e ON e.equipment_id = s.equipment_id
      UNION ALL
      SELECT ${caCols}
      FROM checklist_assignments ca
      LEFT JOIN equipment e   ON e.equipment_id = ca.target_id
      LEFT JOIN frequencies f ON f.id = ca.frequency_id
      WHERE ca.target_type='equipment'
      ORDER BY scheduled_date
    `).all();
  }
  res.json(rows);
});

// =============================================================
// DEPARTMENTS — admin-managed
// =============================================================
app.get('/api/departments', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM departments ORDER BY name').all());
});

app.post('/api/departments', requireAuth, requireActivity('manage_departments'), (req, res) => {
  const { name, description } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const exists = db.prepare('SELECT 1 FROM departments WHERE name=?').get(name);
  if (exists) return res.status(409).json({ error: 'Department already exists' });
  const r = db.prepare('INSERT INTO departments(name,description) VALUES (?,?)').run(name, description || '');
  audit(req.user, 'CREATE', 'Department', r.lastInsertRowid, `Created "${name}"`);
  res.json(db.prepare('SELECT * FROM departments WHERE id=?').get(r.lastInsertRowid));
});

app.put('/api/departments/:id', requireAuth, requireActivity('manage_departments'), (req, res) => {
  const { name, description, status } = req.body || {};
  const r = db.prepare(`UPDATE departments SET
      name = COALESCE(?,name),
      description = COALESCE(?,description),
      status = COALESCE(?,status)
    WHERE id=?`).run(name, description, status, req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Not found' });
  audit(req.user, 'UPDATE', 'Department', req.params.id, 'Department modified');
  res.json(db.prepare('SELECT * FROM departments WHERE id=?').get(req.params.id));
});

app.delete('/api/departments/:id', requireAuth, requireActivity('manage_departments'), (req, res) => {
  const inUse = db.prepare('SELECT COUNT(*) n FROM users WHERE department_id=?').get(req.params.id).n
              + db.prepare('SELECT COUNT(*) n FROM roles WHERE department_id=?').get(req.params.id).n;
  if (inUse > 0) return res.status(409).json({ error: `Cannot delete — ${inUse} user(s)/role(s) still reference this department. Reassign them first.` });
  const r = db.prepare('DELETE FROM departments WHERE id=?').run(req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Not found' });
  audit(req.user, 'DELETE', 'Department', req.params.id, 'Department deleted');
  res.json({ ok: true });
});

// =============================================================
// ACTIVITIES — permissions catalog (admin-extensible)
// =============================================================
app.get('/api/activities', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM activities ORDER BY category, label').all());
});

app.post('/api/activities', requireAuth, requireActivity('manage_activities'), (req, res) => {
  const { code, label, category } = req.body || {};
  if (!code || !label) return res.status(400).json({ error: 'code and label required' });
  if (!/^[a-z][a-z0-9_]*$/.test(code)) return res.status(400).json({ error: 'code must be lowercase letters / digits / underscore, starting with a letter' });
  const exists = db.prepare('SELECT 1 FROM activities WHERE code=?').get(code);
  if (exists) return res.status(409).json({ error: 'activity code already exists' });
  const r = db.prepare('INSERT INTO activities(code,label,category,is_system) VALUES (?,?,?,0)').run(code, label, category || 'Custom');
  audit(req.user, 'CREATE', 'Activity', r.lastInsertRowid, `Created activity "${code}"`);
  res.json(db.prepare('SELECT * FROM activities WHERE id=?').get(r.lastInsertRowid));
});

app.put('/api/activities/:id', requireAuth, requireActivity('manage_activities'), (req, res) => {
  const { label, category } = req.body || {};
  const a = db.prepare('SELECT * FROM activities WHERE id=?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE activities SET label=COALESCE(?,label), category=COALESCE(?,category) WHERE id=?')
    .run(label, category, req.params.id);
  audit(req.user, 'UPDATE', 'Activity', req.params.id, 'Activity modified');
  res.json(db.prepare('SELECT * FROM activities WHERE id=?').get(req.params.id));
});

app.delete('/api/activities/:id', requireAuth, requireActivity('manage_activities'), (req, res) => {
  const a = db.prepare('SELECT * FROM activities WHERE id=?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  if (a.is_system) return res.status(409).json({ error: 'Cannot delete built-in activity' });
  // Check no role uses this activity code
  const rolesUsing = db.prepare('SELECT name, permissions_json FROM roles').all()
    .filter(r => { try { return JSON.parse(r.permissions_json || '[]').includes(a.code); } catch (e) { return false; } });
  if (rolesUsing.length > 0) {
    return res.status(409).json({ error: `Cannot delete — ${rolesUsing.length} role(s) still grant this activity (${rolesUsing.map(r=>r.name).join(', ')}). Remove it from those roles first.` });
  }
  db.prepare('DELETE FROM activities WHERE id=?').run(req.params.id);
  audit(req.user, 'DELETE', 'Activity', req.params.id, `Deleted activity "${a.code}"`);
  res.json({ ok: true });
});

// =============================================================
// ROLES — admin-managed, each linked to one department, with a permissions list
// =============================================================
app.get('/api/roles', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT r.*, d.name AS department_name,
           (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id) AS user_count
    FROM roles r LEFT JOIN departments d ON d.id = r.department_id
    ORDER BY r.name
  `).all();
  rows.forEach(r => { try { r.permissions = JSON.parse(r.permissions_json || '[]'); } catch(e) { r.permissions = []; } delete r.permissions_json; });
  res.json(rows);
});

app.get('/api/roles/:id', requireAuth, (req, res) => {
  const r = db.prepare(`
    SELECT r.*, d.name AS department_name
    FROM roles r LEFT JOIN departments d ON d.id = r.department_id
    WHERE r.id = ?`).get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  try { r.permissions = JSON.parse(r.permissions_json || '[]'); } catch(e) { r.permissions = []; }
  delete r.permissions_json;
  res.json(r);
});

app.post('/api/roles', requireAuth, requireActivity('manage_roles'), (req, res) => {
  const { name, department_id, description, permissions } = req.body || {};
  if (!name || !department_id) return res.status(400).json({ error: 'name and department_id required' });
  const dept = db.prepare('SELECT 1 FROM departments WHERE id=?').get(department_id);
  if (!dept) return res.status(400).json({ error: 'Unknown department_id' });
  const exists = db.prepare('SELECT 1 FROM roles WHERE name=?').get(name);
  if (exists) return res.status(409).json({ error: 'role name already exists' });
  const perms = Array.isArray(permissions) ? [...new Set(permissions)] : [];
  // Validate every permission code exists in activities
  if (perms.length) {
    const known = new Set(db.prepare('SELECT code FROM activities').all().map(a=>a.code));
    const unknown = perms.filter(p => !known.has(p));
    if (unknown.length) return res.status(400).json({ error: `Unknown activities: ${unknown.join(', ')}` });
  }
  const r = db.prepare('INSERT INTO roles(name,department_id,description,permissions_json,is_system) VALUES (?,?,?,?,0)')
    .run(name, department_id, description || '', JSON.stringify(perms));
  audit(req.user, 'CREATE', 'Role', r.lastInsertRowid, `Created role "${name}" with ${perms.length} activities`);
  res.json({ id: r.lastInsertRowid, name, department_id, permissions: perms });
});

app.put('/api/roles/:id', requireAuth, requireActivity('manage_roles'), (req, res) => {
  const { name, department_id, description, permissions, status } = req.body || {};
  const role = db.prepare('SELECT * FROM roles WHERE id=?').get(req.params.id);
  if (!role) return res.status(404).json({ error: 'Not found' });
  let permsJson = null;
  if (Array.isArray(permissions)) {
    const known = new Set(db.prepare('SELECT code FROM activities').all().map(a=>a.code));
    const unknown = permissions.filter(p => !known.has(p));
    if (unknown.length) return res.status(400).json({ error: `Unknown activities: ${unknown.join(', ')}` });
    permsJson = JSON.stringify([...new Set(permissions)]);
  }
  db.prepare(`UPDATE roles SET
      name = COALESCE(?,name),
      department_id = COALESCE(?,department_id),
      description = COALESCE(?,description),
      permissions_json = COALESCE(?,permissions_json),
      status = COALESCE(?,status)
    WHERE id=?`).run(name, department_id, description, permsJson, status, req.params.id);

  // Keep denormalized role/department names on users in sync.
  if (name || department_id) {
    const fresh = db.prepare(`SELECT r.name AS rn, d.name AS dn FROM roles r LEFT JOIN departments d ON d.id=r.department_id WHERE r.id=?`).get(req.params.id);
    db.prepare('UPDATE users SET role=?, department=COALESCE(?,department) WHERE role_id=?').run(fresh.rn, fresh.dn, req.params.id);
  }
  audit(req.user, 'UPDATE', 'Role', req.params.id, 'Role modified');
  res.json({ ok: true });
});

app.delete('/api/roles/:id', requireAuth, requireActivity('manage_roles'), (req, res) => {
  const role = db.prepare('SELECT * FROM roles WHERE id=?').get(req.params.id);
  if (!role) return res.status(404).json({ error: 'Not found' });
  if (role.is_system) return res.status(409).json({ error: 'Cannot delete built-in role' });
  const inUse = db.prepare('SELECT COUNT(*) n FROM users WHERE role_id=?').get(req.params.id).n;
  if (inUse > 0) return res.status(409).json({ error: `Cannot delete — ${inUse} user(s) still have this role. Reassign them first.` });
  db.prepare('DELETE FROM roles WHERE id=?').run(req.params.id);
  audit(req.user, 'DELETE', 'Role', req.params.id, `Deleted role "${role.name}"`);
  res.json({ ok: true });
});

// =============================================================
// PM FREQUENCIES — admin-managed master
// =============================================================
app.post('/api/frequencies', requireAuth, requireActivity('manage_pm_frequencies'), (req, res) => {
  const { name, days, tolerance_days, reviewer_id, approver_id } = req.body || {};
  if (!name || days === undefined) return res.status(400).json({ error: 'name and days required' });
  const apErr = validateMasterApprovers(req.user.id, reviewer_id, approver_id);
  if (apErr) return res.status(400).json({ error: apErr });
  const exists = db.prepare('SELECT 1 FROM frequencies WHERE name=?').get(name);
  if (exists) return res.status(409).json({ error: 'frequency name already exists' });
  const r = db.prepare(`INSERT INTO frequencies(name,days,tolerance_days,status,created_by,reviewer_id,approver_id)
                        VALUES (?,?,?,'Pending Review',?,?,?)`)
    .run(name, parseInt(days,10), parseInt(tolerance_days || 0,10),
         req.user.id, Number(reviewer_id), Number(approver_id));
  audit(req.user, 'CREATE', 'Frequency', r.lastInsertRowid, `Created "${name}" (${days}d) — submitted for review`);
  notify(Number(reviewer_id), 'Frequency awaiting your review',
    `"${name}" (${days}d) submitted by ${req.user.name}`,
    'master_review', `/pmconfig/frequencies/${r.lastInsertRowid}`);
  res.json(db.prepare('SELECT * FROM frequencies WHERE id=?').get(r.lastInsertRowid));
});

app.put('/api/frequencies/:id', requireAuth, requireActivity('manage_pm_frequencies'), (req, res) => {
  const { name, days, tolerance_days, status } = req.body || {};
  const f = db.prepare('SELECT * FROM frequencies WHERE id=?').get(req.params.id);
  if (!f) return res.status(404).json({ error: 'Not found' });
  db.prepare(`UPDATE frequencies SET
      name=COALESCE(?,name),
      days=COALESCE(?,days),
      tolerance_days=COALESCE(?,tolerance_days),
      status=COALESCE(?,status)
    WHERE id=?`).run(name, days, tolerance_days, status, req.params.id);
  audit(req.user, 'UPDATE', 'Frequency', req.params.id, 'Frequency modified');
  res.json(db.prepare('SELECT * FROM frequencies WHERE id=?').get(req.params.id));
});

app.delete('/api/frequencies/:id', requireAuth, requireActivity('manage_pm_frequencies'), (req, res) => {
  const f = db.prepare('SELECT * FROM frequencies WHERE id=?').get(req.params.id);
  if (!f) return res.status(404).json({ error: 'Not found' });
  const inUse = db.prepare('SELECT COUNT(*) n FROM pm_schedules WHERE frequency=?').get(f.name).n
              + db.prepare('SELECT COUNT(*) n FROM checklist_assignments WHERE frequency_id=?').get(req.params.id).n;
  if (inUse > 0) return res.status(409).json({ error: `Cannot delete — ${inUse} PM(s) or assignment(s) still use this frequency.` });
  db.prepare('DELETE FROM frequencies WHERE id=?').run(req.params.id);
  audit(req.user, 'DELETE', 'Frequency', req.params.id, `Deleted "${f.name}"`);
  res.json({ ok: true });
});

// =============================================================
// PM CATEGORIES — admin-managed master
// =============================================================
app.post('/api/pm-categories', requireAuth, requireActivity('manage_pm_categories'), (req, res) => {
  const { name, description, reviewer_id, approver_id } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const apErr = validateMasterApprovers(req.user.id, reviewer_id, approver_id);
  if (apErr) return res.status(400).json({ error: apErr });
  const exists = db.prepare('SELECT 1 FROM pm_categories WHERE name=?').get(name);
  if (exists) return res.status(409).json({ error: 'category already exists' });
  const r = db.prepare(`INSERT INTO pm_categories(name,description,status,created_by,reviewer_id,approver_id)
                        VALUES (?,?,'Pending Review',?,?,?)`)
    .run(name, description || '', req.user.id, Number(reviewer_id), Number(approver_id));
  audit(req.user, 'CREATE', 'PMCategory', r.lastInsertRowid, `Created "${name}" — submitted for review`);
  notify(Number(reviewer_id), 'PM Category awaiting your review',
    `"${name}" submitted by ${req.user.name}`, 'master_review', `/pmconfig/categories/${r.lastInsertRowid}`);
  res.json(db.prepare('SELECT * FROM pm_categories WHERE id=?').get(r.lastInsertRowid));
});

app.put('/api/pm-categories/:id', requireAuth, requireActivity('manage_pm_categories'), (req, res) => {
  const { name, description, status } = req.body || {};
  const c = db.prepare('SELECT * FROM pm_categories WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  db.prepare(`UPDATE pm_categories SET name=COALESCE(?,name), description=COALESCE(?,description), status=COALESCE(?,status) WHERE id=?`)
    .run(name, description, status, req.params.id);
  audit(req.user, 'UPDATE', 'PMCategory', req.params.id, 'Category modified');
  res.json(db.prepare('SELECT * FROM pm_categories WHERE id=?').get(req.params.id));
});

app.delete('/api/pm-categories/:id', requireAuth, requireActivity('manage_pm_categories'), (req, res) => {
  const c = db.prepare('SELECT * FROM pm_categories WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  const inUse = db.prepare('SELECT COUNT(*) n FROM pm_schedules WHERE category=?').get(c.name).n
              + db.prepare('SELECT COUNT(*) n FROM checklists WHERE category_id=?').get(req.params.id).n;
  if (inUse > 0) return res.status(409).json({ error: `Cannot delete — ${inUse} PM(s) / checklist(s) use this category.` });
  db.prepare('DELETE FROM pm_categories WHERE id=?').run(req.params.id);
  audit(req.user, 'DELETE', 'PMCategory', req.params.id, `Deleted "${c.name}"`);
  res.json({ ok: true });
});

// =============================================================
// STRUCTURED CHECKLISTS — sections + questions
// =============================================================
function loadChecklistFull(id) {
  const cl = db.prepare(`
    SELECT cl.*, d.name AS dept_name, cg.name AS group_name, pc.name AS category_name,
           u.name AS created_by_name,
           rv.name AS reviewer_name, ap.name AS approver_name
    FROM checklists cl
    LEFT JOIN checklist_groups cg ON cg.id = cl.group_id
    LEFT JOIN departments d ON d.id = cg.department_id
    LEFT JOIN pm_categories pc ON pc.id = cl.category_id
    LEFT JOIN users u  ON u.id  = cl.created_by
    LEFT JOIN users rv ON rv.id = cl.reviewer_id
    LEFT JOIN users ap ON ap.id = cl.approver_id
    WHERE cl.id = ?`).get(id);
  if (!cl) return null;
  const sections = db.prepare('SELECT * FROM checklist_sections WHERE checklist_id=? ORDER BY position, id').all(id);
  for (const s of sections) {
    const qs = db.prepare('SELECT * FROM checklist_questions WHERE section_id=? ORDER BY position, id').all(s.id);
    for (const q of qs) {
      try { q.options = q.options_json ? JSON.parse(q.options_json) : null; } catch(e) { q.options = null; }
      try { q.frequencies = q.frequencies_json ? JSON.parse(q.frequencies_json) : []; } catch(e) { q.frequencies = []; }
      delete q.options_json;
      delete q.frequencies_json;
    }
    s.questions = qs;
  }
  cl.sections = sections;
  if (cl.fields_json) {
    try { cl.legacy_fields = JSON.parse(cl.fields_json); } catch(e) {}
  }
  delete cl.fields_json;
  try { cl.required_fields = cl.required_fields_json ? JSON.parse(cl.required_fields_json) : []; } catch(e) { cl.required_fields = []; }
  delete cl.required_fields_json;
  cl.frequencies = db.prepare(`SELECT f.id, f.name, f.days, f.tolerance_days
                               FROM checklist_frequencies cf JOIN frequencies f ON f.id = cf.frequency_id
                               WHERE cf.checklist_id = ?
                               ORDER BY f.days`).all(id);
  return cl;
}

app.get('/api/checklists/:id/full', requireAuth, (req, res) => {
  const cl = loadChecklistFull(req.params.id);
  if (!cl) return res.status(404).json({ error: 'Not found' });
  res.json(cl);
});

// Allowed standard "Required Field" keys for execution-side capture.
const REQUIRED_FIELD_KEYS = ['area','equipment','capacity_make','spares','validation_by','corrective','external_report'];

function validateChecklistCore({ code, name }, { codeRequired = true } = {}) {
  if (codeRequired || code !== undefined && code !== null && code !== '') {
    if (!code) return 'Checklist ID is required';
    if (!/^[A-Za-z0-9_\-]{2,50}$/.test(code)) return 'Checklist ID must be 2-50 alphanumeric characters (letters, digits, - and _ allowed)';
  }
  if (!name || name.length < 3 || name.length > 300) return 'Checklist Name must be 3-300 characters';
  return null;
}

function saveChecklistFrequencies(checklistId, frequencyIds) {
  db.prepare('DELETE FROM checklist_frequencies WHERE checklist_id=?').run(checklistId);
  if (!Array.isArray(frequencyIds)) return;
  const ins = db.prepare('INSERT OR IGNORE INTO checklist_frequencies(checklist_id, frequency_id) VALUES (?,?)');
  for (const fid of frequencyIds) {
    if (!fid) continue;
    const f = db.prepare("SELECT id FROM frequencies WHERE id=? AND status='Active'").get(fid);
    if (f) ins.run(checklistId, f.id);
  }
}

app.post('/api/checklists', requireAuth, requireActivity('manage_checklists'), (req, res) => {
  const { code, name, description, group_id, category_id, sections, required_fields, frequency_ids } = req.body || {};
  const err = validateChecklistCore({ code, name });
  if (err) return res.status(400).json({ error: err });
  if (!group_id) return res.status(400).json({ error: 'PM Checklist Group is required' });
  const grp = db.prepare('SELECT id FROM checklist_groups WHERE id=?').get(group_id);
  if (!grp) return res.status(400).json({ error: 'Unknown checklist group' });
  // First-ever creation of this code starts at v1.0. Multiple versions of the
  // same code coexist (each row is a distinct version). The composite UNIQUE
  // index on (code, version) prevents accidental duplicate-version inserts.
  if (db.prepare("SELECT 1 FROM checklists WHERE code=? AND version='v1.0'").get(code)) {
    return res.status(409).json({ error: `Checklist ID "${code}" already exists. Use "Create new version" on the existing record instead.` });
  }
  // Sanitize required_fields to known keys
  const reqd = Array.isArray(required_fields)
    ? required_fields.filter(k => REQUIRED_FIELD_KEYS.includes(k))
    : [];
  // Version is system-controlled. New checklists always start at v1.0 — the client cannot override.
  const r = db.prepare(`INSERT INTO checklists(code,name,description,group_id,category_id,version,status,required_fields_json,created_by)
                        VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(code, name, description || '', group_id || null, category_id || null, 'v1.0', 'Draft', JSON.stringify(reqd), req.user.id);
  const newId = r.lastInsertRowid;
  saveChecklistFrequencies(newId, frequency_ids);
  if (Array.isArray(sections)) {
    const insSec = db.prepare('INSERT INTO checklist_sections(checklist_id,name,description,position) VALUES (?,?,?,?)');
    const insQ = db.prepare(`INSERT INTO checklist_questions(section_id,label,qtype,options_json,required,min_value,max_value,unit,frequencies_json,position) VALUES (?,?,?,?,?,?,?,?,?,?)`);
    sections.forEach((s, sIdx) => {
      const sId = insSec.run(newId, s.name || `Section ${sIdx+1}`, s.description || '', sIdx+1).lastInsertRowid;
      (s.questions || []).forEach((q, qIdx) => {
        const freqsJson = Array.isArray(q.frequencies) && q.frequencies.length
          ? JSON.stringify(q.frequencies.map(Number).filter(Boolean))
          : null;
        insQ.run(sId, q.label || 'Question', q.qtype || 'text',
                 q.options ? JSON.stringify(q.options) : null,
                 q.required ? 1 : 0,
                 q.min_value ?? null, q.max_value ?? null, q.unit || null, freqsJson, qIdx+1);
      });
    });
  }
  audit(req.user, 'CREATE', 'Checklist', newId, `Created "${name}"`);
  res.json(loadChecklistFull(newId));
});

app.put('/api/checklists/:id', requireAuth, requireActivity('manage_checklists'), (req, res) => {
  // Note: `version` from req.body is intentionally ignored — it's system-controlled.
  const { code, name, description, group_id, category_id, status, sections, required_fields, frequency_ids } = req.body || {};
  const cl = db.prepare('SELECT * FROM checklists WHERE id=?').get(req.params.id);
  if (!cl) return res.status(404).json({ error: 'Not found' });
  // Only allow content edits while in Draft / Rejected. Approved checklists are locked.
  if (!['Draft','Rejected'].includes(cl.status) && (sections || name || description || code)) {
    return res.status(409).json({ error: `Cannot edit checklist in status "${cl.status}". Bump the version or push back to Draft.` });
  }
  if (code !== undefined && code !== null && code !== '' && code !== cl.code) {
    if (!/^[A-Za-z0-9_\-]{2,50}$/.test(code)) return res.status(400).json({ error: 'Checklist ID must be 2-50 alphanumeric characters' });
    // Editing a code is only valid if there's no other row with that (code, version) pair.
    if (db.prepare('SELECT 1 FROM checklists WHERE code=? AND version=? AND id!=?').get(code, cl.version, req.params.id)) {
      return res.status(409).json({ error: `Checklist ID "${code}" at ${cl.version} already exists` });
    }
  }
  if (name !== undefined && (name.length < 3 || name.length > 300)) {
    return res.status(400).json({ error: 'Checklist Name must be 3-300 characters' });
  }
  let reqdJson = null;
  if (Array.isArray(required_fields)) {
    reqdJson = JSON.stringify(required_fields.filter(k => REQUIRED_FIELD_KEYS.includes(k)));
  }
  db.prepare(`UPDATE checklists SET
      code=COALESCE(?,code),
      name=COALESCE(?,name),
      description=COALESCE(?,description),
      group_id=COALESCE(?,group_id),
      category_id=COALESCE(?,category_id),
      status=COALESCE(?,status),
      required_fields_json=COALESCE(?,required_fields_json)
    WHERE id=?`).run(code, name, description, group_id, category_id, status, reqdJson, req.params.id);

  if (Array.isArray(frequency_ids)) saveChecklistFrequencies(req.params.id, frequency_ids);

  // If sections payload provided, replace structured content (idempotent overwrite).
  if (Array.isArray(sections)) {
    db.prepare('DELETE FROM checklist_sections WHERE checklist_id=?').run(req.params.id);
    const insSec = db.prepare('INSERT INTO checklist_sections(checklist_id,name,description,position) VALUES (?,?,?,?)');
    const insQ = db.prepare(`INSERT INTO checklist_questions(section_id,label,qtype,options_json,required,min_value,max_value,unit,frequencies_json,position) VALUES (?,?,?,?,?,?,?,?,?,?)`);
    sections.forEach((s, sIdx) => {
      const sId = insSec.run(req.params.id, s.name || `Section ${sIdx+1}`, s.description || '', sIdx+1).lastInsertRowid;
      (s.questions || []).forEach((q, qIdx) => {
        const freqsJson = Array.isArray(q.frequencies) && q.frequencies.length
          ? JSON.stringify(q.frequencies.map(Number).filter(Boolean))
          : null;
        insQ.run(sId, q.label || 'Question', q.qtype || 'text',
                 q.options ? JSON.stringify(q.options) : null,
                 q.required ? 1 : 0,
                 q.min_value ?? null, q.max_value ?? null, q.unit || null, freqsJson, qIdx+1);
      });
    });
  }
  audit(req.user, 'UPDATE', 'Checklist', req.params.id, 'Checklist modified');
  res.json(loadChecklistFull(req.params.id));
});

app.delete('/api/checklists/:id', requireAuth, requireActivity('manage_checklists'), (req, res) => {
  const cl = db.prepare('SELECT * FROM checklists WHERE id=?').get(req.params.id);
  if (!cl) return res.status(404).json({ error: 'Not found' });
  const inUse = db.prepare('SELECT COUNT(*) n FROM pm_schedules WHERE checklist_id=?').get(req.params.id).n
              + db.prepare('SELECT COUNT(*) n FROM checklist_assignments WHERE checklist_id=?').get(req.params.id).n;
  if (inUse > 0) return res.status(409).json({ error: `Cannot delete — ${inUse} PM(s) / assignment(s) still reference this checklist.` });
  db.prepare('DELETE FROM checklists WHERE id=?').run(req.params.id);
  audit(req.user, 'DELETE', 'Checklist', req.params.id, `Deleted "${cl.name}"`);
  res.json({ ok: true });
});

// ---- Checklist workflow: Initiator -> Reviewer -> Approver ----
// Draft  ->[submit]-> Pending Review ->[review]-> Pending Approval ->[approve]-> Approved
//                                                          \-> Rejected (any stage with rejection_reason)
app.put('/api/checklists/:id/submit', requireAuth, requireActivity('manage_checklists'), (req, res) => {
  const { reviewer_id, approver_id } = req.body || {};
  const cl = db.prepare('SELECT * FROM checklists WHERE id=?').get(req.params.id);
  if (!cl) return res.status(404).json({ error: 'Not found' });
  if (!['Draft','Rejected'].includes(cl.status)) return res.status(409).json({ error: `Cannot submit from status "${cl.status}"` });
  if (!reviewer_id || !approver_id) return res.status(400).json({ error: 'reviewer_id and approver_id required' });
  if (reviewer_id === approver_id) return res.status(400).json({ error: 'Reviewer and approver must be different users' });
  const reviewer = db.prepare('SELECT id, name FROM users WHERE id=?').get(reviewer_id);
  const approver = db.prepare('SELECT id, name FROM users WHERE id=?').get(approver_id);
  if (!reviewer || !approver) return res.status(400).json({ error: 'Unknown reviewer or approver' });
  // Must have at least one section with at least one question to be submittable
  const sectionCount = db.prepare('SELECT COUNT(*) n FROM checklist_sections WHERE checklist_id=?').get(req.params.id).n;
  if (sectionCount === 0) return res.status(409).json({ error: 'Add at least one section + question before submitting' });

  db.prepare(`UPDATE checklists SET
      status='Pending Review', reviewer_id=?, approver_id=?,
      submitted_at=datetime('now'), reviewed_at=NULL, approved_at=NULL, rejection_reason=NULL
    WHERE id=?`).run(reviewer_id, approver_id, req.params.id);
  notify(reviewer_id,
    'Checklist awaiting your review',
    `${cl.name} (${cl.version}) submitted by ${req.user.name}.`,
    'checklist_review',
    `/checklists/${req.params.id}`);
  audit(req.user, 'SUBMIT', 'Checklist', req.params.id, `Submitted "${cl.name}" for review (reviewer: ${reviewer.name}, approver: ${approver.name})`);
  res.json({ ok: true });
});

app.put('/api/checklists/:id/review', requireAuth, requireActivity('review_checklist'), requireESignature, (req, res) => {
  const { decision, reason } = req.body || {};
  const cl = db.prepare('SELECT * FROM checklists WHERE id=?').get(req.params.id);
  if (!cl) return res.status(404).json({ error: 'Not found' });
  if (cl.status !== 'Pending Review') return res.status(409).json({ error: `Not in Pending Review (currently ${cl.status})` });
  if (cl.reviewer_id !== req.user.id && !req.user.is_admin) return res.status(403).json({ error: 'Only the assigned reviewer can review this checklist' });
  if (!['approve','reject'].includes(decision)) return res.status(400).json({ error: 'decision must be "approve" or "reject"' });

  if (decision === 'approve') {
    db.prepare("UPDATE checklists SET status='Pending Approval', reviewed_at=datetime('now') WHERE id=?").run(req.params.id);
    notify(cl.approver_id,
      'Checklist awaiting your approval',
      `${cl.name} (${cl.version}) reviewed by ${req.user.name}.`,
      'checklist_approve',
      `/checklists/${req.params.id}`);
    audit(req.user, 'REVIEW', 'Checklist', req.params.id, `Reviewed "${cl.name}" — passed to approver`);
  } else {
    if (!reason || !reason.trim()) return res.status(400).json({ error: 'reason required for rejection' });
    db.prepare("UPDATE checklists SET status='Rejected', rejection_reason=? WHERE id=?").run(reason, req.params.id);
    notify(cl.created_by,
      'Checklist rejected by reviewer',
      `${cl.name}: ${reason}`,
      'checklist_rejected',
      `/checklists/${req.params.id}`);
    audit(req.user, 'REJECT', 'Checklist', req.params.id, `Rejected at review: ${reason}`);
  }
  res.json({ ok: true });
});

app.put('/api/checklists/:id/approve', requireAuth, requireActivity('approve_checklist'), requireESignature, (req, res) => {
  const { decision, reason } = req.body || {};
  const cl = db.prepare('SELECT * FROM checklists WHERE id=?').get(req.params.id);
  if (!cl) return res.status(404).json({ error: 'Not found' });
  if (cl.status !== 'Pending Approval') return res.status(409).json({ error: `Not in Pending Approval (currently ${cl.status})` });
  if (cl.approver_id !== req.user.id && !req.user.is_admin) return res.status(403).json({ error: 'Only the assigned approver can approve this checklist' });

  if (decision === 'reject') {
    if (!reason || !reason.trim()) return res.status(400).json({ error: 'reason required for rejection' });
    db.prepare("UPDATE checklists SET status='Rejected', rejection_reason=? WHERE id=?").run(reason, req.params.id);
    notify(cl.created_by,
      'Checklist rejected by approver',
      `${cl.name}: ${reason}`,
      'checklist_rejected',
      `/checklists/${req.params.id}`);
    audit(req.user, 'REJECT', 'Checklist', req.params.id, `Rejected at approval: ${reason}`);
  } else {
    db.prepare("UPDATE checklists SET status='Approved', approved_at=datetime('now') WHERE id=?").run(req.params.id);
    // Auto-supersede: any other Approved versions of THIS code drop to Superseded.
    // The current version is now the canonical one for new assignments.
    const supersededRows = db.prepare(`
      SELECT id, version FROM checklists
      WHERE code=? AND id != ? AND status='Approved'
    `).all(cl.code, req.params.id);
    if (supersededRows.length > 0) {
      const upd = db.prepare("UPDATE checklists SET status='Superseded', superseded_at=datetime('now'), superseded_by=? WHERE id=?");
      for (const row of supersededRows) {
        upd.run(req.params.id, row.id);
        audit(req.user, 'SUPERSEDE', 'Checklist', row.id, `Superseded by ${cl.code} ${cl.version} (id ${req.params.id})`);
      }
    }
    notify(cl.created_by,
      'Checklist approved',
      `${cl.name} (${cl.version}) is now approved${supersededRows.length?` — ${supersededRows.length} prior version(s) auto-superseded`:''}.`,
      'checklist_approved',
      `/checklists/${req.params.id}`);
    if (cl.reviewer_id && cl.reviewer_id !== req.user.id) {
      notify(cl.reviewer_id, 'Checklist approved', `${cl.name} (${cl.version}) has been approved.`, 'checklist_approved', `/checklists/${req.params.id}`);
    }
    audit(req.user, 'APPROVE', 'Checklist', req.params.id, `Approved "${cl.name}" (${cl.version}) — available for assignment${supersededRows.length?` · superseded ${supersededRows.length} older version(s)`:''}`);
  }
  res.json({ ok: true });
});

// ---- Versioning -----------------------------------------------------------
// "Create a new version" branches an existing checklist into a brand-new Draft
// row that shares the same code + name but bumps the major version (v1.0 ->
// v2.0 -> v3.0). Sections, questions, frequencies, and required_fields are
// copied. The original row is untouched until the new version reaches Approved
// — at which point the auto-supersede logic in /approve marks the older Active
// versions as 'Superseded'. Assignments referencing old versions stay live.
function bumpMajorVersion(v) {
  // Accepts 'v1.0', 'v2.0', '1', 'v1', etc. Returns 'v(N+1).0'.
  const m = String(v || 'v1.0').match(/(\d+)/);
  const major = m ? parseInt(m[1], 10) : 1;
  return `v${major + 1}.0`;
}
app.post('/api/checklists/:id/new-version', requireAuth, requireActivity('manage_checklists'), (req, res) => {
  const src = db.prepare('SELECT * FROM checklists WHERE id=?').get(req.params.id);
  if (!src) return res.status(404).json({ error: 'Source checklist not found' });
  // Compute next version: look at every version of this code and pick max+1
  const sibs = db.prepare("SELECT version FROM checklists WHERE code=?").all(src.code);
  const maxMajor = sibs.reduce((mx, r) => {
    const m = String(r.version || '').match(/(\d+)/);
    return Math.max(mx, m ? parseInt(m[1], 10) : 0);
  }, 0);
  const newVersion = `v${maxMajor + 1}.0`;
  // Insert new Draft row
  const r = db.prepare(`INSERT INTO checklists(code,name,description,group_id,category_id,version,status,required_fields_json,created_by)
                        VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(src.code, src.name, src.description, src.group_id, src.category_id, newVersion, 'Draft', src.required_fields_json, req.user.id);
  const newId = r.lastInsertRowid;
  // Copy frequencies
  const freqRows = db.prepare('SELECT frequency_id FROM checklist_frequencies WHERE checklist_id=?').all(src.id);
  const insFreq = db.prepare('INSERT INTO checklist_frequencies(checklist_id,frequency_id) VALUES (?,?)');
  for (const fr of freqRows) insFreq.run(newId, fr.frequency_id);
  // Copy sections + questions
  const sections = db.prepare('SELECT * FROM checklist_sections WHERE checklist_id=? ORDER BY position, id').all(src.id);
  const insSec = db.prepare('INSERT INTO checklist_sections(checklist_id,name,description,position) VALUES (?,?,?,?)');
  const insQ = db.prepare(`INSERT INTO checklist_questions(section_id,label,qtype,options_json,required,min_value,max_value,unit,frequencies_json,position) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  for (const sec of sections) {
    const newSecId = insSec.run(newId, sec.name, sec.description, sec.position).lastInsertRowid;
    const qs = db.prepare('SELECT * FROM checklist_questions WHERE section_id=? ORDER BY position, id').all(sec.id);
    for (const q of qs) {
      insQ.run(newSecId, q.label, q.qtype, q.options_json, q.required, q.min_value, q.max_value, q.unit, q.frequencies_json, q.position);
    }
  }
  audit(req.user, 'NEW_VERSION', 'Checklist', newId, `Created ${newVersion} of "${src.name}" (${src.code}) — branched from ${src.version}`);
  res.json({ id: newId, code: src.code, version: newVersion, status: 'Draft' });
});

// ---- Drop / Reactivate ----------------------------------------------------
// An Approved checklist can be dropped (deactivated) so it's no longer
// available for new assignments. Existing assignments referencing it are left
// alone. Dropped checklists can be reactivated. Both actions require e-sig.
app.put('/api/checklists/:id/drop', requireAuth, requireActivity('approve_checklist','manage_checklists'), requireESignature, (req, res) => {
  const { remarks } = req.body || {};
  const cl = db.prepare('SELECT * FROM checklists WHERE id=?').get(req.params.id);
  if (!cl) return res.status(404).json({ error: 'Not found' });
  if (cl.status !== 'Approved') return res.status(409).json({ error: `Only Approved checklists can be dropped (currently ${cl.status})` });
  if (!remarks || !remarks.trim()) return res.status(400).json({ error: 'Remarks are required to drop a checklist (regulatory traceability)' });
  db.prepare("UPDATE checklists SET status='Inactive', dropped_at=datetime('now'), drop_remarks=? WHERE id=?").run(remarks, req.params.id);
  if (cl.created_by && cl.created_by !== req.user.id) {
    notify(cl.created_by, 'Checklist dropped',
      `${cl.name} (${cl.version}) has been dropped: ${remarks}`,
      'checklist_dropped', `/checklists/${req.params.id}`);
  }
  audit(req.user, 'DROP', 'Checklist', req.params.id, `Dropped "${cl.name}" (${cl.version}): ${remarks}`);
  res.json({ ok: true });
});

app.put('/api/checklists/:id/reactivate', requireAuth, requireActivity('approve_checklist','manage_checklists'), requireESignature, (req, res) => {
  const { remarks } = req.body || {};
  const cl = db.prepare('SELECT * FROM checklists WHERE id=?').get(req.params.id);
  if (!cl) return res.status(404).json({ error: 'Not found' });
  if (cl.status !== 'Inactive') return res.status(409).json({ error: `Only Inactive checklists can be reactivated (currently ${cl.status})` });
  db.prepare("UPDATE checklists SET status='Approved', dropped_at=NULL, drop_remarks=NULL WHERE id=?").run(req.params.id);
  if (cl.created_by && cl.created_by !== req.user.id) {
    notify(cl.created_by, 'Checklist reactivated',
      `${cl.name} (${cl.version}) is now Active again.`,
      'checklist_reactivated', `/checklists/${req.params.id}`);
  }
  audit(req.user, 'REACTIVATE', 'Checklist', req.params.id, `Reactivated "${cl.name}" (${cl.version})${remarks?': '+remarks:''}`);
  res.json({ ok: true });
});

// =============================================================
// CHECKLIST ASSIGNMENTS — manager assigns checklist to user; user is notified
// =============================================================
function nextAssignmentId() {
  const row = db.prepare("SELECT assignment_id FROM checklist_assignments ORDER BY id DESC LIMIT 1").get();
  if (!row) return 'CA-001';
  const m = row.assignment_id.match(/(\d+)$/);
  const n = m ? parseInt(m[1], 10) + 1 : 1;
  return 'CA-' + String(n).padStart(3, '0');
}

app.get('/api/assignments', requireAuth, (req, res) => {
  // Auto-expire so the assignments list / PM Approval page / My Tasks never
  // show a row that's silently crossed tolerance (per spec).
  try { markExpiredAssignments(); } catch (e) {}
  const { mine, status, inbox } = req.query;
  // "inbox=1" — anything awaiting THIS user: executor / reviewer / approver / clearance grantor /
  //                                          assigner whose assignment is now Awaiting Executor.
  const where = [];
  const args = [];
  if (mine === '1')  { where.push('ca.assignee_id = ?'); args.push(req.user.id); }
  if (inbox === '1') {
    // Withdrawn assignments never appear in the inbox — the workflow is terminal.
    where.push("ca.status NOT IN ('Withdrawn')");
    where.push("(ca.assignee_id = ? OR ca.reviewer_id = ? OR ca.approver_id = ? OR ca.clearance_user_id = ? OR (ca.status='Awaiting Executor' AND ca.assigned_by = ?))");
    args.push(req.user.id, req.user.id, req.user.id, req.user.id, req.user.id);
  }
  if (status)        { where.push('ca.status = ?');     args.push(status); }
  const sql = `
    SELECT ca.id, ca.assignment_id, ca.checklist_id, ca.target_type, ca.target_id,
           ca.assignee_id, ca.reviewer_id, ca.approver_id, ca.frequency_id,
           ca.effective_date, ca.due_date,
           ca.status, ca.notes, ca.assigned_at, ca.started_at,
           ca.submitted_at, ca.reviewed_at, ca.approved_at, ca.completed_at,
           ca.rejection_reason,
           ca.clearance_user_id, ca.clearance_status,
           ca.clearance_requested_at, ca.clearance_responded_at, ca.clearance_remarks,
           cl.name AS checklist_name, cl.version AS checklist_version,
           u.name  AS assignee_name, u.user_id  AS assignee_user_id,
           rv.name AS reviewer_name, rv.user_id AS reviewer_user_id,
           ap.name AS approver_name, ap.user_id AS approver_user_id,
           cu.name AS clearance_user_name,
           b.name  AS assigned_by_name,
           f.name  AS frequency, f.days AS frequency_days, f.tolerance_days,
           CASE ca.target_type
             WHEN 'equipment' THEN (SELECT name FROM equipment WHERE equipment_id = ca.target_id)
             WHEN 'area'      THEN (SELECT name FROM areas WHERE area_id = ca.target_id)
             ELSE NULL
           END AS target_label
    FROM checklist_assignments ca
    LEFT JOIN checklists cl ON cl.id = ca.checklist_id
    LEFT JOIN users u   ON u.id   = ca.assignee_id
    LEFT JOIN users rv  ON rv.id  = ca.reviewer_id
    LEFT JOIN users ap  ON ap.id  = ca.approver_id
    LEFT JOIN users cu  ON cu.id  = ca.clearance_user_id
    LEFT JOIN users b   ON b.id   = ca.assigned_by
    LEFT JOIN frequencies f ON f.id = ca.frequency_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY ca.due_date IS NULL, ca.due_date ASC, ca.id DESC
  `;
  res.json(db.prepare(sql).all(...args));
});

app.get('/api/assignments/:assignment_id', requireAuth, (req, res) => {
  const row = db.prepare(`
    SELECT ca.*, cl.name AS checklist_name, cl.version AS checklist_version,
           u.name  AS assignee_name, u.user_id  AS assignee_user_id,
           rv.name AS reviewer_name, rv.user_id AS reviewer_user_id,
           ap.name AS approver_name, ap.user_id AS approver_user_id,
           cu.name AS clearance_user_name,
           b.name  AS assigned_by_name, f.name AS frequency, f.days AS frequency_days, f.tolerance_days,
           CASE ca.target_type
             WHEN 'equipment' THEN (SELECT name FROM equipment WHERE equipment_id = ca.target_id)
             WHEN 'area'      THEN (SELECT name FROM areas WHERE area_id = ca.target_id)
             ELSE NULL
           END AS target_label
    FROM checklist_assignments ca
    LEFT JOIN checklists cl ON cl.id = ca.checklist_id
    LEFT JOIN users u   ON u.id   = ca.assignee_id
    LEFT JOIN users rv  ON rv.id  = ca.reviewer_id
    LEFT JOIN users ap  ON ap.id  = ca.approver_id
    LEFT JOIN users cu  ON cu.id  = ca.clearance_user_id
    LEFT JOIN users b   ON b.id   = ca.assigned_by
    LEFT JOIN frequencies f ON f.id = ca.frequency_id
    WHERE ca.assignment_id = ?`).get(req.params.assignment_id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.response_data) { try { row.response_data = JSON.parse(row.response_data); } catch(e) {} }
  row.checklist = loadChecklistFull(row.checklist_id);
  res.json(row);
});

app.post('/api/assignments', requireAuth, requireActivity('assign_checklist'), (req, res) => {
  const { checklist_id, target_type, target_id, clearance_user_id, reviewer_id, approver_id,
          frequency_id, effective_date, due_date, notes } = req.body || {};
  if (!checklist_id || !target_type || !target_id) {
    return res.status(400).json({ error: 'checklist_id, target_type and target_id required' });
  }
  if (!clearance_user_id) return res.status(400).json({ error: 'Clearance User (production) is required' });
  if (!['equipment','area'].includes(target_type)) {
    return res.status(400).json({ error: 'target_type must be "equipment" or "area"' });
  }
  const cl = db.prepare('SELECT id, name, status, reviewer_id AS template_reviewer, approver_id AS template_approver FROM checklists WHERE id=?').get(checklist_id);
  if (!cl) return res.status(400).json({ error: 'Unknown checklist_id' });
  if (cl.status !== 'Approved') {
    return res.status(409).json({ error: `Cannot assign — checklist is "${cl.status}". Only Approved checklists can be assigned.` });
  }
  // Validate target exists
  let targetName = '';
  if (target_type === 'equipment') {
    const eq = db.prepare('SELECT equipment_id, name FROM equipment WHERE equipment_id=?').get(target_id);
    if (!eq) return res.status(400).json({ error: 'Unknown equipment_id' });
    targetName = `${eq.equipment_id} (${eq.name})`;
  } else {
    const ar = db.prepare('SELECT area_id, name FROM areas WHERE area_id=?').get(target_id);
    if (!ar) return res.status(400).json({ error: 'Unknown area_id' });
    targetName = `${ar.area_id} (${ar.name || ''})`;
  }
  const grantor = db.prepare('SELECT id, name FROM users WHERE id=?').get(clearance_user_id);
  if (!grantor) return res.status(400).json({ error: 'Unknown clearance_user_id' });

  // Reviewer/approver: default to checklist's template reviewer/approver if not given.
  const finalReviewer = reviewer_id || cl.template_reviewer;
  const finalApprover = approver_id || cl.template_approver;
  if (!finalReviewer || !finalApprover) {
    return res.status(400).json({ error: 'reviewer_id and approver_id are required (checklist has no defaults)' });
  }
  if (finalReviewer === finalApprover) {
    return res.status(400).json({ error: 'Reviewer and approver must be different users' });
  }
  const rv = db.prepare('SELECT id, name FROM users WHERE id=?').get(finalReviewer);
  const ap = db.prepare('SELECT id, name FROM users WHERE id=?').get(finalApprover);
  if (!rv || !ap) return res.status(400).json({ error: 'Unknown reviewer/approver' });

  const aid = nextAssignmentId();
  // New assignments start at "Pending Assignment Review" — the Engineering plan must be
  // reviewed and then approved before the production clearance request is even issued.
  db.prepare(`INSERT INTO checklist_assignments(assignment_id,checklist_id,target_type,target_id,
              reviewer_id,approver_id,frequency_id,effective_date,due_date,notes,status,
              clearance_user_id,assigned_by)
              VALUES (?,?,?,?, ?,?,?,?,?,?,?, ?,?)`)
    .run(aid, checklist_id, target_type, target_id,
         rv.id, ap.id, frequency_id || null, effective_date || null, due_date || null, notes || '', 'Pending Assignment Review',
         grantor.id, req.user.id);

  notify(rv.id,
    'PM assignment plan awaiting your review',
    `${cl.name} on ${target_type} ${targetName}${due_date ? ' — scheduled ' + due_date : ''}. Review before production clearance is requested.`,
    'assignment_plan_review',
    `/assignments/${aid}`);

  audit(req.user, 'ASSIGN', 'Checklist', aid,
    `Assigned "${cl.name}" to ${target_type} ${targetName} — Reviewer ${rv.name} → Approver ${ap.name} → Clearance ${grantor.name}`);
  res.json(db.prepare('SELECT * FROM checklist_assignments WHERE assignment_id=?').get(aid));
});

// ---- Step 4: Equipment Assignment Review & Approval ----
// Engineering's assignment plan is reviewed and approved BEFORE the production clearance
// request is sent. Reuses the same reviewer_id + approver_id picked at assignment time —
// in pharma practice the same chain authorises both the plan and the execution.
app.put('/api/assignments/:assignment_id/assignment-review', requireAuth, requireActivity('review_pm','review_checklist'), requireESignature, (req, res) => {
  const { decision, reason } = req.body || {};
  const a = db.prepare('SELECT * FROM checklist_assignments WHERE assignment_id=?').get(req.params.assignment_id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  if (a.status !== 'Pending Assignment Review') return res.status(409).json({ error: `Cannot review from status "${a.status}"` });
  if (a.reviewer_id !== req.user.id && !req.user.is_admin) return res.status(403).json({ error: 'Only the assigned reviewer can review this assignment plan' });
  if (!['approve','reject'].includes(decision)) return res.status(400).json({ error: 'decision must be "approve" or "reject"' });

  if (decision === 'approve') {
    db.prepare("UPDATE checklist_assignments SET status='Pending Assignment Approval' WHERE assignment_id=?").run(req.params.assignment_id);
    notify(a.approver_id,
      'PM assignment plan awaiting your approval',
      `${req.params.assignment_id} reviewed by ${req.user.name}.`,
      'assignment_plan_approve',
      `/assignments/${req.params.assignment_id}`);
    audit(req.user, 'PLAN_REVIEW', 'Assignment', req.params.assignment_id, `Reviewed assignment plan — passed to approver`);
  } else {
    if (!reason || !reason.trim()) return res.status(400).json({ error: 'reason required for rejection' });
    db.prepare("UPDATE checklist_assignments SET status='Assignment Rejected', rejection_reason=? WHERE assignment_id=?").run(reason, req.params.assignment_id);
    if (a.assigned_by) {
      notify(a.assigned_by, 'PM assignment plan rejected at review', `${req.params.assignment_id}: ${reason}`, 'assignment_plan_rejected', `/assignments/${req.params.assignment_id}`);
    }
    audit(req.user, 'PLAN_REJECT', 'Assignment', req.params.assignment_id, `Rejected at assignment review: ${reason}`);
  }
  res.json({ ok: true });
});

app.put('/api/assignments/:assignment_id/assignment-approve', requireAuth, requireActivity('approve_pm','approve_checklist'), requireESignature, (req, res) => {
  const { decision, reason } = req.body || {};
  const a = db.prepare('SELECT * FROM checklist_assignments WHERE assignment_id=?').get(req.params.assignment_id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  if (a.status !== 'Pending Assignment Approval') return res.status(409).json({ error: `Cannot approve from status "${a.status}"` });
  if (a.approver_id !== req.user.id && !req.user.is_admin) return res.status(403).json({ error: 'Only the assigned approver can approve this assignment plan' });

  if (decision === 'reject') {
    if (!reason || !reason.trim()) return res.status(400).json({ error: 'reason required for rejection' });
    db.prepare("UPDATE checklist_assignments SET status='Assignment Rejected', rejection_reason=? WHERE assignment_id=?").run(reason, req.params.assignment_id);
    if (a.assigned_by) {
      notify(a.assigned_by, 'PM assignment plan rejected at approval', `${req.params.assignment_id}: ${reason}`, 'assignment_plan_rejected', `/assignments/${req.params.assignment_id}`);
    }
    audit(req.user, 'PLAN_REJECT', 'Assignment', req.params.assignment_id, `Rejected at assignment approval: ${reason}`);
  } else {
    // Plan approved — the PM is now Scheduled. Clearance is a separate, manual step
    // initiated by Engineering closer to the due date (see /request-clearance below).
    db.prepare(`UPDATE checklist_assignments SET status='Scheduled' WHERE assignment_id=?`)
      .run(req.params.assignment_id);
    if (a.assigned_by) {
      notify(a.assigned_by,
        'PM scheduled — initiate clearance when ready',
        `${req.params.assignment_id} plan approved by ${req.user.name}. It now sits in the calendar at ${a.due_date || a.effective_date || 'the scheduled date'}. Initiate the production clearance request closer to that date.`,
        'pm_scheduled',
        `/assignments/${req.params.assignment_id}`);
    }
    audit(req.user, 'PLAN_APPROVE', 'Assignment', req.params.assignment_id, `Assignment plan approved — PM scheduled (clearance pending Engineering initiation)`);
  }
  res.json({ ok: true });
});

// ---- Step 7: Engineering manually initiates the Production Clearance Request ----
// Triggered closer to the due date — only at this point does the production user receive
// the clearance request notification.
app.put('/api/assignments/:assignment_id/request-clearance', requireAuth, requireActivity('assign_checklist'), (req, res) => {
  const a = db.prepare('SELECT * FROM checklist_assignments WHERE assignment_id=?').get(req.params.assignment_id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  if (a.status !== 'Scheduled') return res.status(409).json({ error: `Cannot initiate clearance — assignment is "${a.status}". Clearance can only be requested for a Scheduled PM.` });
  if (!a.clearance_user_id) return res.status(409).json({ error: 'No clearance user attached to this assignment.' });

  const cu = db.prepare('SELECT name FROM users WHERE id=?').get(a.clearance_user_id);
  const cl = db.prepare('SELECT name FROM checklists WHERE id=?').get(a.checklist_id);

  db.prepare(`UPDATE checklist_assignments SET
      status='Pending Clearance',
      clearance_status='Pending',
      clearance_requested_at=datetime('now')
    WHERE assignment_id=?`).run(req.params.assignment_id);

  notify(a.clearance_user_id,
    'PM Clearance requested',
    `${cl ? cl.name + ' on ' : ''}${a.target_id} — clearance requested by ${req.user.name}${a.due_date ? ' (due ' + a.due_date + ')' : ''}.`,
    'clearance',
    `/assignments/${req.params.assignment_id}`);

  audit(req.user, 'REQUEST_CLEARANCE', 'Assignment', req.params.assignment_id,
    `Clearance request sent to ${cu ? cu.name : '#'+a.clearance_user_id}`);
  res.json({ ok: true });
});

// ---- Clearance step: Production user grants/denies BEFORE executor is assigned ----
app.put('/api/assignments/:assignment_id/clearance', requireAuth, requireActivity('grant_clearance'), requireESignature, (req, res) => {
  const { decision, remarks } = req.body || {};
  // Pull frequency tolerance via join so we can enforce the tolerance window.
  const a = db.prepare(`
    SELECT ca.*, f.tolerance_days AS freq_tolerance_days, f.name AS frequency_name
    FROM checklist_assignments ca
    LEFT JOIN frequencies f ON f.id = ca.frequency_id
    WHERE ca.assignment_id=?
  `).get(req.params.assignment_id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  if (a.status !== 'Pending Clearance') return res.status(409).json({ error: `Cannot act on clearance — assignment is "${a.status}"` });
  if (a.clearance_user_id !== req.user.id && !req.user.is_admin) {
    return res.status(403).json({ error: 'Only the designated clearance user can grant or deny this clearance' });
  }
  if (!['grant','deny'].includes(decision)) return res.status(400).json({ error: 'decision must be "grant" or "deny"' });

  // Tolerance enforcement (only when granting — denial is always allowed).
  // The scheduled date is `effective_date`. The frequency carries a
  // `tolerance_days` window. Clearance must be granted by
  // (effective_date + tolerance_days). Past that, the row should go through
  // the Expired Equipment / PNC-Exception path, not normal clearance.
  if (decision === 'grant') {
    const scheduled = a.effective_date || a.due_date;
    const tol = Number(a.freq_tolerance_days ?? a.tolerance_days ?? 0);
    if (scheduled) {
      const sched = new Date(scheduled + 'T00:00:00Z');
      const deadline = new Date(sched.getTime() + tol * 24 * 60 * 60 * 1000);
      const todayUtc = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
      if (todayUtc > deadline) {
        const overdueDays = Math.floor((todayUtc - deadline) / (24 * 60 * 60 * 1000));
        audit(req.user, 'CLEARANCE_BLOCKED', 'Assignment', req.params.assignment_id,
          `Attempted to grant clearance ${overdueDays}d past tolerance window (scheduled ${scheduled}, +${tol}d tolerance). Use Expired Equipment / PNC-Exception flow.`);
        return res.status(409).json({
          error: `Cannot grant clearance — assignment is ${overdueDays} day(s) past the tolerance window. Scheduled ${scheduled}, +${tol} day tolerance. Route this through the Expired Equipment module with a PNC + Exception reference instead.`
        });
      }
    }
  }

  if (decision === 'grant') {
    db.prepare(`UPDATE checklist_assignments SET
        status='Awaiting Executor',
        clearance_status='Granted',
        clearance_responded_at=datetime('now'),
        clearance_remarks=?
      WHERE assignment_id=?`).run(remarks || null, req.params.assignment_id);
    if (a.assigned_by) {
      notify(a.assigned_by,
        'Clearance granted — assign an executor',
        `${req.params.assignment_id} is cleared by ${req.user.name}. Pick an executor to start execution.`,
        'awaiting_executor',
        `/assignments/${req.params.assignment_id}`);
    }
    // Audit message captures the timestamp + tolerance window for the regulatory file.
    const sched = a.effective_date || a.due_date;
    const tol = Number(a.freq_tolerance_days ?? a.tolerance_days ?? 0);
    const tolNote = sched ? ` · scheduled ${sched} (+${tol}d tol)` : '';
    audit(req.user, 'CLEARANCE_GRANT', 'Assignment', req.params.assignment_id,
      `Granted by ${req.user.name} at ${new Date().toISOString().slice(0,16).replace('T',' ')}${tolNote}${remarks?` — ${remarks}`:''}`);
  } else {
    if (!remarks || !remarks.trim()) return res.status(400).json({ error: 'Remarks required for denial' });
    db.prepare(`UPDATE checklist_assignments SET
        status='Clearance Denied',
        clearance_status='Denied',
        clearance_responded_at=datetime('now'),
        clearance_remarks=?
      WHERE assignment_id=?`).run(remarks, req.params.assignment_id);
    if (a.assigned_by) {
      notify(a.assigned_by,
        'Clearance denied',
        `${req.params.assignment_id}: ${remarks}`,
        'clearance_denied',
        `/assignments/${req.params.assignment_id}`);
    }
    audit(req.user, 'CLEARANCE_DENY', 'Assignment', req.params.assignment_id,
      `Denied by ${req.user.name} — ${remarks}`);
  }
  res.json({ ok: true });
});

// ---- After clearance is granted, the Engineering Manager picks the executor ----
app.put('/api/assignments/:assignment_id/assign-executor', requireAuth, requireActivity('assign_checklist'), (req, res) => {
  const { assignee_id } = req.body || {};
  if (!assignee_id) return res.status(400).json({ error: 'assignee_id required' });
  const a = db.prepare('SELECT * FROM checklist_assignments WHERE assignment_id=?').get(req.params.assignment_id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  if (a.status !== 'Awaiting Executor') return res.status(409).json({ error: `Cannot assign executor — assignment is "${a.status}"` });
  const u = db.prepare('SELECT id, name FROM users WHERE id=?').get(assignee_id);
  if (!u) return res.status(400).json({ error: 'Unknown user' });
  if (a.reviewer_id === u.id || a.approver_id === u.id) {
    return res.status(400).json({ error: 'Executor cannot also be the assigned reviewer or approver' });
  }
  db.prepare(`UPDATE checklist_assignments SET assignee_id=?, status='Pending' WHERE assignment_id=?`)
    .run(u.id, req.params.assignment_id);
  notify(u.id,
    'New PM activity assigned to you',
    `${req.params.assignment_id} — ${req.user.name} assigned you as executor.`,
    'assignment',
    `/assignments/${req.params.assignment_id}`);
  audit(req.user, 'ASSIGN_EXECUTOR', 'Assignment', req.params.assignment_id, `Executor set to ${u.name}`);
  res.json({ ok: true });
});

function isExecutor(a, user) {
  if (user.is_admin) return true;
  if (a.assignee_id && a.assignee_id === user.id) return true;
  // Open assignment — first taker claims it
  if (!a.assignee_id && userHasActivity(user, 'execute_checklist')) return true;
  return false;
}

// Executor begins work
app.put('/api/assignments/:assignment_id/start', requireAuth, (req, res) => {
  const a = db.prepare('SELECT * FROM checklist_assignments WHERE assignment_id=?').get(req.params.assignment_id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  if (!isExecutor(a, req.user)) return res.status(403).json({ error: 'Only the assigned executor can start this assignment' });
  if (!['Pending'].includes(a.status)) return res.status(409).json({ error: `Cannot start from status ${a.status}` });
  if (!a.assignee_id) {
    db.prepare("UPDATE checklist_assignments SET assignee_id=? WHERE assignment_id=?").run(req.user.id, req.params.assignment_id);
  }
  db.prepare("UPDATE checklist_assignments SET status='In Progress', started_at=datetime('now') WHERE assignment_id=?")
    .run(req.params.assignment_id);
  audit(req.user, 'START', 'Assignment', req.params.assignment_id,
    `Assignment started by ${req.user.name}${!a.assignee_id ? ' (claimed open assignment)' : ''}`);
  res.json({ ok: true });
});

// Executor saves partial progress without changing status (autosave-like).
app.put('/api/assignments/:assignment_id/save', requireAuth, (req, res) => {
  const { response_data, notes } = req.body || {};
  const a = db.prepare('SELECT * FROM checklist_assignments WHERE assignment_id=?').get(req.params.assignment_id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  if (!isExecutor(a, req.user)) return res.status(403).json({ error: 'Only the executor can save progress' });
  if (!['Pending','In Progress'].includes(a.status)) return res.status(409).json({ error: `Cannot save from status ${a.status}` });
  if (a.status === 'Pending') {
    db.prepare("UPDATE checklist_assignments SET status='In Progress', started_at=COALESCE(started_at, datetime('now')), assignee_id=COALESCE(assignee_id, ?) WHERE assignment_id=?")
      .run(req.user.id, req.params.assignment_id);
  }
  db.prepare('UPDATE checklist_assignments SET response_data=?, notes=COALESCE(?,notes) WHERE assignment_id=?')
    .run(JSON.stringify(response_data || {}), notes || null, req.params.assignment_id);
  res.json({ ok: true });
});

// Executor submits completed work for review
app.put('/api/assignments/:assignment_id/submit', requireAuth, (req, res) => {
  const { response_data, notes } = req.body || {};
  const a = db.prepare('SELECT * FROM checklist_assignments WHERE assignment_id=?').get(req.params.assignment_id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  if (!isExecutor(a, req.user)) return res.status(403).json({ error: 'Only the executor can submit this assignment' });
  if (!['Pending','In Progress'].includes(a.status)) return res.status(409).json({ error: `Cannot submit from status ${a.status}` });
  if (!a.reviewer_id || !a.approver_id) return res.status(409).json({ error: 'No reviewer/approver attached to this assignment — ask the manager to set them.' });

  // Claim if open
  if (!a.assignee_id) {
    db.prepare("UPDATE checklist_assignments SET assignee_id=? WHERE assignment_id=?").run(req.user.id, req.params.assignment_id);
  }
  const sig = `${req.user.name} @ ${new Date().toISOString()}`;
  db.prepare(`UPDATE checklist_assignments SET
      status='Pending Review',
      response_data=?,
      notes=COALESCE(?,notes),
      executor_sig=?,
      submitted_at=datetime('now'),
      started_at=COALESCE(started_at, datetime('now')),
      rejection_reason=NULL
    WHERE assignment_id=?`)
    .run(JSON.stringify(response_data || {}), notes || null, sig, req.params.assignment_id);
  notify(a.reviewer_id,
    'PM activity awaiting your review',
    `${req.params.assignment_id} submitted by ${req.user.name}.`,
    'assignment_review',
    `/assignments/${req.params.assignment_id}`);
  audit(req.user, 'SUBMIT', 'Assignment', req.params.assignment_id,
    `Submitted for review by ${req.user.name}`);
  res.json({ ok: true });
});

// Reviewer's action: pass to approver, or reject back to executor
app.put('/api/assignments/:assignment_id/review', requireAuth, requireActivity('review_pm','review_checklist'), requireESignature, (req, res) => {
  const { decision, reason } = req.body || {};
  const a = db.prepare('SELECT * FROM checklist_assignments WHERE assignment_id=?').get(req.params.assignment_id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  if (a.status !== 'Pending Review') return res.status(409).json({ error: `Cannot review from status ${a.status}` });
  if (a.reviewer_id !== req.user.id && !req.user.is_admin) return res.status(403).json({ error: 'Only the assigned reviewer can review this assignment' });
  if (!['approve','reject'].includes(decision)) return res.status(400).json({ error: 'decision must be "approve" or "reject"' });

  if (decision === 'approve') {
    const sig = `${req.user.name} @ ${new Date().toISOString()}`;
    db.prepare("UPDATE checklist_assignments SET status='Pending Approval', reviewer_sig=?, reviewed_at=datetime('now') WHERE assignment_id=?")
      .run(sig, req.params.assignment_id);
    notify(a.approver_id,
      'PM activity awaiting your approval',
      `${req.params.assignment_id} reviewed by ${req.user.name}.`,
      'assignment_approve',
      `/assignments/${req.params.assignment_id}`);
    audit(req.user, 'REVIEW', 'Assignment', req.params.assignment_id, `Reviewed — passed to approver`);
  } else {
    if (!reason || !reason.trim()) return res.status(400).json({ error: 'reason required for rejection' });
    db.prepare("UPDATE checklist_assignments SET status='In Progress', rejection_reason=?, reviewed_at=NULL, reviewer_sig=NULL WHERE assignment_id=?")
      .run(reason, req.params.assignment_id);
    if (a.assignee_id) {
      notify(a.assignee_id,
        'Your PM activity needs rework',
        `${req.params.assignment_id}: ${reason}`,
        'assignment_rejected',
        `/assignments/${req.params.assignment_id}`);
    }
    audit(req.user, 'REJECT', 'Assignment', req.params.assignment_id, `Rejected at review: ${reason}`);
  }
  res.json({ ok: true });
});

// Approver's action: final approval or rejection back to executor
app.put('/api/assignments/:assignment_id/approve', requireAuth, requireActivity('approve_pm','approve_checklist'), requireESignature, (req, res) => {
  const { decision, reason } = req.body || {};
  const a = db.prepare('SELECT * FROM checklist_assignments WHERE assignment_id=?').get(req.params.assignment_id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  if (a.status !== 'Pending Approval') return res.status(409).json({ error: `Cannot approve from status ${a.status}` });
  if (a.approver_id !== req.user.id && !req.user.is_admin) return res.status(403).json({ error: 'Only the assigned approver can approve this assignment' });

  if (decision === 'reject') {
    if (!reason || !reason.trim()) return res.status(400).json({ error: 'reason required for rejection' });
    db.prepare("UPDATE checklist_assignments SET status='In Progress', rejection_reason=?, approved_at=NULL, approver_sig=NULL, reviewed_at=NULL, reviewer_sig=NULL WHERE assignment_id=?")
      .run(reason, req.params.assignment_id);
    if (a.assignee_id) {
      notify(a.assignee_id, 'Your PM activity was rejected by QA', `${req.params.assignment_id}: ${reason}`, 'assignment_rejected', `/assignments/${req.params.assignment_id}`);
    }
    if (a.reviewer_id) {
      notify(a.reviewer_id, 'PM activity rejected by approver', `${req.params.assignment_id}: ${reason}`, 'assignment_rejected', `/assignments/${req.params.assignment_id}`);
    }
    audit(req.user, 'REJECT', 'Assignment', req.params.assignment_id, `Rejected at approval: ${reason}`);
  } else {
    const sig = `${req.user.name} @ ${new Date().toISOString()}`;
    db.prepare("UPDATE checklist_assignments SET status='Completed', approver_sig=?, approved_at=datetime('now'), completed_at=datetime('now') WHERE assignment_id=?")
      .run(sig, req.params.assignment_id);
    if (a.assignee_id) {
      notify(a.assignee_id, 'PM activity approved & closed', `${req.params.assignment_id} has been approved.`, 'assignment_completed', `/assignments/${req.params.assignment_id}`);
    }
    if (a.assigned_by && a.assigned_by !== req.user.id) {
      notify(a.assigned_by, 'PM activity completed', `${req.params.assignment_id} is closed.`, 'assignment_completed', `/assignments/${req.params.assignment_id}`);
    }
    audit(req.user, 'APPROVE', 'Assignment', req.params.assignment_id, `Final approval — assignment closed`);
  }
  res.json({ ok: true });
});

// =============================================================
// EXPIRED EQUIPMENT — auto-detect + re-assign workflow
// =============================================================
// Lifecycle: Pending/In Progress/Pending Review/Pending Approval
//            -> Expired (auto when today > due_date + tolerance, or effective + freq.days + tolerance)
//            -> Pending (via re-assign with PNC + Exception + Description)
function markExpiredAssignments() {
  const rows = db.prepare(`
    SELECT ca.assignment_id, ca.due_date, ca.effective_date, ca.status,
           f.days AS freq_days, f.tolerance_days
    FROM checklist_assignments ca
    LEFT JOIN frequencies f ON f.id = ca.frequency_id
    WHERE ca.status IN ('Pending Assignment Review','Pending Assignment Approval','Scheduled','Pending Clearance','Awaiting Executor','Pending','In Progress','Pending Review','Pending Approval')
  `).all();
  const todayStr = new Date().toISOString().slice(0, 10);
  const today = new Date(todayStr);
  const upd = db.prepare("UPDATE checklist_assignments SET status='Expired', expired_at=datetime('now') WHERE assignment_id=?");
  let n = 0;
  for (const a of rows) {
    const tol = Number(a.tolerance_days || 0);
    let expireBy = null;
    if (a.due_date) {
      const d = new Date(a.due_date);
      d.setDate(d.getDate() + tol);
      expireBy = d;
    } else if (a.effective_date && a.freq_days) {
      const d = new Date(a.effective_date);
      d.setDate(d.getDate() + Number(a.freq_days) + tol);
      expireBy = d;
    }
    if (expireBy && today > expireBy) {
      upd.run(a.assignment_id);
      n++;
    }
  }
  return n;
}

// ----- Pending (overdue but within tolerance) ------------------------------
// "Pending" = past scheduled date AND still within (effective_date + tolerance),
// in any active workflow state (Pending Clearance / Scheduled / Awaiting Executor
// / Pending / In Progress / Pending Review / Pending Approval / Rejected).
// The Initiator uses this list to assign or re-assign an executor without
// invoking the PNC / Exception flow (that's reserved for Expired).
const PENDING_STATUSES = [
  'Pending Clearance','Scheduled','Awaiting Executor','Pending',
  'In Progress','Pending Review','Pending Approval','Rejected'
];

function pendingReasonFor(a) {
  switch (a.status) {
    case 'Scheduled':         return 'Clearance not initiated';
    case 'Pending Clearance': return 'Awaiting clearance from production';
    case 'Awaiting Executor': return 'Executor not assigned';
    case 'Pending':           return a.assignee_id ? 'Assigned — execution not started' : 'Awaiting executor';
    case 'In Progress':       return 'Execution in progress';
    case 'Pending Review':    return 'Submitted — awaiting reviewer';
    case 'Pending Approval':  return 'Reviewed — awaiting approver';
    case 'Rejected':          return 'Rejected — awaiting re-execution';
    default:                  return a.status || '—';
  }
}

app.get('/api/assignments/pending', requireAuth, (req, res) => {
  // First flip anything past-tolerance to Expired so it doesn't pollute Pending.
  const flipped = markExpiredAssignments();
  const todayStr = new Date().toISOString().slice(0, 10);
  const placeholders = PENDING_STATUSES.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT ca.assignment_id, ca.checklist_id, ca.target_id,
           ca.assignee_id, ca.reviewer_id, ca.approver_id,
           ca.frequency_id, ca.effective_date, ca.due_date, ca.status,
           ca.rejection_reason, ca.reviewed_at, ca.submitted_at,
           cl.name AS checklist_name, cl.version AS checklist_version,
           f.name AS frequency, f.days AS frequency_days, f.tolerance_days,
           e.name AS equipment_name, e.make, e.model, e.capacity,
           a.area_id, a.name AS area_name,
           l.location_id, l.description AS location_name,
           b.block_id, b.name AS block_name,
           p.plant_id, p.unit_number, p.name AS plant_name,
           u.name AS assignee_name,
           rv.name AS reviewer_name, ap.name AS approver_name
    FROM checklist_assignments ca
    LEFT JOIN checklists cl ON cl.id = ca.checklist_id
    LEFT JOIN frequencies f ON f.id = ca.frequency_id
    LEFT JOIN equipment e   ON e.equipment_id = ca.target_id
    LEFT JOIN areas a       ON a.area_id      = e.area_id
    LEFT JOIN locations l   ON l.location_id  = a.location_id
    LEFT JOIN blocks b      ON b.block_id     = l.block_id
    LEFT JOIN plants p      ON p.plant_id     = b.plant_id
    LEFT JOIN users u   ON u.id   = ca.assignee_id
    LEFT JOIN users rv  ON rv.id  = ca.reviewer_id
    LEFT JOIN users ap  ON ap.id  = ca.approver_id
    WHERE ca.target_type='equipment'
      AND ca.status IN (${placeholders})
      AND (
        ca.effective_date IS NULL
        OR date(ca.effective_date) <= date(?)
      )
    ORDER BY date(ca.effective_date) ASC, ca.id ASC
  `).all(...PENDING_STATUSES, todayStr);
  rows.forEach(r => {
    r.equipment_description = [r.make, r.model, r.capacity].filter(Boolean).join(' / ') || r.equipment_name || '—';
    r.pending_reason = pendingReasonFor(r);
  });
  res.json({ flipped, rows });
});

// Assign / re-assign a pending PM to an executor. No PNC/Exception required —
// the PM is still within the tolerance window. Re-assigning to a different
// executor RESETS execution state so the new person starts fresh.
app.put('/api/assignments/:assignment_id/assign-pending', requireAuth, requireActivity('assign_checklist'), (req, res) => {
  const { assignee_id } = req.body || {};
  if (!assignee_id) return res.status(400).json({ error: 'assignee_id required' });
  const a = db.prepare(`
    SELECT ca.*, u.name AS assignee_name
    FROM checklist_assignments ca
    LEFT JOIN users u ON u.id = ca.assignee_id
    WHERE assignment_id=?
  `).get(req.params.assignment_id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  if (!PENDING_STATUSES.includes(a.status)) {
    return res.status(409).json({ error: `Cannot assign from status "${a.status}". The assignment must be in a pending workflow state.` });
  }
  const u = db.prepare('SELECT id, name FROM users WHERE id=? AND status="Active"').get(Number(assignee_id));
  if (!u) return res.status(400).json({ error: 'Unknown or inactive executor' });
  if (a.reviewer_id === u.id || a.approver_id === u.id) {
    return res.status(400).json({ error: 'Executor cannot also be the assigned reviewer or approver.' });
  }

  const isReassign = a.assignee_id && a.assignee_id !== u.id;
  if (isReassign) {
    // Re-assign to a different person — wipe in-flight execution state so the
    // new executor doesn't inherit someone else's partial responses.
    db.prepare(`UPDATE checklist_assignments SET
        status='Pending',
        assignee_id=?,
        response_data=NULL,
        executor_sig=NULL, reviewer_sig=NULL, approver_sig=NULL,
        submitted_at=NULL, reviewed_at=NULL, started_at=NULL,
        rejection_reason=NULL
      WHERE assignment_id=?`).run(u.id, req.params.assignment_id);
  } else {
    // First-time assignment (or no-op same person) — just put it on the
    // executor's plate without touching prior data.
    db.prepare(`UPDATE checklist_assignments SET
        status='Pending',
        assignee_id=?
      WHERE assignment_id=?`).run(u.id, req.params.assignment_id);
  }
  notify(u.id, 'PM assignment received',
    `${req.params.assignment_id} (${a.target_id || ''}) ${isReassign ? 're-assigned to you' : 'assigned to you'} from Pending Equipment list.`,
    'assignment', `/assignments/${req.params.assignment_id}`);
  audit(req.user, isReassign ? 'REASSIGN_PENDING' : 'ASSIGN_PENDING', 'Assignment', req.params.assignment_id,
    `${isReassign?'Re-assigned':'Assigned'} pending PM to ${u.name}${a.assignee_name?` (was ${a.assignee_name})`:''} from status "${a.status}"`);
  res.json({ ok: true });
});

app.get('/api/assignments/expired', requireAuth, (req, res) => {
  const flipped = markExpiredAssignments();
  const rows = db.prepare(`
    SELECT ca.assignment_id, ca.checklist_id, ca.target_id,
           ca.assignee_id, ca.reviewer_id, ca.approver_id,
           ca.frequency_id, ca.effective_date, ca.due_date, ca.status,
           ca.pnc_number, ca.exception_number, ca.exception_description,
           ca.expired_at, ca.reassigned_at,
           cl.name AS checklist_name, cl.version AS checklist_version,
           f.name AS frequency, f.days AS frequency_days, f.tolerance_days,
           e.name AS equipment_name, e.make, e.model, e.capacity,
           a.area_id, a.name AS area_name,
           l.location_id, l.description AS location_name,
           b.block_id, b.name AS block_name,
           p.plant_id, p.unit_number, p.name AS plant_name,
           u.name AS assignee_name,
           rv.name AS reviewer_name, ap.name AS approver_name
    FROM checklist_assignments ca
    LEFT JOIN checklists cl ON cl.id = ca.checklist_id
    LEFT JOIN frequencies f ON f.id = ca.frequency_id
    LEFT JOIN equipment e   ON e.equipment_id = ca.target_id
    LEFT JOIN areas a       ON a.area_id      = e.area_id
    LEFT JOIN locations l   ON l.location_id  = a.location_id
    LEFT JOIN blocks b      ON b.block_id     = l.block_id
    LEFT JOIN plants p      ON p.plant_id     = b.plant_id
    LEFT JOIN users u   ON u.id   = ca.assignee_id
    LEFT JOIN users rv  ON rv.id  = ca.reviewer_id
    LEFT JOIN users ap  ON ap.id  = ca.approver_id
    WHERE ca.target_type='equipment' AND ca.status='Expired'
    ORDER BY date(ca.due_date) ASC, ca.id ASC
  `).all();
  // Synthesised "equipment_description"
  rows.forEach(r => {
    r.equipment_description = [r.make, r.model, r.capacity].filter(Boolean).join(' / ') || r.equipment_name || '—';
  });
  res.json({ flipped, rows });
});

// Withdraw an in-flight checklist assignment from a piece of equipment.
// Used when the checklist itself needs revision (a new version is being prepared)
// or the assignment was set up incorrectly. Allowed at any pre-Completed stage.
// Requires remarks + e-signature for GMP traceability.
app.put('/api/assignments/:assignment_id/withdraw', requireAuth, requireActivity('assign_checklist'), requireESignature, (req, res) => {
  const { remarks } = req.body || {};
  if (!remarks || !remarks.trim()) return res.status(400).json({ error: 'Remarks are required to withdraw an assignment' });
  const a = db.prepare('SELECT * FROM checklist_assignments WHERE assignment_id=?').get(req.params.assignment_id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  if (a.status === 'Completed' || a.status === 'Withdrawn') {
    return res.status(409).json({ error: `Cannot withdraw — assignment is "${a.status}".` });
  }
  db.prepare(`UPDATE checklist_assignments
              SET status='Withdrawn', withdrawn_at=datetime('now'), withdrawn_by=?, withdraw_remarks=?
              WHERE assignment_id=?`)
    .run(req.user.id, remarks, req.params.assignment_id);

  // Notify everyone in the workflow chain so they don't keep trying to act on it.
  const notifyList = [a.assignee_id, a.reviewer_id, a.approver_id, a.clearance_user_id, a.assigned_by]
    .filter(x => x && x !== req.user.id);
  const seen = new Set();
  for (const uid of notifyList) {
    if (seen.has(uid)) continue;
    seen.add(uid);
    notify(uid, 'PM assignment withdrawn',
      `${a.assignment_id} (target: ${a.target_id || '—'}) was withdrawn: ${remarks}`,
      'assignment_withdrawn', `/assignments/${a.assignment_id}`);
  }
  audit(req.user, 'WITHDRAW', 'Assignment', a.assignment_id,
    `Withdrew assignment for ${a.target_type || 'target'} ${a.target_id || ''} (checklist id ${a.checklist_id}). Reason: ${remarks}`);
  res.json({ ok: true });
});

app.put('/api/assignments/:assignment_id/reassign', requireAuth, requireActivity('assign_checklist'), requireESignature, (req, res) => {
  const { assignee_id, reviewer_id, approver_id, pnc_number, exception_number, exception_description, effective_date, due_date } = req.body || {};
  if (!pnc_number || !pnc_number.trim()) return res.status(400).json({ error: 'PNC Number is required to re-assign an expired PM' });
  if (!exception_number || !exception_number.trim()) return res.status(400).json({ error: 'Exception Number is required' });
  if (!exception_description || !exception_description.trim()) return res.status(400).json({ error: 'Other Description is required' });
  if (!assignee_id) return res.status(400).json({ error: 'Executor (assignee_id) is required' });
  const a = db.prepare('SELECT * FROM checklist_assignments WHERE assignment_id=?').get(req.params.assignment_id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  if (a.status !== 'Expired') return res.status(409).json({ error: `Cannot re-assign from status "${a.status}". Only Expired assignments are re-assignable.` });

  const u = db.prepare('SELECT id, name FROM users WHERE id=?').get(assignee_id);
  if (!u) return res.status(400).json({ error: 'Unknown assignee_id' });

  // Validate reviewer + approver. Default to the originals if not provided.
  const finalRev = reviewer_id || a.reviewer_id;
  const finalApp = approver_id || a.approver_id;
  if (!finalRev || !finalApp) return res.status(400).json({ error: 'Reviewer and Approver must be set' });
  if (finalRev === finalApp) return res.status(400).json({ error: 'Reviewer and Approver must be different users' });
  if (finalRev === u.id || finalApp === u.id) return res.status(400).json({ error: 'Executor cannot also be their own reviewer or approver' });

  db.prepare(`UPDATE checklist_assignments SET
      status='Pending',
      assignee_id=?,
      reviewer_id=?,
      approver_id=?,
      pnc_number=?,
      exception_number=?,
      exception_description=?,
      effective_date=COALESCE(?,effective_date),
      due_date=COALESCE(?,due_date),
      reassigned_at=datetime('now'),
      reassigned_by=?,
      -- clear stale execution state from the previous run
      response_data=NULL,
      executor_sig=NULL, reviewer_sig=NULL, approver_sig=NULL,
      submitted_at=NULL, reviewed_at=NULL, approved_at=NULL,
      started_at=NULL, completed_at=NULL,
      rejection_reason=NULL
    WHERE assignment_id=?`)
    .run(u.id, finalRev, finalApp,
         pnc_number.trim(), exception_number.trim(), exception_description.trim(),
         effective_date || null, due_date || null,
         req.user.id, req.params.assignment_id);

  notify(u.id,
    'Expired PM re-assigned to you',
    `${req.params.assignment_id} re-assigned by ${req.user.name}. Exception ${exception_number.trim()} (PNC ${pnc_number.trim()}).`,
    'assignment',
    `/assignments/${req.params.assignment_id}`);

  audit(req.user, 'REASSIGN', 'Assignment', req.params.assignment_id,
    `Re-assigned expired PM to ${u.name} (PNC ${pnc_number.trim()}, Exception ${exception_number.trim()})`);
  res.json({ ok: true });
});

// =============================================================
// NOTIFICATIONS
// =============================================================
app.get('/api/notifications', requireAuth, (req, res) => {
  const { unread } = req.query;
  const where = ['user_id = ?'];
  const args = [req.user.id];
  if (unread === '1') where.push('is_read = 0');
  const rows = db.prepare(`
    SELECT id, title, message, kind, link, is_read, created_at
    FROM notifications
    WHERE ${where.join(' AND ')}
    ORDER BY id DESC
    LIMIT 100
  `).all(...args);
  res.json(rows);
});

app.get('/api/notifications/unread-count', requireAuth, (req, res) => {
  const n = db.prepare('SELECT COUNT(*) n FROM notifications WHERE user_id=? AND is_read=0').get(req.user.id).n;
  res.json({ count: n });
});

app.put('/api/notifications/:id/read', requireAuth, (req, res) => {
  db.prepare('UPDATE notifications SET is_read=1 WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

app.put('/api/notifications/read-all', requireAuth, (req, res) => {
  db.prepare('UPDATE notifications SET is_read=1 WHERE user_id=? AND is_read=0').run(req.user.id);
  res.json({ ok: true });
});

// =============================================================
// STATIC
// =============================================================
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// 404 for unknown API paths only
app.use('/api', (req, res) => res.status(404).json({ error: 'API route not found' }));

// JSON error handler — any thrown / next(err) in /api routes ends up here.
// Without this, Express renders an HTML stack trace which the client parses as "HTTP 500".
app.use('/api', (err, req, res, next) => {
  console.error(`[api error] ${req.method} ${req.originalUrl}: ${err.message}`);
  if (err.stack) console.error(err.stack);
  if (res.headersSent) return next(err);
  const msg = err && err.message ? err.message : 'Internal server error';
  res.status(500).json({ error: msg });
});

app.listen(PORT, '0.0.0.0', () => {
  const env = process.env.NODE_ENV || 'development';
  const isPackaged = typeof process.pkg !== 'undefined';
  console.log('==========================================');
  console.log(`  PMMS server listening on port ${PORT} (${env})`);
  console.log(`  Open http://localhost:${PORT} in your browser`);
  if (env !== 'production') {
    console.log('  Default login:  admin / admin123');
  }
  // Show the LAN IPs so testers on the office network can connect.
  try {
    const nets = require('os').networkInterfaces();
    const lanIps = [];
    for (const name of Object.keys(nets)) {
      for (const iface of nets[name] || []) {
        if (iface.family === 'IPv4' && !iface.internal) lanIps.push(iface.address);
      }
    }

    if (lanIps.length) {
      console.log('  Office LAN URL:');
      for (const ip of lanIps) console.log(`     http://${ip}:${PORT}`);
    }
  } catch (e) {}
  console.log('==========================================');

  // When running as a packaged .exe, auto-launch the default browser so the user
  // doesn't have to type the URL by hand.
  if (isPackaged && process.platform === 'win32' && process.env.PMMS_NO_BROWSER !== '1') {
    try {
      require('child_process').exec(`start "" "http://localhost:${PORT}"`);
    } catch (e) { /* ignore */ }
  }
});
