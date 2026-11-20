    function getExportMonthKey(date) {
      const parts = getNyParts(date);
      if (!parts) return "";
      return `${parts.year}-${String(parts.month).padStart(2, "0")}`;
    }

function clearExportAvailabilityCache() {
      exportAvailabilityDayMapCache = null;
      exportAvailabilityMonthMapCache = null;
      exportAvailabilityBoundsCache = null;
      observedExportDayIndexCache = null;
    }

    function getObservedExportDayIndex() {
      if (observedExportDayIndexCache) return observedExportDayIndexCache;
      const index = new Map();
      getObservedDays().forEach(day => {
        const dayKey = String(day?.date || "").slice(0, 10);
        if (!dayKey) return;
        const existing = index.get(dayKey);
        const existingCount = Array.isArray(existing?.hours) ? existing.hours.length : 0;
        const newCount = Array.isArray(day?.hours) ? day.hours.length : 0;
        if (!existing || newCount >= existingCount) index.set(dayKey, day);
      });
      observedExportDayIndexCache = index;
      return index;
    }

    function scheduleExportTimePickerRender(force = false) {
      if (!isDownloadModalOpen() && !force) return;
      if (exportTimePickerRenderRaf != null) cancelAnimationFrame(exportTimePickerRenderRaf);
      exportTimePickerRenderRaf = requestAnimationFrame(() => {
        exportTimePickerRenderRaf = null;
        renderExportTimePicker();
      });
    }

    function getForecastExportEntriesLimited() {
      const entries = getForecastExportEntries()
        .filter(entry => entryTimeMs(entry) != null)
        .sort((a, b) => entryTimeMs(a) - entryTimeMs(b));
      if (!entries.length) return [];
      const firstMs = entryTimeMs(entries[0]);
      const maxMs = firstMs + EXPORT_RANGE_MAX_MS;
      return entries.filter(entry => {
        const t = entryTimeMs(entry);
        return t != null && t <= maxMs;
      });
    }

    function getExportAvailabilityDayMap() {
      if (exportAvailabilityDayMapCache) return exportAvailabilityDayMapCache;
      const map = new Map();
      const entryDates = new Map();

      function ensureMeta(dayKey) {
        if (!dayKey) return null;
        if (!map.has(dayKey)) {
          let firstDate;
          let lastDate;
          map.set(dayKey, {
            dayKey,
            observed: false,
            forecast: false,
            count: 0,
            // The archive has tens of thousands of days. Resolve exact New
            // York boundaries only when a visible day or aggregate needs them.
            get firstDate() {
              if (firstDate === undefined) {
                firstDate = parseStoredLocalNyToDate(`${dayKey}T00:00`);
                const entry = entryDates.get(dayKey)?.firstDate;
                if (entry && (!firstDate || entry.getTime() < firstDate.getTime())) firstDate = entry;
              }
              return firstDate;
            },
            set firstDate(value) { firstDate = value; },
            get lastDate() {
              if (lastDate === undefined) {
                lastDate = parseStoredLocalNyToDate(`${dayKey}T23:00`);
                const entry = entryDates.get(dayKey)?.lastDate;
                if (entry && (!lastDate || entry.getTime() > lastDate.getTime())) lastDate = entry;
              }
              return lastDate;
            },
            set lastDate(value) { lastDate = value; }
          });
        }
        return map.get(dayKey);
      }

      if (currentDataMode !== "return-interval") {
        getObservedExportDayIndex().forEach((day, dayKey) => {
          const meta = ensureMeta(dayKey);
          if (!meta) return false;
          meta.observed = true;
          const hours = Array.isArray(day?.hours) ? day.hours : [];
          meta.count += Math.max(1, hours.length || 24);
        });
      }

      const activeEntries = currentDataMode === "return-interval"
        ? getReturnIntervalExportEntries()
        : getForecastExportEntriesLimited();
      activeEntries.forEach(entry => {
        const d = getEntryESTDate(entry);
        const dayKey = getExportDayKeyFromDate(d);
        const meta = ensureMeta(dayKey);
        if (!meta) return;
        meta.forecast = true;
        meta.modeled = currentDataMode === "return-interval";
        meta.count += 1;
        if (d) {
          const dates = entryDates.get(dayKey);
          if (!dates) entryDates.set(dayKey, { firstDate: d, lastDate: d });
          else {
            if (d.getTime() < dates.firstDate.getTime()) dates.firstDate = d;
            if (d.getTime() > dates.lastDate.getTime()) dates.lastDate = d;
          }
        }
      });

      exportAvailabilityDayMapCache = map;
      return map;
    }

    function getExportAvailabilityBoundsForDays(days) {
      // ISO day keys preserve calendar order without parsing every boundary.
      const ordered = Array.from(days).sort((a, b) => a.dayKey < b.dayKey ? -1 : a.dayKey > b.dayKey ? 1 : 0);
      let firstDate = null;
      let lastDate = null;
      for (const meta of ordered) {
        if (meta.firstDate) { firstDate = meta.firstDate; break; }
      }
      for (let i = ordered.length - 1; i >= 0; i--) {
        if (ordered[i].lastDate) { lastDate = ordered[i].lastDate; break; }
      }
      return firstDate && lastDate ? { firstDate, lastDate } : null;
    }

    function getExportAvailabilityBounds() {
      if (exportAvailabilityBoundsCache) return exportAvailabilityBoundsCache;
      const dayMap = getExportAvailabilityDayMap();
      if (!dayMap.size) return null;
      exportAvailabilityBoundsCache = getExportAvailabilityBoundsForDays(dayMap.values());
      return exportAvailabilityBoundsCache;
    }

    function getExportAvailabilityMonthMap() {
      if (exportAvailabilityMonthMapCache) return exportAvailabilityMonthMapCache;
      const months = new Map();
      const monthDays = new Map();
      getExportAvailabilityDayMap().forEach(meta => {
        const monthKey = String(meta.dayKey || "").slice(0, 7);
        if (!monthKey) return;
        if (!months.has(monthKey)) {
          const days = [];
          monthDays.set(monthKey, days);
          let bounds;
          const getBounds = () => {
            if (bounds === undefined) bounds = getExportAvailabilityBoundsForDays(days);
            return bounds;
          };
          months.set(monthKey, {
            monthKey,
            observed: false,
            forecast: false,
            get firstDate() { return getBounds()?.firstDate || null; },
            get lastDate() { return getBounds()?.lastDate || null; }
          });
        }
        const current = months.get(monthKey);
        current.observed = current.observed || !!meta.observed;
        current.forecast = current.forecast || !!meta.forecast;
        monthDays.get(monthKey).push(meta);
      });
      exportAvailabilityMonthMapCache = months;
      return months;
    }

    function formatExportCompactDate(date) {
      if (!date) return "--";
      const parts = getNyParts(date);
      if (!parts) return "--";
      const mm = String(Number(parts.month)).padStart(2, "0");
      const dd = String(Number(parts.day)).padStart(2, "0");
      const yy = String(Number(parts.year) % 100).padStart(2, "0");
      return `${mm}/${dd}/${yy}`;
    }

    function showExportDateOrderPopup(message, title = "Check export range", opener = null) {
      const finalMessage = message || "Please check the selected export range.";
      const modal = document.getElementById("exportOrderModal");
      const heading = document.getElementById("exportOrderModalTitle");
      const body = document.getElementById("exportOrderModalBody");
      if (heading) heading.textContent = title;
      if (body) body.textContent = finalMessage;
      if (modal) {
        modal.hidden = false;
        modal.classList.add("open");
        if (opener) document.dispatchEvent(new CustomEvent("nww:modalchange", { detail: { opener } }));
        setTimeout(() => document.getElementById("exportOrderModalOkBtn")?.focus(), 0);
      } else {
        window.alert(finalMessage);
      }
      setDownloadStatus(finalMessage, true);
    }

    function closeExportDateOrderPopup() {
      const modal = document.getElementById("exportOrderModal");
      if (!modal) return;
      modal.classList.remove("open");
      modal.hidden = true;
    }

    function renderExportTimePicker() {
      const wrap = document.getElementById("exportTimePicker");
      const dataRangeEl = document.getElementById("exportDataRangeText");
      if (!wrap) return;

      wrap.hidden = false;
      const bounds = getDownloadArchiveBounds();
      if (dataRangeEl) {
        if (currentDataMode === "return-interval") {
          dataRangeEl.innerHTML = `<span>Modeled storm</span><strong>${Number(returnIntervalData?.windowHours || 24)}-hour synthetic event</strong>`;
        } else if (bounds?.firstDate && bounds?.lastDate) {
          dataRangeEl.innerHTML = `<span>Available data</span><strong>${formatExportCompactDate(bounds.firstDate)} – ${formatExportCompactDate(bounds.lastDate)}</strong>`;
        } else {
          dataRangeEl.innerHTML = `<span>Available data</span><strong>—</strong>`;
        }
      }
    }

