    function buildHourlyRangeFrameItems(entries, range, sourceSeries = new Map()) {
      if (!Array.isArray(entries) || !entries.length || !range ||
          !Number.isFinite(range.startMs) || !Number.isFinite(range.endMs) || range.endMs < range.startMs) return [];
      // Source data is padded for interpolation by the other export cadences.
      // An hourly frame keeps its real source timestamp and must remain inside
      // the user's exact bounds, including fractional-minute endpoints.
      const sorted = entries.filter(entry => {
        const time = entryTimeMs(entry);
        return Number.isFinite(time) && time >= range.startMs && time <= range.endMs;
      }).sort((a, b) => entryTimeMs(a) - entryTimeMs(b));
      const usedKeys = new Set();
      const items = [];
      const hourMs = 60 * 60 * 1000;
      // UTC hour slots distinguish both occurrences of a repeated New York
      // hour and never invent a reading in the missing spring-forward hour.
      const firstSlotMs = Math.ceil(range.startMs / hourMs) * hourMs;
      for (let slotMs = firstSlotMs; slotMs <= range.endMs; slotMs += hourMs) {
        const match = findClosestExportEntryForSlot(sorted, slotMs, usedKeys, 31 * 60 * 1000);
        if (!match) continue;
        usedKeys.add(match.key);
        const exportEntry = {
          ...match.entry,
          observationInterval: "1hour",
          timelineIntervalMinutes: 60,
          exportInterval: "hourly"
        };
        const item = getDownloadFrameItemFromEntry(exportEntry, sourceSeries);
        if (item) items.push(item);
      }
      return items;
    }

    function getQuarterHourExportEntries(entries, range, sourceSeries = new Map()) {
      if (!Array.isArray(entries) || !entries.length || !range) return [];
      const byTime = new Map();
      const observedDates = new Set();
      const projected = entries.filter(entry => {
        if (entry.exportSourceMode && entry.exportSourceMode !== "observed") return true;
        if (entry.observedDate) observedDates.add(entry.observedDate);
        return false;
      });
      // The observed timeline decides which quarter hours actually exist.
      // In particular, the forecast's hourly interpolation cannot fill a gauge outage.
      observedDates.forEach(dateStr => {
        const canonical = buildObservedCanonicalSeries(getObservedDayRecord(dateStr), dateStr);
        sourceSeries.set(`observed:${dateStr}`, canonical);
        canonical.forEach(entry => {
          const time = entryTimeMs(entry);
          if (!entry.isDailyPeakOnly && Number.isFinite(getStageValue(entry)) &&
              time >= range.startMs && time <= range.endMs) {
            byTime.set(time, { ...entry, exportSourceMode: "observed" });
          }
        });
      });
      if (projected.length) {
        const quarterHourMs = 15 * 60 * 1000;
        const series = buildQuarterHourTimelineSeries(projected, {
          kind: projected[0].exportSourceMode,
          startMs: Math.ceil(range.startMs / quarterHourMs) * quarterHourMs,
          endMs: range.endMs,
          fillMissingSlots: false,
          maxGapMinutes: 75
        });
        const preferObserved = currentDataMode === "observed";
        series.forEach(entry => {
          const time = entryTimeMs(entry);
          if (!preferObserved || !byTime.has(time)) byTime.set(time, entry);
        });
      }
      return Array.from(byTime.values()).sort((a, b) => entryTimeMs(a) - entryTimeMs(b))
        .filter(entry => Number.isFinite(getStageValue(entry)));
    }

    function buildQuarterHourRangeFrameItems(entries, range, sourceSeries = new Map()) {
      return getQuarterHourExportEntries(entries, range, sourceSeries)
        .map(entry => {
          const exportEntry = {
            ...entry,
            observationInterval: "15min",
            timelineIntervalMinutes: 15,
            exportInterval: "15min"
          };
          return getDownloadFrameItemFromEntry(exportEntry, sourceSeries);
        })
        .filter(Boolean);
    }

    function buildDailyMaximumRangeFrameItems(entries, range, sourceSeries = new Map()) {
      if (!Array.isArray(entries) || !entries.length || !range) return [];
      const inRange = entries.filter(entry => {
        const time = entryTimeMs(entry);
        return Number.isFinite(time) && time >= range.startMs && time <= range.endMs && Number.isFinite(getStageValue(entry));
      });
      const daily = currentDataMode === "return-interval"
        ? buildReturnIntervalDailyMaximumSeries(inRange)
        : buildDailyMaximumSeries(inRange, { kind: "export" });
      return daily
        .map(entry => {
          const exportEntry = {
            ...entry,
            exportSourceMode: entry.exportSourceMode || "observed",
            observationInterval: "daily",
            timelineIntervalMinutes: 1440,
            exportInterval: "daily"
          };
          return getDownloadFrameItemFromEntry(exportEntry, sourceSeries);
        })
        .filter(Boolean);
    }

    function buildExportRangeFrameItems(entries, range, intervalValue = getDownloadIntervalValue()) {
      if (intervalValue === "daily") return buildDailyMaximumRangeFrameItems(entries, range);
      const timed = entries.filter(entry => !entry.isDailyPeakOnly);
      const dailyOnly = buildDailyMaximumRangeFrameItems(entries.filter(entry => entry.isDailyPeakOnly), range);
      const frames = intervalValue === "15min"
        ? buildQuarterHourRangeFrameItems(timed, range)
        : buildHourlyRangeFrameItems(timed, range);
      // Unknown peak times must never become interpolation endpoints or gain
      // an hourly/quarter-hour label merely because of the export selection.
      return [...frames, ...dailyOnly].sort((a, b) => entryTimeMs(a.entry) - entryTimeMs(b.entry));
    }


    async function withExportFrames(frameItems, onFrame, progressStart = 4, progressEnd = 82) {
      const total = Math.max(1, frameItems.length);
      exportFrameViewPrimed = false;
      throwIfExportCancelled();
      for (let i = 0; i < frameItems.length; i++) {
        const item = frameItems[i];
        throwIfExportCancelled();
        const pct = progressStart + ((i / total) * (progressEnd - progressStart));
        const message = `Rendering frame ${i + 1} of ${frameItems.length}...`;
        setDownloadStatus(message);
        setExportProgress(message, pct, false);
        await prepareExportFrame(item, { isFirstFrame: i === 0 });
        throwIfExportCancelled();
        const canvas = await captureExportCanvas();
        try {
          throwIfExportCancelled();
          await onFrame({ sequence: i, item, entry: item.entry, canvas });
          throwIfExportCancelled();
        } finally {
          canvas.width = 1;
          canvas.height = 1;
        }
        const donePct = progressStart + (((i + 1) / total) * (progressEnd - progressStart));
        setExportProgress(`Rendered frame ${i + 1} of ${frameItems.length}...`, donePct, false);
      }
    }

    function canvasToBlob(canvas, type = "image/png", quality) {
      return new Promise((resolve, reject) => {
        if (!canvas || typeof canvas.toBlob !== "function") {
          reject(new Error("Canvas export failed because this browser cannot create image blobs."));
          return;
        }
        canvas.toBlob(blob => {
          if (blob) {
            resolve(blob);
          } else {
            reject(new Error("Canvas export failed because the map image could not be converted to a file."));
          }
        }, type, quality);
      });
    }

    function drawRoundedRectPath(ctx, x, y, width, height, radius) {
      const r = Math.max(0, Math.min(radius, width / 2, height / 2));
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + width - r, y);
      ctx.quadraticCurveTo(x + width, y, x + width, y + r);
      ctx.lineTo(x + width, y + height - r);
      ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
      ctx.lineTo(x + r, y + height);
      ctx.quadraticCurveTo(x, y + height, x, y + height - r);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.closePath();
    }

    function drawExportTimestampOnCanvas(ctx, canvas, entry) {
      const scale = getExportCaptureScale();
      const layout = getExportFooterLayout(canvas.width / scale, canvas.height / scale);
      const fontFamily = "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
      ctx.save();
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      getExportTimestampRows(entry, layout).forEach(row => {
        ctx.font = `${row.weight} ${row.size * scale}px ${fontFamily}`;
        ctx.fillStyle = row.color;
        ctx.fillText(row.text, row.x * scale, (row.y + row.height / 2) * scale, row.width * scale);
      });
      ctx.restore();
    }

    function drawExportFloodOnCanvas(ctx, image, rect) {
      const layout = getExportFooterLayout(ctx.canvas.width, ctx.canvas.height);
      // Raster bounds can extend beyond the map; never paint into the footer.
      ctx.save();
      ctx.beginPath();
      ctx.rect(layout.map.x, layout.map.y, layout.map.width, layout.map.height);
      ctx.clip();
      ctx.globalAlpha = Math.max(0, Math.min(1, overlayOpacity));
      ctx.drawImage(image, rect.x, rect.y, rect.width, rect.height);
      ctx.restore();
    }

    function getExportCaptureScale() {
      const dpr = Number(window.devicePixelRatio) || 1;
      return Math.max(1, Math.min(EXPORT_CAPTURE_SCALE, dpr > 1 ? dpr : EXPORT_CAPTURE_SCALE));
    }

    function getExportOverlayRect(mapInstance) {
      if (!mapInstance || !floodLatLngBounds) return null;
      // The fast compositor only supports axis-aligned image rectangles. A
      // world-file raster is captured through Leaflet so its four-corner warp
      // remains spatially correct in every exported frame.
      if (exportFloodLayer?._worldFileAffine) return null;
      const scale = getExportCaptureScale();
      const nw = mapInstance.latLngToContainerPoint(floodLatLngBounds.getNorthWest());
      const se = mapInstance.latLngToContainerPoint(floodLatLngBounds.getSouthEast());
      return {
        x: Math.round(nw.x * scale),
        y: Math.round(nw.y * scale),
        width: Math.round((se.x - nw.x) * scale),
        height: Math.round((se.y - nw.y) * scale)
      };
    }


    async function captureFastGifBaseCanvas(firstItem) {
      await ensureExportMunicipalBoundary();
      await prepareExportRoadNames();
      const mapInstance = ensureExportMap();
      applyExportStageAspect(getDownloadAspectValue());
      mapInstance.invalidateSize(false);
      updateExportLegend(firstItem?.entry);
      updateExportBoundaryVisibility();
      await updateExportParcelsLayer();
      fitExportMapToSelectedExtent(mapInstance);
      updateExportRoadLayerAppearance();

      if (exportFloodLayer && mapInstance.hasLayer(exportFloodLayer)) {
        mapInstance.removeLayer(exportFloodLayer);
      }
      const timestamp = document.getElementById("exportTimestampLabel");
      const legend = document.getElementById("exportLegendDock");
      const logoStrip = document.getElementById("exportLogoStrip");
      const previousTimestampVisibility = timestamp?.style.visibility || "";
      const previousLegendVisibility = legend?.style.visibility || "";
      const previousLogoVisibility = logoStrip?.style.visibility || "";
      let baseCanvas;
      try {
        if (timestamp) timestamp.style.visibility = "hidden";
        if (legend) legend.style.visibility = "hidden";
        if (logoStrip) logoStrip.style.visibility = "hidden";
        await waitForExportMapReady(80);
        await waitForStableRender();
        baseCanvas = await captureExportCanvas({ omitRoadLabels: exportUsesScalableRoadLabels() });
      } finally {
        // A cancelled/failed capture must not hide chrome in later exports.
        if (timestamp) timestamp.style.visibility = previousTimestampVisibility;
        if (legend) legend.style.visibility = previousLegendVisibility;
        if (logoStrip) logoStrip.style.visibility = previousLogoVisibility;
      }
      let mapForegroundCanvas, roadLabelsCanvas, chromeCanvas;
      try {
        mapForegroundCanvas = await captureExportMapForegroundCanvas();
        roadLabelsCanvas = await captureExportRoadLabelsCanvas(baseCanvas);
        chromeCanvas = await captureExportChromeCanvas();
        updateExportTimestampLabel(firstItem?.entry || null);
        return { baseCanvas, overlayRect: getExportOverlayRect(mapInstance), mapForegroundCanvas, roadLabelsCanvas, chromeCanvas };
      } catch (error) {
        [baseCanvas, mapForegroundCanvas, roadLabelsCanvas, chromeCanvas].filter(Boolean).forEach(canvas => {
          canvas.width = 1;
          canvas.height = 1;
        });
        throw error;
      }
    }

    async function addFastCompositeGifFrames(gif, frameItems, progressStart = 4, progressEnd = 96) {
      const total = Math.max(1, frameItems.length);
      throwIfExportCancelled();
      const {
        baseCanvas,
        overlayRect,
        mapForegroundCanvas,
        roadLabelsCanvas,
        chromeCanvas
      } = await captureFastGifBaseCanvas(frameItems[0]);
      const frameCanvas = document.createElement("canvas");
      try {
        throwIfExportCancelled();
        frameCanvas.width = baseCanvas.width;
        frameCanvas.height = baseCanvas.height;
        const ctx = frameCanvas.getContext("2d", { alpha: false, willReadFrequently: false });
        if (ctx) { ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high"; }
        if (!ctx || !overlayRect) {
          await withExportFrames(frameItems, async ({ canvas }) => {
            await gif.addFrame(canvas, { delay: getGifFrameDelayMs() });
          }, progressStart, progressEnd);
          return;
        }
        for (let i = 0; i < frameItems.length; i++) {
          const item = frameItems[i];
          throwIfExportCancelled();
          const pct = progressStart + ((i / total) * (progressEnd - progressStart));
          const message = `Encoding frame ${i + 1} of ${frameItems.length}...`;
          if (i === 0 || i === frameItems.length - 1 || i % EXPORT_PROGRESS_UPDATE_EVERY === 0) {
            setDownloadStatus(message);
            setExportProgress(message, pct, false);
          }
          ctx.globalAlpha = 1;
          ctx.globalCompositeOperation = "source-over";
          ctx.drawImage(baseCanvas, 0, 0);
          {
            const overlayImg = await getExportFrameImage(item);
            drawExportFloodOnCanvas(ctx, overlayImg, overlayRect);
          }
          if (mapForegroundCanvas) ctx.drawImage(mapForegroundCanvas, 0, 0, frameCanvas.width, frameCanvas.height);
          if (roadLabelsCanvas) ctx.drawImage(roadLabelsCanvas, 0, 0, frameCanvas.width, frameCanvas.height);
          if (chromeCanvas) ctx.drawImage(chromeCanvas, 0, 0, frameCanvas.width, frameCanvas.height);
          drawExportTimestampOnCanvas(ctx, frameCanvas, item.entry);
          await gif.addFrame(frameCanvas, { delay: getGifFrameDelayMs() });
          throwIfExportCancelled();
          const donePct = progressStart + (((i + 1) / total) * (progressEnd - progressStart));
          if (i === frameItems.length - 1 || i % EXPORT_PROGRESS_UPDATE_EVERY === 0) {
            setExportProgress(`Encoded frame ${i + 1} of ${frameItems.length}...`, donePct, false);
          }
          if (i % 8 === 7) await wait(0);
        }
      } finally {
        [baseCanvas, mapForegroundCanvas, roadLabelsCanvas, chromeCanvas, frameCanvas].filter(Boolean).forEach(canvas => {
          canvas.width = 1;
          canvas.height = 1;
        });
      }
    }

    async function buildStableExportGifPalette(firstItem, workerScript, aspectConfig, gifQuality) {
      throwIfExportCancelled();
      setDownloadStatus("Locking GIF key colors...");
      setExportProgress("Locking GIF key colors...", 4, false);
      exportFrameViewPrimed = false;
      await prepareExportFrame(firstItem, { isFirstFrame: true });
      throwIfExportCancelled();

      const paletteCanvas = await captureExportCanvas();
      const exportScale = getExportCaptureScale();
      let paletteGif;
      try {
        paletteGif = createStreamingGifEncoder({
          quality: gifQuality,
          workerScript,
          width: Math.round(aspectConfig.width * exportScale),
          height: Math.round(aspectConfig.height * exportScale),
          dither: EXPORT_GIF_DITHER,
          globalPalette: true,
        }, 1);
        activeGifExport = paletteGif;
        await paletteGif.addFrame(paletteCanvas, { delay: 1 });
        throwIfExportCancelled();
        const palette = paletteGif.getGlobalPalette();
        if (!palette || typeof palette.length !== "number" || palette.length < 3) {
          throw new Error("Could not create a stable GIF color palette.");
        }
        return Array.from(palette);
      } finally {
        if (activeGifExport === paletteGif) activeGifExport = null;
        paletteGif?.dispose();
        paletteCanvas.width = 1;
        paletteCanvas.height = 1;
      }
    }

    async function exportGif(frameItems) {
      throwIfExportCancelled();
      if (typeof Worker === "undefined") {
        throw new Error("This browser cannot encode GIF images.");
      }
      const aspectConfig = applyExportStageAspect(getDownloadAspectValue());
      const items = frameItems.slice(0, getDownloadFrameLimit());
      if (!items.length) throw new Error("No frames are available for export.");
      setDownloadStatus(`Preparing ${aspectConfig.label} GIF...`);
      setExportProgress(`Preparing ${aspectConfig.label} GIF...`, 2, false);
      const workerScript = await getGifWorkerUrl();
      throwIfExportCancelled();

      const gifQuality = EXPORT_GIF_QUALITY;

      const exportScale = getExportCaptureScale();
      const stableGlobalPalette = await buildStableExportGifPalette(items[0], workerScript, aspectConfig, gifQuality);
      throwIfExportCancelled();
      const gif = createStreamingGifEncoder({
        quality: gifQuality,
        workerScript,
        width: Math.round(aspectConfig.width * exportScale),
        height: Math.round(aspectConfig.height * exportScale),
        dither: EXPORT_GIF_DITHER,
        // Use the same precomputed palette for every frame, including frame one. This keeps
        // static chrome—especially the flood-depth key—pixel-stable throughout the GIF.
        globalPalette: stableGlobalPalette,
      }, items.length);
      activeGifExport = gif;
      try {
        await addFastCompositeGifFrames(gif, items, 8, 96);
        throwIfExportCancelled();
        const blob = gif.finish();
        setExportProgress("Starting GIF download...", 99, false);
        downloadBlob(blob, `${getExportBaseName(items)}.gif`);
      } finally {
        gif.dispose();
        if (activeGifExport === gif) activeGifExport = null;
      }
    }

    async function exportPng(frameItems) {
      throwIfExportCancelled();
      const aspectConfig = applyExportStageAspect(getDownloadAspectValue());
      const items = frameItems.slice(0, EXPORT_PNG_SELECTION_LIMIT);
      setDownloadStatus(`Preparing ${items.length} PNG frame${items.length === 1 ? "" : "s"}...`);
      setExportProgress(`Preparing ${aspectConfig.label} PNG export...`, 2, false);

      if (items.length === 1) {
        await withExportFrames(items, async ({ canvas, entry, sequence }) => {
          const blob = await canvasToBlob(canvas, "image/png");
          throwIfExportCancelled();
          downloadBlob(blob, `${getExportBaseName(items)}-${getSafeFrameStamp(entry, sequence)}.png`);
        }, 8, 94);
        return;
      }

      if (typeof JSZip === "undefined") {
        throw new Error("PNG zip export library did not load.");
      }
      const zip = new JSZip();
      await withExportFrames(items, async ({ canvas, entry, sequence }) => {
        const blob = await canvasToBlob(canvas, "image/png");
        throwIfExportCancelled();
        zip.file(`${String(sequence + 1).padStart(2, "0")}-${getSafeFrameStamp(entry, sequence)}.png`, blob);
        throwIfExportCancelled();
      }, 8, 76);
      setDownloadStatus("Packaging PNG files...");
      setExportProgress("Packaging PNG files...", 82, false);
      const zipBlob = await zip.generateAsync({ type: "blob", compression: "STORE" }, metadata => {
        throwIfExportCancelled();
        const pct = 82 + ((Number(metadata.percent) || 0) * 0.16);
        setExportProgress(`Packaging PNG files... ${Math.round(metadata.percent || 0)}%`, pct, false);
      });
      throwIfExportCancelled();
      downloadBlob(zipBlob, `${getExportBaseName(items)}-pngs.zip`);
    }

    async function downloadCurrentSelection() {
      if (exportInProgress) return;
      stopPlayback();
      if (getDownloadScopeValue() === "current" && floodFrameState !== "ready") {
        setDownloadStatus("Wait for a valid flood map before exporting this selection.", true);
        return;
      }
      syncDownloadRangeInputs(false);
      const format = getDownloadFormatValue();
      const validation = validateDownloadRangeForExport();
      if (!validation.ok) {
        const popupTitle = validation.reason === "range-too-long"
          ? "Time range too long"
          : "Check export range";
        // Preview preparation can outlast the activating click and disable
        // this button briefly. Restore the warning to the actual action.
        showExportDateOrderPopup(validation.message, popupTitle, document.getElementById("downloadBtn"));
        updateDownloadSummary();
        return;
      }

      const needsArchive = getDownloadScopeValue() !== "current" && exportRangeNeedsObservedArchive(validation.range);
      // Close the settings dialog before showing progress so its focus/inert
      // isolation cannot disable the progress Cancel button during preparation.
      setDownloadModalOpen(false);
      setDownloadBusy(true, needsArchive ? "Preparing export..." : "Preparing export...");
      try {
        if (needsArchive) {
          await awaitRasterRequest(ensureExportArchiveAvailability());
          throwIfExportCancelled();
          const availableValidation = validateDownloadRangeForExport();
          if (!availableValidation.ok) throw new Error(availableValidation.message);
          try {
            await awaitRasterRequest(ensureObservedArchiveRange(validation.range.startDate, validation.range.endDate));
          } catch (error) {
            throwIfExportCancelled();
            throw new Error("The selected tide-archive year could not be loaded. Please try again.", { cause: error });
          }
        }
        throwIfExportCancelled();
        let frameItems = getDownloadFrameItems();
        if (format === "png" && frameItems.length > EXPORT_PNG_SELECTION_LIMIT) {
          frameItems = frameItems.slice(0, EXPORT_PNG_SELECTION_LIMIT);
          toast(`PNG export is limited to ${EXPORT_PNG_SELECTION_LIMIT} frames.`);
        }
        if (!frameItems.length) throw new Error("No frames are available for export.");
        const label = format === "png" ? "PNG" : `${getDownloadAspectValue()} GIF`;
        setExportProgress(`Preparing ${label} export with ${frameItems.length} frame${frameItems.length === 1 ? "" : "s"}...`, 1, false);
        setDownloadStatus("Preparing export...");
        setExportProgress("Preparing export...", 1, false);
        await awaitRasterRequest(ensureExportLibraries(format, frameItems.length));
        throwIfExportCancelled();
        if (format === "png") {
          await exportPng(frameItems);
        } else {
          await exportGif(frameItems);
        }
        const doneMessage = `Downloaded ${format.toUpperCase()} export.`;
        setDownloadStatus(doneMessage);
        finishExportProgress(doneMessage, false);
      } catch (err) {
        if (isExportCancelledError(err)) {
          const cancelMessage = "Export cancelled.";
          setDownloadStatus(cancelMessage, false);
          finishCancelledExportProgress(cancelMessage);
        } else {
          console.error(err);
          const friendlyMessage = getFriendlyExportError(err, format);
          toast(friendlyMessage);
          setDownloadStatus(friendlyMessage, true);
          finishExportProgress(friendlyMessage, true);
        }
      } finally {
        setDownloadBusy(false, document.getElementById("downloadStatus")?.textContent || "");
        updateDownloadSummary();
      }
    }

