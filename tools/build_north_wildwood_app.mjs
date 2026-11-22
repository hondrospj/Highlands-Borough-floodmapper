import fs from 'node:fs';

const root = new URL('../', import.meta.url);
const read = name => fs.readFileSync(new URL(name, root), 'utf8');
const town = JSON.parse(read('tools/app/town-profile.json'));
const embeddedJson = value => JSON.stringify(value).replace(/[<&]/g, char =>
  char === '<' ? '\\u003c' : '\\u0026');
const htmlEscape = value => String(value).replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const values = {
  'profile': embeddedJson(town.config),
  'webcams': embeddedJson(town.webcams),
  'page-title': htmlEscape(town.config.pageTitle),
  'town-name': htmlEscape(town.config.site.name),
  'brand-title-line-1': htmlEscape(town.config.brandTitleLine1),
  'brand-title-line-2': htmlEscape(town.config.brandTitleLine2),
};
const index = read('tools/app/index.template.html').replace(/<!-- floodmapper:([\w-]+) -->/g, (_, key) => {
  if (!Object.hasOwn(values, key)) throw new Error(`Unknown mapper template field: ${key}`);
  return values[key];
});
if (process.argv.includes('--check')) {
  if (read('index.html') !== index) {
    throw new Error('index.html is stale. Run node tools/build_north_wildwood_app.mjs.');
  }
  console.log('Verified client mapper entry point');
} else {
  fs.writeFileSync(new URL('index.html', root), index);
  console.log('Built client mapper entry point');
}
