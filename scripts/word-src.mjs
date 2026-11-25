// The Word source ("wordsrc"): the text and pictures of a proposal or document, as one JSON file per round and
// option. It is INTERNAL: never listed or downloaded by people. The Studio server reads it, has Claude tidy it
// into an outline and writes the .docx from that (docs/download-plan.md, "Word").
// Shared by exports.mjs (the untrusted step: lenient, it clips to the caps and says so) and assemble.mjs (the
// trusted step: strict, anything that is not exactly the schema is refused). No imports but node:zlib.
//
// File, version 1 (UTF-8 JSON, stable key order, no timestamps: the same material gives the same bytes):
//   { "v": 1, "title": "<project name>",
//     "blocks": [ { "k": "page", "name": "..." },
//                 { "k": "h", "n": 1..3, "t": "..." },
//                 { "k": "p", "t": "text with **bold** runs" },
//                 { "k": "li", "ordered": false, "items": ["..."] },
//                 { "k": "table", "rows": [["..."]] },          // rows[0] is the header row when the table has one
//                 { "k": "fig", "id": "f1" } ],
//     "figures": { "f1": { "w": 600, "h": 300, "png": "<base64>" } } }
// What exports.mjs writes per page (inert intermediates) is the same without "page" blocks and with figure
// references by number: word-pNNN.json = { "v": 1, "blocks": [ ..., { "k": "fig", "n": 1 } ] } and the pictures
// wNNN-fMM.png; assemble.mjs merges them.
import zlib from 'node:zlib';

export const CAPS = Object.freeze({
  blocks: 3000,                  // blocks in one file (page blocks included)
  text: 4000,                    // characters in one text
  totalText: 400 * 1024,         // bytes of all the text together
  listItems: 200, rows: 200, cols: 12,
  figures: 20, figW: 2400, figH: 1600, figBytes: Math.round(1.5 * 1048576),
  fileBytes: 12 * 1048576,       // the finished file
  pageJson: 1048576,             // one word-pNNN.json as read by the assembler
});

// ---- text ------------------------------------------------------------------------------------------
// Built from code points, so this source holds no invisible characters. To a space: C0 and C1 controls (tab and
// newline too) and the line and paragraph separators. Dropped: the soft hyphen, bidi overrides and isolates,
// and the byte order mark.
const chars = (...ranges) => new RegExp(`[${ranges.map(([a, b]) => String.fromCharCode(a) + (b ? `-${String.fromCharCode(b)}` : '')).join('')}]`, 'g');
const TO_SPACE = chars([0, 0x1f], [0x7f, 0x9f], [0x2028], [0x2029]);
const DROP = chars([0xad], [0x202a, 0x202e], [0x2066, 0x2069], [0xfeff]);
// One line of plain text: no control characters, no bidi overrides, no byte order mark, no lone surrogates,
// runs of white space collapsed. Anything that is not a string is "".
export function cleanText(v) {
  let s = typeof v === 'string' ? v : '';
  s = s.toWellFormed();
  return s.replace(TO_SPACE, ' ').replace(DROP, '').replace(/\s+/g, ' ').trim();
}
// Bold is **...** and nothing else. Runs of three or more stars are two; an odd number of markers (a broken
// run) or an empty run takes all the markers out, so a text never holds half a run.
export function cleanBold(s) {
  s = s.replace(/\*{3,}/g, '**');
  if ((s.split('**').length - 1) % 2) return s.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
  return s.replace(/\*\*\s*\*\*/g, '').replace(/\s+/g, ' ').trim();
}
const stripBold = (s) => s.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
const bytesOf = (s) => Buffer.byteLength(s, 'utf8');
const boldMarks = (s) => s.split('**').length - 1;

