// Job "fetch" of render.yml: get the files of the save Studio asked to have rendered again.
// The GitHub OIDC token proves this is Studio's render workflow; the ticket (STUDIO_RENDER_TICKET) says
// which save. Runs only this pinned code: nothing fetched here is run in this job.
//   node render-fetch.mjs render
// Writes render/studio.json and render/dist/<the round's files>, and the step output go=yes. If the
// round has been changed again since Studio asked, there is nothing to do: go=no, and the job ends well.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fail } from './lib.mjs';
import { oidcToken } from './oidc.mjs';

const out = path.resolve(process.argv[2] || 'render');
const SERVER = (process.env.STUDIO_URL || 'https://studio.mindfuldesign.me').replace(/\/$/, '');
const ticket = process.env.STUDIO_RENDER_TICKET || '';
if (!/^rt_[A-Za-z0-9_-]{43}$/.test(ticket)) fail('No render ticket. This workflow is started by MindfulStudio, not by hand.');
const say = (k, v) => { if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`); };

const res = await fetch(`${SERVER}/api/render/manifest`, { headers: { authorization: `Bearer ${await oidcToken()}`, 'x-studio-render': ticket }, signal: AbortSignal.timeout(60e3) }).catch((e) => fail(`Couldn't reach Studio: ${e.message}`));
const m = await res.json().catch(() => ({}));
if (res.status === 409) { console.log(`::notice::Nothing to render: ${m.error || 'the round has been changed again'}`); say('go', 'no'); process.exit(0); }
if (!res.ok) fail(`Studio refused the render (${res.status}): ${m.error || 'no reason given'}`);

const dist = path.join(out, 'dist');
fs.mkdirSync(dist, { recursive: true });
fs.writeFileSync(path.join(out, 'studio.json'), JSON.stringify(m.studio, null, 2));
let n = 0, bytes = 0;
for (const f of m.files) {
  // The names are Studio's, but a path is still only ever written inside dist/.
  const abs = path.resolve(dist, f.path);
  if (!abs.startsWith(dist + path.sep) || f.path.split('/').some((s) => !s || s === '.' || s === '..' || s.startsWith('.'))) fail(`Studio named a file outside the round: ${String(f.path).slice(0, 120)}`);
  let buf = null;
  for (let attempt = 1; attempt <= 3 && !buf; attempt++) {
    try {
      const r = await fetch(`${SERVER}/api/render/files/${f.sha256}`, { headers: { authorization: `Bearer ${m.fetchToken}` }, signal: AbortSignal.timeout(120e3) });
      if (r.ok) buf = Buffer.from(await r.arrayBuffer()); else if (r.status < 500) fail(`Studio would not give ${f.path} (${r.status}).`);
    } catch { /* tried again below */ }
    if (!buf) await new Promise((x) => setTimeout(x, attempt * 2000));
  }
  if (!buf) fail(`Couldn't fetch ${f.path} from Studio.`);
  if (crypto.createHash('sha256').update(buf).digest('hex') !== f.sha256) fail(`${f.path} did not arrive whole.`);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buf);
  n++; bytes += buf.length;
}
console.log(`Fetched ${n} files (${Math.round(bytes / 1024)} KB) of save ${m.upload}.`);
say('go', 'yes');
