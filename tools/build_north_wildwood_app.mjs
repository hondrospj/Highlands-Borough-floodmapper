import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const check = process.argv.includes('--check');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'tools/app/manifest.json'), 'utf8'));
const outputs = new Map();
const replacements = new Map();
const readSources = entry => entry.sources.map(source => fs.readFileSync(path.join(root, source), 'utf8')).join('');
const version = text => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
const town = JSON.parse(fs.readFileSync(path.join(root, 'tools/app/town-profile.json'), 'utf8'));
const htmlEscape = text => String(text).replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const embeddedJson = value => JSON.stringify(value).replace(/[<&]/g, char =>
  char === '<' ? '\\u003c' : '\\u0026');
for (const [tag, value] of Object.entries({
  'profile': embeddedJson(town.config),
  'webcams': embeddedJson(town.webcams),
  'page-title': htmlEscape(town.config.pageTitle),
  'town-name': htmlEscape(town.config.site.name),
})) replacements.set(`<!-- floodmapper:${tag} -->`, value);

// Coalesce CSS only within its original cascade interval. External stylesheets
// and scripts are barriers; moving rules across either could change the UI.
for (const entry of manifest.styles) {
  outputs.set(entry.output, (outputs.get(entry.output) || '') + readSources(entry));
}
for (const entry of manifest.styles) {
  const token = `<!-- nww:style:${entry.id} -->`;
  replacements.set(token, entry.firstInBundle
    ? `<link rel="stylesheet" data-nww-style-bundle="${path.basename(entry.output, '.css')}" href="./${entry.output}?v=${version(outputs.get(entry.output))}">`
    : token);
}
for (const entry of manifest.scripts) {
  const source = readSources(entry);
  outputs.set(entry.output, source);
  // Keep classic, parser-blocking execution at the original script position.
  // In particular, the domain fragments compile into ONE runtime scope so
  // function hoisting, lexical bindings and microtask checkpoints stay intact.
  const open = entry.openTag.replace(/>$/, ` data-nww-script="${entry.id}" src="./${entry.output}?v=${version(source)}">`);
  replacements.set(`<!-- nww:script:${entry.id} -->`, `${open}${entry.closeTag}`);
}

let html = fs.readFileSync(path.join(root, 'tools/app/index.template.html'), 'utf8');
const tokens = html.match(/<!-- nww:(?:style|script):[^ ]+ -->/g) || [];
if (tokens.length !== replacements.size - 4 || new Set(tokens).size !== tokens.length) {
  throw new Error('Application template must contain every manifest block exactly once.');
}
html = html.replace(/<!-- nww:(?:style|script):[^ ]+ -->/g, token => {
  if (!replacements.has(token)) throw new Error(`Unknown source token: ${token}`);
  return replacements.get(token);
});
html = html.replace(/<!-- floodmapper:(?:profile|webcams|page-title|town-name) -->/g,
  token => replacements.get(token));
html = html.replace(/(\b(?:src|href)="(?:\.\/)?)(assets\/[^"?#]+)\?v=shared"/g, (_, prefix, relative) =>
  `${prefix}${relative}?v=${version(outputs.get(relative) ?? fs.readFileSync(path.join(root, relative)))}"`);
outputs.set('index.html', html);

let changed = 0;
for (const [relative, content] of outputs) {
  const target = path.join(root, relative);
  if (fs.existsSync(target) && fs.readFileSync(target, 'utf8') === content) continue;
  if (check) throw new Error(`${relative} is stale. Run node tools/build_north_wildwood_app.mjs.`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  changed++;
}
console.log(`${check ? 'Verified' : 'Built'} North Wildwood: ${manifest.scripts.length} scripts, ${new Set(manifest.styles.map(entry => entry.output)).size} CSS bundles; ${changed} changed outputs.`);
