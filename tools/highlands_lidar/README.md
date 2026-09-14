# Highlands elevation rebuild

This pipeline replaces the legacy five-foot elevation source with a one-meter
2022/2014 mosaic and regenerates the complete existing flood catalog. Elevations
remain NAVD88 feet. The one-foot computational grid and five-foot display grid
are distinct from the one-meter measured-source raster spacing.

## Sources

Download the files listed in
`assets/hydraulic-connectivity-2022-2014-v2/SourceResamplingManifest.json`.
Use each record's `downloadUrl`, save it with the local `file` name, and verify
its SHA-256 checksum before rebuilding. The 2022 tiles are 18TWK8572,
18TWK8573, 18TWK8671, 18TWK8672, and 18TWK8673. The complete fallback is
`USGS_one_meter_x58y448_NJ_SdL5_2014.tif`.

The native sources already have NAVD88 orthometric heights in meters. Horizontal
reprojection uses NAD83(2011) New Jersey US survey feet (EPSG:6527). No additional
geoid-to-ellipsoid conversion is applied; heights are converted once using
1 foot = 0.3048 meter. 2022 valid cells replace 2014 cells. No legacy elevations
are used as a fallback. The established municipal valid-data footprint is
stored in `inputs/municipal_mask_5ft.tif`.

The 2022 coastal flight has incomplete borough coverage. A per-cell source-year
map is provided in `assets/elevation/source_year_1m.tif`. Mixing survey vintages
can leave real temporal differences along coverage edges; the source manifest
records the overlap difference distribution. This build does not infer new
bulkhead heights or otherwise modify the physical flood rules.

## Rebuild

Requires Python with GDAL, NumPy, SciPy and Pillow, plus a C++17 compiler and
`gdal-config` from the same GDAL installation. Run from the repository root:

```sh
python tools/highlands_lidar/rebuild.py --sources /path/to/source-tiles --work-dir /path/to/build
```

The script builds bounded cubic one-foot computational terrain from the
one-meter mosaic, builds the minimax connectivity graph, produces all 201
stages (0–20 feet NAVD88 at 0.1-foot increments) for five phases and two
image families, and validates all 2,010 flood images. It also creates two query
PNGs and the one-meter Cloud Optimized GeoTIFF for point elevation queries.

The supplied developed-land and public-road masks preserve the existing August
2026 Highlands build inputs; they are on the same georeferenced calculation and
display grids. `towns.json` preserves flood thresholds 3.07/4.07/5.07 feet
NAVD88 and zero attenuation anchors. Validation checks every image, its
palette, paired depth/stage footprints, municipal clipping, monotone filling,
release nesting, and graph predecessor/source constraints.

## Publication

Copy the validated catalog into `assets/hydraulic-connectivity-2022-2014-v2/`
and the source COG into `assets/elevation/`. The site uses the bundled catalog
and the versioned Bunny COG for elevation queries. A complete additional copy
of the catalog is stored in Bunny under
`HighlandsBorough/highlands-lidar-2022-2014-v2/`.

```sh
python tools/highlands_lidar/publish.py --catalog /path/to/build/catalog --cog /path/to/build/HighlandsBorough_2022_2014_1m_NAVD88ft.tif --report /path/to/build/PublicationValidation.json
```

Publishing reads the existing `BUNNY_STORAGE_PASSWORD`/`BUNNY_STORAGE_KEY`
environment variable or the macOS Keychain service
`shorelysafe.bunny.storage.floodmapperv1` (account `floodmapperv1`). Credentials
are never printed or committed. The publisher uploads only this versioned
Highlands release, verifies every public PNG and the elevation COG by SHA-256,
checks CORS, and checks DEM byte-range access. It does not delete older releases.

`--verify-only` reruns public verification without uploading. Publishing does
not commit or push GitHub changes; those operations occur after validation.
