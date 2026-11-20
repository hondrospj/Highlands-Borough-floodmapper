    function getDownloadScopeValue() {
      const hiddenScope = document.getElementById("downloadScopeSelect");
      const activeScopeButton = document.querySelector("#downloadScopeControl button[data-scope].active");
      const raw = hiddenScope?.value || activeScopeButton?.dataset?.scope || "range";
      const normalized = raw === "current" ? "current" : "range";
      if (hiddenScope && hiddenScope.value !== normalized) hiddenScope.value = normalized;
      return normalized;
    }

    function getDownloadFormatValue() {
      const hiddenFormat = document.getElementById("downloadFormatSelect");
      const activeFormatButton = document.querySelector("#downloadFormatControl button[data-format].active");
      const raw = hiddenFormat?.value || activeFormatButton?.dataset?.format || "gif";
      const normalized = raw === "png" ? "png" : "gif";
      if (hiddenFormat && hiddenFormat.value !== normalized) hiddenFormat.value = normalized;
      return normalized;
    }

    function getDownloadIntervalValue() {
      const hiddenInterval = document.getElementById("downloadIntervalSelect");
      const activeIntervalButton = document.querySelector("#downloadIntervalControl button[data-export-interval].active");
      const raw = hiddenInterval?.value || activeIntervalButton?.dataset?.exportInterval || "hourly";
      const normalized = EXPORT_INTERVALS[raw] ? raw : "hourly";
      if (hiddenInterval && hiddenInterval.value !== normalized) hiddenInterval.value = normalized;
      return normalized;
    }

    function getDownloadIntervalConfig() {
      return EXPORT_INTERVALS[getDownloadIntervalValue()] || EXPORT_INTERVALS.hourly;
    }

    function getDownloadFrameLimit() {
      return getDownloadIntervalConfig().frameLimit;
    }

    function getDownloadSpeedValue() {
      const hiddenSpeed = document.getElementById("downloadSpeedSelect");
      const activeSpeedButton = document.querySelector("#downloadSpeedControl button[data-speed].active");
      const raw = hiddenSpeed?.value || activeSpeedButton?.dataset?.speed || "normal";
      const normalized = EXPORT_GIF_SPEEDS[raw] ? raw : "normal";
      if (hiddenSpeed && hiddenSpeed.value !== normalized) hiddenSpeed.value = normalized;
      return normalized;
    }

    function getGifFrameDelayMs() {
      return EXPORT_GIF_SPEEDS[getDownloadSpeedValue()]?.delayMs || 1000;
    }

    function getDownloadAspectValue() {
      const hiddenAspect = document.getElementById("downloadAspectSelect");
      const activeAspectButton = document.querySelector("#downloadAspectControl button[data-aspect].active");
      const raw = hiddenAspect?.value || activeAspectButton?.dataset?.aspect || "viewport";
      const normalized = Object.hasOwn(EXPORT_GIF_ASPECTS, raw) ? raw : "viewport";
      if (hiddenAspect && hiddenAspect.value !== normalized) hiddenAspect.value = normalized;
      return normalized;
    }

    function getDownloadExtentValue() {
      const hiddenExtent = document.getElementById("downloadExtentSelect");
      const activeExtentButton = document.querySelector("#downloadExtentControl button[data-extent].active");
      const raw = hiddenExtent?.value || activeExtentButton?.dataset?.extent || "current";
      const normalized = raw === "town" ? "town" : "current";
      if (hiddenExtent && hiddenExtent.value !== normalized) hiddenExtent.value = normalized;
      return normalized;
    }

    function getCurrentForecastExportRange() {
      const entries = getForecastExportEntriesLimited()
        .filter(entry => entryTimeMs(entry) != null)
        .sort((a, b) => entryTimeMs(a) - entryTimeMs(b));
      if (!entries.length) return null;
      const firstDate = getEntryESTDate(entries[0]);
      const lastDate = getEntryESTDate(entries[entries.length - 1]);
      if (!firstDate || !lastDate) return null;
      const cappedLast = new Date(Math.min(lastDate.getTime(), firstDate.getTime() + EXPORT_RANGE_MAX_MS));
      return { firstDate, lastDate: cappedLast };
    }

    function getCurrentSelectionExportRange() {
      if (currentDataMode === "return-interval") {
        const entries = getReturnIntervalExportEntries()
          .filter(entry => entryTimeMs(entry) != null)
          .sort((a, b) => entryTimeMs(a) - entryTimeMs(b));
        const firstDate = entries.length ? getEntryESTDate(entries[0]) : null;
        const lastDate = entries.length ? getEntryESTDate(entries[entries.length - 1]) : null;
        return firstDate && lastDate ? { firstDate, lastDate } : null;
      }
      const currentDate = getEntryESTDate(getDownloadCurrentEntry());
      if (!currentDate) return getCurrentForecastExportRange();

      const currentMs = currentDate.getTime();
      const maxEndMs = currentMs + EXPORT_RANGE_MAX_MS;
      const remainingDates = currentSeriesHours
        .map(entry => getEntryESTDate(entry))
        .filter(date => {
          const timeMs = date?.getTime();
          return Number.isFinite(timeMs) && timeMs >= currentMs && timeMs <= maxEndMs;
        })
        .sort((a, b) => a.getTime() - b.getTime());
      const lastDate = remainingDates.length
        ? remainingDates[remainingDates.length - 1]
        : currentDate;

      return { firstDate: currentDate, lastDate };
    }

    function seedDownloadRangeToCurrentSelection(force = false) {
      const startEl = document.getElementById("downloadStartInput");
      const endEl = document.getElementById("downloadEndInput");
      if (!startEl || !endEl) return false;

      const selectedRange = getCurrentSelectionExportRange();
      if (!selectedRange) return false;

      if (force) {
        delete startEl.dataset.userEdited;
        delete endEl.dataset.userEdited;
      }

      const activeEditor = document.activeElement;
      const editingStart = activeEditor && activeEditor === document.getElementById("downloadStartDateText");
      const editingEnd = activeEditor && activeEditor === document.getElementById("downloadEndDateText");
      if (force || (!editingStart && startEl.dataset.invalidDate !== "1" &&
          (!startEl.value || startEl.dataset.userEdited !== "1"))) {
        setRangeInputDate("downloadStartInput", selectedRange.firstDate);
      }
      if (force || (!editingEnd && endEl.dataset.invalidDate !== "1" &&
          (!endEl.value || endEl.dataset.userEdited !== "1"))) {
        const endDate = getDownloadFormatValue() === "png"
          ? (getRangeInputDate("downloadStartInput") || selectedRange.firstDate)
          : selectedRange.lastDate;
        setRangeInputDate("downloadEndInput", endDate);
      }
      return true;
    }

    // Freeze the visible geographic area once for the entire export job.
    let exportViewportBounds = null;

    function getActiveMapBounds() {
      const activeMap = window.NORTH_WILDWOOD_3D?.getMap?.();
      const bounds = document.body.classList.contains("map-3d-ready") && activeMap
        ? activeMap.getBounds() : map?.getBounds();
      if (!bounds) return null;
      const south = bounds.getSouth(), north = bounds.getNorth();
      const west = bounds.getWest(), east = bounds.getEast();
      if (![south, north, west, east].every(Number.isFinite) || north <= south || east <= west) return null;
      return L.latLngBounds([[south, west], [north, east]]);
    }

    // Geometry is shared by DOM captures and the fast GIF compositor. The
    // footer owns real canvas space; no title, key or logo covers the map.
    function getExportFooterLayout(width, height) {
      const w = Math.max(2, Math.round(width));
      const h = Math.max(2, Math.round(height));
      const unit = Math.max(0.125, Math.min(w / 1200, h / 900));
      const stacked = w < h * 1.1;
      const footerHeight = Math.max(1, Math.round(Math.min(h * 0.4, (stacked ? 270 : 194) * unit)));
      const mapHeight = h - footerHeight;
      const pad = Math.round(24 * unit);
      const gap = Math.round(16 * unit);
      const brandWidth = Math.round(240 * unit);
      const timestampWidth = stacked ? w - pad * 2 - brandWidth - gap : Math.round(w * 0.48) - pad - gap;
      const rightX = Math.round(w * 0.48);
      return {
        width: w, height: h, unit, stacked, footerHeight,
        map: { x: 0, y: 0, width: w, height: mapHeight },
        timestamp: { x: pad, y: mapHeight + Math.round(16 * unit), width: timestampWidth, height: Math.round(128 * unit) },
        legend: stacked
          ? { x: pad, y: mapHeight + Math.round(156 * unit), width: w - pad * 2, height: Math.round(90 * unit) }
          : { x: rightX, y: mapHeight + Math.round(16 * unit), width: w - rightX - pad, height: Math.round(90 * unit) },
        branding: stacked
          ? { x: w - pad - brandWidth, y: mapHeight + Math.round(22 * unit), width: brandWidth, height: Math.round(80 * unit) }
          : { x: rightX, y: mapHeight + Math.round(108 * unit), width: w - rightX - pad, height: Math.round(58 * unit) },
        attribution: { x: pad, y: h - Math.round(18 * unit), size: Math.max(3, Math.round(11 * unit)) }
      };
    }

    function getExportViewportConfigForRatio(ratio, longEdge) {
      const safeRatio = Number.isFinite(ratio) && ratio > 0 ? ratio : 16 / 9;
      let width = longEdge * Math.min(1, safeRatio);
      const mapHeight = longEdge / Math.max(1, safeRatio);
      let height = mapHeight;
      // Preserve the geographic map ratio with the footer outside that area.
      for (let i = 0; i < 16; i++) height = mapHeight + getExportFooterLayout(width, height).footerHeight;
      const scale = Math.min(1, longEdge / Math.max(width, height));
      width = Math.max(2, Math.round(width * scale));
      height = Math.max(2, Math.round(height * scale));
      return { value: "viewport", width, height, label: "Map view", resolutionLabel: `${width} × ${height}` };
    }

    function getExportViewportLongEdge() {
      return getDownloadFormatValue() === "png" ? 2160 : 1800;
    }

    function getExportViewportAspect() {
      const bounds = exportViewportBounds || getActiveMapBounds();
      const nw = bounds && L.CRS.EPSG3857.latLngToPoint(bounds.getNorthWest(), 0);
      const se = bounds && L.CRS.EPSG3857.latLngToPoint(bounds.getSouthEast(), 0);
      const ratio = nw && se ? (se.x - nw.x) / (se.y - nw.y) : 16 / 9;
      return getExportViewportConfigForRatio(ratio, getExportViewportLongEdge());
    }

    function fitExportMapToSelectedExtent(mapInstance, renderConfig = null) {
      if (!mapInstance) return;
      const mode = getDownloadExtentValue();

      if (mode === "town") {
        const townBounds = getBoundaryDrivenOverlayBounds();
        if (townBounds && (!townBounds.isValid || townBounds.isValid())) {
          const aspect = renderConfig || getExportAspectConfig();
          const sidePadding = Math.round(Math.min(64, aspect.width * 0.025));
          const topPadding = sidePadding;
          mapInstance.fitBounds(townBounds, {
            paddingTopLeft: [sidePadding, topPadding],
            paddingBottomRight: [sidePadding, sidePadding],
            animate: false
          });
          return;
        }
      }

      if (mode === "current") {
        const visibleBounds = exportViewportBounds || getActiveMapBounds();
        if (!visibleBounds) throw new Error("The current map view is not ready. Please try again.");
        // Fractional zoom preserves the selected area at any output resolution.
        // A chosen social aspect crops around its center instead of zooming out.
        mapInstance.options.zoomSnap = 0;
        const zoom = mapInstance.getBoundsZoom(visibleBounds, true);
        const nw = mapInstance.project(visibleBounds.getNorthWest(), zoom);
        const se = mapInstance.project(visibleBounds.getSouthEast(), zoom);
        const center = mapInstance.unproject(nw.add(se).divideBy(2), zoom);
        mapInstance.setView(center, zoom, { animate: false });
        return;
      }

      let bounds = null;
      if (mode === "simulation" && floodLatLngBounds) {
        bounds = floodLatLngBounds;
      } else if (map) {
        bounds = getActiveMapBounds();
      }

      if ((!bounds || !bounds.isValid || !bounds.isValid()) && floodLatLngBounds) {
        bounds = floodLatLngBounds;
      }

      if (bounds && (!bounds.isValid || bounds.isValid())) {
        mapInstance.fitBounds(bounds, { padding: [0, 0], animate: false });
      } else if (map) {
        mapInstance.setView(map.getCenter(), map.getZoom(), { animate: false });
      }
    }


    function getExportAspectConfig(aspect = null) {
      const selected = aspect || getDownloadAspectValue();
      if (!Object.hasOwn(EXPORT_GIF_ASPECTS, selected)) return getExportViewportAspect();
      const base = EXPORT_GIF_ASPECTS[selected];
      if (getDownloadFormatValue() !== "png") {
        return { ...base, resolutionLabel: `${base.width} × ${base.height}` };
      }
      return {
        ...base,
        width: base.pngWidth || base.width,
        height: base.pngHeight || base.height,
        resolutionLabel: `${base.pngWidth || base.width} × ${base.pngHeight || base.height}`
      };
    }

    function applyExportStageAspect(aspect = null, renderConfig = null) {
      const config = renderConfig || getExportAspectConfig(aspect);
      const layout = getExportFooterLayout(config.width, config.height);
      const stageHost = document.getElementById("exportStage");
      const stageFrame = document.getElementById("exportStageFrame");
      [stageHost, stageFrame].filter(Boolean).forEach(element => {
        element.style.width = `${config.width}px`;
        element.style.height = `${config.height}px`;
      });
      if (stageFrame) {
        stageFrame.dataset.exportAspect = config.value;
        stageFrame.dataset.exportCompact = String(config.width < 1000);
        stageFrame.style.setProperty("--export-footer-gap", `${Math.round(12 * layout.unit)}px`);
        stageFrame.style.setProperty("--export-key-gap", `${Math.max(1, Math.round(5 * layout.unit))}px`);
        stageFrame.style.setProperty("--export-key-title", `${Math.round(26 * layout.unit)}px`);
        stageFrame.style.setProperty("--export-key-label", `${Math.round(22 * layout.unit)}px`);
        stageFrame.style.setProperty("--export-key-bar", `${Math.round(20 * layout.unit)}px`);
      }
      const mapElement = document.getElementById("exportMap");
      if (mapElement) mapElement.style.setProperty("height", `${layout.map.height}px`, "important");
      const footer = document.getElementById("exportFooter");
      if (footer) footer.style.height = `${layout.footerHeight}px`;
      [["exportTimestampLabel", layout.timestamp], ["exportLegendDock", layout.legend], ["exportLogoStrip", layout.branding]].forEach(([id, box]) => {
        const element = document.getElementById(id);
        if (!element) return;
        for (const [key, value] of Object.entries({ left: box.x, top: box.y - layout.map.height, width: box.width, height: box.height })) {
          element.style.setProperty(key, `${value}px`, "important");
        }
      });
      const attribution = document.getElementById("exportMapAttribution");
      if (attribution) {
        attribution.style.padding = `0 ${layout.attribution.x}px`;
        attribution.style.fontSize = `${layout.attribution.size}px`;
        attribution.style.lineHeight = `${Math.round(16 * layout.unit)}px`;
      }
      if (exportMap) exportMap.invalidateSize(false);
      return config;
    }


    function syncDownloadArchivePickerBounds() {
      const bounds = getDownloadArchiveBounds();
      const startPicker = document.getElementById("downloadStartDatePicker");
      const endPicker = document.getElementById("downloadEndDatePicker");
      if (bounds?.firstDate && bounds?.lastDate) {
        const minValue = formatNyLocalIso(bounds.firstDate).slice(0, 10);
        const maxValue = formatNyLocalIso(bounds.lastDate).slice(0, 10);
        [startPicker, endPicker].forEach(picker => {
          if (!picker) return;
          picker.min = minValue;
          picker.max = maxValue;
        });
      } else {
        [startPicker, endPicker].forEach(picker => {
          picker?.removeAttribute("min");
          picker?.removeAttribute("max");
        });
      }
    }

