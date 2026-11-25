// Job "studio" (the one that runs the designs' code): the raw material for PDF and PowerPoint downloads.
// For every proposal, document and presentation project, every round, option and page it prints the page
// with Chrome and writes only inert files: a one-page-set PDF (p001.pdf ...) and, for presentations, a
// 1920 x 1080 JPEG (p001.jpg ...), plus a small manifest.json per option. Nothing here is trusted: the
// next step, assemble.mjs, checks every file again and builds the real downloads (docs/download-plan.md).
// Rounds are printed NEWEST first (the highest number of each project, then the next, ...), and the time
// budget (6 minutes, the first page is always printed) cuts the oldest: a round it never reached gets a
// manifest with "skipped": true and a note, and the server keeps the downloads it already has for it.
//   node exports.mjs studio.json dist exports-src
// Env: STUDIO_CHROME_CHANNEL=chrome uses the installed Chrome (a Mac without Playwright's Chromium);
// STUDIO_EXPORTS_BUDGET_MS changes the total time budget.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright';
import { readStudio, exportPlan, MAX_PAGES } from './lib.mjs';

const PAGE_MS = 60e3;                    // one page, start to finish
const BUDGET_MS = Number(process.env.STUDIO_EXPORTS_BUDGET_MS) || 6 * 60e3;
const DOC_LAYOUT_PX = 1024;              // a document is laid out this wide, then scaled onto A4
const A4_PX = { w: 793.7, h: 1122.5 };
const MARGIN_MM = { top: 12, bottom: 14, side: 10 };
const mmToPx = (mm) => (mm / 25.4) * 96;
const pad = (n) => String(n).padStart(3, '0');

const started = Date.now();
const [studioFile, dist, out] = process.argv.slice(2);
const studio = readStudio(studioFile);
const root = path.resolve(dist);
fs.mkdirSync(out, { recursive: true });

