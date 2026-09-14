#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const {chromium} = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const url = process.argv[2] || 'http://127.0.0.1:8174/';
const output = process.argv[3] || '/tmp/highlands-browser-validation';
fs.mkdirSync(output, {recursive: true});
const browser = await chromium.launch({headless: true, ...(process.env.CHROME_PATH ? {executablePath: process.env.CHROME_PATH} : {})});
const results = [];
try {
  for (const viewport of [{width: 1440, height: 1000}, {width: 390, height: 844}]) {
    const page = await browser.newPage({viewport});
    const errors = [], assetFailures = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', r => {
      if (r.status() >= 400 && /hydraulic-connectivity-2022-2014-v2|highlands-borough-2022-2014-1m-v2/.test(r.url())) assetFailures.push({url: r.url(), status: r.status()});
    });
    await page.goto(url, {waitUntil: 'domcontentloaded', timeout: 45000});
    await page.waitForFunction(() => typeof map !== 'undefined' && map && typeof currentFloodLayer !== 'undefined' && currentFloodLayer, null, {timeout: 60000});
    const checks = await page.evaluate(async () => {
      const query = await getHydraulicQueryGrid();
      const developed = await getDevelopedQueryGrid();
      const records = [];
      for (const phase of ['filling', 'slack', 'draining-release-15', 'draining-release-30', 'draining']) {
        for (const mode of ['depth', 'dynamic']) {
          const record = await getHydraulicOverlayRecord(mode, 5.1, phase, null, []);
          await preloadImage(record.url);
          records.push({phase, mode, url: record.url});
        }
      }
      const stage = 5.1;
      const token = ++lastRenderToken;
      await setFloodLayer('depth', stage, 'slack', token, null, []);
      const script = document.getElementById('floodmapper-v11-depth-query').textContent;
      const raster = JSON.parse(script.match(/const V11_RASTERS = (.+);/)[1]).HighlandsBoroughDepth;
      const tiff = await GeoTIFF.fromUrl(raster.cogUrl);
      const image = await tiff.getImage();
      const point = {lat: 40.403, lon: -73.989};
      if (!proj4.defs('EPSG:6527')) proj4.defs('EPSG:6527', '+proj=tmerc +lat_0=38.8333333333333 +lon_0=-74.5 +k=0.9999 +x_0=150000 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=us-ft +no_defs +type=crs');
      const xy = proj4('EPSG:4326', 'EPSG:6527', [point.lon, point.lat]);
      const col = Math.floor((xy[0] - raster.geoTransform[0]) / raster.geoTransform[1]);
      const row = Math.floor((xy[1] - raster.geoTransform[3]) / raster.geoTransform[5]);
      const ground = Number((await image.readRasters({window: [col, row, col+1, row+1], interleave: true}))[0]);
      return {query: [query.width, query.height], developed: [developed.width, developed.height], records,
              cog: {width: image.getWidth(), height: image.getHeight(), ground, point}, stage,
              release: raster.id, title: document.title};
    });
    assert.deepEqual(checks.query, [1476, 1638]);
    assert.deepEqual(checks.developed, [1476, 1638]);
    assert.equal(checks.records.length, 10);
    assert.ok(checks.records.every(r => r.url.includes('hydraulic-connectivity-2022-2014-v2')));
    assert.deepEqual([checks.cog.width, checks.cog.height], [2250, 2497]);
    assert.ok(Number.isFinite(checks.cog.ground) && checks.cog.ground > -50 && checks.cog.ground < 300);
    assert.ok(Math.abs(checks.cog.ground - 5.290337085723877) < 1e-5, 'Browser DEM sample must match the independent GDAL sample');
    assert.equal(checks.release, 'highlands-borough-2022-2014-1m-v2');
    await page.waitForTimeout(800);
    await page.screenshot({path: path.join(output, `highlands-${viewport.width}.png`)});
    await page.evaluate(() => map.fire('click', {latlng: L.latLng(40.403, -73.989)}));
    await page.waitForFunction(() => {
      const text = document.querySelector('.shorely-v11-depth-value')?.textContent || '';
      return /^\d+(\.\d+)? ft$/.test(text.trim());
    }, null, {timeout: 45000});
    const popup = await page.locator('.shorely-v11-depth-query').innerText();
    assert.ok(!popup.includes('estimated'), 'Depth must use the new DEM, not the color-class fallback');
    assert.deepEqual(errors, []);
    assert.deepEqual(assetFailures, []);
    results.push({viewport, checks, popup, errors, assetFailures});
    await page.close();
  }
  fs.writeFileSync(path.join(output, 'BrowserValidation.json'), JSON.stringify({status: 'passed', url, results}, null, 2));
  console.log(JSON.stringify({status: 'passed', viewports: results.map(r => r.viewport), elevationSamples: results.map(r => r.checks.cog.ground)}, null, 2));
} finally {
  await browser.close();
}
