// Downloads, the trusted step: builds each round's PDF and PowerPoint files from what exports.mjs printed.
// This step runs in a job that has no design code. Everything in exports-src/ came from a job that did, so
// it is untrusted: no symlinks, only the file names exports.mjs makes, size limits checked on the file's
// size BEFORE it is read, and the first bytes of every file are checked. The PDF is rebuilt from an
// allow-list (pdf-clean.mjs, in a worker with a memory limit and a timeout); both files are byte for byte
// the same when made again from the same material.
// Bounds, all of them ending in a plain problem and never a failed run: pages per option (also when
// reading the manifest), bytes per file, per option and per run, and the wall-clock time of the run (the
// newest rounds come first, so what runs out is the oldest).
//   node assemble.mjs studio.json exports-src outdir
// Writes outdir/exports.json: { files: [{ project, round, option, kind, file, sha256, size, pages }], problems: [text] }
// Env (for tests): STUDIO_ASSEMBLE_BUDGET_MS (default 4 minutes), STUDIO_ASSEMBLE_MAX_BYTES (default 600 MB).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import pptxgen from 'pptxgenjs';
import JSZip from 'jszip';
import { readStudio, exportPlan, MAX_PAGES, MAX_PRINTED_PAGES } from './lib.mjs';
import { buildPdfSafely } from './pdf-clean.mjs';

const MB = 1048576;
const MAX_FILE = 25 * MB;                // the most Studio accepts for one file
const MAX_PAGE_PDF = 20 * MB;            // one printed page file
const MAX_JPG = 4 * MB;                  // one slide picture
const MAX_OPTION_BYTES = 150 * MB;       // everything read for one file of one option
const MAX_RUN_BYTES = Number(process.env.STUDIO_ASSEMBLE_MAX_BYTES) || 600 * MB;    // everything read in this run
const BUDGET_MS = Number(process.env.STUDIO_ASSEMBLE_BUDGET_MS) || 4 * 60e3;        // the whole run
const FIXED_DATE = new Date('2026-01-01T00:00:00Z');
const pad = (n) => String(n).padStart(3, '0');
const started = Date.now();

const [studioFile, srcDir, outDir] = process.argv.slice(2);
const studio = readStudio(studioFile);
fs.mkdirSync(outDir, { recursive: true });

const files = [], problems = [];
const problem = (m) => { problems.push(String(m).replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 280)); console.error(`::warning::Downloads: ${m}`); };
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const mbText = (n) => `${Math.max(1, Math.round(n / MB))} MB`;
let runBytes = 0;

// ---- reading untrusted files -------------------------------------------------------------------
// The size of a plain file directly inside dir (which was itself reached without symlinks), within a limit.
// Nothing is read: a file that is too big is refused here, before any of it is loaded.
function statPlain(dir, name, cap) {
  const st = fs.lstatSync(path.join(dir, name), { throwIfNoEntry: false });
  if (!st) throw new Error(`${name} is missing`);
  if (!st.isFile() || st.isSymbolicLink()) throw new Error(`${name} is not a plain file`);
  if (st.size > cap || st.size < 8) throw new Error(`${name} is ${st.size < 8 ? 'empty' : 'too big'}`);
  return st.size;
}
// Read it, exactly that many bytes (the open refuses a link; the size is read again from the open file).
function readPlain(dir, name, cap) {
  statPlain(dir, name, cap);
  const fd = fs.openSync(path.join(dir, name), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > cap || st.size < 8) throw new Error(`${name} changed while it was read`);
    const buf = Buffer.allocUnsafe(st.size);
    let got = 0;
    while (got < buf.length) { const n = fs.readSync(fd, buf, got, buf.length - got, got); if (!n) break; got += n; }
    if (got !== buf.length) throw new Error(`${name} changed while it was read`);
    return buf;
  } finally { fs.closeSync(fd); }
}
// Each folder on the way down must be a real folder, not a link to somewhere else.
function plainDir(base, ...parts) {
  let cur = base;
  for (const part of parts) {
    cur = path.join(cur, part);
    const st = fs.lstatSync(cur, { throwIfNoEntry: false });
    if (!st || !st.isDirectory() || st.isSymbolicLink()) return null;
  }
  return cur;
}
const isPdf = (b) => b.length > 8 && b.toString('latin1', 0, 5) === '%PDF-';
function jpegSize(b) {
  if (b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return null;
  for (let i = 2; i + 9 < b.length;) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { i += 2; continue; }
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}

// The manifest says which pages were printed, in order. It is only believed where it agrees with studio.json,
// and the length of its own list is never used to size anything: a list longer than the page limit, or
// longer than studio.json's own, is refused unread.
function readManifest(dir, expected) {
  let m;
  try { m = JSON.parse(readPlain(dir, 'manifest.json', 256 * 1024).toString('utf8')); } catch (e) { return { ok: [], notes: [], why: `its list of pages could not be read (${e.message})` }; }
  const notes = (Array.isArray(m?.problems) ? m.problems : []).slice(0, 8).map((s) => String(s).replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 220));
  if (m?.skipped === true) return { ok: [], notes: [], skipped: true };
  if (Array.isArray(m?.pages) && (m.pages.length > MAX_PAGES || m.pages.length > expected.length)) return { ok: [], notes: [], why: `its list names ${m.pages.length} pages, studio.json has ${expected.length}` };
  const ok = [];
  for (const [i, pg] of expected.entries()) {
    const e = Array.isArray(m?.pages) ? m.pages[i] : null;
    if (!e || e.slug !== pg.slug || e.pdf !== `p${pad(i + 1)}.pdf` || (e.jpg != null && e.jpg !== `p${pad(i + 1)}.jpg`)) break;
    ok.push({ n: i + 1, slug: pg.slug, name: String(pg.name || pg.slug).slice(0, 120), pdf: e.pdf, jpg: e.jpg || null });
  }
  return { ok, notes };
}

