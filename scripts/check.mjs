// Job "studio": the phase 1a checks (PLAN.md section 9), on built files and the repo's text, never
// running anything from the repo. Prints { tool, findings: [{ level, check, message, where }] }.
//   node check.mjs studio.json dist repo
import fs from 'node:fs';
import path from 'node:path';
import { readStudio, walk } from './lib.mjs';

const [studioFile, dist, repo] = process.argv.slice(2);
const studio = readStudio(studioFile);
const findings = [];
const add = (level, check, message, where = '') => findings.push({ level, check, message, where });
const strip = (html) => html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');

for (const p of studio.projects) for (const r of p.rounds) {
  const root = path.join(dist, r.root);
  if (!fs.existsSync(root)) continue;
  const files = new Set([...walk(root)]);
  for (const rel of files) {
    if (!/\.html?$/.test(rel)) continue;
    const html = fs.readFileSync(path.join(root, rel), 'utf8');
    const body = strip(html);
    const where = `round ${r.number} · ${rel}`;
    // Links and assets resolve inside the round
    for (const m of html.matchAll(/\s(?:href|src)="([^"#?]+)[^"]*"/gi)) {
      const u = m[1];
      if (/^(https?:|mailto:|tel:|data:|javascript:|\/\/)/i.test(u)) continue;
      const target = u.startsWith('/') ? u.slice(1) : path.posix.normalize(path.posix.join(path.posix.dirname(rel), u));
      if (target.startsWith('..')) { add('should', 'Links and assets', `"${u}" points outside this round, so it won't open for the client.`, where); continue; }
      const t = target.endsWith('/') || target === '.' ? `${target === '.' ? '' : target}index.html` : target;
      if (!files.has(t) && !files.has(`${t}/index.html`)) add('must', 'Links and assets', `"${u}" doesn't exist in the round.`, where);
    }
    const h1 = (body.match(/<h1[\s>]/gi) || []).length;
    if (h1 !== 1) add('should', 'One h1', `This page has ${h1} h1 headings; it should have exactly one.`, where);
    for (const m of body.matchAll(/<img\b[^>]*>/gi)) if (!/\salt\s*=/.test(m[0])) add('must', 'Alt text', `An image has no alt text: ${m[0].slice(0, 90)}`, where);
    const textOnly = body.replace(/<[^>]+>/g, ' ');
    if (/—/.test(textOnly)) add('note', 'House style', 'An em dash is in the text (our house style avoids them).', where);
    if (/lorem ipsum|\bTODO\b|\bxxx\b|\bTBC\b/i.test(textOnly)) add('must', 'Placeholder text', 'Placeholder text is still on the page (lorem ipsum, TODO, xxx or TBC).', where);
    if (!/<title>[^<]+<\/title>/i.test(html)) add('should', 'Page title', 'The page has no <title>.', where);
    if (!/<html[^>]*\slang=/i.test(html)) add('should', 'Page language', 'The <html> element has no lang attribute.', where);
  }
}
// Secrets anywhere in the repo's text files (a hit is a must fix; Studio also quarantines it).
const SECRETS = [[/\bmst_[A-Za-z0-9_-]{43}\b/, 'a MindfulStudio token'], [/-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/, 'a private key'], [/\bghp_[A-Za-z0-9]{36}\b/, 'a GitHub token'], [/\bgithub_pat_[A-Za-z0-9_]{60,}\b/, 'a GitHub token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS key'], [/\bsk_live_[A-Za-z0-9]{20,}\b/, 'a Stripe key'], [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, 'a Slack token'], [/\bAIza[0-9A-Za-z_-]{35}\b/, 'a Google key'], [/\bxkeysib-[a-f0-9]{64}/, 'a Brevo key']];
if (repo && fs.existsSync(repo)) for (const rel of walk(repo)) {
  if (rel.startsWith('.git/') || rel.includes('node_modules/') || !/\.(html?|css|js|mjs|json|md|txt|env|ya?ml|php|svg|xml)$/i.test(rel)) continue;
  const p = path.join(repo, rel); if (fs.statSync(p).size > 5e6) continue;
  const s = fs.readFileSync(p, 'utf8');
  for (const [re, what] of SECRETS) if (re.test(s)) add('must', 'Secrets', `${rel} contains what looks like ${what}. Remove it and change that key.`, rel);
}
const must = findings.filter((f) => f.level === 'must').length;
console.error(`Checks: ${must} must fix, ${findings.filter((f) => f.level === 'should').length} should fix, ${findings.filter((f) => f.level === 'note').length} notes.`);
for (const f of findings.filter((x) => x.level === 'must').slice(0, 20)) console.error(`::warning::${f.check}: ${f.message} (${f.where})`);
process.stdout.write(JSON.stringify({ tool: 'studio-checks 1', findings: findings.slice(0, 500) }));
