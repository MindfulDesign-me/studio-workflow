// Job "studio": upload dist/ to MindfulStudio (PLAN.md section 6, "Upload protocol"). The GitHub
// OIDC token proves which repo, branch, commit and workflow this is; there are no upload secrets.
//   node upload.mjs studio.json dist checks.json screenshots.json [exports/exports.json]
// The last argument is optional: the PDF and PowerPoint files assemble.mjs made (docs/download-plan.md).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readStudio, walk, fail, exportType } from './lib.mjs';
import { oidcToken } from './oidc.mjs';

const [studioFile, dist, checksFile, shotsFile, exportsFile] = process.argv.slice(2);
const SERVER = (process.env.STUDIO_URL || 'https://studio.mindfuldesign.me').replace(/\/$/, '');
const studioRaw = JSON.parse(fs.readFileSync(studioFile, 'utf8'));
const studio = readStudio(studioFile);
const hashOf = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const where = new Map();
const files = [];
for (const rel of walk(dist)) {
  if (rel.split('/').some((s) => s.startsWith('.'))) continue;
  const abs = path.join(dist, rel); const buf = fs.readFileSync(abs); const sha256 = hashOf(buf);
  where.set(sha256, abs); files.push({ path: rel, sha256, size: buf.length });
}
// The screenshot list comes from the "shots" job, which ran the designs' code, so it is untrusted:
// only JPEG files inside the shots folder are taken.
const shotsDir = path.resolve(path.dirname(shotsFile || 'shots/x'));
let shotList = [];
try { shotList = JSON.parse(fs.readFileSync(shotsFile, 'utf8') || '[]'); } catch { /* no screenshots */ }
const screenshots = (Array.isArray(shotList) ? shotList : []).slice(0, 2000).flatMap((s) => {
  const abs = path.resolve(String(s?.file || ''));
  if (!abs.startsWith(shotsDir + path.sep) || !abs.endsWith('.jpg') || !fs.existsSync(abs) || fs.lstatSync(abs).isSymbolicLink()) return [];
  const buf = fs.readFileSync(abs);
  if (buf[0] !== 0xff || buf[1] !== 0xd8 || buf.length > 5 * 1048576) return [];
  const sha256 = hashOf(buf); where.set(sha256, abs);
  return [{ project: String(s.project), round: Number(s.round), option: String(s.option), page: String(s.page), width: Number(s.width), sha256, size: buf.length }];
});
// PDF and PowerPoint downloads. The list is the assembler's (a job with no design code), but it is read
// as carefully as the screenshots: each file must be a plain file next to the list, with the right first
// bytes and size, and name a project, round and option that studio.json has. Whatever is wrong with one
// is a note in the save's checks, never a failed save. Their size and hash are measured here.
const exportShas = new Set(), exportProblems = [];
const exportEntries = [];
if (exportsFile && fs.existsSync(exportsFile)) {
  const dir = path.resolve(path.dirname(exportsFile));
  let listed = {};
  try { listed = JSON.parse(fs.readFileSync(exportsFile, 'utf8') || '{}'); } catch { exportProblems.push('The list of PDF and PowerPoint files could not be read, so none were sent.'); }
  for (const m of (Array.isArray(listed.problems) ? listed.problems : []).slice(0, 40)) exportProblems.push(String(m).slice(0, 280));
  // "wordsrc" is the Word source (workflow/EXPORTS.md): internal, for proposals and documents, a JSON file of at most 12 MB.
  const KIND_MAGIC = { pdf: [0x25, 0x50, 0x44, 0x46, 0x2d], pptx: [0x50, 0x4b, 0x03, 0x04], wordsrc: [0x7b] };
  const LABEL = { pdf: 'PDF', pptx: 'PowerPoint', wordsrc: 'Word copy' };
  for (const e of (Array.isArray(listed.files) ? listed.files : []).slice(0, 400)) {
    const what = `${LABEL[e?.kind] || 'PDF'} for ${String(e?.project).slice(0, 60)} round ${Number(e?.round) || '?'}`;
    const skip = (why) => exportProblems.push(`The ${what} was left out: ${why}.`);
    const p = studio.projects.find((x) => x.slug === e?.project);
    const r = p?.rounds.find((x) => x.number === e.round);
    const type = exportType(p);
    if (!r || !r.options.some((o) => o.slug === e.option)) { skip('it is not for a round and option in studio.json'); continue; }
    const kindOk = e.kind === 'pdf' ? !!type : e.kind === 'pptx' ? type === 'presentation' : e.kind === 'wordsrc' ? type === 'proposal' || type === 'document' : false;
    if (typeof e.kind !== 'string' || !Object.hasOwn(KIND_MAGIC, e.kind) || !kindOk) { skip('that kind of file is not made for this type of project'); continue; }
    const abs = path.resolve(dir, String(e.file || ''));
    if (!/^[A-Za-z0-9._-]+$/.test(String(e.file)) || path.dirname(abs) !== dir) { skip('its file name is not a plain name'); continue; }
    const st = fs.lstatSync(abs, { throwIfNoEntry: false });
    if (!st) { skip('the file is missing'); continue; }
    if (!st.isFile() || st.isSymbolicLink()) { skip('it is not a plain file'); continue; }
    const limit = e.kind === 'wordsrc' ? 12 : 25;
    if (st.size < 8 || st.size > limit * 1048576) { skip(st.size < 8 ? 'the file is empty' : `it is ${Math.round(st.size / 1048576)} MB and the limit is ${limit} MB`); continue; }
    const buf = fs.readFileSync(abs);
    if (!KIND_MAGIC[e.kind].every((b, i) => buf[i] === b)) { skip('it is not a real file of that kind'); continue; }
    if (e.kind === 'pptx' && (!buf.includes('[Content_Types].xml') || buf.includes('vbaProject.bin'))) { skip('it did not pass the file check'); continue; }
    const sha256 = hashOf(buf);
    if (exportEntries.some((x) => x.project === e.project && x.round === e.round && x.option === e.option && x.kind === e.kind)) { skip('it is listed twice'); continue; }
    where.set(sha256, abs); exportShas.add(sha256);
    const pages = Number.isInteger(e.pages) && e.pages >= 1 && e.pages <= 200 ? e.pages : 0;
    exportEntries.push({ project: e.project, round: e.round, option: e.option, kind: e.kind, sha256, size: buf.length, pages });
  }
}
let checks = fs.existsSync(checksFile) ? JSON.parse(fs.readFileSync(checksFile, 'utf8') || 'null') : null;
if (exportProblems.length) {
  checks ??= { tool: 'studio-exports 1', findings: [] };
  checks.findings = [...exportProblems.slice(0, 40).map((message) => ({ level: 'should', check: 'downloads', message, where: '' })), ...(checks.findings || [])];
}
const message = String(process.env.COMMIT_MESSAGE || '').split('\n')[0].slice(0, 200);

