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
// Proposals and documents also get the text and pictures of every page read out for the Word copy (word-extract.mjs
// runs in the page, word-src.mjs cleans what it found): word-p001.json (blocks, no pictures inside) and
// w001-f01.png (one element screenshot per figure), named in the page's entry in manifest.json. That happens
// after the page has settled and BEFORE it is printed, with screen media on, and it never costs the PDF:
// whatever goes wrong is a problem note in the manifest and the page is printed all the same.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { readStudio, exportPlan, MAX_PAGES, WORD_TYPES } from './lib.mjs';
import { extractDom } from './word-extract.mjs';
import { CAPS, newBudget, normalizeBlocks, pngSize, isPngBytes } from './word-src.mjs';

const PAGE_MS = 60e3;                    // one page, start to finish
const WORD_MS = 15e3;                    // the most the Word reading of one page may take (less when the page is slow)
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

// ---- the Word source of one page ---------------------------------------------------------------------
const pad2 = (n) => String(n).padStart(2, '0');
// The budget of the whole option's file is kept here as the assembler will count it, with room kept for what
// the assembler adds itself: the title (at most 100 characters) and, for each page, its "page" block and name
// (at most 120 characters), 400 bytes each, so a file made of what this writes is never over a cap there.
const newWord = (dir) => { const st = newBudget(); st.bytes = 400; return { dir, st, figs: 0, hashes: new Set(), helper: null }; };
// Is this picture one flat colour (nothing drawn)? Decided by Chrome itself, in a blank page of its own that
// never ran the design's code. If it can't be decided the picture is kept.
async function isBlank(context, wc, png) {
  try {
    wc.helper ??= await context.newPage();
    return await wc.helper.evaluate(async (b64) => {
      const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
      const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
      const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(img, 0, 0);
      const d = x.getImageData(0, 0, c.width, c.height).data;
      for (let i = 4; i < d.length; i += 4) if (d[i] !== d[0] || d[i + 1] !== d[1] || d[i + 2] !== d[2] || d[i + 3] !== d[3]) return false;
      return true;
    }, png.toString('base64'));
  } catch { return false; }
}
// Reads page number n (1-based): runs the extractor in the page, cleans and clips what it found, takes an
// element screenshot of each figure it kept, and writes word-pNNN.json and the pictures. Returns
// { word, figures: [names], notes }.
async function extractWord(page, context, wc, n, deadline, cancel) {
  const notes = [];
  wc.st.blocks += 1; wc.st.bytes += 400;           // the page's own "page" block, made by the assembler
  const raw = await page.evaluate(extractDom, {
    maxBlocks: CAPS.blocks - wc.st.blocks + 1, maxBytes: CAPS.totalText - wc.st.bytes + 1024, maxNodes: 60000,
    minFigW: 120, minFigH: 60, maxFigW: CAPS.figW, maxFigH: CAPS.figH, maxFigs: CAPS.figures - wc.figs,
  });
  if (!raw || !Array.isArray(raw.blocks)) throw new Error('the page gave no answer');
  const blocks = normalizeBlocks(raw.blocks, wc.st, { strict: false, note: (m) => notes.push(m) });
  if (raw.tooBig > 0) notes.push(`${raw.tooBig} picture${raw.tooBig > 1 ? 's' : ''} bigger than ${CAPS.figW} x ${CAPS.figH} pixels ${raw.tooBig > 1 ? 'were' : 'was'} left out of the Word copy.`);
  if (raw.moreFigs > 0) notes.push(`${raw.moreFigs} more picture${raw.moreFigs > 1 ? 's' : ''} left out of the Word copy: at most ${CAPS.figures} fit.`);
  if (raw.stopped && !wc.st.stop) notes.push('The page is very large; only the first part of it is in the Word copy.');
  // The pictures, in the order of the text. A picture that can't be taken, is blank, is a copy of one already
  // taken, or is too big is left out together with its place in the text.
  const names = [], kept = new Map();
  let skipped = 0;
  for (const b of blocks) {
    if (b.k !== 'fig') continue;
    if (cancel.v || Date.now() > deadline || wc.figs >= CAPS.figures) { skipped++; continue; }
    try {
      const png = await page.locator(`[data-studio-wfig="${b.n}"]`).first().screenshot({ type: 'png', animations: 'disabled', caret: 'hide', timeout: 5000 });
      const size = pngSize(png);
      if (!isPngBytes(png) || !size || size.w > CAPS.figW || size.h > CAPS.figH || png.length > CAPS.figBytes) { skipped++; continue; }
      const hash = crypto.createHash('sha256').update(png).digest('hex');
      if (wc.hashes.has(hash) || await isBlank(context, wc, png)) continue;
      if (cancel.v) { skipped++; continue; }
      wc.hashes.add(hash); wc.figs++;
      const name = `w${pad(n)}-f${pad2(names.length + 1)}.png`;
      names.push(name); kept.set(b.n, names.length);
      fs.writeFileSync(path.join(wc.dir, name), png);
    } catch { skipped++; }
  }
  if (skipped) notes.push(`${skipped} picture${skipped > 1 ? 's' : ''} could not be taken for the Word copy (too big, or no time left).`);
  const final = blocks.filter((b) => b.k !== 'fig' || kept.has(b.n)).map((b) => (b.k === 'fig' ? { k: 'fig', n: kept.get(b.n) } : b));
  if (cancel.v) throw new Error('it took too long');
  const word = `word-p${pad(n)}.json`;
  fs.writeFileSync(path.join(wc.dir, word), JSON.stringify({ v: 1, blocks: final }));
  return { word, figures: names, notes };
}
// extractWord inside what is left of the page's time. A failure leaves the budget as it was and is a note.
async function readWord(page, context, wc, n, t0) {
  const room = Math.min(WORD_MS, PAGE_MS - (Date.now() - t0) - 25e3);
  if (room < 3e3) return { notes: ['The text of this page was not read for the Word copy: not enough time was left.'] };
  const snap = { st: { ...wc.st, said: new Set(wc.st.said) }, figs: wc.figs, hashes: new Set(wc.hashes) };
  const cancel = { v: false };
  try { return await withTimeout(extractWord(page, context, wc, n, Date.now() + room, cancel), room, 'Reading the text'); } catch (e) {
    cancel.v = true; wc.st = snap.st; wc.figs = snap.figs; wc.hashes = snap.hashes;
    return { notes: [`The text of this page could not be read for the Word copy: ${oneLine(e)}.`] };
  }
}

