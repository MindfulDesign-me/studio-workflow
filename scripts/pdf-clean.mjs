// Downloads, the trusted step: makes one PDF out of printed pages that came from a job which ran design code.
// The pages are NOT copied: each one is rebuilt from an allow-list. Only the keys a printed page needs are
// followed and written into a new file, at every level (the page, its resources, fonts, images, forms,
// colors, patterns and the streams under them); everything else is left behind, so nothing a page could
// do (actions, scripts, links, forms, file attachments, embedded files) can come along, not even as an
// unused object. Streams are copied as they are (their bytes are never decoded here) and only the two kinds
// of compression Chrome prints with are allowed: Flate and DCT (JPEG).
// The work runs in a worker thread with a memory limit and a timeout, so one hostile or huge file ends as
// a plain problem and never takes the whole step down. A second look (findForbidden) scans the finished file.
// Residual risk (docs/download-plan.md): font programs, JPEG and Flate data are passed through as they are;
// a viewer's own parser for those is outside what this step can check.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import {
  PDFDocument, PDFName, PDFDict, PDFArray, PDFNumber, PDFString, PDFHexString, PDFBool, PDFNull, PDFRef,
  PDFStream, PDFRawStream, PDFInvalidObject,
} from 'pdf-lib';

const FILTERS = new Set(['FlateDecode', 'DCTDecode']);
const MAX_OBJECTS = 300000;     // objects followed in one file
const MAX_DEPTH = 24;
const MAX_TREE_NODES = 4000;    // page tree nodes looked at in one file
const MAX_SIDE = 14400;         // points; the PDF limit for a page

