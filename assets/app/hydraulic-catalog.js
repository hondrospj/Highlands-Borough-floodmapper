// Readers for the supported hydraulic catalog and observation formats.
// Town-specific paths, elevations, and palettes come from the local config.
function createHydraulicCatalogAdapter(format, palette = {}) {

  let hydraulicQueryGridPromise = null;

  let developedQueryGridPromise = null;

  let hydraulicRenderQueue = Promise.resolve();

  const RASTER_COMPOSITE_CACHE_LIMIT = FLOOD_COMPOSITE_CACHE_ENTRY_LIMIT;

  const RASTER_STRIPE_ROWS = 64;

  function getBunnyAssetUrl(value) {
      if (!value) return value;
      const url = new URL(value, APP_BASE);
      if (!url.href.startsWith(APP_BASE.href)) return url.href;
      const path = decodeURIComponent(url.pathname.slice(APP_BASE.pathname.length));
      const assets = window.SHORELYSAFE_BUNNY_ASSETS;
      const object = assets?.files?.[path];
      return object ? assets.base + object : url.href;
    }
  function clampStage(value) {
      return Math.max(MIN_STAGE, Math.min(MAX_STAGE, value));
    }
  function roundToOneDecimal(value) {
      return Number(value.toFixed(1));
    }
  function floorToCatalogStep(value) {
      const stepped = Math.floor((value + 1e-9) / STAGE_STEP) * STAGE_STEP;
      return roundToOneDecimal(stepped);
    }
  function getOverlayStage(value) {
      const stage = normalizeStageValue(value);
      if (stage == null) return null;
      return Math.max(MIN_DEPTH_STAGE, floorToCatalogStep(Math.max(MIN_DEPTH_STAGE, Math.min(MAX_STAGE, stage))));
    }

  function getVerticalBathtubPenalty(stageValue) {
      const stage = Number(stageValue);
      if (!Number.isFinite(stage)) return null;
      if (stage < MINOR_FLOOD_FT) return 0;
      if (stage >= MAJOR_FLOOD_FT) return MAJOR_VERTICAL_PENALTY_FT;
      const x0 = MINOR_FLOOD_FT;
      const x1 = MODERATE_FLOOD_FT;
      const x2 = MAJOR_FLOOD_FT;
      const l0 = ((stage - x1) * (stage - x2)) / ((x0 - x1) * (x0 - x2));
      const l1 = ((stage - x0) * (stage - x2)) / ((x1 - x0) * (x1 - x2));
      const l2 = ((stage - x0) * (stage - x1)) / ((x2 - x0) * (x2 - x1));
      return Math.max(0,
        MINOR_VERTICAL_PENALTY_FT * l0 +
        MODERATE_VERTICAL_PENALTY_FT * l1 +
        MAJOR_VERTICAL_PENALTY_FT * l2
      );
    }
  function normalizeHydraulicPhase(value) {
      const phase = String(value || "").toLowerCase();
      const supported = new Set([
        "filling",
        "slack",
        "draining-release-15",
        "draining-release-30",
        "draining"
      ]);
      return supported.has(phase) ? phase : "slack";
    }
  function getPenaltyRemainingFraction(stageValue, phase = "slack") {
      const stage = Number(stageValue);
      const normalizedPhase = normalizeHydraulicPhase(phase);
      const penalty = getVerticalBathtubPenalty(stage);
      if (!Number.isFinite(penalty) || penalty <= 0 || normalizedPhase === "draining") return 0;
      if (normalizedPhase === "filling" || normalizedPhase === "slack") return 1;
      if (normalizedPhase === "draining-release-15") {
        return stage < MODERATE_FLOOD_FT ? 2 / 3 : 1 / 2;
      }
      if (normalizedPhase === "draining-release-30") {
        return stage < MODERATE_FLOOD_FT ? 1 / 3 : 0;
      }
      return 0;
    }
  function getPenaltyAdjustedOverlayStage(stageValue, phase = "slack") {
      const stage = Number(stageValue);
      const penalty = getVerticalBathtubPenalty(stage);
      if (!Number.isFinite(stage) || !Number.isFinite(penalty)) return null;
      return getOverlayStage(stage - penalty * getPenaltyRemainingFraction(stage, phase));
    }
  function getPenalizedWaterSurfaceStage(stageValue, phase = "slack") {
      const stage = Number(stageValue);
      const normalizedPhase = normalizeHydraulicPhase(phase);
      const penalty = getVerticalBathtubPenalty(stage);
      if (!Number.isFinite(stage) || !Number.isFinite(penalty)) return null;
      if (normalizedPhase.startsWith("draining")) return stage;
      return stage - penalty * getPenaltyRemainingFraction(stage, normalizedPhase);
    }
  function getHydraulicFrameMinutes(entry, fallback = 15) {
      const explicitMinutes = Number(entry?.timelineIntervalMinutes);
      if (Number.isFinite(explicitMinutes) && explicitMinutes > 0) return explicitMinutes;
      if (entry?.observationInterval === "15min") return 15;
      if (entry?.observationInterval === "1hour") return 60;
      return fallback;
    }
  function findHydraulicCrestIndex(series = [], resolvedIndex = 0) {
      const rows = Array.isArray(series) ? series : [];
      if (!rows.length) return -1;
      const safeIndex = Math.max(0, Math.min(Number(resolvedIndex) || 0, rows.length - 1));
      const currentTime = entryTimeMs(rows[safeIndex]);
      const maximumLookbackMinutes = 8 * 60;
      const separatingDropFt = 0.4;
      let crestIndex = safeIndex;
      let crestStage = getStageValue(rows[safeIndex]);

      for (let candidate = safeIndex - 1; candidate >= 0; candidate -= 1) {
        const candidateTime = entryTimeMs(rows[candidate]);
        if (Number.isFinite(currentTime) && Number.isFinite(candidateTime) &&
            currentTime - candidateTime > maximumLookbackMinutes * 60 * 1000) break;
        if (!Number.isFinite(currentTime) && safeIndex - candidate > 32) break;
        const candidateStage = getStageValue(rows[candidate]);
        if (!Number.isFinite(candidateStage)) continue;
        if (!Number.isFinite(crestStage) || candidateStage > crestStage + 1e-9 ||
            (Math.abs(candidateStage - crestStage) <= 1e-9 && candidate > crestIndex)) {
          crestStage = candidateStage;
          crestIndex = candidate;
        } else if (candidate < crestIndex && candidateStage < crestStage - separatingDropFt) {
          break;
        }
      }
      return crestIndex;
    }
  function getHydraulicElapsedMinutes(rows, crestIndex, resolvedIndex) {
      const crestTime = entryTimeMs(rows[crestIndex]);
      const currentTime = entryTimeMs(rows[resolvedIndex]);
      if (Number.isFinite(crestTime) && Number.isFinite(currentTime)) {
        return Math.max(0, (currentTime - crestTime) / 60000);
      }
      return Math.max(0, resolvedIndex - crestIndex) * getHydraulicFrameMinutes(rows[resolvedIndex]);
    }
  function inferHydraulicPhaseForIndex(series = [], index = 0) {
      const rows = Array.isArray(series) ? series : [];
      if (!rows.length) return "slack";
      const resolvedIndex = Math.max(0, Math.min(Number(index) || 0, rows.length - 1));
      const current = getStageValue(rows[resolvedIndex]);
      const previous = resolvedIndex > 0 ? getStageValue(rows[resolvedIndex - 1]) : null;
      const next = resolvedIndex + 1 < rows.length ? getStageValue(rows[resolvedIndex + 1]) : null;
      const before = Number.isFinite(current) && Number.isFinite(previous) ? current - previous : null;
      const after = Number.isFinite(next) && Number.isFinite(current) ? next - current : null;
      const epsilon = 0.025;

      if (Number.isFinite(before) && Number.isFinite(after) && before > epsilon && after <= epsilon) return "slack";
      if (Number.isFinite(before) && Number.isFinite(after) && before >= 0 && after < -epsilon) return "slack";
      if (Number.isFinite(before) && Number.isFinite(after) && before < -epsilon && after >= -epsilon) return "draining";
      if (Number.isFinite(before) && Number.isFinite(after) && before <= epsilon && after > epsilon) {
        return before < 0 ? "draining" : "slack";
      }

      const falling = (Number.isFinite(before) && before < -epsilon) ||
        (Number.isFinite(after) && after < -epsilon && Number.isFinite(before) && before < 0);
      if (falling) {
        const crestIndex = findHydraulicCrestIndex(rows, resolvedIndex);
        const crestStage = getStageValue(rows[crestIndex]);
        const minutesSinceCrest = getHydraulicElapsedMinutes(rows, crestIndex, resolvedIndex);
        if (crestStage < MINOR_FLOOD_FT || crestStage >= MAJOR_FLOOD_FT) return "draining";
        if (crestStage >= MODERATE_FLOOD_FT) {
          return minutesSinceCrest <= 15 ? "draining-release-15" : "draining";
        }
        if (minutesSinceCrest <= 15) return "draining-release-15";
        if (minutesSinceCrest <= 30) return "draining-release-30";
        return "draining";
      }

      const delta = Number.isFinite(after) && (!Number.isFinite(before) || Math.abs(after) >= Math.abs(before))
        ? after
        : before;
      if (Number.isFinite(delta) && delta > epsilon) return "filling";
      if (Number.isFinite(delta) && delta < -epsilon) return "draining";
      return "slack";
    }
  function getHydraulicPhaseForEntry(entry, index = null, series = currentSeriesHours) {
      if (entry?.hydraulicPhaseCanonical && entry?.hydraulicPhase) {
        return normalizeHydraulicPhase(entry.hydraulicPhase);
      }
      const rows = Array.isArray(series) ? series : [];
      let resolvedIndex = Number.isInteger(index) ? index : rows.indexOf(entry);
      if (resolvedIndex < 0 && entry) resolvedIndex = findClosestEntryIndex(rows, entry);
      if (resolvedIndex < 0) return entry?.hydraulicPhase
        ? normalizeHydraulicPhase(entry.hydraulicPhase)
        : "slack";
      return inferHydraulicPhaseForIndex(rows, resolvedIndex);
    }
  function annotateHydraulicSeries(series = []) {
      const rows = (Array.isArray(series) ? series : []).map(entry => ({ ...entry }));
      return rows.map((entry, index) => {
        const phase = Number.isFinite(getStageValue(entry))
          ? inferHydraulicPhaseForIndex(rows, index)
          : "slack";
        const annotated = {
          ...entry,
          hydraulicPhase: phase,
          hydraulicPhaseCanonical: true
        };
        if (!phase.startsWith("draining")) return annotated;
        const crestIndex = findHydraulicCrestIndex(rows, index);
        const crestEntry = rows[crestIndex];
        return {
          ...annotated,
          hydraulicCrestIndex: crestIndex,
          hydraulicCrestTimeUtc: Number.isFinite(entryTimeMs(crestEntry))
            ? new Date(entryTimeMs(crestEntry)).toISOString()
            : null,
          hydraulicCrestStageFt: getStageValue(crestEntry),
          hydraulicElapsedMinutes: getHydraulicElapsedMinutes(rows, crestIndex, index)
        };
      });
    }
  function stageToCode(stageValue) {
      const n = Number(stageValue);
      const sign = n < 0 ? "m" : "p";
      const tenths = Math.round(Math.abs(n) * 10);
      return `${sign}${String(tenths).padStart(3, "0")}`;
    }
  function getOverlayFilename(mode, stageValue) {
      const code = stageToCode(stageValue);
      if (mode === "depth") return `${SITE_CONFIG.depthPngPrefix}${code}.png`;
      return `${SITE_CONFIG.stagePngPrefix}${code}.png`;
    }
  function getOverlayFilenameCandidates(mode, stageValue) {
      const png = getOverlayFilename(mode, stageValue);
      return [png.replace(/\.png$/, ".webp"), png];
    }
  const getOverlayCandidates =
    format === "phase-v2" || format === "phase-v2-sparse"
      ? (function getOverlayCandidates(mode, stageValue, phase = "slack") {
      const normalizedPhase = normalizeHydraulicPhase(phase);
      const phaseRoots = OVERLAY_PHASE_ROOTS?.[mode]?.[normalizedPhase] || [];
      const roots = phaseRoots.length ? phaseRoots : (OVERLAY_ROOTS[mode] || []);
      const filenames = getOverlayFilenameCandidates(mode, stageValue);
      const urls = roots.flatMap(root => filenames.map(name => new URL(name, root).href));
      // Identical phase frames share one CDN URL and one decoded-image cache key.
      // Keep the existing local formats as a fallback if the CDN is unavailable.
      return [...new Set(urls.flatMap(url => [getBunnyAssetUrl(url), url]))];
    })
    : (function getOverlayCandidates(mode, stageValue, phase = "slack") {
      const normalizedPhase = normalizeHydraulicPhase(phase);
      const phaseRoots = OVERLAY_PHASE_ROOTS?.[mode]?.[normalizedPhase] || [];
      const roots = phaseRoots.length ? phaseRoots : (OVERLAY_ROOTS[mode] || []);
      const filenames = getOverlayFilenameCandidates(mode, stageValue);
      return roots.flatMap(root => filenames.map(name => new URL(name, root).href));
    });

  async function findWorkingOverlay(mode, stageValue, phase = "slack") {
      const candidates = getOverlayCandidates(mode, stageValue, phase);
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
  async function getCachedAtlasRecord(key, load) {
      if (overlayRecordCache.has(key)) return overlayRecordCache.get(key);
      const request = load();
      overlayRecordCache.set(key, request);
      try {
        const record = await request;
        throwIfExportCancelled();
        if (overlayRecordCache.get(key) === request) {
          if (record) overlayRecordCache.set(key, record);
          else overlayRecordCache.delete(key);
        }
        return record;
      } catch (error) {
        if (overlayRecordCache.get(key) === request) overlayRecordCache.delete(key);
        throw error;
      }
    }

  async function getBaseOverlayRecord(mode, stageValue) {
      throwIfExportCancelled();
      const key = `base:${mode}:${stageToCode(stageValue)}`;
      return getCachedAtlasRecord(key, () => findWorkingOverlay(mode, stageValue));
    }

  function getUncertaintyRasterColor() {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return [0, 255, 0, 255];
      const configured = getComputedStyle(document.documentElement)
        .getPropertyValue("--below")
        .trim();
      context.fillStyle = configured || "#00ff00";
      context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data);
    }
  function isUncertaintyRasterPixel(values, offset, uncertaintyRgba) {
      return values[offset + 3] > 8 &&
        Math.abs(values[offset] - uncertaintyRgba[0]) <= 8 &&
        Math.abs(values[offset + 1] - uncertaintyRgba[1]) <= 8 &&
        Math.abs(values[offset + 2] - uncertaintyRgba[2]) <= 8;
    }
  function isWetRasterPixel(values, offset, uncertaintyRgba) {
      return values[offset + 3] > 8 &&
        !isUncertaintyRasterPixel(values, offset, uncertaintyRgba);
    }
  const canvasToFillingObjectUrl =
    format === "phase-v2" || format === "phase-v2-sparse"
      ? (function canvasToFillingObjectUrl(canvas) {
      return new Promise((resolve, reject) => {
        canvas.toBlob(blob => {
          // Safari can retain a detached canvas backing store until explicitly reset.
          canvas.width = canvas.height = 0;
          if (!blob) {
            reject(new Error("The connectivity composite could not be encoded."));
            return;
          }
          const url = URL.createObjectURL(blob);
          floodCompositeBlobSizes.set(url, blob.size);
          // Some palette converters also use this encoder; bound bookkeeping.
          while (floodCompositeBlobSizes.size > 256) {
            floodCompositeBlobSizes.delete(floodCompositeBlobSizes.keys().next().value);
          }
          resolve(url);
        }, "image/png");
      });
    })
    : (function canvasToFillingObjectUrl(canvas) {
      return new Promise((resolve, reject) => {
        canvas.toBlob(blob => {
          if (!blob) {
            reject(new Error("The connectivity composite could not be encoded."));
            return;
          }
          const url = URL.createObjectURL(blob);
          floodCompositeBlobSizes.set(url, blob.size);
          // Some palette converters also use this encoder; bound bookkeeping.
          while (floodCompositeBlobSizes.size > 256) {
            floodCompositeBlobSizes.delete(floodCompositeBlobSizes.keys().next().value);
          }
          resolve(url);
        }, "image/png");
      });
    });

  const cacheFillingComposite =
    format === "phase-v2" || format === "phase-v2-sparse"
      ? (function cacheFillingComposite(key, record) {
      if (typeof floodCompositeBlobSizes !== "undefined" && record?.url && floodCompositeBlobSizes.has(record.url)) {
        record.compositeByteLength = floodCompositeBlobSizes.get(record.url);
        floodCompositeBlobSizes.delete(record.url);
      }
      fillingCompositeCache.set(key, record);
      while (
        fillingCompositeCache.size > RASTER_COMPOSITE_CACHE_LIMIT ||
        (fillingCompositeCache.size > 1 &&
          Array.from(fillingCompositeCache.values()).reduce((bytes, item) => bytes + (item?.compositeByteLength || 0), 0) >
            (typeof FLOOD_COMPOSITE_CACHE_BYTE_LIMIT === "number" ? FLOOD_COMPOSITE_CACHE_BYTE_LIMIT : 128 * 1024 * 1024))
      ) {
        const oldestKey = fillingCompositeCache.keys().next().value;
        const oldest = fillingCompositeCache.get(oldestKey);
        fillingCompositeCache.delete(oldestKey);
        releaseCompositeUrl(oldest);
      }
      return record;
    })
    : (function cacheFillingComposite(key, record) {
      if (typeof floodCompositeBlobSizes !== "undefined" && record?.url && floodCompositeBlobSizes.has(record.url)) {
        record.compositeByteLength = floodCompositeBlobSizes.get(record.url);
        floodCompositeBlobSizes.delete(record.url);
      }
      fillingCompositeCache.set(key, record);
      while (
        fillingCompositeCache.size > FLOOD_COMPOSITE_CACHE_ENTRY_LIMIT ||
        (fillingCompositeCache.size > 1 &&
          Array.from(fillingCompositeCache.values()).reduce((bytes, item) => bytes + (item?.compositeByteLength || 0), 0) >
            (typeof FLOOD_COMPOSITE_CACHE_BYTE_LIMIT === "number" ? FLOOD_COMPOSITE_CACHE_BYTE_LIMIT : 128 * 1024 * 1024))
      ) {
        const oldestKey = fillingCompositeCache.keys().next().value;
        const oldest = fillingCompositeCache.get(oldestKey);
        if (oldest?.url?.startsWith("blob:")) URL.revokeObjectURL(oldest.url);
        fillingCompositeCache.delete(oldestKey);
      }
      return record;
    });

  function releaseCompositeUrl(record) {
      if (!record?.url?.startsWith("blob:")) return;
      if ([...fillingCompositeCache.values(), ...drainageCompositeCache.values()].some(other => other?.url === record.url)) return;
      // Keep displayed/pending images valid through an atomic layer replacement.
      if ([currentFloodLayer, pendingFloodLayer].some(layer => layer?.getElement()?.src === record.url)) return;
      exportImageElementCache.delete(record.url);
      preloadPromiseCache.delete(record.url);
      URL.revokeObjectURL(record.url);
    }
  function readRasterStripe(context, image, y, width, rows) {
      context.clearRect(0, 0, width, rows);
      context.drawImage(image, 0, y, width, rows, 0, 0, width, rows);
      return context.getImageData(0, 0, width, rows);
    }
  const buildPenaltyConnectivityComposite =
    format === "phase-v2" || format === "phase-v2-sparse"
      ? (async function buildPenaltyConnectivityComposite(mode, rawStage, adjustedStage, phase) {
      const [rawRecord, adjustedRecord, developedGrid] = await Promise.all([
        getBaseOverlayRecord(mode, rawStage),
        getBaseOverlayRecord(mode, adjustedStage),
        getDevelopedQueryGrid()
      ]);
      if (!rawRecord || !adjustedRecord) return adjustedRecord || rawRecord || null;

      const [rawImage, adjustedImage] = await Promise.all([
        getExportImageElement(rawRecord.url),
        getExportImageElement(adjustedRecord.url)
      ]);
      if (!rawImage || !adjustedImage ||
          rawImage.naturalWidth !== adjustedImage.naturalWidth ||
          rawImage.naturalHeight !== adjustedImage.naturalHeight) {
        console.warn("Connectivity filling composite skipped because raster images do not match.");
        return adjustedRecord;
      }

      const width = adjustedImage.naturalWidth;
      const height = adjustedImage.naturalHeight;
      if (!developedGrid || developedGrid.width !== width || developedGrid.height !== height) {
        console.warn("Developed-land penalty skipped because its mask does not match the flood raster.");
        return rawRecord;
      }
      const output = document.createElement("canvas");
      output.width = width;
      output.height = height;
      const outputContext = output.getContext("2d", { willReadFrequently: true });
      if (!outputContext) return adjustedRecord;
      outputContext.drawImage(adjustedImage, 0, 0);

      const stripeHeight = Math.min(RASTER_STRIPE_ROWS, height);
      const scratch = document.createElement("canvas");
      scratch.width = width;
      scratch.height = stripeHeight;
      const scratchContext = scratch.getContext("2d", { willReadFrequently: true });
      if (!scratchContext) return adjustedRecord;

      const uncertaintyRgba = getUncertaintyRasterColor();
      const useRawWetColor = mode === "dynamic" ||
        normalizeHydraulicPhase(phase).startsWith("draining");

      for (let y = 0; y < height; y += stripeHeight) {
        const rows = Math.min(stripeHeight, height - y);
        const adjustedData = outputContext.getImageData(0, y, width, rows);
        scratchContext.clearRect(0, 0, width, stripeHeight);
        scratchContext.drawImage(
          rawImage,
          0, y, width, rows,
          0, 0, width, rows
        );
        const rawData = scratchContext.getImageData(0, 0, width, rows);
        const target = adjustedData.data;
        const raw = rawData.data;
        const developed = await developedGrid.readRows(y, rows);

        for (let offset = 0; offset < target.length; offset += 4) {
          const developedOffset = offset;
          if (developed[developedOffset + 2] < 128) {
            target[offset] = raw[offset];
            target[offset + 1] = raw[offset + 1];
            target[offset + 2] = raw[offset + 2];
            target[offset + 3] = raw[offset + 3];
            continue;
          }
          const adjustedWet = isWetRasterPixel(target, offset, uncertaintyRgba);
          const rawWet = isWetRasterPixel(raw, offset, uncertaintyRgba);
          const uncertainty = isUncertaintyRasterPixel(target, offset, uncertaintyRgba) ||
            isUncertaintyRasterPixel(raw, offset, uncertaintyRgba);

          if (adjustedWet) {
            if (useRawWetColor && rawWet) {
              target[offset] = raw[offset];
              target[offset + 1] = raw[offset + 1];
              target[offset + 2] = raw[offset + 2];
              target[offset + 3] = raw[offset + 3];
            }
            continue;
          }
          if (rawWet || uncertainty) {
            target[offset] = uncertaintyRgba[0];
            target[offset + 1] = uncertaintyRgba[1];
            target[offset + 2] = uncertaintyRgba[2];
            target[offset + 3] = uncertaintyRgba[3];
          } else {
            target[offset] = 0;
            target[offset + 1] = 0;
            target[offset + 2] = 0;
            target[offset + 3] = 0;
          }
        }
        outputContext.putImageData(adjustedData, 0, y);
      }

      const url = await canvasToFillingObjectUrl(output);
      scratch.width = scratch.height = 0;
      return {
        ...rawRecord,
        url,
        filename: `${rawRecord.filename || getOverlayFilename(mode, rawStage)}#${normalizeHydraulicPhase(phase)}`,
        rawStage,
        adjustedStage,
        hydraulicPhase: normalizeHydraulicPhase(phase),
        isPenaltyConnectivityComposite: true
      };
    })
    : (async function buildPenaltyConnectivityComposite(mode, rawStage, adjustedStage, phase) {
      const [rawRecord, adjustedRecord, developedGrid] = await Promise.all([
        getBaseOverlayRecord(mode, rawStage),
        getBaseOverlayRecord(mode, adjustedStage),
        getDevelopedQueryGrid()
      ]);
      if (!rawRecord || !adjustedRecord) return adjustedRecord || rawRecord || null;

      const [rawImage, adjustedImage] = await Promise.all([
        getExportImageElement(rawRecord.url),
        getExportImageElement(adjustedRecord.url)
      ]);
      if (!rawImage || !adjustedImage ||
          rawImage.naturalWidth !== adjustedImage.naturalWidth ||
          rawImage.naturalHeight !== adjustedImage.naturalHeight) {
        console.warn("Connectivity filling composite skipped because raster images do not match.");
        return adjustedRecord;
      }

      const width = adjustedImage.naturalWidth;
      const height = adjustedImage.naturalHeight;
      if (!developedGrid || developedGrid.width !== width || developedGrid.height !== height) {
        console.warn("Developed-land penalty skipped because its mask does not match the flood raster.");
        return rawRecord;
      }
      const output = document.createElement("canvas");
      output.width = width;
      output.height = height;
      const outputContext = output.getContext("2d", { willReadFrequently: true });
      if (!outputContext) return adjustedRecord;
      outputContext.drawImage(adjustedImage, 0, 0);

      const stripeHeight = Math.min(128, height);
      const scratch = document.createElement("canvas");
      scratch.width = width;
      scratch.height = stripeHeight;
      const scratchContext = scratch.getContext("2d", { willReadFrequently: true });
      if (!scratchContext) return adjustedRecord;

      const uncertaintyRgba = getUncertaintyRasterColor();
      const useRawWetColor = mode === "dynamic" ||
        normalizeHydraulicPhase(phase).startsWith("draining");

      for (let y = 0; y < height; y += stripeHeight) {
        const rows = Math.min(stripeHeight, height - y);
        const adjustedData = outputContext.getImageData(0, y, width, rows);
        scratchContext.clearRect(0, 0, width, stripeHeight);
        scratchContext.drawImage(
          rawImage,
          0, y, width, rows,
          0, 0, width, rows
        );
        const rawData = scratchContext.getImageData(0, 0, width, rows);
        const target = adjustedData.data;
        const raw = rawData.data;
        const developed = developedGrid.values;

        for (let offset = 0; offset < target.length; offset += 4) {
          const developedOffset = (y * width * 4) + offset;
          if (developed[developedOffset + 2] < 128) {
            target[offset] = raw[offset];
            target[offset + 1] = raw[offset + 1];
            target[offset + 2] = raw[offset + 2];
            target[offset + 3] = raw[offset + 3];
            continue;
          }
          const adjustedWet = isWetRasterPixel(target, offset, uncertaintyRgba);
          const rawWet = isWetRasterPixel(raw, offset, uncertaintyRgba);
          const uncertainty = isUncertaintyRasterPixel(target, offset, uncertaintyRgba) ||
            isUncertaintyRasterPixel(raw, offset, uncertaintyRgba);

          if (adjustedWet) {
            if (useRawWetColor && rawWet) {
              target[offset] = raw[offset];
              target[offset + 1] = raw[offset + 1];
              target[offset + 2] = raw[offset + 2];
              target[offset + 3] = raw[offset + 3];
            }
            continue;
          }
          if (rawWet || uncertainty) {
            target[offset] = uncertaintyRgba[0];
            target[offset + 1] = uncertaintyRgba[1];
            target[offset + 2] = uncertaintyRgba[2];
            target[offset + 3] = uncertaintyRgba[3];
          } else {
            target[offset] = 0;
            target[offset + 1] = 0;
            target[offset + 2] = 0;
            target[offset + 3] = 0;
          }
        }
        outputContext.putImageData(adjustedData, 0, y);
      }

      const url = await canvasToFillingObjectUrl(output);
      return {
        ...rawRecord,
        url,
        filename: `${rawRecord.filename || getOverlayFilename(mode, rawStage)}#${normalizeHydraulicPhase(phase)}`,
        rawStage,
        adjustedStage,
        hydraulicPhase: normalizeHydraulicPhase(phase),
        isPenaltyConnectivityComposite: true
      };
    });

  async function getOverlayRecord(mode, stageValue, phase = "slack") {
      const rawStage = getOverlayStage(stageValue);
      if (rawStage == null) return null;
      const normalizedPhase = normalizeHydraulicPhase(phase);
      const key = `${mode}:${normalizedPhase}:${stageToCode(rawStage)}`;
      return getCachedAtlasRecord(key, () => findWorkingOverlay(mode, rawStage, normalizedPhase));
    }

  function getHydraulicStageFraction(rawStageFt, lowerStageFt) {
      const raw = Number(rawStageFt);
      const lower = Number(lowerStageFt);
      if (!Number.isFinite(raw) || !Number.isFinite(lower)) return 0;
      return Math.max(0, Math.min(1, (raw - lower) / STAGE_STEP));
    }
  function getFillingTransitionBlend(stageFraction) {
      const fraction = Math.max(0, Math.min(1, Number(stageFraction) || 0));
      const nearestFrameProgress = Math.min(1, fraction * 2);
      return nearestFrameProgress * nearestFrameProgress * (3 - 2 * nearestFrameProgress);
    }
  function getDrainageDepthColor(depthFt) {
      for (let index = 0; index < DRAINAGE_DEPTH_BREAKS_FT.length; index += 1) {
        if (depthFt < DRAINAGE_DEPTH_BREAKS_FT[index]) return DRAINAGE_DEPTH_COLORS[index];
      }
      return DRAINAGE_DEPTH_COLORS[DRAINAGE_DEPTH_COLORS.length - 1];
    }
  function getDrainageStageColor(stageFt) {
      if (stageFt >= MAJOR_FLOOD_FT) return DRAINAGE_STAGE_COLORS[2];
      if (stageFt >= MODERATE_FLOOD_FT) return DRAINAGE_STAGE_COLORS[1];
      return DRAINAGE_STAGE_COLORS[0];
    }
  async function loadHydraulicQueryPng(url) {
      const useStripes = format === "phase-v2" || format === "phase-v2-sparse";
      if (useStripes && window.AvalonQueryStripes && typeof DecompressionStream === "function") {
        try { return await AvalonQueryStripes.load(getBunnyAssetUrl(url.replace(/\.png$/, ".rgba.json"))); }
        catch (error) { console.warn("Query strips unavailable; using the original PNG.", error); }
      }
      const sources = useStripes ? [...new Set([getBunnyAssetUrl(url), url])] : [url];
      const image = await new Promise((resolve, reject) => {
        let attempt = 0;
        function loadNext() {
          if (attempt === sources.length) {
            reject(new Error("Could not load hydraulic query asset: " + url));
            return;
          }
          const candidate = new Image();
          candidate.crossOrigin = "anonymous";
          candidate.decoding = "async";
          const timer = window.setTimeout(failed, 20000);
          function release() {
            window.clearTimeout(timer);
            candidate.onload = candidate.onerror = null;
          }
          function failed() {
            release();
            candidate.removeAttribute("src");
            loadNext();
          }
          candidate.onload = () => { release(); resolve(candidate); };
          candidate.onerror = failed;
          candidate.src = sources[attempt++];
        }
        loadNext();
      });
      const { naturalWidth: width, naturalHeight: height } = image;
      const canvas = document.createElement("canvas");
      try {
        canvas.width = width;
        canvas.height = useStripes ? Math.min(RASTER_STRIPE_ROWS, height) : height;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("Hydraulic query canvas is unavailable.");
        if (!useStripes) {
          context.drawImage(image, 0, 0);
          return { width, height, values: context.getImageData(0, 0, width, height).data };
        }
        return {
          width, height, storage: "png-stripes",
          async readRows(y, rows) {
            canvas.width = width;
            canvas.height = rows;
            try {
              context.drawImage(image, 0, y, width, rows, 0, 0, width, rows);
              return context.getImageData(0, 0, width, rows).data;
            } finally { canvas.width = canvas.height = 0; }
          }
        };
      } finally { canvas.width = canvas.height = 0; }
    }

  function getV2PointDepth(stage, phase, mode, ground, developed, pixel) {
      if (!Number.isFinite(stage) || !Number.isFinite(ground) || !pixel) return {value:null,state:"unavailable"};
      const green = isUncertaintyRasterPixel(pixel, 0, [99,212,113,225]);
      if (green) return {value:null,state:"uncertain"};
      if (pixel[3] <= 8) return {value:0,state:"modeled"};
      const depthStage = mode === "dynamic" || normalizeHydraulicPhase(phase) === "filling" ? stage : getOverlayStage(stage);
      const surface = mode === "dynamic" || !developed ? depthStage : getPenalizedWaterSurfaceStage(depthStage, phase);
      const depth = Math.max(0, surface - ground);
      if (mode === "depth" && depth <= 0.005) {
        const shallow = DRAINAGE_DEPTH_COLORS[0].every((v,i) => Math.abs(v-pixel[i]) <= 3);
        return {value:shallow ? 0.05 : null,state:shallow ? "modeled" : "unavailable"};
      }
      return {value:depth,state:"modeled"};
    }
  async function getHydraulicQueryGrid() {
      if (!hydraulicQueryGridPromise) {
        hydraulicQueryGridPromise = loadHydraulicQueryPng(DEPTH_QUERY_PNG_URL)
          .catch(error => {
            hydraulicQueryGridPromise = null;
            throw error;
          });
      }
      return hydraulicQueryGridPromise;
    }
  async function getDevelopedQueryGrid() {
      if (!developedQueryGridPromise) {
        developedQueryGridPromise = loadHydraulicQueryPng(DEVELOPED_QUERY_PNG_URL)
          .catch(error => {
            developedQueryGridPromise = null;
            throw error;
          });
      }
      return developedQueryGridPromise;
    }
  function isDevelopedRasterPixel(developedPixels, offset) {
      return Boolean(developedPixels && developedPixels[offset + 2] >= 128);
    }
  const getFillingTransitionPixelDepth =
    format === "phase-v2" || format === "phase-v2-sparse"
      ? (function getFillingTransitionPixelDepth(queryPixels, developedPixels, pixel, rawStageFt) {
      if (!queryPixels || !developedPixels || queryPixels.length !== developedPixels.length) return null;
      const offset = pixel * 4;
      const encodedGround = queryPixels[offset] * 256 + queryPixels[offset + 1];
      if (!encodedGround || queryPixels[offset + 2] === 255) return null;
      const groundFt = (encodedGround - 32768) / 10;
      const stageFt = Number(rawStageFt);
      if (!Number.isFinite(stageFt)) return null;
      const adjustedStageFt = stageFt -
        (isDevelopedRasterPixel(developedPixels, offset) ? getVerticalBathtubPenalty(stageFt) : 0);
      if (groundFt > adjustedStageFt + 1e-9) return null;
      return Math.max(0.005, adjustedStageFt - groundFt);
    })
    : (function getFillingTransitionPixelDepth(queryPixels, developedPixels, pixel, rawStageFt) {
      if (!queryPixels || !developedPixels || queryPixels.length !== developedPixels.length) return null;
      const offset = pixel * 4;
      const encodedGround = queryPixels[offset] * 256 + queryPixels[offset + 1];
      if (!encodedGround || queryPixels[offset + 2] === 255) return null;
      const groundFt = (encodedGround - 32768) / 10;
      const stageFt = Number(rawStageFt);
      if (!Number.isFinite(stageFt)) return null;
      const adjustedStageFt = stageFt -
        (isDevelopedRasterPixel(developedPixels, offset) ? getVerticalBathtubPenalty(stageFt) : 0);
      if (groundFt > adjustedStageFt + 1e-9) return null;
      return Math.max(0.005, stageFt - groundFt);
    });

  const applyFillingTransitionPixels =
    format === "phase-v2" || format === "phase-v1"
      ? (function applyFillingTransitionPixels(
      lowerPixels,
      upperPixels,
      developedPixels,
      width,
      height,
      rawStageFt,
      lowerStageFt,
      mode,
      depthPixels = upperPixels,
      queryPixels = null
    ) {
      if (!lowerPixels || !upperPixels || lowerPixels.length !== upperPixels.length ||
          !developedPixels || developedPixels.length !== lowerPixels.length ||
          !queryPixels || queryPixels.length !== lowerPixels.length ||
          width * height * 4 !== lowerPixels.length) return 0;
      const fraction = getHydraulicStageFraction(rawStageFt, lowerStageFt);
      if (!(fraction > 0)) return 0;
      const blend = getFillingTransitionBlend(fraction);
      const transitionStageRgb = getDrainageStageColor(rawStageFt);
      const uncertaintyRgba = getUncertaintyRasterColor();
      let added = 0;
      const pixelCount = width * height;

      for (let pixel = 0; pixel < pixelCount; pixel += 1) {
        const offset = pixel * 4;
        const candidate = !isWetRasterPixel(lowerPixels, offset, uncertaintyRgba) &&
          isWetRasterPixel(upperPixels, offset, uncertaintyRgba) &&
          isDevelopedRasterPixel(developedPixels, offset);
        if (!candidate) continue;
        const depthFt = getFillingTransitionPixelDepth(
          queryPixels,
          developedPixels,
          pixel,
          rawStageFt
        );
        if (!Number.isFinite(depthFt)) continue;
        const color = mode === "depth"
          ? getDrainageDepthColor(depthFt)
          : transitionStageRgb;
        const sourceAlpha = lowerPixels[offset + 3];
        if (sourceAlpha > 0) {
          lowerPixels[offset] = Math.round(lowerPixels[offset] * (1 - blend) + color[0] * blend);
          lowerPixels[offset + 1] = Math.round(lowerPixels[offset + 1] * (1 - blend) + color[1] * blend);
          lowerPixels[offset + 2] = Math.round(lowerPixels[offset + 2] * (1 - blend) + color[2] * blend);
          lowerPixels[offset + 3] = Math.round(sourceAlpha * (1 - blend) + 225 * blend);
        } else {
          lowerPixels[offset] = color[0];
          lowerPixels[offset + 1] = color[1];
          lowerPixels[offset + 2] = color[2];
          lowerPixels[offset + 3] = Math.round(225 * blend);
        }
        added += 1;
      }
      return added;
    })
    : (function applyFillingTransitionPixels(
      lowerPixels,
      upperPixels,
      developedPixels,
      width,
      height,
      rawStageFt,
      lowerStageFt,
      mode,
      queryPixels = null
    ) {
      if (!lowerPixels || !upperPixels || lowerPixels.length !== upperPixels.length ||
          !developedPixels || developedPixels.length !== lowerPixels.length ||
          !queryPixels || queryPixels.length !== lowerPixels.length ||
          width * height * 4 !== lowerPixels.length) return 0;
      const fraction = getHydraulicStageFraction(rawStageFt, lowerStageFt);
      if (!(fraction > 0)) return 0;
      const blend = getFillingTransitionBlend(fraction);
      const transitionStageRgb = getDrainageStageColor(rawStageFt);
      const uncertaintyRgba = getUncertaintyRasterColor();
      let added = 0;
      const pixelCount = width * height;

      for (let pixel = 0; pixel < pixelCount; pixel += 1) {
        const offset = pixel * 4;
        const candidate = !isWetRasterPixel(lowerPixels, offset, uncertaintyRgba) &&
          isWetRasterPixel(upperPixels, offset, uncertaintyRgba) &&
          isDevelopedRasterPixel(developedPixels, offset);
        if (!candidate) continue;
        const depthFt = getFillingTransitionPixelDepth(
          queryPixels,
          developedPixels,
          pixel,
          rawStageFt
        );
        if (!Number.isFinite(depthFt)) continue;
        const color = mode === "depth"
          ? getDrainageDepthColor(depthFt)
          : transitionStageRgb;
        const sourceAlpha = lowerPixels[offset + 3];
        if (sourceAlpha > 0) {
          lowerPixels[offset] = Math.round(lowerPixels[offset] * (1 - blend) + color[0] * blend);
          lowerPixels[offset + 1] = Math.round(lowerPixels[offset + 1] * (1 - blend) + color[1] * blend);
          lowerPixels[offset + 2] = Math.round(lowerPixels[offset + 2] * (1 - blend) + color[2] * blend);
          lowerPixels[offset + 3] = Math.round(sourceAlpha * (1 - blend) + 225 * blend);
        } else {
          lowerPixels[offset] = color[0];
          lowerPixels[offset + 1] = color[1];
          lowerPixels[offset + 2] = color[2];
          lowerPixels[offset + 3] = Math.round(225 * blend);
        }
        added += 1;
      }
      return added;
    });

  const getFillingInterpolatedOverlayRecord =
    format === "phase-v2"
      ? (async function getFillingInterpolatedOverlayRecord(
      mode,
      lowerStageFt,
      phase,
      entry,
      lowerRecord
    ) {
      const rawStageFt = getStageValue(entry);
      const fraction = getHydraulicStageFraction(rawStageFt, lowerStageFt);
      const normalizedPhase = normalizeHydraulicPhase(phase);
      if (!lowerRecord || !(fraction > 1e-6) || fraction >= 1 - 1e-6 ||
          (normalizedPhase !== "filling" && normalizedPhase !== "slack")) return lowerRecord;
      const upperStageFt = roundToOneDecimal(Math.min(MAX_STAGE, lowerStageFt + STAGE_STEP));
      if (!(upperStageFt > lowerStageFt)) return lowerRecord;
      const key = [
        "continuous-filling",
        mode,
        normalizedPhase,
        Number(rawStageFt).toFixed(3),
        stageToCode(lowerStageFt),
        stageToCode(upperStageFt)
      ].join("|");
      if (fillingCompositeCache.has(key)) {
        const cached = fillingCompositeCache.get(key);
        fillingCompositeCache.delete(key);
        fillingCompositeCache.set(key, cached);
        return cached;
      }

      const request = (async () => {
        const upperRequest = getOverlayRecord(mode, upperStageFt, normalizedPhase);
        const depthRequest = mode === "depth"
          ? upperRequest
          : getOverlayRecord("depth", upperStageFt, normalizedPhase);
        const [upperRecord, depthRecord] = await Promise.all([upperRequest, depthRequest]);
        if (!upperRecord || !depthRecord) return lowerRecord;
        const [lowerImage, upperImage, depthImage, developedGrid, queryGrid] = await Promise.all([
          getExportImageElement(lowerRecord.url),
          getExportImageElement(upperRecord.url),
          getExportImageElement(depthRecord.url),
          getDevelopedQueryGrid(),
          getHydraulicQueryGrid()
        ]);
        if (!lowerImage || !upperImage || !depthImage || !developedGrid || !queryGrid) return lowerRecord;
        const width = lowerImage.naturalWidth;
        const height = lowerImage.naturalHeight;
        if (upperImage.naturalWidth !== width || upperImage.naturalHeight !== height ||
            depthImage.naturalWidth !== width || depthImage.naturalHeight !== height ||
            developedGrid.width !== width || developedGrid.height !== height ||
            queryGrid.width !== width || queryGrid.height !== height) {
          console.warn("Filling interpolation skipped because its raster grids do not match.");
          return lowerRecord;
        }

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) return lowerRecord;
        const scratch = document.createElement("canvas");
        scratch.width = width;
        scratch.height = Math.min(RASTER_STRIPE_ROWS, height);
        try {
          const stripeContext = scratch.getContext("2d", { willReadFrequently: true });
          if (!stripeContext) return lowerRecord;
          let addedPixelCount = 0;
          for (let y = 0; y < height; y += RASTER_STRIPE_ROWS) {
            const rows = Math.min(RASTER_STRIPE_ROWS, height - y);
            const [developedPixels, queryPixels] = await Promise.all([
              developedGrid.readRows(y, rows), queryGrid.readRows(y, rows)
            ]);
            const lower = readRasterStripe(stripeContext, lowerImage, y, width, rows);
            const upper = readRasterStripe(stripeContext, upperImage, y, width, rows).data;
            const depth = depthImage === upperImage ? upper : readRasterStripe(stripeContext, depthImage, y, width, rows).data;
            addedPixelCount += applyFillingTransitionPixels(lower.data, upper,
              developedPixels, width, rows, rawStageFt,
              lowerStageFt, mode, depth, queryPixels);
            context.putImageData(lower, 0, y);
          }
          if (!addedPixelCount) return lowerRecord;
          return { ...lowerRecord, url: await canvasToFillingObjectUrl(canvas),
            isContinuousFillingComposite: true, fillingFraction: fraction, addedPixelCount };
        } finally {
          canvas.width = canvas.height = scratch.width = scratch.height = 0;
        }
      })().catch(error => {
        console.warn("Could not build the continuous filling raster; using the lower catalog raster.", error);
        return lowerRecord;
      });

      fillingCompositeCache.set(key, request);
      const record = await request;
      return cacheFillingComposite(key, record);
    })
    : format === "phase-v2-sparse"
      ? (async function getFillingInterpolatedOverlayRecord(
      mode,
      lowerStageFt,
      phase,
      entry,
      lowerRecord
    ) {
      const rawStageFt = getStageValue(entry);
      const fraction = getHydraulicStageFraction(rawStageFt, lowerStageFt);
      const normalizedPhase = normalizeHydraulicPhase(phase);
      if (!lowerRecord || !(fraction > 1e-6) || fraction >= 1 - 1e-6 ||
          (normalizedPhase !== "filling" && normalizedPhase !== "slack")) return lowerRecord;
      const upperStageFt = roundToOneDecimal(Math.min(MAX_STAGE, lowerStageFt + STAGE_STEP));
      if (!(upperStageFt > lowerStageFt)) return lowerRecord;
      const key = [
        "continuous-filling",
        mode,
        normalizedPhase,
        Number(rawStageFt).toFixed(3),
        stageToCode(lowerStageFt),
        stageToCode(upperStageFt)
      ].join("|");
      if (fillingCompositeCache.has(key)) {
        const cached = fillingCompositeCache.get(key);
        fillingCompositeCache.delete(key);
        fillingCompositeCache.set(key, cached);
        return cached;
      }

      const request = (async () => {
        if (mode === "depth" && window.AvalonSparseTransitions) {
          try {
            return await getSparseFillingOverlayRecord(mode, lowerStageFt, normalizedPhase, rawStageFt, lowerRecord);
          } catch (error) {
            console.warn("Sparse filling data unavailable; using the full query grid.", error);
          }
        }
        const upperRequest = getOverlayRecord(mode, upperStageFt, normalizedPhase);
        const upperRecord = await upperRequest;
        if (!upperRecord) return lowerRecord;
        const [lowerImage, upperImage, developedGrid, queryGrid] = await Promise.all([
          getExportImageElement(lowerRecord.url),
          getExportImageElement(upperRecord.url),
          getDevelopedQueryGrid(),
          getHydraulicQueryGrid()
        ]);
        if (!lowerImage || !upperImage || !developedGrid || !queryGrid) return lowerRecord;
        const width = lowerImage.naturalWidth;
        const height = lowerImage.naturalHeight;
        if (upperImage.naturalWidth !== width || upperImage.naturalHeight !== height ||
            developedGrid.width !== width || developedGrid.height !== height ||
            queryGrid.width !== width || queryGrid.height !== height) {
          console.warn("Filling interpolation skipped because its raster grids do not match.");
          return lowerRecord;
        }

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) return lowerRecord;
        const upperCanvas = document.createElement("canvas");
        upperCanvas.width = width;
        upperCanvas.height = height;
        try {
          const upperContext = upperCanvas.getContext("2d", { willReadFrequently: true });
          if (!upperContext) return lowerRecord;
          context.drawImage(lowerImage, 0, 0);
          upperContext.drawImage(upperImage, 0, 0);
          let addedPixelCount = 0;
          for (let y = 0; y < height; y += RASTER_STRIPE_ROWS) {
            const rows = Math.min(RASTER_STRIPE_ROWS, height - y);
            const [developedPixels, queryPixels] = await Promise.all([
              developedGrid.readRows(y, rows), queryGrid.readRows(y, rows)
            ]);
            const lower = context.getImageData(0, y, width, rows);
            const upper = upperContext.getImageData(0, y, width, rows).data;
            addedPixelCount += applyFillingTransitionPixels(lower.data, upper,
              developedPixels, width, rows, rawStageFt,
              lowerStageFt, mode, queryPixels);
            context.putImageData(lower, 0, y);
          }
          if (!addedPixelCount) return lowerRecord;
          return { ...lowerRecord, url: await canvasToFillingObjectUrl(canvas),
            isContinuousFillingComposite: true, fillingFraction: fraction, addedPixelCount };
        } finally {
          canvas.width = canvas.height = upperCanvas.width = upperCanvas.height = 0;
        }
      })().catch(error => {
        console.warn("Could not build the continuous filling raster; using the lower catalog raster.", error);
        return lowerRecord;
      });

      fillingCompositeCache.set(key, request);
      const record = await request;
      return cacheFillingComposite(key, record);
    })
    : (async function getFillingInterpolatedOverlayRecord(
      mode,
      lowerStageFt,
      phase,
      entry,
      lowerRecord
    ) {
      const rawStageFt = getStageValue(entry);
      const fraction = getHydraulicStageFraction(rawStageFt, lowerStageFt);
      const normalizedPhase = normalizeHydraulicPhase(phase);
      if (!lowerRecord || !(fraction > 1e-6) || fraction >= 1 - 1e-6 ||
          (normalizedPhase !== "filling" && normalizedPhase !== "slack")) return lowerRecord;
      const upperStageFt = roundToOneDecimal(Math.min(MAX_STAGE, lowerStageFt + STAGE_STEP));
      if (!(upperStageFt > lowerStageFt)) return lowerRecord;
      const key = ["continuous-filling", mode, normalizedPhase, Number(rawStageFt).toFixed(3), stageToCode(lowerStageFt), stageToCode(upperStageFt)].join("|");
      if (fillingCompositeCache.has(key)) {
        const cached = fillingCompositeCache.get(key);
        fillingCompositeCache.delete(key);
        fillingCompositeCache.set(key, cached);
        return cached;
      }
      const request = (async () => {
        const upperRequest = getOverlayRecord(mode, upperStageFt, normalizedPhase);
        const depthRequest = mode === "depth" ? upperRequest : getOverlayRecord("depth", upperStageFt, normalizedPhase);
        const [upperRecord, depthRecord] = await Promise.all([upperRequest, depthRequest]);
        if (!upperRecord || !depthRecord) return lowerRecord;
        const [lowerImage, upperImage, depthImage, developedGrid, queryGrid] = await Promise.all([
          getExportImageElement(lowerRecord.url), getExportImageElement(upperRecord.url),
          getExportImageElement(depthRecord.url), getDevelopedQueryGrid(), getHydraulicQueryGrid()
        ]);
        if (!lowerImage || !upperImage || !depthImage || !developedGrid || !queryGrid) return lowerRecord;
        const width = lowerImage.naturalWidth;
        const height = lowerImage.naturalHeight;
        if (upperImage.naturalWidth !== width || upperImage.naturalHeight !== height ||
            depthImage.naturalWidth !== width || depthImage.naturalHeight !== height ||
            developedGrid.width !== width || developedGrid.height !== height ||
            queryGrid.width !== width || queryGrid.height !== height) {
          console.warn("Filling interpolation skipped because its raster grids do not match.");
          return lowerRecord;
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) return lowerRecord;
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
          lowerImageData.data, upperPixels, developedGrid.values, width, height,
          rawStageFt, lowerStageFt, mode, depthPixels, queryGrid.values
        );
        if (!addedPixelCount) return lowerRecord;
        context.putImageData(lowerImageData, 0, 0);
        return { ...lowerRecord, url: await canvasToFillingObjectUrl(canvas), isContinuousFillingComposite: true, fillingFraction: fraction, addedPixelCount };
      })().catch(error => {
        console.warn("Could not build the continuous filling raster; using the lower catalog raster.", error);
        return lowerRecord;
      });
      fillingCompositeCache.set(key, request);
      const record = await request;
      return cacheFillingComposite(key, record);
    });

  function getDrainageRetentionMilestones(entry, series = currentSeriesHours) {
      const phase = getHydraulicPhaseForEntry(entry, null, series);
      const crestStage = Number(entry?.hydraulicCrestStageFt);
      const currentTime = entryTimeMs(entry);
      const crestTime = Date.parse(entry?.hydraulicCrestTimeUtc || "");
      if (!phase.startsWith("draining") || !Number.isFinite(crestStage) ||
          crestStage < MINOR_FLOOD_FT || !Number.isFinite(currentTime) || !Number.isFinite(crestTime)) return [];

      const rows = (Array.isArray(series) ? series : []).filter(row => {
        const time = entryTimeMs(row);
        return Number.isFinite(time) && time >= crestTime && time < currentTime && Number.isFinite(getStageValue(row));
      });
      const selected = new Map();
      for (const row of rows) {
        const rowPhase = getHydraulicPhaseForEntry(row, null, series);
        if (rowPhase === "filling") continue;
        const existing = selected.get(rowPhase);
        if (!existing || getStageValue(row) > getStageValue(existing)) selected.set(rowPhase, row);
      }
      return Array.from(selected.values()).sort((a, b) => entryTimeMs(a) - entryTimeMs(b));
    }
  function applyDrainageRetentionPixels(currentPixels, historicalPixelSets, queryPixels, stageFt, mode) {
      const pixelCount = Math.floor(currentPixels.length / 4);
      if (!pixelCount || !queryPixels || queryPixels.length !== currentPixels.length) return 0;
      const history = (historicalPixelSets || []).filter(values => values && values.length === currentPixels.length);
      if (!history.length) return 0;
      const uncertaintyRgba = getUncertaintyRasterColor();
      const crestPixels = history[0];
      let modified = 0;

      for (let pixel = 0, offset = 0; pixel < pixelCount; pixel += 1, offset += 4) {
        if (!isWetRasterPixel(currentPixels, offset, uncertaintyRgba) || crestPixels[offset + 3] > 0) continue;
        currentPixels[offset] = 0;
        currentPixels[offset + 1] = 0;
        currentPixels[offset + 2] = 0;
        currentPixels[offset + 3] = 0;
        modified += 1;
      }

      const retained = new Uint8Array(pixelCount);
      for (const historyPixels of history) {
        for (let pixel = 0, offset = 0; pixel < pixelCount; pixel += 1, offset += 4) {
          if (!retained[pixel] && crestPixels[offset + 3] > 0 &&
              isWetRasterPixel(historyPixels, offset, uncertaintyRgba)) retained[pixel] = 1;
        }
      }

      const retainedStageRgb = getDrainageStageColor(stageFt);
      for (let pixel = 0, offset = 0; pixel < pixelCount; pixel += 1, offset += 4) {
        if (!retained[pixel] || isWetRasterPixel(currentPixels, offset, uncertaintyRgba)) continue;
        const encodedGround = queryPixels[offset] * 256 + queryPixels[offset + 1];
        if (!encodedGround || queryPixels[offset + 2] === 255) continue;
        const groundFt = (encodedGround - 32768) / 10;
        const depthFt = Number(stageFt) - groundFt;
        if (!(depthFt > 0.005)) continue;
        const color = mode === "depth" ? getDrainageDepthColor(depthFt) : retainedStageRgb;
        currentPixels[offset] = color[0];
        currentPixels[offset + 1] = color[1];
        currentPixels[offset + 2] = color[2];
        currentPixels[offset + 3] = 225;
        modified += 1;
      }
      return modified;
    }
  const cacheDrainageComposite =
    format === "phase-v2" || format === "phase-v2-sparse"
      ? (function cacheDrainageComposite(key, record) {
      if (typeof floodCompositeBlobSizes !== "undefined" && record?.url && floodCompositeBlobSizes.has(record.url)) {
        record.compositeByteLength = floodCompositeBlobSizes.get(record.url);
        floodCompositeBlobSizes.delete(record.url);
      }
      drainageCompositeCache.set(key, record);
      while (
        drainageCompositeCache.size > RASTER_COMPOSITE_CACHE_LIMIT ||
        (drainageCompositeCache.size > 1 &&
          Array.from(drainageCompositeCache.values()).reduce((bytes, item) => bytes + (item?.compositeByteLength || 0), 0) >
            (typeof FLOOD_COMPOSITE_CACHE_BYTE_LIMIT === "number" ? FLOOD_COMPOSITE_CACHE_BYTE_LIMIT : 128 * 1024 * 1024))
      ) {
        const oldestKey = drainageCompositeCache.keys().next().value;
        const oldest = drainageCompositeCache.get(oldestKey);
        drainageCompositeCache.delete(oldestKey);
        releaseCompositeUrl(oldest);
      }
      return record;
    })
    : (function cacheDrainageComposite(key, record) {
      if (typeof floodCompositeBlobSizes !== "undefined" && record?.url && floodCompositeBlobSizes.has(record.url)) {
        record.compositeByteLength = floodCompositeBlobSizes.get(record.url);
        floodCompositeBlobSizes.delete(record.url);
      }
      drainageCompositeCache.set(key, record);
      while (
        drainageCompositeCache.size > FLOOD_COMPOSITE_CACHE_ENTRY_LIMIT ||
        (drainageCompositeCache.size > 1 &&
          Array.from(drainageCompositeCache.values()).reduce((bytes, item) => bytes + (item?.compositeByteLength || 0), 0) >
            (typeof FLOOD_COMPOSITE_CACHE_BYTE_LIMIT === "number" ? FLOOD_COMPOSITE_CACHE_BYTE_LIMIT : 128 * 1024 * 1024))
      ) {
        const oldestKey = drainageCompositeCache.keys().next().value;
        const oldest = drainageCompositeCache.get(oldestKey);
        if (oldest?.url?.startsWith("blob:")) URL.revokeObjectURL(oldest.url);
        drainageCompositeCache.delete(oldestKey);
      }
      return record;
    });

  const getHydraulicOverlayRecord =
    format === "phase-v2" || format === "phase-v2-sparse"
      ? (function getHydraulicOverlayRecord(mode, stageValue, phase = "slack", entry = null, series = currentSeriesHours, isCurrent = null) {
      // One composite at a time, including exports and rapid slider input.
      const request = hydraulicRenderQueue.then(() => {
        if (isCurrent && !isCurrent()) return null;
        return buildHydraulicOverlayRecord(mode, stageValue, phase, entry, series);
      });
      hydraulicRenderQueue = request.catch(() => {});
      return request;
    })
    : (async function getHydraulicOverlayRecord(mode, stageValue, phase = "slack", entry = null, series = currentSeriesHours) {
      const record = await getSourceHydraulicOverlayRecord(mode, stageValue, phase, entry, series);
      return getDisplayOverlayRecord(record, mode);
    });

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
  async function getBathtubStageOverlayRecord(stageValue) {
      const stage = Number(stageValue);
      if (!Number.isFinite(stage)) return null;
      const key = `v2-bathtub:${stage.toFixed(3)}`;
      if (drainageCompositeCache.has(key)) {
        const cached = drainageCompositeCache.get(key);
        drainageCompositeCache.delete(key);
        drainageCompositeCache.set(key, cached);
        return cached;
      }
      const grid = await getHydraulicQueryGrid();
      const canvas = document.createElement("canvas");
      canvas.width = grid.width; canvas.height = grid.height;
      try {
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("Flood-stage canvas unavailable");
        for (let y = 0; y < grid.height; y += RASTER_STRIPE_ROWS) {
          const rows = Math.min(RASTER_STRIPE_ROWS, grid.height - y);
          const pixels = await grid.readRows(y, rows);
          const stripe = context.createImageData(grid.width, rows);
          applyBathtubStagePixels(pixels, stripe.data, stage);
          context.putImageData(stripe, 0, y);
        }
        return cacheDrainageComposite(key, {
          url: await canvasToFillingObjectUrl(canvas),
          filename: `${SITE_CONFIG.stagePngPrefix}V2${stageToCode(stage)}.png`,
          isBathtubStage: true
        });
      } finally { canvas.width = canvas.height = 0; }
    }
  async function buildHydraulicOverlayRecord(mode, stageValue, phase = "slack", entry = null, series = currentSeriesHours) {
      const rawStage = normalizeStageValue(stageValue);
      if (rawStage == null) return null;
      if (mode === "dynamic") return getBathtubStageOverlayRecord(rawStage);
      const lowerStage = getOverlayStage(rawStage);
      let baseRecord = await getOverlayRecord(mode, rawStage, phase);
      if (!baseRecord || !entry) return baseRecord;
      baseRecord = await getFillingInterpolatedOverlayRecord(mode, lowerStage, phase, entry, baseRecord);
      const milestones = getDrainageRetentionMilestones(entry, series);
      if (!milestones.length) return baseRecord;

      const key = [
        "history-drainage",
        mode,
        Number(rawStage).toFixed(3),
        normalizeHydraulicPhase(phase),
        entryTimeMs(entry), getStageValue(entry),
        ...milestones.map(item => `${entryTimeMs(item)}:${normalizeHydraulicPhase(item.hydraulicPhase)}:${stageToCode(getOverlayStage(getStageValue(item)))}:${getStageValue(item)}`)
      ].join("|");
      if (drainageCompositeCache.has(key)) {
        const cached = drainageCompositeCache.get(key);
        drainageCompositeCache.delete(key);
        drainageCompositeCache.set(key, cached);
        return cached;
      }

      const request = (async () => {
        const historicalRecords = (await Promise.all(milestones.map(item => {
          const itemStage = getOverlayStage(getStageValue(item));
          return itemStage == null
            ? Promise.resolve(null)
            : getOverlayRecord(mode, itemStage, getHydraulicPhaseForEntry(item, null, series));
        }))).filter(Boolean);
        if (!historicalRecords.length) return baseRecord;

        const [baseImage, queryGrid, ...historyImages] = await Promise.all([
          getExportImageElement(baseRecord.url),
          getHydraulicQueryGrid(),
          ...historicalRecords.map(record => getExportImageElement(record.url))
        ]);
        if (!baseImage || !queryGrid || historyImages.some(image => !image)) return baseRecord;
        if (baseImage.naturalWidth !== queryGrid.width || baseImage.naturalHeight !== queryGrid.height ||
            historyImages.some(image => image.naturalWidth !== baseImage.naturalWidth || image.naturalHeight !== baseImage.naturalHeight)) {
          console.warn("Drainage retention skipped because its raster grids do not match.");
          return baseRecord;
        }

        const canvas = document.createElement("canvas");
        canvas.width = baseImage.naturalWidth;
        canvas.height = baseImage.naturalHeight;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) return baseRecord;
        const width = canvas.width, height = canvas.height;
        const scratch = document.createElement("canvas");
        scratch.width = width;
        scratch.height = Math.min(RASTER_STRIPE_ROWS, height);
        try {
          const stripeContext = scratch.getContext("2d", { willReadFrequently: true });
          if (!stripeContext) return baseRecord;
          let retainedPixelCount = 0;
          for (let y = 0; y < height; y += RASTER_STRIPE_ROWS) {
            const rows = Math.min(RASTER_STRIPE_ROWS, height - y);
            const queryPixels = await queryGrid.readRows(y, rows);
            const current = readRasterStripe(stripeContext, baseImage, y, width, rows);
            const history = historyImages.map(image => readRasterStripe(stripeContext, image, y, width, rows).data);
            retainedPixelCount += applyDrainageRetentionPixels(current.data, history,
              queryPixels, rawStage, mode);
            context.putImageData(current, 0, y);
          }
          if (!retainedPixelCount) return baseRecord;
          return { ...baseRecord, url: await canvasToFillingObjectUrl(canvas),
            isHistoryAwareDrainageComposite: true, retainedPixelCount };
        } finally {
          canvas.width = canvas.height = scratch.width = scratch.height = 0;
        }
      })().catch(error => {
        console.warn("Could not build the history-aware drainage raster; using the static phase raster.", error);
        return baseRecord;
      });

      drainageCompositeCache.set(key, request);
      const record = await request;
      return cacheDrainageComposite(key, record);
    }
  function queryPoint(lat, lon, width, height) {
      if (!floodLatLngBounds || ![lat, lon, width, height].every(Number.isFinite)) return null;
      const west = floodLatLngBounds.getWest(), east = floodLatLngBounds.getEast();
      const south = floodLatLngBounds.getSouth(), north = floodLatLngBounds.getNorth();
      const x = Math.floor((lon - west) / (east - west) * width);
      const y = Math.floor((north - lat) / (north - south) * height);
      return x < 0 || y < 0 || x >= width || y >= height ? null : {x, y};
    }
  async function sampleTownQueryGrid(lat, lon) {
      const stripesPath = TOWN_CONFIG.overlays.pointStripesIndexPath;
      if (stripesPath && window.AvalonPointStripes) {
        try {
          const index = new URL(stripesPath, APP_BASE);
          const stripes = await AvalonPointStripes.info(getBunnyAssetUrl(index.href));
          const point = queryPoint(lat, lon, stripes.width, stripes.height);
          if (!point) return null;
          const stripe = Math.floor(point.y / stripes.rows);
          const stripeUrl = getBunnyAssetUrl(new URL(`s${String(stripe).padStart(2, "0")}.json`, index).href);
          const {groundCode, developed} = await AvalonPointStripes.read(stripeUrl, stripes, point.x, point.y);
          return groundCode ? {elevation: (groundCode - 32768) / 10, developedFlag: developed} : null;
        } catch (error) {
          console.warn("Point stripes unavailable; reading the town query raster.", error);
        }
      }
      const [ground, developed] = await Promise.all([getHydraulicQueryGrid(), getDevelopedQueryGrid()]);
      if (!ground || !developed || developed.width !== ground.width || developed.height !== ground.height) return null;
      const point = queryPoint(lat, lon, ground.width, ground.height);
      if (!point) return null;
      const stripe = Math.floor(point.y / RASTER_STRIPE_ROWS) * RASTER_STRIPE_ROWS;
      const rows = Math.min(RASTER_STRIPE_ROWS, ground.height - stripe);
      const [g, d] = await Promise.all([ground.readRows(stripe, rows), developed.readRows(stripe, rows)]);
      const offset = ((point.y - stripe) * ground.width + point.x) * 4;
      const groundCode = g[offset] * 256 + g[offset + 1];
      return groundCode ? {elevation: (groundCode - 32768) / 10, developedFlag: isDevelopedRasterPixel(d, offset)} : null;
    }
  function sampleTownRenderedPixel(lat, lon) {
      const image = currentFloodLayer?.getElement?.();
      if (!image?.complete || !image.naturalWidth) return null;
      const point = queryPoint(lat, lon, image.naturalWidth, image.naturalHeight);
      if (!point) return null;
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      try {
        const context = canvas.getContext("2d", {willReadFrequently: true});
        if (!context) return null;
        context.drawImage(image, point.x, point.y, 1, 1, 0, 0, 1, 1);
        const townPixel = context.getImageData(0, 0, 1, 1).data;
        return {townPixel, flooded: townPixel[3] > 8};
      } finally { canvas.width = canvas.height = 0; }
    }
  const townDepth =
    format === "phase-v2" || format === "phase-v2-sparse"
      ? (function townDepth(sample, stage, rendered, phase) {
      if (!sample || !rendered?.townPixel) return null;
      return getV2PointDepth(stage, phase, currentOverlayMode, sample.elevation, sample.developedFlag, rendered.townPixel).value;
    })
    : (function townDepth(sample, stage, rendered, phase) {
      if (rendered?.visible === false) return 0;
      const surface = getPenalizedWaterSurfaceStage(stage, phase);
      if (Number.isFinite(surface) && Number.isFinite(sample?.elevation)) return Math.max(0, surface - sample.elevation);
      if (rendered?.depthBandFt) {
        const [lower, upper] = rendered.depthBandFt;
        return Number.isFinite(upper) ? (lower + upper) / 2 : lower + 0.5;
      }
      return null;
    });

  async function getSparseFillingOverlayRecord(mode, lowerStageFt, phase, rawStageFt, lowerRecord) {
      if (mode !== "depth" || !window.AvalonSparseTransitions) return null;
      const lowerImage = await getExportImageElement(lowerRecord.url);
      if (!lowerImage) throw new Error("The lower flood image is unavailable");
      const width = lowerImage.naturalWidth;
      const height = lowerImage.naturalHeight;
      const lowerStageCode = Math.round(lowerStageFt * 10);
      const path = `assets/hydraulic-connectivity-v2/transitions/depth/${phase}/p${String(lowerStageCode).padStart(3, "0")}.json`;
      const transition = await AvalonSparseTransitions.load(getBunnyAssetUrl(new URL(path, APP_BASE).href), {
        mode, phase, lowerStageCode, width, height, lowerUrl: lowerRecord.url
      });
      if (!transition.indices.length) return lowerRecord;

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      try {
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("Sparse flood canvas is unavailable");
        context.drawImage(lowerImage, 0, 0);
        const fraction = getHydraulicStageFraction(rawStageFt, lowerStageFt);
        const blend = getFillingTransitionBlend(fraction);
        const adjustedStage = rawStageFt - getVerticalBathtubPenalty(rawStageFt);
        const { indices, ground } = transition;
        let addedPixelCount = 0;
        let cursor = 0;
        while (cursor < indices.length) {
          const y = Math.floor(Math.floor(indices[cursor] / width) / RASTER_STRIPE_ROWS) * RASTER_STRIPE_ROWS;
          const rows = Math.min(RASTER_STRIPE_ROWS, height - y);
          const first = cursor;
          const stripeEnd = (y + rows) * width;
          while (cursor < indices.length && indices[cursor] < stripeEnd) cursor += 1;
          let hasChanges = false;
          for (let i = first; i < cursor; i += 1) {
            if ((ground[i] - 32768) / 10 <= adjustedStage + 1e-9) { hasChanges = true; break; }
          }
          if (!hasChanges) continue;
          const imageData = context.getImageData(0, y, width, rows);
          const pixels = imageData.data;
          for (let i = first; i < cursor; i += 1) {
            const groundFt = (ground[i] - 32768) / 10;
            if (groundFt > adjustedStage + 1e-9) continue;
            const depthFt = Math.max(0.005, adjustedStage - groundFt);
            const color = getDrainageDepthColor(depthFt);
            const offset = (indices[i] - y * width) * 4;
            const sourceAlpha = pixels[offset + 3];
            if (sourceAlpha > 0) {
              pixels[offset] = Math.round(pixels[offset] * (1 - blend) + color[0] * blend);
              pixels[offset + 1] = Math.round(pixels[offset + 1] * (1 - blend) + color[1] * blend);
              pixels[offset + 2] = Math.round(pixels[offset + 2] * (1 - blend) + color[2] * blend);
              pixels[offset + 3] = Math.round(sourceAlpha * (1 - blend) + 225 * blend);
            } else {
              pixels[offset] = color[0];
              pixels[offset + 1] = color[1];
              pixels[offset + 2] = color[2];
              pixels[offset + 3] = Math.round(225 * blend);
            }
            addedPixelCount += 1;
          }
          context.putImageData(imageData, 0, y);
        }
        if (!addedPixelCount) return lowerRecord;
        return { ...lowerRecord, url: await canvasToFillingObjectUrl(canvas),
          isContinuousFillingComposite: true, isSparseFillingComposite: true,
          fillingFraction: fraction, addedPixelCount };
      } finally {
        canvas.width = canvas.height = 0;
      }
    }
  async function getSourceHydraulicOverlayRecord(mode, stageValue, phase = "slack", entry = null, series = currentSeriesHours) {
      const rawStage = normalizeStageValue(stageValue);
      if (rawStage == null) return null;
      const lowerStage = getOverlayStage(rawStage);
      let baseRecord = await getOverlayRecord(mode, rawStage, phase);
      if (!baseRecord || !entry) return baseRecord;
      baseRecord = await getFillingInterpolatedOverlayRecord(mode, lowerStage, phase, entry, baseRecord);
      const milestones = getDrainageRetentionMilestones(entry, series);
      if (!milestones.length) return baseRecord;
      const key = ["history-drainage", mode, Number(rawStage).toFixed(3), normalizeHydraulicPhase(phase), entryTimeMs(entry), getStageValue(entry),
        ...milestones.map(item => `${entryTimeMs(item)}:${normalizeHydraulicPhase(item.hydraulicPhase)}:${stageToCode(getOverlayStage(getStageValue(item)))}:${getStageValue(item)}`)].join("|");
      if (drainageCompositeCache.has(key)) {
        const cached = drainageCompositeCache.get(key);
        drainageCompositeCache.delete(key);
        drainageCompositeCache.set(key, cached);
        return cached;
      }
      const request = (async () => {
        const historicalRecords = (await Promise.all(milestones.map(item => {
          const itemStage = getOverlayStage(getStageValue(item));
          return itemStage == null ? Promise.resolve(null) : getOverlayRecord(mode, itemStage, getHydraulicPhaseForEntry(item, null, series));
        }))).filter(Boolean);
        if (!historicalRecords.length) return baseRecord;
        const [baseImage, queryGrid, ...historyImages] = await Promise.all([
          getExportImageElement(baseRecord.url), getHydraulicQueryGrid(),
          ...historicalRecords.map(record => getExportImageElement(record.url))
        ]);
        if (!baseImage || !queryGrid || historyImages.some(image => !image)) return baseRecord;
        if (baseImage.naturalWidth !== queryGrid.width || baseImage.naturalHeight !== queryGrid.height ||
            historyImages.some(image => image.naturalWidth !== baseImage.naturalWidth || image.naturalHeight !== baseImage.naturalHeight)) {
          console.warn("Drainage retention skipped because its raster grids do not match.");
          return baseRecord;
        }
        const canvas = document.createElement("canvas");
        canvas.width = baseImage.naturalWidth; canvas.height = baseImage.naturalHeight;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) return baseRecord;
        context.drawImage(baseImage, 0, 0);
        const currentImageData = context.getImageData(0, 0, canvas.width, canvas.height);
        const historicalPixelSets = historyImages.map(image => {
          context.clearRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0);
          return context.getImageData(0, 0, canvas.width, canvas.height).data;
        });
        const retainedPixelCount = applyDrainageRetentionPixels(currentImageData.data, historicalPixelSets, queryGrid.values, rawStage, mode);
        if (!retainedPixelCount) return baseRecord;
        context.putImageData(currentImageData, 0, 0);
        return { ...baseRecord, url: await canvasToFillingObjectUrl(canvas), isHistoryAwareDrainageComposite: true, retainedPixelCount };
      })().catch(error => {
        console.warn("Could not build the history-aware drainage raster; using the static phase raster.", error);
        return baseRecord;
      });
      drainageCompositeCache.set(key, request);
      const record = await request;
      return cacheDrainageComposite(key, record);
    }
  const CATALOG_DEPTH_COLORS = palette.depth;

  const CATALOG_STAGE_COLORS = palette.stages;

  const CATALOG_UNCERTAINTY_COLOR = palette.uncertainty;

  const displayOverlayCache = new Map();

  const DISPLAY_OVERLAY_CACHE_LIMIT = FLOOD_COMPOSITE_CACHE_COMPACT ? 64 : 96;

  const DISPLAY_OVERLAY_CACHE_BYTE_LIMIT = (FLOOD_COMPOSITE_CACHE_COMPACT ? 8 : 16) * 1024 * 1024;

  function applyOverlayDisplayColors(pixels, mode) {
      const uncertainty = getUncertaintyRasterColor();
      const displayPalette = mode === "depth" ? DRAINAGE_DEPTH_COLORS : DRAINAGE_STAGE_COLORS;
      const catalogPalette = mode === "depth" ? CATALOG_DEPTH_COLORS : CATALOG_STAGE_COLORS;
      const sourcePalettes = [catalogPalette, displayPalette];
      const colors = new Map();
      for (let offset = 0; offset < pixels.length; offset += 4) {
        if (pixels[offset + 3] <= 8 || isUncertaintyRasterPixel(pixels, offset, uncertainty)) continue;
        const red = pixels[offset];
        const green = pixels[offset + 1];
        const blue = pixels[offset + 2];
        const key = (red << 16) | (green << 8) | blue;
        let color = colors.get(key);
        if (!color) {
          if (isUncertaintyRasterPixel(pixels, offset, CATALOG_UNCERTAINTY_COLOR)) {
            color = uncertainty;
          } else {
            let bestDistance = Infinity;
            let bestIndex = 0;
            for (const palette of sourcePalettes) {
              for (const [index, [r, g, b]] of palette.entries()) {
                const distance = (red - r) ** 2 + (green - g) ** 2 + (blue - b) ** 2;
                if (distance < bestDistance) {
                  bestDistance = distance;
                  bestIndex = index;
                }
              }
            }
            color = displayPalette[bestIndex];
          }
          colors.set(key, color);
        }
        pixels[offset] = color[0]; pixels[offset + 1] = color[1]; pixels[offset + 2] = color[2];
      }
      return pixels;
    }
  async function getDisplayOverlayRecord(record, mode) {
      if (!record?.url || record.displayPaletteMode === mode) return record;
      const key = `${mode}:${record.url}`;
      if (displayOverlayCache.has(key)) {
        const cached = displayOverlayCache.get(key);
        displayOverlayCache.delete(key);
        displayOverlayCache.set(key, cached);
        return cached;
      }
      const request = (async () => {
        const image = await getExportImageElement(record.url);
        throwIfExportCancelled();
        if (!image) throw new Error("The flood overlay image could not load.");
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("The flood overlay canvas is unavailable.");
        context.drawImage(image, 0, 0);
        const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
        applyOverlayDisplayColors(imageData.data, mode);
        context.putImageData(imageData, 0, 0);
        const url = await canvasToFillingObjectUrl(canvas);
        const paletteByteLength = floodCompositeBlobSizes.get(url) || 0;
        floodCompositeBlobSizes.delete(url);
        return { ...record, url, displayPaletteMode: mode, paletteByteLength };
      })();
      displayOverlayCache.set(key, request);
      try {
        const result = await request;
        displayOverlayCache.set(key, result);
        // Pending requests still coalesce, but do not block eviction of finished images.
        const completed = Array.from(displayOverlayCache.entries()).filter(([, item]) => item?.url);
        let bytes = completed.reduce((total, [, item]) => total + (item.paletteByteLength || 0), 0);
        while (completed.length > DISPLAY_OVERLAY_CACHE_LIMIT ||
          (completed.length > 1 && bytes > DISPLAY_OVERLAY_CACHE_BYTE_LIMIT)) {
          // Keep this result usable even if a single image exceeds the byte budget.
          const oldestIndex = completed.findIndex(([cachedKey]) => cachedKey !== key);
          if (oldestIndex < 0) break;
          const [oldestKey, oldest] = completed.splice(oldestIndex, 1)[0];
          bytes -= oldest.paletteByteLength || 0;
          URL.revokeObjectURL(oldest.url);
          exportImageElementCache.delete(oldest.url);
          preloadPromiseCache.delete(oldest.url);
          displayOverlayCache.delete(oldestKey);
        }
        return result;
      } catch (error) {
        displayOverlayCache.delete(key);
        throw error;
      }
    }
  const projection = "+proj=tmerc +lat_0=38.8333333333333 +lon_0=-74.5 +k=0.9999 +x_0=150000 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=us-ft +no_defs +type=crs";

  let townCogImage;

  async function sampleTownCog(lat, lon) {
      const raster = TOWN_CONFIG.overlays.legacyExactQuery;
      if (!raster || !window.proj4) return null;
      const [[south, west], [north, east]] = raster.bounds;
      if (lat < south || lat > north || lon < west || lon > east) return null;
      const [originX, stepX, rotX, originY, rotY, stepY] = raster.geoTransform;
      if (rotX !== 0 || rotY !== 0 || !stepX || !stepY) return null;
      if (!proj4.defs("EPSG:6527")) proj4.defs("EPSG:6527", projection);
      const [x, y] = proj4("EPSG:4326", "EPSG:6527", [lon, lat]);
      const col = Math.floor((x - originX) / stepX), row = Math.floor((y - originY) / stepY);
      if (col < 0 || col >= raster.width || row < 0 || row >= raster.height) return null;
      if (!townCogImage) {
        townCogImage = (async () => {
          await ensureDepthQueryLibrary();
          return readDepthCogWithDeadline(async signal => (await GeoTIFF.fromUrl(raster.cogUrl, {}, signal)).getImage());
        })().catch(error => {townCogImage = null; throw error;});
      }
      const image = await townCogImage;
      const result = await readDepthCogWithDeadline(signal => image.readRasters({
        window: [col, row, col + 1, row + 1], width: 1, height: 1, interleave: true, signal,
      }));
      const elevation = Number(result[0]);
      return Number.isFinite(elevation) && Math.abs(elevation - raster.noDataValue) >= 0.0001 ? {elevation} : null;
    }
  return format === "phase-v1" ? { getHydraulicOverlayRecord, getOverlayStage, getHydraulicPhaseForEntry, annotateHydraulicSeries, stageToCode, sample: sampleTownCog, townDepth, getHydraulicQueryGrid, getPenalizedWaterSurfaceStage, getUncertaintyRasterColor, isWetRasterPixel } : { getHydraulicOverlayRecord, getOverlayStage, getHydraulicPhaseForEntry, annotateHydraulicSeries, stageToCode, sample: sampleTownQueryGrid, townDepth, sampleTownRenderedPixel };
}

