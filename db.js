// db.js — SQLite schema + seed data for PMMS
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

// Password hashing using Node's built-in crypto.scrypt (no external deps).
// Format stored in DB: "scrypt$<salt_hex>$<hash_hex>"
const SCRYPT_N = 16384, SCRYPT_R = 8, SCRYPT_P = 1, SCRYPT_KEYLEN = 64;
function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(plain, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function verifyPassword(plain, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, saltHex, hashHex] = stored.split('$');
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(plain, salt, expected.length, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return crypto.timingSafeEqual(actual, expected);
}

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'pmms.db');
try { require('fs').mkdirSync(path.dirname(DB_PATH), { recursive: true }); } catch (e) { /* ignore */ }
console.log(`[db] using SQLite at ${DB_PATH}`);
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---------- Schema ----------
function createSchema() {
  db.exec(`
    -- Departments master (configurable by admin)
    CREATE TABLE IF NOT EXISTS departments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'Active',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Activities (permissions) — admin-extensible
    CREATE TABLE IF NOT EXISTS activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      label TEXT NOT NULL,
      category TEXT,
      is_system INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Roles — each role belongs to one department and has a permissions array
    CREATE TABLE IF NOT EXISTS roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      department_id INTEGER NOT NULL REFERENCES departments(id),
      description TEXT,
      permissions_json TEXT NOT NULL DEFAULT '[]',
      is_system INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'Active',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT UNIQUE NOT NULL,
      employee_id TEXT UNIQUE,
      name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      password_hash TEXT NOT NULL,
      role_id INTEGER REFERENCES roles(id),
      department_id INTEGER REFERENCES departments(id),
      role TEXT,
      department TEXT,
      status TEXT NOT NULL DEFAULT 'Active',
      last_login TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS plants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plant_id TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      location TEXT,
      version TEXT NOT NULL DEFAULT 'v1.0',
      status TEXT NOT NULL DEFAULT 'Active',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      modified_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      block_id TEXT UNIQUE NOT NULL,
      plant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Active',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS formulations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      formulation_id TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      department TEXT,
      status TEXT NOT NULL DEFAULT 'Active'
    );

    CREATE TABLE IF NOT EXISTS locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      location_id TEXT UNIQUE NOT NULL,
      block_id TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'Active'
    );

    CREATE TABLE IF NOT EXISTS areas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      area_id TEXT UNIQUE NOT NULL,
      location_id TEXT NOT NULL,
      area_type TEXT,
      status TEXT NOT NULL DEFAULT 'Active'
    );

    CREATE TABLE IF NOT EXISTS equipment (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      equipment_id TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      make_model TEXT,
      serial TEXT,
      capacity TEXT,
      area_id TEXT,
      status TEXT NOT NULL DEFAULT 'Active',
      qr_code TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- PM frequency master (editable by manage_pm_frequencies)
    CREATE TABLE IF NOT EXISTS frequencies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      days INTEGER NOT NULL,
      tolerance_days INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'Active'
    );

    -- PM category master (editable by manage_pm_categories)
    CREATE TABLE IF NOT EXISTS pm_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'Active'
    );

    CREATE TABLE IF NOT EXISTS checklist_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      department_id INTEGER REFERENCES departments(id),
      department TEXT
    );

    -- Checklists — Draft / Pending Review / Pending Approval / Approved / Rejected
    -- Only Approved checklists can be assigned. Initiator -> Reviewer -> Approver workflow.
    CREATE TABLE IF NOT EXISTS checklists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      group_id INTEGER REFERENCES checklist_groups(id),
      category_id INTEGER REFERENCES pm_categories(id),
      version TEXT NOT NULL DEFAULT 'v1.0',
      status TEXT NOT NULL DEFAULT 'Draft',
      fields_json TEXT,
      created_by INTEGER REFERENCES users(id),
      reviewer_id INTEGER REFERENCES users(id),
      approver_id INTEGER REFERENCES users(id),
      submitted_at TEXT,
      reviewed_at TEXT,
      approved_at TEXT,
      rejection_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- New structured checklist: sections (a.k.a. "checkpoint groups")
    CREATE TABLE IF NOT EXISTS checklist_sections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      checklist_id INTEGER NOT NULL REFERENCES checklists(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT,
      position INTEGER NOT NULL DEFAULT 0
    );

    -- Questions / checkpoints under a section
    CREATE TABLE IF NOT EXISTS checklist_questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      section_id INTEGER NOT NULL REFERENCES checklist_sections(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      qtype TEXT NOT NULL,
      options_json TEXT,
      required INTEGER NOT NULL DEFAULT 0,
      min_value REAL,
      max_value REAL,
      unit TEXT,
      position INTEGER NOT NULL DEFAULT 0
    );

    -- Checklist assignment: manager assigns an approved checklist to an equipment or area,
    -- plus an executor + reviewer + approver for the execution workflow.
    -- Lifecycle: Pending -> In Progress (executor) -> Pending Review -> Pending Approval -> Completed
    --           or -> Rejected (from review/approval; goes back to In Progress on rework).
    CREATE TABLE IF NOT EXISTS checklist_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      assignment_id TEXT UNIQUE NOT NULL,
      checklist_id INTEGER NOT NULL REFERENCES checklists(id),
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      assignee_id INTEGER REFERENCES users(id),
      reviewer_id INTEGER REFERENCES users(id),
      approver_id INTEGER REFERENCES users(id),
      frequency_id INTEGER REFERENCES frequencies(id),
      due_date TEXT,
      status TEXT NOT NULL DEFAULT 'Pending',
      response_data TEXT,
      notes TEXT,
      executor_sig TEXT,
      reviewer_sig TEXT,
      approver_sig TEXT,
      rejection_reason TEXT,
      assigned_by INTEGER REFERENCES users(id),
      assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      submitted_at TEXT,
      reviewed_at TEXT,
      approved_at TEXT,
      completed_at TEXT
    );

    -- In-app notifications
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      title TEXT NOT NULL,
      message TEXT,
      kind TEXT NOT NULL DEFAULT 'info',
      link TEXT,
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS pm_schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pm_id TEXT UNIQUE NOT NULL,
      equipment_id TEXT NOT NULL,
      checklist_id INTEGER REFERENCES checklists(id),
      frequency TEXT NOT NULL,
      category TEXT,
      scheduled_date TEXT NOT NULL,
      tolerance_days INTEGER NOT NULL DEFAULT 5,
      department TEXT,
      technician_id INTEGER REFERENCES users(id),
      reviewer_id INTEGER REFERENCES users(id),
      approver_id INTEGER REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'Pending',
      execution_data TEXT,
      technician_sig TEXT,
      reviewer_sig TEXT,
      approver_sig TEXT,
      started_at TEXT,
      completed_at TEXT,
      remarks TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS breakdowns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bd_id TEXT UNIQUE NOT NULL,
      equipment_id TEXT NOT NULL,
      reported_at TEXT NOT NULL DEFAULT (datetime('now')),
      reported_by INTEGER REFERENCES users(id),
      severity TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Active',
      description TEXT,
      root_cause TEXT,
      resolution TEXT,
      mttr_hours REAL,
      closed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      user_id INTEGER REFERENCES users(id),
      user_name TEXT,
      action TEXT NOT NULL,
      entity TEXT,
      entity_id TEXT,
      details TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_pm_status   ON pm_schedules(status);
    CREATE INDEX IF NOT EXISTS idx_pm_eq       ON pm_schedules(equipment_id);
    CREATE INDEX IF NOT EXISTS idx_bd_status   ON breakdowns(status);
    CREATE INDEX IF NOT EXISTS idx_audit_ts    ON audit_log(ts);
    CREATE INDEX IF NOT EXISTS idx_notif_user  ON notifications(user_id, is_read);
    CREATE INDEX IF NOT EXISTS idx_assn_user   ON checklist_assignments(assignee_id, status);
  `);
}

