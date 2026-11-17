// Job "studio": upload dist/ to MindfulStudio (PLAN.md section 6, "Upload protocol"). The GitHub
// OIDC token proves which repo, branch, commit and workflow this is; there are no upload secrets.
//   node upload.mjs studio.json dist checks.json screenshots.json
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readStudio, walk, fail } from './lib.mjs';
import { oidcToken } from './oidc.mjs';

const [studioFile, dist, checksFile, shotsFile] = process.argv.slice(2);
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
const checks = fs.existsSync(checksFile) ? JSON.parse(fs.readFileSync(checksFile, 'utf8') || 'null') : null;
const message = String(process.env.COMMIT_MESSAGE || '').split('\n')[0].slice(0, 200);

// auth is a string, or a function giving a fresh token per attempt (an OIDC token is single use, so a
// retried start needs a new one, review M15).
async function call(method, url, body, auth, type) {
  for (let attempt = 1; ; attempt++) {
    const bearer = typeof auth === 'function' ? await auth() : auth;
    let res;
    try { res = await fetch(SERVER + url, { method, headers: { authorization: `Bearer ${bearer}`, ...(type ? { 'content-type': type } : {}) }, body, signal: AbortSignal.timeout(120e3) }); } catch (e) {
      if (attempt < 3) { await new Promise((r) => setTimeout(r, attempt * 3000)); continue; }
      fail(`Couldn't reach Studio: ${e.message}`);
    }
    const j = await res.json().catch(() => ({}));
    if (res.ok) return j;
    if (res.status >= 500 && attempt < 3) { await new Promise((r) => setTimeout(r, attempt * 3000)); continue; }
    fail(`Studio refused the upload (${res.status}): ${j.error || 'no reason given'}`);
  }
}
const start = await call('POST', '/api/uploads', JSON.stringify({ studio: studioRaw, files, screenshots, checks, message }), () => oidcToken(), 'application/json');
console.log(`Upload ${start.id}: ${files.length} files, ${start.missing.length} new.`);
let n = 0;
for (const h of start.missing) {
  await call('PUT', `/api/uploads/${start.id}/blobs/${h}`, fs.readFileSync(where.get(h)), start.uploadToken, 'application/octet-stream');
  if (++n % 100 === 0) console.log(`  ${n} of ${start.missing.length}`);
}
const fin = await call('POST', `/api/uploads/${start.id}/finalize`, '{}', start.uploadToken, 'application/json');
for (const r of fin.rounds) console.log(`::notice title=In MindfulStudio::Round ${r.number} of ${r.project}: ${r.url}`);
void studio;