// What each kind of object may keep. A key not listed is left behind. Values say what the value must be:
//   v          numbers, names, strings, true/false and lists of those (a dictionary there is left behind)
//   sch:NAME   a dictionary or stream, rebuilt from S.NAME (a list of them is allowed; plain values pass)
//   str:NAME   a stream, rebuilt from S.NAME
//   cs         a color space: a name, or a list that may hold more color spaces, dictionaries and streams
//   xobject    an image or a form (anything else is left behind)
//   map:KIND   a dictionary whose every value is of KIND (fonts by name, images by name, ...)
const STREAM_KEYS = { Filter: 'v', DecodeParms: 'sch:parms' };
const FN = { FunctionType: 'v', Domain: 'v', Range: 'v', Size: 'v', BitsPerSample: 'v', Order: 'v', Encode: 'v', Decode: 'v', C0: 'v', C1: 'v', N: 'v', Functions: 'sch:function', Bounds: 'v' };
const S = {
  parms: { Predictor: 'v', Colors: 'v', BitsPerComponent: 'v', Columns: 'v', ColorTransform: 'v' },
  stream0: {},
  resources: { Font: 'map:sch:font', XObject: 'map:xobject', ExtGState: 'map:sch:extgstate', ColorSpace: 'map:cs', Pattern: 'map:sch:pattern', Shading: 'map:sch:shading', ProcSet: 'v' },
  group: { Type: 'v', S: 'v', CS: 'cs', I: 'v', K: 'v' },
  font: { Type: 'v', Subtype: 'v', BaseFont: 'v', FirstChar: 'v', LastChar: 'v', Widths: 'v', FontDescriptor: 'sch:fontdesc', Encoding: 'sch:encoding', ToUnicode: 'str:stream0', DescendantFonts: 'sch:font', CIDSystemInfo: 'sch:cidinfo', DW: 'v', W: 'v', DW2: 'v', W2: 'v', CIDToGIDMap: 'sch:stream0', FontBBox: 'v', FontMatrix: 'v', CharProcs: 'map:str:stream0', Resources: 'sch:resources' },
  fontdesc: { Type: 'v', FontName: 'v', FontFamily: 'v', FontStretch: 'v', FontWeight: 'v', Flags: 'v', FontBBox: 'v', ItalicAngle: 'v', Ascent: 'v', Descent: 'v', Leading: 'v', CapHeight: 'v', XHeight: 'v', StemV: 'v', StemH: 'v', AvgWidth: 'v', MaxWidth: 'v', MissingWidth: 'v', FontFile: 'str:fontfile', FontFile2: 'str:fontfile', FontFile3: 'str:fontfile', CIDSet: 'str:stream0' },
  fontfile: { Length1: 'v', Length2: 'v', Length3: 'v', Subtype: 'v' },
  encoding: { Type: 'v', BaseEncoding: 'v', Differences: 'v' },
  cidinfo: { Registry: 'v', Ordering: 'v', Supplement: 'v' },
  image: { Type: 'v', Subtype: 'v', Width: 'v', Height: 'v', ColorSpace: 'cs', BitsPerComponent: 'v', Decode: 'v', ImageMask: 'v', Mask: 'sch:image', SMask: 'sch:image', Interpolate: 'v', Intent: 'v', SMaskInData: 'v', Matte: 'v', ColorTransform: 'v' },
  form: { Type: 'v', Subtype: 'v', BBox: 'v', Matrix: 'v', Resources: 'sch:resources', Group: 'sch:group' },
  extgstate: { Type: 'v', LW: 'v', LC: 'v', LJ: 'v', ML: 'v', D: 'v', RI: 'v', OP: 'v', op: 'v', OPM: 'v', FL: 'v', SM: 'v', SA: 'v', BM: 'v', SMask: 'sch:softmask', CA: 'v', ca: 'v', AIS: 'v', TK: 'v' },
  softmask: { Type: 'v', S: 'v', G: 'sch:form', BC: 'v', TR: 'sch:function' },
  pattern: { Type: 'v', PatternType: 'v', PaintType: 'v', TilingType: 'v', BBox: 'v', XStep: 'v', YStep: 'v', Resources: 'sch:resources', Matrix: 'v', Shading: 'sch:shading', ExtGState: 'sch:extgstate' },
  shading: { ShadingType: 'v', ColorSpace: 'cs', Background: 'v', BBox: 'v', AntiAlias: 'v', Domain: 'v', Coords: 'v', Function: 'sch:function', Extend: 'v', Matrix: 'v', BitsPerCoordinate: 'v', BitsPerComponent: 'v', BitsPerFlag: 'v', Decode: 'v', VerticesPerRow: 'v' },
  function: FN,
  csobj: { ...FN, Alternate: 'cs', WhitePoint: 'v', BlackPoint: 'v', Gamma: 'v', Matrix: 'v', Range: 'v' },
};
// Left behind on every page and object and not worth a note (a printed page has these).
const EXPECTED_DROPS = new Set(['Length', 'Parent', 'Tabs', 'Annots', 'StructParents', 'StructParent']);

const isPrimitive = (o) => o instanceof PDFName || o instanceof PDFNumber || o instanceof PDFString || o instanceof PDFHexString || o instanceof PDFBool || o === PDFNull;
const nameOf = (o) => (o instanceof PDFName ? o.decodeText() : null);
const numbers = (o, n) => o instanceof PDFArray && o.size() === n && o.asArray().every((x) => x instanceof PDFNumber && Number.isFinite(x.asNumber()));

