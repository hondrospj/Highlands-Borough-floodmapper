#!/usr/bin/env python3
"""Mosaic native 1 m NAVD88 sources and prepare the existing 1 ft graph grid.

2022 observed cells take priority; 2014 fills the remainder. Horizontal
reprojection explicitly excludes vertical transformations: both source DEMs
already contain NAVD88 orthometric meters. Elevations are converted once to
international feet. Cubic interpolation is bounded to local source extrema.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from osgeo import gdal, osr
from scipy.ndimage import minimum_filter, maximum_filter

NODATA = -9999.0
FTUS_M = 1200 / 3937
GRID = (629945.0, 5.0, 0.0, 575195.0, 0.0, -5.0)
WIDTH, HEIGHT = 1476, 1638
RELEASE = "highlands-lidar-2022-2014-v3"


def sha(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as f:
        for b in iter(lambda: f.read(1024 * 1024), b""):
            h.update(b)
    return h.hexdigest()


def memory(a, gt, wkt, nodata=NODATA):
    ds = gdal.GetDriverByName("MEM").Create("", a.shape[1], a.shape[0], 1, gdal.GDT_Float32)
    ds.SetGeoTransform(gt)
    ds.SetProjection(wkt)
    ds.GetRasterBand(1).SetNoDataValue(nodata)
    ds.GetRasterBand(1).WriteArray(a)
    return ds


def write(path, a, gt, wkt, cog=False, unit="ft"):
    source = memory(a, gt, wkt)
    source.GetRasterBand(1).SetUnitType(unit)
    options = ["COMPRESS=DEFLATE", "PREDICTOR=3"]
    if cog:
        options += ["BLOCKSIZE=256", "OVERVIEWS=NONE"]
    else:
        options += ["TILED=YES", "BIGTIFF=IF_SAFER"]
    out = gdal.Translate(str(path), source, format="COG" if cog else "GTiff", creationOptions=options)
    out.FlushCache()
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--sources", type=Path, required=True)
    parser.add_argument("--municipal-mask", type=Path, default=Path(__file__).parent / "inputs/municipal_mask_5ft.tif")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    gdal.UseExceptions()
    gdal.SetConfigOption("PROJ_NETWORK", "OFF")
    osr.SetPROJEnableNetwork(False)
    args.output.mkdir(parents=True, exist_ok=True)
    srs = osr.SpatialReference()
    srs.ImportFromEPSG(6527)
    wkt = srs.ExportToWkt()
    pixel_ft = 1 / FTUS_M
    nw, nh = math.ceil(WIDTH * 5 / pixel_ft), math.ceil(HEIGHT * 5 / pixel_ft)
    gt = (GRID[0], pixel_ft, 0, GRID[3], 0, -pixel_ft)
    bounds = (gt[0], gt[3] - nh * pixel_ft, gt[0] + nw * pixel_ft, gt[3])
    legacy = gdal.Open(str(args.municipal_mask))
    if (legacy.RasterXSize, legacy.RasterYSize) != (WIDTH, HEIGHT) or not np.allclose(legacy.GetGeoTransform(), GRID):
        raise ValueError("Legacy municipal mask is not on the documented Highlands grid")
    old = legacy.ReadAsArray()
    mask5 = np.isfinite(old) & (old > 0) & (old != legacy.GetRasterBand(1).GetNoDataValue())
    maskds = memory(mask5.astype(np.float32), GRID, wkt, nodata=0)
    mask1m = gdal.Warp("", maskds, format="MEM", outputBounds=bounds, width=nw, height=nh, resampleAlg="near").ReadAsArray() > 0
    source_files = [args.sources / "USGS_one_meter_x58y448_NJ_SdL5_2014.tif"]
    source_files += [args.sources / f"2022_{tile}.tif" for tile in ("8572", "8573", "8671", "8672", "8673")]
    merged = np.full((nh, nw), NODATA, np.float32)
    provenance = np.zeros((nh, nw), np.uint8)
    descriptions = []
    overlap_diffs = []
    for i, path in enumerate(source_files):
        ds = gdal.Open(str(path))
        horizontal = osr.SpatialReference(wkt=ds.GetProjection())
        horizontal.StripVertical()
        # Both input rasters already store NAVD88 heights. Passing horizontal
        # CRS prevents GDAL from silently applying an ellipsoid/geoid shift.
        # Exact transforms avoid the default 0.125-source-pixel approximation,
        # which can produce different heights when warp chunk boundaries vary.
        warped = gdal.Warp("", ds, format="MEM", srcSRS=horizontal.ExportToWkt(), dstSRS=wkt,
                           outputBounds=bounds, width=nw, height=nh, resampleAlg="bilinear", dstNodata=NODATA,
                           errorThreshold=0)
        values = warped.ReadAsArray()
        valid = np.isfinite(values) & (values != NODATA)
        if i:
            overlap = valid & (provenance == 14) & mask1m
            overlap_diffs.append(values[overlap] - merged[overlap])
        merged[valid] = values[valid]
        provenance[valid] = 22 if i else 14
        original_name = (f"2022_USGS_NJ_18TWK{path.stem.removeprefix('2022_')}_BareEarth_1mGrid.tif" if i else path.name)
        download = ("https://noaa-nos-coastal-lidar-pds.s3.amazonaws.com/dem/USACE_NJ_NY_DEM_2022_9851/nj/" if i else "https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/1m/Projects/NJ_SdL5_2014/TIFF/") + original_name
        descriptions.append({"file": path.name, "originalFilename": original_name, "downloadUrl": download, "sha256": sha(path), "nativeCellSizeMeters": 1,
                             "surveyYear": 2022 if i else 2014, "horizontalSourceCrs": horizontal.GetName(),
                             "verticalDatum": "NAVD88", "verticalUnits": "meters"})
    missing = mask1m & (provenance == 0)
    if missing.any():
        raise AssertionError(f"{missing.sum()} municipal source cells lack elevation")
    merged /= np.float32(0.3048)
    merged[provenance == 0] = NODATA
    source_m = memory(merged, gt, wkt)
    # Compute local source limits before applying the municipal mask, so the
    # border uses real neighboring ground rather than nodata edge artifacts.
    good = provenance != 0
    lo = minimum_filter(np.where(good, merged, np.inf), size=5, mode="nearest")
    hi = maximum_filter(np.where(good, merged, -np.inf), size=5, mode="nearest")
    graph_bounds = (GRID[0], GRID[3] - HEIGHT * 5, GRID[0] + WIDTH * 5, GRID[3])
    graph_gt = (GRID[0], 1, 0, GRID[3], 0, -1)
    warp_kw = dict(format="MEM", outputBounds=graph_bounds, width=WIDTH * 5, height=HEIGHT * 5)
    print("Interpolating bounded one-foot calculation terrain", flush=True)
    calc = gdal.Warp("", source_m, resampleAlg="cubic", **warp_kw).ReadAsArray()
    l = gdal.Warp("", memory(lo, gt, wkt), resampleAlg="near", **warp_kw).ReadAsArray()
    h = gdal.Warp("", memory(hi, gt, wkt), resampleAlg="near", **warp_kw).ReadAsArray()
    calc_mask = np.repeat(np.repeat(mask5, 5, axis=0), 5, axis=1)
    if np.any(calc_mask & ((calc == NODATA) | ~np.isfinite(calc))):
        raise AssertionError("Missing one-foot municipal terrain")
    clamped = int(np.count_nonzero(calc_mask & ((calc < l) | (calc > h))))
    np.clip(calc, l, h, out=calc)
    calc[~calc_mask] = NODATA
    write(args.output / "highlands_1ft.tif", calc, graph_gt, wkt)
    del calc, l, h, calc_mask
    merged[~mask1m] = NODATA
    cog_path = args.output / "HighlandsBorough_2022_2014_1m_NAVD88ft.tif"
    write(cog_path, merged, gt, wkt, cog=True)
    write(args.output / "render_mask_5ft.tif", mask5.astype(np.float32), GRID, wkt, unit="")
    write(args.output / "source_year_1m.tif", np.where(mask1m, provenance.astype(np.int16) + 2000, NODATA).astype(np.float32), gt, wkt, unit="year")
    delta = np.concatenate(overlap_diffs)
    report = {
        "schema": "highlands-elevation-mosaic-v2", "release": RELEASE,
        "generatedUtc": datetime.now(timezone.utc).isoformat(),
        "sources": descriptions, "priority": "2022 valid measurements; 2014 fills remaining cells",
        "collectionDates2022": ["2022-11-10", "2022-11-11"],
        "sourceCellSizeMeters": 1, "sourceCellSizeFt": 1 / 0.3048,
        "sourceGridHorizontalUnits": "US survey feet", "sourceGeoTransform": gt,
        "sourceWidth": nw, "sourceHeight": nh, "sourceCog": cog_path.name,
        "sourceCogSha256": sha(cog_path), "verticalDatum": "NAVD88", "verticalUnits": "feet",
        "metersToFeetFactor": 1 / 0.3048, "verticalGeoidTransformationApplied": False,
        "horizontalTransformApproximationTolerancePixels": 0,
        "projNetworkEnabled": False,
        "processingRuntime": {"gdal": gdal.VersionInfo("RELEASE_NAME"),
                              "proj": ".".join(str(x()) for x in (osr.GetPROJVersionMajor, osr.GetPROJVersionMinor, osr.GetPROJVersionMicro))},
        "validSourceCells": int(mask1m.sum()), "cells2022": int(np.count_nonzero(mask1m & (provenance == 22))),
        "cells2014": int(np.count_nonzero(mask1m & (provenance == 14))), "unfilledMunicipalCells": int(missing.sum()),
        "overlap2022Minus2014Meters": {"median": float(np.median(delta)), "p05": float(np.percentile(delta, 5)), "p95": float(np.percentile(delta, 95))},
        "output": "highlands_1ft.tif", "outputSha256": sha(args.output / "highlands_1ft.tif"),
        "outputCellSizeFt": 1, "renderCellSizeFt": 5,
        "method": "bilinear horizontal reprojection to one-meter mosaic; cubic interpolation bounded to local 5x5 finite source extrema for one-foot calculations",
        "cubicValuesClamped": clamped,
        "municipalMask": "existing Highlands raster valid-data footprint; no legacy elevations reused",
        "municipalMaskSha256": sha(args.output / "render_mask_5ft.tif"),
        "accuracyStatement": "one-meter source raster; one-foot computational spacing; five-foot display pooling; interpolation adds no measured detail",
        "sourceLinks": ["https://www.fisheries.noaa.gov/inport/item/70179", "https://www.nj.gov/njgin/edata/elevation/"],
    }
    (args.output / "SourceResamplingManifest.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2), flush=True)


if __name__ == "__main__":
    main()
