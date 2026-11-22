/* Optional ground contours. Elevations stay in feet NAVD88 in either water-level datum. */
(() => {
  "use strict";

  const contourPath = TOWN_CONFIG.assets?.elevationContoursPath;
  if (!contourPath) return;
  const template = document.getElementById("elevationContoursTemplate");
  const layerList = document.querySelector(".layers-card .layer-list");
  if (!template || !layerList) return;
  layerList.appendChild(template.content.cloneNode(true));
  const toggle = document.getElementById("contoursToggle");
  const status = document.getElementById("contoursStatus");
  if (!toggle || toggle.dataset.contoursBound === "true") return;
  toggle.dataset.contoursBound = "true";
  template.remove();

  const paneName = "highlandsContourPane";
  const labelPaneName = "highlandsContourLabelPane";
  const projection = "+proj=tmerc +lat_0=38.8333333333333 +lon_0=-74.5 +k=0.9999 +x_0=150000 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=us-ft +no_defs +type=crs";
  let enabled = false;
  let generation = 0;
  let loading = null;
  let contourLayer = null;
  let labels = null;
  let mapInstance = null;
  let indexLines = [];
  let contourData = null;
  let glLabels = [];
  const waitingMaps = new WeakSet();
  const glSourceId = "highlands-contours-source";
  const glLayerIds = ["highlands-contours-halo", "highlands-contours-lines"];

  function getMapLibre() {
    return document.body.classList.contains("map-3d-ready")
      ? window.NORTH_WILDWOOD_3D?.getMap?.() : null;
  }

  function syncMapLibre(gl = getMapLibre(), refresh = true) {
    if (!gl) { if (refresh) refreshLabels(); return; }
    if (!gl.getSource(glSourceId) && !gl.isStyleLoaded()) {
      if (enabled && contourData && !waitingMaps.has(gl)) {
        waitingMaps.add(gl);
        gl.once("idle", () => {
          waitingMaps.delete(gl);
          if (gl === getMapLibre()) syncMapLibre(gl);
        });
      }
      if (refresh) refreshLabels();
      return;
    }
    if (enabled && contourData && !gl.getSource(glSourceId)) {
      gl.addSource(glSourceId, { type: "geojson", data: contourData });
    }
    if (gl.getSource(glSourceId)) {
      for (const [id, color, opacity, indexWidth, width] of [
        [glLayerIds[0], "#ffffff", 0.78, 3.5, 2.4],
        [glLayerIds[1], "#765025", 0.92, 1.7, 0.85]
      ]) {
        if (!gl.getLayer(id)) gl.addLayer({
          id, type: "line", source: glSourceId,
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": color, "line-opacity": opacity,
            "line-width": ["case", ["get", "isIndex"], indexWidth, width] }
        }, gl.getLayer("nw-boundary-mask") ? "nw-boundary-mask" : undefined);
        const visibility = enabled ? "visible" : "none";
        if (gl.getLayoutProperty(id, "visibility") !== visibility) {
          gl.setLayoutProperty(id, "visibility", visibility);
        }
      }
      const order = gl.getStyle().layers.map(layer => layer.id);
      const water = Math.max(order.indexOf("nw-flood-drape"), order.indexOf("nw-flood-overlay"));
      if (glLayerIds.some(id => order.indexOf(id) < water)) {
        for (const id of glLayerIds) gl.moveLayer(id, gl.getLayer("nw-boundary-mask") ? "nw-boundary-mask" : undefined);
      }
    }
    if (refresh) refreshLabels();
  }

  const style = document.createElement("style");
  style.textContent = `
    .highlands-contour-status{position:absolute;width:1px;height:1px;overflow:hidden;
      clip-path:inset(50%);white-space:nowrap}
    .highlands-contour-label{background:none;border:0;pointer-events:none!important}
    .highlands-contour-label span{display:inline-block;padding:2px 5px;border-radius:4px;
      background:rgba(255,255,255,.93);color:#63421e;border:1px solid rgba(99,66,30,.25);
      font:700 10px/1.2 Inter,system-ui,sans-serif;white-space:nowrap;
      box-shadow:0 1px 3px rgba(0,0,0,.12)}
  `;
  document.head.appendChild(style);

  function getMap() {
    return typeof map !== "undefined" ? map : null;
  }

  function setChecked(value) {
    toggle.classList.toggle("on", value);
    toggle.setAttribute("aria-checked", String(value));
  }

  function setStatus(value) {
    if (status) status.textContent = value;
  }

  function makePane(name, zIndex) {
    const pane = mapInstance.getPane(name) || mapInstance.createPane(name);
    pane.style.zIndex = String(zIndex);
    pane.style.pointerEvents = "none";
    return pane;
  }

  function refreshLabels() {
    if (!labels) return;
    labels.clearLayers();
    glLabels.forEach(marker => marker.remove());
    glLabels = [];
    const gl = getMapLibre();
    if (!enabled || (gl ? gl.getZoom() < 12
      : !mapInstance.hasLayer(contourLayer) || mapInstance.getZoom() < 12)) return;

    const bounds = gl ? gl.getBounds() : mapInstance.getBounds();
    const size = gl ? L.point(gl.getContainer().clientWidth, gl.getContainer().clientHeight) : mapInstance.getSize();
    const center = L.point(size.x / 2, size.y / 2);
    const placed = [];
    const perElevation = new Map();
    for (const line of indexLines) {
      if ((perElevation.get(line.elevationFt) || 0) >= 2) continue;
      let selected = null;
      let distance = Infinity;
      const stride = Math.max(1, Math.floor(line.points.length / 30));
      for (let i = 0; i < line.points.length; i += stride) {
        const position = line.points[i];
        const coordinate = gl ? [position[1], position[0]] : position;
        if (!bounds.contains(coordinate)) continue;
        const projected = gl ? gl.project(coordinate) : mapInstance.latLngToContainerPoint(position);
        const point = L.point(projected.x, projected.y);
        if (point.x < 30 || point.x > size.x - 30 || point.y < 25 || point.y > size.y - 25) continue;
        if (placed.some(other => Math.abs(other.x - point.x) < 85 && Math.abs(other.y - point.y) < 30)) continue;
        const candidateDistance = point.distanceTo(center);
        if (candidateDistance < distance) {
          selected = { position, point };
          distance = candidateDistance;
        }
      }
      if (!selected) continue;
      if (gl) {
        const element = document.createElement("div");
        element.className = "highlands-contour-label";
        element.setAttribute("aria-hidden", "true");
        const text = document.createElement("span");
        text.textContent = `${line.elevationFt} ft`;
        element.appendChild(text);
        glLabels.push(new window.maplibregl.Marker({ element, anchor: "center" })
          .setLngLat([selected.position[1], selected.position[0]]).addTo(gl));
      } else L.marker(selected.position, {
        pane: labelPaneName,
        interactive: false,
        keyboard: false,
        icon: L.divIcon({
          className: "highlands-contour-label",
          html: `<span>${line.elevationFt} ft</span>`,
          iconSize: [48, 18],
          iconAnchor: [24, 9]
        })
      }).addTo(labels);
      placed.push(selected.point);
      perElevation.set(line.elevationFt, (perElevation.get(line.elevationFt) || 0) + 1);
      if (placed.length >= 24) break;
    }
  }

  function buildLayer(data) {
    if (data?.horizontalCrs !== "EPSG:6527" || data.verticalDatum !== "NAVD88" ||
        data.verticalUnits !== "feet" || data.intervalFt !== 5 || data.indexIntervalFt !== 25 ||
        !Array.isArray(data.lines) || !data.lines.length) {
      throw new Error("The elevation contour data is unavailable.");
    }
    if (typeof window.proj4 !== "function") throw new Error("The contour projection could not load.");
    const transform = window.proj4(projection, "EPSG:4326");
    const grouped = new Map();
    const preparedIndexes = [];
    const features = [];
    for (const line of data.lines) {
      if (!Number.isFinite(line.elevationFt) || line.elevationFt % 5 !== 0 ||
          !Array.isArray(line.coordinates) || line.coordinates.length < 2) {
        throw new Error("The elevation contour data is invalid.");
      }
      const points = line.coordinates.map(coordinate => {
        if (!Array.isArray(coordinate) || !Number.isFinite(coordinate[0]) || !Number.isFinite(coordinate[1])) {
          throw new Error("The elevation contour data is invalid.");
        }
        const [longitude, latitude] = transform.forward(coordinate);
        if (!Number.isFinite(longitude) || !Number.isFinite(latitude) ||
            Math.abs(longitude) > 180 || Math.abs(latitude) > 90) {
          throw new Error("The contour coordinates could not be displayed.");
        }
        return [latitude, longitude];
      });
      features.push({ type: "Feature", properties: {
        elevationFt: line.elevationFt, isIndex: line.elevationFt % 25 === 0
      }, geometry: { type: "LineString", coordinates: points.map(point => [point[1], point[0]]) } });
      if (!grouped.has(line.elevationFt)) grouped.set(line.elevationFt, []);
      grouped.get(line.elevationFt).push(points);
      if (line.elevationFt % 25 === 0) preparedIndexes.push({ elevationFt: line.elevationFt, points });
    }

    makePane(paneName, 610);
    makePane(labelPaneName, 611);
    const renderer = L.canvas({ pane: paneName, padding: 0.2 });
    const layer = L.layerGroup();
    // A thin white casing keeps ground contours visible over flood shading and satellite imagery.
    for (const [elevation, lines] of grouped) {
      L.polyline(lines, {
        pane: paneName, renderer, interactive: false, color: "#ffffff", opacity: 0.78,
        weight: elevation % 25 === 0 ? 3.5 : 2.4, smoothFactor: 0
      }).addTo(layer);
    }
    for (const [elevation, lines] of grouped) {
      L.polyline(lines, {
        pane: paneName, renderer, interactive: false, color: "#765025", opacity: 0.92,
        weight: elevation % 25 === 0 ? 1.7 : 0.85, smoothFactor: 0
      }).addTo(layer);
    }
    contourData = { type: "FeatureCollection", features };
    indexLines = preparedIndexes.sort((a, b) => b.points.length - a.points.length);
    labels = L.layerGroup();
    contourLayer = layer;
    mapInstance.on("moveend zoomend resize", refreshLabels);
    return layer;
  }

  function loadLayer() {
    if (contourLayer) return Promise.resolve(contourLayer);
    if (!loading) {
      const base = typeof APP_BASE !== "undefined" ? APP_BASE : document.baseURI;
      loading = fetchJson(new URL(contourPath, base).href, { cache: "force-cache", timeoutMs: 20000 })
        .then(buildLayer)
        .catch(error => {
          loading = null;
          throw error;
        });
    }
    return loading;
  }

  async function setEnabled(value) {
    const request = ++generation;
    enabled = Boolean(value);
    setChecked(enabled);
    mapInstance = getMap();
    if (!enabled) {
      if (mapInstance && contourLayer) mapInstance.removeLayer(contourLayer);
      if (mapInstance && labels) mapInstance.removeLayer(labels);
      syncMapLibre();
      toggle.removeAttribute("aria-busy");
      setStatus("");
      return;
    }

    toggle.setAttribute("aria-busy", "true");
    setStatus("Loading contours…");
    try {
      if (!mapInstance) throw new Error("The map is still loading. Please try again.");
      const layer = await loadLayer();
      if (!enabled || request !== generation) return;
      if (!getMapLibre()) {
        if (!mapInstance.hasLayer(layer)) layer.addTo(mapInstance);
        if (!mapInstance.hasLayer(labels)) labels.addTo(mapInstance);
      }
      syncMapLibre();
      setStatus("");
    } catch (error) {
      if (request !== generation) return;
      enabled = false;
      setChecked(false);
      if (mapInstance && contourLayer) mapInstance.removeLayer(contourLayer);
      if (mapInstance && labels) mapInstance.removeLayer(labels);
      setStatus("Elevation contours unavailable. Please try again.");
      if (typeof toast === "function") toast(error.message);
      console.warn("Ground elevation contours:", error);
    } finally {
      if (request === generation) toggle.removeAttribute("aria-busy");
    }
  }

  setChecked(false);
  setStatus("");
  toggle.addEventListener("click", () => setEnabled(!enabled));
  toggle.addEventListener("keydown", event => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setEnabled(!enabled);
    }
  });
  let renderedMapLibre = getMapLibre();
  new MutationObserver(() => {
    const currentMapLibre = getMapLibre();
    if (currentMapLibre === renderedMapLibre) return;
    renderedMapLibre = currentMapLibre;
    if (!enabled || !contourLayer || !mapInstance) return;
    if (getMapLibre()) {
      mapInstance.removeLayer(contourLayer);
      mapInstance.removeLayer(labels);
    } else {
      if (!mapInstance.hasLayer(contourLayer)) contourLayer.addTo(mapInstance);
      if (!mapInstance.hasLayer(labels)) labels.addTo(mapInstance);
    }
    syncMapLibre();
  }).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  window.HIGHLANDS_CONTOURS = {
    setEnabled, syncMapLibre,
    getState: () => ({ enabled, loaded: Boolean(contourLayer), labelCount: glLabels.length || labels?.getLayers().length || 0 })
  };
})();