function updateDownloadSummary() {
      const summary = document.getElementById("downloadSummary");
      if (!summary || !isDownloadModalOpen()) return;

      syncDownloadRangeInputs(false);
      const scope = getDownloadScopeValue();
      const format = getDownloadFormatValue();
      const formatLabel = format.toUpperCase();
      const aspectConfig = getExportAspectConfig();
      const aspectLabel = aspectConfig.label;
      const resolutionLabel = format === "png" ? `, ${aspectConfig.resolutionLabel}` : "";
      const extentLabel = getDownloadExtentValue() === "town" ? `Fill ${TOWN_CONFIG.site.name}` : "Current View";
      const speed = EXPORT_GIF_SPEEDS[getDownloadSpeedValue()]?.label || "Normal";
      const interval = getDownloadIntervalConfig();
      const frameLimit = getDownloadFrameLimit();

      if (format === "png") {
        if (scope === "range") {
          const range = getDownloadRangeRequest();
          const count = range ? Math.min(getDownloadRangeSummaryFrameCount(range), frameLimit) : 0;
          summary.textContent = count
            ? `PNG (${aspectLabel}${resolutionLabel}, ${interval.label}, ${extentLabel}) export of ${count} frame${count === 1 ? "" : "s"}.`
            : "No frames are available for export.";
          return;
        }
        const item = getDownloadFrameItemFromEntry(getDownloadCurrentEntry());
        summary.textContent = item ? `PNG (${aspectLabel}${resolutionLabel}, ${extentLabel}) export at ${formatHourEntryTime(item.entry)}.` : "No frames are available for export.";
        return;
      }

      if (scope === "range") {
        const range = getDownloadRangeRequest();
        if (!range) {
          summary.textContent = "No frames are available for export.";
          return;
        }
        if (range.durationMs > EXPORT_RANGE_MAX_MS) {
          summary.textContent = `${formatLabel} (${aspectLabel}, ${speed}, ${extentLabel}) export range is longer than ${EXPORT_RANGE_MAX_HOURS} hours and is not allowed.`;
          return;
        }
        const frameCount = Math.min(getDownloadRangeSummaryFrameCount(range), frameLimit);
        summary.textContent = `${formatLabel} (${aspectLabel}, ${interval.label}, ${speed}, ${extentLabel}) export of ${frameCount} frame${frameCount === 1 ? "" : "s"} from ${formatFixedESTFromUtc(range.startDate.toISOString())} to ${formatFixedESTFromUtc(range.endDate.toISOString())}.`;
        return;
      }

      const item = getDownloadFrameItemFromEntry(getDownloadCurrentEntry());
      if (!item) {
        summary.textContent = "No frames are available for export.";
        return;
      }
      summary.textContent = `${formatLabel} (${aspectLabel}, ${speed}, ${extentLabel}) export at ${formatHourEntryTime(item.entry)}.`;
    }



