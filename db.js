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

// When packaged by pkg, __dirname points inside the read-only snapshot. The DB file must live
// next to the .exe in the real filesystem instead. process.execPath is "PMMS.exe" in that case.
const IS_PACKAGED = typeof process.pkg !== 'undefined';
const BASE_DIR    = IS_PACKAGED ? path.dirname(process.execPath) : __dirname;
const DB_PATH = process.env.DB_PATH || path.join(BASE_DIR, 'pmms.db');
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

    -- Master tables share the same review/approve workflow columns: created_by, reviewer_id,
    -- approver_id, reviewed_at, review_remarks, approved_at, approval_remarks. New rows start at
    -- status='Pending Review' and only flip to 'Active' after both gates pass.
    CREATE TABLE IF NOT EXISTS plants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plant_id TEXT UNIQUE NOT NULL,
      unit_number TEXT,
      name TEXT NOT NULL,
      location TEXT,
      version TEXT,
      status TEXT NOT NULL DEFAULT 'Pending Review',
      created_by INTEGER REFERENCES users(id),
      reviewer_id INTEGER REFERENCES users(id),
      approver_id INTEGER REFERENCES users(id),
      reviewed_at TEXT, review_remarks TEXT,
      approved_at TEXT, approval_remarks TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      modified_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      block_id TEXT UNIQUE NOT NULL,
      plant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Pending Review',
      created_by INTEGER REFERENCES users(id),
      reviewer_id INTEGER REFERENCES users(id),
      approver_id INTEGER REFERENCES users(id),
      reviewed_at TEXT, review_remarks TEXT,
      approved_at TEXT, approval_remarks TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS formulations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      formulation_id TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      department TEXT,
      status TEXT NOT NULL DEFAULT 'Pending Review',
      created_by INTEGER REFERENCES users(id),
      reviewer_id INTEGER REFERENCES users(id),
      approver_id INTEGER REFERENCES users(id),
      reviewed_at TEXT, review_remarks TEXT,
      approved_at TEXT, approval_remarks TEXT
    );

    CREATE TABLE IF NOT EXISTS locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      location_id TEXT UNIQUE NOT NULL,
      block_id TEXT NOT NULL,
      description TEXT,
      formulation_id INTEGER REFERENCES formulations(id),
      status TEXT NOT NULL DEFAULT 'Pending Review',
      created_by INTEGER REFERENCES users(id),
      reviewer_id INTEGER REFERENCES users(id),
      approver_id INTEGER REFERENCES users(id),
      reviewed_at TEXT, review_remarks TEXT,
      approved_at TEXT, approval_remarks TEXT
    );

    CREATE TABLE IF NOT EXISTS areas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      area_id TEXT UNIQUE NOT NULL,
      location_id TEXT NOT NULL,
      name TEXT,
      status TEXT NOT NULL DEFAULT 'Pending Review',
      created_by INTEGER REFERENCES users(id),
      reviewer_id INTEGER REFERENCES users(id),
      approver_id INTEGER REFERENCES users(id),
      reviewed_at TEXT, review_remarks TEXT,
      approved_at TEXT, approval_remarks TEXT
    );

    CREATE TABLE IF NOT EXISTS equipment (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      equipment_id TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      make TEXT,
      model TEXT,
      serial TEXT,
      capacity TEXT,
      area_id TEXT,
      status TEXT NOT NULL DEFAULT 'Pending Review',
      qr_code TEXT,
      created_by INTEGER REFERENCES users(id),
      reviewer_id INTEGER REFERENCES users(id),
      approver_id INTEGER REFERENCES users(id),
      reviewed_at TEXT, review_remarks TEXT,
      approved_at TEXT, approval_remarks TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- PM frequency master (editable by manage_pm_frequencies)
    -- Canonical Checklist Name master — QA maintains the approved list of
    -- names that appear in the Checklist builder dropdown.
    CREATE TABLE IF NOT EXISTS checklist_name_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'Active',
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- =====================================================================
    -- CONFIGURABLE APPROVAL WORKFLOWS
    -- ---------------------------------------------------------------------
    -- Admins define named workflows (e.g. "Standard 2-Stage", "GMP 3-Stage",
    -- "Engineering 4-Stage"). Each workflow has an ordered list of stages
    -- stored as JSON. When a master record is created, the creator picks a
    -- workflow and assigns a user to each stage. The record then walks
    -- through the stages in order, with each stage requiring an e-signature.
    -- =====================================================================
    CREATE TABLE IF NOT EXISTS approval_workflows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      description TEXT,
      stages_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Active',
      is_system INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Per-record approval progress. One row per (entity, stage). When the
    -- record is first created, N rows get inserted (one per workflow stage)
    -- with status='Pending'. Each row gets signed in order.
    CREATE TABLE IF NOT EXISTS record_approval_stages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_id INTEGER NOT NULL REFERENCES approval_workflows(id),
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      stage_index INTEGER NOT NULL,
      stage_label TEXT NOT NULL,
      stage_type TEXT NOT NULL,
      assignee_id INTEGER REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'Pending',
      signed_by_id INTEGER REFERENCES users(id),
      signed_at TEXT,
      remarks TEXT,
      signature_meaning TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ras_entity ON record_approval_stages(entity_type, entity_id, stage_index);

    CREATE TABLE IF NOT EXISTS frequencies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      days INTEGER NOT NULL,
      tolerance_days INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'Pending Review',
      created_by INTEGER REFERENCES users(id),
      reviewer_id INTEGER REFERENCES users(id),
      approver_id INTEGER REFERENCES users(id),
      reviewed_at TEXT,
      review_remarks TEXT,
      approved_at TEXT,
      approval_remarks TEXT
    );

    -- PM category master (editable by manage_pm_categories) — same 2-stage
    -- review/approve workflow as the other masters.
    CREATE TABLE IF NOT EXISTS pm_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'Pending Review',
      created_by INTEGER REFERENCES users(id),
      reviewer_id INTEGER REFERENCES users(id),
      approver_id INTEGER REFERENCES users(id),
      reviewed_at TEXT,
      review_remarks TEXT,
      approved_at TEXT,
      approval_remarks TEXT
    );

    -- Checklist groups master — same 2-stage review/approve workflow.
    CREATE TABLE IF NOT EXISTS checklist_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      department_id INTEGER REFERENCES departments(id),
      department TEXT,
      status TEXT NOT NULL DEFAULT 'Pending Review',
      created_by INTEGER REFERENCES users(id),
      reviewer_id INTEGER REFERENCES users(id),
      approver_id INTEGER REFERENCES users(id),
      reviewed_at TEXT,
      review_remarks TEXT,
      approved_at TEXT,
      approval_remarks TEXT
    );

    -- Checklists — Draft / Pending Review / Pending Approval / Approved / Rejected
    -- Only Approved checklists can be assigned. Initiator -> Reviewer -> Approver workflow.
    CREATE TABLE IF NOT EXISTS checklists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT,
      name TEXT NOT NULL,
      description TEXT,
      group_id INTEGER REFERENCES checklist_groups(id),
      category_id INTEGER REFERENCES pm_categories(id),
      version TEXT NOT NULL DEFAULT 'v1.0',
      status TEXT NOT NULL DEFAULT 'Draft',
      fields_json TEXT,
      required_fields_json TEXT,
      created_by INTEGER REFERENCES users(id),
      reviewer_id INTEGER REFERENCES users(id),
      approver_id INTEGER REFERENCES users(id),
      submitted_at TEXT,
      reviewed_at TEXT,
      approved_at TEXT,
      rejection_reason TEXT,
      dropped_at TEXT,
      drop_remarks TEXT,
      superseded_at TEXT,
      superseded_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- Multiple versions of the same Checklist ID coexist: each (code, version) is unique.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_checklists_code_version ON checklists(code, version);

    -- Each checklist may be associated with one or more frequencies (Weekly + Monthly + Quarterly)
    CREATE TABLE IF NOT EXISTS checklist_frequencies (
      checklist_id INTEGER NOT NULL REFERENCES checklists(id) ON DELETE CASCADE,
      frequency_id INTEGER NOT NULL REFERENCES frequencies(id),
      PRIMARY KEY (checklist_id, frequency_id)
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
    -- frequencies_json: JSON array of frequency IDs this checkpoint applies to.
    -- Empty / NULL = applies to ALL frequencies the parent checklist allows.
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
      frequencies_json TEXT,
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
      effective_date TEXT,
      due_date TEXT,
      status TEXT NOT NULL DEFAULT 'Pending',
      response_data TEXT,
      notes TEXT,
      executor_sig TEXT,
      reviewer_sig TEXT,
      approver_sig TEXT,
      rejection_reason TEXT,
      -- Expired-PM re-assignment metadata (mandatory when re-assigning from 'Expired')
      pnc_number TEXT,
      exception_number TEXT,
      exception_description TEXT,
      expired_at TEXT,
      reassigned_at TEXT,
      reassigned_by INTEGER REFERENCES users(id),
      -- Clearance step: production user grants clearance before the executor can be assigned.
      clearance_user_id INTEGER REFERENCES users(id),
      clearance_status TEXT,
      clearance_requested_at TEXT,
      clearance_responded_at TEXT,
      clearance_remarks TEXT,
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
  ['review_master',          'Review Master Data',        'Masters'],
  ['approve_master',         'Approve Master Data',       'Masters'],
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
  ['grant_clearance',        'Grant PM Clearance',        'Checklists'],
  // Breakdowns
  ['view_breakdowns',        'View Breakdowns',           'Breakdowns'],
  ['report_breakdown',       'Report Breakdown',          'Breakdowns'],
  ['resolve_breakdown',      'Resolve Breakdown',         'Breakdowns'],
  // Reports
  ['view_reports',           'View Reports',              'Reports'],
  ['view_audit',             'View Audit Trail',          'Reports'],
];

