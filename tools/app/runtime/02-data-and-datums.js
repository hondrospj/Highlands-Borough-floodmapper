    function pad2(n) {
      return String(n).padStart(2, "0");
    }

    function toast(msg = "") {
      const el = document.getElementById("toast");
      const textEl = document.getElementById("toastMessage");
      if (!el) return;
      if (!msg) {
        el.classList.remove("show");
        if (textEl) textEl.textContent = "";
        return;
      }
      if (textEl) textEl.textContent = msg;
      else el.textContent = msg;
      el.classList.add("show");
    }

    let floodBannerDismissed = false;

    function clearTopBanner() {
      floodBannerDismissed = true;
      const banner = document.getElementById("topBanner");
      if (banner) banner.classList.remove("alert");
    }

    function setBanner(active, title = "", meta = "", count = 0) {
      const banner = document.getElementById("topBanner");
      if (!banner) return;
      if (TOWN_CONFIG?.alerts?.enabled === false) {
        banner.classList.remove("alert");
        banner.hidden = true;
        banner.setAttribute("aria-hidden", "true");
        return;
      }
      if (!active) floodBannerDismissed = false;
      banner.classList.toggle("alert", Boolean(active) && !floodBannerDismissed);
      document.getElementById("bannerTitle").textContent = title || "No active flood alerts";
      document.getElementById("bannerMeta").textContent = meta || "";
      document.getElementById("bannerCount").textContent = `${count} active`;
    }

    async function fetchJson(url, options = {}) {
      const { timeoutMs = 30000, ...requestOptions } = options;
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, {
          cache: "no-store",
          headers: { "Accept": "application/geo+json, application/json" },
          signal: controller.signal,
          ...requestOptions
        });
        if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
        return await response.json();
      } finally {
        window.clearTimeout(timer);
      }
    }

    function setOpacityText() {
      const percent = Math.round(overlayOpacity * 100);
      document.getElementById("opacityText").textContent = `${percent}%`;
      document.getElementById("opacitySlider").setAttribute("aria-valuetext", `${percent} percent`);
    }

    function getDatumLabel() {
      return currentDatum === "mllw" ? "MLLW" : "NAVD88";
    }

    function getDatumLongLabel() {
      return currentDatum === "mllw" ? formatDatumToggleLabel() : "NAVD88";
    }

    function normalizeStageValue(value) {
      if (value == null || typeof value === "boolean" ||
          (typeof value !== "number" && typeof value !== "string") ||
          (typeof value === "string" && !value.trim())) return null;
      const n = Number(value);
      if (!Number.isFinite(n)) return null;
      return n;
    }

    function convertStageForDisplay(value) {
      const n = normalizeStageValue(value);
      if (!Number.isFinite(n)) return null;
      return n + (DATUM_OFFSETS[currentDatum] || 0);
    }

    function formatStageForDisplay(value, digits = 2) {
      const converted = convertStageForDisplay(value);
      return Number.isFinite(converted) ? `${converted.toFixed(digits)} ft` : "--";
    }

    function updateDatumUI() {
      const pill = document.getElementById("datumPill");
      const navdBtn = document.getElementById("datumNavd88Btn");
      const mllwBtn = document.getElementById("datumMllwBtn");
      const stageSub = document.getElementById("stageSubText");
      if (pill) pill.textContent = getDatumLabel();
      if (navdBtn) {
        const isActive = currentDatum === "navd88";
        navdBtn.classList.toggle("active", isActive);
        navdBtn.setAttribute("aria-pressed", String(isActive));
      }
      if (mllwBtn) {
        const isActive = currentDatum === "mllw";
        mllwBtn.classList.toggle("active", isActive);
        mllwBtn.setAttribute("aria-pressed", String(isActive));
      }
      if (stageSub) stageSub.textContent = getDatumLongLabel();
    }

    function getTimelineIntervalMinutes() {
      return currentTimelineIntervalMinutes === 15 || currentTimelineIntervalMinutes === 1440
        ? currentTimelineIntervalMinutes
        : 60;
    }

    function getTimelineIntervalLabel(minutes = getTimelineIntervalMinutes()) {
      if (minutes === 15) return "15 min";
      if (minutes === 1440) return "daily maximum";
      return "1 hour";
    }

    function updateTimelineIntervalUI() {
      const minutes = getTimelineIntervalMinutes();
      currentObservedResolution = minutes === 15 ? "15min" : (minutes === 1440 ? "daily" : "1hour");

      const hourBtn = document.getElementById("intervalHourBtn");
      const quarterBtn = document.getElementById("intervalQuarterBtn");
      const dailyBtn = document.getElementById("intervalDailyBtn");
      if (hourBtn) {
        const active = minutes === 60;
        hourBtn.classList.toggle("active", active);
        hourBtn.setAttribute("aria-pressed", String(active));
      }
      if (quarterBtn) {
        const active = minutes === 15;
        quarterBtn.classList.toggle("active", active);
        quarterBtn.setAttribute("aria-pressed", String(active));
      }
      if (dailyBtn) {
        const active = minutes === 1440;
        dailyBtn.classList.toggle("active", active);
        dailyBtn.setAttribute("aria-pressed", String(active));
      }

      const dock = document.getElementById("timelineDock");
      if (dock) dock.dataset.timelineInterval = String(minutes);
    }

    function updateObservedResolutionUI() {
      updateTimelineIntervalUI();
    }

    function getForecastScenarioConfig(scenario = currentForecastScenario) {
      return FORECAST_SCENARIOS[scenario] || FORECAST_SCENARIOS.mean;
    }

    function getForecastScenarioLabel(scenario = currentForecastScenario) {
      return getForecastScenarioConfig(scenario).label;
    }

    function getForecastScenarioPercentileLabel(scenario = currentForecastScenario) {
      return getForecastScenarioConfig(scenario).percentile;
    }

    function getForecastScenarioHours(data = forecastData, scenario = currentForecastScenario) {
      if (!data) return [];
      const record = data.scenarioForecasts?.[scenario] || data.forecasts?.[scenario];
      if (Array.isArray(record?.hours)) return record.hours;
      return scenario === "mean" && Array.isArray(data.hours) ? data.hours : [];
    }

    function getActiveForecastHours() {
      return getForecastScenarioHours(forecastData, currentForecastScenario);
    }

    function updateForecastScenarioButtons() {
      for (const [scenario, cfg] of Object.entries(FORECAST_SCENARIOS)) {
        const btn = document.getElementById(cfg.buttonId);
        if (!btn) continue;
        const isActive = scenario === currentForecastScenario;
        btn.classList.toggle("active", isActive);
        btn.setAttribute("aria-pressed", String(isActive));
      }
      const pill = document.getElementById("forecastScenarioPill");
      if (pill) pill.textContent = getForecastScenarioLabel();
      if (currentDataMode === "forecast") {
        const dataPill = document.getElementById("dataModePill");
        if (dataPill) dataPill.textContent = getForecastScenarioLabel();
      }
    }

    async function switchForecastScenario(scenario) {
      if (!FORECAST_SCENARIOS[scenario]) return;
      if (scenario === currentForecastScenario && currentDataMode === "forecast"
          && (currentSeriesHours.length || loadForecast.pendingSelectionGeneration === selectionGeneration)
          && loadTopTideEvent.pendingSelectionGeneration !== selectionGeneration) return;
      stopPlayback();
      const preferredEntry = currentDataMode === "forecast" ? currentSeriesHours[currentHourIndex] : null;
      const floodSelectionToken = cancelPendingFloodFrame();
      toast("");
      currentForecastScenario = scenario;
      currentDataMode = "forecast";
      updateForecastScenarioButtons();
      updateDataModeButtons();
      cancelPendingFloodFrame(false);
      await loadForecast(preferredEntry, { preserveForecastDay: true });
      if (floodSelectionToken !== lastRenderToken) return false;
      renderTopTides();
      await renderHour(currentHourIndex);
    }

    function getReturnIntervalRecord(years = currentReturnIntervalYears) {
      const requested = Number(years);
      return (returnIntervalData?.intervals || []).find(item => Number(item?.years) === requested) || null;
    }

    function getReturnIntervalLabel(years = currentReturnIntervalYears) {
      const value = Number(years);
      return value === 1 ? "Every Year" : `Every ${value.toLocaleString("en-US")} Years`;
    }

    function getReturnIntervalStormLabel(years = currentReturnIntervalYears) {
      const value = Number(years);
      return `${value.toLocaleString("en-US")}-Year Storm`;
    }

    function updateReturnIntervalButtons() {
      RETURN_INTERVAL_OPTIONS.forEach(years => {
        const btn = document.querySelector(`[data-return-years="${years}"]`);
        if (!btn) return;
        const active = years === currentReturnIntervalYears;
        btn.classList.toggle("active", active);
        btn.setAttribute("aria-pressed", String(active));
      });
      const pill = document.getElementById("returnIntervalPill");
      if (pill) pill.textContent = getReturnIntervalLabel();
      if (currentDataMode === "return-interval") {
        const dataPill = document.getElementById("dataModePill");
        if (dataPill) dataPill.textContent = getReturnIntervalLabel();
      }
    }

    function buildReturnIntervalDailyMaximumSeries(entries) {
      const source = Array.isArray(entries) ? entries : [];
      const halfWindow = Number(returnIntervalData?.windowHours || 84) / 2;
      const bestByStormDay = new Map();
      source.forEach(entry => {
        const offset = Number(entry?.offsetHours);
        const stage = getStageValue(entry);
        if (!Number.isFinite(offset) || !Number.isFinite(stage)) return;
        const dayIndex = Math.max(0, Math.floor((offset + halfWindow) / 24));
        const existing = bestByStormDay.get(dayIndex);
        if (!existing || stage > getStageValue(existing)) bestByStormDay.set(dayIndex, entry);
      });
      return Array.from(bestByStormDay.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([dayIndex, entry]) => ({
          ...entry,
          syntheticStormDay: dayIndex + 1,
          observationInterval: "daily",
          timelineIntervalMinutes: 1440,
          isDailyMaximum: true,
          dailyMaximumKind: "return-interval"
        }));
    }

    function buildReturnIntervalDisplaySeries(entries = currentRawSeriesHours) {
      const source = annotateHydraulicSeries(Array.isArray(entries) ? entries : []);
      if (getTimelineIntervalMinutes() === 1440) return buildReturnIntervalDailyMaximumSeries(source);
      if (getTimelineIntervalMinutes() === 15) {
        return source.map(entry => ({
          ...entry,
          timelineIntervalMinutes: 15,
          observationInterval: "15min"
        }));
      }
      return source
        .filter(entry => Math.abs(Number(entry?.offsetHours) - Math.round(Number(entry?.offsetHours))) < 1e-8)
        .map(entry => ({
          ...entry,
          timelineIntervalMinutes: 60,
          observationInterval: "1hour"
        }));
    }

    async function loadReturnInterval(preferredEntry = null, options = {}) {
      const generation = options.generation ?? ++selectionGeneration;
      if (generation !== selectionGeneration) return false;
      const request = { generation };
      loadReturnInterval.pendingSelection = request;
      try {
        // A modeled selection owns its data request. Overlay and cadence
        // changes may update that selection while its first response loads.
        currentDataMode = "return-interval";
        currentViewType = "return-interval";
        currentTopTideIndex = null;
        currentRawSeriesHours = [];
        currentSeriesHours = [];
        currentHourIndex = 0;
        currentSelectedLabel = `${getReturnIntervalLabel()} Flood`;
        currentSelectedSubLabel = "";
        currentRangeLabel = "";
        syncSliderBounds();
        document.getElementById("hourSlider").value = "0";
        renderSelectionMeta(null, null, null);
        document.getElementById("stageSubText").textContent = "";
        renderTimelineMeta();
        renderTimelineDays();
        setFloodFrameStatus(currentFloodLayer
          ? ""
          : "", "info");

        if (!returnIntervalData || options.forceRefresh) {
          const payload = await fetchJson(withFreshJsonUrl(RETURN_INTERVALS_URL));
          if (generation !== selectionGeneration) return false;
          returnIntervalData = payload;
        }
        if (generation !== selectionGeneration) return false;
        const record = getReturnIntervalRecord();
        if (!record || !Array.isArray(record.series15min) || !record.series15min.length) {
          throw new Error(`${getReturnIntervalLabel()} synthetic storm is unavailable.`);
        }
        const targetNavd88Ft = Number(record.targetNavd88Ft ?? record.weightedNavd88Ft ?? record.naccsNavd88Ft);
        if (!Number.isFinite(targetNavd88Ft)) {
          throw new Error(`${getReturnIntervalLabel()} target water level is unavailable.`);
        }

        clearExportAvailabilityCache();
        currentRawSeriesHours = annotateHydraulicSeries(record.series15min);
        currentSeriesHours = buildReturnIntervalDisplaySeries(currentRawSeriesHours);
        currentSelectedSubLabel = `${targetNavd88Ft.toFixed(2)} ft NAVD88`;
        currentRangeLabel = `${returnIntervalData.windowHours || 84}-hour sample storm`;
        syncSliderBounds();
        currentHourIndex = preferredEntry
          ? findClosestEntryIndex(currentSeriesHours, preferredEntry)
          : getPeakHourIndex(currentSeriesHours);
        document.getElementById("hourSlider").value = String(currentHourIndex);
        updateReturnIntervalButtons();
        return true;
      } catch (error) {
        if (generation !== selectionGeneration || currentDataMode !== "return-interval") return false;
        returnIntervalData = null;
        currentRawSeriesHours = [];
        currentSeriesHours = [];
        currentHourIndex = 0;
        currentSelectedSubLabel = "";
        currentRangeLabel = "";
        syncSliderBounds();
        document.getElementById("hourSlider").value = "0";
        clearFloodLayer();
        renderSelectionMeta(null, null, null);
        document.getElementById("stageSubText").textContent = "Modeled flood data could not load";
        renderTimelineMeta();
        renderTimelineDays();
        reportFloodFrameFailure();
        const message = "Modeled flood data could not load. Select a modeled flood to retry.";
        setFloodFrameStatus(message, "error");
        toast(message);
        return false;
      } finally {
        if (loadReturnInterval.pendingSelection === request) loadReturnInterval.pendingSelection = null;
      }
    }

    async function switchReturnInterval(years) {
      const requested = Number(years);
      if (!RETURN_INTERVAL_OPTIONS.includes(requested)) return;
      if (requested === currentReturnIntervalYears && currentDataMode === "return-interval" &&
          (currentSeriesHours.length || loadReturnInterval.pendingSelection?.generation === selectionGeneration) &&
          loadTopTideEvent.pendingSelectionGeneration !== selectionGeneration) return;
      stopPlayback();
      const generation = ++selectionGeneration;
      cancelPendingFloodFrame();
      toast("");
      currentReturnIntervalYears = requested;
      currentDataMode = "return-interval";
      currentViewType = "return-interval";
      updateDataModeButtons();
      cancelPendingFloodFrame(false);
      const loaded = await loadReturnInterval(null, { generation });
      if (generation !== selectionGeneration || loaded === false) return false;
      await renderHour(currentHourIndex);
    }

