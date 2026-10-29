(() => {
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const COL = { 1: '#d92d3a', 2: '#ef7d1a', 3: '#e8b923', 4: '#2f9e5b', 5: '#3b82c4' };
const NAME = { 1: 'Resuscitation', 2: 'Emergent', 3: 'Urgent', 4: 'Less urgent', 5: 'Non-urgent' };
const UNITS = ['Trauma / Resus', 'ICU', 'ER Main', 'Urgent Care', 'Fast Track'];
const ROLE = { nurse: 'Triage nurse', doctor: 'Emergency physician', admin: 'Administrator' };
const TABS = { nurse: [['queue', 'Triage queue']], doctor: [['queue', 'Clinical queue']], admin: [['ana', 'Analytics'], ['audit', 'Audit log'], ['users', 'Users and roles'], ['cfg', 'Routing and capacity']] };
const SAMPLES = [['Cardiac', '58M crushing chest pain radiating to left arm, sweating. HR 118, BP 92/60, SpO2 93'], ['Stroke', '72F sudden facial droop and slurred speech, weak on one side. BP 188/100'], ['Asthma', '24F wheezing, shortness of breath, cannot finish sentences. SpO2 89, RR 32'], ['Fracture', '16M fell off skateboard, suspected broken wrist, swelling'], ['Fever', '3 year old with fever and vomiting since yesterday. Temp 39.6'], ['Sprain', '31F twisted ankle playing basketball, mild swelling'], ['Trauma', '35M motorbike collision, severe bleeding from leg, HR 135, BP 82/50']];
let tok = sessionStorage.getItem('tok'), me = null, tab = '', sig = '', sel = null, openIds = new Set(), timer = null, tick = null, pv = 0, pvT = null;
const fmt = s => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
const badge = l => `<span class="lv" style="--c:${COL[l]};${l === 3 ? 'color:#1c1500' : ''}">${l}</span>`;

function toast(m, bad) { const d = document.createElement('div'); d.className = 'toast' + (bad ? ' bad' : ''); d.textContent = m; const t = $('#toasts'); t.append(d); while (t.children.length > 3) t.firstChild.remove(); setTimeout(() => d.remove(), 4500); }
async function api(path, method = 'GET', body) {
  const r = await fetch('/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && tok && path !== '/login') { signOut('Your session expired. Please sign in again.'); throw new Error(''); }
  if (!r.ok) throw new Error(j.error || 'Request failed');
  return j;
}
function signOut(msg) { tok = null; me = null; sessionStorage.removeItem('tok'); clearInterval(timer); clearInterval(tick); showLogin(msg); }

// ---------- Intake fields (shared by staff intake and the public form) ----------
function fields(p, srcs) {
  return `<label for="${p}-txt">Chief complaint and notes (free text)</label><textarea id="${p}-txt" placeholder="e.g. 58M crushing chest pain radiating to left arm. HR 118, BP 92/60, SpO2 93"></textarea>
<div class="g"><div><label for="${p}-age">Age</label><input id="${p}-age" type="number" min="0" max="120"></div><div><label for="${p}-src">Source</label><select id="${p}-src">${srcs.map(s => `<option>${s}</option>`).join('')}</select></div>
<div><label for="${p}-hr">Heart rate</label><input id="${p}-hr" type="number"></div><div><label for="${p}-bp">Systolic BP</label><input id="${p}-bp" type="number"></div>
<div><label for="${p}-o2">SpO2 %</label><input id="${p}-o2" type="number"></div><div><label for="${p}-rr">Resp. rate</label><input id="${p}-rr" type="number"></div>
<div><label for="${p}-tp">Temp °C</label><input id="${p}-tp" type="number" step="0.1"></div></div>`;
}
const IDS = ['txt', 'age', 'src', 'hr', 'bp', 'o2', 'rr', 'tp'];
const readF = p => Object.fromEntries(IDS.map(i => [i === 'txt' ? 'text' : i, $(`#${p}-${i}`).value]));
const clearF = p => IDS.forEach(i => { if (i !== 'src') $(`#${p}-${i}`).value = ''; });

// ---------- Login ----------
function showLogin(msg) {
  $('#app').innerHTML = `<div class="login"><section class="card"><h1>AI Triage Dispatcher</h1><p class="sub">Staff sign in. Accounts are created by your administrator.</p>
<label for="u">Username</label><input id="u" autocomplete="username"><label for="p">Password</label><input id="p" type="password" autocomplete="current-password">
<button class="p" id="li">Sign in</button><div class="err" id="lerr">${esc(msg || '')}</div></section>
<section class="card"><h2>Patient or paramedic intake</h2><p class="sub">No account needed. In a real emergency call your local emergency number.</p>${fields('pub', ['Self-portal', 'Paramedic'])}
<button class="p" id="pi">Send to triage</button><div class="err" id="pr" style="color:inherit"></div></section></div>`;
 const go = async () => { try { const j = await api('/login', 'POST', { username: $('#u').value, password: $('#p').value }); tok = j.token; sessionSave(); showApp(); } catch (e) { showLogin(e.message); } };
  $('#li').onclick = go; $('#p').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  $('#pi').onclick = async () => { try { const j = await api('/intake', 'POST', readF('pub')); $('#pr').innerHTML = `Received. Your ticket number is <b>#${j.ticket}</b>. Tell a staff member if your condition gets worse.`; clearF('pub'); } catch (e) { $('#pr').textContent = e.message; $('#pr').style.color = '#d92d3a'; } };
}

// ---------- App shell ----------
function showApp() {
  tab = TABS[me.role][0][0]; sig = '';
  $('#app').innerHTML = `<header><div><h1>AI Triage Dispatcher</h1><div class="sub">${esc(me.name)} · ${ROLE[me.role]}</div></div><button id="lo">Sign out</button></header>
<div class="page"><div id="stats"></div><div class="tabs" role="tablist">${TABS[me.role].map(([k, n]) => `<button role="tab" data-tab="${k}" aria-selected="${k === tab}">${n}</button>`).join('')}</div>
<div class="wrap ${me.role === 'nurse' ? 'side' : ''}">${me.role === 'nurse' ? '<section class="card" id="side"></section>' : ''}<section id="main"></section></div></div>`;
  $('#lo').onclick = () => { api('/me').catch(() => 0); signOut(); };
  document.querySelector('.tabs').onclick = e => { const k = e.target.dataset.tab; if (!k) return; tab = k; sig = ''; document.querySelectorAll('.tabs button').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === k)); load(true); };
  const m = $('#main'); m.addEventListener('click', onClick); m.addEventListener('change', onChange);
  m.addEventListener('toggle', e => { if (e.target.tagName === 'DETAILS') e.target.open ? openIds.add(+e.target.dataset.id) : openIds.delete(+e.target.dataset.id); }, true);
  if (me.role === 'nurse') buildIntake();
  load(true); timer = setInterval(load, 3000);
  tick = setInterval(() => document.querySelectorAll('[data-t]').forEach(e => e.textContent = fmt((Date.now() - e.dataset.t) / 1000)), 1000);
}

// ---------- Nurse intake with automatic ESI preview ----------
function buildIntake() {
  $('#side').innerHTML = `<h2>Digital intake portal</h2>${fields('n', ['Walk-in', 'Paramedic', 'Self-portal'])}<div id="prev" aria-live="polite"></div>
<button class="p" id="go">Triage patient</button><label>Load a sample case</label><div class="chips">${SAMPLES.map((s, i) => `<button data-s="${i}">${s[0]}</button>`).join('')}</div>`;
  const run = () => { clearTimeout(pvT); pvT = setTimeout(preview, 250); };
  IDS.forEach(i => $('#n-' + i).addEventListener('input', run));
  $('#n-txt').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('#go').click(); });
  $('#side').querySelector('.chips').onclick = e => { const i = e.target.dataset.s; if (i == null) return; $('#n-txt').value = SAMPLES[i][1]; run(); };
  $('#go').onclick = async () => { try { await api('/patients', 'POST', readF('n')); clearF('n'); preview(); toast('Patient triaged'); sig = ''; load(true); } catch (e) { toast(e.message, 1); } };
  preview();
}
async function preview() {
  const f = readF('n'), my = ++pv, el = $('#prev'); if (!el) return;
  if (f.text.trim().length < 3) { el.innerHTML = '<div class="sub" style="margin-top:10px">Type the health problem and the AI picks ESI 1 to 5 automatically.</div>'; return; }
  try {
    const r = await api('/preview', 'POST', f); if (my !== pv || !r) return;
    el.innerHTML = `<div class="card" style="margin-top:10px;border-left:6px solid ${COL[r.level]}"><div class="sub">Automatic triage result</div><div style="font-size:18px;font-weight:600;margin:2px 0">${badge(r.level)} ${NAME[r.level]}</div><div>Urgency ${r.score}/100 · route to <b>${esc(r.unit)}</b></div><div class="why">${r.marked}</div>${[...r.tags, ...r.flags].map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>`;
  } catch { /* ignore preview errors */ }
}

