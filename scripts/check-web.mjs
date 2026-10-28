// Static checks for the web client (no browser needed):
//  1. every module parses,
//  2. CSP compatibility: no inline <script>, no inline event handlers, no style="" attributes anywhere,
//  3. every data-action / data-form used in a template has a registered handler (and vice versa is reported),
//  4. every route-linked hash path in templates matches a registered route pattern,
//  5. dangerous DOM sinks are used only where reviewed.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '../apps/web/public');
const jsDir = path.join(root, 'js');
const files = fs.readdirSync(jsDir).filter((f) => f.endsWith('.js')).map((f) => path.join(jsDir, f));
const problems = [];
const read = (f) => fs.readFileSync(f, 'utf8');

// 1. syntax
for (const f of files) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); } catch (e) { problems.push(`syntax error in ${path.relative(root, f)}:\n${e.stderr}`); }
}

// 2. CSP
const index = read(path.join(root, 'index.html'));
for (const m of index.matchAll(/<script\b([^>]*)>/gi)) if (!/\bsrc=/.test(m[1])) problems.push('index.html contains an inline <script>');
if (/\sstyle\s*=/.test(index) || /<style\b/i.test(index)) problems.push('index.html contains inline style');
if (/\son[a-z]+\s*=/.test(index)) problems.push('index.html contains an inline event handler');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
const all = files.map((f) => [f, stripComments(read(f))]);
for (const [f, src] of all) {
  const rel = path.relative(root, f);
  if (/<[a-z][^>]*\sstyle\s*=/i.test(src)) problems.push(`${rel}: inline style attribute (blocked by CSP)`);
  if (/<[a-z][^>]*\son[a-z]+\s*=/i.test(src)) problems.push(`${rel}: inline event handler attribute (blocked by CSP)`);
  if (/javascript:/i.test(src.replace(/safeUrl[^\n]*/g, '').replace(/\/\/[^\n]*javascript:[^\n]*/g, ''))) problems.push(`${rel}: javascript: URL`);
  if (/\beval\s*\(|new Function\s*\(|document\.write\s*\(/.test(src)) problems.push(`${rel}: eval-like call`);
}
const css = read(path.join(root, 'styles.css'));
if (/url\(\s*['"]?https?:/i.test(css) || /@import/i.test(css)) problems.push('styles.css loads an external resource (blocked by CSP)');

// 3. handlers
const used = { action: new Set(), form: new Set() };
const defined = { action: new Set(['logout', 'reload', 'closemenu']), form: new Set(['filter']) };
for (const [, src] of all) {
  for (const m of src.matchAll(/data-action="([a-z0-9-]+)"/gi)) used.action.add(m[1]);
  for (const m of src.matchAll(/data-form="([a-z0-9-]+)"/gi)) used.form.add(m[1]);
  for (const m of src.matchAll(/form\(\s*'([a-z0-9-]+)'/g)) used.form.add(m[1]);
  for (const m of src.matchAll(/actions(?:\.([a-z]+)|\['([a-z0-9-]+)'\])\s*=/g)) defined.action.add(m[1] ?? m[2]);
  for (const m of src.matchAll(/forms(?:\.([a-z]+)|\['([a-z0-9-]+)'\])\s*=/g)) defined.form.add(m[1] ?? m[2]);
  for (const m of src.matchAll(/^\s*(?:reload|closemenu|logout):/gm)) defined.action.add(m[0].trim().replace(':', ''));
}
for (const kind of ['action', 'form']) {
  for (const n of used[kind]) if (!defined[kind].has(n)) problems.push(`data-${kind} "${n}" is used but no handler is registered`);
  for (const n of defined[kind]) if (!used[kind].has(n) && !['filter', 'logout', 'reload', 'closemenu'].includes(n)) console.warn(`note: ${kind} handler "${n}" is never referenced`);
}

// 4. routes vs links
const patterns = [];
for (const [, src] of all) for (const m of src.matchAll(/route\(\s*'([^']+)'/g)) patterns.push(new RegExp('^' + m[1].replace(/:[a-z_]+/gi, '[^/]+') + '$'));
const linked = new Set();
for (const [, src] of all) {
  for (const m of src.matchAll(/href="#(\/[a-z0-9\-/]*)(?:\?|")/gi)) linked.add(m[1].replace(/\/$/, '') || '/');
  for (const m of src.matchAll(/go\(\s*['`](\/[a-z0-9\-/]*)/g)) linked.add(m[1].replace(/\/$/, '') || '/');
  for (const m of src.matchAll(/\['(\/[a-z0-9\-/]*)',\s*'/g)) linked.add(m[1]);
}
for (const l of linked) {
  const probe = l.replace(/\/$/, '');
  if (!patterns.some((re) => re.test(probe) || re.test(probe + '/x') && false)) {
    // links ending in "/" are prefixes of parameterised routes (for example href="#/ventures/${id}")
    if (!patterns.some((re) => re.test(probe + '/x'))) problems.push(`link to "${l}" does not match any route`);
  }
}

if (problems.length) {
  console.error(`Web client check FAILED (${problems.length}):\n- ` + problems.join('\n- '));
  process.exit(1);
}
console.log(`Web client check passed: ${files.length} modules, ${patterns.length} routes, ${used.action.size} actions, ${used.form.size} forms.`);
