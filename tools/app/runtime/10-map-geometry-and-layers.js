    function preloadAroundHour(index) {
      // Full-resolution composites are loaded only for the selected frame.
    }

    function scheduleOverlayCatalogWarmup(index) {
      // The selected frame is loaded on demand by the map renderer.
    }

    function scheduleHistoricalTopTideWarmup() {
      // Historical data and its raster are requested only when a card is selected.
    }

    // The hydraulic grid is north-up in EPSG:6527, not in Web Mercator. Keep
    // all four transformed pixel-edge corners so Leaflet and MapLibre preserve
    // the world file's rotation and projection convergence instead of forcing
    // the raster into an axis-aligned WGS84 rectangle.
    function getConfiguredWorldFileCornersLatLng() {
      const configured = TOWN_CONFIG?.overlays?.worldFileCornersWgs84;
      const values = Array.isArray(configured)
        ? configured
        : configured && typeof configured === "object"
          ? [configured.northWest, configured.northEast, configured.southEast, configured.southWest]
          : [];
      if (values.length !== 4) return null;
      const corners = values.map(value => {
        const lat = Number(Array.isArray(value) ? value[0] : value?.lat);
        const lng = Number(Array.isArray(value) ? value[1] : value?.lng ?? value?.lon);
        return [lat, lng];
      });
      if (!corners.every(value => value.every(Number.isFinite))) return null;
      return corners.map(value => L.latLng(value[0], value[1]));
    }

    function getConfiguredWorldFileCoordinates() {
      const corners = getConfiguredWorldFileCornersLatLng();
      return corners?.map(corner => [corner.lng, corner.lat]) || null;
    }

    function getWorldFileRasterSize() {
      const configured = TOWN_CONFIG?.overlays?.worldFileRasterSize || {};
      const width = Number(configured.width);
      const height = Number(configured.height);
      return {
        width: Number.isFinite(width) && width > 0 ? width : 2186,
        height: Number.isFinite(height) && height > 0 ? height : 2824
      };
    }

    function latLngToWorldFileUv(lat, lng) {
      const corners = getConfiguredWorldFileCornersLatLng();
      if (!corners) return null;
      const projectedCorners = corners.map(corner => L.CRS.EPSG3857.project(corner));
      const [northWest, northEast, , southWest] = projectedCorners;
      const acrossX = northEast.x - northWest.x;
      const acrossY = northEast.y - northWest.y;
      const downX = southWest.x - northWest.x;
      const downY = southWest.y - northWest.y;
      const determinant = (acrossX * downY) - (acrossY * downX);
      if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) return null;
      const point = L.CRS.EPSG3857.project(L.latLng(Number(lat), Number(lng)));
      const relativeX = point.x - northWest.x;
      const relativeY = point.y - northWest.y;
      const u = ((relativeX * downY) - (relativeY * downX)) / determinant;
      const v = ((acrossX * relativeY) - (acrossY * relativeX)) / determinant;
      return Number.isFinite(u) && Number.isFinite(v) ? { u, v } : null;
    }

    function latLngToWorldFilePixel(lat, lng, width, height) {
      const uv = latLngToWorldFileUv(lat, lng);
      if (!uv || uv.u < 0 || uv.v < 0 || uv.u >= 1 || uv.v >= 1) return null;
      const x = Math.floor(uv.u * Number(width));
      const y = Math.floor(uv.v * Number(height));
      return Number.isFinite(x) && Number.isFinite(y) ? { x, y, u: uv.u, v: uv.v } : null;
    }

    const WorldFileImageOverlay = L.ImageOverlay.extend({
      initialize(url, corners, options = {}) {
        this._worldFileCorners = corners.map(corner => L.latLng(corner));
        this._worldFileAffine = true;
        this._pixelWidth = Number(options.pixelWidth) || 2186;
        this._pixelHeight = Number(options.pixelHeight) || 2824;
        const bounds = L.latLngBounds(this._worldFileCorners);
        L.ImageOverlay.prototype.initialize.call(this, url, bounds, options);
      },

      _worldFileLayerPoints(zoomEvent = null) {
        if (!this._map) return null;
        return this._worldFileCorners.map(corner => zoomEvent
          ? this._map._latLngToNewLayerPoint(corner, zoomEvent.zoom, zoomEvent.center)
          : this._map.latLngToLayerPoint(corner));
      },

      _applyWorldFileTransform(points) {
        if (!this._image || !points) return;
        const [northWest, northEast, , southWest] = points;
        const width = this._pixelWidth;
        const height = this._pixelHeight;
        const scaleX = (northEast.x - northWest.x) / width;
        const shearY = (northEast.y - northWest.y) / width;
        const shearX = (southWest.x - northWest.x) / height;
        const scaleY = (southWest.y - northWest.y) / height;
        this._image.style.width = `${width}px`;
        this._image.style.height = `${height}px`;
        this._image.style.left = "0";
        this._image.style.top = "0";
        this._image.style.transformOrigin = "0 0";
        // A world file is affine. Keeping the raster in Leaflet's normal 2D
        // compositor plane prevents pan/zoom flashes and z-order inversions.
        this._image.style.transform = `matrix(${[
          scaleX, shearY, shearX, scaleY, northWest.x, northWest.y
        ].join(",")})`;
      },

      _reset() {
        this._applyWorldFileTransform(this._worldFileLayerPoints());
      },

      _animateZoom(event) {
        this._applyWorldFileTransform(this._worldFileLayerPoints(event));
      }
    });

    function createWorldFileImageOverlay(url, options = {}) {
      const corners = getConfiguredWorldFileCornersLatLng();
      if (!corners) return null;
      const rasterSize = getWorldFileRasterSize();
      return new WorldFileImageOverlay(url, corners, {
        ...options,
        pixelWidth: rasterSize.width,
        pixelHeight: rasterSize.height
      });
    }

    function createHydraulicImageOverlay(url, options = {}, source = url) {
      if (url === PARCEL_BOUNDARY_PNG_URL && TOWN_CONFIG.parcels?.worldFileCornersWgs84) {
        const raster = TOWN_CONFIG.parcels.worldFileRasterSize;
        return new WorldFileImageOverlay(source, TOWN_CONFIG.parcels.worldFileCornersWgs84, {
          ...options,
          pixelWidth: raster?.width,
          pixelHeight: raster?.height
        });
      }
      return createWorldFileImageOverlay(source, options) || L.imageOverlay(source, floodLatLngBounds, options);
    }

    function getActiveFloodOverlayCoordinates() {
      const useWorldFile = currentFloodLayer?._worldFileAffine === true ||
        (!currentFloodLayer && floodOverlayGeometryMode === "world-file");
      if (useWorldFile) {
        const coordinates = getConfiguredWorldFileCoordinates();
        if (coordinates) return coordinates;
      }
      if (!floodLatLngBounds) return null;
      return [
        [floodLatLngBounds.getWest(), floodLatLngBounds.getNorth()],
        [floodLatLngBounds.getEast(), floodLatLngBounds.getNorth()],
        [floodLatLngBounds.getEast(), floodLatLngBounds.getSouth()],
        [floodLatLngBounds.getWest(), floodLatLngBounds.getSouth()]
      ];
    }

    async function ensureOverlayBounds(sampleOverlayUrl) {
      const configured = TOWN_CONFIG?.overlays?.boundsWgs84 || {};
      const south = Number(configured.south);
      const west = Number(configured.west);
      const north = Number(configured.north);
      const east = Number(configured.east);
      const hasConfiguredBounds = [south, west, north, east].every(Number.isFinite)
        && south < north
        && west < east;
      const worldFileCorners = getConfiguredWorldFileCornersLatLng();
      floodLatLngBounds = worldFileCorners
        ? L.latLngBounds(worldFileCorners)
        : hasConfiguredBounds
          ? L.latLngBounds([south, west], [north, east])
          : getBoundaryDrivenOverlayBounds();
      floodOverlayGeometryMode = worldFileCorners ? "world-file" : "axis-aligned";
      document.body.dataset.floodRasterGeometry = worldFileCorners
        ? "world-file-quadrilateral"
        : "axis-aligned";

      return {
        url: sampleOverlayUrl || null,
        mode: worldFileCorners ? "world-file-quadrilateral" : hasConfiguredBounds ? "configured-raster" : "boundary-fallback",
        bounds: floodLatLngBounds
      };
    }

    function getPrimaryMunicipalBoundaryRing() {
      return Array.isArray(municipalBoundaryRings) && municipalBoundaryRings.length ? municipalBoundaryRings[0] : FALLBACK_TOWN_MASK_RING;
    }

    function approximateRingArea(ring) {
      if (!Array.isArray(ring) || ring.length < 3) return 0;
      let area = 0;
      for (let i = 0; i < ring.length; i++) {
        const [lat1, lng1] = ring[i];
        const [lat2, lng2] = ring[(i + 1) % ring.length];
        area += (lng1 * lat2) - (lng2 * lat1);
      }
      return Math.abs(area / 2);
    }

    function webMercatorToWgs84(x, y) {
      const longitude = (Number(x) / 20037508.34) * 180;
      const mercatorLatitude = (Number(y) / 20037508.34) * 180;
      const latitude = (180 / Math.PI) * (2 * Math.atan(Math.exp(mercatorLatitude * Math.PI / 180)) - (Math.PI / 2));
      return [longitude, latitude];
    }

