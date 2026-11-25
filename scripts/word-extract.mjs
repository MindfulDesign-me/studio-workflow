// The Word extractor: ONE function that exports.mjs runs inside the page (page.evaluate), in the job that runs
// the designs' code. What it returns is plain data and nothing in it is believed: exports.mjs cleans and
// clips it (word-src.mjs), writes inert files, and assemble.mjs checks them again.
//
// Rules (docs/download-plan.md, "Extractor rules"):
//  - It reads the rendered DOM and computed styles only. It never fetches a URL, never reads a file, never
//    follows a link, never runs a script of the page's. It does mark the figures it finds with an attribute
//    (data-studio-wfig) so the caller can take element screenshots of them.
//  - It skips script, style, noscript, template, nav, button, form controls (input, select, textarea, ...),
//    iframes, media, and anything with role navigation, button, menu, tab, toolbar, search, tooltip ...; and
//    anything hidden: display none, visibility hidden, aria-hidden, a collapsed box with clipped overflow (a
//    closed accordion), a visually-hidden 1 px box, clip or clip-path to nothing, a box fully off the page
//    to the left or the top (or far to the right), and everything inside those. svg text is never read.
//  - It walks in document order. Headings h1-h6 (h4 to h6 are level 3); lists (direct li text, nested lists
//    follow as more items of the same list); tables (cell text, thead rows first); every other element that
//    shows text and has no block child is one paragraph (a card is its text, a label and a title are
//    separate paragraphs when the design makes them separate boxes). Text of inline elements joins the
//    paragraph around them. White space is collapsed. <strong> and <b> runs become **...**.
//  - Figures: svg, canvas and img elements that are at least 120 x 60 px (and at most 2400 x 1600, the most a
//    Word picture may be), in document order, at most opts.maxFigs. Smaller ones are icons and are left out.
// Returns { blocks, figs, tooBig, moreFigs, stopped }. A figure block is { k: 'fig', n: <its number> }.
export function extractDom(opts) {
  const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'nav', 'button', 'select', 'option', 'optgroup', 'datalist', 'input', 'textarea', 'output', 'progress', 'meter', 'iframe', 'frame', 'frameset', 'object', 'embed', 'video', 'audio', 'track', 'source', 'map', 'area', 'head', 'title', 'meta', 'link', 'base', 'dialog']);
  const SKIP_ROLES = new Set(['navigation', 'button', 'menu', 'menubar', 'menuitem', 'toolbar', 'tablist', 'tab', 'tooltip', 'search', 'switch', 'checkbox', 'radio', 'combobox', 'listbox', 'slider', 'spinbutton', 'textbox', 'progressbar']);
  const INLINE = /^(inline|inline-block|inline-flex|inline-grid|inline-table|ruby|ruby-base|ruby-text|contents)$/;
  const out = { blocks: [], figs: 0, tooBig: 0, moreFigs: 0, stopped: false };
  let nodes = 0, bytes = 0;
  const styles = new WeakMap(), skips = new WeakMap(), holds = new WeakMap();
  const css = (el) => { let c = styles.get(el); if (!c) { c = getComputedStyle(el); styles.set(el, c); } return c; };
  scrollTo(0, 0);

  function hidden(el) {
    const c = css(el);
    if (c.display === 'none' || c.visibility === 'hidden' || c.visibility === 'collapse') return true;
    if (c.display === 'contents') return false;
    const r = el.getBoundingClientRect();
    const empty = r.width <= 0 || r.height <= 0;
    const clipped = c.overflow !== 'visible' || c.overflowX !== 'visible' || c.overflowY !== 'visible';
    if (empty && clipped) return true;
    if ((r.width <= 1 || r.height <= 1) && clipped && el.localName !== 'svg') return true;
    if (c.position === 'absolute' && c.clip !== 'auto' && /rect\(\s*0(px)?[ ,]+0(px)?[ ,]+0(px)?[ ,]+0(px)?\s*\)/.test(c.clip)) return true;
    if (/inset\(\s*(50|100)%/.test(c.clipPath)) return true;
    return r.right + scrollX <= 0 || r.bottom + scrollY <= 0 || r.left + scrollX > innerWidth * 2 + 2000;
  }
  function skip(el) {
    let s = skips.get(el);
    if (s !== undefined) return s;
    nodes++;
    const t = el.localName;
    const role = (el.getAttribute('role') || '').toLowerCase();
    s = SKIP_TAGS.has(t) || el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('hidden') || SKIP_ROLES.has(role) || hidden(el);
    skips.set(el, s);
    return s;
  }
  const isBlock = (el) => !INLINE.test(css(el).display);
  const isHeading = (t) => /^h[1-6]$/.test(t);
  const isFigTag = (t) => t === 'svg' || t === 'canvas' || t === 'img';
  const size = (el) => { const r = el.getBoundingClientRect(); return { w: r.width, h: r.height }; };
  const bigFig = (el) => { if (!isFigTag(el.localName)) return false; const s = size(el); return s.w >= opts.minFigW && s.h >= opts.minFigH; };
  // Does it have anything inside that is not part of a run of text: a block, a heading, a list, a table, a figure?
  function holdsStructure(el) {
    let h = holds.get(el);
    if (h !== undefined) return h;
    h = false;
    for (const c of el.children) {
      if (skip(c)) continue;
      const t = c.localName;
      if (isHeading(t) || t === 'ul' || t === 'ol' || t === 'table' || bigFig(c) || isBlock(c) || holdsStructure(c)) { h = true; break; }
    }
    holds.set(el, h);
    return h;
  }
  // An inline element the design sets apart from its neighbours (a box of its own, or a gap of about a fifth of
  // an em at either side, like a number and its title in a heading) is a separate word, not glued to them.
  function apart(el) {
    const c = css(el);
    if (c.display !== 'inline') return true;
    const em = parseFloat(c.fontSize) || 16;
    return (parseFloat(c.marginLeft) || 0) + (parseFloat(c.paddingLeft) || 0) >= em * 0.2 || (parseFloat(c.marginRight) || 0) + (parseFloat(c.paddingRight) || 0) >= em * 0.2;
  }
  const mark = (s) => { const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s); return m[2] ? `${m[1]}**${m[2]}**${m[3]}` : s; };
  const plainStars = (s) => s.replace(/\*{2,}/g, '*');
  // The text of an element's children as one run. nested: lists inside are left for the list walker.
  function inline(el, bold, allowBold, nested) {
    let s = '';
    for (const n of el.childNodes) {
      if (n.nodeType === 3) { s += allowBold ? plainStars(n.nodeValue) : n.nodeValue; continue; }
      if (n.nodeType !== 1 || skip(n)) continue;
      const t = n.localName;
      if (t === 'br' || t === 'wbr') { s += t === 'br' ? ' ' : ''; continue; }
      if (isFigTag(t) || t === 'svg' || t === 'math') continue;
      if (nested && (t === 'ul' || t === 'ol')) continue;
      const strong = allowBold && !bold && (t === 'strong' || t === 'b');
      let inner = inline(n, bold || strong, allowBold, nested);
      if (strong) inner = mark(inner);
      s += isBlock(n) || apart(n) ? ` ${inner} ` : inner;
    }
    return s;
  }
  const tidy = (s) => s.replace(/\s+/g, ' ').replace(/\*\*\s*\*\*/g, '').trim();
  const stop = () => out.stopped || (out.stopped = out.blocks.length >= opts.maxBlocks || bytes > opts.maxBytes || nodes > opts.maxNodes);
  const push = (b, text) => { out.blocks.push(b); bytes += text.length; };
  const para = (t) => { if (t) push({ k: 'p', t }, t); };

  function list(el) {
    const items = [];
    const collect = (l) => {
      for (const li of l.children) {
        if (skip(li) || li.localName !== 'li') continue;
        const t = tidy(inline(li, false, true, true));
        if (t) items.push(t);
        for (const sub of li.children) if ((sub.localName === 'ul' || sub.localName === 'ol') && !skip(sub)) collect(sub);
        if (items.length > 2000) return;
      }
    };
    collect(el);
    if (items.length) push({ k: 'li', ordered: el.localName === 'ol', items }, items.join(''));
  }
  function table(el) {
    const rows = [];
    for (const tr of el.rows) {
      if (skip(tr)) continue;
      const cells = [];
      for (const c of tr.cells) { if (cells.length >= 40) break; cells.push(skip(c) ? '' : tidy(inline(c, false, true, false))); }
      if (cells.some(Boolean)) rows.push(cells);
      if (rows.length >= 600) break;
    }
    if (rows.length) push({ k: 'table', rows }, rows.map((r) => r.join('')).join(''));
  }
  function figure(el) {
    if (!bigFig(el)) return;
    const { w, h } = size(el);
    if (w > opts.maxFigW || h > opts.maxFigH) { out.tooBig++; return; }
    if (el.localName === 'img' && !(el.complete && el.naturalWidth > 0)) return;
    if (out.figs >= opts.maxFigs) { out.moreFigs++; return; }
    out.figs++;
    el.setAttribute('data-studio-wfig', String(out.figs));
    push({ k: 'fig', n: out.figs }, '');
  }
  function walk(parent) {
    let buf = '';
    const flush = () => { const t = tidy(buf); buf = ''; para(t); };
    for (const n of parent.childNodes) {
      if (stop()) break;
      if (n.nodeType === 3) { buf += plainStars(n.nodeValue); continue; }
      if (n.nodeType !== 1 || skip(n)) continue;
      const t = n.localName;
      if (isFigTag(t)) { flush(); figure(n); continue; }
      if (t === 'svg' || t === 'math') continue;
      if (isHeading(t)) { flush(); const h = tidy(inline(n, false, false, false)); if (h) push({ k: 'h', n: Math.min(3, Number(t[1])), t: h }, h); continue; }
      if (t === 'ul' || t === 'ol') { flush(); list(n); continue; }
      if (t === 'table') { flush(); table(n); continue; }
      if (t === 'br') { buf += ' '; continue; }
      if (holdsStructure(n)) { flush(); walk(n); flush(); continue; }
      const strong = t === 'strong' || t === 'b';
      const inner = inline(n, strong, true, false);
      if (isBlock(n)) { flush(); para(tidy(strong ? mark(inner) : inner)); continue; }
      buf += apart(n) ? ` ${strong ? mark(inner) : inner} ` : strong ? mark(inner) : inner;
    }
    flush();
  }
  if (document.body) walk(document.body);
  return out;
}