function installDailyObservationReader() {
  const loadSharedObservedData = loadObserved;
      let nativeObservationRequest;
      let nativeObservationGeneration = -1;
      preloadObservedArchiveIndexText = async () => null;
      ensureObserved15MinuteArchive = async () => null;
      ensureCanonicalDailyArchive = async () => null;
      warmBackgroundData = async () => {
        await loadObserved();
        return observedData;
      };
      ensureObservedArchiveForDate = async () => {
        await loadObserved();
        return true;
      };
      ensureObservedArchiveRange = ensureObservedArchiveForDate;
      loadObserved = async () => {
        const generation = archiveGeneration;
        if (!observedData) {
          if (!nativeObservationRequest || nativeObservationGeneration !== generation) {
            nativeObservationGeneration = generation;
            nativeObservationRequest = fetchJson(OBSERVED_URL, { cache: "default", timeoutMs: 90000 });
          }
          const request = nativeObservationRequest;
          try {
            const snapshot = await request;
            if (generation !== archiveGeneration) return false;
            if (!Array.isArray(snapshot?.days)) throw new Error("The town observations are unavailable.");
            observedData = snapshot;
            observedDaysCache = null;
            clearExportAvailabilityCache();
          } finally {
            if (nativeObservationRequest === request) nativeObservationRequest = null;
          }
        }
        return loadSharedObservedData();
      };
}

