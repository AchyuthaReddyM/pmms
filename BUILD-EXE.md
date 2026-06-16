# Building PMMS as a Windows .exe

This guide turns the PMMS source code into a single `PMMS.exe` you can hand to your testing team. Testers never see the source — it's compiled into V8 bytecode inside the .exe.

---

## What testers get

A single file: **`PMMS.exe`** (~50–80 MB).

Double-clicking it:
1. Starts the PMMS server on port 3000 inside their machine.
2. Creates a `pmms.db` file in the same folder as the .exe on first launch (with the seeded admin user + demo data).
3. Auto-opens their default browser at `http://localhost:3000`.
4. Console window stays open showing the LAN URL so others on the same network can connect.

When they close the console window, the server stops. Their data stays in `pmms.db`.

---

## Build prerequisites (one-time, on your dev machine)

You need **Node 20** locally to build (pkg targets Node 20 for stability — the resulting .exe still runs everywhere on Windows). If you have Node 22 installed, that's fine too — only the build machine needs Node, the testers don't need Node at all.

```bash
# In the PMMS project folder
npm install
```

This installs `@yao-pkg/pkg` (the maintained fork of vercel/pkg) as a dev dependency.

---

## Build the .exe

```bash
npm run build:exe
```

What this does:
- Runs `pkg . --targets node20-win-x64 --output dist/PMMS.exe --compress GZip`
- Compiles `server.js` and `db.js` into V8 bytecode bundled into the binary
- Embeds the `public/` folder (HTML, CSS, JS, logos) as assets
- Embeds the `better-sqlite3` native module so SQLite works on the tester's machine
- Compresses everything with GZip to keep the file size down

Output: **`dist/PMMS.exe`**

### Sanity check the build

```bash
dist\PMMS.exe
```

You should see:
```
[db] using SQLite at C:\path\to\dist\pmms.db
==========================================
  PMMS server listening on port 3000 (development)
  Open http://localhost:3000 in your browser
  Office LAN URL:
     http://192.168.1.50:3000
==========================================
```

Your default browser should open to the PMMS login page automatically. Sign in as `admin` / `admin123`.

Press `Ctrl+C` in the console (or close the window) to stop.

A `pmms.db` file will have appeared next to `PMMS.exe` — that's the database. To start fresh, delete that file and re-launch.

---

## Distribution options for the office testing team

### Option A — one tester per machine, isolated

Easiest. Give each tester a copy of `PMMS.exe`. They each get their own private database on their machine. Useful when each tester is verifying separate things and shouldn't interfere with the others' data.

**Hand them:** the `PMMS.exe` file (over USB, email, OneDrive, shared folder).
**They do:** put it in any folder, double-click. No installer, no admin rights needed.

### Option B — one shared server, many testers connect (Recommended)

You want EVERYONE to test against the same data — same equipment, same checklists, same assignments. Run PMMS.exe on ONE machine, every tester opens the URL in their browser.

