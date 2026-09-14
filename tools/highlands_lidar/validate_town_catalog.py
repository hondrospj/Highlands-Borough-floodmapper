#!/usr/bin/env python3
"""Validate a complete portable connectivity catalog and its graph contract."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from osgeo import gdal
from PIL import Image

PHASES = {
    "filling": "filling",
    "slack": "",
    "draining-release-15": "draining-release-15",
    "draining-release-30": "draining-release-30",
    "draining": "draining",
}
EXPECTED_DEPTH = [
    (207, 239, 255), (39, 105, 219), (91, 95, 214), (95, 45, 168),
    (124, 66, 196), (167, 63, 161), (224, 90, 174), (177, 54, 123),
    (165, 36, 64), (63, 0, 10), (58, 0, 8),
]
EXPECTED_STAGE = [(213, 138, 0), (216, 75, 103), (124, 92, 224)]
EXPECTED_GREEN = (121, 221, 90)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--town", required=True)
    parser.add_argument("--graph", type=Path, required=True)
    parser.add_argument("--catalog", type=Path, required=True)
    parser.add_argument("--render-mask", type=Path)
    return parser.parse_args()


def filename(config: dict, family: str, stage_index: int) -> str:
    prefix = config["prefixDepth"] if family == "DepthPNGs" else config["prefixStage"]
    return f"{prefix}p{stage_index:03d}.png"


def read_codes(path: Path) -> np.ndarray:
    with Image.open(path) as image:
        if image.mode != "P":
            raise AssertionError(f"Not a paletted PNG: {path}")
        return np.asarray(image).copy()


def palette_rgb(path: Path, indices: range) -> list[tuple[int, int, int]]:
    with Image.open(path) as image:
        raw = image.getpalette()
    return [tuple(raw[index * 3:index * 3 + 3]) for index in indices]


def validate_graph(graph: Path, width: int, height: int) -> dict:
    shape = (height, width)
    ground = np.memmap(graph / "elevation10.raw", "<i2", "r", shape=shape)
    connection = np.memmap(graph / "connection10.raw", "<i2", "r", shape=shape)
    source = np.memmap(graph / "source_flag.raw", "u1", "r", shape=shape) != 0
    nodata = np.iinfo(np.int16).min
    none = np.iinfo(np.int16).max
    if np.any(source & ((ground == nodata) | (ground > 20))):
        raise AssertionError("Qualified source contains nodata or terrain above 2.0 ft")
    connected = connection != none
    if np.any(connected & (ground == nodata)):
        raise AssertionError("Connection stage assigned to nodata")
    if np.any(connected & (connection < ground)):
        raise AssertionError("Connection stage is below local ground")
    if np.any(source & ~connected):
        raise AssertionError("Qualified source is not connected")

    # Every non-source connected cell must have a side-neighbour that can be
    # its minimax predecessor at the same or a lower controlling crest.
    has_predecessor = source.copy()
    checks = (
        (slice(1, None), slice(None), slice(None, -1), slice(None)),
        (slice(None, -1), slice(None), slice(1, None), slice(None)),
        (slice(None), slice(1, None), slice(None), slice(None, -1)),
        (slice(None), slice(None, -1), slice(None), slice(1, None)),
    )
    for cy, cx, ny, nx in checks:
        current = connection[cy, cx]
        neighbour = connection[ny, nx]
        current_ground = ground[cy, cx]
        has_predecessor[cy, cx] |= (
            (current != none) & (neighbour != none)
            & (np.maximum(current_ground.astype(np.int32), neighbour.astype(np.int32)) <= current)
        )
    missing = connected & ~has_predecessor
    if np.any(missing):
        raise AssertionError(f"{np.count_nonzero(missing)} connected cells lack a minimax predecessor")
    return {
        "validCells": int(np.count_nonzero(ground != nodata)),
        "sourceCells": int(np.count_nonzero(source)),
        "connectedCells": int(np.count_nonzero(connected)),
        "unconnectedThrough20Ft": int(np.count_nonzero((ground != nodata) & ~connected)),
    }


def main() -> None:
    opts = parse_args()
    config = json.loads(opts.config.read_text())[opts.town]
    manifest = json.loads((opts.catalog / "HydraulicConnectivityAssetManifest.json").read_text())
    width = int(manifest["graph"]["width"])
    height = int(manifest["graph"]["height"])
    expected_size = (
        int(manifest["render"]["width"]),
        int(manifest["render"]["height"]),
    )
    outside = None
    if opts.render_mask:
        mask_dataset = gdal.Open(str(opts.render_mask))
        if mask_dataset is None:
            raise FileNotFoundError(opts.render_mask)
        if (mask_dataset.RasterXSize, mask_dataset.RasterYSize) != expected_size:
            raise AssertionError("Municipal render mask has wrong dimensions")
        outside = mask_dataset.GetRasterBand(1).ReadAsArray() == 0
        mask_dataset = None
    if manifest["catalog"]["pngCount"] != 2010:
        raise AssertionError("Manifest does not declare 2,010 catalog PNGs")

    paths: list[Path] = []
    previous_filling = None
    phase_wet_counts = {}
    for phase, directory in PHASES.items():
        counts = []
        for stage_index in range(201):
            depth = opts.catalog / "DepthPNGs" / config["folder"] / directory / filename(config, "DepthPNGs", stage_index)
            dynamic = opts.catalog / "StagePNGs" / config["folder"] / directory / filename(config, "StagePNGs", stage_index)
            if not depth.is_file() or not dynamic.is_file():
                raise FileNotFoundError(depth if not depth.is_file() else dynamic)
            paths.extend((depth, dynamic))
            with Image.open(depth) as image:
                if image.size != expected_size:
                    raise AssertionError(f"Wrong dimensions: {depth}: {image.size}")
            depth_codes = read_codes(depth)
            stage_codes = read_codes(dynamic)
            if outside is not None:
                if np.any(depth_codes[outside] != 0):
                    raise AssertionError(f"Depth PNG leaks outside municipal mask: {depth}")
                if np.any(stage_codes[outside] != 0):
                    raise AssertionError(f"Stage PNG leaks outside municipal mask: {dynamic}")
            wet = (depth_codes >= 1) & (depth_codes <= 11)
            stage_wet = (stage_codes >= 1) & (stage_codes <= 3)
            if not np.array_equal(wet, stage_wet):
                raise AssertionError(f"Depth/stage wet masks differ: {depth}")
            if previous_filling is not None and phase == "filling" and np.any(previous_filling & ~wet):
                raise AssertionError(f"Filling catalog loses wet pixels at stage {stage_index / 10:.1f}")
            if phase == "filling":
                previous_filling = wet
            predecessor = {"draining-release-15": "slack", "draining-release-30": "draining-release-15"}.get(phase)
            if predecessor:
                predecessor_path = opts.catalog / "DepthPNGs" / config["folder"] / PHASES[predecessor] / filename(config, "DepthPNGs", stage_index)
                predecessor_codes = read_codes(predecessor_path)
                predecessor_wet = (predecessor_codes >= 1) & (predecessor_codes <= 11)
                if np.any(predecessor_wet & ~wet):
                    raise AssertionError(f"{phase} omits predecessor wet cells at {stage_index / 10:.1f}")
            counts.append(int(np.count_nonzero(wet)))
        phase_wet_counts[phase] = {"minimum": min(counts), "maximum": max(counts)}

    if len(paths) != 2010 or len(set(paths)) != 2010:
        raise AssertionError(f"Expected 2,010 unique paths, found {len(set(paths))}")
    sample_depth = opts.catalog / "DepthPNGs" / config["folder"] / filename(config, "DepthPNGs", 40)
    sample_stage = opts.catalog / "StagePNGs" / config["folder"] / filename(config, "StagePNGs", 40)
    if palette_rgb(sample_depth, range(1, 12)) != EXPECTED_DEPTH or palette_rgb(sample_depth, range(12, 13))[0] != EXPECTED_GREEN:
        raise AssertionError("Depth palette or green diagnostic color changed")
    if palette_rgb(sample_stage, range(1, 4)) != EXPECTED_STAGE or palette_rgb(sample_stage, range(4, 5))[0] != EXPECTED_GREEN:
        raise AssertionError("Stage palette or green diagnostic color changed")
    graph_result = validate_graph(opts.graph, width, height)
    report = {
        "status": "passed", "town": config["town"], "pngCount": len(paths),
        "dimensions": list(expected_size), "palettePreserved": True,
        "depthStageMasksPaired": True, "fillingMonotone": True,
        "releasePhaseNesting": True,
        "allRenderedPngsClippedToMunicipalMask": outside is not None,
        "graph": graph_result,
        "phaseWetPixelCounts": phase_wet_counts,
    }
    report_path = opts.catalog / "HydraulicConnectivityValidation.json"
    report_path.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
