// Rule-based clinical triage engine. Demo only: NOT clinically validated.
// Rule format: [regex, weight, tag, unit, interventions]
const R = [
[/cardiac arrest|not breathing|no pulse|unresponsive|unconscious|pulseless/,100,'Arrest / unresponsive','Trauma / Resus',['Start CPR and attach defibrillator','Secure airway, IV/IO access','Call resuscitation team']],
[/anaphyla|throat (swelling|closing)|choking|can.?t breathe/,95,'Airway threat','Trauma / Resus',['Airway management now','IM epinephrine if allergic reaction','Oxygen, continuous monitoring']],
[/severe bleeding|hemorrhag|haemorrhag|gunshot|stab|major trauma|crush injury|crushed/,92,'Major trauma / bleeding','Trauma / Resus',['Direct pressure, control bleeding','Two large-bore IVs, type and crossmatch','Alert trauma surgeon']],
[/seizure|convuls|status epilepticus/,88,'Seizure','Trauma / Resus',['Protect airway, note onset time','Check glucose','Benzodiazepine per protocol if ongoing']],
[/stroke|facial droop|face droop|slurred|one.?sided weak|sudden (numb|weak|vision)|can.?t speak|aphasia/,82,'Stroke signs','ICU / Stroke unit',['Note last-known-well time','Stat CT head, check glucose','Activate stroke team']],
[/chest pain|chest pressure|crushing|tightness in (the )?chest|radiating to (the )?(left )?(arm|jaw)/,78,'Possible cardiac event','ICU / Cardiac',['12-lead ECG within 10 minutes','IV access, troponin, aspirin if no contraindication','Continuous cardiac monitoring']],
[/overdose|poison|ingest|suicid/,76,'Overdose / self-harm risk','ICU / Resus',['Identify substance and time taken','Poison control, consider naloxone','Constant observation']],
[/shortness of breath|difficulty breathing|wheez|breathless|asthma/,70,'Respiratory distress','ER Main (monitored)',['Oxygen to keep SpO2 above 94%','Nebuliser if wheeze','Chest X-ray, ABG as needed']],
[/head injury|hit (his|her|their) head|concussion|lost consciousness|fainted|syncope/,66,'Head injury / syncope','ER Main (monitored)',['Neuro checks and GCS','ECG, glucose','CT head if criteria met']],
[/pregnan.*(bleed|pain)|vaginal bleeding/,68,'Obstetric concern','ER Main (monitored)',['Fetal heart check','Rh status and IV access','Notify obstetrics']],
[/severe (abdominal|stomach)|appendic|rigid abdomen|vomiting blood|black stool/,58,'Acute abdomen / GI bleed','ER Main',['NPO, IV fluids','Bloods and imaging','Surgical review']],
[/high fever|fever|dehydrat|vomiting|diarrh|infection|burn/,42,'Infection / dehydration','ER Main',['Temperature and vitals recheck','IV fluids if dehydrated','Bloods, urine, cultures if septic']],
[/fracture|broken|dislocat|deep cut|laceration|open wound/,38,'Possible fracture / wound','ER Main',['Immobilise, analgesia','X-ray','Wound irrigation, tetanus status']],
[/migraine|headache|ear ?ache|uti|urinary|back pain|abdominal pain|stomach/,28,'Moderate pain','Urgent Care',['Analgesia and reassess','Urinalysis if urinary','Discharge advice or review']],
[/sprain|twisted|strain|bruise|minor cut|small cut|rash|sore throat|cold|cough|insect bite|splinter/,12,'Minor injury / illness','Urgent Care',['Rest, ice, elevation or simple dressing','Over-the-counter analgesia','Self-care advice']]];

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const levelOf = (s, th) => s >= th[0] ? 1 : s >= th[1] ? 2 : s >= th[2] ? 3 : s >= th[3] ? 4 : 5;
const num = (t, re) => { const m = t.match(re); return m ? parseFloat(m[1]) : null; };

function triage(text, o, th) {
  const t = text.toLowerCase();
  const v = {
    hr: o.hr ?? num(t, /(?:hr|heart rate|pulse)\D{0,3}(\d{2,3})/),
    bp: o.bp ?? num(t, /(?:bp|b\/p)\D{0,3}(\d{2,3})\s*\/\s*\d{2,3}/),
    o2: o.o2 ?? num(t, /(?:spo2|sat|o2)\D{0,3}(\d{2,3})/),
    rr: o.rr ?? num(t, /(?:rr|resp(?:iratory)? rate)\D{0,3}(\d{2})/),
    tp: o.tp ?? num(t, /(?:temp|temperature)\D{0,3}(\d{2}(?:\.\d)?)/)
  };
  const age = o.age ?? num(t, /(\d{1,3})\s*(?:y\/?o|yo|year|yr|m\b|f\b|-year)/);
  const hits = R.filter(r => r[0].test(t));
  let s = hits.length ? hits[0][1] + Math.min(10, (hits.length - 1) * 4) : 10;
  const flags = [];
  const add = (c, p, f) => { if (c) { s += p; flags.push(f); } };
  add(v.o2 != null && v.o2 < 90, 28, 'SpO2 ' + v.o2 + ' (critical)');
  add(v.o2 != null && v.o2 >= 90 && v.o2 < 94, 14, 'SpO2 ' + v.o2 + ' (low)');
  add(v.hr != null && (v.hr > 130 || v.hr < 45), 20, 'HR ' + v.hr + ' (extreme)');
  add(v.hr != null && v.hr > 110 && v.hr <= 130, 10, 'HR ' + v.hr + ' (high)');
  add(v.bp != null && v.bp < 90, 25, 'SBP ' + v.bp + ' (hypotension)');
  add(v.bp != null && v.bp > 180, 12, 'SBP ' + v.bp + ' (severe hypertension)');
  add(v.rr != null && v.rr > 30, 15, 'RR ' + v.rr + ' (extreme)');
  add(v.rr != null && v.rr > 24 && v.rr <= 30, 8, 'RR ' + v.rr + ' (high)');
  add(v.tp != null && v.tp >= 39.5, 10, 'Temp ' + v.tp + ' C');
  add(age != null && (age < 1 || age >= 75), 8, age < 1 ? 'Infant' : 'Age ' + age + ' (high risk)');
  s = Math.max(0, Math.min(100, Math.round(s)));
  const level = levelOf(s, th), top = hits[0];
  const unit = level === 1 ? 'Trauma / Resus' : level >= 4 ? 'Urgent Care' : (top && top[3] !== 'Urgent Care' ? top[3] : 'ER Main');
  const tags = hits.map(h => h[2]);
  const iv = [...new Set(hits.slice(0, 2).flatMap(h => h[4]))];
  if (!hits.length) iv.push('Nurse to assess complaint manually', 'Full set of vitals');
  const brief = `${age != null ? age + '-year-old' : 'Adult'} (${String(o.src).toLowerCase()}) presenting with ${tags.length ? tags.join(', ').toLowerCase() : 'unclassified complaint'}. ${flags.length ? 'Abnormal vitals: ' + flags.join('; ') + '. ' : ''}Assessed as ESI ${level}, urgency ${s}/100; route to ${unit}.`;
  return { score: s, level, unit, tags, flags, iv, brief, age, vitals: v };
}

// Escapes the text, then wraps terms matched by the rules in <mark> so staff can see why the AI scored it.
function mark(text) {
  let h = esc(text);
  R.forEach(r => { h = h.replace(new RegExp(r[0].source, 'gi'), m => `<mark>${m}</mark>`); });
  return h;
}
module.exports = { triage, mark, levelOf };
