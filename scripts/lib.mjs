// Shared by the workflow's scripts: reading studio.json and walking dist/.
import fs from 'node:fs';
import path from 'node:path';

export function readStudio(file) {
  let s;
  try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { fail(`studio.json is missing or not valid JSON (${e.message}).`); }
  if (s?.schema !== 1 || !Array.isArray(s.projects)) fail('studio.json must have "schema": 1 and a "projects" list.');
  // Keep in step with server/lib/types.js: refuse a wrong type before building, not after.
  const TYPES = ['website', 'product', 'layouts', 'brand', 'proposal', 'presentation', 'document', 'marketing'];
  for (const p of s.projects) if (p?.type != null && !TYPES.includes(String(p.type).trim().toLowerCase())) fail(`studio.json: project "${p.slug}" has type "${p.type}". Use one of: ${TYPES.join(', ')}.`);
  // A round's optional "date": a real day, YYYY-MM-DD (keep in step with server/lib/days.js).
  const isDay = (v) => { if (typeof v !== 'string') return false; const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v)); if (!m || m[1] < 2000 || m[1] > 2100) return false; const t = new Date(Date.UTC(m[1], m[2] - 1, m[3])); return t.getUTCMonth() === m[2] - 1 && t.getUTCDate() === Number(m[3]); };
  for (const p of s.projects) for (const r of p.rounds || []) {
    if (r?.date != null && r.date !== '' && !isDay(r.date)) fail(`studio.json: round ${r.number} of "${p.slug}" has date "${r.date}". Use a real day from 2000 to 2100 written YYYY-MM-DD, like "2026-11-14".`);
    r.root ??= `${p.slug}/round-${r.number}`;
    for (const pg of r.pages || []) pg.path ??= `${pg.slug}/index.html`;
  }
  return s;
}
export function* walk(dir, rel = '') {
  for (const f of fs.readdirSync(path.join(dir, rel)).sort()) {
    const r = rel ? `${rel}/${f}` : f;
    const st = fs.lstatSync(path.join(dir, r));
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) yield* walk(dir, r); else yield r;
  }
}
export function fail(msg) { console.error(`::error::${msg}`); process.exit(1); }
