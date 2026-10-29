# AI Hospital Triage & Dispatcher

Node.js + Express + SQLite. Staff sign in with accounts created by the administrator; each role sees its own panel.
Demo / competition build. **Not clinically validated. Do not use for real patient care.**

## Run locally (VS Code)
1. Install Node.js 18 or newer.
2. Open this folder in VS Code, then open a terminal.
3. `npm install`
4. `npm start`  (or `npm run dev` to auto-restart on changes)
5. Open http://localhost:3000

On first start the app creates `triage.db` and three accounts. Default password is the username plus `12345`
(`nurse12345`, `doctor12345`, `admin12345`). Set `SEED_NURSE_PASSWORD`, `SEED_DOCTOR_PASSWORD` and `SEED_ADMIN_PASSWORD`
before the first start to choose your own, or change them later under Users and roles (Reset password).
Add `DEMO_SIM=1` to generate sample patients every 8 seconds for demos.

## Roles
| Role | Can do | Cannot see |
|---|---|---|
| Triage nurse | Intake with live automatic ESI preview, queue, override level (reason required), dispatch to unit | Admin screens |
| Emergency physician | Clinical briefs, timeline, matched terms, set In Treatment / Admitted / Discharged | Admin screens |
| Administrator | Create accounts, change roles, deactivate, reset passwords, audit log, analytics, routing and capacity settings | Patient text and clinical details (the server refuses) |

Roles are enforced on the server for every request, not just hidden in the browser.
A patient counts as **seen by staff** the first time a physician clicks **Mark as seen** or sets any status (In Treatment, Admitted, Discharged). The time and name are recorded, the wait clock stops, escalation alerts stop, and the Analytics "Seen by staff" and "Avg wait until seen" figures use it.
The public form on the login page (self-portal or paramedic) returns only a ticket number.

## Publish publicly (Render example)
1. Put this folder in a GitHub repository (`.gitignore` already excludes `node_modules`, `.env` and database files).
2. On render.com: New > Web Service > connect the repo.
   - Build command: `npm install`
   - Start command: `npm start`
3. Environment variables: `JWT_SECRET` (long random string), the three `SEED_*_PASSWORD` values, `DB_PATH=/var/data/triage.db`.
4. Add a **persistent disk** mounted at `/var/data`. Without one, SQLite data is erased on every redeploy or restart
   (fine for a quick demo, not for judging day). Railway and Fly.io work the same way with a volume.
5. Render provides HTTPS automatically. Open the URL, sign in as admin, and change the default passwords first.

## Before a real deployment (what is not covered)
- Needs clinical validation by clinicians; the rules in `triage.js` are a simplified demo.
- For several server instances or heavy load, replace SQLite with PostgreSQL.
- Add password-change for users, lockout and multi-factor sign-in, encrypted backups, and a compliance review (HIPAA, GDPR or local law).
- The board refreshes by polling every 3 seconds; use WebSockets for instant updates.

## Files
- `server.js` API, database, role checks, escalation job
- `triage.js` AI severity engine (rules)
- `public/` browser app (`index.html`, `app.js`, `style.css`)
