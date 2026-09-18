#!/usr/bin/env python3
"""Render the portable North-Wildwood-style five-phase flood catalog.

The renderer consumes the one-foot minimax connectivity graph, pools all 25
calculation cells beneath each five-foot display pixel, applies the town's
developed-land penalty, constrains visible feeders to public roads, preserves
monotone catalog masks, and smooths depth only inside the selected wet mask.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from osgeo import gdal, osr
from PIL import Image, ImageDraw
from scipy.ndimage import gaussian_filter, label as ndimage_label

sys.path.insert(0, str(Path(__file__).resolve().parent))
from conditional_connectivity_routes import (  # noqa: E402
    connect_penalty_basins_by_lowest_road_route,
    source_block_geodesic_distance,
)
from hydraulic_mask_sequence import HydraulicMaskSequence  # noqa: E402

STAGES = np.round(np.arange(0.0, 20.05, 0.1), 1)
PHASES = {
    "filling": "filling",
    "slack": "",
    "draining-release-15": "draining-release-15",
    "draining-release-30": "draining-release-30",
    "draining": "draining",
}
PREDECESSOR = {
    "draining-release-15": "slack",
    "draining-release-30": "draining-release-15",
}
DEPTH_BREAKS = np.asarray([0.10, 0.25, 0.50, 1.00, 1.50, 2.00, 2.50, 3.00, 4.00, 5.00])
DEPTH_COLORS = [
    (207, 239, 255), (39, 105, 219), (91, 95, 214), (95, 45, 168),
    (124, 66, 196), (167, 63, 161), (224, 90, 174), (177, 54, 123),
    (165, 36, 64), (63, 0, 10), (58, 0, 8),
]
STAGE_COLORS = [(213, 138, 0), (216, 75, 103), (124, 92, 224)]
GREEN = (121, 221, 90)
NODATA10 = np.iinfo(np.int16).min
NO_CONNECTION10 = np.iinfo(np.int16).max


def args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--town", required=True)
    parser.add_argument("--graph", type=Path, required=True)
    parser.add_argument("--dem", type=Path, required=True)
    parser.add_argument("--road-mask", type=Path, required=True)
    parser.add_argument("--render-template", type=Path)
    parser.add_argument("--render-mask", type=Path)
    parser.add_argument("--domain-manifest", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def rgba_palette(colors: list[tuple[int, int, int]], green_index: int) -> tuple[list[int], bytes]:
    palette = [0] * (256 * 3)
    alpha = bytearray(256)
    for index, color in enumerate(colors, 1):
        palette[index * 3:index * 3 + 3] = color
        alpha[index] = 225
    palette[green_index * 3:green_index * 3 + 3] = GREEN
    alpha[green_index] = 205
    return palette, bytes(alpha)


def code(stage: float) -> str:
    return f"p{round(stage * 10):03d}"


def penalty_function(thresholds: list[float], anchors: list[float]):
    minor, moderate, major = map(float, thresholds)
    values = np.asarray(anchors, dtype=np.float64)
    coefficients = np.polyfit([minor, moderate, major], values, 2)

    def penalty(stage: float) -> float:
        if stage < minor:
            return 0.0
        if stage >= major:
            return float(values[2])
        return max(0.0, float(np.polyval(coefficients, stage)))

    return penalty, coefficients.tolist()


def remaining_fraction(stage: float, phase: str, thresholds: list[float], penalty: float) -> float:
    if penalty <= 0 or phase == "draining":
        return 0.0
    if phase in ("filling", "slack"):
        return 1.0
    moderate, major = float(thresholds[1]), float(thresholds[2])
    if stage >= major:
        return 0.0
    if phase == "draining-release-15":
        return 2 / 3 if stage < moderate else 1 / 2
    if phase == "draining-release-30":
        return 1 / 3 if stage < moderate else 0.0
    raise ValueError(phase)


def pooled_summary(graph: Path, width: int, height: int) -> dict[str, np.ndarray]:
    shape = (height, width)
    render_shape = (height // 5, width // 5)
    elevation = np.memmap(graph / "elevation10.raw", "<i2", "r", shape=shape)
    connection = np.memmap(graph / "connection10.raw", "<i2", "r", shape=shape)
    developed = np.memmap(graph / "developed_flag.raw", "u1", "r", shape=shape)
    source = np.memmap(graph / "source_flag.raw", "u1", "r", shape=shape)
    maximum16 = np.iinfo(np.int16).max
    maximum32 = np.iinfo(np.int32).max
    result = {
        "ground": np.full(render_shape, maximum16, np.int16),
        "ground_developed": np.full(render_shape, maximum16, np.int16),
        "ground_undeveloped": np.full(render_shape, maximum16, np.int16),
        "activation": np.full(render_shape, maximum32, np.int32),
        "activation_developed": np.full(render_shape, maximum32, np.int32),
        "activation_undeveloped": np.full(render_shape, maximum32, np.int32),
        "source": np.zeros(render_shape, bool),
        "developed_count": np.zeros(render_shape, np.uint8),
    }
    for oy in range(5):
        for ox in range(5):
            ground = elevation[oy::5, ox::5]
            conn = connection[oy::5, ox::5]
            valid = ground != NODATA10
            dev = valid & (developed[oy::5, ox::5] != 0)
            undev = valid & ~dev
            activation = np.maximum(ground.astype(np.int32) * 10, conn.astype(np.int32) * 10)
            activation = np.where(valid & (conn != NO_CONNECTION10), activation, maximum32)
            np.minimum(result["ground"], np.where(valid, ground, maximum16), out=result["ground"])
            np.minimum(result["ground_developed"], np.where(dev, ground, maximum16), out=result["ground_developed"])
            np.minimum(result["ground_undeveloped"], np.where(undev, ground, maximum16), out=result["ground_undeveloped"])
            np.minimum(result["activation"], activation, out=result["activation"])
            np.minimum(result["activation_developed"], np.where(dev, activation, maximum32), out=result["activation_developed"])
            np.minimum(result["activation_undeveloped"], np.where(undev, activation, maximum32), out=result["activation_undeveloped"])
            result["source"] |= source[oy::5, ox::5] != 0
            result["developed_count"] += dev
    return result


def crop_summary_to_render_grid(
    summary: dict[str, np.ndarray],
    graph_dem_path: Path,
    render_template_path: Path | None,
) -> tuple[dict[str, np.ndarray], dict]:
    """Crop a buffered five-foot graph summary to the stable display grid."""
    if render_template_path is None:
        height, width = summary["ground"].shape
        return summary, {
            "bufferedGraph": False,
            "graphSummaryWidth": width,
            "graphSummaryHeight": height,
            "cropOffsetPixels": [0, 0],
        }
    graph_dem = gdal.Open(str(graph_dem_path))
    template = gdal.Open(str(render_template_path))
    if graph_dem is None:
        raise FileNotFoundError(graph_dem_path)
    if template is None:
        raise FileNotFoundError(render_template_path)
    source = graph_dem.GetGeoTransform()
    target = template.GetGeoTransform()
    pooled = (
        source[0], source[1] * 5.0, source[2],
        source[3], source[4], source[5] * 5.0,
    )
    if not (
        abs(pooled[1] - target[1]) < 1e-7
        and abs(pooled[5] - target[5]) < 1e-7
        and abs(pooled[2] - target[2]) < 1e-10
        and abs(pooled[4] - target[4]) < 1e-10
    ):
        raise RuntimeError(
            f"Buffered graph and render grids have incompatible cells: "
            f"{pooled} versus {target}"
        )
    x_float = (target[0] - pooled[0]) / pooled[1]
    y_float = (target[3] - pooled[3]) / pooled[5]
    x0, y0 = int(round(x_float)), int(round(y_float))
    if abs(x_float - x0) > 1e-6 or abs(y_float - y0) > 1e-6:
        raise RuntimeError("Render grid is not aligned to the buffered graph")
    width, height = template.RasterXSize, template.RasterYSize
    graph_height, graph_width = summary["ground"].shape
    if x0 < 0 or y0 < 0 or x0 + width > graph_width or y0 + height > graph_height:
        raise RuntimeError("Render grid lies outside the buffered graph")
    cropped = {
        key: values[y0:y0 + height, x0:x0 + width].copy()
        for key, values in summary.items()
    }
    graph_dem = None
    template = None
    return cropped, {
        "bufferedGraph": True,
        "graphSummaryWidth": graph_width,
        "graphSummaryHeight": graph_height,
        "renderWidth": width,
        "renderHeight": height,
        "cropOffsetPixels": [x0, y0],
        "calculationOrder": (
            "connectivity solved on buffered graph before display crop"
        ),
    }


def apply_render_mask(
    summary: dict[str, np.ndarray],
    render_mask_path: Path | None,
) -> dict:
    """Make every catalog/query pixel outside the municipal boundary nodata."""
    valid_before = summary["ground"] != np.iinfo(np.int16).max
    if render_mask_path is None:
        return {
            "applied": False,
            "validPixelsBeforeMask": int(np.count_nonzero(valid_before)),
            "validPixelsAfterMask": int(np.count_nonzero(valid_before)),
        }
    dataset = gdal.Open(str(render_mask_path))
    if dataset is None:
        raise FileNotFoundError(render_mask_path)
    if (dataset.RasterYSize, dataset.RasterXSize) != valid_before.shape:
        raise RuntimeError("Municipal render mask dimensions do not match render grid")
    inside = dataset.GetRasterBand(1).ReadAsArray() != 0
    dataset = None
    outside = ~inside
    maximum16 = np.iinfo(np.int16).max
    maximum32 = np.iinfo(np.int32).max
    for key in ("ground", "ground_developed", "ground_undeveloped"):
        summary[key][outside] = maximum16
    for key in ("activation", "activation_developed", "activation_undeveloped"):
        summary[key][outside] = maximum32
    summary["source"][outside] = False
    summary["developed_count"][outside] = 0
    valid_after = summary["ground"] != maximum16
    return {
        "applied": True,
        "source": str(render_mask_path),
        "municipalMaskPixels": int(np.count_nonzero(inside)),
        "validPixelsBeforeMask": int(np.count_nonzero(valid_before)),
        "validPixelsAfterMask": int(np.count_nonzero(valid_after)),
        "outsidePixelsTransparent": True,
        "appliesTo": "all depth, stage, and query PNGs",
    }


def apply_connection_floor_regions(
    config: dict,
    summary: dict[str, np.ndarray],
    dem_path: Path,
) -> list[dict]:
    """Raise first-admission stages inside user-supplied hydraulic pockets."""
    regions = config.get("connectionFloorRegions") or []
    if not regions:
        return []
    dem = gdal.Open(str(dem_path))
    if dem is None:
        raise FileNotFoundError(dem_path)
    transform = dem.GetGeoTransform()
    render_height, render_width = summary["activation"].shape
    scale_x = dem.RasterXSize / render_width
    scale_y = dem.RasterYSize / render_height
    render_pixel_x = transform[1] * scale_x
    render_pixel_y = transform[5] * scale_y
    target = osr.SpatialReference()
    target.ImportFromWkt(dem.GetProjection())
    target.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    source = osr.SpatialReference()
    source.ImportFromEPSG(4326)
    source.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    project = osr.CoordinateTransformation(source, target)
    dem = None
    diagnostics = []
    maximum = np.iinfo(np.int32).max
    for region in regions:
        vertices = []
        for longitude, latitude in region["polygonWgs84"]:
            projected_x, projected_y, _ = project.TransformPoint(
                float(longitude), float(latitude)
            )
            pixel_x = (projected_x - transform[0]) / render_pixel_x
            pixel_y = (projected_y - transform[3]) / render_pixel_y
            vertices.append((pixel_x, pixel_y))
        image = Image.new("1", (render_width, render_height), 0)
        ImageDraw.Draw(image).polygon(vertices, fill=1)
        region_mask = np.asarray(image, dtype=bool)
        floor100 = int(round(float(region["stageNavd88Ft"]) * 100.0))
        mode = region.get("mode", "minimum-floor")
        changed_union = np.zeros(region_mask.shape, dtype=bool)
        raised_union = np.zeros(region_mask.shape, dtype=bool)
        lowered_union = np.zeros(region_mask.shape, dtype=bool)
        activation_ground_pairs = (
            ("activation", "ground"),
            ("activation_developed", "ground_developed"),
            ("activation_undeveloped", "ground_undeveloped"),
        )
        for key, ground_key in activation_ground_pairs:
            values = summary[key]
            if mode == "fixed-admission":
                ground_values = summary[ground_key]
                candidate = (
                    region_mask
                    & (values != maximum)
                    & (ground_values != np.iinfo(np.int16).max)
                )
                target_values = np.maximum(
                    ground_values.astype(np.int32) * 10,
                    floor100,
                )
                changed = candidate & (values != target_values)
                raised_union |= changed & (target_values > values)
                lowered_union |= changed & (target_values < values)
                values[candidate] = target_values[candidate]
            else:
                changed = region_mask & (values != maximum) & (values < floor100)
                raised_union |= changed
                values[changed] = floor100
            changed_union |= changed
        diagnostics.append(
            {
                "name": region["name"],
                "stageNavd88Ft": float(region["stageNavd88Ft"]),
                "mode": mode,
                "boundaryDescription": region.get("boundaryDescription"),
                "polygonWgs84": region["polygonWgs84"],
                "polygonDisplayPixels": int(np.count_nonzero(region_mask)),
                "activationPixelsChanged": int(np.count_nonzero(changed_union)),
                "activationPixelsRaised": int(np.count_nonzero(raised_union)),
                "activationPixelsLowered": int(np.count_nonzero(lowered_union)),
                "treatment": (
                    (
                        "candidate cells remain disconnected/green below the fixed "
                        "admission stage; at that stage they become immediately "
                        "eligible at their unmodified local ground depths"
                    )
                    if mode == "fixed-admission"
                    else
                    (
                        "candidate cells remain disconnected/green below the floor; "
                        "at the floor they become immediately eligible at their "
                        "unmodified local ground depths"
                    )
                ),
            }
        )
    return diagnostics


def save_paletted(path: Path, values: np.ndarray, palette: list[int], alpha: bytes) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    image = Image.fromarray(values, "P")
    image.putpalette(palette)
    image.info["transparency"] = alpha
    image.save(path, "PNG", optimize=False, compress_level=7)
    return path.stat().st_size


def save_queries(config: dict, summary: dict[str, np.ndarray], output: Path) -> dict:
    ground10 = summary["ground"]
    activation100 = summary["activation"]
    valid = ground10 != np.iinfo(np.int16).max
    unsigned = np.zeros(ground10.shape, np.uint16)
    unsigned[valid] = (ground10[valid].astype(np.int32) + 32768).astype(np.uint16)
    activation10 = np.rint(activation100.astype(np.float64) / 10).astype(np.int64)
    packed = np.zeros((*ground10.shape, 4), np.uint8)
    packed[..., 0] = (unsigned >> 8).astype(np.uint8)
    packed[..., 1] = (unsigned & 255).astype(np.uint8)
    encodable = valid & (activation100 != np.iinfo(np.int32).max)
    packed[..., 2] = 255
    packed[..., 2][encodable] = np.clip(activation10[encodable], -50, 204).astype(np.int16).astype(np.int32) + 50
    packed[..., 3] = 255
    query_path = output / "queries" / f"{config['queryPrefix']}HydraulicQuery5ft.png"
    query_path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(packed, "RGBA").save(query_path, "PNG", compress_level=7)

    traversable = valid
    distance, distance_diag = source_block_geodesic_distance(summary["source"], traversable, 5.0)
    encoded = np.where(np.isfinite(distance), np.clip(np.rint(distance), 0, 65534), 65535).astype(np.uint16)
    developed = summary["developed_count"] >= 13
    mask = np.empty((*developed.shape, 4), np.uint8)
    mask[..., 0] = (encoded >> 8).astype(np.uint8)
    mask[..., 1] = (encoded & 255).astype(np.uint8)
    mask[..., 2] = developed.astype(np.uint8) * 255
    mask[..., 3] = 255
    mask_path = output / "queries" / f"{config['queryPrefix']}DevelopedMask5ft.png"
    Image.fromarray(mask, "RGBA").save(mask_path, "PNG", compress_level=9)
    return {
        "hydraulicQuery": str(query_path.relative_to(output)),
        "developedQuery": str(mask_path.relative_to(output)),
        "developedPixels": int(np.count_nonzero(developed)),
        "sourceDistance": distance_diag,
    }


def main() -> None:
    opts = args()
    all_config = json.loads(opts.config.read_text())
    config = all_config[opts.town]
    graph_manifest = json.loads((opts.graph / "graph_manifest.json").read_text())
    width, height = int(graph_manifest["width"]), int(graph_manifest["height"])
    summary = pooled_summary(opts.graph, width, height)
    summary, domain_diagnostics = crop_summary_to_render_grid(
        summary, opts.dem, opts.render_template
    )
    if opts.domain_manifest:
        buffered_domain = json.loads(opts.domain_manifest.read_text())
        buffered_domain["renderIntegration"] = domain_diagnostics
    else:
        buffered_domain = domain_diagnostics
    render_mask_diagnostics = apply_render_mask(summary, opts.render_mask)
    render_reference = opts.render_template or opts.dem
    connection_floor_diagnostics = apply_connection_floor_regions(
        config,
        summary,
        render_reference,
    )
    valid = summary["ground"] != np.iinfo(np.int16).max
    ground = summary["ground"].astype(np.float32) / 10
    ground_dev = summary["ground_developed"].astype(np.float32) / 10
    ground_undev = summary["ground_undeveloped"].astype(np.float32) / 10
    activation = summary["activation"].astype(np.float64) / 100
    activation_dev = summary["activation_developed"].astype(np.float64) / 100
    activation_undev = summary["activation_undeveloped"].astype(np.float64) / 100
    source = summary["source"]

    road_ds = gdal.Open(str(opts.road_mask))
    if road_ds is None:
        raise FileNotFoundError(opts.road_mask)
    render_height, render_width = summary["ground"].shape
    if (road_ds.RasterXSize, road_ds.RasterYSize) != (render_width, render_height):
        raise RuntimeError("Public-road mask dimensions do not match render grid")
    roads = road_ds.GetRasterBand(1).ReadAsArray() != 0
    road_metadata = road_ds.GetMetadata()
    road_ds = None

    thresholds = list(map(float, config["thresholdsNavd88Ft"]))
    penalty_at, coefficients = penalty_function(thresholds, config["penaltiesFt"])
    depth_palette, depth_alpha = rgba_palette(DEPTH_COLORS, 12)
    stage_palette, stage_alpha = rgba_palette(STAGE_COLORS, 4)
    output = opts.output.resolve()
    query_manifest = save_queries(config, summary, output)
    phase_records = {}
    for phase, directory in PHASES.items():
        sequence = HydraulicMaskSequence(max_hole_pixels=4)
        bytes_written = feeder_instances = green_instances = 0
        previous_flooded = None
        previous_penalty = 0.0
        for stage_index, stage_raw in enumerate(STAGES):
            stage = float(stage_raw)
            base = valid & (activation <= stage + 1e-9)
            penalty = penalty_at(stage)
            phase_penalty = penalty * remaining_fraction(stage, phase, thresholds, penalty)
            adjusted_stage = stage - phase_penalty
            dev_eligible = activation_dev <= stage + 1e-9
            dev_flooded = dev_eligible & (ground_dev <= adjusted_stage + 1e-9)
            undev_flooded = activation_undev <= stage + 1e-9
            adjusted = valid & (dev_flooded | undev_flooded)
            held = valid & dev_eligible & ~adjusted & (phase_penalty > 0)
            feeder = np.zeros(adjusted.shape, bool)
            flooded = adjusted
            if phase_penalty > 0 and np.any(roads & held):
                flooded, feeder, _ = connect_penalty_basins_by_lowest_road_route(
                    adjusted, base, source, roads, ground,
                    penalized_uncertainty=held, feeder_half_width_cells=1,
                )
            required = np.zeros(flooded.shape, bool)
            if previous_flooded is not None and not (previous_penalty <= 0 < phase_penalty):
                required |= previous_flooded
            predecessor = PREDECESSOR.get(phase)
            if predecessor:
                predecessor_path = (
                    output / "DepthPNGs" / config["folder"]
                    / PHASES[predecessor]
                    / f"{config['prefixDepth']}{code(stage)}.png"
                )
                if not predecessor_path.is_file():
                    raise FileNotFoundError(predecessor_path)
                predecessor_codes = np.asarray(Image.open(predecessor_path))
                required |= (predecessor_codes >= 1) & (predecessor_codes <= 11)
            preserved_feeder = required & held & roads & ~flooded
            flooded = flooded | preserved_feeder
            feeder = feeder | preserved_feeder
            repair_eligible = valid & ((ground_dev <= adjusted_stage + 1e-9) | (ground_undev <= stage + 1e-9))
            candidate = flooded.copy()
            flooded = sequence.update(flooded, "filling", repair_eligible)
            stabilized = flooded & ~candidate
            previous_flooded = flooded.copy()
            previous_penalty = phase_penalty
            terrain_below = valid & (ground < stage - 0.005)
            disconnected = terrain_below & ~base
            green = ~flooded & (disconnected | (held & ~flooded))
            green_instances += int(np.count_nonzero(green))
            if phase.startswith("draining"):
                depth = np.where(flooded, stage - ground, 0).astype(np.float32)
            else:
                depth = np.maximum(
                    np.where(dev_flooded, adjusted_stage - ground_dev, 0),
                    np.where(undev_flooded, stage - ground_undev, 0),
                ).astype(np.float32)
                depth[stabilized] = np.maximum(stage - ground[stabilized], 0)
            if np.any(flooded):
                weight = gaussian_filter(flooded.astype(np.float32), sigma=2, mode="nearest")
                filtered = gaussian_filter(np.where(flooded, np.maximum(depth, 0), 0), sigma=2, mode="nearest")
                depth = np.where(flooded, np.divide(filtered, np.maximum(weight, 1e-6)), depth)
            depth[feeder] = 0.05
            depth_codes = np.zeros(flooded.shape, np.uint8)
            depth_codes[green] = 12
            depth_codes[flooded] = np.digitize(depth[flooded], DEPTH_BREAKS) + 1
            local_activation = np.minimum(
                np.where(dev_flooded, activation_dev, np.inf),
                np.where(undev_flooded, activation_undev, np.inf),
            )
            local_activation = np.where(feeder | stabilized, activation, local_activation)
            stage_codes = np.zeros(flooded.shape, np.uint8)
            stage_codes[green] = 4
            stage_codes[flooded] = np.where(
                local_activation[flooded] < thresholds[0], 1,
                np.where(local_activation[flooded] < thresholds[1], 2, 3),
            )
            stage_name = code(stage)
            depth_path = output / "DepthPNGs" / config["folder"] / directory / f"{config['prefixDepth']}{stage_name}.png"
            stage_path = output / "StagePNGs" / config["folder"] / directory / f"{config['prefixStage']}{stage_name}.png"
            bytes_written += save_paletted(depth_path, depth_codes, depth_palette, depth_alpha)
            bytes_written += save_paletted(stage_path, stage_codes, stage_palette, stage_alpha)
            feeder_instances += int(np.count_nonzero(feeder))
            if stage_index % 20 == 0:
                print(f"{config['town']}: {phase} {stage:4.1f} ft", flush=True)
        phase_records[phase] = {
            "stageCount": len(STAGES), "pngCount": len(STAGES) * 2,
            "pngBytes": bytes_written, "visibleFeederPixelInstances": feeder_instances,
            "greenPixelInstances": green_instances,
            "fillingPixelsPreserved": sequence.diagnostics.filling_pixels_preserved,
            "enclosedHolePixelsRepaired": sequence.diagnostics.enclosed_hole_pixels_repaired,
        }

    dem_ds = gdal.Open(str(render_reference))
    transform = dem_ds.GetGeoTransform()
    projection = dem_ds.GetProjection()
    dem_ds = None
    if opts.render_template:
        render_transform = list(transform)
    else:
        render_transform = [transform[0], transform[1] * 5, transform[2], transform[3], transform[4], transform[5] * 5]
    manifest = {
        "schema": "portable-north-wildwood-style-connectivity-assets-v1",
        "generatedUtc": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "town": config["town"], "graph": graph_manifest,
        "hydraulicDomain": buffered_domain,
        "renderClip": render_mask_diagnostics,
        "render": {"width": render_width, "height": render_height, "cellSizeFt": 5,
                   "geotransform": render_transform, "projection": projection,
                   "phases": phase_records},
        "catalog": {"minimumNavd88Ft": 0, "maximumNavd88Ft": 20,
                    "stepFt": 0.1, "stageCount": 201, "phaseCount": 5,
                    "imageTypeCount": 2, "pngCount": 2010},
        "thresholdsNavd88Ft": thresholds,
        "developedPenalty": {"anchorsFt": config["penaltiesFt"],
                             "quadraticCoefficients": coefficients,
                             "spatialMask": "NJDEP Land Use 2015 TYPE15=URBAN"},
        "phaseDirectories": PHASES,
        "siteSpecificConnectionFloors": connection_floor_diagnostics,
        "publicRoadMask": {"source": road_metadata.get("SOURCE"),
                           "filter": road_metadata.get("FILTER"),
                           "roadPixels": int(np.count_nonzero(roads)),
                           "feederWidthFt": 15,
                           "routeCriterion": "lowest crest, then shortest route"},
        "depthBreaksFt": DEPTH_BREAKS.tolist(),
        "depthColorsRgb": DEPTH_COLORS,
        "stageColorsRgb": STAGE_COLORS,
        "disconnectedColorRgb": GREEN,
        "queries": query_manifest,
        "limitations": {"bulkheads": "No site-specific crest input was supplied; no North Wildwood crest was borrowed."},
    }
    (output / "HydraulicConnectivityAssetManifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"status": "passed", "output": str(output), "pngCount": 2010}, indent=2))


if __name__ == "__main__":
    main()