class Cleaner {
  constructor(src, out) {
    this.sc = src.context; this.oc = out.context;
    this.memo = new Map(); this.count = 0; this.dropped = new Set();
  }
  drop(k) { if (!EXPECTED_DROPS.has(k)) this.dropped.add(k); }
  // A dictionary or stream rebuilt from its schema. Returns undefined when the value must be left behind.
  copy(kind, val, depth = 0) {
    if (depth > MAX_DEPTH || ++this.count > MAX_OBJECTS) throw new Error('it is nested too deeply or has too many parts');
    let ref = null;
    if (val instanceof PDFRef) { ref = val; val = this.sc.lookup(val); }
    if (val === undefined || val instanceof PDFInvalidObject) return undefined;
    if (kind.startsWith('map:')) {
      if (!(val instanceof PDFDict) || val instanceof PDFStream) return undefined;
      const d = PDFDict.withContext(this.oc);
      for (const [k, v] of val.entries()) { const c = this.copy(kind.slice(4), v, depth + 1); if (c !== undefined) d.set(PDFName.of(k.decodeText()), c); else this.drop(`${k.decodeText()} (in a list)`); }
      return d;
    }
    if (isPrimitive(val)) return kind.startsWith('str:') || kind === 'xobject' ? undefined : val;
    if (val instanceof PDFArray) {
      if (kind === 'xobject') return undefined;
      const a = this.oc.obj([]);
      for (const e of val.asArray()) {
        const c = this.copy(kind === 'cs' ? 'cs.item' : kind, e, depth + 1);
        if (c !== undefined) a.push(c);
      }
      return a;
    }
    const stream = val instanceof PDFStream;
    if (stream && !(val instanceof PDFRawStream)) return undefined;
    if (!stream && !(val instanceof PDFDict)) return undefined;
    let schema, name = kind.replace(/^(sch|str):/, '');
    if (kind === 'v') return undefined;                                   // a dictionary where plain values belong
    if (kind === 'cs') return undefined;                                  // a color space is a name or a list
    if (kind === 'cs.item') name = 'csobj';
    if (kind === 'xobject') {
      if (!stream) return undefined;
      const sub = nameOf(val.dict.get(PDFName.of('Subtype')));
      if (sub !== 'Image' && sub !== 'Form') { this.drop(`XObject ${sub || 'of no kind'}`); return undefined; }
      name = sub === 'Image' ? 'image' : 'form';
    } else if (kind.startsWith('str:') && !stream) return undefined;
    schema = S[name];
    if (!schema) return undefined;
    const key = ref ? `${ref.tag}|${name}` : null;
    if (key && this.memo.has(key)) return this.memo.get(key);
    const target = ref ? this.oc.nextRef() : null;
    if (key) this.memo.set(key, target);
    const d = PDFDict.withContext(this.oc);
    const dict = stream ? val.dict : val;
    for (const [k, v] of dict.entries()) {
      const kn = k.decodeText();
      const want = schema[kn] ?? (stream ? STREAM_KEYS[kn] : undefined);
      if (!want) { this.drop(kn); continue; }
      if (kn === 'Filter') this.checkFilter(v);
      const c = this.copy(want, v, depth + 1);
      if (c !== undefined) d.set(PDFName.of(kn), c); else this.drop(kn);
    }
    let result;
    if (stream) { d.set(PDFName.of('Length'), PDFNumber.of(val.contents.length)); result = PDFRawStream.of(d, val.contents); } else result = d;
    if (target) { this.oc.assign(target, result); return target; }
    return stream ? this.oc.register(result) : result;
  }
  checkFilter(v) {
    const list = v instanceof PDFRef ? this.sc.lookup(v) : v;
    const names = list instanceof PDFArray ? list.asArray().map((x) => nameOf(x instanceof PDFRef ? this.sc.lookup(x) : x)) : [nameOf(list)];
    for (const n of names) if (!FILTERS.has(n)) throw new Error(`it uses a kind of compression that is not allowed (${String(n).slice(0, 30)})`);
  }
}

// The pages of a document, in order, without trusting its own count: the tree is walked with a limit on
// depth, nodes and pages, and a node reached twice means the tree is not a tree (a trick to make a few
// bytes stand for billions of pages).
function pageLeaves(src, max) {
  const ctx = src.context, leaves = [], seen = new Set();
  let nodes = 0;
  const walk = (ref, inherited, depth) => {
    if (!(ref instanceof PDFRef) || depth > 16 || ++nodes > MAX_TREE_NODES) throw new Error('its page tree is broken or too big');
    if (seen.has(ref.tag)) throw new Error('its page tree is broken (a page is reached twice)');
    seen.add(ref.tag);
    const node = ctx.lookup(ref);
    if (!(node instanceof PDFDict)) throw new Error('its page tree is broken');
    const here = { ...inherited };
    for (const k of ['Resources', 'MediaBox', 'CropBox', 'Rotate']) { const v = node.get(PDFName.of(k)); if (v !== undefined) here[k] = v; }
    const kids = node.get(PDFName.of('Kids'));
    const list = kids instanceof PDFRef ? ctx.lookup(kids) : kids;
    if (list instanceof PDFArray) { for (const k of list.asArray()) walk(k, here, depth + 1); return; }
    if (leaves.length >= max) throw new Error(`it has more than ${max} pages`);
    leaves.push({ attrs: here, contents: node.get(PDFName.of('Contents')), group: node.get(PDFName.of('Group')) });
  };
  const pages = src.catalog.get(PDFName.of('Pages'));
  walk(pages, {}, 0);
  return leaves;
}

