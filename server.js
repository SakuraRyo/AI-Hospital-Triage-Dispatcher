const express = require('express'), Database = require('better-sqlite3'), bcrypt = require('bcryptjs'),
  jwt = require('jsonwebtoken'), helmet = require('helmet'), rateLimit = require('express-rate-limit'),
  crypto = require('crypto'), path = require('path');
const { triage, mark, levelOf } = require('./triage');

const SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.JWT_SECRET) console.warn('WARNING: JWT_SECRET not set. Sessions reset on every restart. Set it in production.');

// ---------- Database ----------
const db = new Database(process.env.DB_PATH || path.join(__dirname, 'triage.db'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('nurse','doctor','admin')), pass_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS patients(id INTEGER PRIMARY KEY, text TEXT NOT NULL, age INTEGER, src TEXT, vitals TEXT, base_score INTEGER, score INTEGER, level INTEGER, ai_level INTEGER, unit TEXT, status TEXT DEFAULT 'Waiting', tags TEXT, flags TEXT, iv TEXT, brief TEXT, esc INTEGER DEFAULT 0, overridden INTEGER DEFAULT 0, created_at INTEGER, treated_at INTEGER);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, patient_id INTEGER, detail TEXT);
CREATE TABLE IF NOT EXISTS config(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_pat_status ON patients(status);
CREATE INDEX IF NOT EXISTS idx_audit_pat ON audit(patient_id);
`);
// "Seen by staff" = the first moment a clinician acts on the patient (Mark as seen, or any status update).
for (const col of ['seen_at INTEGER', 'seen_by TEXT']) { try { db.exec('ALTER TABLE patients ADD COLUMN ' + col); } catch { /* column already exists */ } }
db.exec('UPDATE patients SET seen_at=treated_at WHERE seen_at IS NULL AND treated_at IS NOT NULL');
if (!db.prepare('SELECT 1 FROM users').get()) {
  const ins = db.prepare('INSERT INTO users(username,name,role,pass_hash) VALUES (?,?,?,?)');
  [['nurse', 'Maria Santos', 'nurse'], ['doctor', 'Dr. Reyes', 'doctor'], ['admin', 'Admin Cruz', 'admin']].forEach(([u, n, r]) =>
    ins.run(u, n, r, bcrypt.hashSync(process.env['SEED_' + u.toUpperCase() + '_PASSWORD'] || u + '12345', 10)));
  console.log('Seeded demo accounts: nurse / doctor / admin (default password = username + 12345). CHANGE THESE.');
}
const DEF = { th: [85, 65, 40, 20], cap: { 'Trauma / Resus': 4, 'ICU': 6, 'ER Main': 12, 'Urgent Care': 10 }, lim: { 1: 10, 2: 25, 3: 50, 4: 80, 5: 110 } };
const getCfg = () => { const r = db.prepare("SELECT value FROM config WHERE key='cfg'").get(); return r ? { ...DEF, ...JSON.parse(r.value) } : DEF; };
const setCfg = c => db.prepare("INSERT INTO config(key,value) VALUES('cfg',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(c));
const log = (actor, action, pid, detail) => db.prepare('INSERT INTO audit(ts,actor,action,patient_id,detail) VALUES(?,?,?,?,?)').run(Date.now(), actor, action, pid || null, detail || '');
const grp = u => u.startsWith('Trauma') ? 'Trauma / Resus' : u.startsWith('ICU') ? 'ICU' : u.startsWith('ER') ? 'ER Main' : 'Urgent Care';

// ---------- Helpers ----------
class Bad extends Error { constructor(m, s = 400) { super(m); this.status = s; } }
const SRC = ['Walk-in', 'Paramedic', 'Self-portal'], UNITS = ['Trauma / Resus', 'ICU', 'ER Main', 'Urgent Care', 'Fast Track'], STATUS = ['In Treatment', 'Admitted', 'Discharged'];
const nm = (v, lo, hi) => { const x = parseFloat(v); return Number.isFinite(x) && x >= lo && x <= hi ? x : null; };
function clean(b, forceSrc) {
  const text = String(b.text || '').trim().slice(0, 2000);
  if (text.length < 3) throw new Bad('Describe the complaint (at least 3 characters).');
  return { text, age: nm(b.age, 0, 120), src: forceSrc || (SRC.includes(b.src) ? b.src : 'Walk-in'), hr: nm(b.hr, 10, 300), bp: nm(b.bp, 30, 300), o2: nm(b.o2, 30, 100), rr: nm(b.rr, 2, 80), tp: nm(b.tp, 25, 45) };
}
function createPatient(o) {
  const r = triage(o.text, o, getCfg().th);
  const id = db.prepare(`INSERT INTO patients(text,age,src,vitals,base_score,score,level,ai_level,unit,tags,flags,iv,brief,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(o.text, r.age, o.src, JSON.stringify(r.vitals), r.score, r.score, r.level, r.level, r.unit, JSON.stringify(r.tags), JSON.stringify(r.flags), JSON.stringify(r.iv), r.brief, Date.now()).lastInsertRowid;
  log('AI engine', 'TRIAGE', id, `ESI ${r.level}, urgency ${r.score}, routed to ${r.unit} (source: ${o.src})`);
  return id;
}
const pub = p => ({ id: p.id, age: p.age, src: p.src, status: p.status, level: p.level, aiLevel: p.ai_level, score: p.score, unit: p.unit, tags: JSON.parse(p.tags), flags: JSON.parse(p.flags), iv: JSON.parse(p.iv), brief: p.brief, marked: mark(p.text), esc: p.esc, overridden: !!p.overridden, created: p.created_at, treated: p.treated_at, seen: p.seen_at, seenBy: p.seen_by });
const pid = q => { const id = parseInt(q.params.id, 10); const p = db.prepare('SELECT * FROM patients WHERE id=?').get(id); if (!p) throw new Bad('Patient not found.', 404); return p; };

// ---------- App ----------
const app = express();
app.set('trust proxy', 1);
app.use(helmet());
app.use(express.json({ limit: '50kb' }));
const limiter = (max, windowMs) => rateLimit({ windowMs, max, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests. Try again later.' } });

// Server-side RBAC: every protected route checks the signed token AND the user's current role in the database.
const auth = (...roles) => (q, s, next) => {
  let u;
  try {
    const { id } = jwt.verify((q.headers.authorization || '').replace('Bearer ', ''), SECRET);
    u = db.prepare('SELECT id,username,name,role,active FROM users WHERE id=?').get(id);
  } catch { /* fall through */ }
  if (!u || !u.active) return s.status(401).json({ error: 'Please sign in.' });
  if (roles.length && !roles.includes(u.role)) return s.status(403).json({ error: 'Your role cannot do this.' });
  q.user = u; next();
};

app.post('/api/login', limiter(10, 15 * 60 * 1000), (q, s) => {
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(String(q.body.username || '').toLowerCase().trim());
  if (!u || !u.active || !bcrypt.compareSync(String(q.body.password || ''), u.pass_hash)) { log(String(q.body.username || '?').slice(0, 40), 'LOGIN_FAILED'); throw new Bad('Wrong username or password.', 401); }
  log(u.name, 'LOGIN', null, u.role);
  s.json({ token: jwt.sign({ id: u.id }, SECRET, { expiresIn: '8h' }), user: { name: u.name, role: u.role } });
});
app.get('/api/me', auth(), (q, s) => s.json({ name: q.user.name, role: q.user.role }));

// Public self-portal / paramedic intake: returns a ticket number only, never patient data.
app.post('/api/intake', limiter(20, 60 * 1000), (q, s) => {
  const id = createPatient(clean(q.body, SRC.includes(q.body.src) && q.body.src !== 'Walk-in' ? q.body.src : 'Self-portal'));
  s.json({ ticket: id });
});

// Patients (clinical roles only; administrators never receive patient text)
app.get('/api/patients', auth('nurse', 'doctor'), (q, s) =>
  s.json(db.prepare("SELECT * FROM patients WHERE status IN ('Waiting','In Treatment') ORDER BY score DESC, created_at").all().map(pub)));
app.post('/api/patients', auth('nurse'), (q, s) => { const id = createPatient(clean(q.body)); log(q.user.name, 'INTAKE', id, 'Entered by staff'); s.json({ id }); });
app.get('/api/patients/:id/timeline', auth('nurse', 'doctor'), (q, s) => { const p = pid(q); s.json(db.prepare('SELECT ts,actor,action,detail FROM audit WHERE patient_id=? ORDER BY ts').all(p.id)); });
app.post('/api/patients/:id/override', auth('nurse'), (q, s) => {
  const p = pid(q), lvl = parseInt(q.body.level, 10), reason = String(q.body.reason || '').trim().slice(0, 300);
  if (!(lvl >= 1 && lvl <= 5)) throw new Bad('Level must be 1 to 5.');
  if (reason.length < 3) throw new Bad('A reason is required for an override.');
  db.prepare('UPDATE patients SET level=?, overridden=1 WHERE id=?').run(lvl, p.id);
  log(q.user.name, 'OVERRIDE', p.id, `ESI ${p.level} to ${lvl} (AI said ${p.ai_level}, score ${p.base_score}). Reason: ${reason}`); s.json({ ok: 1 });
});
app.post('/api/patients/:id/dispatch', auth('nurse'), (q, s) => {
  const p = pid(q); if (!UNITS.includes(q.body.unit)) throw new Bad('Unknown unit.');
  db.prepare('UPDATE patients SET unit=? WHERE id=?').run(q.body.unit, p.id);
  log(q.user.name, 'DISPATCH', p.id, `Sent to ${q.body.unit} (was ${p.unit})`); s.json({ ok: 1 });
});
app.post('/api/patients/:id/status', auth('doctor'), (q, s) => {
  const p = pid(q); if (!STATUS.includes(q.body.status)) throw new Bad('Unknown status.');
  const now = Date.now();
  db.prepare("UPDATE patients SET status=?, treated_at=COALESCE(treated_at,?), seen_at=COALESCE(seen_at,?), seen_by=COALESCE(seen_by,?) WHERE id=?").run(q.body.status, now, now, q.user.name, p.id);
  log(q.user.name, 'STATUS', p.id, q.body.status); s.json({ ok: 1 });
});

// Live preview for the intake form: runs the AI engine without saving anything.
app.post('/api/preview', auth('nurse'), limiter(300, 60 * 1000), (q, s) => {
  if (String(q.body.text || '').trim().length < 3) return s.json(null);
  const o = clean(q.body), r = triage(o.text, o, getCfg().th);
  s.json({ level: r.level, score: r.score, unit: r.unit, tags: r.tags, flags: r.flags, marked: mark(o.text) });
});

app.post('/api/patients/:id/seen', auth('doctor'), (q, s) => {
  const p = pid(q); if (p.seen_at) return s.json({ ok: 1 });
  db.prepare('UPDATE patients SET seen_at=?, seen_by=? WHERE id=?').run(Date.now(), q.user.name, p.id);
  log(q.user.name, 'SEEN', p.id, `Seen by clinician after ${Math.round((Date.now() - p.created_at) / 1000)}s`); s.json({ ok: 1 });
});

// Summary: counts only, no patient details (safe for every role)
app.get('/api/summary', auth(), (q, s) => {
  const act = db.prepare("SELECT level,unit FROM patients WHERE status IN ('Waiting','In Treatment')").all(), cfg = getCfg(), use = {};
  act.forEach(p => { const g = grp(p.unit); use[g] = (use[g] || 0) + 1; });
  const tot = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(esc),0) e FROM patients').get();
  const seen = db.prepare('SELECT COUNT(*) n, AVG((seen_at-created_at)/1000.0) w FROM patients WHERE seen_at IS NOT NULL').get();
  const arr = db.prepare('SELECT ai_level l, COUNT(*) n FROM patients GROUP BY ai_level').all();
  s.json({ byLevel: [1, 2, 3, 4, 5].map(l => act.filter(p => p.level === l).length), arrivalsByLevel: [1, 2, 3, 4, 5].map(l => (arr.find(a => a.l === l) || { n: 0 }).n),
    cap: cfg.cap, use, total: tot.n, escalated: tot.e, seen: seen.n, avgWait: seen.w, overrides: db.prepare("SELECT COUNT(*) n FROM audit WHERE action='OVERRIDE'").get().n });
});

// Administration
app.get('/api/audit', auth('admin'), (q, s) => s.json(db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 300').all()));
app.get('/api/config', auth('admin'), (q, s) => s.json(getCfg()));
app.put('/api/config', auth('admin'), (q, s) => {
  const c = getCfg(), { th, cap, lim } = q.body;
  if (th) { if (!Array.isArray(th) || th.length !== 4 || th.some(v => !(v >= 1 && v <= 100)) || th.some((v, i) => i && th[i - 1] <= v)) throw new Bad('Cutoffs must be 4 numbers, 1 to 100, in descending order.'); c.th = th.map(Number); }
  if (cap) for (const k of Object.keys(c.cap)) if (cap[k] != null) { if (!(cap[k] >= 1 && cap[k] <= 500)) throw new Bad('Capacity must be 1 to 500.'); c.cap[k] = parseInt(cap[k], 10); }
  if (lim) for (const k of [1, 2, 3, 4, 5]) if (lim[k] != null) { if (!(lim[k] >= 1 && lim[k] <= 86400)) throw new Bad('Escalation limit must be 1 to 86400 seconds.'); c.lim[k] = parseInt(lim[k], 10); }
  setCfg(c); log(q.user.name, 'CONFIG', null, JSON.stringify({ th: c.th, cap: c.cap, lim: c.lim })); s.json(c);
});
app.get('/api/users', auth('admin'), (q, s) => s.json(db.prepare('SELECT id,username,name,role,active FROM users ORDER BY id').all()));
app.post('/api/users', auth('admin'), (q, s) => {
  const { username, name, role, password } = q.body;
  if (!/^[a-z0-9._-]{3,30}$/.test(username || '')) throw new Bad('Username: 3 to 30 lowercase letters, digits, dot, dash or underscore.');
  if (!String(name || '').trim() || !['nurse', 'doctor', 'admin'].includes(role)) throw new Bad('Name and a valid role are required.');
  if (String(password || '').length < 8) throw new Bad('Password must be at least 8 characters.');
  try { db.prepare('INSERT INTO users(username,name,role,pass_hash) VALUES (?,?,?,?)').run(username, String(name).trim().slice(0, 60), role, bcrypt.hashSync(password, 10)); }
  catch { throw new Bad('That username already exists.'); }
  log(q.user.name, 'USER_CREATED', null, `${username} (${role})`); s.json({ ok: 1 });
});
app.patch('/api/users/:id', auth('admin'), (q, s) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(parseInt(q.params.id, 10));
  if (!u) throw new Bad('User not found.', 404); if (u.id === q.user.id) throw new Bad('You cannot change your own account.');
  if (q.body.role) { if (!['nurse', 'doctor', 'admin'].includes(q.body.role)) throw new Bad('Invalid role.'); db.prepare('UPDATE users SET role=? WHERE id=?').run(q.body.role, u.id); log(q.user.name, 'ROLE_CHANGED', null, `${u.username}: ${u.role} to ${q.body.role}`); }
  if (q.body.active != null) { db.prepare('UPDATE users SET active=? WHERE id=?').run(q.body.active ? 1 : 0, u.id); log(q.user.name, q.body.active ? 'USER_ACTIVATED' : 'USER_DEACTIVATED', null, u.username); }
  s.json({ ok: 1 });
});
app.post('/api/users/:id/reset', auth('admin'), (q, s) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(parseInt(q.params.id, 10)); if (!u) throw new Bad('User not found.', 404);
  const temp = crypto.randomBytes(6).toString('base64url');
  db.prepare('UPDATE users SET pass_hash=? WHERE id=?').run(bcrypt.hashSync(temp, 10), u.id);
  log(q.user.name, 'PASSWORD_RESET', null, u.username); s.json({ temp });
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', (q, s) => s.status(404).json({ error: 'Not found.' }));
app.use((e, q, s, n) => { if (!e.status) console.error(e); s.status(e.status || 500).json({ error: e.status ? e.message : 'Server error.' }); });

// ---------- Background jobs ----------
// Auto-escalation: a waiting patient who passes the limit for their level is flagged and gets a higher urgency score.
setInterval(() => {
  const cfg = getCfg();
  for (const p of db.prepare("SELECT * FROM patients WHERE status='Waiting' AND seen_at IS NULL").all()) {
    const n = Math.floor((Date.now() - p.created_at) / 1000 / cfg.lim[p.level]);
    if (n > p.esc) {
      const score = Math.min(100, p.base_score + 8 * n), lvl = p.overridden ? p.level : Math.min(p.level, levelOf(score, cfg.th));
      db.prepare('UPDATE patients SET esc=?, score=?, level=? WHERE id=?').run(n, score, lvl, p.id);
      log('AI engine', 'ESCALATION', p.id, `Waited past limit (x${n}). Urgency ${score}, ESI ${lvl}. Notify charge nurse.`);
    }
  }
}, 5000);

// Optional demo traffic: set DEMO_SIM=1 to add a sample patient every 8 seconds (max 15 waiting).
if (process.env.DEMO_SIM === '1') {
  const S = ['58M crushing chest pain radiating to left arm, sweating. HR 118, BP 92/60, SpO2 93', '72F sudden facial droop and slurred speech, weak on one side. BP 188/100', '24F wheezing, shortness of breath. SpO2 89, RR 32',
    '16M fell off skateboard, suspected broken wrist, swelling', '3 year old with fever and vomiting since yesterday. Temp 39.6', '31F twisted ankle playing basketball, mild swelling', '45M small cut on finger from kitchen knife', '35M motorbike collision, severe bleeding from leg, HR 135, BP 82/50'];
  setInterval(() => { if (db.prepare("SELECT COUNT(*) n FROM patients WHERE status='Waiting'").get().n < 15) createPatient(clean({ text: S[Math.floor(Math.random() * S.length)], src: 'Walk-in' })); }, 8000);
}

app.listen(process.env.PORT || 3000, () => console.log('Triage system running on port ' + (process.env.PORT || 3000)));