// auth is a string, or a function giving a fresh token per attempt (an OIDC token is single use, so a
// retried start needs a new one, review M15). soft: a failure is a warning and null, not the end of the
// save (a PDF or PowerPoint that doesn't arrive is left out; the design still saves).
async function call(method, url, body, auth, type, soft = false) {
  const stop = (msg) => { if (soft) { console.log(`::warning::${msg}`); return null; } return fail(msg); };
  for (let attempt = 1; ; attempt++) {
    const bearer = typeof auth === 'function' ? await auth() : auth;
    let res;
    try { res = await fetch(SERVER + url, { method, headers: { authorization: `Bearer ${bearer}`, ...(type ? { 'content-type': type } : {}) }, body, signal: AbortSignal.timeout(120e3) }); } catch (e) {
      if (attempt < 3) { await new Promise((r) => setTimeout(r, attempt * 3000)); continue; }
      return stop(`Couldn't reach Studio: ${e.message}`);
    }
    const j = await res.json().catch(() => ({}));
    if (res.ok) return j;
    if (res.status >= 500 && attempt < 3) { await new Promise((r) => setTimeout(r, attempt * 3000)); continue; }
    return stop(`Studio refused the upload (${res.status}): ${j.error || 'no reason given'}`);
  }
}
const start = await call('POST', '/api/uploads', JSON.stringify({ studio: studioRaw, files, screenshots, exports: exportEntries, checks, message }), () => oidcToken(), 'application/json');
console.log(`Upload ${start.id}: ${files.length} files, ${start.missing.length} new.`);
let n = 0;
for (const h of start.missing) {
  // Only what the server asked for. A download that fails to go up is a warning: the save carries on without it.
  if (exportShas.has(h)) { if (await call('PUT', `/api/uploads/${start.id}/blobs/${h}`, fs.readFileSync(where.get(h)), start.uploadToken, 'application/octet-stream', true) == null) console.log('::warning::A PDF, PowerPoint or Word file could not be sent, so it will be missing from the downloads.'); continue; }
  await call('PUT', `/api/uploads/${start.id}/blobs/${h}`, fs.readFileSync(where.get(h)), start.uploadToken, 'application/octet-stream');
  if (++n % 100 === 0) console.log(`  ${n} of ${start.missing.length}`);
}
const fin = await call('POST', `/api/uploads/${start.id}/finalize`, '{}', start.uploadToken, 'application/json');
for (const r of fin.rounds) console.log(`::notice title=In MindfulStudio::Round ${r.number} of ${r.project}: ${r.url}`);
void studio;
