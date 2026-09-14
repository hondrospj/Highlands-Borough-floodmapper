#!/usr/bin/env python3
"""Rebuild and validate Highlands without publishing or modifying source data."""
import argparse
import json
from pathlib import Path
import os
import shlex
import shutil
import subprocess
import sys


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--sources", type=Path, required=True)
    p.add_argument("--work-dir", type=Path, required=True)
    args = p.parse_args()
    tools = Path(__file__).resolve().parent
    work = args.work_dir.resolve()
    work.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, PROJ_NETWORK="OFF")

    def run(argv):
        subprocess.run([str(x) for x in argv], check=True, env=env)

    run([sys.executable, tools / "prepare_dem.py", "--sources", args.sources.resolve(), "--output", work])
    flags = []
    for option in ("--cflags", "--libs"):
        flags += shlex.split(subprocess.check_output(["gdal-config", option], text=True))
    if sys.platform == "darwin":
        prefix = subprocess.check_output(["gdal-config", "--prefix"], text=True).strip()
        flags += ["-Wl,-rpath," + str(Path(prefix) / "lib")]
    run(["c++", "-O3", "-std=c++17", tools / "town_connectivity_graph.cpp", "-o", work / "graph-builder", *flags])
    run([work / "graph-builder", "--dem", work / "highlands_1ft.tif", "--developed", tools / "inputs/developed_1ft.tif", "--output", work / "graph"])
    common = ["--config", tools / "towns.json", "--town", "highlands", "--graph", work / "graph"]
    run([sys.executable, tools / "render_town_catalog.py", *common, "--dem", work / "highlands_1ft.tif",
         "--road-mask", tools / "inputs/road_mask_5ft.tif", "--render-mask", work / "render_mask_5ft.tif", "--output", work / "catalog"])
    shutil.copy2(work / "SourceResamplingManifest.json", work / "catalog/SourceResamplingManifest.json")
    manifest_path = work / "catalog/HydraulicConnectivityAssetManifest.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["renderClip"]["source"] = "tools/highlands_lidar/inputs/municipal_mask_5ft.tif"
    manifest["sourceElevation"] = {"manifest": "SourceResamplingManifest.json", "nativeCellSizeMeters": 1,
                                   "surveyPriority": [2022, 2014], "verticalDatum": "NAVD88", "verticalUnits": "feet"}
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    run([sys.executable, tools / "validate_town_catalog.py", *common, "--catalog", work / "catalog", "--render-mask", work / "render_mask_5ft.tif"])


if __name__ == "__main__":
    main()