// wc: the Word reading of this option (proposals and documents), or null. Returns { word, figures, notes }.
async function printPage(context, url, kind, file, jpgFile, wc, pageNo) {
  const page = await context.newPage();
  try {
    const t0 = Date.now();
    return await withTimeout((async () => {
      let got = { notes: [] };
      await page.emulateMedia({ media: 'screen' });
      await settle(page, url);
      if (wc) got = await readWord(page, context, wc, pageNo, t0);
      if (kind === 'presentation') {
        await page.pdf({ path: file, width: '1920px', height: '1080px', printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 }, pageRanges: '1', preferCSSPageSize: false });
        await page.screenshot({ path: jpgFile, type: 'jpeg', quality: 80 });
      } else {
        // A document that was designed to be printed says so (an @page rule or @media print styles: sheets
        // with their own size, margins and page breaks). Print it as it asked: print media, its own page
        // size, no scaling. One that has none (a long web page) is laid out about 1024 px wide and scaled onto A4.
        const print = await page.evaluate(() => {
          const seen = { page: false, media: false };
          for (const sheet of document.styleSheets) {
            let rules; try { rules = sheet.cssRules; } catch { continue; }
            for (const r of rules) {
              if (r instanceof CSSPageRule) seen.page = true;
              else if (r instanceof CSSMediaRule && /(^|[\s,(])print\b/.test(r.media.mediaText)) { seen.media = true; for (const x of r.cssRules) if (x instanceof CSSPageRule) seen.page = true; }
            }
          }
          return seen;
        });
        if (print.page || print.media) {
          // A printed sheet is narrower than a phone breakpoint (letter is 816 px), so a design's
          // "max-width" rules for narrow screens would switch its phone layout on. Drop them: paper is not a phone.
          await page.evaluate(() => {
            for (const sheet of document.styleSheets) {
              let rules; try { rules = sheet.cssRules; } catch { continue; }
              for (let i = rules.length - 1; i >= 0; i--) {
                const r = rules[i];
                if (r instanceof CSSMediaRule && /max-(device-)?width/.test(r.media.mediaText) && !/\bprint\b/.test(r.media.mediaText)) sheet.deleteRule(i);
              }
            }
          });
          await page.emulateMedia({ media: 'print' });
          const m = print.page ? undefined : { top: `${MARGIN_MM.top}mm`, bottom: `${MARGIN_MM.bottom}mm`, left: `${MARGIN_MM.side}mm`, right: `${MARGIN_MM.side}mm` };
          await page.pdf({ path: file, format: 'A4', preferCSSPageSize: true, printBackground: true, ...(m ? { margin: m } : {}) });
        } else {
          const scale = Math.round(((A4_PX.w - 2 * mmToPx(MARGIN_MM.side)) / DOC_LAYOUT_PX) * 1000) / 1000;
          await page.pdf({ path: file, format: 'A4', printBackground: true, scale, margin: { top: `${MARGIN_MM.top}mm`, bottom: `${MARGIN_MM.bottom}mm`, left: `${MARGIN_MM.side}mm`, right: `${MARGIN_MM.side}mm` } });
        }
      }
      return got;
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
        const wc = WORD_TYPES.includes(kind) ? newWord(dir) : null;       // proposals and documents: the Word source too
        try {
          for (const [i, pg] of pages.entries()) {
            if (over()) { problem(`Page "${pg.name}" and the pages after it were skipped: the time for making downloads (${budgetText}) ran out.`); break; }
            const n = pad(i + 1), file = path.join(dir, `p${n}.pdf`), jpgFile = path.join(dir, `p${n}.jpg`);
            try {
              const got = await printPage(context, `${base}/${r.root}/${o.slug}/${pg.path}`, kind, file, jpgFile, wc, i + 1);
              manifest.pages.push({ slug: pg.slug, name: pg.name, pdf: `p${n}.pdf`, ...(kind === 'presentation' ? { jpg: `p${n}.jpg` } : {}), ...(got?.word ? { word: got.word, figures: got.figures } : {}) });
              for (const m of got?.notes || []) problem(`Word copy, page "${pg.name}": ${m}`);
              made++;
            } catch (e) { problem(`Page "${pg.name}" could not be made into a file: ${oneLine(e)}.`); fs.rmSync(file, { force: true }); fs.rmSync(jpgFile, { force: true }); break; }
          }
        } finally { await wc?.helper?.close().catch(() => {}); }
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
      }
    } finally { await context.close().catch(() => {}); }
  }
} finally { await browser.close(); server.close(); }
if (left.length) console.error(`::warning::Downloads: not printed, the time (${budgetText}) ran out first: ${left.join(', ')}.`);
console.error(`Download pages printed: ${made}`);
