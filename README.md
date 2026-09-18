# Highlands Borough Floodmapper

Generated from the Avalon template using town-specific gauges, datum offsets, thresholds, overlay roots, and the hard-coded municipal boundary from Towns.shp.

The terrain uses the November 2022 USACE/USGS coastal LiDAR DEMs wherever valid measurements are available (about 41% of the mapped area), with the 2014 USGS/NJ Post-Sandy one-meter DEM covering the remainder. Both sources contain NAVD88 elevations. Source cells are one meter, the connectivity calculation grid is one foot, and displayed flood rasters use five-foot pooling. Interpolation does not create finer measured resolution.

All 2,010 flood rasters and both hydraulic query grids were rebuilt from this mosaic. The map's point elevation queries use the same one-meter source. The build preserves Highlands' flood thresholds, depth colors, automatic shared-side source qualification, minimax first-connection stages, five tidal phases, and zero developed-land attenuation. No site-specific bulkhead crest was supplied.

See [the elevation manifest](assets/hydraulic-connectivity-2022-2014-v3/SourceResamplingManifest.json) for tile URLs, survey dates, checksums, units, coverage, and processing, and [the rebuild instructions](tools/highlands_lidar/README.md) for reproduction and validation.
