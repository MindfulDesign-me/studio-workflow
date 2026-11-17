// Job "build": run each project's build command from studio.json, then check every round's pages
// ended up in dist/<project>/round-<n>/<option>/<page path>. A project without a build command is
// copied as it is: each round folder named in studio.json goes to dist/ unchanged.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { readStudio, fail } from './lib.mjs';

const studio = readStudio(process.argv[2] || 'studio.json');
fs.mkdirSync('dist', { recursive: true });
for (const p of studio.projects) {
  if (p.build) {
    console.log(`::group::Build ${p.name}: ${p.build}`);
    try { execSync(p.build, { stdio: 'inherit', env: { ...process.env, STUDIO_DIST: path.resolve('dist') } }); } catch { fail(`The build for ${p.name} failed: "${p.build}". The lines above say why.`); }
    console.log('::endgroup::');
  } else {
    for (const r of p.rounds) {
      const from = path.join(p.slug, `round-${r.number}`);
      if (!fs.existsSync(from)) continue;
      fs.cpSync(from, path.join('dist', r.root), { recursive: true, filter: (src) => !path.basename(src).startsWith('.') && !src.split(path.sep).includes('notes') });
    }
  }
  for (const r of p.rounds) for (const o of r.options) for (const pg of r.pages) {
    const f = path.join('dist', r.root, o.slug, pg.path);
    if (fs.existsSync(path.join('dist', r.root)) && !fs.existsSync(f)) fail(`Round ${r.number} of ${p.name}: ${o.name} has no "${pg.name}" page (expected ${f}).`);
  }
}
console.log('Build done.');
