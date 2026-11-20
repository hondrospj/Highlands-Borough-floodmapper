    function getSelectedStageNavd88() {
      const committedStage = currentFloodLayer?._floodmapperFrame?.stage;
      if (Number.isFinite(committedStage)) return committedStage;
      const entry = currentSeriesHours[currentHourIndex];
      const stage = normalizeStageValue(getStageValue(entry));
      return Number.isFinite(stage) ? stage : null;
    }

    function finiteStructureNumber(value) {
      if (value == null || String(value).trim() === "") return null;
      const number = Number(value);
      return Number.isFinite(number) ? number : null;
    }

    function getNsiFirstOccupiedFloorNavd88(properties) {
      const p = properties || {};
      const localGround = finiteStructureNumber(p.localGroundNavd88Ft ?? p.nsi2026LocalGroundNavd88Ft);
      const riseToOccupiedFloor = finiteStructureNumber(p.foundationHeightFt ?? p.nsi2026FoundationHeightFt);
      if (localGround != null && riseToOccupiedFloor != null) {
        return localGround + Math.max(0, riseToOccupiedFloor);
      }
      return finiteStructureNumber(p.modeledFirstFloorNavd88Ft ?? p.nsi2026ModeledFirstFloorNavd88Ft);
    }

    function getNsiStructureImpactStyle(properties, stage = getSelectedStageNavd88()) {
      const firstFloor = getNsiFirstOccupiedFloorNavd88(properties);
      if (!Number.isFinite(firstFloor) || !Number.isFinite(stage)) {
        return { radius: 2.7, color: "#94a3b8", weight: 0.7, opacity: 0.8, fillColor: "#64748b", fillOpacity: 0.42 };
      }
      const waterAboveFloor = stage - firstFloor;
      if (waterAboveFloor > 0.1) {
        return { radius: 4.3, color: "#fff1f2", weight: 1.1, opacity: 0.95, fillColor: "#fb7185", fillOpacity: 0.95 };
      }
      if (waterAboveFloor >= -0.5) {
        return { radius: 3.6, color: "#fff7d6", weight: 1.0, opacity: 0.95, fillColor: "#fbbf24", fillOpacity: 0.88 };
      }
      return { radius: 2.7, color: "#d9fdff", weight: 0.7, opacity: 0.72, fillColor: "#22d3ee", fillOpacity: 0.48 };
    }

    function formatNsiImpactStatus(properties, stage = getSelectedStageNavd88()) {
      const firstFloor = getNsiFirstOccupiedFloorNavd88(properties);
      if (!Number.isFinite(firstFloor) || !Number.isFinite(stage)) return "Choose a water level to compare.";
      const difference = stage - firstFloor;
      if (difference > 0.1) return `Current water is ${formatWaterDepth(difference, 1)} above the occupied first floor.`;
      if (difference >= -0.1) return "Current water is at the occupied first floor.";
      return `Current water is ${formatWaterDepth(Math.abs(difference), 1)} below the occupied first floor.`;
    }

    function buildNsiStructurePopup(feature) {
      const p = feature?.properties || {};
      const firstFloor = getNsiFirstOccupiedFloorNavd88(p);
      const address = escapeTownAddressHtml(p.address || `Modeled ${TOWN_CONFIG.site.name} structure`);
      return '<div class="nsi-structure-popup">' +
        '<details class="property-help"><summary aria-label="About the first-floor estimate">?</summary>' +
          '<p>This compares the selected water level with the estimated occupied floor.</p></details>' +
        '<span class="house-alert-kicker">Estimated First-Floor Flooding</span>' +
        '<h3>' + address + '</h3>' +
        '<div class="nsi-impact-status">' + escapeTownAddressHtml(formatNsiImpactStatus(p)) + '</div>' +
        '<div class="nsi-structure-grid">' +
          '<span>Occupied First-Floor Elevation</span><strong>' + (Number.isFinite(firstFloor) ? firstFloor.toFixed(1) + ' ft NAVD88' : '—') + '</strong>' +
        '</div>' +
        '<div class="house-alert-note">Estimate</div>' +
        '</div>';
    }

    function openNsiStructurePopup(feature, latlng) {
      const popup = openPersistentFloodPopup(latlng, buildNsiStructurePopup(feature), 360);
      persistentDepthQueryContext = { popup, kind: "structure", feature };
      return popup;
    }

    function updateNsiStructureImpactLayer() {
      if (!nsiStructuresLayer) return;
      const stage = getSelectedStageNavd88();
      nsiStructuresLayer.eachLayer(layer => {
        if (layer?.feature?.properties && typeof layer.setStyle === "function") {
          layer.setStyle(getNsiStructureImpactStyle(layer.feature.properties, stage));
        }
      });
    }

    function findNsiStructureFeatureForLocation(lat, lon, maximumDistanceMeters = 24) {
      let nearest = null;
      let nearestDistance = Infinity;
      const longitudeScale = Math.cos(Number(lat) * Math.PI / 180);
      nsiStructureFeatures.forEach(feature => {
        const coordinates = feature?.geometry?.coordinates || [];
        const dLat = Number(coordinates[1]) - Number(lat);
        const dLon = (Number(coordinates[0]) - Number(lon)) * longitudeScale;
        const meters = Math.hypot(dLat, dLon) * 111320;
        if (Number.isFinite(meters) && meters < nearestDistance) {
          nearestDistance = meters;
          nearest = feature;
        }
      });
      return nearestDistance <= maximumDistanceMeters ? nearest : null;
    }

    async function ensureNsiStructureAssets() {
      if (nsiStructuresLayer) return nsiStructuresLayer;
      if (!NSI_STRUCTURES_URL) throw new Error("USACE NSI 2026 structures are not configured.");
      if (!nsiStructureLoadPromise) {
        nsiStructureLoadPromise = fetchJson(NSI_STRUCTURES_URL, { cache: "force-cache" })
          .then(payload => {
            const schema = String(payload?.metadata?.schema || "");
            const configuredStructureSchema = TOWN_CONFIG.structures?.firstFloorAssetSchema;
            const townStructures = configuredStructureSchema && schema === configuredStructureSchema &&
              payload.type === "FeatureCollection" && Array.isArray(payload.features);
            if (!/nsi-2026-first-floor-v1$/.test(schema) && !townStructures) {
              throw new Error("The USACE NSI 2026 structure asset needs to be refreshed.");
            }
            nsiStructureFeatures = Array.isArray(payload.features) ? payload.features : [];
            nsiStructureRenderer = nsiStructureRenderer || L.canvas({ pane: "structuresPane", padding: 0.5, tolerance: 7 });
            nsiStructuresLayer = L.geoJSON(payload, {
              pane: "structuresPane",
              renderer: nsiStructureRenderer,
              pointToLayer: (feature, latlng) => L.circleMarker(latlng, {
                ...getNsiStructureImpactStyle(feature?.properties),
                pane: "structuresPane",
                renderer: nsiStructureRenderer,
                bubblingMouseEvents: false,
                interactive: true
              }),
              onEachFeature: (feature, layer) => {
                layer.on("click", event => {
                  if (mapClickMode !== "building") {
                    handleDepthQueryClick(event);
                    return;
                  }
                  if (event?.originalEvent) event.originalEvent._parcelHandled = true;
                  beginMapQuery();
                  openNsiStructurePopup(feature, event.latlng);
                });
              }
            });
            return nsiStructuresLayer;
          })
          .catch(error => {
            nsiStructureLoadPromise = null;
            throw error;
          });
      }
      return nsiStructureLoadPromise;
    }

    async function setNsiStructuresEnabled(enabled) {
      const generation = ++nsiLayerGeneration;
      const shouldEnable = Boolean(enabled);
      const toggle = document.getElementById("nsiStructuresToggle");
      if (toggle) {
        toggle.classList.toggle("on", shouldEnable);
        toggle.setAttribute("aria-checked", String(shouldEnable));
      }
      if (!map) ensureMap();
      const key = document.getElementById("structuralImpactsKey");
      if (!shouldEnable) {
        if (key) key.hidden = true;
        if (nsiStructuresLayer && map.hasLayer(nsiStructuresLayer)) map.removeLayer(nsiStructuresLayer);
        if (persistentDepthQueryContext?.kind === "structure" && map.hasLayer(persistentFloodPopup)) {
          map.removeLayer(persistentFloodPopup);
        }
        if (mapClickMode === "building" && !document.getElementById("buildingsToggle")?.classList.contains("on")) {
          setMapClickMode(document.getElementById("parcelsToggle")?.classList.contains("on") ? "parcel" : "depth");
        } else updateMapClickModeControl();
        toast("");
        return;
      }
      // Choose the layer's default interaction when it is requested. A later
      // explicit depth choice must survive the asynchronous asset completion.
      setMapClickMode("building", { closePopup: false });
      let layer;
      try {
        layer = await ensureNsiStructureAssets();
      } catch (error) {
        if (generation !== nsiLayerGeneration) return;
        throw error;
      }
      if (generation !== nsiLayerGeneration) return;
      updateNsiStructureImpactLayer();
      if (!map.hasLayer(layer)) layer.addTo(map);
      if (key) key.hidden = false;
    }

    async function ensureParcelAssets() {
      // Parcel matching needs only metadata. Keep it available even when the
      // independent boundary image fails, and reuse it for an image retry.
      if (!parcelLoadPromise) {
        parcelLoadPromise = fetchJson(PARCELS_URL, { cache: "force-cache" })
          .then(geojson => {
            parcelFeatures = Array.isArray(geojson?.features) ? geojson.features : [];
          }).catch(err => {
            parcelLoadPromise = null;
            throw err;
          });
      }
      await parcelLoadPromise;
      if (!parcelsLayer) {
        parcelsLayer = createHydraulicImageOverlay(PARCEL_BOUNDARY_PNG_URL, {
          pane: "parcelsPane",
          opacity: 0.78,
          interactive: false,
          crossOrigin: true,
          zIndex: 610
        });
      }
      return parcelsLayer;
    }

    function loadParcelBoundaryLayer(layer) {
      if (!layer._floodmapperParcelLoadPromise) {
        layer._floodmapperParcelLoadPromise = new Promise((resolve, reject) => {
          let settled = false;
          const finish = error => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            layer.off("load", loaded);
            layer.off("error", failed);
            if (error) {
              if (map.hasLayer(layer)) map.removeLayer(layer);
              const image = layer.getElement?.();
              if (image) { try { image.src = ""; } catch (_) {} }
              // A late error from a retired image cannot evict its replacement.
              if (parcelsLayer === layer) parcelsLayer = null;
              reject(error);
            } else resolve(layer);
          };
          const failed = () => finish(new Error("Parcels could not be loaded. Please try again."));
          const loaded = async () => {
            const image = layer.getElement?.();
            if (!image?.naturalWidth || !image?.naturalHeight) { failed(); return; }
            try {
              if (typeof image.decode === "function") await image.decode();
              finish();
            } catch (_) { failed(); }
          };
          const timer = window.setTimeout(() => finish(new Error("Parcels took too long to load. Please try again.")), 20000);
          layer.on("load", loaded);
          layer.on("error", failed);
        });
      }
      if (!map.hasLayer(layer)) layer.addTo(map);
      return layer._floodmapperParcelLoadPromise;
    }

    function updateParcelBoundaryResolution() {
      const layer = parcelsLayer;
      if (!layer || !map?.hasLayer(layer) || !Number.isFinite(map.getZoom?.())) return;
      const detailed = map.getZoom() >= 17 && parcelFeatures.length > 0;
      if (detailed && !layer._parcelVector) {
        layer._parcelVector = L.geoJSON({ type: "FeatureCollection", features: parcelFeatures }, {
          pane: "parcelsPane",
          renderer: L.canvas({ pane: "parcelsPane" }),
          style: { color: "#ef4444", weight: 1.15, opacity: 0.72, fill: false },
          interactive: false
        });
      }
      const vector = layer._parcelVector;
      if (detailed && vector && !map.hasLayer(vector)) vector.addTo(map);
      if (!detailed && vector && map.hasLayer(vector)) map.removeLayer(vector);
      layer.setOpacity(detailed ? 0 : 0.78);
    }

    async function setParcelsEnabled(enabled) {
      const generation = ++parcelLayerGeneration;
      const shouldEnable = Boolean(enabled);
      const toggle = document.getElementById("parcelsToggle");
      if (toggle) {
        toggle.classList.toggle("on", shouldEnable);
        toggle.setAttribute("aria-checked", String(shouldEnable));
      }
      if (!map) ensureMap();
      if (!shouldEnable) {
        const vector = parcelsLayer?._parcelVector;
        if (vector && map.hasLayer(vector)) map.removeLayer(vector);
        if (parcelsLayer && map.hasLayer(parcelsLayer)) map.removeLayer(parcelsLayer);
        if (persistentDepthQueryContext?.kind === "parcel" && map.hasLayer(persistentFloodPopup)) {
          map.removeLayer(persistentFloodPopup);
        }
        if (mapClickMode === "parcel") {
          const buildingModeAvailable = document.getElementById("buildingsToggle")?.classList.contains("on") ||
            document.getElementById("nsiStructuresToggle")?.classList.contains("on");
          setMapClickMode(buildingModeAvailable ? "building" : "depth");
        } else updateMapClickModeControl();
        toast("");
        return;
      }
      setMapClickMode("parcel", { closePopup: false });
      let layer;
      try {
        layer = await ensureParcelAssets();
        if (generation !== parcelLayerGeneration) return;
        await loadParcelBoundaryLayer(layer);
      } catch (error) {
        if (generation !== parcelLayerGeneration) return;
        throw error;
      }
      if (generation !== parcelLayerGeneration) return;
      updateParcelBoundaryResolution();
      toast("");
    }

    function pointInRing(lon, lat, ring) {
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = Number(ring[i]?.[0]), yi = Number(ring[i]?.[1]);
        const xj = Number(ring[j]?.[0]), yj = Number(ring[j]?.[1]);
        const intersects = ((yi > lat) !== (yj > lat)) && (lon < ((xj - xi) * (lat - yi)) / ((yj - yi) || Number.EPSILON) + xi);
        if (intersects) inside = !inside;
      }
      return inside;
    }

    function pointInParcelFeature(feature, lat, lon) {
      const geometry = feature?.geometry;
      if (!geometry) return false;
      const polygons = geometry.type === "Polygon" ? [geometry.coordinates] :
        (geometry.type === "MultiPolygon" ? geometry.coordinates : []);
      return polygons.some(rings => {
        if (!Array.isArray(rings?.[0]) || !pointInRing(lon, lat, rings[0])) return false;
        return !rings.slice(1).some(hole => pointInRing(lon, lat, hole));
      });
    }

    function getParcelRasterRows(feature, width, height) {
      const geometry = feature?.geometry;
      const polygons = geometry?.type === "Polygon" ? [geometry.coordinates] :
        (geometry?.type === "MultiPolygon" ? geometry.coordinates : []);
      const project = ([lon, lat]) => latLngToWorldFileUv(lat, lon);
      const rows = new Map();
      let total = 0;
      for (const polygon of polygons) {
        const rings = polygon.map(ring => ring.map(project));
        const points = rings.flat();
        if (!points.length || points.some(point => !point)) continue;
        const minY = Math.min(...points.map(point => point.v * height));
        const maxY = Math.max(...points.map(point => point.v * height));
        for (let y = Math.ceil(minY - 0.5); y < maxY - 0.5; y += 1) {
          const crossing = [];
          const center = (y + 0.5) / height;
          for (const ring of rings) {
            for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
              const a = ring[j], b = ring[i];
              if ((a.v > center) === (b.v > center)) continue;
              crossing.push((a.u + (center - a.v) * (b.u - a.u) / (b.v - a.v)) * width);
            }
          }
          crossing.sort((a, b) => a - b);
          for (let i = 0; i + 1 < crossing.length; i += 2) {
            const start = Math.ceil(crossing[i] - 0.5);
            const end = Math.ceil(crossing[i + 1] - 0.5);
            if (end <= start) continue;
            total += end - start;
            if (y < 0 || y >= height || end <= 0 || start >= width) continue;
            const spans = rows.get(y) || [];
            spans.push([Math.max(0, start), Math.min(width, end)]);
            rows.set(y, spans);
          }
        }
      }
      return { rows, total, width, height };
    }

    function measureParcelFloodPixels(footprint, grid, context) {
      let covered = 0, wet = 0, deepest = -1, unresolvedDepth = false;
      for (const [y, spans] of footprint.rows) {
        for (const [start, end] of spans) {
          const colors = context.getImageData(start, y, end - start, 1).data;
          for (let x = start; x < end; x += 1) {
            const offset = (y * grid.width + x) * 4;
            if (!(grid.values[offset] || grid.values[offset + 1])) continue;
            covered += 1;
            const colorOffset = (x - start) * 4;
            if (!isWetRasterPixel(colors, colorOffset)) continue;
            wet += 1;
            const band = DRAINAGE_DEPTH_COLORS.findIndex(color =>
              color.every((channel, index) => Math.abs(channel - colors[colorOffset + index]) <= 3));
            if (band < 0) unresolvedDepth = true;
            deepest = Math.max(deepest, band);
          }
        }
      }
      return { total: footprint.total, covered, wet, deepest, unresolvedDepth };
    }

    function formatParcelDepthBand(metrics) {
      if (!metrics.wet) return "Dry";
      if (metrics.deepest < 0) return "Depth unavailable";
      const low = metrics.deepest ? DRAINAGE_DEPTH_BREAKS_FT[metrics.deepest - 1] : 0;
      const high = DRAINAGE_DEPTH_BREAKS_FT[metrics.deepest];
      if (metrics.unresolvedDepth) return low > 0 ? `≥${low} ft` : "Depth varies";
      return Number.isFinite(high) ? `${low}–${high} ft` : `≥${low} ft`;
    }

    function buildParcelAreaPopup(feature, metrics, loading) {
      const address = escapeTownAddressHtml(feature?.properties?.address || `Selected ${TOWN_CONFIG.site.name} parcel`);
      const facts = metrics?.covered
        ? `<div class="parcel-flood-facts">
            <div><span>${metrics.covered === metrics.total ? "Flooded Area" : "Covered Area Flooded"}</span>
            <strong>${(100 * metrics.wet / metrics.covered).toFixed(1)}%</strong></div>
            <div><span>Maximum Flood Depth</span><strong>${formatParcelDepthBand(metrics)}</strong></div>
          </div>${metrics.covered === metrics.total ? "" : `<p class="house-alert-note">${Math.round(100 * metrics.covered / metrics.total)}% of this parcel has model coverage.</p>`}`
        : `<p class="house-alert-note" role="status">${loading ? "" : "Parcel depth and area are unavailable for this frame."}</p>`;
      return '<div class="house-alert-popup building-info-card parcel-area-popup">' +
        '<span class="house-alert-kicker">Parcel Flooding</span><h3>' + address + '</h3>' + facts +
        '<button class="house-alert-cta" data-property-profile="parcel" type="button">See Parcel Flood Projections</button></div>';
    }

    function openParcelAreaPopup(feature, latlng) {
      selectedParcelFeature = feature;
      const popup = openPersistentFloodPopup(latlng, buildParcelAreaPopup(feature, null, true), 460);
      persistentDepthQueryContext = { popup, kind: "parcel", feature };
      updatePersistentDepthQueryPopup();
      return popup;
    }

    async function refreshParcelFloodPopup(context) {
      const layer = currentFloodLayer;
      const frame = layer?._floodmapperFrame;
      if (context.layer === layer) {
        if (context.html) updatePropertyPopup(context.popup, context.html);
        return;
      }
      context.layer = layer;
      context.html = null;
      const isCurrent = () => persistentDepthQueryContext === context && currentFloodLayer === layer &&
        map?.hasLayer(context.popup);
      let metrics = null;
      try {
        if (frame && layer._worldFileAffine) {
          const image = frame.overlayMode === "depth"
            ? layer.getElement()
            : await getHydraulicOverlayRecord("depth", frame.overlayStage, frame.phase, frame.entry, frame.series)
              .then(record => getDrainageRasterImage(record?.url));
          const grid = await getDepthQueryGrid();
          if (!isCurrent()) return;
          if (image && grid && image.naturalWidth === grid.width && image.naturalHeight === grid.height) {
            if (!context.footprint || context.footprint.width !== grid.width || context.footprint.height !== grid.height) {
              context.footprint = getParcelRasterRows(context.feature, grid.width, grid.height);
            }
            const canvas = document.createElement("canvas");
            // Only read the parcel's rows. The decoded frame is already in memory.
            canvas.width = grid.width;
            canvas.height = 1;
            const pixels = canvas.getContext("2d", { willReadFrequently: true });
            if (pixels) {
              metrics = measureParcelFloodPixels(context.footprint, grid, {
                getImageData(start, y, width) {
                  pixels.clearRect(0, 0, width, 1);
                  pixels.drawImage(image, start, y, width, 1, 0, 0, width, 1);
                  return pixels.getImageData(0, 0, width, 1);
                }
              });
            }
          }
        }
      } catch (error) {
        console.warn("Parcel depth and area are unavailable.", error);
        if (context.layer === layer) delete context.layer;
      }
      if (isCurrent()) {
        context.html = buildParcelAreaPopup(context.feature, metrics, false);
        updatePropertyPopup(context.popup, context.html);
      }
    }

    async function findParcelFeatureForLocation(lat, lon, options = {}) {
      await ensureParcelAssets();
      const features = options.matchesFeature ? parcelFeatures.filter(options.matchesFeature) : parcelFeatures;
      const containing = features.find(feature => pointInParcelFeature(feature, lat, lon));
      if (containing) return containing;
      if (options.allowNearest === false) return null;
      let nearest = null;
      let nearestDistance = Infinity;
      features.forEach(feature => {
        const p = feature?.properties || {};
        const dLat = Number(p.centroidLat) - lat;
        const dLon = (Number(p.centroidLon) - lon) * Math.cos(lat * Math.PI / 180);
        const meters = Math.hypot(dLat, dLon) * 111320;
        if (Number.isFinite(meters) && meters < nearestDistance) {
          nearestDistance = meters;
          nearest = feature;
        }
      });
      return nearestDistance <= 90 ? nearest : null;
    }

