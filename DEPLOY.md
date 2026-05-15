# Deploying PMMS to Render.com

Step-by-step. The whole thing takes about 15 minutes the first time.

---

## Prerequisites (one-time)

- A **GitHub account** — sign up at <https://github.com> if you don't have one.
- **Git installed** locally — download from <https://git-scm.com/downloads>. Verify with `git --version` in a terminal.
- A **Render account** — sign up at <https://render.com> (free, can use GitHub login).

---

## Part 1 — Push the code to GitHub

### 1.1 Create an empty private repo on GitHub

- Go to <https://github.com/new>
- Repository name: `pmms` (or anything you like)
- Visibility: **Private** (keeps the seed data and admin defaults out of public view)
- Do **NOT** add a README, .gitignore, or license — we already have them
- Click **Create repository**

GitHub will show you a "quick setup" page with a URL like:
`https://github.com/<your-username>/pmms.git` — copy it.

### 1.2 Initialize the local git repo and push

Open a terminal (PowerShell or Command Prompt) inside the project folder
`C:\Users\Administrator\OneDrive - ways-automation.com\Documents\Claude\Projects\PMMS`
and run:

```bash
git init
git branch -M main
git add .
git status
```

Verify `git status` shows the source files but **not** `pmms.db` or `node_modules/`. If it does, the `.gitignore` is working correctly.

Now commit and push:

```bash
git commit -m "Initial PMMS app for Ways Automation"
git remote add origin https://github.com/<your-username>/pmms.git
git push -u origin main
```

GitHub will prompt for credentials. If it asks for a password, GitHub no longer accepts your account password — generate a **Personal Access Token** at <https://github.com/settings/tokens/new> with the `repo` scope, and paste the token where it asks for a password.

After the push, refresh the GitHub page; you should see all your files.

---

## Part 2 — Deploy to Render

### 2.1 Connect your repo

- Go to <https://dashboard.render.com>
- Click **New +** → **Blueprint** (this reads `render.yaml` from the repo)
- Click **Connect GitHub** if it's the first time, authorise Render to read your repo
- Pick the `pmms` repo from the list
- Render will detect `render.yaml` and propose creating:
  - **Web Service** named `pmms`
  - **Disk** named `pmms-data` (1 GB)
- Click **Apply**

### 2.2 Set the admin password

Before the first deploy finishes, set the admin password so it isn't `admin123`:

- In the Render dashboard, open the **pmms** service
- Go to **Environment** in the left sidebar
- Find `ADMIN_PASSWORD` (it's already declared in `render.yaml` with `sync: false`)
- Click **Edit** and set a strong password (at least 12 characters, mix of letters/numbers/symbols)
- Save — Render will redeploy automatically

### 2.3 Wait for the build

- Watch the **Logs** tab — you should see:
  ```
  npm install
  ...
  [db] using SQLite at /var/data/pmms.db
  [db] WARNING: seeding admin with default password "admin123" — set ADMIN_PASSWORD env var for production
        (this line goes away once ADMIN_PASSWORD is set and you redeploy)
  ==========================================
    PMMS server listening on port 10000 (production)
  ==========================================
  ```
- First build takes 3–5 minutes (npm install + better-sqlite3 native compile).

### 2.4 Open the app

- At the top of the service page Render shows the URL, like
  `https://pmms.onrender.com`
- Click it — you should see the PMMS login page with the Ways Automation logo.
- Sign in as `admin` with the password you set in step 2.2.

---

## Part 3 — After deploy

### Rotate other seeded passwords

The other demo users (`siyer`, `rmehta`, `pkumar`, etc.) are seeded with the demo passwords from the README. In production:

- Sign in as `admin`
- Open **User Management**
- Either delete those demo users or set them inactive
- Add real users with strong passwords

### Push updates

After the first deploy, every `git push` to `main` triggers Render to auto-redeploy. The persistent disk keeps your database between deploys.

### Reset the database (carefully)

If you ever need to start fresh:

- In Render → **pmms** service → **Shell**
- Run: `rm /var/data/pmms.db && exit`
- Render → **Manual Deploy** → **Deploy latest commit**

This wipes everything and re-seeds.

### Backups

- Render takes daily snapshots of the disk automatically.
- For an extra layer, you can run `sqlite3 /var/data/pmms.db ".backup /var/data/pmms-backup.db"` from the shell, or set up a scheduled job to upload `pmms.db` to S3 / Google Drive.

---

## Cost summary

At today's Render pricing:

- Starter web service: **~$7 / month**
- 1 GB persistent disk: **~$0.25 / month**
- HTTPS, automated TLS, custom domains, daily backups: included

Total: **~$7.25 / month**.

### Free-tier alternative (no disk, ephemeral)

If you'd rather start free:

1. Edit `render.yaml`:
   - Change `plan: starter` → `plan: free`
   - Comment out the entire `disk:` block
   - Change `DB_PATH` value to leave it blank (DB lands inside the container)
2. Push to GitHub — Render redeploys for free.
3. **Trade-off:** the SQLite file lives inside the container's writable filesystem; it's gone on every redeploy or after the free service sleeps. Good for a demo, not for real data.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `npm install` fails on `better-sqlite3` | Render auto-installs build tools — usually transient; click "Clear build cache & deploy" |
| App shows 502 / spins forever | Check the Logs tab; the server likely crashed at startup. Look for the error and patch the code. |
| Browser shows old logo / no logo | Hard-refresh with `Ctrl+Shift+R`. Browsers cache favicons aggressively. |
| Can't sign in after redeploy on free plan | Free plan has ephemeral disk — DB got wiped. Upgrade to Starter + disk, or accept demo-only. |
| Want a custom domain | Render → service → **Settings** → **Custom Domain**. Add `pmms.ways-automation.com`, then add a CNAME record at your DNS host pointing to the Render URL. HTTPS auto-issued in minutes. |

---

© 2026 Ways Automation
