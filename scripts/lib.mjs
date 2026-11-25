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
  // Shapes are the server's to refuse (it does, at upload); here a wrong shape is skipped, never a crash.
  for (const p of s.projects) for (const r of Array.isArray(p?.rounds) ? p.rounds : []) {
    if (!r || typeof r !== 'object') continue;
    if (r?.date != null && r.date !== '' && !isDay(r.date)) fail(`studio.json: round ${r.number} of "${p.slug}" has date "${r.date}". Use a real day from 2000 to 2100 written YYYY-MM-DD, like "2026-11-14".`);
    r.root ??= `${p.slug}/round-${r.number}`;
    for (const pg of Array.isArray(r.pages) ? r.pages : []) if (pg && typeof pg === 'object') pg.path ??= `${pg.slug}/index.html`;
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
// Downloads (docs/download-plan.md): the types that have PDF and PowerPoint files, the most pages one
// option may print, and what studio.json may put into a path. Shared by exports.mjs, assemble.mjs, upload.mjs.
export const EXPORT_TYPES = ['proposal', 'document', 'presentation'];
export const MAX_PAGES = 80;             // pages of a round that are printed (a slide is one page)
export const MAX_PRINTED_PAGES = 200;    // PDF pages in one option's file (a proposal page runs over several)
export const MAX_ROUNDS = 200, MAX_OPTIONS = 4;   // the server's limits (server/lib/studiojson.js)
// Keep in step with SLUG_RE in server/lib/util.js: lowercase letters, numbers and hyphens.
export const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;
// Keep in step with pagePathOk in server/lib/studiojson.js.
const pathOk = (p) => typeof p === 'string' && p.length <= 200 && !p.startsWith('/') && !p.split('/').some((s) => s === '' || s === '.' || s === '..' || s.startsWith('.'));
export const exportType = (p) => { const t = String(p?.type || '').trim().toLowerCase(); return EXPORT_TYPES.includes(t) ? t : null; };
const clean = (v, n) => String(v ?? '').replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, ' ').trim().slice(0, n);

// The one list of what to print and assemble. Nothing from studio.json reaches a path, a URL or a file name
// except through here: the project, option and page slugs are checked against the server's slug rule, the
// round number is a whole number from 1 to 999, a round's folder and a page's path are plain relative
// paths, and the lists are real lists within the server's limits. Anything else is left out with a plain
// note (note(text)), never a crash.
// Order: the NEWEST rounds first (the highest number of each project; then the next highest of each, ...),
// so a time budget that runs out cuts the oldest rounds, never the one that was just saved.
// Each item: { p: {slug, name, type}, r: {number, date, root}, o: {slug, name}, pages: [{slug, name, path}], cut, rank }.
export function exportPlan(studio, note = () => {}) {
  const items = [];
  for (const [pi, p] of studio.projects.entries()) {
    const type = exportType(p);
    if (!type) continue;
    if (!SLUG.test(String(p.slug))) { note(`A ${type} project was left out: its short name "${clean(p.slug, 40)}" can't be a folder name (lowercase letters, numbers and hyphens).`); continue; }
    const proj = { slug: p.slug, name: clean(p.name, 100) || p.slug, type };
    if (!Array.isArray(p.rounds)) { note(`${proj.name} was left out: it has no list of rounds.`); continue; }
    const seen = new Set(), rounds = [];
    for (const r of p.rounds.slice(0, MAX_ROUNDS)) {
      if (!Number.isInteger(r?.number) || r.number < 1 || r.number > 999) { note(`A round of ${proj.name} was left out: its number "${clean(r?.number, 20)}" is not a whole number from 1 to 999.`); continue; }
      const where = `${proj.name} round ${r.number}`;
      if (seen.has(r.number)) { note(`${where} is listed twice; only the first is used.`); continue; }
      seen.add(r.number);
      if (!pathOk(r.root)) { note(`${where} was left out: its folder is not a plain relative path.`); continue; }
      if (!Array.isArray(r.options) || !Array.isArray(r.pages)) { note(`${where} was left out: it needs a list of options and a list of pages.`); continue; }
      // A page that is not valid leaves the whole round out: a download with a page missing is worse than none.
      const pages = [], slugs = new Set();
      for (const pg of r.pages.slice(0, MAX_PAGES)) {
        if (!SLUG.test(String(pg?.slug)) || slugs.has(pg.slug) || !pathOk(pg.path)) { note(`${where} was left out: a page's short name or path is not valid ("${clean(pg?.slug, 40)}").`); pages.length = 0; break; }
        slugs.add(pg.slug);
        pages.push({ slug: pg.slug, name: clean(pg.name, 120) || pg.slug, path: pg.path });
      }
      if (!pages.length) { if (!r.pages.length) note(`${where} was left out: it has no pages.`); continue; }
      const options = [], oslugs = new Set();
      for (const o of r.options.slice(0, MAX_OPTIONS)) {
        if (!SLUG.test(String(o?.slug)) || oslugs.has(o.slug)) { note(`${where}: an option was left out because its short name is not valid ("${clean(o?.slug, 40)}").`); continue; }
        oslugs.add(o.slug);
        options.push({ slug: o.slug, name: clean(o.name, 80) || o.slug });
      }
      rounds.push({ number: r.number, date: typeof r.date === 'string' ? r.date : null, root: r.root, pages, options, cut: Math.max(0, r.pages.length - pages.length) });
    }
    rounds.sort((a, b) => b.number - a.number);
    for (const [rank, r] of rounds.entries()) for (const o of r.options) items.push({ p: proj, r: { number: r.number, date: r.date, root: r.root }, o, pages: r.pages, cut: r.cut, rank, pi });
  }
  return items.sort((a, b) => a.rank - b.rank || a.pi - b.pi);
}
