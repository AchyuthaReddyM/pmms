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

// DB_PATH can be overridden via env (e.g., Render mounts a disk at /var/data).
// Falls back to local file for development.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'pmms.db');
// Ensure parent directory exists (Render disk mount point already exists,
// but this helps for arbitrary DB_PATH values).
try {
  require('fs').mkdirSync(path.dirname(DB_PATH), { recursive: true });
} catch (e) { /* ignore */ }
console.log(`[db] using SQLite at ${DB_PATH}`);
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---------- Schema ----------
function createSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      email TEXT,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
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

    CREATE TABLE IF NOT EXISTS frequencies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      days INTEGER NOT NULL,
      tolerance_days INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pm_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL
    );

    CREATE TABLE IF NOT EXISTS checklist_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      department TEXT
    );

    CREATE TABLE IF NOT EXISTS checklists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      group_id INTEGER REFERENCES checklist_groups(id),
      version TEXT NOT NULL DEFAULT 'v1.0',
      status TEXT NOT NULL DEFAULT 'Active',
      fields_json TEXT NOT NULL,
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
  `);
}

// ---------- Seed ----------
function seed() {
  const hasUsers = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (hasUsers > 0) return; // already seeded

  const insertUser = db.prepare(`
    INSERT INTO users (user_id, name, email, password_hash, role, department, status)
    VALUES (?, ?, ?, ?, ?, ?, 'Active')
  `);
  const mkHash = (pw) => hashPassword(pw);

  // Admin password can be set via ADMIN_PASSWORD env var; falls back to 'admin123'.
  // In production set ADMIN_PASSWORD in Render's environment.
  const adminPw = process.env.ADMIN_PASSWORD || 'admin123';
  if (adminPw === 'admin123') {
    console.warn('[db] WARNING: seeding admin with default password "admin123" — set ADMIN_PASSWORD env var for production');
  }
  const users = [
    ['admin',     'Achyutha Reddy', 'achyutha2006@gmail.com', mkHash(adminPw),         'System Administrator', 'IT'],
    ['siyer',     'S. Iyer',        'siyer@ways.local',       mkHash('approver123'),  'Approver',             'Engineering'],
    ['rmehta',    'R. Mehta',       'rmehta@ways.local',      mkHash('reviewer123'),  'Reviewer',             'QA'],
    ['pkumar',    'P. Kumar',       'pkumar@ways.local',      mkHash('tech123'),      'Technician',           'Engineering - Mechanical'],
    ['krao',      'K. Rao',         'krao@ways.local',        mkHash('tech123'),      'Technician',           'Engineering - Electrical'],
    ['snaidu',    'S. Naidu',       'snaidu@ways.local',      mkHash('tech123'),      'Technician',           'HVAC'],
    ['mverma',    'M. Verma',       'mverma@ways.local',      mkHash('prod123'),      'Production',           'Production'],
    ['qaapprove', 'Q. Anand',       'qa@ways.local',          mkHash('qa123'),        'QA',                   'QA'],
    ['stores',    'Stores Officer', 'stores@ways.local',      mkHash('store123'),     'Warehouse',            'Warehouse'],
  ];
  for (const u of users) insertUser.run(...u);

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

  const cats = ['Mechanical','Electrical','Instrumentation','Utility','HVAC','Calibration','Lubrication','Safety'];
  for (const c of cats) ins('INSERT INTO pm_categories(name) VALUES (?)').run(c);

  const groups = [
    ['Granulation Equipment','Engineering - Mechanical'],
    ['Compression Machines','Engineering - Mechanical'],
    ['Coating Equipment','Engineering - Mechanical'],
    ['HVAC / Utilities','HVAC'],
    ['Capsule Filling','Engineering - Mechanical'],
  ];
  for (const g of groups) ins('INSERT INTO checklist_groups(name,department) VALUES (?,?)').run(...g);

  // A starter checklist
  const fbdChecklist = JSON.stringify([
    { id: 'q1', type: 'dropdown', label: 'Verify equipment is shut down and tagged out', options:['OK','Not OK'], required:true },
    { id: 'q2', type: 'dropdown', label: 'Inspect filter bag condition', options:['OK','Replace'], required:true },
    { id: 'q3', type: 'number',   label: 'Inlet air temperature (°C)', min:25, max:80, required:true },
    { id: 'q4', type: 'checkbox', label: 'Lubricated blower bearings', required:true },
    { id: 'q5', type: 'text',     label: 'Lubricant batch ID', required:true },
    { id: 'q6', type: 'text',     label: 'Remarks', required:false },
  ]);
  ins('INSERT INTO checklists(name,group_id,version,fields_json) VALUES (?,?,?,?)').run('FBD Monthly Mechanical',1,'v3.2',fbdChecklist);

  const rmgChecklist = JSON.stringify([
    { id: 'q1', type: 'dropdown', label: 'Power isolation done', options:['Yes','No'], required:true },
    { id: 'q2', type: 'number',   label: 'Motor amperage (A)', min:0, max:200, required:true },
    { id: 'q3', type: 'dropdown', label: 'Impeller condition', options:['OK','Worn'], required:true },
    { id: 'q4', type: 'text',     label: 'Remarks', required:false },
  ]);
  ins('INSERT INTO checklists(name,group_id,version,fields_json) VALUES (?,?,?,?)').run('RMG Weekly Electrical',1,'v2.1',rmgChecklist);

  const ahuChecklist = JSON.stringify([
    { id: 'q1', type: 'dropdown', label: 'Filter status', options:['OK','Replace'], required:true },
    { id: 'q2', type: 'number',   label: 'Differential pressure (Pa)', min:0, max:500, required:true },
    { id: 'q3', type: 'number',   label: 'Supply air flow (CFM)', min:0, max:20000, required:true },
    { id: 'q4', type: 'text',     label: 'Remarks', required:false },
  ]);
  ins('INSERT INTO checklists(name,group_id,version,fields_json) VALUES (?,?,?,?)').run('AHU Quarterly HVAC',4,'v1.4',ahuChecklist);

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

  // A completed PM with execution data
  const completedData = JSON.stringify({ q1:'OK', q2:'OK', q3:55, q4:true, q5:'LUB-2026-04-001', q6:'Routine PM completed without issues' });
  insSched.run('PM-2575','EQ-CAP-01', cl('FBD Monthly Mechanical'),'Monthly','Mechanical', fmt(addDays(today, -16)),'Engineering - Mechanical', u('snaidu'), u('rmehta'), u('siyer'), 'Completed', u('admin'));
  db.prepare(`UPDATE pm_schedules SET execution_data=?, started_at=?, completed_at=?, technician_sig=?, reviewer_sig=?, approver_sig=? WHERE pm_id='PM-2575'`)
    .run(completedData, fmt(addDays(today, -16))+' 09:15:00', fmt(addDays(today,-16))+' 11:20:00','S. Naidu','R. Mehta','S. Iyer');

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
    // wipe tables (in dependency-safe order)
    db.exec(`
      DROP TABLE IF EXISTS audit_log;
      DROP TABLE IF EXISTS breakdowns;
      DROP TABLE IF EXISTS pm_schedules;
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
    `);
  }
  createSchema();
  seed();
}

// Initialize on require
initAndSeed(false);

module.exports = { db, initAndSeed, hashPassword, verifyPassword };
