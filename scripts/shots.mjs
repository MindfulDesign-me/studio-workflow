// Job "studio": screenshots for the library and round pages. Every page of every option at 1440 px,
// and each option's first page at 390 px. Pages are served from a local server on this runner.
//   node shots.mjs studio.json dist outdir > screenshots.json
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright';
import { readStudio } from './lib.mjs';

const [studioFile, dist, out] = process.argv.slice(2);
const studio = readStudio(studioFile);
fs.mkdirSync(out, { recursive: true });
const TYPES = { html: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', woff2: 'font/woff2', woff: 'font/woff', json: 'application/json', gif: 'image/gif', avif: 'image/avif' };
const root = path.resolve(dist);
const server = http.createServer((req, res) => {
  const p = path.normalize(path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  if (!p.startsWith(root)) { res.writeHead(404); return res.end(); }
  const f = fs.existsSync(p) && fs.statSync(p).isDirectory() ? path.join(p, 'index.html') : p;
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[f.split('.').pop()] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
// On GitHub's runner the workflow installs Playwright's Chromium; locally, PW_CHANNEL=chrome uses
// the installed Chrome instead.
const browser = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});
const list = [];
try {
  for (const p of studio.projects) for (const r of p.rounds) {
    if (!fs.existsSync(path.join(dist, r.root))) continue;
    for (const o of r.options) {
      const jobs = [...r.pages.map((pg) => [pg, 1440]), [r.pages[0], 390]];
      for (const [pg, width] of jobs) {
        const page = await browser.newPage({ viewport: { width, height: width >= 800 ? 900 : 844 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
        try {
          await page.goto(`${base}/${r.root}/${o.slug}/${pg.path}`, { waitUntil: 'networkidle', timeout: 30e3 });
          await page.waitForTimeout(400);
          const file = path.join(out, `${p.slug}-r${r.number}-${o.slug}-${pg.slug}-${width}.jpg`);
          await page.screenshot({ path: file, type: 'jpeg', quality: 72 });
          list.push({ project: p.slug, round: r.number, option: o.slug, page: pg.slug, width, file });
        } catch (e) { console.error(`::warning::No screenshot of ${o.name} ${pg.name} at ${width}px: ${e.message.split('\n')[0]}`); }
        await page.close();
      }
    }
  }
} finally { await browser.close(); server.close(); }
console.error(`Screenshots: ${list.length}`);
process.stdout.write(JSON.stringify(list));
