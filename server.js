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
    SELECT s.token, s.expires_at, u.id, u.user_id, u.name, u.role, u.department, u.email
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > datetime('now')
  `).get(token);
  return row || null;
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

// =============================================================
// AUTH
// =============================================================
app.post('/api/auth/login', (req, res) => {
  const { user_id, password } = req.body || {};
  if (!user_id || !password) return res.status(400).json({ error: 'user_id and password required' });
  const u = db.prepare('SELECT * FROM users WHERE user_id = ?').get(user_id);
  if (!u) return res.status(401).json({ error: 'Invalid credentials' });
  if (u.status !== 'Active') return res.status(403).json({ error: 'User is locked or inactive' });
  if (!verifyPassword(password, u.password_hash)) return res.status(401).json({ error: 'Invalid credentials' });

  const token = crypto.randomBytes(24).toString('hex');
  const expires = new Date(Date.now() + 8 * 3600 * 1000).toISOString();
  db.prepare('INSERT INTO sessions(token,user_id,expires_at) VALUES (?,?,?)').run(token, u.id, expires);
  db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(u.id);

  audit({ id: u.id, name: u.name }, 'LOGIN', 'User', u.user_id, `Role: ${u.role}`);

  res.json({
    token,
    user: { id: u.id, user_id: u.user_id, name: u.name, email: u.email, role: u.role, department: u.department }
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
      email: req.user.email, role: req.user.role, department: req.user.department
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
  const { name, location } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const plant_id = nextId('PL-', 'plants', 'plant_id');
  db.prepare('INSERT INTO plants(plant_id,name,location) VALUES (?,?,?)').run(plant_id, name, location || '');
  audit(req.user, 'CREATE', 'Plant', plant_id, `Plant "${name}" created`);
  res.json(db.prepare('SELECT * FROM plants WHERE plant_id=?').get(plant_id));
});
app.put('/api/plants/:plant_id', requireAuth, requireRole('System Administrator'), (req, res) => {
  const { name, location, status } = req.body;
  const r = db.prepare('UPDATE plants SET name=COALESCE(?,name), location=COALESCE(?,location), status=COALESCE(?,status), modified_at=datetime(\'now\') WHERE plant_id=?')
    .run(name, location, status, req.params.plant_id);
  if (r.changes === 0) return res.status(404).json({ error: 'Not found' });
  audit(req.user, 'UPDATE', 'Plant', req.params.plant_id, 'Plant modified');
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

// LOCATIONS
app.get('/api/locations', requireAuth, (req,res) => res.json(db.prepare('SELECT * FROM locations ORDER BY location_id').all()));

// AREAS
app.get('/api/areas', requireAuth, (req,res) => res.json(db.prepare('SELECT * FROM areas ORDER BY area_id').all()));

// EQUIPMENT
app.get('/api/equipment', requireAuth, (req,res) => res.json(db.prepare('SELECT * FROM equipment ORDER BY equipment_id').all()));
app.get('/api/equipment/:equipment_id', requireAuth, (req,res) => {
  const row = db.prepare('SELECT * FROM equipment WHERE equipment_id=?').get(req.params.equipment_id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});
app.post('/api/equipment', requireAuth, requireRole('System Administrator','Engineering'), (req, res) => {
  const { name, make_model, serial, capacity, area_id, status } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const eid = nextId('EQ-', 'equipment', 'equipment_id');
  db.prepare(`INSERT INTO equipment(equipment_id,name,make_model,serial,capacity,area_id,status,qr_code)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(eid, name, make_model||'', serial||'', capacity||'', area_id||'', status||'Active', `QR:${eid}`);
  audit(req.user, 'CREATE', 'Equipment', eid, `Registered: ${name}`);
  res.json(db.prepare('SELECT * FROM equipment WHERE equipment_id=?').get(eid));
});
app.put('/api/equipment/:equipment_id', requireAuth, requireRole('System Administrator','Engineering'), (req, res) => {
  const f = req.body;
  const r = db.prepare(`UPDATE equipment SET
      name=COALESCE(?,name),
      make_model=COALESCE(?,make_model),
      serial=COALESCE(?,serial),
      capacity=COALESCE(?,capacity),
      area_id=COALESCE(?,area_id),
      status=COALESCE(?,status)
    WHERE equipment_id=?`)
    .run(f.name, f.make_model, f.serial, f.capacity, f.area_id, f.status, req.params.equipment_id);
  if (r.changes === 0) return res.status(404).json({ error: 'Not found' });
  audit(req.user, 'UPDATE', 'Equipment', req.params.equipment_id, 'Equipment modified');
  res.json(db.prepare('SELECT * FROM equipment WHERE equipment_id=?').get(req.params.equipment_id));
});

// =============================================================
// USERS
// =============================================================
app.get('/api/users', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT id, user_id, name, email, role, department, status, last_login FROM users ORDER BY id').all());
});
app.post('/api/users', requireAuth, requireRole('System Administrator'), (req, res) => {
  const { user_id, name, email, password, role, department } = req.body;
  if (!user_id || !name || !password || !role) return res.status(400).json({ error: 'user_id, name, password, role required' });
  const exists = db.prepare('SELECT 1 FROM users WHERE user_id=?').get(user_id);
  if (exists) return res.status(409).json({ error: 'user_id already exists' });
  const hash = hashPassword(password);
  const r = db.prepare('INSERT INTO users(user_id,name,email,password_hash,role,department) VALUES (?,?,?,?,?,?)').run(user_id, name, email||'', hash, role, department||'');
  audit(req.user, 'CREATE', 'User', user_id, `Created user with role ${role}`);
  res.json({ id: r.lastInsertRowid, user_id, name, role, department });
});
app.put('/api/users/:user_id/status', requireAuth, requireRole('System Administrator'), (req, res) => {
  const { status } = req.body;
  if (!['Active','Locked','Inactive'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  db.prepare('UPDATE users SET status=? WHERE user_id=?').run(status, req.params.user_id);
  audit(req.user, 'UPDATE', 'User', req.params.user_id, `Status set to ${status}`);
  res.json({ ok: true });
});

// =============================================================
// PM CONFIG
// =============================================================
app.get('/api/frequencies', requireAuth, (req,res) => res.json(db.prepare('SELECT * FROM frequencies ORDER BY days').all()));
app.get('/api/pm-categories', requireAuth, (req,res) => res.json(db.prepare('SELECT * FROM pm_categories ORDER BY name').all()));
app.get('/api/checklist-groups', requireAuth, (req,res) => res.json(db.prepare('SELECT * FROM checklist_groups ORDER BY name').all()));
app.get('/api/checklists', requireAuth, (req,res) => res.json(db.prepare('SELECT id,name,group_id,version,status FROM checklists ORDER BY id').all()));
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
