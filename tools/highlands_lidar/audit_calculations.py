#!/usr/bin/env python3
"""Independent audit of Highlands' saved terrain, graph and rendered catalog.

Does not import the graph builder, pooling code or mask-repair implementation.
SciPy connected-component labels provide a separate connectivity oracle at
every published water level. All checks abort on an unexplained mismatch.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from osgeo import gdal, osr
from PIL import Image
from scipy.ndimage import label, gaussian_filter

GRID5 = (629945., 5., 0., 575195., 0., -5.)
SHAPE5 = (1638, 1476)
CROSS = np.array([[0, 1, 0], [1, 1, 1], [0, 1, 0]], dtype=bool)
PHASES = ('filling', '', 'draining-release-15', 'draining-release-30', 'draining')
BREAKS = np.array([.1, .25, .5, 1., 1.5, 2., 2.5, 3., 4., 5.])


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def raster(path):
    ds = gdal.Open(str(path))
    return ds, ds.ReadAsArray()


def check(condition, description):
    if not condition:
        raise AssertionError(description)


def grid_check(ds, shape, gt):
    check((ds.RasterYSize, ds.RasterXSize) == shape, 'Raster dimensions')
    check(np.allclose(ds.GetGeoTransform(), gt, rtol=0, atol=1e-6), 'Raster grid alignment')
    target = osr.SpatialReference(); target.ImportFromEPSG(6527)
    check(ds.GetSpatialRef().IsSame(target), 'Horizontal CRS must be EPSG:6527')


def pool_min(a):
    # A block reduction, independent of the renderer's 25 offset-stride passes.
    return a.reshape(SHAPE5[0], 5, SHAPE5[1], 5).min(axis=(1, 3))


def repair(wet, eligible):
    """SciPy oracle for fully enclosed eligible holes of at most four cells."""
    labels, n = label(~wet, structure=CROSS)
    counts = np.bincount(labels.ravel())
    allowed = (counts <= 4)
    allowed[0] = False
    allowed[np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]]))] = False
    allowed[np.unique(labels[~wet & ~eligible])] = False
    return wet | allowed[labels]


def native_controls(sources_dir, manifest, output, values, years):
    """Hand bilinear weights at exact projected pixel centers, no GDAL Warp."""
    rng = np.random.default_rng(20220914)
    rows, cols = np.where(values != -9999)
    chosen = rng.choice(len(rows), min(12000, len(rows)), replace=False)
    rows, cols = rows[chosen], cols[chosen]
    t = output.GetGeoTransform()
    points = np.column_stack([t[0]+(cols+.5)*t[1], t[3]+(rows+.5)*t[5]])
    expected = np.full(len(rows), np.nan)
    expected_year = np.zeros(len(rows), dtype=np.int16)
    for source in manifest['sources']:
        ds = gdal.Open(str(sources_dir / source['file']))
        horizontal = ds.GetSpatialRef(); horizontal.StripVertical()
        transform = osr.CoordinateTransformation(output.GetSpatialRef(), horizontal)
        xy = np.array(transform.TransformPoints(points.tolist()))
        gt = ds.GetGeoTransform()
        c, r = (xy[:,0]-gt[0])/gt[1]-.5, (xy[:,1]-gt[3])/gt[5]-.5
        c0, r0 = np.floor(c).astype(int), np.floor(r).astype(int)
        domain = (c >= -.5) & (r >= -.5) & (c < ds.RasterXSize-.5) & (r < ds.RasterYSize-.5)
        # Later edge/nodata kernels can use partial samples. Exclude them from
        # the four-valid-neighbor oracle rather than judging the earlier tile.
        expected[domain] = np.nan
        expected_year[domain] = 0
        core = (c0 >= 0) & (r0 >= 0) & (c0+1 < ds.RasterXSize) & (r0+1 < ds.RasterYSize)
        q = np.flatnonzero(core)
        raw = ds.ReadAsArray()
        v = np.stack([raw[r0[q],c0[q]], raw[r0[q],c0[q]+1], raw[r0[q]+1,c0[q]], raw[r0[q]+1,c0[q]+1]])
        good = np.all(np.isfinite(v) & (v != ds.GetRasterBand(1).GetNoDataValue()), axis=0)
        q, v = q[good], v[:,good]
        dx, dy = c[q]-c0[q], r[q]-r0[q]
        meters = v[0]*(1-dx)*(1-dy)+v[1]*dx*(1-dy)+v[2]*(1-dx)*dy+v[3]*dx*dy
        expected[q] = meters/.3048
        expected_year[q] = source['surveyYear']
        del raw
    good = np.isfinite(expected) & (expected_year == years[rows,cols])
    errors = np.abs(values[rows[good],cols[good]] - expected[good])
    check(good.sum() > 8000, 'Insufficient independent native controls')
    worst = int(np.argmax(errors))
    check(errors.max() < .0001, f'Native bilinear/feet control error: {errors.max()} feet at row {rows[good][worst]}, col {cols[good][worst]}, year {expected_year[good][worst]}, expected {expected[good][worst]}')
    return {'method': 'Exact center coordinate transform and hand bilinear weights on native meter samples, divided by 0.3048',
            'samples': int(good.sum()), 'samples2014': int(np.sum(expected_year[good] == 2014)),
            'samples2022': int(np.sum(expected_year[good] == 2022)),
            'maximumAbsoluteErrorFeet': float(errors.max()), 'p95AbsoluteErrorFeet': float(np.percentile(errors,95)),
            'toleranceFeet': .0001, 'partialNodataAndEdgeKernelsExcluded': True}


def cubic_controls(terrain, valid, mosaic, mosaic_ds):
    """Direct 16-term cubic convolution, bounded by the nearest 5x5 source."""
    rng = np.random.default_rng(73808190)
    rows = rng.integers(0, terrain.shape[0], 30000)
    cols = rng.integers(0, terrain.shape[1], 30000)
    t = mosaic_ds.GetGeoTransform()
    px = (GRID5[0]+cols+.5-t[0])/t[1]
    py = (GRID5[3]-rows-.5-t[3])/t[5]
    ix, iy = np.floor(px).astype(int), np.floor(py).astype(int)
    core = valid[rows,cols] & (ix>=3) & (iy>=3) & (ix<mosaic.shape[1]-3) & (iy<mosaic.shape[0]-3)
    rows, cols, px, py, ix, iy = (z[core] for z in (rows,cols,px,py,ix,iy))
    bounds = np.stack([mosaic[iy+y,ix+x] for y in range(-2,3) for x in range(-2,3)])
    good = np.all(bounds != -9999, axis=0)
    rows, cols, px, py, ix, iy = (z[good] for z in (rows,cols,px,py,ix,iy))
    lo, hi = bounds[:,good].min(axis=0), bounds[:,good].max(axis=0)
    x, y = px-.5, py-.5
    x0, y0 = np.floor(x).astype(int), np.floor(y).astype(int)

    def kernel(d):
        d = np.abs(d)
        return np.where(d <= 1, 1.5*d**3-2.5*d**2+1, -.5*d**3+2.5*d**2-4*d+2)

    expected = np.zeros(len(rows))
    for dy in range(-1,3):
        for dx in range(-1,3):
            expected += mosaic[y0+dy,x0+dx] * kernel(x-(x0+dx)) * kernel(y-(y0+dy))
    expected = np.clip(expected, lo, hi)
    errors = np.abs(terrain[rows,cols] - expected)
    check(len(errors)>8000, 'Insufficient cubic controls')
    check(errors.max()<.0001, f'Cubic interpolation control error: {errors.max()} feet')
    return {'method': 'Independent 16-term cubic convolution and local 5x5 minimum/maximum clamp',
            'samples': len(errors), 'maximumAbsoluteErrorFeet': float(errors.max()), 'toleranceFeet': .0001}


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--build', type=Path, required=True)
    p.add_argument('--sources', type=Path, required=True)
    p.add_argument('--report', type=Path, required=True)
    a = p.parse_args()
    gdal.UseExceptions(); gdal.SetConfigOption('PROJ_NETWORK', 'OFF'); osr.SetPROJEnableNetwork(False)
    started = time.monotonic()
    inputs = Path(__file__).parent / 'inputs'
    report = {'schema': 'highlands-independent-calculation-audit-v1', 'status': 'running',
              'generatedUtc': datetime.now(timezone.utc).isoformat()}
    source_manifest = json.loads((a.build / 'SourceResamplingManifest.json').read_text())
    for src in source_manifest['sources']:
        check(digest(a.sources / src['file']) == src['sha256'], 'Native tile SHA-256: ' + src['file'])
    check(digest(a.build / source_manifest['sourceCog']) == source_manifest['sourceCogSha256'], 'Mosaic SHA-256')
    check(digest(a.build / 'highlands_1ft.tif') == source_manifest['outputSha256'], 'Calculation DEM SHA-256')
    maskds, mask = raster(inputs / 'municipal_mask_5ft.tif')
    grid_check(maskds, SHAPE5, GRID5)
    mask = mask > 0
    ds, terrain = raster(a.build / 'highlands_1ft.tif')
    shape = (SHAPE5[0] * 5, SHAPE5[1] * 5)
    grid1 = (GRID5[0], 1., 0., GRID5[3], 0., -1.)
    grid_check(ds, shape, grid1)
    check(ds.GetRasterBand(1).GetUnitType() == 'ft', 'Calculation vertical units')
    valid = np.isfinite(terrain) & (terrain != ds.GetRasterBand(1).GetNoDataValue())
    check(np.array_equal(valid, np.repeat(np.repeat(mask, 5, axis=0), 5, axis=1)), 'All 25 children have valid terrain')
    developed_ds = gdal.Open(str(inputs / 'developed_1ft.tif'))
    grid_check(developed_ds, shape, grid1)
    grid_check(gdal.Open(str(inputs / 'road_mask_5ft.tif')), SHAPE5, GRID5)
    mosaic_ds, mosaic = raster(a.build / source_manifest['sourceCog'])
    grid_check(mosaic_ds, (2497, 2250), (GRID5[0], 3937/1200, 0., GRID5[3], 0., -3937/1200))
    check(mosaic_ds.GetRasterBand(1).GetUnitType() == 'ft', 'Mosaic vertical units')
    check(abs(mosaic_ds.GetGeoTransform()[1] * mosaic_ds.GetSpatialRef().GetLinearUnits() - 1) < 1e-12, 'Native 1 meter grid')
    report['grids'] = {'aligned': True, 'validCalculationCells': int(valid.sum()),
                       'validDisplayCells': int(mask.sum()), 'all25SubcellsValid': True,
                       'sourceSpacingMeters': 1, 'sourceHashesChecked': 6,
                       'verticalFeetPerMeter': 1/.3048, 'horizontalUnits': 'US survey feet'}
    print('Grid, source hashes, mask alignment: passed', flush=True)
    _, years = raster(a.build / 'source_year_1m.tif')
    report['nativeElevationControls'] = native_controls(a.sources, source_manifest, mosaic_ds, mosaic, years)
    report['oneFootInterpolationControls'] = cubic_controls(terrain, valid, mosaic, mosaic_ds)
    print('Independent native conversion and bounded cubic interpolation controls: passed', flush=True)

    graph = a.build / 'graph'
    elev = np.memmap(graph / 'elevation10.raw', '<i2', 'r', shape=shape)
    conn = np.memmap(graph / 'connection10.raw', '<i2', 'r', shape=shape)
    sources = np.memmap(graph / 'source_flag.raw', 'u1', 'r', shape=shape)
    dev = np.memmap(graph / 'developed_flag.raw', 'u1', 'r', shape=shape)
    # C++ lround is half-away-from-zero; NumPy rint is ties-to-even.
    scaled = terrain * np.float32(10)
    rounded = np.copysign(np.floor(np.abs(scaled) + np.float32(.5)), scaled)
    quantized = np.where(valid, np.clip(rounded, -300, 300), -32768).astype(np.int16)
    check(np.array_equal(elev, quantized), 'All terrain values must quantize correctly to tenths')
    del scaled, rounded, quantized
    eligible = valid & (terrain <= np.float32(2.0000001))
    labels, n = label(eligible, structure=CROSS)
    counts = np.bincount(labels.ravel())
    qualified = counts >= 101; qualified[0] = False
    independent_sources = qualified[labels]
    check(np.array_equal(independent_sources, sources != 0), 'Independent source-component classification')
    check(np.array_equal(dev != 0, developed_ds.ReadAsArray() != 0), 'Developed mask graph bytes')
    report['sourceComponents'] = {'eligibleComponents': n, 'qualifiedComponents': int(qualified.sum()),
                                 'qualifiedCells': int(independent_sources.sum()), 'mismatchedCells': 0}
    del terrain, eligible, labels, counts, qualified, independent_sources
    stage_records = []
    for stage10 in range(201):
        traversable = valid & (elev <= stage10)
        labels, n = label(traversable, structure=CROSS)
        seeded = np.zeros(n+1, dtype=bool)
        seeded[np.unique(labels[(sources != 0) & traversable])] = True
        seeded[0] = False
        reachable = seeded[labels]
        mismatches = int(np.count_nonzero(reachable != (conn <= stage10)))
        check(mismatches == 0, f'Independent connectivity differs at {stage10/10:.1f} feet: {mismatches} cells')
        stage_records.append({'stageNavd88Ft': stage10/10, 'connectedCells': int(reachable.sum()), 'mismatches': mismatches})
        if stage10 % 20 == 0:
            print(f'Independent connectivity {stage10/10:.1f} ft: passed', flush=True)
    report['connectivity'] = {'method': 'Independent SciPy 4-neighbor labeling at every 0.1-foot level',
                              'stageCount': 201, 'totalMismatches': 0, 'stages': stage_records}
    del labels, seeded, reachable, traversable

    ground10 = pool_min(np.where(valid, elev, 32767))
    activation10 = pool_min(conn)
    ground_dev10 = pool_min(np.where(valid & (dev != 0), elev, 32767))
    ground_undev10 = pool_min(np.where(valid & (dev == 0), elev, 32767))
    act_dev10 = pool_min(np.where(dev != 0, conn, 32767))
    act_undev10 = pool_min(np.where(dev == 0, conn, 32767))
    developed_count = (valid & (dev != 0)).reshape(SHAPE5[0], 5, SHAPE5[1], 5).sum(axis=(1, 3))
    catalog = a.build / 'catalog'
    q = np.array(Image.open(catalog / 'queries/HighlandsHydraulicQuery5ft.png'))
    decoded = q[...,0].astype(np.int32)*256 + q[...,1].astype(np.int32)
    check(np.array_equal(decoded != 0, mask), 'Query nodata footprint')
    check(np.array_equal((decoded - 32768)[mask], ground10[mask]), 'Query ground decoding')
    expected_activation = np.where(activation10 <= 200, np.clip(activation10, -50, 204)+50, 255)
    check(np.array_equal(q[...,2], expected_activation), 'Query connection decoding')
    qdev = np.array(Image.open(catalog / 'queries/HighlandsDevelopedMask5ft.png'))
    check(np.array_equal(qdev[...,2] != 0, developed_count >= 13), 'Query developed majority')
    report['queries'] = {'allPixelsChecked': int(np.prod(SHAPE5)), 'groundMismatches': 0,
                         'activationMismatches': 0, 'developedMismatches': 0}
    print('Independent 25-cell pooling and query decode: passed', flush=True)

    config = json.loads((Path(__file__).parent / 'towns.json').read_text())['highlands']
    check(config['penaltiesFt'] == [0., 0., 0.], 'Audit reference assumes existing zero Highlands attenuation')
    ground = ground10.astype(np.float32)/10
    gd, gu = ground_dev10.astype(np.float32)/10, ground_undev10.astype(np.float32)/10
    previous = np.zeros(SHAPE5, bool)
    render_records = []
    for stage10 in range(201):
        stage = stage10 / 10
        base = mask & (activation10 <= stage10)
        dev_wet = (act_dev10 <= stage10) & (ground_dev10 <= stage10)
        undev_wet = act_undev10 <= stage10
        wet = mask & (dev_wet | undev_wet)
        allowed = mask & (ground10 <= stage10)
        wet = repair(repair(wet, allowed) | previous, allowed)
        previous = wet.copy()
        extra = wet & ~base
        check(not np.any(extra & ~allowed), 'Hole repair above terrain')
        green = ~wet & mask & (ground < stage - .005) & ~base
        weight = gaussian_filter(wet.astype(np.float32), sigma=2, mode='nearest')
        stabilized = wet & ~(dev_wet | undev_wet)
        maxdepth = np.maximum(np.where(dev_wet, stage-gd, 0), np.where(undev_wet, stage-gu, 0))
        maxdepth[stabilized] = np.maximum(stage-ground[stabilized], 0)
        maxdepth = maxdepth.astype(np.float32)
        threshold = np.where(activation10 < 30.7, 1, np.where(activation10 < 40.7, 2, 3))
        stage_codes = np.where(wet, threshold, np.where(green, 4, 0)).astype(np.uint8)
        phase_mismatches = 0
        for phase in PHASES:
            raw_depth = np.where(wet, stage-ground, 0).astype(np.float32) if phase.startswith('draining') else maxdepth
            check(not np.any(raw_depth[wet] < -1e-5), 'Negative flooded depth')
            depth = gaussian_filter(np.where(wet, np.maximum(raw_depth, 0), 0), sigma=2, mode='nearest') / np.maximum(weight, 1e-6)
            depth_codes = np.where(wet, np.searchsorted(BREAKS, depth, side='right')+1, np.where(green, 12, 0)).astype(np.uint8)
            for family, expected in [('Depth', depth_codes), ('Stage', stage_codes)]:
                path = catalog / (family+'PNGs') / 'Highlands Borough' / phase / f'HighlandsBorough{family}p{stage10:03d}.png'
                actual = np.array(Image.open(path))
                mismatch = int(np.count_nonzero(actual != expected))
                phase_mismatches += mismatch
                check(mismatch == 0, f'{path.name} {phase} differs at {mismatch} pixels')
        render_records.append({'stageNavd88Ft': stage, 'wetPixels': int(wet.sum()),
                               'enclosedHolePixels': int(extra.sum()), 'mismatches': phase_mismatches})
        if stage10 % 20 == 0:
            print(f'Independent catalog masks/depth classes {stage:.1f} ft: passed', flush=True)
    report['render'] = {'imagesChecked': 2010, 'totalPixelMismatches': 0, 'stages': render_records,
                        'depthRule': 'water surface minus pooled terrain, wet-mask-normalized Gaussian smoothing sigma=2 display cells',
                        'depthBreaksFeet': BREAKS.tolist(), 'displayCellSizeUsSurveyFeet': 5,
                        'graphElevationIncrementFeet': .1, 'maximumRoundingErrorFeetWithinModelRange': .05,
                        'holeRepair': 'At most four eligible enclosed display cells; separately recomputed with SciPy labeling'}
    report['status'] = 'passed'; report['elapsedSeconds'] = round(time.monotonic()-started, 1)
    a.report.parent.mkdir(parents=True, exist_ok=True)
    a.report.write_text(json.dumps(report, indent=2)+'\n')
    print(json.dumps({'status': report['status'], 'report': str(a.report), 'elapsedSeconds': report['elapsedSeconds']}), flush=True)


if __name__ == '__main__':
    main()