function installCertifiedFloorReader() {
  const fetchSharedMapperJson = fetchJson;
      const sharedFirstOccupiedFloor = getNsiFirstOccupiedFloorNavd88;
      const sharedStructurePopup = buildNsiStructurePopup;
      let certifiedFloorRecords;

      async function loadCertifiedFloorRecords() {
        if (!certifiedFloorRecords) {
          const url = new URL(TOWN_CONFIG.structures.certifiedFirstFloorsPath, APP_BASE).href;
          certifiedFloorRecords = fetchSharedMapperJson(url, {cache: "default"}).then(payload => {
            if (payload?.schema !== TOWN_CONFIG.structures.certifiedFloorSchema || !payload.buildings ||
                typeof payload.buildings !== "object" || Array.isArray(payload.buildings)) {
              throw new Error("The certified elevation release is invalid.");
            }
            return new Map(Object.entries(payload.buildings));
          }).catch(error => {certifiedFloorRecords = null; throw error;});
        }
        return certifiedFloorRecords;
      }

      fetchJson = async (url, options) => {
        const value = await fetchSharedMapperJson(url, options);
        const source = new URL(url, APP_BASE).pathname;
        const nativeStructures = [NSI_STRUCTURES_URL, PARCELS_URL].filter(Boolean).map(path => new URL(path, APP_BASE).pathname);
        if (!nativeStructures.includes(source) || !Array.isArray(value?.features)) return value;
        try {
          const certified = await loadCertifiedFloorRecords();
          for (const feature of value.features) {
            const p = feature?.properties;
            const entry = certified.get(p?.footprintId);
            if (!Number.isFinite(entry?.firstFloorNavd88Ft) || (p.parcelId && p.parcelId !== entry.parcelId)) continue;
            p.certifiedFirstFloorNavd88Ft = entry.firstFloorNavd88Ft;
            p.certifiedHistoricFirstFloorExceedanceCount = entry.historicFloodEventCount;
            p.certifiedStructurePoint = entry.structurePoint;
          }
        } catch (error) {
          console.warn("Certified first floors are currently unavailable; showing modeled elevations.", error);
        }
        return value;
      };
      getNsiFirstOccupiedFloorNavd88 = properties =>
        finiteStructureNumber(properties?.certifiedFirstFloorNavd88Ft) ?? sharedFirstOccupiedFloor(properties);
      buildNsiStructurePopup = feature => {
        const popup = sharedStructurePopup(feature);
        if (!Number.isFinite(feature?.properties?.certifiedFirstFloorNavd88Ft)) return popup;
        return popup.replace("Estimated First-Floor Flooding", "Certified First-Floor Elevation")
          .replace("estimated occupied floor", "certified first-floor elevation")
          .replace('class="house-alert-note">Estimate', 'class="house-alert-note">Elevation certificate');
      };
}

function installFloodDataReaders(config) {
  const format = config.compatibility.hydraulicCatalog;
  if (format !== "v29") {
    const adapter = createHydraulicCatalogAdapter(format, config.overlays.catalogPalette);
    getHydraulicOverlayRecord = adapter.getHydraulicOverlayRecord;
    getOverlayStage = adapter.getOverlayStage;
    getHydraulicPhaseForEntry = adapter.getHydraulicPhaseForEntry;
    annotateHydraulicSeries = adapter.annotateHydraulicSeries;
    stageToCode = adapter.stageToCode;
    sampleDepthModel = adapter.sample;
    getDepthQueryDisplayDepth = adapter.townDepth;
    if (adapter.sampleTownRenderedPixel) sampleRenderedFloodPixel = adapter.sampleTownRenderedPixel;
    window.floodmapperHydraulicCatalog = adapter;
  }
  if (config.data.observedFormat === "days") installDailyObservationReader();
  if (config.structures?.certifiedFirstFloorsPath) installCertifiedFloorReader();
}