// What a finished file must not hold anywhere (the second look, after the rebuild).
const BAD_KEYS = ['JS', 'JavaScript', 'AA', 'A', 'OpenAction', 'Annots', 'AcroForm', 'EmbeddedFiles', 'EF', 'RF', 'Names', 'RichMedia', 'XFA', 'URI', 'Launch', 'Outlines', 'F', 'FS', 'FFilter', 'Ref', 'Alternates', 'OPI', 'Metadata', 'OC', 'Dests', 'Threads', 'SpiderInfo'].map((k) => PDFName.of(k));
const BAD_ACTIONS = new Set(['JavaScript', 'Launch', 'URI', 'SubmitForm', 'ImportData', 'GoToR', 'GoToE', 'Rendition', 'Movie', 'Sound']);
export function findForbidden(doc) {
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    const d = obj instanceof PDFDict ? obj : obj instanceof PDFStream ? obj.dict : null;
    if (!d) continue;
    if (BAD_KEYS.some((k) => d.has(k))) return 'an action, link, attachment or script';
    const s = d.get(PDFName.of('S'));
    if (s instanceof PDFName && BAD_ACTIONS.has(s.decodeText())) return 'an action';
    const t = d.get(PDFName.of('Type'));
    if (t instanceof PDFName && ['EmbeddedFile', 'Filespec', 'Annot', 'Action'].includes(t.decodeText())) return 'an attachment, link or action';
    const f = d.get(PDFName.of('Filter'));
    const fl = f instanceof PDFArray ? f.asArray() : f ? [f] : [];
    for (const x of fl) if (!(x instanceof PDFName) || !FILTERS.has(x.decodeText())) return 'a kind of compression that is not allowed';
    if (obj instanceof PDFStream) {
      const sub = d.get(PDFName.of('Subtype'));
      if (sub instanceof PDFName && ['PS', 'JavaScript', 'Sound', 'Movie'].includes(sub.decodeText())) return 'a program or media object';
    }
  }
  return null;
}

