# Highlands interface data

Built 2026-10-16 for the Highlands Flood Mapper. These assets extend the interface; the existing Highlands phase-aware flood rasters, forecasts, datum offsets, thresholds, and observed archive remain authoritative for map rendering.

- `parcels.geojson`: 2,699 NJOGIS planning parcel polygons intersecting Highlands (municipal code 1319), with public street addresses and identifiers. No owner names or property values are included. Parcel boundaries are not surveys.
- `structures.geojson`: 1,364 public USACE NSI modeled structure points clipped to the municipal boundary. Occupied-floor screening elevation is local five-foot terrain sampled at the structure point plus modeled NSI foundation height, in feet NAVD88. Missing estimates remain missing. These are not surveyed floors or garage depths.
- `roads.geojson`: existing Highlands RoadRisk road centerlines. Road impacts require both a wet pixel in the displayed Highlands flood raster and modeled depth greater than 0.5 ft.
- `parcel-boundaries.png`: the same parcel boundaries rasterized on the Highlands five-foot query grid for the 3D renderer.
- `return-intervals.json`: published 2015 NACCS still-water ARI means from Sandy Hook Bay save point 11544 beside Highlands. No North Wildwood values or local-gauge weighted blending are used. The crest is displayed in an illustrative symmetric 24-hour rise/fall. Shape and duration have no return-period interpretation. Values above 14 ft NAVD88 exceed the existing flood-raster range and are capped on the map, with the numerical level retained.
- `flood-projections.json`: screening gauge exceedances based on finite hourly-max archive values from Sea Bright USGS 01407600 (2007–2026), independent high-tide peaks separated by six hours, and a Gaussian-kernel CDF. Local monthly-mean trend rebases peaks to 2026; NOAA 2022 Sandy Hook 8531680 relative sea-level scenarios shift that distribution. The 95% band uses 400 calendar-year block-bootstrap samples. It describes sampling variability only, excluding floor, terrain, sea-level-scenario and hydraulic-model uncertainty. A gauge exceedance does not establish that water reached a parcel. These counts are not verified building flood histories.

Building footprints in 3D come from Esri/OpenStreetMap and are clipped to Highlands. Their 5 m display heights are schematic; terrain and vertical display use the reference interface's ×4 exaggeration.

Sources:
- NJOGIS parcels: https://services2.arcgis.com/XVOqAjTOJ5P6ngMu/arcgis/rest/services/Parcels_Composite_NJ_WM/FeatureServer/0
- USACE NSI API: https://www.hec.usace.army.mil/confluence/nsi/technicalreferences/2026/api-reference-guide
- USACE NSI limitations: https://www.hec.usace.army.mil/confluence/nsi/technicalreferences/2026/technical-documentation
- NACCS return levels: https://services.northeastoceandata.org/arcgis1/rest/services/NACCS/NACCS/MapServer/1
- NOAA scenarios: https://api.tidesandcurrents.noaa.gov/dpapi/prod/webapi/product/slr_projections.json?units=metric&station=8531680&report_year=2022

Rebuild with `python tools/build_highlands_feature_data.py` after installing NumPy, SciPy, Pillow, Shapely, and pyproj. The source download cache is `tools/.cache/highlands-feature-data`; remove it to refresh official-source downloads. The existing observed archive is read at rebuild time. The 2026 baseline, annual count assumptions, return-level save point, hydrograph shape, and screening methodology require review before changing them. This rebuild is manual; the existing forecast/observation schedules are unchanged. Run `python tools/test_highlands_feature_data.py` to validate local geometry, floor arithmetic, datum offsets, scenario ordering and projection-array consistency.