// ---------- Built-in activities ----------
const BUILTIN_ACTIVITIES = [
  // User Management
  ['view_users',             'View Users',                'User Management'],
  ['manage_users',           'Create / Edit Users',       'User Management'],
  // Roles & Departments
  ['manage_departments',     'Manage Departments',        'Access Control'],
  ['manage_roles',           'Manage Roles',              'Access Control'],
  ['manage_activities',      'Manage Activities',         'Access Control'],
  // PM Config
  ['manage_pm_frequencies',  'Manage PM Frequencies',     'PM Configuration'],
  ['manage_pm_categories',   'Manage PM Categories',      'PM Configuration'],
  ['manage_checklists',      'Create / Edit Checklists',  'PM Configuration'],
  // Plants / Equipment
  ['manage_plants',          'Manage Plants & Blocks',    'Masters'],
  ['view_equipment',         'View Equipment',            'Masters'],
  ['manage_equipment',       'Add / Edit Equipment',      'Masters'],
  // PM lifecycle
  ['view_pm',                'View PM Schedules',         'PM Lifecycle'],
  ['create_pm',              'Create PM Schedule',        'PM Lifecycle'],
  ['approve_pm',             'Approve PM',                'PM Lifecycle'],
  ['assign_pm',              'Assign PM to Technician',   'PM Lifecycle'],
  ['execute_pm',             'Execute PM',                'PM Lifecycle'],
  ['review_pm',              'Review Completed PM',       'PM Lifecycle'],
  // Checklist authoring workflow
  ['review_checklist',       'Review Checklist',          'Checklists'],
  ['approve_checklist',      'Approve Checklist',         'Checklists'],
  // Checklist assignments
  ['assign_checklist',       'Assign Checklist',          'Checklists'],
  ['execute_checklist',      'Execute Assigned Checklist','Checklists'],
  // Breakdowns
  ['view_breakdowns',        'View Breakdowns',           'Breakdowns'],
  ['report_breakdown',       'Report Breakdown',          'Breakdowns'],
  ['resolve_breakdown',      'Resolve Breakdown',         'Breakdowns'],
  // Reports
  ['view_reports',           'View Reports',              'Reports'],
  ['view_audit',             'View Audit Trail',          'Reports'],
];