// ---------- Seed ----------
// Clean-slate seed: just enough for the admin to log in. Everything else (departments,
// roles, users, plants, equipment, frequencies, categories, checklists, etc.) is left
// empty so the administrator can configure the system from scratch.
function seed() {
  const hasUsers = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (hasUsers > 0) return; // already seeded

  // 1. Activities (system) — required because the code references these codes in permission checks.
  //    Admin can add or remove custom activities later via Admin Settings → Activities.
  const insAct = db.prepare('INSERT INTO activities(code,label,category,is_system) VALUES (?,?,?,1)');
  for (const a of BUILTIN_ACTIVITIES) insAct.run(...a);
  const allCodes = BUILTIN_ACTIVITIES.map(a => a[0]);

  // 2. One department: IT (so the admin role has a home).
  const insDept = db.prepare('INSERT INTO departments(name,description) VALUES (?,?)');
  insDept.run('IT', 'Information Technology');
  const deptId = (name) => db.prepare('SELECT id FROM departments WHERE name=?').get(name).id;

  // 3. One role: System Administrator with every activity. Bypasses all permission checks
  //    via the is_admin flag, so the admin can configure everything from scratch.
  db.prepare('INSERT INTO roles(name,department_id,description,permissions_json,is_system) VALUES (?,?,?,?,1)')
    .run('System Administrator', deptId('IT'), 'Full access to every activity in the system', JSON.stringify(allCodes));
  const adminRole = db.prepare("SELECT id, department_id FROM roles WHERE name='System Administrator'").get();

  // 4. The admin user — Achyutha Reddy. Password defaults to admin123; override with
  //    ADMIN_PASSWORD env var before first launch in production.
  const adminPw = process.env.ADMIN_PASSWORD || 'admin123';
  if (adminPw === 'admin123') {
    console.warn('[db] WARNING: seeding admin with default password "admin123" — set ADMIN_PASSWORD env var for production');
  }
  db.prepare(`INSERT INTO users (user_id, employee_id, name, email, password_hash, role_id, department_id, role, department, status)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Active')`)
    .run('admin', 'EMP-0001', 'Achyutha Reddy', 'achyutha2006@gmail.com',
         hashPassword(adminPw), adminRole.id, adminRole.department_id,
         'System Administrator', 'IT');

  // 5. Seed two standard approval workflows so the system has something to
  //    pick from out of the box. Admins can add more in Admin Settings.
  const standardWorkflows = [
    {
      name: 'Standard 2-Stage (Reviewer → Approver)',
      description: 'Default workflow. One Reviewer signs, then one Approver signs.',
      stages_json: JSON.stringify([
        { label: 'Reviewer',  type: 'review'  },
        { label: 'Approver',  type: 'approve' },
      ]),
    },
    {
      name: 'GMP 3-Stage (Reviewer → Approver → Final QA)',
      description: 'GMP-grade workflow. Adds a Final QA sign-off after the Approver.',
      stages_json: JSON.stringify([
        { label: 'Reviewer',          type: 'review'  },
        { label: 'Approver',          type: 'approve' },
        { label: 'Final QA Sign-off', type: 'approve' },
      ]),
    },
  ];
  const insWf = db.prepare(`INSERT INTO approval_workflows(name, description, stages_json, status, is_system, created_by)
                            VALUES (?, ?, ?, 'Active', 1, ?)`);
  for (const w of standardWorkflows) {
    try { insWf.run(w.name, w.description, w.stages_json, null); } catch (e) { /* may already exist */ }
  }

  // 6. One audit row marking the clean seed. Audit log otherwise starts empty.
  db.prepare('INSERT INTO audit_log(user_name,action,entity,entity_id,details) VALUES (?,?,?,?,?)')
    .run('System', 'SEED', 'SYSTEM', '-', 'Clean seed: System Administrator role + admin user + 2 standard approval workflows; no other data');

  // No further seed data. Departments, roles, users, plants, blocks, locations, areas,
  // formulations, equipment, frequencies, PM categories, checklist groups, checklists,
  // assignments, breakdowns — all left empty for the administrator to configure.
}

