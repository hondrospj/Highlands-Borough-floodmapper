    function loadDepthQueryPng(url) {
      return new Promise((resolve, reject) => {
        const image = new Image();
        let settled = false;
        const timer = window.setTimeout(() => {
          const error = new Error("Packed depth-query PNG took too long to load. Please try again.");
          error.name = "TimeoutError";
          finish(error);
        }, 20000);
        const finish = (error, grid) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          image.onload = image.onerror = null;
          if (error) {
            try { image.src = ""; } catch (_) {}
            reject(error);
          } else resolve(grid);
        };
        image.crossOrigin = "anonymous";
        image.decoding = "async";
        image.onload = () => {
          try {
            const canvas = document.createElement("canvas");
            canvas.width = image.naturalWidth;
            canvas.height = image.naturalHeight;
            const context = canvas.getContext("2d", { willReadFrequently: true });
            if (!context) throw new Error("Could not create the depth-query canvas.");
            context.drawImage(image, 0, 0);
            finish(null, {
              width: canvas.width,
              height: canvas.height,
              values: context.getImageData(0, 0, canvas.width, canvas.height).data
            });
          } catch (error) {
            finish(error);
          }
        };
        image.onerror = () => finish(new Error("Packed depth-query PNG could not be loaded."));
        image.src = url;
      });
    }

    async function getDepthQueryGrid() {
      if (!DEPTH_QUERY_PNG_URL) return null;
      if (!depthQueryGridPromise) {
        const request = (async () => {
          let lastError = null;
          for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
              const url = new URL(DEPTH_QUERY_PNG_URL);
              if (attempt) url.searchParams.set("_retry", String(Date.now()));
              return await loadDepthQueryPng(url.href);
            } catch (error) {
              // A stalled transport has already used its full deadline. Let
              // the frame controller/user retry instead of doubling that wait.
              if (error?.name === "TimeoutError") throw error;
              lastError = error;
            }
          }
          throw lastError || new Error("Packed depth-query PNG is unavailable.");
        })().catch(error => {
          if (depthQueryGridPromise === request) depthQueryGridPromise = null;
          throw error;
        });
        depthQueryGridPromise = request;
      }
      return awaitRasterRequest(depthQueryGridPromise);
    }

    async function getDevelopedQueryGrid() {
      if (!DEVELOPED_QUERY_PNG_URL) return null;
      if (!developedQueryGridPromise) {
        const request = loadDepthQueryPng(DEVELOPED_QUERY_PNG_URL)
          .catch(error => {
            if (developedQueryGridPromise === request) developedQueryGridPromise = null;
            throw error;
          });
        developedQueryGridPromise = request;
      }
      return awaitRasterRequest(developedQueryGridPromise);
    }

    async function readDepthCogWithDeadline(read) {
      const controller = new AbortController();
      let timer;
      const deadline = new Promise((_, reject) => {
        timer = window.setTimeout(() => {
          const error = new Error("Depth query GeoTIFF took too long to load. Please try again.");
          error.name = "TimeoutError";
          reject(error);
          controller.abort();
        }, 20000);
      });
      try {
        return await Promise.race([deadline, read(controller.signal)]);
      } finally {
        window.clearTimeout(timer);
      }
    }

    function getDepthQueryImage() {
      if (!depthQueryImagePromise) {
        const request = (async () => {
          if (!DEPTH_QUERY_COG_URL) throw new Error("Depth query COG is not configured.");
          if (!window.GeoTIFF?.fromUrl) await ensureDepthQueryLibrary();
          return await readDepthCogWithDeadline(async signal => {
            const tiff = await GeoTIFF.fromUrl(DEPTH_QUERY_COG_URL, {}, signal);
            return tiff.getImage();
          });
        })().catch(error => {
          if (depthQueryImagePromise === request) depthQueryImagePromise = null;
          throw error;
        });
        depthQueryImagePromise = request;
      }
      return depthQueryImagePromise;
    }

    // Query grids follow their own georeferencing, not one town's layout.
    // Rotated grids keep the affine transform; north-up catalogs use Mercator Y.
    function latLngToDepthQueryPixel(lat, lng, width, height) {
      if (![lat, lng, width, height].every(Number.isFinite) ||
          width <= 0 || height <= 0 || Math.abs(lat) >= 90) return null;
      if (TOWN_CONFIG?.overlays?.worldFileCornersWgs84) {
        return latLngToWorldFilePixel(lat, lng, width, height);
      }
      const bounds = TOWN_CONFIG?.overlays?.boundsWgs84;
      if (!bounds) return null;
      const { west, east, south, north } = bounds;
      if (![west, east, south, north].every(Number.isFinite) ||
          west >= east || south >= north || south <= -90 || north >= 90) return null;
      const mercY = latitude => Math.log(Math.tan(Math.PI / 4 + latitude * Math.PI / 360));
      const u = (lng - west) / (east - west);
      const v = (mercY(north) - mercY(lat)) / (mercY(north) - mercY(south));
      if (!Number.isFinite(u) || !Number.isFinite(v) || u < 0 || v < 0 || u >= 1 || v >= 1) return null;
      return { x: Math.floor(u * width), y: Math.floor(v * height), u, v };
    }

    async function samplePackedDepthGrid(lat, lon) {
      const [grid, developedGrid] = await Promise.all([
        getDepthQueryGrid(),
        getDevelopedQueryGrid().catch(error => {
          console.warn("Developed-land query mask is unavailable.", error);
          return undefined;
        })
      ]);
      if (!grid || !floodLatLngBounds) return null;
      const pixel = latLngToDepthQueryPixel(lat, lon, grid.width, grid.height);
      if (!pixel) return null;
      const { x, y } = pixel;
      const offset = (y * grid.width + x) * 4;
      const encodedElevation = grid.values[offset] * 256 + grid.values[offset + 1];
      if (encodedElevation === 0) return null;
      const elevation10 = encodedElevation - 32768;
      const connectionCode = grid.values[offset + 2];
      const developedOffset = developedGrid &&
        developedGrid.width === grid.width && developedGrid.height === grid.height
        ? (y * developedGrid.width + x) * 4
        : -1;
      const encodedSourceDistance = developedOffset >= 0
        ? developedGrid.values[developedOffset] * 256 + developedGrid.values[developedOffset + 1]
        : 65535;
      return {
        elevation: elevation10 / 10,
        zoneId: 0,
        connectionStage: connectionCode === 255 ? 9999 : (connectionCode - 50) / 10,
        sourceFlag: false,
        hardStructureFlag: false,
        stormGrateFlag: false,
        developedFlag: developedOffset >= 0
          ? developedGrid.values[developedOffset + 2] >= 128 : developedGrid === null ? false : null,
        sourceDistanceFt: encodedSourceDistance === 65535 ? null : encodedSourceDistance,
        featureDistanceFt: null
      };
    }

    async function sampleDepthModelFromCog(lat, lon) {
      const imageRequest = getDepthQueryImage();
      const image = await awaitRasterRequest(imageRequest);
      const bounds = image.getBoundingBox();
      const width = image.getWidth();
      const height = image.getHeight();
      const longitudeStep = (bounds[2] - bounds[0]) / width;
      const latitudeStep = (bounds[3] - bounds[1]) / height;
      const x = Math.floor((lon - bounds[0]) / longitudeStep);
      const y = Math.floor((bounds[3] - lat) / latitudeStep);
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= width || y >= height) return null;
      // A one-foot feature can be narrower than one screen pixel at ordinary
      // zooms. Use a physical radius so a diagonal or resampled cell cannot
      // snap to a bulkhead or drain farther away than the intended 16 feet.
      const feetPerDegreeLatitude = 364000;
      const xStepFt = longitudeStep * feetPerDegreeLatitude * Math.cos(lat * Math.PI / 180);
      const yStepFt = latitudeStep * feetPerDegreeLatitude;
      const featureRadiusFt = 16;
      const xRadius = Math.ceil(featureRadiusFt / xStepFt);
      const yRadius = Math.ceil(featureRadiusFt / yStepFt);
      const x0 = Math.max(0, x - xRadius);
      const y0 = Math.max(0, y - yRadius);
      const x1 = Math.min(width, x + xRadius + 1);
      const y1 = Math.min(height, y + yRadius + 1);
      const sampleCount = 7;
      const windowWidth = x1 - x0;
      const rasterRequest = readDepthCogWithDeadline(signal => image.readRasters({
        window: [x0, y0, x1, y1],
        samples: [0, 1, 2, 3, 4, 5, 6],
        interleave: true,
        signal
      })).catch(error => {
        if (depthQueryImagePromise === imageRequest) depthQueryImagePromise = null;
        throw error;
      });
      const values = await awaitRasterRequest(rasterRequest);
      let sampleOffset = ((y - y0) * windowWidth + (x - x0)) * sampleCount;
      let bestDistanceSquared = Infinity;
      for (let row = 0; row < y1 - y0; row += 1) {
        for (let column = 0; column < windowWidth; column += 1) {
          const offset = (row * windowWidth + column) * sampleCount;
          const candidateElevation = Number(values[offset]);
          const hardFlag = Number(values[offset + 4]);
          const grateFlag = Number(values[offset + 5]);
          const plausibleElevation = Number.isFinite(candidateElevation) &&
            candidateElevation > -100 && candidateElevation < 100;
          const isFeature = plausibleElevation &&
            ((hardFlag >= 0.5 && hardFlag <= 1.5) || (grateFlag >= 0.5 && grateFlag <= 1.5));
          if (!isFeature) continue;
          const distanceSquared = ((x0 + column - x) * xStepFt) ** 2 + ((y0 + row - y) * yStepFt) ** 2;
          if (distanceSquared <= featureRadiusFt ** 2 && distanceSquared < bestDistanceSquared) {
            bestDistanceSquared = distanceSquared;
            sampleOffset = offset;
          }
        }
      }
      const elevation = Number(values[sampleOffset]);
      const zoneId = Math.round(Number(values[sampleOffset + 1]));
      const connectionStage = Number(values[sampleOffset + 2]);
      const sourceFlag = Number(values[sampleOffset + 3]);
      const hardStructureFlag = Number(values[sampleOffset + 4]);
      const stormGrateFlag = Number(values[sampleOffset + 5]);
      const developedFlag = Number(values[sampleOffset + 6]);
      if (!Number.isFinite(elevation) || elevation <= -1000 || elevation >= 1000) return null;
      return {
        elevation,
        zoneId,
        connectionStage,
        sourceFlag: sourceFlag >= 0.5,
        hardStructureFlag: hardStructureFlag >= 0.5,
        stormGrateFlag: stormGrateFlag >= 0.5,
        developedFlag: developedFlag >= 0.5,
        featureDistanceFt: Number.isFinite(bestDistanceSquared) ? Math.sqrt(bestDistanceSquared) : null
      };
    }

    async function sha256Hex(buffer) {
      if (!window.crypto?.subtle) return "";
      const digest = await window.crypto.subtle.digest("SHA-256", buffer);
      return Array.from(new Uint8Array(digest))
        .map(value => value.toString(16).padStart(2, "0"))
        .join("");
    }

    function preloadPhysicsQueryImage(record) {
      const url = record?.url;
      if (!url) return Promise.resolve(null);
      if (physicsQueryImageCache.has(url)) return physicsQueryImageCache.get(url);
      const promise = (async () => {
        const response = await fetch(url, {
          mode: "cors",
          credentials: "omit",
          cache: "force-cache",
          headers: { Accept: "image/png" }
        });
        if (!response.ok) throw new Error(`Physics query PNG returned HTTP ${response.status}.`);
        const buffer = await response.arrayBuffer();
        if (record.sha256 && window.crypto?.subtle) {
          const actual = await sha256Hex(buffer);
          if (actual !== String(record.sha256).toLowerCase()) {
            throw new Error("Physics query PNG failed its SHA-256 integrity check.");
          }
        }
        const objectUrl = URL.createObjectURL(new Blob([buffer], { type: "image/png" }));
        const image = new Image();
        image.decoding = "async";
        try {
          await new Promise((resolve, reject) => {
            image.onload = resolve;
            image.onerror = () => reject(new Error("Physics query PNG could not be decoded."));
            image.src = objectUrl;
          });
          return image;
        } finally {
          URL.revokeObjectURL(objectUrl);
        }
      })().catch(error => {
        physicsQueryImageCache.delete(url);
        throw error;
      });
      physicsQueryImageCache.set(url, promise);
      return promise;
    }

    function latLngToPhysicsQueryPixel(manifest, lat, lon, width, height) {
      const bounds = manifest?.boundsWgs84;
      if (manifest?.schema !== "north-wildwood-physics-forecast-v2" ||
          manifest?.image?.crs !== "EPSG:3857" ||
          manifest?.image?.coordinateSystem !== "web-mercator" ||
          !Array.isArray(bounds) || bounds.length !== 2 ||
          ![lat, lon, width, height].every(Number.isFinite) ||
          width <= 0 || height <= 0) return null;
      const south = Number(bounds[0]?.[0]);
      const west = Number(bounds[0]?.[1]);
      const north = Number(bounds[1]?.[0]);
      const east = Number(bounds[1]?.[1]);
      if (
        ![south, west, north, east].every(Number.isFinite) ||
        west >= east || south >= north || south <= -85.05112878 || north >= 85.05112878 ||
        lat < south || lat > north || lon < west || lon > east
      ) return null;
      const mercY = latitude => Math.log(Math.tan(Math.PI / 4 + latitude * Math.PI / 360));
      const u = (lon - west) / (east - west);
      const v = (mercY(north) - mercY(lat)) / (mercY(north) - mercY(south));
      if (!Number.isFinite(u) || !Number.isFinite(v) || u < 0 || v < 0 || u >= 1 || v >= 1) return null;
      return { x: Math.floor(u * width), y: Math.floor(v * height) };
    }

    async function samplePhysicsDepth(asset, lat, lon) {
      if (!asset?.query?.url) return null;
      const manifest = getActivePhysicsManifest();
      // Check the schema and extent before requesting any image. Native-grid
      // v1 products cannot be safely sampled as Web Mercator pixels.
      if (!latLngToPhysicsQueryPixel(manifest, lat, lon, 1, 1)) return null;
      const image = await preloadPhysicsQueryImage(asset.query);
      if (!image || image.naturalWidth !== manifest.image.width || image.naturalHeight !== manifest.image.height) return null;
      const point = latLngToPhysicsQueryPixel(manifest, lat, lon, image.naturalWidth, image.naturalHeight);
      if (!point) return null;
      const { x, y } = point;
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.drawImage(image, x, y, 1, 1, 0, 0, 1, 1);
      const pixel = context.getImageData(0, 0, 1, 1).data;
      const wet = pixel[2] === 1;
      return { wet, depthM: wet ? (pixel[0] * 256 + pixel[1]) / 1000 : null };
    }

    async function sampleDepthModel(lat, lon) {
      if (DEPTH_QUERY_PNG_URL) {
        try {
          return await samplePackedDepthGrid(lat, lon);
        } catch (error) {
          console.warn("Packed routed-depth query failed; retrying through the COG.", error);
        }
      }
      if (DEPTH_QUERY_COG_URL) {
        let lastError = null;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            return await sampleDepthModelFromCog(lat, lon);
          } catch (error) {
            if (error?.name === "TimeoutError" || error?.name === "AbortError") throw error;
            lastError = error;
          }
        }
        throw lastError || new Error("Depth query data is unavailable.");
      }
      throw new Error("Depth query data is unavailable.");
    }

    function sampleRenderedFloodPixel(lat, lon) {
      const image = currentFloodLayer?.getElement?.();
      if (
        !image ||
        !image.complete ||
        image.naturalWidth <= 0 ||
        image.naturalHeight <= 0 ||
        !floodLatLngBounds
      ) return null;
      const imageUrl = image.currentSrc || image.src;
      try {
        if (
          !renderedFloodPixelCache ||
          renderedFloodPixelCache.url !== imageUrl ||
          renderedFloodPixelCache.width !== image.naturalWidth ||
          renderedFloodPixelCache.height !== image.naturalHeight
        ) {
          const canvas = document.createElement("canvas");
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          const context = canvas.getContext("2d", { willReadFrequently: true });
          if (!context) return null;
          context.drawImage(image, 0, 0);
          renderedFloodPixelCache = {
            url: imageUrl,
            width: image.naturalWidth,
            height: image.naturalHeight,
            context
          };
        }
        const pixel = currentFloodLayer?._worldFileAffine
          ? latLngToWorldFilePixel(lat, lon, image.naturalWidth, image.naturalHeight)
          : (() => {
            const west = floodLatLngBounds.getWest();
            const east = floodLatLngBounds.getEast();
            const south = floodLatLngBounds.getSouth();
            const north = floodLatLngBounds.getNorth();
            const x = Math.floor(((lon - west) / (east - west)) * image.naturalWidth);
            const y = Math.floor(((north - lat) / (north - south)) * image.naturalHeight);
            return x >= 0 && y >= 0 && x < image.naturalWidth && y < image.naturalHeight ? { x, y } : null;
          })();
        if (!pixel) return null;
        const { x, y } = pixel;
        const rgba = renderedFloodPixelCache.context.getImageData(x, y, 1, 1).data;
        const visible = rgba[3] > 0;
        const green = isDisconnectedRasterPixel(rgba, 0);
        const depthBandIndex = currentOverlayMode === "depth" ? DRAINAGE_DEPTH_COLORS.findIndex(color =>
          color.every((channel, index) => Math.abs(channel - rgba[index]) <= 3)) : -1;
        const depthBandFt = depthBandIndex < 0 ? null : [depthBandIndex ? DRAINAGE_DEPTH_BREAKS_FT[depthBandIndex - 1] : 0,
          DRAINAGE_DEPTH_BREAKS_FT[depthBandIndex] ?? Infinity];
        return { visible, green, flooded: visible && !green, depthBandFt };
      } catch (error) {
        console.warn("Rendered flood-pixel sampling was unavailable.", error);
        renderedFloodPixelCache = null;
        return null;
      }
    }

    function getDepthQueryDisplayDepth(sample, stageValue, renderedFlood = null, phase = "slack") {
      if (!sample) return null;
      const stage = normalizeStageValue(stageValue);
      if (!Number.isFinite(stage)) return null;
      // A failed or misaligned companion does not classify the terrain. A dry
      // raster pixel is still meaningful, but a wet pixel has no point estimate.
      if (sample.developedFlag === null) return renderedFlood?.flooded === false ? 0 : null;
      const overlayStage = getOverlayStage(stage);
      const depthStage = normalizeHydraulicPhase(phase) === "filling" ? stage : overlayStage;
      const developed = sample.developedFlag === true;
      const depthModel = getPenalizedConnectedDepth(
        depthStage,
        sample.elevation,
        developed,
        phase,
        sample.sourceDistanceFt
      );
      const adjustedStage = Number(depthModel?.adjustedStage);
      const normalizedPhase = normalizeHydraulicPhase(phase);
      const connectionStageLimit = normalizedPhase === "draining"
        ? adjustedStage
        : overlayStage;
      const modeledConnected = Number.isFinite(adjustedStage) &&
        sample.elevation < adjustedStage - 0.005 &&
        Number.isFinite(sample.connectionStage) &&
        sample.connectionStage <= connectionStageLimit + 0.0001;
      const connected = renderedFlood ? renderedFlood.flooded : modeledConnected;
      const depth = connected && depthModel ? depthModel.depth : null;
      // A visible pooled/feeder pixel is not evidence for an invented point depth.
      if (renderedFlood?.flooded && (!Number.isFinite(depth) || depth <= 0.005)) {
        // Only an actual shallow raster band supports the displayed 0–0.1 ft range.
        return renderedFlood.depthBandFt?.[1] === 0.1 ? 0.05 : null;
      }
      return Number.isFinite(depth) ? depth : 0;
    }

    function getDepthQueryPopupHeading() {
      const displayedMode = currentFloodLayer?._floodmapperFrame?.dataMode || currentDataMode;
      if (displayedMode === "forecast") return "Forecast Water Depth";
      if (displayedMode === "observed") return "Water Depth";
      return "Modeled Water Depth";
    }

    function formatDepthQueryValue(depth) {
      if (!Number.isFinite(depth)) return "N/A";
      if (depth > 0 && depth <= 0.1000001) return "0–1.2 in";
      return formatWaterDepth(depth);
    }

    function buildDepthQueryValueHtml(value) {
      const parts = String(value).match(/^(.*?)\s+(in|ft)$/);
      if (!parts) return '<span class="depth-query-number">' + value + '</span>';
      return '<span class="depth-query-number">' + parts[1] + '</span> ' +
        '<span class="depth-query-unit">' + parts[2] + '</span>';
    }

    function buildDepthQueryPopupHtml(depth) {
      const value = formatDepthQueryValue(depth);
      return '<div class="depth-query-popup" role="status" aria-live="polite">' +
        '<h3>' + getDepthQueryPopupHeading() + '</h3><div class="depth-query-value">' +
        buildDepthQueryValueHtml(value) + '</div></div>';
    }

    function updatePersistentDepthQueryPopup(options = {}) {
      const context = persistentDepthQueryContext;
      const popup = persistentFloodPopup;
      if (!context || !popup || context.popup !== popup || !map?.hasLayer(popup)) return;
      if (context.kind === "structure") {
        updatePropertyPopup(popup, buildNsiStructurePopup(context.feature));
        return;
      }
      if (context.kind === "parcel") {
        return refreshParcelFloodPopup(context);
      }
      if (context.kind === "physics") {
        // Physics values belong to one frame; close them when navigation starts.
        if (floodFrameState !== "ready") {
          map.removeLayer(popup);
          persistentDepthQueryContext = null;
        }
        return;
      }
      if (context.kind === "building") {
        updatePropertyPopup(popup, buildHouseAlertPopup(context.feature));
        return;
      }
      const displayedFrame = currentFloodLayer?._floodmapperFrame;
      const stage = displayedFrame ? displayedFrame.stage : getStageValue(currentSeriesHours[currentHourIndex]);
      if (floodFrameState !== "ready") {
        popup.setContent(buildDepthQueryPopupHtml(null));
        popup.update();
        return;
      }
      const renderedFlood = options.useRenderedFlood === false
        ? null
        : sampleRenderedFloodPixel(context.latlng.lat, context.latlng.lng);
      const phase = displayedFrame?.phase || getHydraulicPhaseForEntry(
        currentSeriesHours[currentHourIndex],
        currentHourIndex,
        currentSeriesHours
      );
      const depth = getDepthQueryDisplayDepth(context.sample, stage, renderedFlood, phase);
      popup.setContent(buildDepthQueryPopupHtml(depth));
      popup.update();
    }

    function openDepthQueryPopup(latlng, sample) {
      const displayedFrame = currentFloodLayer?._floodmapperFrame;
      const stage = displayedFrame ? displayedFrame.stage : getStageValue(currentSeriesHours[currentHourIndex]);
      const renderedFlood = sample
        ? sampleRenderedFloodPixel(latlng.lat, latlng.lng)
        : null;
      const phase = displayedFrame?.phase || getHydraulicPhaseForEntry(
        currentSeriesHours[currentHourIndex],
        currentHourIndex,
        currentSeriesHours
      );
      const depth = floodFrameState === "ready"
        ? getDepthQueryDisplayDepth(sample, stage, renderedFlood, phase) : null;
      const popup = openPersistentFloodPopup(latlng, buildDepthQueryPopupHtml(depth), 300);
      if (sample) {
        persistentDepthQueryContext = { popup, latlng, sample };
      }
      return popup;
    }

    function beginMapQuery() {
      if (cancelPendingTownAddressLookup()) setTownAddressStatus("");
      return ++mapQueryGeneration;
    }

    async function handleDepthQueryClick(event) {
      if (event?.originalEvent?._parcelHandled || !event?.latlng) return;
      const queryGeneration = beginMapQuery();
      const queryMode = mapClickMode;
      const queryRenderToken = lastRenderToken;
      const isCurrentQuery = () => queryGeneration === mapQueryGeneration && queryMode === mapClickMode && queryRenderToken === lastRenderToken;
      try {
        if (queryMode === "parcel" && document.getElementById("parcelsToggle")?.classList.contains("on")) {
          const feature = await findParcelFeatureForLocation(event.latlng.lat, event.latlng.lng, { allowNearest: false });
          if (!isCurrentQuery() || !document.getElementById("parcelsToggle")?.classList.contains("on")) return;
          if (feature) openParcelAreaPopup(feature, event.latlng);
          else toast("Tap inside a parcel to see its flood estimate.");
          return;
        }
        if (queryMode === "building" && parcelInfoInteractionEnabled()) {
          const nsiEnabled = document.getElementById("nsiStructuresToggle")?.classList.contains("on");
          if (nsiEnabled) {
            const structureFeature = findNsiStructureFeatureForLocation(event.latlng.lat, event.latlng.lng);
            if (structureFeature) {
              openNsiStructurePopup(structureFeature, event.latlng);
              return;
            }
          }
          if (!document.getElementById("buildingsToggle")?.classList.contains("on")) {
            toast("Tap a highlighted structure or choose Flood Depth.");
            return;
          }
          const parcelFeature = await findParcelFeatureForLocation(
            event.latlng.lat,
            event.latlng.lng,
            { allowNearest: false }
          );
          if (!isCurrentQuery() || !document.getElementById("buildingsToggle")?.classList.contains("on")) return;
          if (parcelFeature) {
            openParcelFloodPrompt(parcelFeature, event.latlng);
            return;
          }
          toast("No parcel contains that building tap. Tap inside a building or choose Water depth.");
          return;
        }
        const entry = currentSeriesHours[currentHourIndex];
        const physicsAsset = getPhysicsAssetForEntry(entry);
        if (physicsAsset) {
          const queryToken = lastRenderToken;
          const result = await samplePhysicsDepth(physicsAsset, event.latlng.lat, event.latlng.lng);
          if (!isCurrentQuery() || queryToken !== lastRenderToken || entry !== currentSeriesHours[currentHourIndex] || floodFrameState !== "ready") return;
          const depthFt = result?.depthM == null ? null : result.depthM / 0.3048;
          const html = '<div class="depth-query-popup" role="status" aria-live="polite">' +
            '<h3>Physics Water Depth</h3><div class="depth-query-value">' +
            buildDepthQueryValueHtml(result == null ? "N/A" : formatWaterDepth(depthFt == null ? 0 : depthFt)) +
            '</div><div class="house-alert-note">' +
            (result == null ? 'Outside modeled coverage' : result.wet ? 'Hydraulically connected modeled flooding' : 'Dry in this exact time step') +
            ' • cycle ' + escapeTownAddressHtml(getActivePhysicsManifest()?.cycleId || '—') +
            '</div></div>';
          const popup = openPersistentFloodPopup(event.latlng, html, 330);
          persistentDepthQueryContext = { popup, kind: "physics" };
          return;
        }
        const sample = await sampleDepthModel(event.latlng.lat, event.latlng.lng);
        if (!isCurrentQuery()) return;
        if (!sample) {
          await openDepthQueryPopup(event.latlng, null);
          return;
        }
        await openDepthQueryPopup(event.latlng, sample);
      } catch (err) {
        if (!isCurrentQuery()) return;
        console.error("Depth query failed", err);
        toast("Depth query is temporarily unavailable.");
      }
    }

