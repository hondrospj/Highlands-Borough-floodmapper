    function physicsCycleIdFromUtc(value) {
      // The producer names hourly cycles YYYYMMDDTHH00Z, without seconds.
      // Reject missing zones and normalized invalid dates before selecting a
      // cycle-specific pointer; Date.parse alone accepts dates such as Feb 30.
      const parts = typeof value === "string" && value.match(
        /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-](\d{2}):(\d{2}))$/
      );
      if (!parts || Number(parts[2]) > 23 || Number(parts[3]) > 59 ||
          Number(parts[4] || 0) > 59 || (parts[5] && !/^0+$/.test(parts[5])) ||
          Number(parts[7] || 0) > 23 || Number(parts[8] || 0) > 59) return "";
      const midnight = Date.parse(`${parts[1]}T00:00:00Z`);
      const timestamp = Date.parse(value);
      if (!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== parts[1] ||
          !Number.isFinite(timestamp)) return "";
      const cycle = new Date(timestamp);
      if (cycle.getUTCMinutes() || cycle.getUTCSeconds() || cycle.getUTCMilliseconds()) return "";
      const iso = cycle.toISOString();
      return /^\d{4}-/.test(iso) ? iso.slice(0, 16).replace(/[-:]/g, "") + "Z" : "";
    }

    function physicsPointerUrl() {
      const cycleId = physicsCycleIdFromUtc(forecastData?.petssCycleUtc);
      const cyclePointerPath = PHYSICS_FORECAST_CYCLE_POINTER_TEMPLATE && cycleId
        ? PHYSICS_FORECAST_CYCLE_POINTER_TEMPLATE.replaceAll("{cycleId}", cycleId)
        : "";
      const pointerPath = cyclePointerPath || PHYSICS_FORECAST_POINTER_URL;
      if (!pointerPath) return "";
      const url = new URL(pointerPath, window.location.href);
      url.searchParams.set("_cycle_check", String(Math.floor(Date.now() / 300000)));
      return url.href;
    }

    function resolvePhysicsFileRecord(record, manifestUrl) {
      if (!record?.path || !manifestUrl) return null;
      return { ...record, url: new URL(record.path, manifestUrl).href };
    }

    function hydratePhysicsManifest(manifest, manifestUrl) {
      const hydrate = record => ({
        ...record,
        visible: resolvePhysicsFileRecord(record.visible, manifestUrl),
        impact: resolvePhysicsFileRecord(record.impact, manifestUrl),
        query: resolvePhysicsFileRecord(record.query, manifestUrl)
      });
      return {
        ...manifest,
        frames: (Array.isArray(manifest?.frames) ? manifest.frames : []).map(hydrate),
        dailyMaximums: (Array.isArray(manifest?.dailyMaximums) ? manifest.dailyMaximums : []).map(hydrate)
      };
    }

    function getActivePhysicsManifest() {
      return physicsForecastManifests[currentForecastScenario] || null;
    }

    async function loadPhysicsForecast(force = false) {
      if (!PHYSICS_FORECAST_POINTER_URL && !PHYSICS_FORECAST_CYCLE_POINTER_TEMPLATE) return null;
      if (Object.keys(physicsForecastManifests).length && !force) {
        return getActivePhysicsManifest();
      }
      const generation = archiveGeneration;
      const pointerUrl = physicsPointerUrl();
      if (!pointerUrl) return null;
      const pointer = await fetchJson(pointerUrl);
      if (generation !== archiveGeneration) throw new Error("Physics request superseded by Reload");
      const manifestUrls = pointer?.manifestUrls && typeof pointer.manifestUrls === "object"
        ? pointer.manifestUrls
        : (pointer?.manifestUrl ? { [pointer.scenario || "mean"]: pointer.manifestUrl } : {});
      if (pointer?.status !== "complete" || !Object.keys(manifestUrls).length) {
        throw new Error("The physics forecast pointer is not complete.");
      }
      const hydrated = await Promise.all(Object.entries(manifestUrls).map(async ([scenario, rawUrl]) => {
        const manifestUrl = new URL(rawUrl, pointerUrl).href;
        const manifest = await fetchJson(manifestUrl);
        const recordsValid = records => Array.isArray(records) && records.length &&
          records.every(record => record?.visible?.path && record?.impact?.path && record?.query?.path);
        if (
          manifest?.status !== "complete" ||
          manifest?.schema !== "north-wildwood-physics-forecast-v2" ||
          manifest?.image?.crs !== "EPSG:3857" ||
          manifest?.image?.coordinateSystem !== "web-mercator" ||
          !Array.isArray(manifest?.boundsWgs84) ||
          !recordsValid(manifest?.frames) ||
          !recordsValid(manifest?.dailyMaximums)
        ) {
          throw new Error(`The ${scenario} physics forecast manifest is invalid.`);
        }
        if (pointer.cycleId && manifest.cycleId !== pointer.cycleId) {
          throw new Error("The physics pointer and manifest cycle do not match.");
        }
        if ((manifest.scenario || "mean") !== scenario) {
          throw new Error(`The ${scenario} physics manifest has the wrong scenario label.`);
        }
        return [scenario, hydratePhysicsManifest(manifest, manifestUrl)];
      }));
      if (generation !== archiveGeneration) throw new Error("Physics request superseded by Reload");
      physicsForecastManifests = Object.fromEntries(hydrated);
      physicsQueryImageCache = new Map();
      return getActivePhysicsManifest() || hydrated[0]?.[1] || null;
    }

    function physicsManifestMatchesForecastCycle(manifest = getActivePhysicsManifest()) {
      if (!manifest || !forecastData) return false;
      const physicsCycle = Date.parse(manifest?.petssSource?.cycleUtc || "");
      const dashboardCycle = Date.parse(forecastData?.petssCycleUtc || "");
      return Number.isFinite(physicsCycle) &&
        Number.isFinite(dashboardCycle) &&
        physicsCycle === dashboardCycle;
    }

    function physicsForecastApplies() {
      return Boolean(
        currentDataMode === "forecast" &&
        physicsManifestMatchesForecastCycle()
      );
    }

    function physicsFrameToForecastEntry(frame) {
      const stage = Number(frame?.boundaryStageNavd88Ft);
      return {
        timeUtc: frame.timeUtc,
        displayTimeUtc: frame.timeUtc,
        navd88StageFt: stage,
        stageFt: stage,
        value: stage,
        timelineIntervalMinutes: 15,
        observationInterval: "15min",
        physicsFrame: frame,
        physicsCycleId: getActivePhysicsManifest()?.cycleId || "",
        isPhysicsForecast: true
      };
    }

    function getPhysicsForecastDisplaySeries() {
      const manifest = getActivePhysicsManifest();
      if (!physicsForecastApplies() || !manifest) return null;
      const allFrames = annotateHydraulicSeries(manifest.frames.map(physicsFrameToForecastEntry));
      const interval = getTimelineIntervalMinutes();
      if (interval === 15) return allFrames;
      if (interval === 60) {
        return allFrames
          .filter(entry => entry.physicsFrame?.isHourlySourcePoint)
          .map(entry => ({ ...entry, timelineIntervalMinutes: 60, observationInterval: "1hour" }));
      }
      const entriesByLocalDate = new Map();
      allFrames.forEach(entry => {
        const parts = getNyParts(getEntryESTDate(entry));
        if (!parts) return;
        const key = `${parts.year}-${parts.month}-${parts.day}`;
        if (!entriesByLocalDate.has(key)) entriesByLocalDate.set(key, []);
        entriesByLocalDate.get(key).push(entry);
      });
      return manifest.dailyMaximums.map(daily => {
        const entries = entriesByLocalDate.get(daily.dateLocal) || [];
        const peak = entries.reduce((best, entry) => (
          !best || getStageValue(entry) > getStageValue(best) ? entry : best
        ), entries[0] || allFrames[0]);
        return {
          ...peak,
          observedDate: daily.dateLocal,
          observationInterval: "daily",
          timelineIntervalMinutes: 1440,
          isDailyMaximum: true,
          dailyMaximumKind: "forecast",
          physicsDailyMaximum: daily
        };
      });
    }

    function getPhysicsAssetForEntry(entry) {
      if (!physicsForecastApplies()) return null;
      return entry?.physicsDailyMaximum || entry?.physicsFrame || null;
    }

    function getPhysicsDisplayRecord(asset, mode = currentOverlayMode) {
      return mode === "dynamic" ? asset?.impact : asset?.visible;
    }

    let playTimer = null;
    let playbackInFlight = false;
    let playbackObservedDaysAdvanced = 0;
    let playbackPausedForConfirmation = false;
    let overlayOpacity = DEFAULT_OPACITY;
    let lastRenderToken = 0;
    let selectionGeneration = 0;
    let archiveGeneration = 0;
    let floodFrameState = "unavailable";
    let currentSelectionQualityNote = "";
    let nwsAlertRefreshTimer = null;
    let nwsAlertPromise = null;
    let lastSuccessfulNwsAlerts = null;
    let imageExistsCache = new Map();
    let overlayRecordCache = new Map();
    let preloadPromiseCache = new Map();
    let exportInProgress = false;
    let exportCancelRequested = false;
    let activeGifExport = null;
    let gifWorkerUrlPromise = null;
    let exportImageElementCache = new Map();
    let exportAvailabilityDayMapCache = null;
    let exportAvailabilityMonthMapCache = null;
    let exportAvailabilityBoundsCache = null;
    let observedExportDayIndexCache = null;
    let exportTimePickerRenderRaf = null;