function syncDownloadRangeInputs(force = false) {
      const wrap = document.getElementById("downloadRangeFields");
      const startEl = document.getElementById("downloadStartInput");
      const endEl = document.getElementById("downloadEndInput");
      if (!startEl || !endEl) return;

      if (wrap) wrap.hidden = false;
      if (force) {
        delete startEl.dataset.userEdited;
        delete endEl.dataset.userEdited;
      }
      syncDownloadArchivePickerBounds();

      const seededSelection = seedDownloadRangeToCurrentSelection(force);
      if (!seededSelection && (!startEl.value || !endEl.value)) {
        const currentDate = getEntryESTDate(getDownloadCurrentEntry());
        if (currentDate) {
          if (!startEl.value && (force || startEl.dataset.invalidDate !== "1")) setRangeInputDate("downloadStartInput", currentDate);
          if (!endEl.value && (force || endEl.dataset.invalidDate !== "1")) setRangeInputDate("downloadEndInput", currentDate);
        }
      }

      syncExportDateTimeEditorFromCanonical("start", { preserveActiveEdit: !force });
      syncExportDateTimeEditorFromCanonical("end", { preserveActiveEdit: !force });
      renderExportTimePicker();
    }

function getDownloadRangeRequest() {
      if (!commitAllExportDateTimeEditors(false)) return null;
      const startDate = getRangeInputDate("downloadStartInput");
      const endDate = getRangeInputDate("downloadEndInput");
      if (!startDate || !endDate) return null;

      const startMs = startDate.getTime();
      const endMs = endDate.getTime();
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;

      return {
        startDate,
        endDate,
        startMs,
        endMs,
        durationMs: endMs - startMs
      };
    }

