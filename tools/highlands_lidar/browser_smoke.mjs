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
      if (r.status() >= 400 && /hydraulic-connectivity-2022-2014-v3|highlands-borough-2022-2014-1m-v3/.test(r.url())) assetFailures.push({url: r.url(), status: r.status()});
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
      const entry = currentSeriesHours[currentHourIndex];
      const stage = getStageValue(entry);
      const phase = getHydraulicPhaseForEntry(entry, currentHourIndex, currentSeriesHours);
      const token = ++lastRenderToken;
      await setFloodLayer('depth', stage, phase, token, entry, currentSeriesHours);
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
    assert.ok(checks.records.every(r => r.url.includes('hydraulic-connectivity-2022-2014-v3')));
    assert.deepEqual([checks.cog.width, checks.cog.height], [2250, 2497]);
    assert.ok(Number.isFinite(checks.cog.ground) && checks.cog.ground > -50 && checks.cog.ground < 300);
    assert.ok(Math.abs(checks.cog.ground - 5.290337085723877) < 1e-5, 'Browser DEM sample must match the independent GDAL sample');
    assert.equal(checks.release, 'highlands-borough-2022-2014-1m-v3');
    await page.waitForTimeout(800);
    await page.screenshot({path: path.join(output, `highlands-${viewport.width}.png`)});
    await page.evaluate(() => map.fire('click', {latlng: L.latLng(40.403, -73.989)}));
    await page.waitForFunction(() => {
      const text = document.querySelector('.shorely-v11-depth-value')?.textContent || '';
      return /^\d+(\.\d+)? ft$/.test(text.trim());
    }, null, {timeout: 45000});
    const popup = await page.locator('.shorely-v11-depth-query').innerText();
    assert.ok(!popup.includes('estimated'), 'Depth must use the new DEM, not the color-class fallback');
    const depthCases = await page.evaluate(async () => {
      const entry = currentSeriesHours[currentHourIndex];
      const stage = getStageValue(entry);
      const phase = getHydraulicPhaseForEntry(entry, currentHourIndex, currentSeriesHours);
      const surface = getPenalizedWaterSurfaceStage(stage, phase);
      const record = await getHydraulicOverlayRecord('depth', stage, phase, entry, currentSeriesHours);
      const overlay = new Image(); overlay.crossOrigin = 'anonymous';
      await new Promise((resolve, reject) => { overlay.onload = resolve; overlay.onerror = reject; overlay.src = record.url; });
      const canvas = document.createElement('canvas'); canvas.width = overlay.naturalWidth; canvas.height = overlay.naturalHeight;
      const ctx = canvas.getContext('2d', {willReadFrequently: true}); ctx.drawImage(overlay, 0, 0);
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const script = document.getElementById('floodmapper-v11-depth-query').textContent;
      const raster = JSON.parse(script.match(/const V11_RASTERS = (.+);/)[1]).HighlandsBoroughDepth;
      const image = await (await GeoTIFF.fromUrl(raster.cogUrl)).getImage();
      const terrain = await image.readRasters({interleave: true});
      const b = floodLatLngBounds, cases = {};
      for (let i = 0; i < pixels.length && (!cases.wet || !cases.disconnected); i += 4) {
        if (!pixels[i+3]) continue;
        const green = (pixels[i]-121)**2 + (pixels[i+1]-221)**2 + (pixels[i+2]-90)**2 < 9;
        const kind = green ? 'disconnected' : 'wet';
        if (cases[kind]) continue;
        const pixel = i/4, row = Math.floor(pixel/canvas.width), col = pixel%canvas.width;
        const lon = b.getWest()+(col+.5)/canvas.width*(b.getEast()-b.getWest());
        const lat = b.getNorth()-(row+.5)/canvas.height*(b.getNorth()-b.getSouth());
        const xy = proj4('EPSG:4326', 'EPSG:6527', [lon, lat]);
        const x = Math.floor((xy[0]-raster.geoTransform[0])/raster.geoTransform[1]);
        const y = Math.floor((xy[1]-raster.geoTransform[3])/raster.geoTransform[5]);
        if (x<0 || y<0 || x>=raster.width || y>=raster.height) continue;
        const ground = Number(terrain[y*raster.width+x]);
        if (!(ground>=0 && ground<surface-.2)) continue;
        cases[kind] = {kind, lat, lon, ground, stage, surface, expectedDepth: green ? 0 : Math.max(0, surface-ground)};
      }
      return Object.values(cases);
    });
    assert.ok(depthCases.some(c => c.kind === 'wet'), 'A positive flooded-depth control must be available');
    assert.ok(depthCases.some(c => c.kind === 'disconnected'), 'A below-water disconnected control must be available');
    for (const control of depthCases) {
      await page.evaluate(async c => { map.fire('click', {latlng: L.latLng(c.lat, c.lon)}); await new Promise(r => setTimeout(r, 100)); }, control);
      await page.waitForFunction(() => /^\d+(\.\d+)? ft$/.test([...document.querySelectorAll('.shorely-v11-depth-value')].at(-1)?.textContent?.trim() || ''), null, {timeout: 45000});
      control.displayedDepth = parseFloat(await page.locator('.shorely-v11-depth-value').last().innerText());
      assert.equal(control.displayedDepth, Number(control.expectedDepth.toFixed(2)), `${control.kind} popup must respect terrain subtraction and connectivity`);
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(assetFailures, []);
    results.push({viewport, checks, popup, depthCases, errors, assetFailures});
    await page.close();
  }
  fs.writeFileSync(path.join(output, 'BrowserValidation.json'), JSON.stringify({status: 'passed', url, results}, null, 2));
  console.log(JSON.stringify({status: 'passed', viewports: results.map(r => r.viewport), elevationSamples: results.map(r => r.checks.cog.ground)}, null, 2));
} finally {
  await browser.close();
}
