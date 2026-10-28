#!/usr/bin/env python3
"""Build contours from the verified one-foot, bounded-cubic calculation DEM.

Requires numpy, Pillow, and contourpy. This does not change flood-model assets.
"""

import argparse
import hashlib
import json
import math
from pathlib import Path

import contourpy
import numpy as np
from PIL import Image


def simplify(points, tolerance):
    """Douglas–Peucker in projected US survey feet, preserving line endpoints."""
    if len(points) <= 2:
        return points
    keep = np.zeros(len(points), dtype=bool)
    keep[0] = keep[-1] = True
    pending = [(0, len(points) - 1)]
    while pending:
        first, last = pending.pop()
        if last <= first + 1:
            continue
        delta = points[last] - points[first]
        segment = points[first + 1:last] - points[first]
        length_squared = float(np.dot(delta, delta))
        if length_squared:
            fractions = np.clip(segment @ delta / length_squared, 0, 1)
            distances = np.linalg.norm(segment - fractions[:, None] * delta, axis=1)
        else:
            distances = np.linalg.norm(segment, axis=1)
        index = int(np.argmax(distances))
        if distances[index] > tolerance:
            middle = first + 1 + index
            keep[middle] = True
            pending.extend(((first, middle), (middle, last)))
    return points[keep]


def build(dem_path, manifest_path, calculation_dem_path):
    manifest = json.loads(manifest_path.read_text())
    digest = hashlib.sha256(dem_path.read_bytes()).hexdigest()
    if (manifest.get("sourceCogSha256") != digest
            or manifest.get("verticalDatum") != "NAVD88"
            or manifest.get("verticalUnits") != "feet"):
        raise ValueError("DEM hash and NAVD88-foot source manifest must match")

    calculation_digest = hashlib.sha256(calculation_dem_path.read_bytes()).hexdigest()
    if (manifest.get("outputSha256") != calculation_digest
            or manifest.get("outputCellSizeFt") != 1):
        raise ValueError("The one-foot calculation DEM must match its resampling manifest")

    with Image.open(calculation_dem_path) as image:
        scale = image.tag_v2[33550]
        tie = image.tag_v2[33922]
        geo_keys = image.tag_v2[34735]
        projected_crs = next(
            (geo_keys[i + 3] for i in range(4, len(geo_keys), 4)
             if geo_keys[i] == 3072 and geo_keys[i + 1] == 0), None
        )
        if projected_crs != 6527:
            raise ValueError("Expected the documented EPSG:6527 source grid")
        if not all(math.isclose(step, 1, abs_tol=1e-9) for step in scale[:2]):
            raise ValueError("The calculation DEM must have one-foot horizontal spacing")
        no_data = float(image.tag_v2[42113])
        values = np.asarray(image, dtype=np.float64)

    values = np.ma.masked_where(~np.isfinite(values) | (values == no_data), values)
    origin_x = tie[3] - tie[0] * scale[0]
    origin_y = tie[4] + tie[1] * scale[1]
    x = origin_x + (np.arange(values.shape[1]) + 0.5) * scale[0]
    y = origin_y - (np.arange(values.shape[0]) + 0.5) * scale[1]
    generator = contourpy.contour_generator(
        x=x, y=y, z=values, corner_mask=False, line_type="Separate"
    )

    interval, index_interval = 5, 25
    first = math.ceil(float(values.min()) / interval) * interval
    last = math.floor(float(values.max()) / interval) * interval
    lines = []
    for level in range(first, last + 1, interval):
        for points in generator.lines(level):
            length = float(np.linalg.norm(np.diff(points, axis=0), axis=1).sum())
            if length < 1:
                continue
            points = simplify(points, 0.1)
            if len(points) < 2 or np.all(points == points[0]):
                continue
            lines.append({
                "elevationFt": level,
                "index": level % index_interval == 0,
                "coordinates": np.round(points, 2).tolist(),
            })

    return {
        "schemaVersion": 1,
        "horizontalCrs": "EPSG:6527",
        "verticalDatum": "NAVD88",
        "verticalUnits": "feet",
        "intervalFt": interval,
        "indexIntervalFt": index_interval,
        "source": {
            "name": "Highlands 2022/2014 bare-earth LiDAR mosaic",
            "surveyYears": [2022, 2014],
            "priority": manifest["priority"],
            "sourceCellSizeMeters": manifest["sourceCellSizeMeters"],
            "sourceCog": manifest["sourceCog"],
            "sha256": digest,
            "links": manifest["sourceLinks"],
        },
        "generation": {
            "method": "Linear contours of bounded-cubic one-foot terrain; NoData masked",
            "calculationCellSizeFt": 1,
            "calculationDem": manifest["output"],
            "calculationDemSha256": calculation_digest,
            "resamplingMethod": manifest["method"],
            "accuracyStatement": manifest["accuracyStatement"],
            "cornerMask": False,
            "simplificationToleranceFt": 0.1,
            "minimumInputLineLengthFt": 1,
        },
        "lines": lines,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dem", required=True, type=Path)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--calculation-dem", required=True, type=Path,
                        help="The manifest's bounded-cubic one-foot output DEM")
    parser.add_argument("--output", type=Path,
                        default=Path("data/highlands-elevation-contours.json"))
    args = parser.parse_args()
    result = build(args.dem, args.manifest, args.calculation_dem)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, separators=(",", ":")) + "\n")
    print(f"{len(result['lines'])} contour lines; {args.output.stat().st_size:,} bytes")


if __name__ == "__main__":
    main()