// ---- PowerPoint ---------------------------------------------------------------------------------
async function buildPptx({ title, date, slides }) {
  const pres = new pptxgen();
  pres.layout = 'LAYOUT_16x9';                       // 10 x 5.625 in, the shape of a 1920 x 1080 slide
  pres.title = title; pres.subject = ''; pres.author = 'MindfulStudio'; pres.company = ''; pres.revision = '1';
  for (const s of slides) {
    const slide = pres.addSlide();
    slide.addImage({ data: `image/jpeg;base64,${s.bytes.toString('base64')}`, x: 0, y: 0, w: 10, h: 5.625, altText: s.name });
    slide.addNotes(s.name);
  }
  const raw = await pres.write({ outputType: 'nodebuffer' });
  // Same material, same file: a fixed date on every part and in the document properties, a fixed order.
  const zip = await JSZip.loadAsync(raw);
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort((a, b) => (a === '[Content_Types].xml' ? -1 : b === '[Content_Types].xml' ? 1 : a < b ? -1 : a > b ? 1 : 0));
  if (names.length > 600 || !names.includes('[Content_Types].xml')) throw new Error('the PowerPoint file came out wrong');
  const iso = date.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const next = new JSZip();
  for (const n of names) {
    let data = await zip.files[n].async('nodebuffer');
    if (/vbaProject|\.bin$/i.test(n)) throw new Error('the PowerPoint file held a macro or binary part');
    if (n.endsWith('.rels') && data.includes('TargetMode="External"')) throw new Error('the PowerPoint file held an outside link');
    if (n === 'docProps/core.xml') data = Buffer.from(data.toString('utf8').replace(/(<dcterms:(?:created|modified)[^>]*>)[^<]*(<\/dcterms:)/g, `$1${iso}$2`));
    next.file(n, data, { date, createFolders: false, unixPermissions: 0o644 });
  }
  const bytes = await next.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 }, platform: 'UNIX' });
  const count = names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).length;
  if (count !== slides.length) throw new Error(`it came out with ${count} slides instead of ${slides.length}`);
  return { bytes, pages: count };
}

// ---- the rounds ---------------------------------------------------------------------------------
const roundDate = (r) => (r.date ? new Date(`${r.date}T12:00:00Z`) : FIXED_DATE);
function keep({ p, r, o, kind, bytes, pages }) {
  const where = `${kind === 'pdf' ? 'PDF' : 'PowerPoint'} for ${p.name} round ${r.number} (${o.name})`;
  if (bytes.length > MAX_FILE) return problem(`The ${where} was left out: it is ${mbText(bytes.length)} and the limit is 25 MB.`);
  // The name is made of checked slugs and a whole number only (none of them can hold "__" or a slash).
  const file = `${p.slug}__round-${r.number}__${o.slug}.${kind}`;
  fs.writeFileSync(path.join(outDir, file), bytes);
  files.push({ project: p.slug, round: r.number, option: o.slug, kind, file, sha256: sha256(bytes), size: bytes.length, pages });
}
// "Acme Deck rounds 3 and 1, Acme Site round 2" for a list of plan items.
function roundsText(items) {
  const by = new Map();
  for (const it of items) { const k = it.p.name; if (!by.has(k)) by.set(k, new Set()); by.get(k).add(it.r.number); }
  return [...by].map(([name, set]) => { const n = [...set]; return `${name} round${n.length > 1 ? 's' : ''} ${n.length > 1 ? `${n.slice(0, -1).join(', ')} and ${n.at(-1)}` : n[0]}`; }).join('; ');
}
// Reading and checking the sizes of all of an option's files for one output, before any is read.
function reserve(dir, names, cap) {
  const sizes = names.map(([name, c]) => statPlain(dir, name, Math.min(c, cap)));
  const sum = sizes.reduce((a, b) => a + b, 0);
  if (sum > cap) throw new Error(`its files add up to ${mbText(sum)}, more than the ${mbText(cap)} one file may be made from`);
  if (runBytes + sum > MAX_RUN_BYTES) throw new Error(`this run has read as much as it may (${mbText(MAX_RUN_BYTES)}), so it was left out`);
  runBytes += sum;
}
const timeLeft = () => BUDGET_MS - (Date.now() - started);