// ---------- Data loading and drawing ----------
async function load(force) {
  if (!me) return;
  try {
    const d = { sm: await api('/summary') };
    if (tab === 'queue') { d.pts = await api('/patients'); if (sel && d.pts.some(p => p.id === sel)) d.tl = await api(`/patients/${sel}/timeline`); else sel = null; }
    if (tab === 'audit') d.audit = await api('/audit');
    if (tab === 'users') d.users = await api('/users');
    if (tab === 'cfg') d.cfg = await api('/config');
    $('#stats').innerHTML = stats(d.sm);
    const s = JSON.stringify(d); if (s === sig && !force) return;
    const a = document.activeElement, m = $('#main');
    if (!force && a && m.contains(a) && /^(SELECT|INPUT|TEXTAREA)$/.test(a.tagName)) return; // never redraw while someone is using a control
    sig = s; m.innerHTML = views[tab](d);
  } catch (e) { if (e.message && me) console.warn(e.message); }
}
function stats(sm) {
  return `<div class="stats">${sm.byLevel.map((n, i) => `<div class="st" style="--c:${COL[i + 1]}"><b>${n}</b><span>ESI ${i + 1} · ${NAME[i + 1]}</span></div>`).join('')}<div class="st"><b>${sm.escalated}</b><span>Escalations</span></div><div class="st"><b>${sm.avgWait == null ? '-' : fmt(sm.avgWait)}</b><span>Avg wait until seen</span></div></div>
<div class="caps">${Object.entries(sm.cap).map(([g, c]) => { const n = sm.use[g] || 0, f = n >= c; return `<div class="cp${f ? ' full' : ''}"><b>${esc(g)}</b><div>${n} / ${c} beds${f ? ' · at capacity' : ''}</div><div class="bar"><i style="width:${Math.min(100, n / c * 100)}%;--c:${f ? '#d92d3a' : 'var(--ac)'}"></i></div></div>`; }).join('')}</div>`;
}
function acts(p) {
  if (me.role === 'nurse') return `<select data-act="ovr" data-id="${p.id}" aria-label="Override ESI level"><option value="">Override…</option>${[1, 2, 3, 4, 5].map(l => `<option value="${l}">ESI ${l}</option>`).join('')}</select><select data-act="disp" data-id="${p.id}" aria-label="Dispatch to"><option value="">Dispatch…</option>${UNITS.map(u => `<option>${u}</option>`).join('')}</select>`;
  return `<button data-act="open" data-id="${p.id}">Open</button>`;
}
function row(p) {
  const waiting = !p.seen, w = p.seen ? fmt((p.seen - p.created) / 1000) : `<span data-t="${p.created}">${fmt((Date.now() - p.created) / 1000)}</span>`;
  return `<tr class="row${p.esc && waiting ? ' esc' : ''}" style="--c:${COL[p.level]}"><td>${badge(p.level)}${p.overridden ? `<div class="sub">AI said ${p.aiLevel}</div>` : ''}</td>
<td><b>#${p.id}</b> ${p.age != null ? p.age + 'y' : ''}<div class="sub">${esc(p.src)} · ${esc(p.status)}${p.overridden ? ' · nurse override' : ''}</div><div class="sub">${p.seen ? `Seen by ${esc(p.seenBy)} at ${new Date(p.seen).toLocaleTimeString()}` : 'Not yet seen by staff'}</div>${p.tags.slice(0, 2).map(t => `<span class="tag">${esc(t)}</span>`).join('')}</td>
<td><b>${p.score}</b><div class="bar"><i style="width:${p.score}%;--c:${COL[p.level]}"></i></div></td><td>${esc(p.unit)}</td>
<td>${w}${p.esc && waiting ? `<div><span class="badge">Escalated${p.esc > 1 ? ' x' + p.esc : ''}</span></div>` : ''}</td>
<td><details data-id="${p.id}"${openIds.has(p.id) ? ' open' : ''}><summary>View brief</summary><div class="brief">${esc(p.brief)}<div class="why">${p.marked}</div><ul>${p.iv.map(i => `<li>${esc(i)}</li>`).join('')}</ul></div></details></td><td>${acts(p)}</td></tr>`;
}
function detail(d) {
  const p = (d.pts || []).find(x => x.id === sel); if (!p) return '';
  return `<div class="card" style="margin-bottom:12px;border-left:6px solid ${COL[p.level]}"><h3>Patient #${p.id}: ESI ${p.level}, urgency ${p.score}/100, ${esc(p.status)}</h3><p>${esc(p.brief)}</p>
<h4>Why the AI scored this way (matched terms highlighted)</h4><div class="why">${p.marked}</div><div>${[...p.tags, ...p.flags].map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>
<h4>Recommended immediate interventions</h4><ul>${p.iv.map(i => `<li>${esc(i)}</li>`).join('')}</ul>
<h4>Timeline</h4><table class="plain">${(d.tl || []).map(e => `<tr><td>${new Date(e.ts).toLocaleTimeString()}</td><td>${esc(e.actor)}</td><td>${esc(e.action)}: ${esc(e.detail)}</td></tr>`).join('')}</table>
<h4>Seen by staff</h4><div>${p.seen ? `Seen by ${esc(p.seenBy)} at ${new Date(p.seen).toLocaleTimeString()}` : `<button data-act="seen" data-id="${p.id}">Mark as seen</button><div class="sub">Stops the escalation alert. Setting any status below also counts as seen.</div>`}</div><h4>Handover and status</h4><div class="chips">${['In Treatment', 'Admitted', 'Discharged'].map(s => `<button data-act="st" data-id="${p.id}" data-v="${s}">${s}</button>`).join('')}</div></div>`;
}
const views = {
  queue: d => (me.role === 'doctor' ? detail(d) : '') + `<div class="card"><h2>ER command center</h2>${d.pts.length ? `<div class="scroll"><table><thead><tr><th>Level</th><th>Patient</th><th>Urgency</th><th>Route to</th><th>Wait</th><th>Clinical brief</th><th>Actions</th></tr></thead><tbody>${d.pts.map(row).join('')}</tbody></table></div>` : '<div class="empty">No patients waiting.</div>'}</div>`,
  ana: d => { const s = d.sm, mx = Math.max(1, ...s.arrivalsByLevel); return `<div class="card"><h2>Analytics</h2><div class="stats"><div class="st"><b>${s.total}</b><span>Total arrivals</span></div><div class="st"><b>${s.seen}</b><span>Seen by staff</span></div><div class="st"><b>${s.overrides}</b><span>Nurse overrides</span></div><div class="st"><b>${s.escalated}</b><span>Escalations</span></div></div><h4>Arrivals by AI-assigned ESI level</h4>${s.arrivalsByLevel.map((n, i) => `<div style="display:flex;align-items:center;gap:8px;margin:5px 0">${badge(i + 1)}<div class="bar" style="flex:1;width:auto;height:14px"><i style="width:${n / mx * 100}%;--c:${COL[i + 1]}"></i></div><b>${n}</b></div>`).join('')}</div>`; },
  audit: d => `<div class="card"><h2>Audit log (latest 300)</h2><div class="scroll" style="max-height:560px"><table class="plain"><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Patient</th><th>Detail</th></tr></thead><tbody>${d.audit.map(e => `<tr><td style="white-space:nowrap">${new Date(e.ts).toLocaleString()}</td><td>${esc(e.actor)}</td><td>${esc(e.action)}</td><td>${e.patient_id ? '#' + e.patient_id : ''}</td><td>${esc(e.detail)}</td></tr>`).join('')}</tbody></table></div></div>`,
  users: d => `<div class="card"><h2>User and role management</h2><div class="scroll"><table class="plain"><thead><tr><th>Username</th><th>Name</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>${d.users.map(u => `<tr><td>${esc(u.username)}</td><td>${esc(u.name)}</td><td><select data-act="ur" data-id="${u.id}">${Object.keys(ROLE).map(r => `<option value="${r}"${r === u.role ? ' selected' : ''}>${ROLE[r]}</option>`).join('')}</select></td><td>${u.active ? 'Active' : 'Deactivated'}</td><td><button data-act="ut" data-id="${u.id}" data-v="${u.active ? 0 : 1}">${u.active ? 'Deactivate' : 'Activate'}</button> <button data-act="up" data-id="${u.id}">Reset password</button></td></tr>`).join('')}</tbody></table></div>
<h4>Create a staff account</h4><div class="g"><div><label for="nu">Username</label><input id="nu" autocomplete="off"></div><div><label for="nn">Full name</label><input id="nn" autocomplete="off"></div><div><label for="nr">Role</label><select id="nr">${Object.keys(ROLE).map(r => `<option value="${r}">${ROLE[r]}</option>`).join('')}</select></div><div><label for="np">Temporary password (8+ characters)</label><input id="np" type="text" autocomplete="off"></div></div><button class="p" data-act="add">Create account</button><p class="sub">Give the staff member their username and temporary password. They sign in from the login page.</p></div>`,
  cfg: d => `<div class="card"><h2>Routing and capacity configuration</h2><p class="sub">A patient gets the level whose cutoff their urgency score reaches. Keep cutoffs in descending order.</p><div class="g">${d.cfg.th.map((v, i) => `<div><label>ESI ${i + 1}: score at or above</label><input type="number" min="1" max="100" data-th="${i}" value="${v}"></div>`).join('')}</div>
<h4>Bed capacity per unit</h4><div class="g">${Object.entries(d.cfg.cap).map(([g, v]) => `<div><label>${esc(g)}</label><input type="number" min="1" data-cap="${esc(g)}" value="${v}"></div>`).join('')}</div>
<h4>Escalation limit in seconds</h4><div class="g">${[1, 2, 3, 4, 5].map(l => `<div><label>ESI ${l}</label><input type="number" min="1" data-lim="${l}" value="${d.cfg.lim[l]}"></div>`).join('')}</div><button class="p" data-act="save">Save configuration</button></div>`
};

