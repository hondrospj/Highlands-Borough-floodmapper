// Read the exact authored scripts named by index.html; never commit downloaded UI copies.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

const attributes = text => Object.fromEntries([...text.matchAll(/([\w-]+)\s*=\s*(["'])(.*?)\2/g)].map(match => [match[1].toLowerCase(), match[3]]));
const digest = bytes => createHash('sha256').update(bytes).digest('base64');
export async function loadMapperTestSource(indexUrl = new URL('../index.html', import.meta.url)) {
  const entry = process.env.MAPPER_TEST_INDEX || indexUrl;
  const html = await fs.readFile(entry, 'utf8');
  const scripts = [];
  const cacheRoot = process.env.MAPPER_TEST_CACHE_DIR || path.join(os.tmpdir(), 'floodmapper-pinned-test-assets');
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attrs = attributes(match[1]);
    if (!attrs.src) {
      if (/^application\/(?:ld\+)?json$|^importmap$/i.test(attrs.type || '')) { JSON.parse(match[2]); continue; }
      if (match[2].trim()) scripts.push({filename: `index.html:${attrs.id || scripts.length + 1}`, code: match[2]});
      continue;
    }
    // The third-party libraries are intentionally outside the locally-authored regression suite.
    if (!attrs.src.includes('/gh/') || !attrs.src.includes('/assets/')) continue;
    const url = new URL(attrs.src);
    const pinned = /^\/gh\/[^/]+\/[^/@]+@[a-f0-9]{40}\/(assets\/[A-Za-z0-9_/-]+\.js)$/i.exec(url.pathname);
    assert(url.origin === 'https://cdn.jsdelivr.net' && pinned && !url.search && !url.hash,
      `Authored script must use an immutable jsDelivr commit URL: ${attrs.src}`);
    assert(/^sha256-[A-Za-z0-9+/]{43}=$/.test(attrs.integrity || ''), `Missing SHA256 integrity: ${attrs.src}`);
    const cacheFile = path.join(cacheRoot, createHash('sha256').update(attrs.src).digest('hex') + '.js');
    let bytes;
    if (process.env.MAPPER_TEST_ASSET_ROOT) {
      // Root contains assets/, copied or checked out separately at the pinned release.
      bytes = await fs.readFile(path.join(process.env.MAPPER_TEST_ASSET_ROOT, pinned[1]));
    } else {
      try { bytes = await fs.readFile(cacheFile); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        assert(process.env.MAPPER_TEST_OFFLINE !== '1', `Pinned asset is not cached: ${attrs.src}`);
        const response = await fetch(url, {signal: AbortSignal.timeout(20000)});
        assert(response.ok, `Pinned asset returned HTTP ${response.status}: ${attrs.src}`);
        bytes = Buffer.from(await response.arrayBuffer());
        assert.equal('sha256-' + digest(bytes), attrs.integrity, `Pinned asset integrity mismatch: ${attrs.src}`);
        await fs.mkdir(cacheRoot, {recursive: true});
        await fs.writeFile(cacheFile, bytes);
      }
    }
    assert.equal('sha256-' + digest(bytes), attrs.integrity, `Pinned asset integrity mismatch: ${attrs.src}`);
    scripts.push({filename: attrs.src, code: bytes.toString('utf8')});
  }
  assert(scripts.some(script => script.filename.endsWith('/assets/app/runtime.js')), 'No pinned mapper runtime was found');
  // Syntax-check each actual script independently, matching browser script scope.
  for (const script of scripts) new vm.Script(script.code, {filename: script.filename});
  return {html, scripts, source: html + '\n' + scripts.map(script => script.code).join('\n')};
}