const plan = exportPlan(studio, problem);      // newest rounds first; nothing else from studio.json reaches a path
const late = [];                               // options not started because the time for this run was used up
const notPrinted = [];                         // options exports.mjs did not start for lack of time
let begun = 0;
for (const it of plan) {
  const { p, r, o, pages } = it;
  const dir = plainDir(srcDir, p.slug, `round-${r.number}`, o.slug);
  if (!dir) continue;                                    // exports.mjs made nothing for this round (it was not built)
  if (begun > 0 && timeLeft() <= 0) { late.push(it); continue; }
  begun++;
  const tag = `${p.name} round ${r.number} (${o.name})`;
  const expected = pages;
  const m = readManifest(dir, expected);
  if (m.skipped) { notPrinted.push(it); continue; }
  for (const n of m.notes) problem(`${tag}: ${n}`);
  if (m.why) { problem(`No PDF or PowerPoint for ${tag}: ${m.why}.`); continue; }
  if (m.ok.length < expected.length || !expected.length) {
    problem(`No PDF${p.type === 'presentation' ? ' or PowerPoint' : ''} for ${tag}: ${m.ok.length} of ${expected.length} pages could be made.`);
    continue;
  }
  // PDF (every type)
  try {
    reserve(dir, m.ok.map((e) => [e.pdf, MAX_PAGE_PDF]), MAX_OPTION_BYTES);
    const pdfPages = m.ok.map((e) => ({ name: e.name, bytes: readPlain(dir, e.pdf, MAX_PAGE_PDF) }));
    for (const [i, pg] of pdfPages.entries()) if (!isPdf(pg.bytes)) throw new Error(`${m.ok[i].pdf} is not a real PDF`);
    const single = p.type === 'presentation';
    const res = await buildPdfSafely(
      { pages: pdfPages, title: p.name, dateMs: roundDate(r).getTime(), single, maxPages: single ? MAX_PAGES : MAX_PRINTED_PAGES, slides: single },
      { timeoutMs: Math.max(10e3, Math.min(90e3, timeLeft())) });
    for (const n of res.odd) problem(`${tag}: ${n}.`);
    if (res.off) problem(`${tag}: ${res.off} slide${res.off > 1 ? 's are' : ' is'} not 16:9 in the PDF.`);
    if (res.dropped.length) console.error(`::notice::Downloads: left out of the PDF for ${tag}: ${res.dropped.join(', ')}`);
    keep({ p, r, o, kind: 'pdf', bytes: Buffer.from(res.bytes), pages: res.pages });
  } catch (e) { problem(`No PDF for ${tag}: ${String(e.message).split('\n')[0]}.`); }
  // PowerPoint (presentations)
  if (p.type === 'presentation') {
    try {
      if (m.ok.some((e) => !e.jpg)) throw new Error(`"${m.ok.find((e) => !e.jpg).name}" has no picture`);
      reserve(dir, m.ok.map((e) => [e.jpg, MAX_JPG]), MAX_FILE - MB);     // a picture is not compressed further
      const slides = m.ok.map((e) => {
        const bytes = readPlain(dir, e.jpg, MAX_JPG);
        const s = jpegSize(bytes);
        if (!(s && s.w === 1920 && s.h === 1080)) throw new Error(`${e.jpg} is not a real 1920 x 1080 JPEG picture`);
        return { name: e.name, bytes };
      });
      const res = await buildPptx({ title: p.name, date: roundDate(r), slides });
      keep({ p, r, o, kind: 'pptx', bytes: res.bytes, pages: res.pages });
    } catch (e) { problem(`No PowerPoint for ${tag}: ${String(e.message).split('\n')[0]}.`); }
  }
}
if (notPrinted.length) problem(`Not made, because the time for printing pages ran out first: ${roundsText(notPrinted)}. The downloads Studio already has for them stay.`);
if (late.length) problem(`Not made, because the time for making files (${Math.round(BUDGET_MS / 60e3) || '<1'} minute${BUDGET_MS >= 90e3 ? 's' : ''}) ran out first: ${roundsText(late)}. The downloads Studio already has for them stay.`);
fs.writeFileSync(path.join(outDir, 'exports.json'), JSON.stringify({ files, problems: problems.slice(0, 60) }, null, 1));
console.error(`Downloads: ${files.length} file${files.length === 1 ? '' : 's'}, ${problems.length} problem${problems.length === 1 ? '' : 's'}.`);