// ---------- Seed ----------
function seed() {
  const hasUsers = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (hasUsers > 0) return; // already seeded

  // 1. Activities (system)
  const insAct = db.prepare('INSERT INTO activities(code,label,category,is_system) VALUES (?,?,?,1)');
  for (const a of BUILTIN_ACTIVITIES) insAct.run(...a);
  const allCodes = BUILTIN_ACTIVITIES.map(a => a[0]);

  // 2. Departments
  const depts = [
    ['IT',                       'Information Technology'],
    ['Engineering',              'Engineering department (umbrella)'],
    ['Engineering - Mechanical', 'Mechanical maintenance team'],
    ['Engineering - Electrical', 'Electrical maintenance team'],
    ['HVAC',                     'Heating, Ventilation & Air Conditioning'],
    ['QA',                       'Quality Assurance'],
    ['Production',               'Production / Manufacturing'],
    ['Warehouse',                'Warehouse & Stores'],
  ];
  const insDept = db.prepare('INSERT INTO departments(name,description) VALUES (?,?)');
  for (const d of depts) insDept.run(...d);
  const deptId = (name) => db.prepare('SELECT id FROM departments WHERE name=?').get(name).id;

  // 3. Roles — each tied to one department, with permission set.
  // Names match the legacy role strings so existing requireRole() checks still work.
  const techActs   = ['view_pm','execute_pm','view_equipment','report_breakdown','execute_checklist'];
  const reviewerActs = ['view_pm','review_pm','view_equipment','view_reports','view_audit','execute_checklist','review_checklist'];
  const approverActs = ['view_pm','create_pm','approve_pm','assign_pm','view_equipment','manage_equipment','view_reports','view_breakdowns','resolve_breakdown','manage_checklists','assign_checklist','execute_checklist','review_checklist','approve_checklist'];
  const prodActs   = ['view_pm','view_equipment','report_breakdown','view_breakdowns','execute_checklist'];
  const qaActs     = ['view_pm','approve_pm','review_pm','view_reports','view_audit','execute_checklist','review_checklist','approve_checklist'];
  const whActs     = ['view_equipment','view_pm','execute_checklist'];

  const roles = [
    ['System Administrator', deptId('IT'),                       'Full access to every activity in the system', allCodes,    1],
    ['Approver',             deptId('Engineering'),              'Reviews and approves PM schedules',           approverActs, 1],
    ['Reviewer',             deptId('QA'),                       'Reviews completed PMs for compliance',         reviewerActs, 1],
    ['Technician',           deptId('Engineering - Mechanical'), 'Executes PMs on assigned equipment',           techActs,    1],
    ['Engineering',          deptId('Engineering'),              'Engineering manager — create/edit equipment & PMs', approverActs.concat(['create_pm','manage_plants']), 1],
    ['Production',           deptId('Production'),               'Production staff — reports breakdowns',        prodActs,    1],
    ['QA',                   deptId('QA'),                       'QA personnel',                                 qaActs,      1],
    ['Warehouse',            deptId('Warehouse'),                'Stores / inventory',                           whActs,      1],
  ];
  const insRole = db.prepare('INSERT INTO roles(name,department_id,description,permissions_json,is_system) VALUES (?,?,?,?,?)');
  for (const r of roles) {
    insRole.run(r[0], r[1], r[2], JSON.stringify([...new Set(r[3])]), r[4]);
  }
  const roleByName = (n) => db.prepare('SELECT id, department_id, name FROM roles WHERE name=?').get(n);

  // 4. Users — assign role_id + department_id
  const adminPw = process.env.ADMIN_PASSWORD || 'admin123';
  if (adminPw === 'admin123') {
    console.warn('[db] WARNING: seeding admin with default password "admin123" — set ADMIN_PASSWORD env var for production');
  }
  const mkHash = (pw) => hashPassword(pw);
  const insertUser = db.prepare(`
    INSERT INTO users (user_id, employee_id, name, email, password_hash, role_id, department_id, role, department, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Active')
  `);
  // [user_id, employee_id, name, email, password, role_name, override_department_name?]
  const users = [
    ['admin',     'EMP-0001', 'Achyutha Reddy', 'achyutha2006@gmail.com', adminPw,         'System Administrator', null],
    ['siyer',     'EMP-1001', 'S. Iyer',        'siyer@ways.local',       'approver123',   'Approver',             null],
    ['rmehta',    'EMP-1002', 'R. Mehta',       'rmehta@ways.local',      'reviewer123',   'Reviewer',             null],
    ['pkumar',    'EMP-2001', 'P. Kumar',       'pkumar@ways.local',      'tech123',       'Technician',           'Engineering - Mechanical'],
    ['krao',      'EMP-2002', 'K. Rao',         'krao@ways.local',        'tech123',       'Technician',           'Engineering - Electrical'],
    ['snaidu',    'EMP-2003', 'S. Naidu',       'snaidu@ways.local',      'tech123',       'Technician',           'HVAC'],
    ['mverma',    'EMP-3001', 'M. Verma',       'mverma@ways.local',      'prod123',       'Production',           null],
    ['qaapprove', 'EMP-4001', 'Q. Anand',       'qa@ways.local',          'qa123',         'QA',                   null],
    ['stores',    'EMP-5001', 'Stores Officer', 'stores@ways.local',      'store123',      'Warehouse',            null],
  ];
  for (const u of users) {
    const r = roleByName(u[5]);
    const dId = u[6] ? deptId(u[6]) : r.department_id;
    const dName = u[6] || db.prepare('SELECT name FROM departments WHERE id=?').get(dId).name;
    insertUser.run(u[0], u[1], u[2], u[3], mkHash(u[4]), r.id, dId, r.name, dName);
  }

  const ins = (sql) => db.prepare(sql);

  ins('INSERT INTO plants(plant_id,name,location,version,status) VALUES (?,?,?,?,?)').run('PL-001','Hyderabad Formulations Plant','Hyderabad, IN','v3.1','Active');
  ins('INSERT INTO plants(plant_id,name,location,version,status) VALUES (?,?,?,?,?)').run('PL-002','Visakhapatnam API Plant','Vizag, IN','v2.4','Active');
  ins('INSERT INTO plants(plant_id,name,location,version,status) VALUES (?,?,?,?,?)').run('PL-003','Baddi Solid Dosage','Baddi, HP','v1.7','Under Review');
  ins('INSERT INTO plants(plant_id,name,location,version,status) VALUES (?,?,?,?,?)').run('PL-004','R&D Pilot Plant','Bangalore, IN','v1.0','Inactive');

  const blocks = [
    ['BLK-001','PL-001','Block-A · Granulation'],
    ['BLK-002','PL-001','Block-B · Compression'],
    ['BLK-003','PL-001','Block-C · Coating'],
    ['BLK-004','PL-002','API Synthesis Block'],
  ];
  for (const b of blocks) ins('INSERT INTO blocks(block_id,plant_id,name) VALUES (?,?,?)').run(...b);

  const forms = [
    ['FRM-001','Tablets — Immediate Release','Production'],
    ['FRM-002','Capsules — Hard Gel','Production'],
    ['FRM-003','Oral Solutions','Production'],
    ['FRM-004','Injectables — Sterile','Production'],
  ];
  for (const f of forms) ins('INSERT INTO formulations(formulation_id,name,department) VALUES (?,?,?)').run(...f);

  const locs = [
    ['LOC-001','BLK-001','Granulation Room 1'],
    ['LOC-002','BLK-001','Sifting Area'],
    ['LOC-003','BLK-002','Compression Hall'],
    ['LOC-004','BLK-003','Coating Room'],
  ];
  for (const l of locs) ins('INSERT INTO locations(location_id,block_id,description) VALUES (?,?,?)').run(...l);

  const areas = [
    ['AR-001','LOC-001','Classified — Grade D'],
    ['AR-002','LOC-003','Classified — Grade C'],
    ['AR-003','LOC-002','Black Area'],
    ['AR-004','LOC-004','Classified — Grade D'],
  ];
  for (const a of areas) ins('INSERT INTO areas(area_id,location_id,area_type) VALUES (?,?,?)').run(...a);

  const equipment = [
    ['EQ-RMG-02','Rapid Mixer Granulator','Gansons / RMG-300','SN-7841-A','300 L','AR-001','Active'],
    ['EQ-FBD-04','Fluid Bed Dryer',       'Gansons / FBD-200','SN-9012-B','200 kg','AR-001','Active'],
    ['EQ-TBP-02','Tablet Press',          'Cadmach / CMD-27', 'SN-4451-C','27 stations','AR-002','Under Maintenance'],
    ['EQ-AHU-12','Air Handling Unit',     'Caryaire / AHU-15K','SN-2266-D','15,000 CFM','AR-004','Active'],
    ['EQ-CMP-03','Air Compressor',        'Atlas Copco / GA-90','SN-3380-E','90 kW','AR-003','Active'],
    ['EQ-CAP-01','Capsule Filler',        'ACG / AF-90T',     'SN-1188-F','90,000 caps/hr','AR-002','Validation'],
    ['EQ-AHU-08','Air Handling Unit (8)', 'Caryaire / AHU-10K','SN-7799-G','10,000 CFM','AR-004','Active'],
  ];
  const eqIns = ins('INSERT INTO equipment(equipment_id,name,make_model,serial,capacity,area_id,status,qr_code) VALUES (?,?,?,?,?,?,?,?)');
  for (const e of equipment) eqIns.run(...e, `QR:${e[0]}`);

  const freqs = [
    ['Daily',1,0], ['Weekly',7,2], ['Monthly',30,5], ['Quarterly',90,10], ['Half-Yearly',180,15], ['Yearly',365,30]
  ];
  for (const f of freqs) ins('INSERT INTO frequencies(name,days,tolerance_days) VALUES (?,?,?)').run(...f);

  const cats = [
    ['Mechanical',     'Mechanical maintenance activities'],
    ['Electrical',     'Electrical inspections and tests'],
    ['Instrumentation','Instrument calibration & checks'],
    ['Utility',        'Utility systems (steam, compressed air, etc.)'],
    ['HVAC',           'Heating, ventilation & air conditioning'],
    ['Calibration',    'Periodic instrument calibration'],
    ['Lubrication',    'Lubrication schedule'],
    ['Safety',         'Safety and statutory checks'],
  ];
  for (const c of cats) ins('INSERT INTO pm_categories(name,description) VALUES (?,?)').run(...c);

  const groups = [
    ['Granulation Equipment',  deptId('Engineering - Mechanical'), 'Engineering - Mechanical'],
    ['Compression Machines',   deptId('Engineering - Mechanical'), 'Engineering - Mechanical'],
    ['Coating Equipment',      deptId('Engineering - Mechanical'), 'Engineering - Mechanical'],
    ['HVAC / Utilities',       deptId('HVAC'),                     'HVAC'],
    ['Capsule Filling',        deptId('Engineering - Mechanical'), 'Engineering - Mechanical'],
  ];
  for (const g of groups) ins('INSERT INTO checklist_groups(name,department_id,department) VALUES (?,?,?)').run(...g);

  // Legacy fields_json checklists (still supported)
  const fbdChecklist = JSON.stringify([
    { id: 'q1', type: 'dropdown', label: 'Verify equipment is shut down and tagged out', options:['OK','Not OK'], required:true },
    { id: 'q2', type: 'dropdown', label: 'Inspect filter bag condition', options:['OK','Replace'], required:true },
    { id: 'q3', type: 'number',   label: 'Inlet air temperature (°C)', min:25, max:80, required:true },
    { id: 'q4', type: 'checkbox', label: 'Lubricated blower bearings', required:true },
    { id: 'q5', type: 'text',     label: 'Lubricant batch ID', required:true },
    { id: 'q6', type: 'text',     label: 'Remarks', required:false },
  ]);
  ins("INSERT INTO checklists(name,group_id,version,fields_json,status) VALUES (?,?,?,?,'Approved')").run('FBD Monthly Mechanical',1,'v3.2',fbdChecklist);

  const rmgChecklist = JSON.stringify([
    { id: 'q1', type: 'dropdown', label: 'Power isolation done', options:['Yes','No'], required:true },
    { id: 'q2', type: 'number',   label: 'Motor amperage (A)', min:0, max:200, required:true },
    { id: 'q3', type: 'dropdown', label: 'Impeller condition', options:['OK','Worn'], required:true },
    { id: 'q4', type: 'text',     label: 'Remarks', required:false },
  ]);
  ins("INSERT INTO checklists(name,group_id,version,fields_json,status) VALUES (?,?,?,?,'Approved')").run('RMG Weekly Electrical',1,'v2.1',rmgChecklist);

  const ahuChecklist = JSON.stringify([
    { id: 'q1', type: 'dropdown', label: 'Filter status', options:['OK','Replace'], required:true },
    { id: 'q2', type: 'number',   label: 'Differential pressure (Pa)', min:0, max:500, required:true },
    { id: 'q3', type: 'number',   label: 'Supply air flow (CFM)', min:0, max:20000, required:true },
    { id: 'q4', type: 'text',     label: 'Remarks', required:false },
  ]);
  ins("INSERT INTO checklists(name,group_id,version,fields_json,status) VALUES (?,?,?,?,'Approved')").run('AHU Quarterly HVAC',4,'v1.4',ahuChecklist);

  // ---- Structured (new) checklist sample: AHU Monthly Inspection ----
  const adminId = db.prepare("SELECT id FROM users WHERE user_id='admin'").get().id;
  const ahuCatId = db.prepare("SELECT id FROM pm_categories WHERE name='HVAC'").get().id;
  const reviewerId = db.prepare("SELECT id FROM users WHERE user_id='rmehta'").get().id;
  const approverId = db.prepare("SELECT id FROM users WHERE user_id='siyer'").get().id;
  const clRes = ins(`INSERT INTO checklists(name,description,group_id,category_id,version,status,created_by,reviewer_id,approver_id,submitted_at,reviewed_at,approved_at)
                     VALUES (?,?,?,?,?,?,?,?,?, datetime('now','-3 days'), datetime('now','-2 days'), datetime('now','-1 day'))`)
    .run('AHU Monthly Inspection (v2)', 'Structured monthly AHU inspection with grouped checkpoints.', 4, ahuCatId, 'v2.0', 'Approved', adminId, reviewerId, approverId);
  const ahuCl = clRes.lastInsertRowid;

  const insSec = db.prepare('INSERT INTO checklist_sections(checklist_id,name,description,position) VALUES (?,?,?,?)');
  const insQ = db.prepare(`INSERT INTO checklist_questions(section_id,label,qtype,options_json,required,min_value,max_value,unit,position) VALUES (?,?,?,?,?,?,?,?,?)`);

  const sec1 = insSec.run(ahuCl, 'Pre-Inspection Safety', 'Lock-out, tag-out and PPE verification', 1).lastInsertRowid;
  insQ.run(sec1, 'Equipment isolated and locked out',     'yesno',    null, 1, null, null, null, 1);
  insQ.run(sec1, 'PPE worn (gloves, goggles)',            'checkbox', null, 1, null, null, null, 2);
  insQ.run(sec1, 'Permit-to-work number',                 'text',     null, 1, null, null, null, 3);

  const sec2 = insSec.run(ahuCl, 'Filters & Coils', 'Visual + measurement checks on filters', 2).lastInsertRowid;
  insQ.run(sec2, 'Pre-filter condition',                  'dropdown', JSON.stringify(['OK','Dirty','Replace']), 1, null, null, null, 1);
  insQ.run(sec2, 'HEPA filter condition',                 'dropdown', JSON.stringify(['OK','Replace']),         1, null, null, null, 2);
  insQ.run(sec2, 'Differential pressure across filter',   'number',   null, 1, 0, 500, 'Pa', 3);
  insQ.run(sec2, 'Cooling coil cleanliness',              'dropdown', JSON.stringify(['Clean','Acceptable','Dirty']), 1, null, null, null, 4);

  const sec3 = insSec.run(ahuCl, 'Blower & Motor', 'Mechanical + electrical health of blower assembly', 3).lastInsertRowid;
  insQ.run(sec3, 'Belt tension OK',                       'yesno',    null, 1, null, null, null, 1);
  insQ.run(sec3, 'Motor current draw',                    'number',   null, 1, 0, 100, 'A', 2);
  insQ.run(sec3, 'Bearing temperature',                   'number',   null, 1, 0, 120, '°C', 3);
  insQ.run(sec3, 'Unusual noise / vibration?',            'yesno',    null, 1, null, null, null, 4);

  const sec4 = insSec.run(ahuCl, 'Sign-off', 'Technician notes and signatures', 4).lastInsertRowid;
  insQ.run(sec4, 'Remarks / observations',                'text',     null, 0, null, null, null, 1);

  // PM Schedules — mix of statuses for a populated dashboard
  const u = (uid) => db.prepare('SELECT id FROM users WHERE user_id=?').get(uid).id;
  const cl = (name) => db.prepare('SELECT id FROM checklists WHERE name=?').get(name).id;
  const today = new Date();
  const fmt = (d) => d.toISOString().slice(0,10);
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate()+n); return x; };

  const insSched = ins(`INSERT INTO pm_schedules(pm_id,equipment_id,checklist_id,frequency,category,scheduled_date,department,technician_id,reviewer_id,approver_id,status,created_by)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);

  insSched.run('PM-2607','EQ-FBD-04', cl('FBD Monthly Mechanical'),'Monthly','Mechanical', fmt(addDays(today, 1)),  'Engineering - Mechanical', u('pkumar'),  u('rmehta'), u('siyer'), 'Approved', u('admin'));
  insSched.run('PM-2608','EQ-AHU-12', cl('AHU Quarterly HVAC'),    'Quarterly','HVAC',     fmt(addDays(today, 2)),  'HVAC',                     null,         u('rmehta'), u('siyer'), 'Pending',  u('admin'));
  insSched.run('PM-2609','EQ-RMG-02', cl('RMG Weekly Electrical'), 'Weekly','Electrical',  fmt(today),              'Engineering - Electrical', u('pkumar'),  u('rmehta'), u('siyer'), 'In Progress', u('admin'));
  insSched.run('PM-2610','EQ-CMP-03', cl('FBD Monthly Mechanical'),'Monthly','Mechanical', fmt(addDays(today, 5)),  'Engineering - Mechanical', u('krao'),    u('rmehta'), u('siyer'), 'Approved', u('admin'));
  insSched.run('PM-2589','EQ-TBP-02', cl('FBD Monthly Mechanical'),'Quarterly','Calibration', fmt(addDays(today, -6)),'Engineering - Mechanical', u('pkumar'), u('rmehta'), u('siyer'), 'Overdue',  u('admin'));
  insSched.run('PM-2570','EQ-AHU-08', cl('AHU Quarterly HVAC'),    'Monthly','HVAC',       fmt(addDays(today, -22)),'HVAC',                     null,         u('rmehta'), u('siyer'), 'Expired',  u('admin'));

  const completedData = JSON.stringify({ q1:'OK', q2:'OK', q3:55, q4:true, q5:'LUB-2026-04-001', q6:'Routine PM completed without issues' });
  insSched.run('PM-2575','EQ-CAP-01', cl('FBD Monthly Mechanical'),'Monthly','Mechanical', fmt(addDays(today, -16)),'Engineering - Mechanical', u('snaidu'), u('rmehta'), u('siyer'), 'Completed', u('admin'));
  db.prepare(`UPDATE pm_schedules SET execution_data=?, started_at=?, completed_at=?, technician_sig=?, reviewer_sig=?, approver_sig=? WHERE pm_id='PM-2575'`)
    .run(completedData, fmt(addDays(today, -16))+' 09:15:00', fmt(addDays(today,-16))+' 11:20:00','S. Naidu','R. Mehta','S. Iyer');

  // Sample checklist assignment with notification (target = equipment)
  // Workflow: Executor snaidu -> Reviewer rmehta -> Approver qaapprove
  ins('INSERT INTO checklist_assignments(assignment_id,checklist_id,target_type,target_id,assignee_id,reviewer_id,approver_id,frequency_id,due_date,status,assigned_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run('CA-001', ahuCl, 'equipment', 'EQ-AHU-12', u('snaidu'), u('rmehta'), u('qaapprove'),
         db.prepare("SELECT id FROM frequencies WHERE name='Monthly'").get().id,
         fmt(addDays(today, 3)), 'Pending', u('siyer'));
  ins('INSERT INTO notifications(user_id,title,message,kind,link) VALUES (?,?,?,?,?)')
    .run(u('snaidu'),
         'New checklist assigned',
         'AHU Monthly Inspection (v2) for EQ-AHU-12 is due ' + fmt(addDays(today,3)) + '.',
         'assignment',
         '/assignments/CA-001');

  // Breakdowns
  const insBd = ins('INSERT INTO breakdowns(bd_id,equipment_id,reported_by,severity,status,description) VALUES (?,?,?,?,?,?)');
  insBd.run('BD-118','EQ-TBP-02', u('mverma'),'Critical','Active','Punch failure on station 12; abnormal noise.');
  insBd.run('BD-119','EQ-CAP-01', u('snaidu'),'Major',  'Investigating','Capsule misalignment causing frequent jams.');
  insBd.run('BD-120','EQ-AHU-08', u('mverma'),'Major',  'Spares Awaited','Belt slippage; replacement belt on order.');
  insBd.run('BD-117','EQ-CMP-03', u('pkumar'),'Minor',  'Closed','Oil leak from compressor; gasket replaced.');
  db.prepare(`UPDATE breakdowns SET resolution=?, mttr_hours=?, closed_at=? WHERE bd_id='BD-117'`)
    .run('Replaced bottom gasket; verified no leaks.', 3.5, fmt(addDays(today,-3))+' 14:30:00');

  // Initial audit entries
  const insA = ins('INSERT INTO audit_log(user_name,action,entity,entity_id,details) VALUES (?,?,?,?,?)');
  insA.run('System','SEED','SYSTEM','-','Initial seed completed');
  insA.run('Achyutha Reddy','CREATE','Plant','PL-001','Plant created');
  insA.run('Achyutha Reddy','CREATE','Equipment','EQ-FBD-04','Equipment registered with QR code');
  insA.run('S. Iyer','APPROVE','PM','PM-2607','PM approved for execution');
}

function initAndSeed(force=false) {
  if (force) {
    db.exec(`
      DROP TABLE IF EXISTS audit_log;
      DROP TABLE IF EXISTS breakdowns;
      DROP TABLE IF EXISTS pm_schedules;
      DROP TABLE IF EXISTS notifications;
      DROP TABLE IF EXISTS checklist_assignments;
      DROP TABLE IF EXISTS checklist_questions;
      DROP TABLE IF EXISTS checklist_sections;
      DROP TABLE IF EXISTS checklists;
      DROP TABLE IF EXISTS checklist_groups;
      DROP TABLE IF EXISTS pm_categories;
      DROP TABLE IF EXISTS frequencies;
      DROP TABLE IF EXISTS equipment;
      DROP TABLE IF EXISTS areas;
      DROP TABLE IF EXISTS locations;
      DROP TABLE IF EXISTS formulations;
      DROP TABLE IF EXISTS blocks;
      DROP TABLE IF EXISTS plants;
      DROP TABLE IF EXISTS sessions;
      DROP TABLE IF EXISTS users;
      DROP TABLE IF EXISTS roles;
      DROP TABLE IF EXISTS activities;
      DROP TABLE IF EXISTS departments;
    `);
  }
  createSchema();
  seed();
}

initAndSeed(false);

module.exports = { db, initAndSeed, hashPassword, verifyPassword };