function getDownloadArchiveBounds() {
      if (currentDataMode === "return-interval") {
        const modeledEntries = getReturnIntervalExportEntries()
          .filter(entry => entryTimeMs(entry) != null)
          .sort((a, b) => entryTimeMs(a) - entryTimeMs(b));
        const firstDate = modeledEntries.length ? getEntryESTDate(modeledEntries[0]) : null;
        const lastDate = modeledEntries.length ? getEntryESTDate(modeledEntries[modeledEntries.length - 1]) : null;
        return firstDate && lastDate ? { firstDate, lastDate } : null;
      }
      const observedBounds = getObservedArchiveDateBounds();
      // Until history initializes, forecast-only dates are not authoritative
      // archive limits. Preview/download await availability and revalidate.
      if (!observedBounds) return null;
      const forecastEntries = getForecastExportEntries();
      const forecastFirst = forecastEntries.length ? getEntryESTDate(forecastEntries[0]) : null;
      const forecastLast = forecastEntries.length ? getEntryESTDate(forecastEntries[forecastEntries.length - 1]) : null;
      let firstDate = observedBounds?.firstDate || forecastFirst || getEntryESTDate(getDownloadCurrentEntry());
      let lastDate = observedBounds?.lastDate || forecastLast || getEntryESTDate(getDownloadCurrentEntry());
      if (forecastFirst && (!firstDate || forecastFirst.getTime() < firstDate.getTime())) firstDate = forecastFirst;
      if (forecastLast && (!lastDate || forecastLast.getTime() > lastDate.getTime())) lastDate = forecastLast;
      return firstDate && lastDate ? { firstDate, lastDate } : null;
    }

    function validateDownloadRangeForExport() {
      const range = getDownloadRangeRequest();
      if (!range) {
        return {
          ok: false,
          reason: "invalid-range",
          message: "Please select a valid start date/time and end date/time."
        };
      }

      if (range.endMs < range.startMs) {
        return {
          ok: false,
          reason: "invalid-order",
          message: "The end date and time must be after the start date and time."
        };
      }

      if (range.durationMs > EXPORT_RANGE_MAX_MS) {
        return {
          ok: false,
          reason: "range-too-long",
          message: "Please select a time range of 84 hours or less (up to 4 days)."
        };
      }

      const bounds = getDownloadArchiveBounds();
      if (bounds) {
        const firstMs = bounds.firstDate.getTime();
        const lastMs = bounds.lastDate.getTime();
        if (range.startMs < firstMs || range.endMs > lastMs) {
          return {
            ok: false,
            reason: "outside-data",
            message: `Please choose a time within the available data range: ${formatFixedESTFromUtc(bounds.firstDate.toISOString())} through ${formatFixedESTFromUtc(bounds.lastDate.toISOString())}.`
          };
        }
      }

      return { ok: true, range };
    }

    function getDownloadFrameItems(scope = null) {
      const mode = scope || getDownloadScopeValue();
      const currentEntry = getDownloadCurrentEntry();

      if (mode === "current") {
        if (!currentEntry) return [];
        const item = getDownloadFrameItemFromEntry(currentEntry);
        return item ? [item] : [];
      }

      const range = getDownloadRangeRequest();
      if (!range) return [];

      const interval = getDownloadIntervalValue();
      const snapshot = range.startMs === range.endMs && getDownloadFormatValue() === "png";
      const entries = getDownloadSourceEntries(true, range.startDate, range.endDate, {
        includeNativeLive: interval === "daily" || snapshot,
        keepOverlappingForecast: interval === "15min"
      })
        .filter(entry => entryTimeMs(entry) != null)
        .sort((a, b) => entryTimeMs(a) - entryTimeMs(b));
      if (snapshot) {
        const exact = entries.find(entry => entryTimeMs(entry) === range.startMs) ||
          (entryTimeMs(currentEntry) === range.startMs ? currentEntry : null);
        const item = exact && getDownloadFrameItemFromEntry(exact);
        if (item) return [item];
      }
      if (!entries.length) return [];

      const items = buildExportRangeFrameItems(entries, range, interval);
      const frameLimit = getDownloadFrameLimit();
      if (items.length > frameLimit) {
        return items.slice(0, frameLimit);
      }
      return items;
    }

    function getDownloadRangeSummaryFrameCount(range) {
      if (!range || !Number.isFinite(range.startMs) || !Number.isFinite(range.endMs)) return 0;
      const startMs = Math.min(range.startMs, range.endMs);
      const endMs = Math.max(range.startMs, range.endMs);
      const interval = getDownloadIntervalConfig();
      if (interval.value === "daily") {
        if (currentDataMode === "return-interval") {
          const entries = getReturnIntervalExportEntries().filter(entry => {
            const time = entryTimeMs(entry);
            return Number.isFinite(time) && time >= startMs && time <= endMs;
          });
          return buildReturnIntervalDailyMaximumSeries(entries).length;
        }
        const keys = new Set();
        for (let cursor = startMs; cursor <= endMs; cursor += 6 * 60 * 60 * 1000) {
          const key = getExportDayKeyFromDate(new Date(cursor));
          if (key) keys.add(key);
        }
        const endKey = getExportDayKeyFromDate(new Date(endMs));
        if (endKey) keys.add(endKey);
        return Math.max(1, keys.size);
      }
      const stepMs = interval.minutes * 60 * 1000;
      if (interval.value === "hourly") {
        return Math.max(0, Math.floor(endMs / stepMs) - Math.ceil(startMs / stepMs) + 1);
      }
      return Math.max(1, Math.floor((endMs - startMs) / stepMs) + 1);
    }


function getExportDayKeyFromDate(date) {
      const parts = getNyParts(date);
      if (!parts) return "";
      return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
    }

