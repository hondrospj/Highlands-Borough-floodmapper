(function () {
  "use strict";

  const EMPTY = { type: "FeatureCollection", features: [] };
  const COLOR = "#ef4444";
  const ROAD_STEP_METERS = 5;
  const MIN_DEPTH_FT = 0.5;
  let enabled = false;
  let revision = 0;
  let dataVersion = 0;
  let roadPromise = null;
  let roadLines = null;
  let renderedData = EMPTY;
  let leafletLayer = null;
  let glInstance = null;
  let glDataVersion = -1;
  const toggle = document.getElementById("roadImpactsToggle");

  function setStatus(message) {
    const status = document.getElementById("roadImpactsStatus");
    if (status) status.textContent = message;
  }

  function densifyRoad(coordinates) {
    const output = [coordinates[0]];
    for (let index = 1; index < coordinates.length; index += 1) {
      const a = coordinates[index - 1], b = coordinates[index];
      const meters = Math.hypot((b[0] - a[0]) * Math.cos((a[1] + b[1]) * Math.PI / 360), b[1] - a[1]) * 111320;
      const steps = Math.max(1, Math.ceil(meters / ROAD_STEP_METERS));
      for (let step = 1; step <= steps; step += 1) {
        const t = step / steps;
        output.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
    return output;
  }

  async function loadRoads() {
    if (roadLines) return roadLines;
    if (!roadPromise) {
      const url = new URL("./assets/highlands-data/roads.geojson", APP_BASE);
      roadPromise = fetch(url.href, { cache: "force-cache" }).then(response => {
        if (!response.ok) throw new Error("Road Impacts data could not be loaded.");
        return response.json();
      }).then(collection => {
        if (!Array.isArray(collection.features) || !collection.features.length) throw new Error("Road Impacts data is unavailable.");
        roadLines = collection.features.filter(feature => feature.geometry?.type === "LineString" && feature.geometry.coordinates.length > 1)
          .map(feature => ({ properties: feature.properties, coordinates: densifyRoad(feature.geometry.coordinates) }));
        return roadLines;
      }).catch(error => { roadPromise = null; throw error; });
    }
    return roadPromise;
  }

  function syncLayers() {
    const gl = window.NORTH_WILDWOOD_3D?.getMap?.();
    const useGl = Boolean(gl && document.body.classList.contains("map-3d-ready"));
    if (map && leafletLayer && map.hasLayer(leafletLayer)) map.removeLayer(leafletLayer);
    if (map && enabled && !useGl && renderedData.features.length) {
      if (!map.getPane("roadImpactsPane")) {
        map.createPane("roadImpactsPane");
        map.getPane("roadImpactsPane").style.zIndex = "705";
        map.getPane("roadImpactsPane").style.pointerEvents = "none";
      }
      if (!leafletLayer) {
        leafletLayer = L.geoJSON(renderedData, {
          pane: "roadImpactsPane", interactive: false,
          renderer: L.canvas({ pane: "roadImpactsPane", padding: 0.5 }),
          style: { color: COLOR, weight: 4, opacity: 1, lineCap: "round", lineJoin: "round" }
        });
      }
      leafletLayer.addTo(map);
    }
    if (!useGl) return;
    if (glInstance !== gl) { glInstance = gl; glDataVersion = -1; }
    if (!enabled && !gl.getSource("nw-road-impacts-source")) return;
    if (!gl.getSource("nw-road-impacts-source")) {
      gl.addSource("nw-road-impacts-source", { type: "geojson", data: renderedData });
      const before = gl.getLayer("nw-boundary-mask") ? "nw-boundary-mask" : undefined;
      gl.addLayer({
        id: "nw-road-impacts-halo", type: "line", source: "nw-road-impacts-source",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 11, 3, 16, 6, 20, 9], "line-opacity": 0.85 }
      }, before);
      gl.addLayer({
        id: "nw-road-impacts", type: "line", source: "nw-road-impacts-source",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": COLOR, "line-width": ["interpolate", ["linear"], ["zoom"], 11, 1.5, 16, 4, 20, 7] }
      }, before);
    }
    if (glDataVersion !== dataVersion) {
      gl.getSource("nw-road-impacts-source").setData(renderedData);
      glDataVersion = dataVersion;
    }
    ["nw-road-impacts", "nw-road-impacts-halo"].forEach(id => gl.setLayoutProperty(id, "visibility", enabled ? "visible" : "none"));
  }

  function publishData(collection) {
    renderedData = collection;
    dataVersion += 1;
    if (leafletLayer) { leafletLayer.clearLayers(); leafletLayer.addData(collection); }
    document.body.dataset.roadImpactsSections = String(collection.features.length);
    syncLayers();
  }

  function invalidate() {
    revision += 1;
    publishData(EMPTY);
    document.body.dataset.roadImpactsState = enabled ? "loading" : "disabled";
    if (enabled) setStatus("Updating road impacts…");
  }

  function readRaster(image) {
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(image, 0, 0);
    const values = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const width = canvas.width, height = canvas.height;
    canvas.width = canvas.height = 0;
    return { values, width, height };
  }

  function wetSampler(image, layer) {
    const { values, width, height } = readRaster(image);
    const bounds = layer.getBounds?.() || floodLatLngBounds;
    return coordinate => {
      const lat = coordinate[1], lon = coordinate[0];
      const pixel = layer._worldFileAffine
        ? latLngToWorldFilePixel(lat, lon, width, height)
        : { x: Math.floor((lon - bounds.getWest()) / (bounds.getEast() - bounds.getWest()) * width),
            y: Math.floor((bounds.getNorth() - lat) / (bounds.getNorth() - bounds.getSouth()) * height) };
      if (!pixel || pixel.x < 0 || pixel.y < 0 || pixel.x >= width || pixel.y >= height) return false;
      return isWetRasterPixel(values, (pixel.y * width + pixel.x) * 4, getUncertaintyRasterColor());
    };
  }

  async function depthSampler(entry, stage, phase) {
    const grid = await getHydraulicQueryGrid();
    const bounds = currentFloodLayer?.getBounds?.() || floodLatLngBounds;
    const water = getPenalizedWaterSurfaceStage(stage, phase);
    return coordinate => {
      const x = Math.floor((coordinate[0]-bounds.getWest())/(bounds.getEast()-bounds.getWest())*grid.width);
      const y = Math.floor((bounds.getNorth()-coordinate[1])/(bounds.getNorth()-bounds.getSouth())*grid.height);
      if(x<0||y<0||x>=grid.width||y>=grid.height)return false;
      const i=(y*grid.width+x)*4, encoded=grid.values[i]*256+grid.values[i+1];
      if(!encoded||grid.values[i+2]===255)return false;
      return water-(encoded-32768)/10 > MIN_DEPTH_FT+1e-9;
    };
  }

  async function refresh() {
    if (!enabled) return;
    const request = ++revision;
    const frameToken = lastRenderToken;
    const entry = currentSeriesHours[currentHourIndex];
    const stage = getSelectedStageNavd88();
    const phase = getHydraulicPhaseForEntry(entry, currentHourIndex, currentSeriesHours);
    const layer = currentFloodLayer;
    const image = layer?.getElement?.();
    if (document.body.dataset.floodFrameRecovery !== "ready" || !image?.complete || !image.naturalWidth) {
      publishData(EMPTY);
      setStatus("Road impacts unavailable for this time.");
      document.body.dataset.roadImpactsState = "unavailable";
      return;
    }
    setStatus("Loading road impacts…");
    try {
      const roads = await loadRoads();
      if (!enabled || request !== revision || frameToken !== lastRenderToken) return;
      const isWet = wetSampler(image, layer);
      const exceedsDepth = await depthSampler(entry, stage, phase);
      if (!enabled || request !== revision || frameToken !== lastRenderToken) return;
      const features = [];
      for (let roadIndex = 0; roadIndex < roads.length; roadIndex += 1) {
        if (roadIndex % 30 === 0) {
          await new Promise(resolve => requestAnimationFrame(resolve));
          if (!enabled || request !== revision || frameToken !== lastRenderToken) return;
        }
        const road = roads[roadIndex];
        let run = [];
        const finish = () => {
          if (run.length > 1) features.push({ type: "Feature", properties: road.properties, geometry: { type: "LineString", coordinates: run } });
          run = [];
        };
        for (let index = 1; index < road.coordinates.length; index += 1) {
          const a = road.coordinates[index - 1], b = road.coordinates[index];
          const midpoint = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
          if (isWet(midpoint) && await exceedsDepth(midpoint)) { if (!run.length) run.push(a); run.push(b); }
          else finish();
        }
        finish();
      }
      if (!enabled || request !== revision || frameToken !== lastRenderToken) return;
      publishData({ type: "FeatureCollection", features });
      setStatus(features.length ? "Modeled road water depth > 0.5 ft" : "No road sections above 0.5 ft at this time.");
      document.body.dataset.roadImpactsState = "ready";
    } catch (error) {
      if (!enabled || request !== revision) return;
      publishData(EMPTY);
      setStatus("Road impacts unavailable. Toggle off/on to retry.");
      document.body.dataset.roadImpactsState = "failed";
      console.warn("Road Impacts could not load.", error);
    }
  }

  function setEnabled(value) {
    enabled = Boolean(value);
    toggle?.classList.toggle("on", enabled);
    toggle?.setAttribute("aria-checked", String(enabled));
    const key = document.getElementById("roadImpactsKey");
    if (key) key.hidden = !enabled;
    document.body.dataset.roadImpactsEnabled = String(enabled);
    invalidate();
    if (enabled) return refresh();
  }

  toggle?.addEventListener("click", () => setEnabled(!enabled));
  toggle?.addEventListener("keydown", event => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setEnabled(!enabled); }
  });

  const originalClearFloodLayer = clearFloodLayer;
  clearFloodLayer = function () { invalidate(); return originalClearFloodLayer.apply(this, arguments); };
  const originalRenderHour = renderHour;
  renderHour = async function () {
    const pending = originalRenderHour.apply(this, arguments);
    const frameToken = lastRenderToken;
    const result = await pending;
    if (enabled && frameToken === lastRenderToken) await refresh();
    return result;
  };
  new MutationObserver(syncLayers).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  // Reset the toggle, key, and overlays together on every fresh load.
  setEnabled(false);
  window.addEventListener("pageshow", event => {
    // Back/forward navigation can restore an already-enabled page from memory.
    if (event.persisted) setEnabled(false);
  });
  window.NORTH_WILDWOOD_ROAD_IMPACTS = {
    setEnabled, refresh,
    state: () => ({ enabled, sections: renderedData.features.length, data: renderedData })
  };
})();