**On the "server" machine (any Windows PC):**
1. Put `PMMS.exe` in `C:\PMMS\` (or wherever).
2. Double-click it. Note the **Office LAN URL** printed in the console (e.g. `http://192.168.1.50:3000`).
3. Leave the console window open. (Tip: minimize, don't close.)

**Give the testers:**
- That URL: `http://192.168.1.50:3000`
- Login credentials (`admin / admin123` or the per-role users seeded in the demo data).

**They do:** Open their browser, paste the URL, log in. Done. No software install on their end.

**Firewall:** the first time, Windows may ask "Allow PMMS to communicate on private networks". Click **Allow**.

### Option C — start at Windows boot (advanced)

If you want PMMS to start automatically when the host machine reboots:
1. Create a shortcut to `PMMS.exe`.
2. Press `Win + R`, type `shell:startup`, hit Enter.
3. Drop the shortcut into that folder.

Next reboot, PMMS launches in the background.

---

## Important production tips

**Change the admin password before handing it out.** The seeded `admin / admin123` is fine for an internal test but trivial. After the first launch:
1. Sign in as `admin`.
2. Go to **User Management → 🔑 Reset** on the admin row.
3. Set a strong password.

The default password warning in the console also goes away once you set the `ADMIN_PASSWORD` environment variable before launching (see below).

**Override defaults with env vars** (optional, set before launching):
- `PORT=8080` — listen on a different port if 3000 is taken.
- `DB_PATH=D:\PMMS-data\pmms.db` — keep the database in a specific folder (e.g. on a shared drive).
- `ADMIN_PASSWORD=YourStrongPassword` — seeded admin password instead of `admin123` (only matters on a fresh DB).
- `PMMS_NO_BROWSER=1` — don't auto-open the browser on startup (useful for the shared-server scenario).

Set them in a `start.bat` next to the .exe:
```bat
@echo off
set PORT=3000
set DB_PATH=D:\PMMS-data\pmms.db
set ADMIN_PASSWORD=ChangeMe-2026
set PMMS_NO_BROWSER=1
start "" PMMS.exe
```

Tester double-clicks `start.bat` instead of `PMMS.exe`.

---

## What about source-code exposure?

`PMMS.exe` contains:
- The Node.js v20 runtime (~30 MB)
- Your `server.js` and `db.js` compiled to **V8 bytecode** (not human-readable JS)
- The `public/` folder (HTML/CSS/JS — these are static front-end assets, visible to anyone who opens DevTools in their browser anyway; nothing sensitive lives here)
- The `better-sqlite3.node` native binary

A determined reverse-engineer with V8 bytecode tooling could partially recover logic, but for casual office distribution to a testing team this is more than sufficient. Your business logic stays inside the .exe; testers can't read or modify it.

If you ever need true IP protection: keep PMMS on a cloud server (Render, etc.) and have testers connect via HTTPS — that way they never touch the binary at all.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| "Windows protected your PC" on first launch | Click "More info" → "Run anyway". Happens to all unsigned executables. To eliminate, get a code signing certificate. |
| Build fails on `better-sqlite3` | Make sure you've run `npm install` first. If it still fails, delete `node_modules` and run `npm install` again. |
| Port 3000 already in use | Set `PORT=3001` (or any free port) in a start.bat before launching. |
| Tester can't reach the LAN URL | Their machine must be on the same Wi-Fi/network. Windows Firewall on the server machine must allow Node/PMMS through for private networks. |
| Database wiped between launches | Don't move `PMMS.exe` to a temp folder. Keep it (and its `pmms.db`) in a permanent location like `C:\PMMS\`. |
| Need to start fresh | Stop PMMS, delete `pmms.db` next to the exe, re-launch — DB reseeds. |
| `Error: The module ... was compiled against a different Node.js version` (NODE_MODULE_VERSION mismatch) when running the .exe | Your local `npm install` downloaded a `better-sqlite3` binary built for *your* Node version, but the .exe bundles Node 20. `npm run build:exe` now runs `scripts/prepare-pkg.js` first to download the right Node-20 binary — make sure you're running the full `build:exe` script (not `pkg .` directly). If the issue persists, delete `node_modules/better-sqlite3` and re-run `npm install`, then `npm run build:exe`. |

---

## What's NOT in the .exe

- No internet access required for the testers (entire app is self-contained except for the one CDN script for camera QR scanning, which falls back gracefully if offline).
- No installer, no registry entries, no admin rights.
- No telemetry.

Built as a single portable executable — drop it on any Windows 10/11 machine and it runs.

---

## Licensing (RSA-signed, machine-locked)

PMMS ships with an offline license system. Each `.exe` install is locked to one Windows machine using a hash of MachineGuid + C: volume serial. License keys are signed with RSA-2048 so they can't be forged without the private key (which never leaves your dev machine).

### One-time setup (you, the licensor)

```bash
pip install cryptography
python tools/make_keypair.py
```

This produces `tools/license_private.pem` (keep secret) and `tools/license_public.pem` (safe to commit/share). The script prints the public key — paste the body (between `-----BEGIN PUBLIC KEY-----` and `-----END PUBLIC KEY-----`) into `license.js` over the `__REPLACE_WITH_OUTPUT_FROM_make_keypair_py__` placeholder. Rebuild the exe.

Until the placeholder is replaced, licensing runs in "unconfigured" mode — the app starts unrestricted and prints a warning. After replacement, the app enforces a valid license at every API call when running as a packaged exe.

### Issuing a license for a customer

1. They install PMMS and double-click `PMMS.exe`. The license screen appears showing a 32-char fingerprint (e.g. `7a9f3c…`).
2. They email you the fingerprint.
3. You run:
   ```bash
   python tools/make_license.py
   ```
   It prompts for: fingerprint, expiry (`YYYY-MM-DD` or blank for perpetual), customer name, notes. Outputs a single-line key like:
   ```
   eyJ2IjoxLCJmcCI6IjdhOWYzYy…ZUUw==.cVdN2MlpY…dG8=
   ```
4. Email it back. The customer pastes it into the license screen → click Activate → the app reloads.

Every issued key is appended to `tools/licenses_issued.csv` (gitignored) so you have a paper trail.

### Where the license lives on the customer's machine

In a file named `license.txt` next to `PMMS.exe`. If they re-install, deleting `pmms.db` resets the database but `license.txt` survives. If they move the .exe to a different machine, the fingerprint won't match and the app will block with a clear error.

### Dev / cloud / non-packaged mode

When PMMS runs from source (`node server.js`) or on Render, licensing is automatically bypassed (the check uses `process.pkg` to detect packaging). To test the license screen locally, set `PMMS_ENFORCE_LICENSE=1` before starting the server.

### Renewing or replacing a license

The expiry date is checked at every page load. The app shows an amber banner when within 14 days of expiry. After expiry, every API call returns 402 and the license screen takes over — paste a fresh key to unlock. No service interruption beyond pasting the new key.

### What licensing does NOT protect

- A determined reverse-engineer can patch the binary to skip the `if (license.valid)` branch — RSA only prevents key forgery, not patching. For a stronger guarantee you'd need online activation/heartbeat (out of scope here).
- A perfect clone of the Windows install (same MachineGuid, same volume serial — e.g. a cloned disk image) will accept the same license.
- Clock rollback works around expiry. If you care, set up a Windows scheduled task to NTP-sync.

For internal pharma deployment to a known testing team, this is appropriate. For broad commercial distribution against active piracy, consider online activation instead.

### Quick threat-model reminder

| What's safe to commit / share | What's NEVER shared |
|---|---|
| `license.js` (contains public key) | `tools/license_private.pem` |
| `tools/license_public.pem` | The private key, on any medium |
| `tools/make_keypair.py` / `make_license.py` | `tools/licenses_issued.csv` |
| The compiled `PMMS.exe` | A copy of your dev machine |

If `license_private.pem` ever leaks, generate a new keypair, paste the new public key into license.js, rebuild, and re-issue every active license against the new keypair. Existing keys signed with the leaked private key will silently stop working on the rebuilt exe (the verify step fails).

---

© 2026 Ways Automation · PMMS