// job: { pages: [{ name, bytes }], title, dateMs, single, maxPages, slides }
// Returns { bytes, pages, odd: [text], off: number of pages not 1440 x 810 points (when slides), dropped: [key] }.
export async function buildPdf(job) {
  const out = await PDFDocument.create({ updateMetadata: false });
  const cleaner = new Cleaner({ context: null }, out);
  let total = 0, off = 0;
  const odd = [];
  for (const pg of job.pages) {
    const raw = Buffer.from(pg.bytes.buffer, pg.bytes.byteOffset, pg.bytes.length);
    // A printed page has no compressed object streams. They are the one place a small file could unpack
    // into gigabytes before anything is checked, so a file that has one is refused unread.
    if (raw.includes('/ObjStm') || raw.includes('/XRef')) throw new Error(`"${pg.name}" uses compressed object streams, which a printed page does not`);
    const src = await PDFDocument.load(raw, { ignoreEncryption: false, updateMetadata: false, throwOnInvalidObject: false, parseSpeed: Infinity });
    const leaves = pageLeaves(src, Math.max(0, job.maxPages - total));
    if (!leaves.length) throw new Error(`"${pg.name}" printed no pages`);
    cleaner.sc = src.context; cleaner.memo = new Map();
    const take = job.single ? leaves.slice(0, 1) : leaves;
    for (const leaf of take) {
      const mb = leaf.attrs.MediaBox instanceof PDFRef ? src.context.lookup(leaf.attrs.MediaBox) : leaf.attrs.MediaBox;
      if (!numbers(mb, 4)) throw new Error(`"${pg.name}" has a page without a size`);
      const [x0, y0, x1, y1] = mb.asArray().map((n) => n.asNumber());
      const w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
      if (!(w >= 1 && h >= 1 && w <= MAX_SIDE && h <= MAX_SIDE)) throw new Error(`"${pg.name}" has a page of an odd size`);
      const page = out.addPage([w, h]);
      const node = page.node;
      node.set(PDFName.of('MediaBox'), out.context.obj([x0, y0, x1, y1]));
      const crop = leaf.attrs.CropBox instanceof PDFRef ? src.context.lookup(leaf.attrs.CropBox) : leaf.attrs.CropBox;
      if (numbers(crop, 4)) node.set(PDFName.of('CropBox'), out.context.obj(crop.asArray().map((n) => n.asNumber())));
      const rot = leaf.attrs.Rotate instanceof PDFRef ? src.context.lookup(leaf.attrs.Rotate) : leaf.attrs.Rotate;
      if (rot instanceof PDFNumber && [0, 90, 180, 270].includes(rot.asNumber())) node.set(PDFName.of('Rotate'), rot);
      const res = leaf.attrs.Resources === undefined ? undefined : cleaner.copy('sch:resources', leaf.attrs.Resources);
      node.set(PDFName.of('Resources'), res instanceof PDFDict ? res : out.context.obj({}));
      if (leaf.contents !== undefined) {
        const c = cleaner.copy('str:stream0', leaf.contents);
        if (c !== undefined) node.set(PDFName.of('Contents'), c);
      }
      if (leaf.group !== undefined) { const g = cleaner.copy('sch:group', leaf.group); if (g !== undefined) node.set(PDFName.of('Group'), g); }
      if (job.slides && (Math.abs(w - 1440) > 3 || Math.abs(h - 810) > 3)) off++;
      if (++total > job.maxPages) throw new Error(`it has more than ${job.maxPages} pages`);
    }
    if (job.single && leaves.length > 1) odd.push(`"${pg.name}" printed ${leaves.length} pages; only the first is in the PDF`);
  }
  const bad = findForbidden(out);
  if (bad) throw new Error(`it held ${bad}`);
  const date = new Date(job.dateMs);
  out.setTitle(job.title); out.setAuthor(''); out.setSubject(''); out.setKeywords([]);
  out.setCreator('MindfulStudio'); out.setProducer('MindfulStudio');
  out.setCreationDate(date); out.setModificationDate(date);
  return { bytes: await out.save({ useObjectStreams: false }), pages: total, odd, off, dropped: [...cleaner.dropped].sort().slice(0, 30) };
}

// ---- running it in a worker --------------------------------------------------------------------------
if (!isMainThread && workerData?.pdfJob) {
  try { parentPort.postMessage({ ok: true, ...(await buildPdf(workerData.pdfJob)) }); } catch (e) { parentPort.postMessage({ ok: false, error: String(e?.message || e).split('\n')[0].slice(0, 200) }); }
}

export function buildPdfSafely(job, { timeoutMs = 60e3, heapMb = 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { pdfJob: job }, resourceLimits: { maxOldGenerationSizeMb: heapMb, maxYoungGenerationSizeMb: 64 } });
    let done = false;
    const end = (fn, v) => { if (done) return; done = true; clearTimeout(timer); w.terminate().catch(() => {}); fn(v); };
    const secs = Math.max(1, Math.round(timeoutMs / 1000));
    const timer = setTimeout(() => end(reject, new Error(`it took longer than ${secs} second${secs === 1 ? '' : 's'} to check`)), timeoutMs);
    w.on('message', (m) => (m.ok ? end(resolve, m) : end(reject, new Error(m.error))));
    w.on('error', (e) => end(reject, new Error(e?.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'it needed too much memory to check' : String(e?.message || e).split('\n')[0])));
    w.on('exit', () => end(reject, new Error('the check stopped unexpectedly')));
  });
}