function updateExportSegmentedUI() {
      const scopeValue = getDownloadScopeValue();
      const formatValue = getDownloadFormatValue();
      const intervalValue = getDownloadIntervalValue();
      const aspectValue = getDownloadAspectValue();
      const extentValue = getDownloadExtentValue();
      const speedValue = getDownloadSpeedValue();

      document.querySelectorAll("#downloadScopeControl button[data-scope]").forEach(btn => {
        const active = btn.dataset.scope === scopeValue;
        btn.classList.toggle("active", active);
        btn.setAttribute("aria-pressed", String(active));
      });
      document.querySelectorAll("#downloadFormatControl button[data-format]").forEach(btn => {
        const active = btn.dataset.format === formatValue;
        btn.classList.toggle("active", active);
        btn.setAttribute("aria-pressed", String(active));
      });
      document.querySelectorAll("#downloadIntervalControl button[data-export-interval]").forEach(btn => {
        const active = btn.dataset.exportInterval === intervalValue;
        btn.classList.toggle("active", active);
        btn.setAttribute("aria-pressed", String(active));
      });
      document.querySelectorAll("#downloadAspectControl button[data-aspect]").forEach(btn => {
        const active = btn.dataset.aspect === aspectValue;
        btn.classList.toggle("active", active);
        btn.setAttribute("aria-pressed", String(active));
      });
      document.querySelectorAll("#downloadExtentControl button[data-extent]").forEach(btn => {
        const active = btn.dataset.extent === extentValue;
        btn.classList.toggle("active", active);
        btn.setAttribute("aria-pressed", String(active));
      });
      document.querySelectorAll("#downloadSpeedControl button[data-speed]").forEach(btn => {
        const active = btn.dataset.speed === speedValue;
        btn.classList.toggle("active", active);
        btn.setAttribute("aria-pressed", String(active));
      });
      const speedField = document.getElementById("gifSpeedField");
      if (speedField) speedField.hidden = formatValue !== "gif";
      const btnLabel = document.getElementById("downloadBtnLabel");
      if (btnLabel && !exportInProgress) {
        btnLabel.textContent = formatValue === "png" ? "Download PNG Frames" : "Download GIF";
      }
    }

    function resetExportPanelToDefaults() {
      if (exportInProgress) return;

      const setHidden = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.value = value;
      };

      setHidden("downloadFormatSelect", "gif");
      setHidden("downloadIntervalSelect", "hourly");
      setHidden("downloadAspectSelect", "viewport");
      setHidden("downloadSpeedSelect", "normal");
      setHidden("downloadScopeSelect", "range");
      setHidden("downloadExtentSelect", "current");

      closeExportDateOrderPopup();
      setDownloadStatus("", false);
      updateExportSegmentedUI();
      syncDownloadRangeInputs(true);
      updateDownloadSummary();
      setTimeout(() => document.getElementById("downloadResetBtn")?.blur(), 0);
    }

    function setDownloadBusy(isBusy, message = "") {
      if (isBusy) {
        if (!exportInProgress) {
          exportViewportBounds = getActiveMapBounds();
          exportCancelRequested = false;
        }
      } else {
        exportViewportBounds = null;
        exportCancelRequested = false;
        activeGifExport = null;
      }
      exportInProgress = isBusy;
      document.getElementById("exportProgressOverlay")?.setAttribute("aria-busy", String(Boolean(isBusy)));
      const btn = document.getElementById("downloadBtn");
      const btnLabel = document.getElementById("downloadBtnLabel");
      const progressCloseBtn = document.getElementById("exportProgressCloseBtn");
      const scope = document.getElementById("downloadScopeSelect");
      const start = document.getElementById("downloadStartInput");
      const format = document.getElementById("downloadFormatSelect");
      const interval = document.getElementById("downloadIntervalSelect");
      const aspect = document.getElementById("downloadAspectSelect");
      const speed = document.getElementById("downloadSpeedSelect");
      const extent = document.getElementById("downloadExtentSelect");
      const end = document.getElementById("downloadEndInput");
      const exportEditorControls = [
        "downloadStartDateText",
        "downloadStartDatePicker",
        "downloadStartCalendarBtn",
        "downloadStartTimeSelect",
        "downloadEndDateText",
        "downloadEndDatePicker",
        "downloadEndCalendarBtn",
        "downloadEndTimeSelect"
      ].map(id => document.getElementById(id)).filter(Boolean);
      if (btn) {
        btn.disabled = isBusy;
        btn.classList.toggle("is-busy", isBusy);
      }
      if (btnLabel) {
        btnLabel.textContent = isBusy
          ? "Creating export..."
          : getDownloadFormatValue() === "png" ? "Download PNG Frames" : "Download GIF";
      }
      if (progressCloseBtn) {
        progressCloseBtn.disabled = false;
        progressCloseBtn.classList.toggle("is-cancel-action", isBusy);
        progressCloseBtn.classList.toggle("centered-close-control", !isBusy);
        progressCloseBtn.textContent = isBusy ? "Cancel" : "×";
        progressCloseBtn.setAttribute("aria-label", isBusy ? "Cancel export" : "Hide export progress");
        progressCloseBtn.title = isBusy ? "Cancel export" : "Hide export progress";
      }
      if (scope) scope.disabled = isBusy;
      if (format) format.disabled = isBusy;
      if (interval) interval.disabled = isBusy;
      if (aspect) aspect.disabled = isBusy;
      if (speed) speed.disabled = isBusy;
      document.querySelectorAll("#downloadFormatControl button, #downloadIntervalControl button, #downloadAspectControl button, #downloadSpeedControl button").forEach(el => { el.disabled = isBusy; });
      const picker = document.getElementById("exportTimePicker");
      if (picker) picker.classList.toggle("is-busy", isBusy);
      if (start) start.disabled = isBusy;
      if (end) end.disabled = isBusy;
      const modeledDateLocked = currentDataMode === "return-interval";
      const modeledDateControlIds = new Set([
        "downloadStartDateText",
        "downloadStartDatePicker",
        "downloadStartCalendarBtn",
        "downloadEndDateText",
        "downloadEndDatePicker",
        "downloadEndCalendarBtn"
      ]);
      exportEditorControls.forEach(control => {
        control.disabled = isBusy || (modeledDateLocked && modeledDateControlIds.has(control.id));
      });
      if (isBusy) {
        setExportProgressVisible(true);
        setExportProgress(message || "Preparing export...", 0, false);
      }
      setDownloadStatus(message, false);
    }

