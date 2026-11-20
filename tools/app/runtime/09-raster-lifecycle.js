    function awaitRasterRequest(request) {
      // The decoded grid may be shared with the interactive map. Cancel only
      // this export's wait; the shared transport has its own bounded deadline.
      if (typeof exportInProgress === "undefined" || !exportInProgress) return request;
      return new Promise((resolve, reject) => {
        let settled = false;
        let timer = null;
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          if (timer !== null) window.clearInterval(timer);
          error ? reject(error) : resolve(value);
        };
        const cancel = () => {
          if (!exportCancelRequested) return;
          const error = new Error("Export cancelled.");
          error.name = "AbortError";
          finish(error);
        };
        timer = window.setInterval(cancel, 80);
        Promise.resolve(request).then(value => finish(null, value), error => finish(error));
        cancel();
      });
    }

    function getDrainageRasterImage(url) {
      if (!url) return Promise.resolve(null);
      if (drainageRasterImageCache.has(url)) return awaitRasterRequest(drainageRasterImageCache.get(url));
      const releaseRaster = retainRasterObjectUrl(url);
      const promise = new Promise(resolve => {
        const image = new Image();
        let settled = false;
        const timer = window.setTimeout(() => finish(null), 20000);
        const finish = value => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          image.onload = image.onerror = null;
          releaseRaster();
          if (!value) { try { image.src = ""; } catch (_) {} }
          resolve(value);
        };
        image.crossOrigin = "anonymous";
        image.decoding = "async";
        image.onload = () => finish(image);
        image.onerror = () => finish(null);
        image.src = url;
      }).then(image => {
        // A failed decode must not prevent the next request from retrying.
        if (!image && drainageRasterImageCache.get(url) === promise) {
          drainageRasterImageCache.delete(url);
        }
        return image;
      });
      drainageRasterImageCache.set(url, promise);
      while (drainageRasterImageCache.size > DRAINAGE_RASTER_IMAGE_CACHE_LIMIT) {
        drainageRasterImageCache.delete(drainageRasterImageCache.keys().next().value);
      }
      return awaitRasterRequest(promise);
    }

    function canvasToDrainageObjectUrl(canvas) {
      return new Promise((resolve, reject) => {
        canvas.toBlob(blob => {
          if (!blob) reject(new Error("Could not encode the retained drainage raster."));
          else {
            const url = URL.createObjectURL(blob);
            floodCompositeBlobSizes.set(url, blob.size);
            // Some palette converters also use this encoder; bound bookkeeping.
            while (floodCompositeBlobSizes.size > 256) {
              floodCompositeBlobSizes.delete(floodCompositeBlobSizes.keys().next().value);
            }
            resolve(url);
          }
        }, "image/png");
      });
    }

    // A cache eviction must not revoke an image still used by a renderer or decoder.
    const rasterObjectUrlUsers = new Map();
    const retiredRasterObjectUrls = new Set();
    let rasterObjectUrlCleanupTimer = null;

    function scheduleRasterObjectUrlCleanup() {
      if (rasterObjectUrlCleanupTimer !== null || !retiredRasterObjectUrls.size) return;
      // Let promise continuations hand a generated image to the next consumer.
      rasterObjectUrlCleanupTimer = window.setTimeout(() => {
        rasterObjectUrlCleanupTimer = null;
        for (const url of retiredRasterObjectUrls) {
          if (rasterObjectUrlUsers.has(url) || currentFloodLayer?._url === url || pendingFloodLayer?._url === url) continue;
          URL.revokeObjectURL(url);
          retiredRasterObjectUrls.delete(url);
          preloadPromiseCache.delete(url);
          drainageRasterImageCache.delete(url);
          exportImageElementCache.delete(url);
        }
      }, 0);
    }

    function retainRasterObjectUrl(url) {
      if (!url?.startsWith("blob:")) return () => {};
      rasterObjectUrlUsers.set(url, (rasterObjectUrlUsers.get(url) || 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const remaining = (rasterObjectUrlUsers.get(url) || 1) - 1;
        if (remaining) rasterObjectUrlUsers.set(url, remaining);
        else rasterObjectUrlUsers.delete(url);
        scheduleRasterObjectUrlCleanup();
      };
    }

    function retireRasterObjectUrl(url) {
      if (!url?.startsWith("blob:")) return;
      retiredRasterObjectUrls.add(url);
      scheduleRasterObjectUrlCleanup();
    }

    function cacheBathtubStageOverlay(key, record) {
      bathtubStageOverlayCache.set(key, record);
      while (bathtubStageOverlayCache.size > 48) {
        const oldestKey = bathtubStageOverlayCache.keys().next().value;
        const oldest = bathtubStageOverlayCache.get(oldestKey);
        retireRasterObjectUrl(oldest?.url);
        bathtubStageOverlayCache.delete(oldestKey);
      }
      return record;
    }

    function applyBathtubStagePixels(source, target, stageValue) {
      const stage = Number(stageValue);
      if (!source || !target || source.length !== target.length || !Number.isFinite(stage)) return 0;
      let wetPixels = 0;
      for (let offset = 0; offset < source.length; offset += 4) {
        const encodedGround = source[offset] * 256 + source[offset + 1];
        if (!encodedGround) continue;
        const groundFt = (encodedGround - 32768) / 10;
        if (!(groundFt < stage - 0.005)) continue;
        const color = groundFt < MINOR_FLOOD_FT
          ? DRAINAGE_STAGE_COLORS[0]
          : groundFt < MODERATE_FLOOD_FT
            ? DRAINAGE_STAGE_COLORS[1]
            : DRAINAGE_STAGE_COLORS[2];
        target[offset] = color[0];
        target[offset + 1] = color[1];
        target[offset + 2] = color[2];
        target[offset + 3] = 225;
        wetPixels += 1;
      }
      return wetPixels;
    }

    function applyStageUncertaintyPixels(depthPixels, stagePixels) {
      if (!depthPixels || !stagePixels || depthPixels.length !== stagePixels.length) {
        throw new Error("Flood Depth and Flood Stages raster sizes do not match.");
      }
      let uncertainPixels = 0;
      for (let offset = 0; offset < depthPixels.length; offset += 4) {
        if (!isDisconnectedRasterPixel(depthPixels, offset)) continue;
        stagePixels[offset] = depthPixels[offset];
        stagePixels[offset + 1] = depthPixels[offset + 1];
        stagePixels[offset + 2] = depthPixels[offset + 2];
        stagePixels[offset + 3] = depthPixels[offset + 3];
        uncertainPixels += 1;
      }
      return uncertainPixels;
    }

    async function getBathtubStageOverlayRecord(stageValue, depthRecord = null) {
      const stage = Number(stageValue);
      if (!Number.isFinite(stage)) return null;
      // Equal water levels can have different uncertainty after filling/drainage.
      // The resolved depth-frame URL identifies the exact mask to reuse.
      const key = JSON.stringify([stageToCode(stage), depthRecord?.url || "no-uncertainty"]);
      const cache = bathtubStageOverlayCache;
      if (cache.has(key)) return awaitRasterRequest(cache.get(key));
      const releaseDepth = retainRasterObjectUrl(depthRecord?.url);
      const request = (async () => {
        try {
          const [queryGrid, depthImage] = await Promise.all([
            getDepthQueryGrid(),
            depthRecord ? getDrainageRasterImage(depthRecord.url) : null
          ]);
          if (!queryGrid?.values || !queryGrid.width || !queryGrid.height) return null;
          if (depthRecord && (!depthImage || depthImage.naturalWidth !== queryGrid.width ||
              depthImage.naturalHeight !== queryGrid.height)) {
            throw new Error("Flood Depth uncertainty raster is unavailable or its grid does not match Flood Stages.");
          }
          const canvas = document.createElement("canvas");
          canvas.width = queryGrid.width;
          canvas.height = queryGrid.height;
          const context = canvas.getContext("2d", { willReadFrequently: true });
          if (!context) return null;
          const imageData = context.createImageData(canvas.width, canvas.height);
          applyBathtubStagePixels(queryGrid.values, imageData.data, stage);
          let uncertainPixelCount = 0;
          if (depthImage) {
            context.drawImage(depthImage, 0, 0);
            const depthPixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
            uncertainPixelCount = applyStageUncertaintyPixels(depthPixels, imageData.data);
          }
          context.putImageData(imageData, 0, 0);
          return {
            url: await canvasToDrainageObjectUrl(canvas),
            filename: `${TOWN_CONFIG.overlays.bathtubStagePngPrefix ?? TOWN_CONFIG.overlays.stagePngPrefix}${stageToCode(stage)}.png`,
            isBathtubStage: true,
            uncertainPixelCount
          };
        } finally {
          releaseDepth();
        }
      })().catch(error => {
        if (error?.name === "AbortError" || error?.name === "TimeoutError") {
          if (cache.get(key) === request) cache.delete(key);
          throw error;
        }
        console.warn("Could not build Flood Stages with its Flood Depth uncertainty areas.", error);
        return null;
      });
      cache.set(key, request);
      const record = await awaitRasterRequest(request);
      if (cache !== bathtubStageOverlayCache) {
        retireRasterObjectUrl(record?.url);
        return null;
      }
      if (!record) {
        cache.delete(key);
        return null;
      }
      return cacheBathtubStageOverlay(key, record);
    }

    function cacheRasterComposite(cache, key, record, limit) {
      if (typeof floodCompositeBlobSizes !== "undefined" && record?.url && floodCompositeBlobSizes.has(record.url)) {
        record.compositeByteLength = floodCompositeBlobSizes.get(record.url);
        floodCompositeBlobSizes.delete(record.url);
      }
      cache.set(key, record);
      while (
        cache.size > limit ||
        (cache.size > 1 &&
          Array.from(cache.values()).reduce((bytes, item) => bytes + (item?.compositeByteLength || 0), 0) >
            (typeof FLOOD_COMPOSITE_CACHE_BYTE_LIMIT === "number" ? FLOOD_COMPOSITE_CACHE_BYTE_LIMIT : 128 * 1024 * 1024))
      ) {
        const oldestKey = cache.keys().next().value;
        retireRasterObjectUrl(cache.get(oldestKey)?.url);
        cache.delete(oldestKey);
      }
    }

    function getCachedRasterComposite(cache, key, limit, fallback, build, warning) {
      if (cache.has(key)) {
        const cached = cache.get(key);
        cache.delete(key);
        cache.set(key, cached);
        return awaitRasterRequest(cached);
      }

      const request = build().then(record => {
        if (cache.get(key) === request) {
          // Missing inputs are temporary. Cache a valid unchanged raster or
          // completed composite, and let the next selection retry a fallback.
          if (record) cacheRasterComposite(cache, key, record, limit);
          else cache.delete(key);
        } else if (record && record !== fallback) {
          retireRasterObjectUrl(record.url);
        }
        return record || fallback;
      }, error => {
        if (cache.get(key) === request) cache.delete(key);
        if (error?.name === "AbortError" || error?.name === "TimeoutError") throw error;
        console.warn(warning, error);
        return fallback;
      });
      cache.set(key, request);
      return awaitRasterRequest(request);
    }

    async function getFillingInterpolatedOverlayRecord(
      mode,
      lowerStageFt,
      phase,
      entry,
      lowerRecord
    ) {
      const rawStageFt = getStageValue(entry);
      const fraction = getFillingStageFraction(rawStageFt, lowerStageFt);
      const normalizedPhase = normalizeHydraulicPhase(phase);
      if (!lowerRecord || !(fraction > 1e-6) || fraction >= 1 - 1e-6 ||
          (normalizedPhase !== "filling" && normalizedPhase !== "slack")) return lowerRecord;
      const upperStageFt = roundToCatalogPrecision(Math.min(MAX_STAGE, lowerStageFt + STAGE_STEP));
      if (!(upperStageFt > lowerStageFt)) return lowerRecord;
      const key = [
        mode,
        normalizedPhase,
        Number(rawStageFt).toFixed(3),
        stageToCode(lowerStageFt),
        stageToCode(upperStageFt)
      ].join("|");
      return getCachedRasterComposite(fillingCompositeCache, key, FILLING_COMPOSITE_CACHE_LIMIT, lowerRecord, async () => {
        const upperRequest = getOverlayRecord(mode, upperStageFt, normalizedPhase);
        const depthRequest = mode === "depth"
          ? upperRequest
          : getOverlayRecord("depth", upperStageFt, normalizedPhase);
        const [upperRecord, depthRecord] = await Promise.all([upperRequest, depthRequest]);
        if (!upperRecord || !depthRecord) return null;
        const [lowerImage, upperImage, depthImage, developedGrid, queryGrid] = await Promise.all([
          getDrainageRasterImage(lowerRecord.url),
          getDrainageRasterImage(upperRecord.url),
          getDrainageRasterImage(depthRecord.url),
          getDevelopedQueryGrid(),
          getDepthQueryGrid()
        ]);
        if (!lowerImage || !upperImage || !depthImage || !developedGrid || !queryGrid) return null;
        const width = lowerImage.naturalWidth;
        const height = lowerImage.naturalHeight;
        if (upperImage.naturalWidth !== width || upperImage.naturalHeight !== height ||
            depthImage.naturalWidth !== width || depthImage.naturalHeight !== height ||
            developedGrid.width !== width || developedGrid.height !== height ||
            queryGrid.width !== width || queryGrid.height !== height) {
          console.warn("Filling interpolation skipped because its raster grids do not match.");
          return null;
        }

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) return null;
        context.drawImage(lowerImage, 0, 0);
        const lowerImageData = context.getImageData(0, 0, width, height);
        context.clearRect(0, 0, width, height);
        context.drawImage(upperImage, 0, 0);
        const upperPixels = context.getImageData(0, 0, width, height).data;
        let depthPixels = upperPixels;
        if (depthImage !== upperImage) {
          context.clearRect(0, 0, width, height);
          context.drawImage(depthImage, 0, 0);
          depthPixels = context.getImageData(0, 0, width, height).data;
        }
        const addedPixelCount = applyFillingTransitionPixels(
          lowerImageData.data,
          upperPixels,
          developedGrid.values,
          width,
          height,
          rawStageFt,
          lowerStageFt,
          mode,
          depthPixels,
          queryGrid.values
        );
        if (!addedPixelCount) return lowerRecord;
        context.putImageData(lowerImageData, 0, 0);
        const url = await canvasToDrainageObjectUrl(canvas);
        return {
          ...lowerRecord,
          url,
          isContinuousFillingComposite: true,
          fillingFraction: fraction,
          addedPixelCount
        };
      }, "Could not build the continuous filling raster; using the lower catalog raster.");
    }

    async function getHydraulicOverlayRecord(mode, stageValue, phase, entry = null, series = currentRawSeriesHours) {
      let releaseRaster = null;
      try {
        if (mode === "dynamic") {
          // Physics depth has no green mask. Never substitute a static mask for it.
          if (getPhysicsDisplayRecord(getPhysicsAssetForEntry(entry), "depth")?.url) {
            return getBathtubStageOverlayRecord(stageValue);
          }
          const depthRecord = await getHydraulicOverlayRecord("depth", stageValue, phase, entry, series);
          if (!depthRecord?.url) return null;
          return getBathtubStageOverlayRecord(stageValue, depthRecord);
        }
        let baseRecord = await getOverlayRecord(mode, stageValue, phase);
        if (!baseRecord || !entry) return baseRecord;
        baseRecord = await getFillingInterpolatedOverlayRecord(
          mode,
          stageValue,
          phase,
          entry,
          baseRecord
        );
        releaseRaster = retainRasterObjectUrl(baseRecord?.url);
        const milestones = getDrainageRetentionMilestones(entry, series);
        if (!milestones.length) return baseRecord;

        const key = [
          mode,
          stageToCode(stageValue),
          normalizeHydraulicPhase(phase),
          entryTimeMs(entry), getStageValue(entry),
          ...milestones.map(item => `${entryTimeMs(item)}:${normalizeHydraulicPhase(item.hydraulicPhase)}:${stageToCode(getOverlayStage(getStageValue(item)))}:${getStageValue(item)}`)
        ].join("|");
        return await getCachedRasterComposite(drainageCompositeCache, key, DRAINAGE_COMPOSITE_CACHE_LIMIT, baseRecord, async () => {
          const historicalRecords = await Promise.all(milestones.map(item => {
            const itemStage = getOverlayStage(getStageValue(item));
            return itemStage == null
              ? Promise.resolve(null)
              : getOverlayRecord(mode, itemStage, getHydraulicPhaseForEntry(item, null, series));
          }));
          // The first milestone supplies the crest footprint. An incomplete
          // history must not be cached as if every hydraulic input was available.
          if (historicalRecords.some(record => !record)) return null;

          const [baseImage, queryGrid, ...historyImages] = await Promise.all([
            getDrainageRasterImage(baseRecord.url),
            getDepthQueryGrid(),
            ...historicalRecords.map(record => getDrainageRasterImage(record.url))
          ]);
          if (!baseImage || !queryGrid || historyImages.some(image => !image)) return null;
          if (baseImage.naturalWidth !== queryGrid.width || baseImage.naturalHeight !== queryGrid.height ||
              historyImages.some(image => image.naturalWidth !== queryGrid.width || image.naturalHeight !== queryGrid.height)) {
            console.warn("Drainage retention skipped because its raster grids do not match.");
            return null;
          }

          const canvas = document.createElement("canvas");
          canvas.width = baseImage.naturalWidth;
          canvas.height = baseImage.naturalHeight;
          const context = canvas.getContext("2d", { willReadFrequently: true });
          if (!context) return null;
          context.drawImage(baseImage, 0, 0);
          const currentImageData = context.getImageData(0, 0, canvas.width, canvas.height);
          const historicalPixelSets = historyImages.map(image => {
            context.clearRect(0, 0, canvas.width, canvas.height);
            context.drawImage(image, 0, 0);
            return context.getImageData(0, 0, canvas.width, canvas.height).data;
          });
          const addedPixelCount = applyDrainageRetentionPixels(
            currentImageData.data,
            historicalPixelSets,
            queryGrid.values,
            stageValue,
            mode
          );
          if (!addedPixelCount) return baseRecord;
          context.putImageData(currentImageData, 0, 0);
          const url = await canvasToDrainageObjectUrl(canvas);
          return {
            ...baseRecord,
            url,
            isHistoryAwareDrainageComposite: true,
            retainedPixelCount: addedPixelCount
          };
        }, "Could not build the history-aware drainage raster; using the static phase raster.");
      } finally {
        releaseRaster?.();
      }
    }