const TYPES = { html: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', woff2: 'font/woff2', woff: 'font/woff', json: 'application/json', gif: 'image/gif', avif: 'image/avif' };
const realRoot = fs.realpathSync(root);
const server = http.createServer((req, res) => {
  try {
    const p = path.normalize(path.join(realRoot, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
    let f = fs.realpathSync(p);
    if (fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
    if (!f.startsWith(realRoot + path.sep) || !fs.statSync(f).isFile()) throw new Error('no');
    const type = TYPES[f.split('.').pop().toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': /^(text\/|application\/json)/.test(type) ? `${type}; charset=utf-8` : type });
    fs.createReadStream(f).pipe(res);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const channel = process.env.STUDIO_CHROME_CHANNEL;
const browser = await chromium.launch(channel ? { channel } : {});

const withTimeout = (p, ms, what) => { let t; return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} took longer than ${ms / 1000} seconds`)), ms); })]).finally(() => clearTimeout(t)); };
const oneLine = (e) => String(e?.message || e).split('\n')[0].slice(0, 160);

// Open the page, let it settle, and wake anything that waits to be scrolled into view.
async function settle(page, url) {
  const res = await page.goto(url, { waitUntil: 'load', timeout: 30e3 });
  if (!res || !res.ok()) throw new Error(`the page did not open (${res ? res.status() : 'no answer'})`);
  await page.waitForLoadState('networkidle', { timeout: 8e3 }).catch(() => {});
  await page.evaluate(async () => {
    for (const img of document.images) img.loading = 'eager';
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const step = Math.max(300, Math.round(innerHeight * 0.8));
    for (let y = 0, n = 0; y < document.documentElement.scrollHeight && n < 400; y += step, n++) { scrollTo(0, y); await wait(50); }
    scrollTo(0, 0);
    await Promise.race([document.fonts?.ready, wait(8000)]);
    await Promise.race([Promise.all([...document.images].map((i) => i.decode().catch(() => {}))), wait(8000)]);
    await wait(250);
  });
}

async function printPage(context, url, kind, file, jpgFile) {
  const page = await context.newPage();
  try {
    return await withTimeout((async () => {
      await page.emulateMedia({ media: 'screen' });
      await settle(page, url);
      if (kind === 'presentation') {
        await page.pdf({ path: file, width: '1920px', height: '1080px', printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 }, pageRanges: '1', preferCSSPageSize: false });
        await page.screenshot({ path: jpgFile, type: 'jpeg', quality: 80 });
      } else {
        const scale = Math.round(((A4_PX.w - 2 * mmToPx(MARGIN_MM.side)) / DOC_LAYOUT_PX) * 1000) / 1000;
        await page.pdf({ path: file, format: 'A4', printBackground: true, scale, margin: { top: `${MARGIN_MM.top}mm`, bottom: `${MARGIN_MM.bottom}mm`, left: `${MARGIN_MM.side}mm`, right: `${MARGIN_MM.side}mm` } });
      }
    })(), PAGE_MS, 'The page');
  } finally { await page.close().catch(() => {}); }
}

let made = 0;
const left = [];                                    // rounds not started because the time ran out
const budgetText = BUDGET_MS >= 60e3 ? `${Math.round(BUDGET_MS / 60e3)} minutes` : `${Math.round(BUDGET_MS / 1000) || '<1'} seconds`;
// The first page is always printed, so a budget that is already spent still makes progress on the newest round.
const over = () => made > 0 && Date.now() - started > BUDGET_MS;
// exportPlan checks every value from studio.json that reaches a path or a URL, and puts the NEWEST rounds
// first (highest number of each project, then the next, ...): when the budget runs out it is the oldest
// rounds that wait, never the one that was just saved. Studio keeps the downloads it already has for those.
const rounds = new Map();
for (const it of exportPlan(studio, (m) => console.error(`::warning::Downloads: ${m}`))) {
  const k = `${it.p.slug}#${it.r.number}`;
  if (!rounds.has(k)) rounds.set(k, []);
  rounds.get(k).push(it);
}
try {
  for (const items of rounds.values()) {
    const { p, r } = items[0];
    if (!fs.existsSync(path.join(dist, r.root))) continue;
    const kind = p.type;
    if (over()) {
      for (const { o } of items) {
        const dir = path.join(out, p.slug, `round-${r.number}`, o.slug);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ kind, pages: [], skipped: true, problems: [`Skipped: the time for making downloads (${budgetText}) ran out before this round was reached. Newer rounds come first; Studio keeps the downloads it already has for this round.`] }));
      }
      left.push(`${p.name} round ${r.number}`);
      continue;
    }
    const context = await browser.newContext({ viewport: kind === 'presentation' ? { width: 1920, height: 1080 } : { width: 1280, height: 900 }, deviceScaleFactor: 1, reducedMotion: 'reduce', colorScheme: 'light' });
    try {
      for (const { o, pages, cut } of items) {
        const dir = path.join(out, p.slug, `round-${r.number}`, o.slug);
        fs.mkdirSync(dir, { recursive: true });
        const manifest = { kind, pages: [], problems: [] };
        const problem = (m) => { manifest.problems.push(m); console.error(`::warning::Downloads, ${p.name} round ${r.number} ${o.name}: ${m}`); };
        if (cut) problem(`Only the first ${MAX_PAGES} of ${MAX_PAGES + cut} pages are in the download.`);
        for (const [i, pg] of pages.entries()) {
          if (over()) { problem(`Page "${pg.name}" and the pages after it were skipped: the time for making downloads (${budgetText}) ran out.`); break; }
          const n = pad(i + 1), file = path.join(dir, `p${n}.pdf`), jpgFile = path.join(dir, `p${n}.jpg`);
          try {
            await printPage(context, `${base}/${r.root}/${o.slug}/${pg.path}`, kind, file, jpgFile);
            manifest.pages.push({ slug: pg.slug, name: pg.name, pdf: `p${n}.pdf`, ...(kind === 'presentation' ? { jpg: `p${n}.jpg` } : {}) });
            made++;
          } catch (e) { problem(`Page "${pg.name}" could not be made into a file: ${oneLine(e)}.`); fs.rmSync(file, { force: true }); fs.rmSync(jpgFile, { force: true }); break; }
        }
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
      }
    } finally { await context.close().catch(() => {}); }
  }
} finally { await browser.close(); server.close(); }
if (left.length) console.error(`::warning::Downloads: not printed, the time (${budgetText}) ran out first: ${left.join(', ')}.`);
console.error(`Download pages printed: ${made}`);
