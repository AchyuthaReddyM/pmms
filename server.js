// server.js — PMMS API + static server
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { db, hashPassword, verifyPassword } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust the platform's load balancer (Render, Railway, Fly etc. terminate TLS upstream).
// Lets req.ip and secure cookies work correctly when we add them.
app.set('trust proxy', 1);

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

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

function notify(userId, title, message, kind = 'info', link = null) {
  db.prepare('INSERT INTO notifications(user_id,title,message,kind,link) VALUES (?,?,?,?,?)')
    .run(userId, title, message || '', kind, link);
}

// =============================================================
// AUTH
// =============================================================
app.post('/api/auth/login', (req, res) => {
  const { user_id, password } = req.body || {};
  if (!user_id || !password) return res.status(400).json({ error: 'user_id and password required' });
  const u = db.prepare(`
    SELECT u.*, r.name AS role_name, r.permissions_json, d.name AS dept_name
    FROM users u
    LEFT JOIN roles r ON r.id = u.role_id
    LEFT JOIN departments d ON d.id = u.department_id
    WHERE u.user_id = ?
  `).get(user_id);
  if (!u) return res.status(401).json({ error: 'Invalid credentials' });
  if (u.status !== 'Active') return res.status(403).json({ error: 'User is locked or inactive' });
  if (!verifyPassword(password, u.password_hash)) return res.status(401).json({ error: 'Invalid credentials' });

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
  const total      = db.prepare('SELECT COUNT(*) n FROM pm_schedules').get().n;
  const completed  = db.prepare("SELECT COUNT(*) n FROM pm_schedules WHERE status='Completed'").get().n;
  const overdue    = db.prepare("SELECT COUNT(*) n FROM pm_schedules WHERE status IN ('Overdue','Expired')").get().n;
  const pending    = db.prepare("SELECT COUNT(*) n FROM pm_schedules WHERE status IN ('Pending','Approved','Assigned','In Progress')").get().n;
  const compliance = total === 0 ? 0 : Math.round((completed / total) * 1000) / 10;

  const monthStart = new Date(); monthStart.setDate(1);
  const mtd = db.prepare("SELECT COUNT(*) n FROM pm_schedules WHERE status='Completed' AND completed_at >= ?").get(monthStart.toISOString().slice(0,10)).n;

  const openBd = db.prepare("SELECT COUNT(*) n FROM breakdowns WHERE status NOT IN ('Closed','Resolved')").get().n;

  res.json({ compliance, overdue, pending, completed_mtd: mtd, total_pms: total, open_breakdowns: openBd });
});