// A text longer than max is split, never cut: at the last sentence end in the second half, else the last
// space, else (a word that long) at max. A bold run that is split is closed and opened again.
export function splitText(t, max = CAPS.text) {
  const limit = max - 4, out = [];
  let rest = t;
  while (rest.length > max) {
    let cut = -1;
    const win = rest.slice(0, limit + 1);
    for (const m of win.matchAll(/[.!?…]["'”’)\]*]*\s/g)) { const at = m.index + m[0].length; if (at > limit * 0.5 && at <= limit) cut = at; }
    if (cut < 0) { const sp = win.lastIndexOf(' '); cut = sp > limit * 0.3 ? sp + 1 : limit; }
    if (cut === limit) {                                      // a hard cut: not inside a surrogate pair or a ** marker
      const c = rest.charCodeAt(cut - 1);
      if (c >= 0xd800 && c <= 0xdbff) cut--;
      if (rest[cut - 1] === '*' && rest[cut] === '*') cut--;
    }
    let left = rest.slice(0, cut).trimEnd(), right = rest.slice(cut).trimStart();
    if (boldMarks(left) % 2) { left += '**'; right = `**${right}`; }
    if (left) out.push(left);
    rest = right;
  }
  if (rest) out.push(rest);
  return out;
}
// A text that must stay in one piece (a heading, a list item, a cell): cut at a space, never longer than max.
function cutText(t, max = CAPS.text) {
  if (t.length <= max) return { text: t, cut: false };
  const sp = t.lastIndexOf(' ', max);
  let s = t.slice(0, sp > max * 0.5 ? sp : max).trimEnd();
  if (boldMarks(s) % 2) s += '**';
  return { text: s, cut: true };
}

// ---- blocks ------------------------------------------------------------------------------------------
// Checks a list of blocks of one page and returns clean ones. st is the running budget of the whole file:
// { blocks, bytes, stop, said: Set }. strict (the assembler): a wrong shape, a kind that is not known, or
// more blocks, items, rows or columns than the caps is an Error and the whole file is refused. Not strict
// (the extractor): the same things are clipped to the caps, and a note says so. In both, text that is too
// long is split (paragraphs) or cut (the rest), and what does not fit in the text budget is left out with a
// note. A figure block { k: 'fig', n } is kept as it is when n is a whole number from 1 to figCount (strict) or
// from 1 (not strict, where the pictures are not known yet).
export function newBudget() { return { blocks: 0, bytes: 0, stop: false, said: new Set() }; }
export function normalizeBlocks(raw, st, { strict = true, figCount = 0, note = () => {} } = {}) {
  const say = (m) => { if (!st.said.has(m)) { st.said.add(m); note(m); } };
  const bad = (m) => { if (strict) throw new Error(m); return null; };
  if (!Array.isArray(raw)) { bad('its list of blocks is not a list'); return []; }
  if (strict && raw.length > CAPS.blocks) throw new Error(`it has more than ${CAPS.blocks} blocks`);
  const out = [];
  // Takes a finished block into the budget, or says why not.
  const add = (block, bytes) => {
    if (st.stop) return false;
    if (st.blocks + 1 > CAPS.blocks) { if (strict) throw new Error(`it has more than ${CAPS.blocks} blocks`); st.stop = true; say(`Only the first ${CAPS.blocks} blocks of the text are in the Word copy; the rest was left out.`); return false; }
    if (st.bytes + bytes > CAPS.totalText) { st.stop = true; say(`The text is more than ${CAPS.totalText / 1024} KB; only the first part is in the Word copy.`); return false; }
    st.blocks++; st.bytes += bytes; out.push(block); return true;
  };
  const piece = (v, bold) => { const c = cleanText(v); return bold ? cleanBold(c) : stripBold(c); };
  const one = (v, bold, what) => { const r = cutText(piece(v, bold)); if (r.cut) say(`A very long ${what} was cut in the Word copy.`); return r.text; };
  for (const b of raw) {
    if (st.stop) break;
    if (!b || typeof b !== 'object' || Array.isArray(b)) { bad('a block is not an object'); continue; }
    switch (b.k) {
      case 'h': {
        if (typeof b.t !== 'string') { bad('a heading has no text'); continue; }
        if (!Number.isInteger(b.n) || b.n < 1 || b.n > 6) { bad('a heading has a level that is not 1 to 6'); continue; }
        const t = one(b.t, false, 'heading');
        if (t) add({ k: 'h', n: Math.min(3, b.n), t }, bytesOf(t));
        break;
      }
      case 'p': {
        if (typeof b.t !== 'string') { bad('a paragraph has no text'); continue; }
        for (const part of splitText(piece(b.t, true))) { const t = cleanBold(part); if (t && !add({ k: 'p', t }, bytesOf(t))) break; }
        break;
      }
      case 'li': {
        if (!Array.isArray(b.items)) { bad('a list has no items'); continue; }
        if (strict && b.items.length > CAPS.listItems) throw new Error(`a list has more than ${CAPS.listItems} items`);
        const items = b.items.map((x) => (typeof x === 'string' ? one(x, true, 'list item') : (bad('a list item is not text'), ''))).filter(Boolean);
        for (let i = 0; i < items.length; i += CAPS.listItems) {
          const chunk = items.slice(i, i + CAPS.listItems);
          if (!add({ k: 'li', ordered: b.ordered === true, items: chunk }, chunk.reduce((a, x) => a + bytesOf(x), 0))) break;
        }
        break;
      }
      case 'table': {
        if (!Array.isArray(b.rows)) { bad('a table has no rows'); continue; }
        if (strict && b.rows.length > CAPS.rows) throw new Error(`a table has more than ${CAPS.rows} rows`);
        if (b.rows.length > CAPS.rows) say(`A table has more than ${CAPS.rows} rows; the rest was left out of the Word copy.`);
        const rows = [];
        for (const row of b.rows.slice(0, CAPS.rows)) {
          if (!Array.isArray(row)) { bad('a table row is not a list'); continue; }
          if (strict && row.length > CAPS.cols) throw new Error(`a table has more than ${CAPS.cols} columns`);
          if (row.length > CAPS.cols) say(`A table has more than ${CAPS.cols} columns; the rest was left out of the Word copy.`);
          const cells = row.slice(0, CAPS.cols).map((x) => (typeof x === 'string' ? one(x, true, 'table cell') : (bad('a table cell is not text'), '')));
          if (cells.some(Boolean)) rows.push(cells);
        }
        if (!rows.length) break;
        const width = Math.max(...rows.map((r) => r.length));
        for (const r of rows) while (r.length < width) r.push('');
        add({ k: 'table', rows }, rows.reduce((a, r) => a + r.reduce((x, c) => x + bytesOf(c), 0), 0));
        break;
      }
      case 'fig': {
        if (!Number.isInteger(b.n) || b.n < 1 || (strict && b.n > figCount)) { bad('a picture block points to a picture that is not there'); continue; }
        add({ k: 'fig', n: b.n }, 0);
        break;
      }
      default: bad(`a block of an unknown kind (${cleanText(String(b.k)).slice(0, 20)})`);
    }
  }
  return out;
}

// ---- PNG ---------------------------------------------------------------------------------------------
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const KEEP = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND', 'sRGB', 'gAMA', 'pHYs']);   // everything else (text, profiles, ...) is left behind
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const DEPTHS = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
export const isPngBytes = (b) => Buffer.isBuffer(b) && b.length >= 8 && b.subarray(0, 8).equals(PNG_SIG);
// The width and height from the header, without reading further (null when it is not a PNG).
export function pngSize(b) {
  if (!isPngBytes(b) || b.length < 33 || b.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}
// A real PNG within the caps, rebuilt from an allow-list of chunks (so no text or profile chunk comes along):
// every chunk's checksum is checked, the header and its values are valid, it is not interlaced, nothing
// follows the end, and the image data inflates to exactly the size the header promises. Returns
// { png, w, h } or throws.
export function cleanPng(buf) {
  if (!isPngBytes(buf) || buf.length < 57) throw new Error('is not a real PNG picture');
  let pos = 8, hdr = null, ended = false, plte = false, idat = false;
  const keep = [], data = [];
  while (pos + 12 <= buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString('latin1', pos + 4, pos + 8);
    if (len > 0x7fffffff || pos + 12 + len > buf.length || !/^[A-Za-z]{4}$/.test(type)) throw new Error('is not a real PNG picture (a part is broken)');
    if (zlib.crc32(buf.subarray(pos + 4, pos + 8 + len)) >>> 0 !== buf.readUInt32BE(pos + 8 + len)) throw new Error('is not a real PNG picture (a part is damaged)');
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (!hdr) {
      if (type !== 'IHDR' || len !== 13) throw new Error('is not a real PNG picture (no header)');
      hdr = { w: body.readUInt32BE(0), h: body.readUInt32BE(4), depth: body[8], ctype: body[9], comp: body[10], filt: body[11], inter: body[12] };
    } else if (type === 'IHDR') throw new Error('is not a real PNG picture (two headers)');
    else if (/^[A-Z]/.test(type) && !['PLTE', 'IDAT', 'IEND'].includes(type)) throw new Error('is not a PNG picture this step reads');
    if (type === 'PLTE') plte = true;
    if (type === 'IDAT') { idat = true; data.push(body); }
    if (KEEP.has(type)) keep.push(buf.subarray(pos, pos + 12 + len));
    pos += 12 + len;
    if (type === 'IEND') { ended = true; break; }
  }
  if (!hdr || !ended || pos !== buf.length || !idat) throw new Error('is not a real PNG picture (it is cut short or has more after its end)');
  const { w, h, depth, ctype } = hdr;
  if (!(w >= 1 && h >= 1) || !DEPTHS[ctype]?.includes(depth) || hdr.comp !== 0 || hdr.filt !== 0 || hdr.inter !== 0) throw new Error('is not a real PNG picture (its header is not valid or it is interlaced)');
  if (w > CAPS.figW || h > CAPS.figH) throw new Error(`is ${w} x ${h} pixels and a picture may be at most ${CAPS.figW} x ${CAPS.figH}`);
  if (ctype === 3 && !plte) throw new Error('is not a real PNG picture (no palette)');
  const expected = h * (1 + Math.ceil((w * CHANNELS[ctype] * depth) / 8));
  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(data), { maxOutputLength: expected + 1 }); } catch { throw new Error('is not a real PNG picture (its image data is damaged)'); }
  if (raw.length !== expected) throw new Error('is not a real PNG picture (its image data is the wrong size)');
  return { png: Buffer.concat([PNG_SIG, ...keep]), w, h };
}

// ---- the file ----------------------------------------------------------------------------------------
// pages: [{ name, doc: <parsed word-pNNN.json>, figures: [Buffer, ...] }] in studio.json order. Strict: throws
// an Error (a plain sentence, no full stop) for anything that is not exactly what exports.mjs makes. note(text)
// is called for what was left out but does not stop the file. Returns the file as a Buffer.
export function buildWordSource({ title, pages, note = () => {} }) {
  const st = newBudget();
  const out = [], figs = [];                       // figs: { w, h, b64 }
  const cleanName = (v, max) => cleanText(v).slice(0, max);
  const name = cleanName(title, 200);
  st.bytes += bytesOf(name);
  // Every picture is checked, whether a block uses it or not.
  const checked = pages.map((pg, i) => {
    const list = Array.isArray(pg.figures) ? pg.figures : [];
    return list.map((b, j) => { try { return cleanPng(b); } catch (e) { throw new Error(`the picture ${j + 1} of page ${i + 1} ${e.message}`); } });
  });
  if (checked.reduce((a, l) => a + l.length, 0) > CAPS.figures) throw new Error(`it has more than ${CAPS.figures} pictures`);
  for (const [i, pg] of pages.entries()) {
    const doc = pg.doc;
    if (!doc || typeof doc !== 'object' || Array.isArray(doc) || doc.v !== 1) throw new Error(`the text of page ${i + 1} is not in the form this step reads`);
    const label = cleanName(pg.name, 200);
    if (st.blocks + 1 > CAPS.blocks) throw new Error(`it has more than ${CAPS.blocks} blocks`);
    st.blocks++; st.bytes += bytesOf(label); out.push({ k: 'page', name: label });
    const used = new Set();
    for (const b of normalizeBlocks(doc.blocks, st, { strict: true, figCount: checked[i].length, note })) {
      if (b.k !== 'fig') { out.push(b); continue; }
      if (used.has(b.n)) throw new Error(`a picture of page ${i + 1} is used twice`);
      used.add(b.n);
      const f = checked[i][b.n - 1];
      figs.push({ w: f.w, h: f.h, b64: f.png.toString('base64') });
      out.push({ k: 'fig', id: `f${figs.length}` });
    }
  }
  if (!out.some((b) => b.k !== 'page')) throw new Error('no text or picture was found on the pages');
  const write = (n) => {
    const keepFigs = figs.slice(0, n), ids = new Set(keepFigs.map((_, k) => `f${k + 1}`));
    const blocks = out.filter((b) => b.k !== 'fig' || ids.has(b.id));
    const figures = {};
    for (const [k, f] of keepFigs.entries()) figures[`f${k + 1}`] = { w: f.w, h: f.h, png: f.b64 };
    return Buffer.from(JSON.stringify({ v: 1, title: name, blocks, figures }), 'utf8');
  };
  let n = figs.length, bytes = write(n);
  while (bytes.length > CAPS.fileBytes && n > 0) { n--; bytes = write(n); }
  if (n < figs.length) note(`${figs.length - n} picture${figs.length - n > 1 ? 's were' : ' was'} left out of the Word copy: the file would be over ${CAPS.fileBytes / 1048576} MB.`);
  if (bytes.length > CAPS.fileBytes) throw new Error(`it is more than ${CAPS.fileBytes / 1048576} MB`);
  return bytes;
}