function normalizeBoundaryRingsFromArcGIS(rings, sourceWkid = 3857) {
      if (!Array.isArray(rings)) return [];
      const sourceCrs = Number(sourceWkid) === 4326 ? "EPSG:4326" : "EPSG:3857";

      return rings
        .map(ring => Array.isArray(ring) ? ring : [])
        .map(ring => ring
          .filter(coord => Array.isArray(coord) && coord.length >= 2)
          .map(([x, y]) => {
            const pair = sourceCrs === "EPSG:4326" ? [x, y] : webMercatorToWgs84(x, y);
            const [lng, lat] = pair;
            return [lat, lng];
          })
        )
        .map(ring => {
          if (ring.length > 1) {
            const first = ring[0];
            const last = ring[ring.length - 1];
            if (first[0] === last[0] && first[1] === last[1]) ring.pop();
          }
          return ring;
        })
        .filter(ring => ring.length >= 3)
        .sort((a, b) => approximateRingArea(b) - approximateRingArea(a));
    }

    function buildGeoJsonFeatureFromArcGIS(feature) {
      if (!feature?.geometry?.rings?.length) return null;
      const spatialReference = feature.geometry.spatialReference || {};
      const sourceWkid = Number(spatialReference.latestWkid || spatialReference.wkid || 3857);
      const rings = normalizeBoundaryRingsFromArcGIS(feature.geometry.rings, sourceWkid);
      if (!rings.length) return null;

      const coordinates = rings.length === 1
        ? [rings[0].map(([lat, lng]) => [lng, lat])]
        : rings.map(ring => [ring.map(([lat, lng]) => [lng, lat])]);

      return {
        type: "Feature",
        properties: feature.attributes || {},
        geometry: {
          type: rings.length === 1 ? "Polygon" : "MultiPolygon",
          coordinates
        }
      };
    }

    function latLngBoundsFromBoundsObject(bounds) {
      if (!bounds || typeof bounds !== "object") return null;
      const sw = bounds.southWest || bounds.sw || (Number.isFinite(Number(bounds.south)) && Number.isFinite(Number(bounds.west)) ? [bounds.south, bounds.west] : null);
      const ne = bounds.northEast || bounds.ne || (Number.isFinite(Number(bounds.north)) && Number.isFinite(Number(bounds.east)) ? [bounds.north, bounds.east] : null);
      if (!sw || !ne) return null;
      const parsed = L.latLngBounds(sw, ne);
      return parsed && parsed.isValid && parsed.isValid() ? parsed : null;
    }

    function ringFromLatLngBounds(bounds) {
      if (!bounds || !bounds.isValid || !bounds.isValid()) return [];
      const sw = bounds.getSouthWest();
      const ne = bounds.getNorthEast();
      return [
        [sw.lat, sw.lng],
        [ne.lat, sw.lng],
        [ne.lat, ne.lng],
        [sw.lat, ne.lng],
        [sw.lat, sw.lng]
      ];
    }

    function normalizeLatLngRing(ring) {
      if (!Array.isArray(ring)) return [];
      const normalized = ring
        .filter(point => Array.isArray(point) && point.length >= 2)
        .map(([lat, lng]) => [Number(lat), Number(lng)])
        .filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng));
      if (normalized.length > 1) {
        const first = normalized[0];
        const last = normalized[normalized.length - 1];
        if (first[0] === last[0] && first[1] === last[1]) normalized.pop();
      }
      return normalized.length >= 3 ? normalized : [];
    }

    function normalizeRingsFromGeoJsonGeometry(geometry) {
      if (!geometry) return [];
      const rings = [];
      const addRing = ring => {
        const normalized = Array.isArray(ring)
          ? ring.map(coord => Array.isArray(coord) && coord.length >= 2 ? [Number(coord[1]), Number(coord[0])] : null).filter(Boolean)
          : [];
        const valid = normalizeLatLngRing(normalized);
        if (valid.length) rings.push(valid);
      };
      if (geometry.type === "Polygon") {
        (geometry.coordinates || []).forEach(addRing);
      } else if (geometry.type === "MultiPolygon") {
        (geometry.coordinates || []).forEach(poly => (poly || []).forEach(addRing));
      }
      return rings.sort((a, b) => approximateRingArea(b) - approximateRingArea(a));
    }

    function featureFromLatLngRings(rings, properties = {}) {
      const validRings = (rings || []).map(normalizeLatLngRing).filter(ring => ring.length >= 3);
      if (!validRings.length) return null;
      return {
        type: "Feature",
        properties,
        geometry: {
          type: validRings.length === 1 ? "Polygon" : "MultiPolygon",
          coordinates: validRings.length === 1
            ? [validRings[0].map(([lat, lng]) => [lng, lat])]
            : validRings.map(ring => [ring.map(([lat, lng]) => [lng, lat])])
        }
      };
    }

    function pickBoundaryFeatureFromGeoJson(data) {
      if (!data) return null;
      if (data.type === "Feature") return data;
      if (data.type === "FeatureCollection") {
        return (data.features || []).find(feature => {
          const type = feature?.geometry?.type;
          return type === "Polygon" || type === "MultiPolygon";
        }) || null;
      }
      if (data.type === "Polygon" || data.type === "MultiPolygon") {
        return { type: "Feature", properties: {}, geometry: data };
      }
      return null;
    }

    function seedMunicipalBoundary(data) {
      const feature = pickBoundaryFeatureFromGeoJson(data);
      const rings = normalizeRingsFromGeoJsonGeometry(feature?.geometry);
      if (!feature || !rings.length) return false;
      municipalBoundaryFeature = feature;
      municipalBoundaryRings = rings;
      FALLBACK_TOWN_MASK_RING = rings[0];
      FALLBACK_LATLNG_BOUNDS = latLngBoundsFromRing(rings[0]);
      return true;
    }

    async function fetchBunnyBoundaryFeature() {
      if (!MUNICIPAL_BOUNDARY_BUNNY_URL) return null;
      const response = await fetch(MUNICIPAL_BOUNDARY_BUNNY_URL, {
        cache: "no-store",
        headers: { "Accept": "application/geo+json, application/json" }
      });
      if (!response.ok) throw new Error(`Bunny boundary request failed: ${response.status}`);
      const data = await response.json();

      const geoJsonFeature = pickBoundaryFeatureFromGeoJson(data);
      if (geoJsonFeature) {
        const rings = normalizeRingsFromGeoJsonGeometry(geoJsonFeature.geometry);
        if (rings.length) {
          municipalBoundaryFeature = geoJsonFeature;
          municipalBoundaryRings = rings;
          FALLBACK_TOWN_MASK_RING = rings[0];
          FALLBACK_LATLNG_BOUNDS = latLngBoundsFromRing(rings[0]);
          return { feature: geoJsonFeature, rings };
        }
      }

      const rings = (data.rings || data.fallbackMaskRings || (data.fallbackMaskRing ? [data.fallbackMaskRing] : []))
        .map(normalizeLatLngRing)
        .filter(ring => ring.length >= 3)
        .sort((a, b) => approximateRingArea(b) - approximateRingArea(a));
      const bounds = latLngBoundsFromBoundsObject(data.bounds || data.fallbackLatLngBounds || data.latLngBounds);
      const finalRings = rings.length ? rings : (bounds ? [ringFromLatLngBounds(bounds)] : []);
      if (!finalRings.length) throw new Error("Bunny boundary file did not contain a usable GeoJSON polygon, rings, or bounds.");

      const feature = featureFromLatLngRings(finalRings, data.properties || {});
      FALLBACK_TOWN_MASK_RING = finalRings[0];
      FALLBACK_LATLNG_BOUNDS = bounds || latLngBoundsFromRing(finalRings[0]);
      return { feature, rings: finalRings };
    }

    async function fetchMunicipalBoundaryFeature() {
      try {
        const bunnyBoundary = await fetchBunnyBoundaryFeature();
        if (bunnyBoundary?.feature && bunnyBoundary?.rings?.length) return bunnyBoundary;
      } catch (err) {
        console.warn("Could not load municipal boundary from Bunny; trying ArcGIS query.", err);
      }

      for (const where of MUNICIPAL_BOUNDARY_QUERY_CANDIDATES) {
        const params = new URLSearchParams({
          f: "json",
          where,
          outFields: MUNICIPAL_BOUNDARY_OUTFIELDS,
          returnGeometry: "true",
          outSR: "3857",
          resultRecordCount: "1"
        });

        const response = await fetch(`${MUNICIPAL_BOUNDARY_QUERY_URL}?${params.toString()}`, {
          cache: "no-store",
          headers: { "Accept": "application/json" }
        });

        if (!response.ok) continue;
        const json = await response.json();
        const feature = Array.isArray(json?.features) ? json.features[0] : null;
        const geojsonFeature = buildGeoJsonFeatureFromArcGIS(feature);
        if (geojsonFeature) {
          return { feature: geojsonFeature, rings: normalizeBoundaryRingsFromArcGIS(feature.geometry.rings, Number(feature.geometry?.spatialReference?.latestWkid || feature.geometry?.spatialReference?.wkid || 3857)) };
        }
      }

      return null;
    }

    function makeBoundaryVector(style) {
      const boundaryStyle = {
        fill: false,
        fillOpacity: 0,
        stroke: true,
        ...style
      };

      if (["Polygon", "MultiPolygon"].includes(municipalBoundaryFeature?.geometry?.type)
        && hasValidExportBoundaryGeometry()) {
        return L.geoJSON(municipalBoundaryFeature, {
          pane: "boundaryPane",
          interactive: false,
          style: () => boundaryStyle
        });
      }

      const fallbackRing = normalizeLatLngRing(getPrimaryMunicipalBoundaryRing());
      // An extent is not a municipal boundary. Leave the outline absent until
      // real geometry is available rather than flashing a rectangular town.
      if (!fallbackRing || fallbackRing.length < 3) return null;
      return L.polygon(fallbackRing, {
        pane: "boundaryPane",
        interactive: false,
        smoothFactor: 0,
        ...boundaryStyle
      });
    }

    function createBoundaryMaskGeometry() {
      const outerWorldRing = [
        [85, -180],
        [85, 180],
        [-85, 180],
        [-85, -180]
      ];
      const innerRings = Array.isArray(municipalBoundaryRings) && municipalBoundaryRings.length
        ? municipalBoundaryRings
        : (FALLBACK_TOWN_MASK_RING.length ? [FALLBACK_TOWN_MASK_RING] : []);
      return [outerWorldRing, ...innerRings];
    }

    function updateBoundaryMaskLayer() {
      if (!map) return;

      if (cityBoundaryMask && map.hasLayer(cityBoundaryMask)) {
        map.removeLayer(cityBoundaryMask);
      }
      cityBoundaryMask = null;
      const geometry = createBoundaryMaskGeometry();
      // Never shade the whole world while the municipal cutout is missing.
      if (!hasValidExportBoundaryGeometry() || geometry.length < 2) return;

      cityBoundaryMask = L.polygon(geometry, {
        pane: "maskPane",
        interactive: false,
        smoothFactor: 0,
        stroke: false,
        fill: true,
        fillColor: "#d7d7d7",
        fillOpacity: 0.62,
        bubblingMouseEvents: false
      }).addTo(map);
    }

    function isTownBoundaryEnabled() {
      return true;
    }

    function applyTownBoundaryVisibility() {
      if (!map || !cityBoundaryOutline) {
        renderLegend();
        return;
      }

      const shouldShow = isTownBoundaryEnabled();
      const hasOutline = map.hasLayer(cityBoundaryOutline);

      if (shouldShow && !hasOutline) {
        cityBoundaryOutline.addTo(map);
      } else if (!shouldShow && hasOutline) {
        map.removeLayer(cityBoundaryOutline);
      }

      renderLegend();
    }

    function updateMunicipalBoundaryLayer() {
      if (!map) return;

      if (cityBoundaryOutline && map.hasLayer(cityBoundaryOutline)) {
        map.removeLayer(cityBoundaryOutline);
      }
      if (cityBoundaryMask && map.hasLayer(cityBoundaryMask)) {
        map.removeLayer(cityBoundaryMask);
        cityBoundaryMask = null;
      }
      if (cityBoundaryGuide && map.hasLayer(cityBoundaryGuide)) {
        map.removeLayer(cityBoundaryGuide);
        cityBoundaryGuide = null;
      }

      updateBoundaryMaskLayer();

      cityBoundaryOutline = makeBoundaryVector({
        color: getComputedStyle(document.documentElement).getPropertyValue("--boundary-color").trim() || "#000000",
        weight: 4.6,
        opacity: 1,
        lineCap: "round",
        lineJoin: "round"
      });
      if (cityBoundaryOutline) cityBoundaryOutline.addTo(map);

      applyTownBoundaryVisibility();
      updateColorBasemapClip();
    }

    async function loadMunicipalBoundary() {
      // The bundled official polygon is ready before the map is constructed.
      // Reuse it without a second request or a visible remove/add cycle.
      if (municipalBoundaryFeature && hasValidExportBoundaryGeometry()) return;
      if (municipalBoundaryLoadPromise) return municipalBoundaryLoadPromise;
      municipalBoundaryLoadPromise = (async () => {
        try {
          const boundary = await fetchMunicipalBoundaryFeature();
          if (!boundary?.feature || !boundary?.rings?.length) {
            throw new Error("Municipal boundary query returned no geometry.");
          }
          if (!seedMunicipalBoundary(boundary.feature)) {
            throw new Error("Municipal boundary query returned invalid geometry.");
          }
        } catch (err) {
          console.warn("Municipal boundary unavailable; retaining any valid municipal geometry.", err);
        }
        updateMunicipalBoundaryLayer();
        // A preview may have created the export map before this request finished.
        // Replace its old outline/mask as soon as authoritative geometry arrives.
        if (exportMap && hasValidExportBoundaryGeometry()) updateExportBoundaryVisibility();
        syncLeftPanelLayout();
      })();
      try { return await municipalBoundaryLoadPromise; }
      finally { municipalBoundaryLoadPromise = null; }
    }

    function hasValidExportBoundaryGeometry() {
      return Array.isArray(municipalBoundaryRings) && municipalBoundaryRings.some(ring =>
        Array.isArray(ring) && ring.length >= 3 && ring.every(point =>
          Array.isArray(point) && point.length >= 2 && point.slice(0, 2).every(Number.isFinite)));
    }

    async function ensureExportMunicipalBoundary() {
      if (!hasValidExportBoundaryGeometry()) await loadMunicipalBoundary();
      throwIfExportCancelled();
      if (!hasValidExportBoundaryGeometry()) {
        throw new Error("The town boundary could not load. Please try the export again.");
      }
    }

    function updateColorBasemapClip() {
      if (!basemapColorLayer || typeof basemapColorLayer.getContainer !== "function") return;
      const container = basemapColorLayer.getContainer();
      if (!container) return;
      container.style.clipPath = "";
      container.style.webkitClipPath = "";
    }

    function getTimelineReservedSpace() {
      const dock = document.getElementById("timelineDock");
      if (!dock) return 132;
      const styles = window.getComputedStyle(dock);
      const bottom = parseFloat(styles.bottom) || 0;
      return Math.ceil(dock.offsetHeight + bottom);
    }

    function syncLeftPanelLayout() {
      if(document.body.hasAttribute("data-floodmapper-unified")) return;
      const panel = document.getElementById("leftPanel");
      if (!panel) return;


      panel.classList.remove("needs-scroll");
      document.body.classList.remove(
        "observed-tight",
        "observed-ultra-tight",
        "observed-fit-tight",
        "observed-fit-ultra",
        "calendar-picker-open"
      );

      if (isCompactFloodmapperLayout()) {
        [
          "left", "right", "top", "bottom", "width", "min-width", "max-width",
          "height", "max-height", "overflow", "overflow-y", "overflow-x",
          "scrollbar-gutter", "gap", "padding", "transform", "transition",
          "animation", "display", "flex-direction", "grid-template-columns"
        ].forEach(prop => panel.style.removeProperty(prop));
        scheduleMapTitleFit();
        return;
      }

      // Desktop pane dimensions are available before first paint in controls.css.
      scheduleMapTitleFit();
    }

    function markInitialFloodFrameReady() {
      if (document.body.dataset.initialFloodFrame === "ready") return;
      document.body.dataset.initialFloodFrame = "ready";
      document.body.dataset.initialFloodFrameReadyAt = performance.now().toFixed(1);
    }

    function markInitialFloodFrameFailed() {
      if (document.body.dataset.initialFloodFrame === "ready") return;
      document.body.dataset.initialFloodFrame = "failed";
      document.body.dataset.initialFloodFrameReadyAt = performance.now().toFixed(1);
    }

    function activateDeferredMapLayers() {
      if (!map || deferredMapLayersStarted) return;
      deferredMapLayersStarted = true;
      document.body.dataset.deferredMapLayers = "active";
      document.body.dataset.deferredMapLayersStartedAt = performance.now().toFixed(1);
      if (basemapColorLayer && !map.hasLayer(basemapColorLayer)) basemapColorLayer.addTo(map);
      if (roadsLayer && !map.hasLayer(roadsLayer)) roadsLayer.addTo(map);
      updateRoadLayerAppearance();
      updateColorBasemapClip();
    }

    function ensureMap() {
      if (map) return;

      map = L.map("map", {
        zoomControl: false,
        minZoom: 11,
        maxZoom: 22,
        zoomSnap: 1,
        zoomDelta: 1,
        preferCanvas: true
      });

      map.createPane("basemapGrayPane");
      map.createPane("basemapColorPane");
      map.createPane("satellitePane");
      map.createPane("boundaryPane");
      map.createPane("floodPane");
      map.createPane("parcelsPane");
      map.createPane("buildingsPane");
      map.createPane("structuresPane");
      map.createPane("roadsPane");
      map.createPane("maskPane");
      map.getPane("basemapGrayPane").style.zIndex = 180;
      map.getPane("basemapColorPane").style.zIndex = 190;
      map.getPane("satellitePane").style.zIndex = 200;
      map.getPane("boundaryPane").style.zIndex = 640;
      map.getPane("floodPane").style.zIndex = 500;
      map.getPane("parcelsPane").style.zIndex = 610;
      map.getPane("buildingsPane").style.zIndex = 620;
      map.getPane("structuresPane").style.zIndex = 625;
      map.getPane("roadsPane").style.zIndex = 710;
      map.getPane("maskPane").style.zIndex = 630;
      map.getPane("popupPane").style.zIndex = 800;

      basemapGrayLayer = null;
      basemapColorLayer = makeEsriBuildingBasemapLayer();

      if (basemapColorLayer) {
        basemapColorLayer.on("error", () => {
          if (basemapColorLayer && map.hasLayer(basemapColorLayer)) {
            map.removeLayer(basemapColorLayer);
          }
          basemapColorLayer = L.tileLayer(FALLBACK_BASEMAP_URL, {
            attribution: "Esri, HERE, Garmin, USGS, &copy; OpenStreetMap contributors",
            minZoom: 11,
            maxZoom: 19,
            subdomains: "abc",
            crossOrigin: true,
            updateWhenIdle: true,
            keepBuffer: 1,
            className: "basemap-color-layer",
            pane: "basemapColorPane"
          });
          if (deferredMapLayersStarted) basemapColorLayer.addTo(map);
        });
      } else {
        basemapColorLayer = L.tileLayer(FALLBACK_BASEMAP_URL, {
          attribution: "Esri, HERE, Garmin, USGS, &copy; OpenStreetMap contributors",
          minZoom: 11,
          maxZoom: 19,
          subdomains: "abc",
          crossOrigin: true,
          updateWhenIdle: true,
          keepBuffer: 1,
          className: "basemap-color-layer",
          pane: "basemapColorPane"
        });
      }

      satelliteLayer = L.tileLayer(ESRI_WORLD_IMAGERY_URL, {
        attribution: "Tiles &copy; Esri",
        minZoom: 11,
        maxNativeZoom: 19,
        maxZoom: map.getMaxZoom(),
        crossOrigin: true,
        updateWhenIdle: true,
        keepBuffer: 1,
        pane: "satellitePane"
      });

      roadsLayer = createRoadLabelLayer(ROAD_LABELS_URL, {
        attribution: "Esri, HERE, Garmin, USGS, &copy; OpenStreetMap contributors",
        minZoom: 11,
        maxNativeZoom: 19,
        maxZoom: 20,
        subdomains: "abcd",
        crossOrigin: true,
        opacity: 0,
        updateWhenIdle: true,
        keepBuffer: 1,
        className: "roads-layer",
        pane: "roadsPane"
      });

      updateMunicipalBoundaryLayer();

      L.control.zoom({ position: "topright" }).addTo(map);
      map.on("zoomend moveend resize", () => {
        updateRoadLayerAppearance();
        updateColorBasemapClip();
      });
      map.on("zoomend", updateParcelBoundaryResolution);
      map.on("click", handleDepthQueryClick);
      updateRoadLayerAppearance();
      updateColorBasemapClip();

      map.fitBounds(getBoundaryDrivenOverlayBounds(false), { padding: [20, 20] });
      requestAnimationFrame(() => {
        map.invalidateSize();
        updateColorBasemapClip();
      });
    }

    function setSatelliteEnabled(enabled) {
      const shouldEnable = Boolean(enabled);
      const toggle = document.getElementById("satelliteToggle");
      if (toggle) {
        toggle.classList.toggle("on", shouldEnable);
        toggle.setAttribute("aria-checked", String(shouldEnable));
      }
      if (!map) ensureMap();
      if (shouldEnable) {
        if (satelliteLayer && !map.hasLayer(satelliteLayer)) satelliteLayer.addTo(map);
      } else if (satelliteLayer && map.hasLayer(satelliteLayer)) {
        map.removeLayer(satelliteLayer);
      }
      updateExportSatelliteLayer();
    }

    function parcelInfoInteractionEnabled() {
      return Boolean(
        document.getElementById("parcelsToggle")?.classList.contains("on") ||
        document.getElementById("buildingsToggle")?.classList.contains("on") ||
        document.getElementById("nsiStructuresToggle")?.classList.contains("on")
      );
    }

    function updateMapClickModeControl() {
      const control = document.getElementById("mapClickModeControl");
      const buildingButton = document.getElementById("mapClickBuildingBtn");
      const parcelButton = document.getElementById("mapClickParcelBtn");
      const depthButton = document.getElementById("mapClickDepthBtn");
      if (!control || !buildingButton || !parcelButton || !depthButton) return;
      control.hidden = !parcelInfoInteractionEnabled();
      const buildingsOn = document.getElementById("buildingsToggle")?.classList.contains("on");
      const structuresOn = document.getElementById("nsiStructuresToggle")?.classList.contains("on");
      buildingButton.hidden = !buildingsOn && !structuresOn;
      buildingButton.textContent = buildingsOn ? "Building Info" : "Structure Info";
      buildingButton.setAttribute("aria-label", buildingButton.textContent);
      parcelButton.hidden = !document.getElementById("parcelsToggle")?.classList.contains("on");
      for (const button of [buildingButton, parcelButton, depthButton]) {
        const active = button.dataset.mapClickMode === mapClickMode;
        button.classList.toggle("active", active);
        button.setAttribute("aria-pressed", String(active));
      }
      if (!control.hidden) requestAnimationFrame(positionMapClickModeControl);
    }

    function positionMapClickModeControl() {
      const control = document.getElementById("mapClickModeControl");
      const title = document.getElementById("mapTitleBadge");
      if (!control || !title || control.hidden) return;
      const titleRect = title.getBoundingClientRect();
      if (!Number.isFinite(titleRect.bottom) || titleRect.height < 2) return;
      control.style.setProperty("--map-click-mode-top", `${Math.ceil(titleRect.bottom + 7)}px`);
      if (isCompactFloodmapperLayout()) {
        const dock = document.getElementById("timelineDock")?.getBoundingClientRect();
        if (dock?.height) control.style.setProperty("--map-click-mode-bottom", `${Math.ceil(innerHeight - dock.top + 10)}px`);
      } else {
        control.style.setProperty("--map-click-mode-left", `${(titleRect.left + titleRect.right) / 2}px`);
        control.style.setProperty("--map-click-mode-width", title.style.maxWidth || `${titleRect.width}px`);
      }
    }

    function setMapClickMode(mode, options = {}) {
      ++mapQueryGeneration;
      mapClickMode = mode === "building" || mode === "parcel" ? mode : "depth";
      updateMapClickModeControl();
      if (options.closePopup !== false && persistentFloodPopup && map?.hasLayer(persistentFloodPopup)) {
        map.removeLayer(persistentFloodPopup);
      }
    }

    function disableBuildingInfo() {
      if (persistentDepthQueryContext?.kind === "building" && map.hasLayer(persistentFloodPopup)) {
        map.removeLayer(persistentFloodPopup);
      }
      if (mapClickMode === "building" && !document.getElementById("nsiStructuresToggle")?.classList.contains("on")) {
        setMapClickMode(document.getElementById("parcelsToggle")?.classList.contains("on") ? "parcel" : "depth");
      } else updateMapClickModeControl();
    }

    async function setBuildingsEnabled(enabled, options = {}) {
      const shouldEnable = Boolean(enabled);
      const toggle = document.getElementById("buildingsToggle");
      if (toggle) {
        toggle.classList.toggle("on", shouldEnable);
        toggle.setAttribute("aria-checked", String(shouldEnable));
      }
      if (!map) ensureMap();
      if (!shouldEnable) {
        if (buildingsLayer && map.hasLayer(buildingsLayer)) map.removeLayer(buildingsLayer);
        updateExportBuildingsLayer();
        disableBuildingInfo();
        toast("");
        return;
      }

      if (!buildingsLayer) {
        buildingsLayer = makeEsriBuildingForegroundLayer("buildingsPane");
        if (!buildingsLayer) throw new Error("The exact building layer is unavailable in this browser.");
        buildingsLayer.on("error", () => {
          setBuildingsEnabled(false, { rollback: true }).catch(() => {});
          toast("The exact building layer could not be loaded.");
        });
      }
      if (!map.hasLayer(buildingsLayer)) buildingsLayer.addTo(map);
      if (!options.preserveClickMode) setMapClickMode("building", { closePopup: false });
      updateExportBuildingsLayer();
      toast("");
      ensureParcelAssets().catch(error => console.warn("Building parcel matching will retry when requested.", error));
    }

    function addRoadLabelHalo(context, width, height, radius) {
      const halo = document.createElement("canvas");
      halo.width = width;
      halo.height = height;
      const haloContext = halo.getContext("2d");
      if (!haloContext) return;
      const mask = context.getImageData(0, 0, width, height);
      for (let index = 0; index < mask.data.length; index += 4) {
        const luminance = mask.data[index] * 0.2126 + mask.data[index + 1] * 0.7152 + mask.data[index + 2] * 0.0722;
        // Outline the dark lettering/edges without thickening light road lines.
        if (luminance >= 128) mask.data[index + 3] = 0;
        mask.data[index] = mask.data[index + 1] = mask.data[index + 2] = 255;
      }
      haloContext.putImageData(mask, 0, 0);
      context.save();
      context.globalCompositeOperation = "destination-over";
      for (let direction = 0; direction < 8; direction += 1) {
        const angle = direction * Math.PI / 4;
        context.drawImage(halo, Math.cos(angle) * radius, Math.sin(angle) * radius);
      }
      context.restore();
    }

    // Bake the label styling into canvas tiles so PNG/GIF captures preserve it.
    function hasRoadLabelRenderer() {
      return typeof window.ShorelyRoadLabels?.createLayer === "function"
        && typeof window.L?.esri?.Vector?.vectorTileLayer === "function";
    }

    // The live map keeps its soft gray style; exports can use stronger contrast.
    function createRoadLabelLayer(url, options) {
      if (!hasRoadLabelRenderer()) return null;
      return window.ShorelyRoadLabels.createLayer({
        ...options,
        exportMode: Number(options?.minZoom) === 0,
        includeNames: Number(options?.minZoom) !== 0 || (TOWN_CONFIG.assets?.exportRoadFallback === true &&
          !window.NORTH_WILDWOOD_EXPORT_ROADS?.hasLocalNames?.())
      });
    }

    function updateRoadLayerAppearance({ retry3dRoads: retryRoadLabels = false } = {}) {
      if (!map || !roadsLayer) return;

      const toggle = document.getElementById("roadsToggle");
      const roadsEnabled = !toggle || toggle.classList.contains("on");
      const zoom = map.getZoom() || 0;
      const showLabels = roadsEnabled && zoom >= ROAD_LABEL_ZOOM;

      roadsLayer.setOpacity(showLabels ? 0.98 : 0);

      const pane = map.getPane("roadsPane");
      if (pane) pane.classList.toggle("roads-dark", showLabels);

      // Only an explicit enable from the Road Names switch retries a failed renderer.
      if (retryRoadLabels && roadsEnabled && map.hasLayer(roadsLayer)) {
        roadsLayer.whenReady({ retry: true }).catch(() => {});
      }
    }