// ---------- Actions ----------
async function run(fn, okMsg) { try { const r = await fn(); if (okMsg) toast(okMsg); sig = ''; load(true); return r; } catch (e) { if (e.message) toast(e.message, 1); sig = ''; load(true); } }
function onClick(e) {
  const b = e.target.closest('button[data-act]'); if (!b) return; const { act, id, v } = b.dataset;
  if (act === 'open') { sel = +id; sig = ''; load(true); }
  else if (act === 'seen') run(() => api(`/patients/${id}/seen`, 'POST'), 'Marked as seen');
  else if (act === 'st') run(() => api(`/patients/${id}/status`, 'POST', { status: v }), 'Status updated');
  else if (act === 'ut') run(() => api(`/users/${id}`, 'PATCH', { active: +v }), 'Account updated');
  else if (act === 'up') { if (confirm('Reset this password? A temporary password will be shown once.')) run(async () => { const r = await api(`/users/${id}/reset`, 'POST'); alert('Temporary password (shown once): ' + r.temp); }); }
  else if (act === 'add') run(() => api('/users', 'POST', { username: $('#nu').value.trim().toLowerCase(), name: $('#nn').value, role: $('#nr').value, password: $('#np').value }), 'Account created');
  else if (act === 'save') {
    const th = [...document.querySelectorAll('[data-th]')].map(i => +i.value), cap = {}, lim = {};
    document.querySelectorAll('[data-cap]').forEach(i => cap[i.dataset.cap] = +i.value); document.querySelectorAll('[data-lim]').forEach(i => lim[i.dataset.lim] = +i.value);
    run(() => api('/config', 'PUT', { th, cap, lim }), 'Configuration saved');
  }
}
function onChange(e) {
  const t = e.target, { act, id } = t.dataset; if (!act || !t.value) return;
  if (act === 'ovr') { const reason = (prompt('Reason for overriding the AI level (required):') || '').trim(); t.blur(); if (reason.length < 3) { toast('Override cancelled: a reason is required.', 1); sig = ''; load(true); return; } run(() => api(`/patients/${id}/override`, 'POST', { level: t.value, reason }), 'Override saved'); }
  else if (act === 'disp') { t.blur(); run(() => api(`/patients/${id}/dispatch`, 'POST', { unit: t.value }), 'Patient dispatched'); }
  else if (act === 'ur') { t.blur(); run(() => api(`/users/${id}`, 'PATCH', { role: t.value }), 'Role updated'); }
}

// ---------- Start ----------
(async () => { if (tok) { try { me = await api('/me'); showApp(); return; } catch { /* fall through to login */ } } showLogin(); })();
})();