app.get('/api/dashboard/compliance-by-dept', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT department,
      COUNT(*) AS planned,
      SUM(CASE WHEN status='Completed' THEN 1 ELSE 0 END) AS done
    FROM pm_schedules
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
app.post('/api/plants', requireAuth, requireRole('System Administrator'), (req, res) => {
  const { name, location, unit_number, version } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Name required' });
  const plant_id = nextId('PL-', 'plants', 'plant_id');
  db.prepare('INSERT INTO plants(plant_id,unit_number,name,location,version) VALUES (?,?,?,?,?)')
    .run(plant_id, unit_number || null, name, location || '', version || null);
  audit(req.user, 'CREATE', 'Plant', plant_id, `Plant "${name}"${unit_number?` (${unit_number})`:''} at ${location || '-'}`);
  res.json(db.prepare('SELECT * FROM plants WHERE plant_id=?').get(plant_id));
});
app.put('/api/plants/:plant_id', requireAuth, requireRole('System Administrator'), (req, res) => {
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
app.post('/api/blocks', requireAuth, requireRole('System Administrator'), (req, res) => {
  const { plant_id, name } = req.body;
  if (!plant_id || !name) return res.status(400).json({ error: 'plant_id and name required' });
  const block_id = nextId('BLK-', 'blocks', 'block_id');
  db.prepare('INSERT INTO blocks(block_id,plant_id,name) VALUES (?,?,?)').run(block_id, plant_id, name);
  audit(req.user, 'CREATE', 'Block', block_id, `Block "${name}" under ${plant_id}`);
  res.json(db.prepare('SELECT * FROM blocks WHERE block_id=?').get(block_id));
});

// FORMULATIONS
app.get('/api/formulations', requireAuth, (req,res) => res.json(db.prepare('SELECT * FROM formulations ORDER BY formulation_id').all()));
app.post('/api/formulations', requireAuth, requireActivity('manage_plants'), (req, res) => {
  const { name, department } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const formulation_id = nextId('FRM-', 'formulations', 'formulation_id');
  db.prepare('INSERT INTO formulations(formulation_id,name,department) VALUES (?,?,?)').run(formulation_id, name, department || '');
  audit(req.user, 'CREATE', 'Formulation', formulation_id, `"${name}" under "${department || '—'}"`);
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
  const { block_id, description, formulation_id } = req.body || {};
  if (!block_id) return res.status(400).json({ error: 'block_id required' });
  const block = db.prepare('SELECT name FROM blocks WHERE block_id=?').get(block_id);
  if (!block) return res.status(400).json({ error: 'Unknown block_id' });
  let formName = null;
  if (formulation_id) {
    const f = db.prepare('SELECT name FROM formulations WHERE id=?').get(formulation_id);
    if (!f) return res.status(400).json({ error: 'Unknown formulation_id' });
    formName = f.name;
  }
  const location_id = nextId('LOC-', 'locations', 'location_id');
  db.prepare('INSERT INTO locations(location_id,block_id,description,formulation_id) VALUES (?,?,?,?)')
    .run(location_id, block_id, description || '', formulation_id || null);
  audit(req.user, 'CREATE', 'Location', location_id, `"${description || location_id}" under block ${block_id} (${block.name})${formName?` [${formName}]`:''}`);
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
  const { location_id, name, area_type } = req.body || {};
  const areaName = name || area_type;
  if (!location_id) return res.status(400).json({ error: 'location_id required' });
  const loc = db.prepare('SELECT description FROM locations WHERE location_id=?').get(location_id);
  if (!loc) return res.status(400).json({ error: 'Unknown location_id' });
  const area_id = nextId('AR-', 'areas', 'area_id');
  db.prepare('INSERT INTO areas(area_id,location_id,name) VALUES (?,?,?)').run(area_id, location_id, areaName || '');
  audit(req.user, 'CREATE', 'Area', area_id, `"${areaName || '—'}" under location ${location_id} (${loc.description})`);
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
app.post('/api/equipment', requireAuth, requireRole('System Administrator','Engineering'), (req, res) => {
  let { name, make, model, make_model, serial, capacity, area_id, status } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Name required' });
  // Backwards compat: if legacy make_model passed, split into make/model.
  if (!make && !model && make_model) {
    const parts = String(make_model).split('/').map(s => s.trim());
    make = parts[0] || ''; model = parts.slice(1).join(' / ');
  }
  const eid = nextId('EQ-', 'equipment', 'equipment_id');
  db.prepare(`INSERT INTO equipment(equipment_id,name,make,model,serial,capacity,area_id,status,qr_code)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(eid, name, make||'', model||'', serial||'', capacity||'', area_id||'', status||'Active', `QR:${eid}`);
  audit(req.user, 'CREATE', 'Equipment', eid, `Registered: ${name} — ${make||'—'} ${model||''}${serial?` (SN ${serial})`:''}${area_id?` @ ${area_id}`:''}`);
  res.json(db.prepare('SELECT * FROM equipment WHERE equipment_id=?').get(eid));
});
app.put('/api/equipment/:equipment_id', requireAuth, requireRole('System Administrator','Engineering'), (req, res) => {
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
  const { name, department_id } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const exists = db.prepare('SELECT 1 FROM checklist_groups WHERE name=?').get(name);
  if (exists) return res.status(409).json({ error: 'group already exists' });
  let dName = null;
  if (department_id) {
    const d = db.prepare('SELECT name FROM departments WHERE id=?').get(department_id);
    if (!d) return res.status(400).json({ error: 'Unknown department_id' });
    dName = d.name;
  }
  const r = db.prepare('INSERT INTO checklist_groups(name,department_id,department) VALUES (?,?,?)').run(name, department_id || null, dName);
  audit(req.user, 'CREATE', 'ChecklistGroup', r.lastInsertRowid, `"${name}"${dName ? ' under ' + dName : ''}`);
  res.json({ id: r.lastInsertRowid, name, department_id, department: dName });
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
  const where = status ? 'WHERE s.status = ?' : '';
  const args = status ? [status] : [];
  const rows = db.prepare(`
    SELECT s.pm_id, s.equipment_id, e.name AS equipment_name,
      s.category, s.frequency, s.scheduled_date, s.status, s.department,
      tech.name AS technician_name
    FROM pm_schedules s
    LEFT JOIN equipment e ON e.equipment_id = s.equipment_id
    LEFT JOIN users tech  ON tech.id = s.technician_id
    ${where}
    ORDER BY s.scheduled_date DESC
  `).all(...args);
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

app.post('/api/pm', requireAuth, requireRole('System Administrator','Engineering','Approver','QA'), (req, res) => {
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
app.put('/api/pm/:pm_id/approve', requireAuth, requireRole('System Administrator','Approver','Engineering'), (req, res) => {
  const s = db.prepare('SELECT * FROM pm_schedules WHERE pm_id=?').get(req.params.pm_id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  if (s.status !== 'Pending') return res.status(409).json({ error: `Cannot approve from status ${s.status}` });
  db.prepare('UPDATE pm_schedules SET status=?, approver_sig=? WHERE pm_id=?')
    .run('Approved', req.user.name + ' @ ' + new Date().toISOString(), req.params.pm_id);
  audit(req.user, 'APPROVE', 'PM', req.params.pm_id, 'PM approved for execution');
  res.json(loadSchedule(req.params.pm_id));
});

// Assign technician
app.put('/api/pm/:pm_id/assign', requireAuth, requireRole('System Administrator','Engineering','Approver'), (req, res) => {
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
  const pm = db.prepare(`SELECT pm_id, scheduled_date, frequency, category, status, completed_at FROM pm_schedules WHERE equipment_id=? ORDER BY scheduled_date DESC`).all(req.params.equipment_id);
  const bd = db.prepare(`SELECT bd_id, reported_at, severity, status, description, closed_at FROM breakdowns WHERE equipment_id=? ORDER BY reported_at DESC`).all(req.params.equipment_id);
  res.json({ pm, breakdowns: bd });
});

app.get('/api/reports/overdue', requireAuth, (req, res) => {
  res.json(db.prepare(`
    SELECT s.pm_id, s.equipment_id, e.name AS equipment_name, s.scheduled_date, s.frequency, s.status, s.department
    FROM pm_schedules s LEFT JOIN equipment e ON e.equipment_id = s.equipment_id
    WHERE s.status IN ('Overdue','Expired')
    ORDER BY s.scheduled_date
  `).all());
});

// =============================================================
// CALENDAR
// =============================================================
app.get('/api/calendar', requireAuth, (req, res) => {
  const { year, month } = req.query; // month is 1-12
  let rows;
  if (year && month) {
    const yyyy = String(year).padStart(4,'0');
    const mm = String(month).padStart(2,'0');
    rows = db.prepare(`
      SELECT s.pm_id, s.equipment_id, e.name AS equipment_name, s.frequency, s.category, s.scheduled_date, s.status
      FROM pm_schedules s LEFT JOIN equipment e ON e.equipment_id = s.equipment_id
      WHERE strftime('%Y', s.scheduled_date)=? AND strftime('%m', s.scheduled_date)=?
      ORDER BY s.scheduled_date
    `).all(yyyy, mm);
  } else {
    rows = db.prepare(`
      SELECT s.pm_id, s.equipment_id, e.name AS equipment_name, s.frequency, s.category, s.scheduled_date, s.status
      FROM pm_schedules s LEFT JOIN equipment e ON e.equipment_id = s.equipment_id
      ORDER BY s.scheduled_date
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
  const { name, days, tolerance_days } = req.body || {};
  if (!name || days === undefined) return res.status(400).json({ error: 'name and days required' });
  const exists = db.prepare('SELECT 1 FROM frequencies WHERE name=?').get(name);
  if (exists) return res.status(409).json({ error: 'frequency name already exists' });
  const r = db.prepare('INSERT INTO frequencies(name,days,tolerance_days) VALUES (?,?,?)').run(name, parseInt(days,10), parseInt(tolerance_days || 0,10));
  audit(req.user, 'CREATE', 'Frequency', r.lastInsertRowid, `Created "${name}" (${days}d)`);
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
  const { name, description } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const exists = db.prepare('SELECT 1 FROM pm_categories WHERE name=?').get(name);
  if (exists) return res.status(409).json({ error: 'category already exists' });
  const r = db.prepare('INSERT INTO pm_categories(name,description) VALUES (?,?)').run(name, description || '');
  audit(req.user, 'CREATE', 'PMCategory', r.lastInsertRowid, `Created "${name}"`);
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
  const { code, name, description, group_id, category_id, version, sections, required_fields, frequency_ids } = req.body || {};
  const err = validateChecklistCore({ code, name });
  if (err) return res.status(400).json({ error: err });
  if (!group_id) return res.status(400).json({ error: 'PM Checklist Group is required' });
  const grp = db.prepare('SELECT id FROM checklist_groups WHERE id=?').get(group_id);
  if (!grp) return res.status(400).json({ error: 'Unknown checklist group' });
  if (db.prepare('SELECT 1 FROM checklists WHERE code=?').get(code)) {
    return res.status(409).json({ error: `Checklist ID "${code}" already exists` });
  }
  // Sanitize required_fields to known keys
  const reqd = Array.isArray(required_fields)
    ? required_fields.filter(k => REQUIRED_FIELD_KEYS.includes(k))
    : [];
  const r = db.prepare(`INSERT INTO checklists(code,name,description,group_id,category_id,version,status,required_fields_json,created_by)
                        VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(code, name, description || '', group_id || null, category_id || null, version || 'v1.0', 'Draft', JSON.stringify(reqd), req.user.id);
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
  const { code, name, description, group_id, category_id, version, status, sections, required_fields, frequency_ids } = req.body || {};
  const cl = db.prepare('SELECT * FROM checklists WHERE id=?').get(req.params.id);
  if (!cl) return res.status(404).json({ error: 'Not found' });
  // Only allow content edits while in Draft / Rejected. Approved checklists are locked.
  if (!['Draft','Rejected'].includes(cl.status) && (sections || name || description || code)) {
    return res.status(409).json({ error: `Cannot edit checklist in status "${cl.status}". Bump the version or push back to Draft.` });
  }
  if (code !== undefined && code !== null && code !== '' && code !== cl.code) {
    if (!/^[A-Za-z0-9_\-]{2,50}$/.test(code)) return res.status(400).json({ error: 'Checklist ID must be 2-50 alphanumeric characters' });
    if (db.prepare('SELECT 1 FROM checklists WHERE code=? AND id!=?').get(code, req.params.id)) {
      return res.status(409).json({ error: `Checklist ID "${code}" already exists` });
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
      version=COALESCE(?,version),
      status=COALESCE(?,status),
      required_fields_json=COALESCE(?,required_fields_json)
    WHERE id=?`).run(code, name, description, group_id, category_id, version, status, reqdJson, req.params.id);

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

app.put('/api/checklists/:id/review', requireAuth, requireActivity('review_checklist'), (req, res) => {
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

app.put('/api/checklists/:id/approve', requireAuth, requireActivity('approve_checklist'), (req, res) => {
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
    notify(cl.created_by,
      'Checklist approved',
      `${cl.name} (${cl.version}) is now approved and available for assignment.`,
      'checklist_approved',
      `/checklists/${req.params.id}`);
    if (cl.reviewer_id && cl.reviewer_id !== req.user.id) {
      notify(cl.reviewer_id, 'Checklist approved', `${cl.name} (${cl.version}) has been approved.`, 'checklist_approved', `/checklists/${req.params.id}`);
    }
    audit(req.user, 'APPROVE', 'Checklist', req.params.id, `Approved "${cl.name}" (${cl.version}) — available for assignment`);
  }
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
  const { mine, status, inbox } = req.query;
  // "inbox=1" means: anything where the user is executor / reviewer / approver
  const where = [];
  const args = [];
  if (mine === '1')  { where.push('ca.assignee_id = ?'); args.push(req.user.id); }
  if (inbox === '1') { where.push('(ca.assignee_id = ? OR ca.reviewer_id = ? OR ca.approver_id = ?)'); args.push(req.user.id, req.user.id, req.user.id); }
  if (status)        { where.push('ca.status = ?');     args.push(status); }
  const sql = `
    SELECT ca.id, ca.assignment_id, ca.checklist_id, ca.target_type, ca.target_id,
           ca.assignee_id, ca.reviewer_id, ca.approver_id, ca.frequency_id,
           ca.effective_date, ca.due_date,
           ca.status, ca.notes, ca.assigned_at, ca.started_at,
           ca.submitted_at, ca.reviewed_at, ca.approved_at, ca.completed_at,
           ca.rejection_reason,
           cl.name AS checklist_name, cl.version AS checklist_version,
           u.name  AS assignee_name, u.user_id  AS assignee_user_id,
           rv.name AS reviewer_name, rv.user_id AS reviewer_user_id,
           ap.name AS approver_name, ap.user_id AS approver_user_id,
           b.name  AS assigned_by_name,
           f.name  AS frequency,
           CASE ca.target_type
             WHEN 'equipment' THEN (SELECT name FROM equipment WHERE equipment_id = ca.target_id)
             WHEN 'area'      THEN (SELECT area_type FROM areas WHERE area_id = ca.target_id)
             ELSE NULL
           END AS target_label
    FROM checklist_assignments ca
    LEFT JOIN checklists cl ON cl.id = ca.checklist_id
    LEFT JOIN users u   ON u.id   = ca.assignee_id
    LEFT JOIN users rv  ON rv.id  = ca.reviewer_id
    LEFT JOIN users ap  ON ap.id  = ca.approver_id
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
           b.name  AS assigned_by_name, f.name AS frequency,
           CASE ca.target_type
             WHEN 'equipment' THEN (SELECT name FROM equipment WHERE equipment_id = ca.target_id)
             WHEN 'area'      THEN (SELECT area_type FROM areas WHERE area_id = ca.target_id)
             ELSE NULL
           END AS target_label
    FROM checklist_assignments ca
    LEFT JOIN checklists cl ON cl.id = ca.checklist_id
    LEFT JOIN users u   ON u.id   = ca.assignee_id
    LEFT JOIN users rv  ON rv.id  = ca.reviewer_id
    LEFT JOIN users ap  ON ap.id  = ca.approver_id
    LEFT JOIN users b   ON b.id   = ca.assigned_by
    LEFT JOIN frequencies f ON f.id = ca.frequency_id
    WHERE ca.assignment_id = ?`).get(req.params.assignment_id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.response_data) { try { row.response_data = JSON.parse(row.response_data); } catch(e) {} }
  row.checklist = loadChecklistFull(row.checklist_id);
  res.json(row);
});

app.post('/api/assignments', requireAuth, requireActivity('assign_checklist'), (req, res) => {
  const { checklist_id, target_type, target_id, assignee_id, reviewer_id, approver_id, frequency_id, effective_date, due_date, notes } = req.body || {};
  if (!checklist_id || !target_type || !target_id) {
    return res.status(400).json({ error: 'checklist_id, target_type and target_id required' });
  }
  if (!assignee_id) return res.status(400).json({ error: 'assignee_id (executor) required' });
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
    const ar = db.prepare('SELECT area_id, area_type FROM areas WHERE area_id=?').get(target_id);
    if (!ar) return res.status(400).json({ error: 'Unknown area_id' });
    targetName = `${ar.area_id} (${ar.area_type})`;
  }
  const assignee = db.prepare('SELECT id, name FROM users WHERE id=?').get(assignee_id);
  if (!assignee) return res.status(400).json({ error: 'Unknown assignee_id' });

  // Reviewer/approver: default to checklist's template reviewer/approver if not given.
  const finalReviewer = reviewer_id || cl.template_reviewer;
  const finalApprover = approver_id || cl.template_approver;
  if (!finalReviewer || !finalApprover) {
    return res.status(400).json({ error: 'reviewer_id and approver_id are required (checklist has no defaults)' });
  }
  if (finalReviewer === finalApprover) {
    return res.status(400).json({ error: 'Reviewer and approver must be different users' });
  }
  if (finalReviewer === assignee.id || finalApprover === assignee.id) {
    return res.status(400).json({ error: 'Executor cannot also be their own reviewer or approver' });
  }
  const rv = db.prepare('SELECT id, name FROM users WHERE id=?').get(finalReviewer);
  const ap = db.prepare('SELECT id, name FROM users WHERE id=?').get(finalApprover);
  if (!rv || !ap) return res.status(400).json({ error: 'Unknown reviewer/approver' });

  const aid = nextAssignmentId();
  db.prepare(`INSERT INTO checklist_assignments(assignment_id,checklist_id,target_type,target_id,assignee_id,reviewer_id,approver_id,frequency_id,effective_date,due_date,notes,status,assigned_by)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(aid, checklist_id, target_type, target_id, assignee.id, rv.id, ap.id, frequency_id || null, effective_date || null, due_date || null, notes || '', 'Pending', req.user.id);

  notify(assignee.id,
    'New PM activity assigned',
    `${cl.name} on ${target_type} ${targetName}${due_date ? ' — due ' + due_date : ''}. Assigned by ${req.user.name}.`,
    'assignment',
    `/assignments/${aid}`);

  audit(req.user, 'ASSIGN', 'Checklist', aid,
    `Assigned "${cl.name}" to ${target_type} ${targetName} — Executor: ${assignee.name}, Reviewer: ${rv.name}, Approver: ${ap.name}`);
  res.json(db.prepare('SELECT * FROM checklist_assignments WHERE assignment_id=?').get(aid));
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
app.put('/api/assignments/:assignment_id/review', requireAuth, requireActivity('review_pm','review_checklist'), (req, res) => {
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
app.put('/api/assignments/:assignment_id/approve', requireAuth, requireActivity('approve_pm','approve_checklist'), (req, res) => {
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

app.listen(PORT, '0.0.0.0', () => {
  const env = process.env.NODE_ENV || 'development';
  console.log('==========================================');
  console.log(`  PMMS server listening on port ${PORT} (${env})`);
  if (env !== 'production') {
    console.log(`  Open http://localhost:${PORT} in your browser`);
    console.log('  Default login:  admin / admin123');
  }
  console.log('==========================================');
});
