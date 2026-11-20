    async function testImageUrl(url) {
      if (!url) return { ok: false };
      if (exportCancelRequested) return { ok: false, cancelled: true };
      if (imageExistsCache.has(url)) return imageExistsCache.get(url);
      const request = new Promise(resolve => {
        const img = new Image();
        let settled = false;
        let cancelTimer = null;
        let timeoutTimer = null;
        const done = value => {
          if (settled) return;
          settled = true;
          if (cancelTimer) window.clearInterval(cancelTimer);
          if (timeoutTimer) window.clearTimeout(timeoutTimer);
          resolve(value);
        };
        const cancelIfRequested = () => {
          if (!exportCancelRequested) return false;
          imageExistsCache.delete(url);
          img.onload = null;
          img.onerror = null;
          try { img.src = ""; } catch (_) {}
          done({ ok: false, cancelled: true });
          return true;
        };
        if (cancelIfRequested()) return;
        if (exportInProgress) cancelTimer = window.setInterval(cancelIfRequested, 80);
        img.crossOrigin = "anonymous";
        img.fetchPriority = "high";
        img.onload = () => done({ ok: true });
        img.onerror = () => done({ ok: false });
        timeoutTimer = window.setTimeout(() => done({ ok: false }), 20000);
        img.src = url;
      });
      imageExistsCache.set(url, request);
      const result = await request;
      if (imageExistsCache.get(url) === request) {
        if (!result.ok) imageExistsCache.delete(url);
        else imageExistsCache.set(url, result);
      }
      return result;
    }

    function preloadImage(url, priority = "low") {
      if (!url) return Promise.resolve(null);
      if (preloadPromiseCache.has(url)) return preloadPromiseCache.get(url);

      const releaseRaster = retainRasterObjectUrl(url);
      const promise = new Promise(resolve => {
        const img = new Image();
        let settled = false;
        let cancelTimer = null;
        let timeoutTimer = null;
        const done = value => {
          if (settled) return;
          settled = true;
          releaseRaster();
          if (cancelTimer) window.clearInterval(cancelTimer);
          if (timeoutTimer) window.clearTimeout(timeoutTimer);
          img.onload = null;
          img.onerror = null;
          if (!value) { try { img.src = ""; } catch (_) {} }
          resolve(value);
        };
        const cancelIfRequested = () => {
          if (!exportCancelRequested) return false;
          preloadPromiseCache.delete(url);
          img.onload = null;
          img.onerror = null;
          try { img.src = ""; } catch (_) {}
          done(null);
          return true;
        };
        if (cancelIfRequested()) return;
        if (exportInProgress) cancelTimer = window.setInterval(cancelIfRequested, 80);
        img.crossOrigin = "anonymous";
        img.decoding = "async";
        img.fetchPriority = priority === "high" ? "high" : "low";
        img.onload = async () => done(await decodeFloodFrameImage(img) ? url : null);
        img.onerror = () => done(null);
        timeoutTimer = window.setTimeout(() => done(null), 20000);
        img.src = url;
      });

      preloadPromiseCache.set(url, promise);
      promise.then(result => {
        if (!result && preloadPromiseCache.get(url) === promise) preloadPromiseCache.delete(url);
      });
      return promise;
    }

    // Retain encoded composites for replay; decoded raster caches stay small.
    const FLOOD_COMPOSITE_CACHE_COMPACT = isCompactFloodmapperLayout();
    const FLOOD_COMPOSITE_CACHE_ENTRY_LIMIT = FLOOD_COMPOSITE_CACHE_COMPACT ? 16 : 48;
    const FLOOD_COMPOSITE_CACHE_BYTE_LIMIT = (FLOOD_COMPOSITE_CACHE_COMPACT ? 24 : 128) * 1024 * 1024;
    const floodCompositeBlobSizes = new Map();

    const RASTER_IMAGE_CACHE_LIMIT = isCompactFloodmapperLayout() ? 2 : 4;
    function getExportImageElement(url) {
      if (!url) return Promise.resolve(null);
      if (exportCancelRequested) return Promise.resolve(null);
      if (exportImageElementCache.has(url)) {
        const cached = exportImageElementCache.get(url);
        exportImageElementCache.delete(url);
        exportImageElementCache.set(url, cached);
        return cached;
      }
      const releaseRaster = retainRasterObjectUrl(url);
      const promise = new Promise(resolve => {
        const img = new Image();
        let settled = false;
        let cancelTimer = null;
        let timeoutTimer = null;
        const done = value => {
          if (settled) return;
          settled = true;
          releaseRaster();
          if (cancelTimer) window.clearInterval(cancelTimer);
          if (timeoutTimer) window.clearTimeout(timeoutTimer);
          resolve(value);
        };
        const cancelIfRequested = () => {
          if (!exportCancelRequested) return false;
          exportImageElementCache.delete(url);
          img.onload = null;
          img.onerror = null;
          try { img.src = ""; } catch (_) {}
          done(null);
          return true;
        };
        if (cancelIfRequested()) return;
        cancelTimer = window.setInterval(cancelIfRequested, 80);
        img.decoding = "async";
        img.loading = "eager";
        img.fetchPriority = "high";
        img.crossOrigin = "anonymous";
        img.onload = () => done(img);
        img.onerror = () => done(null);
        timeoutTimer = window.setTimeout(() => done(null), 20000);
        img.src = url;
      });
      exportImageElementCache.set(url, promise);
      while (exportImageElementCache.size > RASTER_IMAGE_CACHE_LIMIT) {
        exportImageElementCache.delete(exportImageElementCache.keys().next().value);
      }
      promise.then(result => {
        if (!result && exportImageElementCache.get(url) === promise) exportImageElementCache.delete(url);
      });
      return promise;
    }

    async function findWorkingOverlay(mode, stageValue, family = "crest") {
      const candidates = getOverlayCandidates(mode, stageValue, family);
      for (const url of candidates) {
        throwIfExportCancelled();
        const exists = await testImageUrl(url);
        throwIfExportCancelled();
        if (exists.ok) {
          return { url, filename: url.split('/').pop() || getOverlayFilename(mode, stageValue) };
        }
      }
      throwIfExportCancelled();
      return null;
    }

    async function getOverlayRecord(mode, stageValue, phase = "slack") {
      const normalizedPhase = normalizeHydraulicPhase(phase);
      const key = `${mode}:${normalizedPhase}:${stageToCode(stageValue)}`;
      if (exportCancelRequested) throwIfExportCancelled();
      if (overlayRecordCache.has(key)) return overlayRecordCache.get(key);
      const request = findWorkingOverlay(mode, stageValue, normalizedPhase);
      overlayRecordCache.set(key, request);
      try {
        const match = await request;
        throwIfExportCancelled();
        if (overlayRecordCache.get(key) === request) {
          if (match) overlayRecordCache.set(key, match);
          else overlayRecordCache.delete(key);
        }
        return match;
      } catch (error) {
        if (overlayRecordCache.get(key) === request) overlayRecordCache.delete(key);
        throw error;
      }
    }

    const DRAINAGE_DEPTH_BREAKS_FT = [0.10, 0.25, 0.50, 1.00, 1.50, 2.00, 2.50, 3.00, 4.00, 5.00];
    const DRAINAGE_DEPTH_COLORS = [
      [125, 249, 255], [93, 231, 255], [56, 211, 255], [27, 183, 245],
      [22, 140, 235], [21, 107, 224], [24, 83, 198], [23, 62, 168],
      [19, 47, 132], [11, 30, 91], [5, 14, 51]
    ];
    const DRAINAGE_STAGE_COLORS = [
      [244, 167, 66], [231, 76, 60], [125, 60, 152]
    ];
    const DRAINAGE_RASTER_IMAGE_CACHE_LIMIT = 4;
    const FILLING_COMPOSITE_CACHE_LIMIT = FLOOD_COMPOSITE_CACHE_ENTRY_LIMIT;
    const DRAINAGE_COMPOSITE_CACHE_LIMIT = FLOOD_COMPOSITE_CACHE_ENTRY_LIMIT;

