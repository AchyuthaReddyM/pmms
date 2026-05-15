# PMMS — Preventive Maintenance & Breakdown Management System

A full-stack web application for pharmaceutical preventive maintenance, built for **Ways Automation**.

Stack: **Node.js + Express + SQLite** (single-file DB) + **vanilla JS frontend**. No build step.

---

## Quick start

### 1. Install Node.js (one-time)

Download and install Node 18+ from <https://nodejs.org>.

Verify in PowerShell / Command Prompt:

```
node --version
npm --version
```

### 2. Install dependencies

In the project folder (this folder), run:

```
npm install
```

This downloads `express`, `better-sqlite3`, and `bcryptjs`. First install may take 1–2 minutes because `better-sqlite3` compiles a small native binary for your platform.

### 3. Start the server

```
npm start
```

You should see:

```
==========================================
  PMMS server listening on port 3000
  Open http://localhost:3000 in your browser
  Default login:  admin / admin123
==========================================
```

### 4. Open the app

Go to **<http://localhost:3000>** in your browser.

On Windows, you can also double-click **`start.bat`** to run install + start in one shot.

---

## Default users (demo)

| User ID    | Password       | Role                  |
|------------|----------------|-----------------------|
| `admin`    | `admin123`     | System Administrator  |
| `siyer`    | `approver123`  | Approver              |
| `rmehta`   | `reviewer123`  | Reviewer (QA)         |
| `pkumar`   | `tech123`      | Technician (Mech.)    |
| `krao`     | `tech123`      | Technician (Elec.)    |
| `snaidu`   | `tech123`      | Technician (HVAC)     |
| `mverma`   | `prod123`      | Production            |
| `qaapprove`| `qa123`        | QA                    |
| `stores`   | `store123`     | Warehouse             |

Different roles can do different things — see the role checks in `server.js`.

---

## What works end-to-end

- **Auth** — bcrypt password hashing, server-side sessions stored in SQLite, 8-hour expiry.
- **Masters** — Plant, Block, Formulation, Location, Area, Equipment Registration. Plants, Blocks and Equipment support `+ New` from the UI.
- **Users** — list, add, lock/unlock.
- **PM Configuration** — Frequency Master, PM Categories, Checklist Groups; create new PM Schedules via a form.
- **PM Lifecycle** — Pending → Approved → Assigned → In Progress → Completed (with e-signature + checklist data persisted as JSON).
- **Breakdowns** — Log, update status, auto MTTR on close.
- **Calendar** — Live monthly view backed by `pm_schedules` table; click any event to open the PM.
- **Reports** — Overdue list and Equipment History.
- **Audit Trail** — Every CREATE / UPDATE / APPROVE / START / COMPLETE / LOGIN / LOGOUT is recorded immutably.

---

## Project layout

```
PMMS/
├── package.json          npm metadata + scripts
├── server.js             Express server + all REST routes
├── db.js                 SQLite schema + seed
├── pmms.db               SQLite database (auto-created on first run)
├── start.bat             Windows: npm install && npm start
├── start.sh              Linux / macOS: install && start
├── README.md             this file
├── .gitignore
└── public/
    ├── index.html        Frontend shell (sidebar + 13 pages)
    ├── styles.css        Theme + components
    └── app.js            All frontend logic (fetch + render)
```

---

## API surface

| Method | Path                                | Description                          |
|--------|-------------------------------------|--------------------------------------|
| POST   | `/api/auth/login`                   | Sign in, returns `{ token, user }`   |
| POST   | `/api/auth/logout`                  | Sign out                             |
| GET    | `/api/auth/me`                      | Current user                         |
| GET    | `/api/dashboard/kpis`               | Compliance %, overdue, pending, etc. |
| GET    | `/api/dashboard/compliance-by-dept` | Department-wise compliance           |
| GET/POST/PUT | `/api/plants`                 | Plant master                         |
| GET/POST | `/api/blocks`                     | Block master                         |
| GET    | `/api/formulations`                 | Formulation master                   |
| GET    | `/api/locations`                    | Location master                      |
| GET    | `/api/areas`                        | Area master                          |
| GET/POST/PUT | `/api/equipment`              | Equipment registration               |
| GET/POST | `/api/users`                      | User management                      |
| PUT    | `/api/users/:user_id/status`        | Lock / unlock                        |
| GET    | `/api/frequencies`                  | PM frequencies                       |
| GET    | `/api/pm-categories`                | PM categories                        |
| GET    | `/api/checklist-groups`             | Checklist groups                     |
| GET    | `/api/checklists` / `/:id`          | Checklists with fields               |
| GET/POST | `/api/pm`                         | PM schedule list / create            |
| GET    | `/api/pm/:pm_id`                    | One PM with checklist fields         |
| PUT    | `/api/pm/:pm_id/approve`            | Approve                              |
| PUT    | `/api/pm/:pm_id/assign`             | Assign technician                    |
| PUT    | `/api/pm/:pm_id/start`              | Start execution                      |
| PUT    | `/api/pm/:pm_id/complete`           | Submit checklist + e-sig             |
| GET/POST/PUT | `/api/breakdowns`             | Breakdown log                        |
| GET    | `/api/audit`                        | Audit trail                          |
| GET    | `/api/calendar?year=&month=`        | Calendar events                      |
| GET    | `/api/reports/overdue`              | Overdue report                       |
| GET    | `/api/reports/equipment-history/:id`| Equipment history                    |

All endpoints other than `/api/auth/login` require an `X-Session-Token` header.

---

## Reset the database

To wipe and reseed:

```
npm run reset
```

This deletes `pmms.db` and recreates it with fresh seed data.

---

## Compliance notes

This is a working application but **not validated** for GMP / 21 CFR Part 11 use. For regulated production use you must run formal IQ / OQ / PQ validation, harden the auth (HTTPS + cookies + CSRF), and add full role/permission matrix testing.

© 2026 Ways Automation