// Schema migration: when an existing DB file is missing columns that newer code expects,
// add them in-place so SELECTs don't blow up with "no such column".
// (CREATE TABLE IF NOT EXISTS only creates the table; it doesn't reconcile columns.)
function migrateSchema() {
  function cols(table) {
    try { return db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name); }
    catch (e) { return []; }
  }
  function addColIfMissing(table, col, ddl) {
    const existing = cols(table);
    if (existing.length === 0) return;
    if (!existing.includes(col)) {
      try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`); console.log(`[db] migration: added ${table}.${col}`); }
      catch (e) { console.error(`[db] migration failed for ${table}.${col}:`, e.message); }
    }
  }
  addColIfMissing('plants', 'unit_number', 'TEXT');
  addColIfMissing('users', 'employee_id', 'TEXT');
  addColIfMissing('users', 'phone', 'TEXT');
  addColIfMissing('users', 'role_id', 'INTEGER');
  addColIfMissing('users', 'department_id', 'INTEGER');
  addColIfMissing('locations', 'formulation_id', 'INTEGER');
  addColIfMissing('areas', 'name', 'TEXT');
  try {
    const areaCols = cols('areas');
    if (areaCols.includes('area_type') && areaCols.includes('name')) {
      const r = db.prepare("UPDATE areas SET name = area_type WHERE (name IS NULL OR name = '') AND area_type IS NOT NULL").run();
      if (r.changes > 0) console.log(`[db] migration: backfilled ${r.changes} areas.name from legacy area_type`);
    }
  } catch (e) { console.error('[db] migration: area_type backfill failed:', e.message); }
  addColIfMissing('equipment', 'make', 'TEXT');
  addColIfMissing('equipment', 'model', 'TEXT');
  addColIfMissing('equipment', 'manufacture_date', 'TEXT');
  addColIfMissing('equipment', 'equipment_type',   'TEXT');
  addColIfMissing('equipment', 'sub_type',         'TEXT');
  // Engineering department this equipment belongs to — drives the
  // sub-tabs in Equipment Master (Mechanical / Electrical / Instrumental /
  // Automation / Other). Stored as a free-text label rather than an FK so the
  // five canonical values are enforced by the UI dropdown.
  addColIfMissing('equipment', 'department',       'TEXT');
  addColIfMissing('checklist_groups', 'department_id', 'INTEGER');
  addColIfMissing('checklists', 'code', 'TEXT');
  addColIfMissing('checklists', 'description', 'TEXT');
  addColIfMissing('checklists', 'category_id', 'INTEGER');
  addColIfMissing('checklists', 'required_fields_json', 'TEXT');
  addColIfMissing('checklists', 'created_by', 'INTEGER');
  addColIfMissing('checklists', 'reviewer_id', 'INTEGER');
  addColIfMissing('checklists', 'approver_id', 'INTEGER');
  addColIfMissing('checklists', 'submitted_at', 'TEXT');
  addColIfMissing('checklists', 'reviewed_at', 'TEXT');
  addColIfMissing('checklists', 'approved_at', 'TEXT');
  addColIfMissing('checklists', 'rejection_reason', 'TEXT');
  addColIfMissing('checklists', 'dropped_at', 'TEXT');
  addColIfMissing('checklists', 'drop_remarks', 'TEXT');
  addColIfMissing('checklists', 'superseded_at', 'TEXT');
  addColIfMissing('checklists', 'superseded_by', 'INTEGER');
  addColIfMissing('checklist_assignments', 'withdrawn_at', 'TEXT');
  addColIfMissing('checklist_assignments', 'withdraw_remarks', 'TEXT');
  addColIfMissing('checklist_assignments', 'withdrawn_by', 'INTEGER');
  addColIfMissing('checklist_questions', 'frequencies_json', 'TEXT');
  addColIfMissing('checklist_assignments', 'target_type', 'TEXT');
  addColIfMissing('checklist_assignments', 'target_id', 'TEXT');
  addColIfMissing('checklist_assignments', 'reviewer_id', 'INTEGER');
  addColIfMissing('checklist_assignments', 'approver_id', 'INTEGER');
  addColIfMissing('checklist_assignments', 'effective_date', 'TEXT');
  addColIfMissing('checklist_assignments', 'executor_sig', 'TEXT');
  addColIfMissing('checklist_assignments', 'reviewer_sig', 'TEXT');
  addColIfMissing('checklist_assignments', 'approver_sig', 'TEXT');
  addColIfMissing('checklist_assignments', 'rejection_reason', 'TEXT');
  addColIfMissing('checklist_assignments', 'submitted_at', 'TEXT');
  addColIfMissing('checklist_assignments', 'reviewed_at', 'TEXT');
  addColIfMissing('checklist_assignments', 'approved_at', 'TEXT');
  addColIfMissing('checklist_assignments', 'pnc_number', 'TEXT');
  addColIfMissing('checklist_assignments', 'exception_number', 'TEXT');
  addColIfMissing('checklist_assignments', 'exception_description', 'TEXT');
  addColIfMissing('checklist_assignments', 'expired_at', 'TEXT');
  addColIfMissing('checklist_assignments', 'reassigned_at', 'TEXT');
  addColIfMissing('checklist_assignments', 'reassigned_by', 'INTEGER');
  addColIfMissing('checklist_assignments', 'clearance_user_id', 'INTEGER');
  addColIfMissing('checklist_assignments', 'clearance_status', 'TEXT');
  addColIfMissing('checklist_assignments', 'clearance_requested_at', 'TEXT');
  addColIfMissing('checklist_assignments', 'clearance_responded_at', 'TEXT');
  addColIfMissing('checklist_assignments', 'clearance_remarks', 'TEXT');
  addColIfMissing('frequencies', 'status', "TEXT NOT NULL DEFAULT 'Active'");
  // Frequency master now follows the same 2-stage Review→Approve workflow as the
  // 6 main masters. Existing seeded frequencies (Active) stay Active; only newly
  // created rows are subject to approval. These columns are nullable so the
  // existing seed rows don't need backfilling.
  addColIfMissing('frequencies', 'created_by',       'INTEGER');
  addColIfMissing('frequencies', 'reviewer_id',      'INTEGER');
  addColIfMissing('frequencies', 'approver_id',      'INTEGER');
  addColIfMissing('frequencies', 'reviewed_at',      'TEXT');
  addColIfMissing('frequencies', 'review_remarks',   'TEXT');
  addColIfMissing('frequencies', 'approved_at',      'TEXT');
  addColIfMissing('frequencies', 'approval_remarks', 'TEXT');
  // PM Categories — full 2-stage approval workflow.
  addColIfMissing('pm_categories', 'created_by',       'INTEGER');
  addColIfMissing('pm_categories', 'reviewer_id',      'INTEGER');
  addColIfMissing('pm_categories', 'approver_id',      'INTEGER');
  addColIfMissing('pm_categories', 'reviewed_at',      'TEXT');
  addColIfMissing('pm_categories', 'review_remarks',   'TEXT');
  addColIfMissing('pm_categories', 'approved_at',      'TEXT');
  addColIfMissing('pm_categories', 'approval_remarks', 'TEXT');
  // Checklist Groups — full 2-stage approval workflow.
  addColIfMissing('checklist_groups', 'status',           "TEXT NOT NULL DEFAULT 'Active'");
  addColIfMissing('checklist_groups', 'created_by',       'INTEGER');
  addColIfMissing('checklist_groups', 'reviewer_id',      'INTEGER');
  addColIfMissing('checklist_groups', 'approver_id',      'INTEGER');
  addColIfMissing('checklist_groups', 'reviewed_at',      'TEXT');
  addColIfMissing('checklist_groups', 'review_remarks',   'TEXT');
  addColIfMissing('checklist_groups', 'approved_at',      'TEXT');
  addColIfMissing('checklist_groups', 'approval_remarks', 'TEXT');

  // Breakdown enhancements — extra fields captured at report time.
  addColIfMissing('breakdowns', 'cause',                'TEXT');  // initial cause (separate from root_cause investigation)
  addColIfMissing('breakdowns', 'proposed_resolution',  'TEXT');
  addColIfMissing('breakdowns', 'estimated_duration',   'TEXT');  // free-text like "4 hours", "2 days"
  addColIfMissing('breakdowns', 'replacement_equipment_id', 'TEXT');
  addColIfMissing('breakdowns', 'replacement_suitable', 'INTEGER'); // 0/1
  addColIfMissing('breakdowns', 'verified_at',          'TEXT');
  addColIfMissing('breakdowns', 'verified_by',          'INTEGER');
  addColIfMissing('breakdowns', 'verification_remarks', 'TEXT');
  addColIfMissing('breakdowns', 'resolution_approved_at', 'TEXT');
  addColIfMissing('breakdowns', 'resolution_approved_by', 'INTEGER');

  // Recurring-popup acknowledgments — once a user acknowledges an overdue PM
  // with a comment, the blocking popup stops appearing for that occurrence.
  // The next scheduled assignment gets its own fresh popup.
  addColIfMissing('checklist_assignments', 'acknowledged_at',       'TEXT');
  addColIfMissing('checklist_assignments', 'acknowledged_by',       'INTEGER');
  addColIfMissing('checklist_assignments', 'acknowledgment_comment', 'TEXT');
  // Reschedule loop: reviewer proposes a new date → creator accepts/counter-proposes → reviewer accepts/rejects.
  addColIfMissing('checklist_assignments', 'proposed_date',         'TEXT');
  addColIfMissing('checklist_assignments', 'proposed_by',           'INTEGER');
  addColIfMissing('checklist_assignments', 'proposed_at',           'TEXT');
  addColIfMissing('checklist_assignments', 'proposed_remarks',      'TEXT');
  addColIfMissing('pm_categories', 'status', "TEXT NOT NULL DEFAULT 'Active'");
  addColIfMissing('pm_categories', 'description', 'TEXT');

  // Seed the standard workflows on an existing DB if they don't already exist.
  // Safe to run on every boot — INSERT OR IGNORE skips dupes by name UNIQUE.
  try {
    const insWf = db.prepare(`INSERT OR IGNORE INTO approval_workflows(name, description, stages_json, status, is_system) VALUES (?, ?, ?, 'Active', 1)`);
    insWf.run(
      'Standard 2-Stage (Reviewer → Approver)',
      'Default workflow. One Reviewer signs, then one Approver signs.',
      JSON.stringify([
        { label: 'Reviewer', type: 'review' },
        { label: 'Approver', type: 'approve' },
      ])
    );
    insWf.run(
      'GMP 3-Stage (Reviewer → Approver → Final QA)',
      'GMP-grade workflow. Adds a Final QA sign-off after the Approver.',
      JSON.stringify([
        { label: 'Reviewer',          type: 'review' },
        { label: 'Approver',          type: 'approve' },
        { label: 'Final QA Sign-off', type: 'approve' },
      ])
    );
  } catch (e) { /* approval_workflows table not yet created on a very old DB */ }

  // Master-data review / approve workflow columns — applied uniformly across all 6 masters.
  for (const t of ['plants','blocks','formulations','locations','areas','equipment']) {
    addColIfMissing(t, 'created_by',        'INTEGER');
    addColIfMissing(t, 'reviewer_id',       'INTEGER');
    addColIfMissing(t, 'approver_id',       'INTEGER');
    addColIfMissing(t, 'reviewed_at',       'TEXT');
    addColIfMissing(t, 'review_remarks',    'TEXT');
    addColIfMissing(t, 'approved_at',       'TEXT');
    addColIfMissing(t, 'approval_remarks',  'TEXT');
  }

  // -----------------------------------------------------------------------
  // One-shot rebuild: drop the legacy UNIQUE(code) constraint on checklists.
  // ----------------------------------------------------------------------
  // The original CREATE TABLE had `code TEXT UNIQUE`, which created an
  // auto-index that SQLite won't let us drop without rebuilding the table.
  // Versioning needs multiple rows to share a code (one per version), so we
  // rebuild the table once, then keep going with a composite UNIQUE(code,version) index.
  try {
    const idxList = db.prepare("PRAGMA index_list('checklists')").all();
    const hasLegacyUniqueOnCode = idxList.some(i =>
      i.unique === 1 && i.origin === 'u' && String(i.name).startsWith('sqlite_autoindex'));
    const hasCompositeIdx = idxList.some(i => i.name === 'idx_checklists_code_version');
    if (hasLegacyUniqueOnCode && !hasCompositeIdx) {
      console.log('[migrate] Rebuilding checklists table to drop UNIQUE(code) and add UNIQUE(code, version)…');
      db.exec('PRAGMA foreign_keys=OFF;');
      db.exec(`
        BEGIN TRANSACTION;
        CREATE TABLE _checklists_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          code TEXT,
          name TEXT NOT NULL,
          description TEXT,
          group_id INTEGER REFERENCES checklist_groups(id),
          category_id INTEGER REFERENCES pm_categories(id),
          version TEXT NOT NULL DEFAULT 'v1.0',
          status TEXT NOT NULL DEFAULT 'Draft',
          fields_json TEXT,
          required_fields_json TEXT,
          created_by INTEGER REFERENCES users(id),
          reviewer_id INTEGER REFERENCES users(id),
          approver_id INTEGER REFERENCES users(id),
          submitted_at TEXT,
          reviewed_at TEXT,
          approved_at TEXT,
          rejection_reason TEXT,
          dropped_at TEXT,
          drop_remarks TEXT,
          superseded_at TEXT,
          superseded_by INTEGER,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO _checklists_new
          (id, code, name, description, group_id, category_id, version, status,
           fields_json, required_fields_json, created_by, reviewer_id, approver_id,
           submitted_at, reviewed_at, approved_at, rejection_reason,
           dropped_at, drop_remarks, superseded_at, superseded_by, created_at)
        SELECT id, code, name, description, group_id, category_id, version, status,
               fields_json, required_fields_json, created_by, reviewer_id, approver_id,
               submitted_at, reviewed_at, approved_at, rejection_reason,
               dropped_at, drop_remarks, superseded_at, superseded_by, created_at
        FROM checklists;
        DROP TABLE checklists;
        ALTER TABLE _checklists_new RENAME TO checklists;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_checklists_code_version ON checklists(code, version);
        COMMIT;
      `);
      db.exec('PRAGMA foreign_keys=ON;');
      console.log('[migrate] checklists rebuild complete.');
    }
  } catch (e) {
    console.error('[migrate] checklists rebuild failed:', e.message);
  }
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
      DROP TABLE IF EXISTS checklist_frequencies;
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
  migrateSchema();
  seed();
}

initAndSeed(false);

module.exports = { db, initAndSeed, hashPassword, verifyPassword };

