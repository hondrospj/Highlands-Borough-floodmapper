    function wait(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    }

    async function waitForStableRender() {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await wait(EXPORT_CAPTURE_DELAY_MS);
    }

    async function waitForExportChromeReady() {
      function loadLogoSource(img, expectedSrc, assignSource) {
        return new Promise((resolve, reject) => {
          let settled = false;
          let decoding = false;
          const failure = () => new Error("The export logo could not load. Please try again.");
          const ready = () => img.complete && img.naturalWidth > 0 && img.naturalHeight > 0
            && img.currentSrc === expectedSrc && img.src === expectedSrc;
          const finish = error => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            clearInterval(cancelTimer);
            img.removeEventListener("load", check);
            img.removeEventListener("error", onError);
            if (error) reject(error);
            else resolve();
          };
          const check = () => {
            if (settled || decoding) return;
            try {
              throwIfExportCancelled();
              if (img.src !== expectedSrc) throw failure();
              if (!ready()) return;
              decoding = true;
              // Firefox can decode the previous current image while the new
              // source is pending. Decode only after this exact source loads.
              Promise.resolve(typeof img.decode === "function" ? img.decode() : undefined)
                .then(() => {
                  throwIfExportCancelled();
                  if (!ready()) throw failure();
                  finish();
                }).catch(finish);
            } catch (error) { finish(error); }
          };
          const onError = () => finish(failure());
          const timeout = setTimeout(() => finish(failure()), 20000);
          const cancelTimer = setInterval(() => {
            try { throwIfExportCancelled(); } catch (error) { finish(error); }
          }, 100);
          img.addEventListener("load", check);
          img.addEventListener("error", onError);
          try { if (assignSource) assignSource(); check(); }
          catch (error) { finish(error); }
        });
      }

      const partner = document.getElementById("exportPartnerLogo");
      const brand = document.getElementById("mapTitlePartnerLogo");
      const pendingPartnerSource = partner && !partner.getAttribute?.("src")
        ? partner.dataset?.exportBrandSrc || brand?.getAttribute?.("src") : "";
      const images = [document.getElementById("exportTownLogo"), partner];
      await Promise.all(images.map(async img => {
        if (!img) return;
        const initializePartner = img === partner && !!pendingPartnerSource;
        const sourceUrl = initializePartner ? pendingPartnerSource : img.src;
        if (!sourceUrl || (!initializePartner && (!img.classList.contains("is-visible") || img.style.display === "none"))) return;
        img.loading = "eager";
        throwIfExportCancelled();
        let expectedSrc = sourceUrl;
        if (!sourceUrl.startsWith("data:")) {
          const source = await getExportImageElement(sourceUrl);
          throwIfExportCancelled();
          if (!source || !source.naturalWidth || !source.naturalHeight) throw new Error("The export logo could not load. Please try again.");
          const canvas = document.createElement("canvas");
          try {
            canvas.width = source.naturalWidth;
            canvas.height = source.naturalHeight;
            const context = canvas.getContext("2d");
            if (!context) throw new Error("Could not prepare the export logo.");
            context.drawImage(source, 0, 0);
            // Inline before assigning the live node, avoiding a duplicate
            // request and html2canvas's later fetch of the original URL.
            expectedSrc = canvas.toDataURL("image/png");
          } finally {
            canvas.width = 1;
            canvas.height = 1;
          }
        }
        await loadLogoSource(img, expectedSrc, initializePartner
          ? () => setExportLogoImage("exportPartnerLogo", expectedSrc, brand?.alt || "ShorelySafe")
          : img.src === expectedSrc ? null : () => { img.src = expectedSrc; });
      }));
    }


    async function waitForExportMapReady(extraDelayMs = 120, renderConfig = null) {
      if (!exportMap) return;
      exportMap.invalidateSize(false);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const vectorRoads = exportUsesScalableRoadLabels();
      // Leaflet's generic load event is not a readiness signal for an Esri
      // vector layer. Use the exact vector/raster checks once per frame.
      const vectorBasemap = exportBasemapColorLayer;
      try {
        await waitForExportVectorLayerReady(vectorBasemap);
      } catch (error) {
        if (isExportCancelledError(error)) throw error;
        useExportFallbackBasemap(vectorBasemap);
      }
      await Promise.all([
        waitForExportRasterLayerReady(exportBasemapColorLayer),
        typeof exportSatelliteLayer !== "undefined" && exportSatelliteLayer && exportMap.hasLayer(exportSatelliteLayer)
          ? waitForExportRasterLayerReady(exportSatelliteLayer) : null,
        vectorRoads ? waitForExportRoadLabelsReady(renderConfig)
          : exportRoadsLayer && Number(exportRoadsLayer.options?.opacity || 0) > 0
            ? waitForExportRasterLayerReady(exportRoadsLayer) : null,
        typeof exportBuildingsLayer !== "undefined" && exportBuildingsLayer && exportMap.hasLayer(exportBuildingsLayer)
          ? waitForExportVectorLayerReady(exportBuildingsLayer) : null
      ]);
      if (extraDelayMs > 0) await wait(extraDelayMs);
    }

    function getFriendlyExportError(err, format = "") {
      const raw = String(err?.message || err || "Download failed.").trim();
      const formatLabel = String(format || "export").toUpperCase();
      if (isExportCancelledError(err)) return "Export cancelled.";
      if (!raw) return `${formatLabel} export failed.`;
      if (/JSZip|zip export library/i.test(raw)) {
        return "PNG export could not package multiple images. Reload the page and try again.";
      }
      if (/gif\.worker|Failed to construct 'Worker'|cannot be accessed from origin/i.test(raw)) {
        return "GIF export was blocked by a worker loading issue. Reload the page and try again.";
      }
      if (/formatNyDateKey|format date key|date key/i.test(raw)) {
        return "The export date picker had an internal date-format issue. Reload the page; if it continues, use MM/DD/YY for both export dates.";
      }
      if (/Failed to fetch|NetworkError|Load failed/i.test(raw)) {
        return "GIF export failed while loading browser export components. Reload the page and try again.";
      }
      if (/html2canvas|canvasToBlob|CanvasToBlob|Canvas export failed|taint|cross-origin resource/i.test(raw)) {
        return `${formatLabel} export could not capture the map cleanly. Reload the page and try again.`;
      }
      if (raw.length > 140) {
        return `${formatLabel} export failed. Check the browser console for the full error.`;
      }
      return raw;
    }

    function getSameOriginWorkerUrl(sourceUrl, { signal, timeoutMs = 12000 } = {}) {
      // The deadline covers both response headers and the complete body. A
      // separate rejection also releases Cancel when a transport ignores abort.
      return new Promise((resolve, reject) => {
        const controller = new AbortController();
        let settled = false;
        let timer = null;
        const finish = (error, url = null) => {
          if (settled) {
            if (url) URL.revokeObjectURL(url);
            return;
          }
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", cancelled);
          if (error) {
            controller.abort();
            reject(error);
          } else {
            resolve(url);
          }
        };
        const cancelled = () => finish(makeExportCancelledError());
        signal?.addEventListener("abort", cancelled, { once: true });
        if (signal?.aborted) {
          cancelled();
          return;
        }
        timer = setTimeout(() => finish(new Error("The GIF worker download took too long. Please try the export again.")), timeoutMs);
        Promise.resolve().then(async () => {
          if (settled) return;
          const response = await fetch(sourceUrl, { mode: "cors", cache: "force-cache", signal: controller.signal });
          if (settled) return;
          if (!response.ok) throw new Error(`Could not load worker script (${response.status}).`);
          const scriptText = await response.text();
          if (settled) return;
          finish(null, URL.createObjectURL(new Blob([scriptText], { type: "text/javascript" })));
        }).catch(error => finish(error));
      });
    }

    async function waitForExportVectorLayerReady(layer, timeoutMs = 15000) {
      if (!layer || typeof layer._createMaplibreLayer !== "function") return;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        throwIfExportCancelled();
        if (layer._map === null) return; // The layer's error handler installed a fallback.
        const glMap = layer._maplibreGL?._glMap;
        if (glMap?.loaded() && glMap.areTilesLoaded()) {
          glMap.triggerRepaint();
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          return;
        }
        await wait(100);
      }
      throw new Error("The map background is still loading. Please try the export again.");
    }

    function retryExportRasterLayerTiles(layer) {
      const mapInstance = typeof exportMap === "undefined" ? null : exportMap;
      if (!mapInstance || typeof mapInstance.hasLayer !== "function" || !mapInstance.hasLayer(layer)
          || typeof mapInstance.removeLayer !== "function" || typeof mapInstance.addLayer !== "function") return false;
      const previousContainer = layer.getContainer?.();
      const parent = previousContainer?.parentNode;
      const nextSibling = previousContainer?.nextSibling;
      // Leaflet 1.9.4 redraw() uses the fractional camera zoom as its tile
      // grid zoom. Reattaching uses onAdd/_setView's rounded grid instead, so
      // integer service levels and x/y stay aligned without moving the camera.
      mapInstance.removeLayer(layer);
      mapInstance.addLayer(layer);
      const container = layer.getContainer?.();
      if (parent && container?.parentNode === parent) {
        parent.insertBefore(container, nextSibling?.parentNode === parent ? nextSibling : null);
      }
      return true;
    }

    async function waitForExportRasterLayerReady(layer, timeoutMs = 30000) {
      if (!layer || typeof layer.isLoading !== "function") return;
      const deadline = Date.now() + timeoutMs;
      let retriedFailedTiles = false;
      while (Date.now() < deadline) {
        throwIfExportCancelled();
        const tiles = Array.from(layer.getContainer()?.querySelectorAll("img.leaflet-tile, canvas.leaflet-tile") || []);
        if (tiles.some(tile => tile.complete && !tile.naturalWidth)) {
          // A preview and its download share this layer. Re-request failed tiles
          // once so a transient preview failure cannot poison the next capture.
          if (!retriedFailedTiles && retryExportRasterLayerTiles(layer)) {
            retriedFailedTiles = true;
            await wait(100);
            continue;
          }
          throw new Error("A map tile could not load. Please try the export again.");
        }
        if (!layer.isLoading() && tiles.length && tiles.every(tile => tile.complete && tile.naturalWidth > 0)) {
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          return;
        }
        await wait(100);
      }
      throwIfExportCancelled();
      const container = layer.getContainer();
      const tiles = Array.from(container?.querySelectorAll("img.leaflet-tile, canvas.leaflet-tile") || []);
      const loading = layer.isLoading();
      // A load can finish during the last polling interval. Check once more
      // before reporting the deadline, without adding a wait or grace period.
      if (!loading && tiles.length && tiles.every(tile => tile.complete && tile.naturalWidth > 0)) {
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return;
      }
      const error = new Error("The map background is still loading. Please try the export again.");
      try {
        const mapInstance = typeof exportMap === "undefined" ? null : exportMap;
        const native = tiles.map(tile => ({
          tag: typeof tile.tagName === "string" ? tile.tagName : null,
          complete: !!tile.complete, naturalWidth: Number(tile.naturalWidth) || 0,
          naturalHeight: Number(tile.naturalHeight) || 0
        }));
        const tracked = Object.values(layer._tiles || {}).map(tile => ({
          current: !!tile.current, loaded: Number(tile.loaded) || null, active: !!tile.active,
          coords: tile.coords ? {
            x: Number.isFinite(tile.coords.x) ? tile.coords.x : null,
            y: Number.isFinite(tile.coords.y) ? tile.coords.y : null,
            z: Number.isFinite(tile.coords.z) ? tile.coords.z : null
          } : null,
          complete: !!tile.el?.complete, naturalWidth: Number(tile.el?.naturalWidth) || 0
        }));
        const freeze = value => {
          if (value && typeof value === "object") {
            Object.values(value).forEach(freeze);
            Object.freeze(value);
          }
          return value;
        };
        error.exportRasterReadiness = freeze({
          schemaVersion: 1, reason: "deadline", observedAt: Date.now(),
          layer: {
            layerId: Number(layer._leaflet_id) || null, kind: "raster",
            url: typeof layer._url === "string" ? layer._url : null,
            mapContains: !!mapInstance && mapInstance.hasLayer(layer),
            ownsMap: !!mapInstance && layer._map === mapInstance, mapMissing: !layer._map,
            containerPresent: !!container, containerAttached: !!container?.isConnected,
            isLoading: typeof loading === "boolean" ? loading : null,
            tileZoom: Number.isFinite(layer._tileZoom) ? layer._tileZoom : null,
            native: {
              count: native.length, complete: native.filter(tile => tile.complete).length,
              ready: native.filter(tile => tile.complete && tile.naturalWidth > 0).length,
              pending: native.filter(tile => !tile.complete).length,
              failed: native.filter(tile => tile.complete && !tile.naturalWidth).length, tiles: native
            },
            tracked: {
              count: tracked.length, current: tracked.filter(tile => tile.current).length,
              loaded: tracked.filter(tile => tile.loaded).length, active: tracked.filter(tile => tile.active).length,
              tiles: tracked
            }
          }
        });
      } catch (_) { /* Diagnostic capture must preserve the original error. */ }
      throw error;
    }

    function useExportFallbackBasemap(expectedLayer = exportBasemapColorLayer) {
      if (expectedLayer !== exportBasemapColorLayer) return;
      if (expectedLayer && exportMap.hasLayer(expectedLayer)) {
        // Esri Leaflet 4.3.2 cannot remove a vector layer before its style is
        // ready: onRemove assumes _maplibreGL exists, and its queued ready
        // listener would otherwise re-add the abandoned layer later.
        if (typeof expectedLayer._createMaplibreLayer === "function" && !expectedLayer._maplibreGL) {
          expectedLayer.off("ready");
          expectedLayer.onRemove = () => {};
        }
        exportMap.removeLayer(expectedLayer);
      }
      exportBasemapColorLayer = L.tileLayer(FALLBACK_BASEMAP_URL, {
        attribution: "Esri, HERE, Garmin, USGS, &copy; OpenStreetMap contributors",
        minZoom: 0, maxZoom: 24, maxNativeZoom: 19,
        subdomains: "abc", crossOrigin: true, updateWhenIdle: true, keepBuffer: 1,
        className: "basemap-color-layer", pane: "basemapColorPane"
      }).addTo(exportMap);
    }

    function isOutsideExportStage(element) {
      // html2canvas clones the document before capturing the requested element.
      // Exclude the live application so its maps/images cannot delay the clone
      // or allocate a second copy of the interactive map during an export.
      const stage = document.getElementById("exportStage");
      return element.parentElement === document.body && element !== stage && !element.contains(stage)
        && !["STYLE", "LINK"].includes(element.tagName);
    }

    async function getExportFrameImage(item) {
      const displayStage = getOverlayStage(getStageValue(item?.entry));
      if (displayStage == null) throw new Error("Stage is not numeric for the selected hour.");
      const phase = getHydraulicPhaseForEntry(item.entry, item.index, item.series);
      // Resolve each frame before using the bounded URL cache. A rounded stage
      // is not an identity for a retained-water or physics forecast raster.
      const physicsRecord = currentOverlayMode === "depth"
        ? getPhysicsDisplayRecord(getPhysicsAssetForEntry(item.entry), "depth") : null;
      const record = physicsRecord
        || await getHydraulicOverlayRecord(currentOverlayMode, displayStage, phase, item.entry, item.series);
      if (!record?.url) throw new Error("The flood image is unavailable for the selected time.");
      const image = await getExportImageElement(record.url);
      throwIfExportCancelled();
      if (!image) throw new Error("The flood image could not load. Please try the export again.");
      return image;
    }

    function createStreamingGifEncoder(options, frameCount) {
      // The gif.js worker protocol emits a header for index 0 and a trailer for
      // the last frame. Encode one transferred RGBA buffer at a time, retaining
      // only compressed Blob parts instead of every full-resolution canvas.
      const worker = new Worker(options.workerScript);
      const parts = [];
      let nextIndex = 0;
      let globalPalette = options.globalPalette;
      let pending = null;
      let closed = false;
      const dispose = (error = new Error("GIF export was aborted.")) => {
        closed = true;
        worker.terminate();
        parts.length = 0;
        if (pending) {
          clearTimeout(pending.timer);
          const reject = pending.reject;
          pending = null;
          reject(error);
        }
      };
      worker.onerror = event => {
        event.preventDefault();
        dispose(new Error("GIF encoding failed. Please try the export again."));
      };
      worker.onmessageerror = () => dispose(new Error("Could not read the encoded GIF frame."));
      worker.onmessage = event => {
        if (!pending || closed) return;
        const frame = event.data;
        if (frame?.index !== nextIndex || !Array.isArray(frame.data) || !frame.data.length) {
          dispose(new Error("The GIF encoder returned an invalid frame."));
          return;
        }
        const pages = frame.data.map((page, index) => index === frame.data.length - 1
          ? page.subarray(0, frame.cursor) : page);
        parts.push(new Blob(pages));
        if (globalPalette === true) globalPalette = frame.globalPalette;
        nextIndex += 1;
        clearTimeout(pending.timer);
        const resolve = pending.resolve;
        pending = null;
        resolve();
      };
      return {
        abort: dispose,
        dispose,
        getGlobalPalette: () => globalPalette,
        async addFrame(canvas, { delay }) {
          throwIfExportCancelled();
          if (closed || pending || nextIndex >= frameCount) throw new Error("GIF encoder is not ready for another frame.");
          const context = canvas.getContext("2d");
          if (!context) throw new Error("Could not read the GIF frame.");
          const data = context.getImageData(0, 0, options.width, options.height).data;
          await new Promise((resolve, reject) => {
            pending = { resolve, reject, timer: setTimeout(() => {
              dispose(new Error("GIF encoding timed out. Please try the export again."));
            }, 120000) };
            try {
              worker.postMessage({
                index: nextIndex, last: nextIndex === frameCount - 1,
                width: options.width, height: options.height,
                quality: options.quality, dither: options.dither,
                globalPalette, repeat: 0,
                transparent: null, delay, canTransfer: true, data
              }, [data.buffer]);
            } catch (error) {
              dispose(error);
            }
          });
          throwIfExportCancelled();
        },
        finish() {
          if (closed || pending || nextIndex !== frameCount) throw new Error("The GIF export is incomplete.");
          return new Blob(parts, { type: "image/gif" });
        }
      };
    }

    let gifWorkerLoadRequest = null;

    function cancelGifWorkerLoad() {
      const request = gifWorkerLoadRequest;
      if (!request) return;
      gifWorkerLoadRequest = null;
      if (gifWorkerUrlPromise === request.promise) gifWorkerUrlPromise = null;
      request.controller.abort();
    }

    async function getGifWorkerUrl() {
      if (gifWorkerUrlPromise) return gifWorkerUrlPromise;
      const request = { controller: new AbortController(), promise: null };
      gifWorkerLoadRequest = request;
      request.promise = getSameOriginWorkerUrl(GIF_WORKER_URL, { signal: request.controller.signal }).then(url => {
        if (gifWorkerLoadRequest !== request || request.controller.signal.aborted) {
          URL.revokeObjectURL(url);
          throw makeExportCancelledError();
        }
        return url;
      }).catch(error => {
        if (gifWorkerUrlPromise === request.promise) gifWorkerUrlPromise = null;
        throw error;
      }).finally(() => {
        if (gifWorkerLoadRequest === request) gifWorkerLoadRequest = null;
      });
      gifWorkerUrlPromise = request.promise;
      return gifWorkerUrlPromise;
    }

    function downloadBlob(blob, filename) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }

