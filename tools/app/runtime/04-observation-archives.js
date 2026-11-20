    function buildObservedIndexFromCanonical(payload) {
      const rows = Array.isArray(payload?.days) ? payload.days : [];
      const days = rows.map(row => {
        const date = String(row?.[0] || "");
        const peak = normalizeStageValue(row?.[1]);
        const pipelineSource = String(row?.[2] || "");
        const peakNAVD88 = Number.isFinite(peak) ? peak / 100 : null;
        return {
          date,
          classification: Number.isFinite(peakNAVD88) ? classifyFloodStage(peakNAVD88) : "none",
          peakNAVD88,
          hours: [],
          pipelineSource,
          isCanonicalPipelineTruth: true,
          isLewesSurrogate: pipelineSource === "N" || (pipelineSource === "C" && surrogateEnabled() && date < primaryArchiveStartDate()),
          surrogateStationId: pipelineSource === "N" ? surrogateStationId() : null,
          surrogateStationName: pipelineSource === "N" ? surrogateStationName() : null
        };
      }).filter(day => /^\d{4}-\d{2}-\d{2}$/.test(day.date));
      return {
        archiveStartDate: payload?.archive?.startDate || days[0]?.date || null,
        archiveEndDate: payload?.archive?.endDate || days[days.length - 1]?.date || null,
        datum: payload?.datum || "NAVD88",
        gaugeName: primaryGaugeName(),
        sourceType: "usgs-first-bias-corrected-noaa-usgs-crest-override",
        lewesCutoffDate: primaryArchiveStartDate(),
        sourcePrecedence: payload?.provenance?.sourcePrecedence || TOWN_CONFIG?.observed?.sourcePrecedence || [],
        provenance: payload?.provenance || {},
        days
      };
    }

    async function ensureCanonicalDailyArchive() {
      if (!CANONICAL_DAILY_URL) return null;
      if (canonicalDailyData) return canonicalDailyData;
      const generation = archiveGeneration;
      const payload = await fetchJson(CANONICAL_DAILY_URL, { cache: "default" });
      if (generation !== archiveGeneration) throw new Error("Archive request superseded by Reload");
      canonicalDailyData = payload;
      return canonicalDailyData;
    }

    function buildLewesObservedIndexDays(archive) {
      const cutoff = primaryArchiveStartDate();
      return (Array.isArray(archive?.days) ? archive.days : [])
        .filter(day => day?.d && String(day.d) < cutoff)
        .map(day => ({
          date: day.d,
          classification: Number.isFinite(decodeSurrogateHundredths(day.p)) ? classifyFloodStage(decodeSurrogateHundredths(day.p)) : "none",
          peakNAVD88: day.p != null && Number.isFinite(Number(day.p)) ? decodeSurrogateHundredths(day.p) : null,
          hours: [],
          isLewesSurrogate: true,
          surrogateStationId: archive?.stationId || surrogateStationId(),
          surrogateStationName: archive?.stationName || surrogateStationName(),
          lewesCompactDay: Array.isArray(day?.v) ? day : null
        }));
    }

    function buildObservedIndexFrom15MinuteArchive(archive, lewesArchive = null) {
      const compactDays = Array.isArray(archive?.days) ? archive.days : [];
      const stoneHarborDays = compactDays.map(day => ({
        date: day.d,
        classification: day.c || "none",
        peakNAVD88: day.p != null && Number.isFinite(Number(day.p)) ? Number(day.p) / 100 : null,
        hours: []
      }));
      const lewesDays = buildLewesObservedIndexDays(lewesArchive);
      const allDays = [...lewesDays, ...stoneHarborDays].sort((a, b) => String(a.date).localeCompare(String(b.date)));
      return {
        archiveStartDate: allDays[0]?.date || archive?.archiveStartDate || compactDays[0]?.d || null,
        archiveEndDate: archive?.archiveEndDate || compactDays[compactDays.length - 1]?.d || null,
        datum: archive?.datum || "NAVD88",
        gaugeName: archive?.gaugeName || primaryGaugeName(),
        sourceType: lewesDays.length ? "lewes-hourly-plus-stone-harbor-15-minute-index" : "compact-15-minute-index",
        lewesCutoffDate: lewesArchive?.stoneHarborCutoffDate || "2007-10-01",
        days: allDays
      };
    }

    function mergeObservedArchiveIndex(index, source = "stone-harbor") {
      if (!index || !Array.isArray(index.days)) return;
      const incoming = source === "lewes"
        ? buildLewesObservedIndexDays(index)
        : index.days.map(day => ({
            date: day.d,
            classification: day.c || "none",
            peakNAVD88: day.p != null && Number.isFinite(Number(day.p)) ? Number(day.p) / 100 : null,
            hours: []
          }));

      // The canonical daily release can predate later USGS observations.
      // Reconcile the browser calendar with the primary replay index BEFORE
      // any year is loaded, so navigation order cannot change source policy.
      const primaryIndex = source === "stone-harbor" && String(index.stationId || index.site) === String(TOWN_CONFIG?.observed?.usgsGaugeId);

      if (!observedData) {
        observedData = buildObservedIndexFrom15MinuteArchive(
          source === "stone-harbor" ? index : { days: [] },
          source === "lewes" ? index : null
        );
      } else {
        const existing = new Map((observedData.days || []).map(day => [String(day?.date || ""), day]));
        incoming.forEach(day => {
          if (!day?.date) return;
          const current = existing.get(day.date);
          if (current) {
            current.isHistoricalCrestOnly = false;
            if (primaryIndex && Number.isFinite(normalizeStageValue(day.peakNAVD88))) {
              current.canonicalPeakNAVD88 ??= current.peakNAVD88;
              if (current.pipelineSource !== "C" && !current.officialCrestEntry) {
                current.peakNAVD88 = day.peakNAVD88;
                current.classification = classifyFloodStage(day.peakNAVD88);
                current.pipelineSource = "U";
              }
              current.isLewesSurrogate = false;
              current.surrogateStationId = null;
              current.surrogateStationName = null;
              return;
            }
            if (current.isCanonicalPipelineTruth) {
              return;
            }
            current.classification = day.classification || current.classification || "none";
            if (Number.isFinite(normalizeStageValue(day.peakNAVD88))) {
              current.peakNAVD88 = Number.isFinite(normalizeStageValue(current.peakNAVD88))
                ? Math.max(Number(current.peakNAVD88), Number(day.peakNAVD88))
                : Number(day.peakNAVD88);
            }
            if (source === "lewes") {
              current.isLewesSurrogate = true;
              current.surrogateStationId = current.surrogateStationId || surrogateStationId();
              current.surrogateStationName = current.surrogateStationName || surrogateStationName();
            }
            return;
          }
          observedData.days.push(day);
          existing.set(day.date, day);
        });
        observedData.days.sort((a, b) => String(a?.date || "").localeCompare(String(b?.date || "")));
        observedData.archiveStartDate = observedData.days[0]?.date || observedData.archiveStartDate;
        if (source === "stone-harbor") {
          observedData.archiveEndDate = index.archiveEndDate || observedData.archiveEndDate;
        }
        if (source === "lewes") {
          observedData.lewesCutoffDate = index.stoneHarborCutoffDate || observedData.lewesCutoffDate || "2007-10-01";
        }
      }
      observedDaysCache = null;
      observedMonthKeys = buildObservedMonthKeysFromDays(getObservedDays());
      clearExportAvailabilityCache();
    }

    function preloadObservedArchiveIndexText(timeoutMs = 15000) {
      if (observedArchiveIndexTextPromise) return observedArchiveIndexTextPromise;
      const controller = new AbortController();
      let timer;
      const deadline = new Promise((_, reject) => {
        timer = window.setTimeout(() => {
          controller.abort();
          reject(new Error("The observed archive index timed out."));
        }, timeoutMs);
      });
      // Race the entire response body, not only the headers. A pending index
      // must yield to the compact fallback even if transport abort is delayed.
      const download = fetch(OBSERVED_ARCHIVE_INDEX_URL, {
        cache: "default",
        headers: { "Accept": "application/geo+json, application/json" },
        signal: controller.signal
      })
        .then(response => {
          if (!response.ok) throw new Error(`HTTP ${response.status} for ${OBSERVED_ARCHIVE_INDEX_URL}`);
          return response.text();
        });
      const request = Promise.race([download, deadline])
        .catch(error => {
          if (observedArchiveIndexTextPromise === request) observedArchiveIndexTextPromise = null;
          throw error;
        })
        .finally(() => window.clearTimeout(timer));
      observedArchiveIndexTextPromise = request;
      return request;
    }

    async function ensureObserved15MinuteArchive() {
      if (observed15MinuteData) return observed15MinuteData;
      const generation = archiveGeneration;
      const indexRequest = preloadObservedArchiveIndexText();
      let payload;
      try {
        payload = JSON.parse(await indexRequest);
        if (generation !== archiveGeneration) throw new Error("Archive request superseded by Reload");
        if (observed15MinuteData) return observed15MinuteData;
        addArchiveShardDays(payload, "stone-harbor", { summary: true });
      } catch (indexError) {
        if (generation !== archiveGeneration) throw indexError;
        if (observedArchiveIndexTextPromise === indexRequest) observedArchiveIndexTextPromise = null;
        console.warn("Optimized observed archive index unavailable; using the compact archive.", indexError);
        payload = await fetchJson(OBSERVED_15MIN_URL, { cache: "default" });
        if (generation !== archiveGeneration) throw new Error("Archive request superseded by Reload");
        if (observed15MinuteData) return observed15MinuteData;
        addArchiveShardDays(payload, "stone-harbor");
      }
      observed15MinuteData = payload;
      return observed15MinuteData;
    }

    async function ensureLewesHourlyArchive() {
      if (!surrogateEnabled() || !LEWES_HOURLY_URL) return null;
      if (lewesHourlyData && Array.isArray(lewesHourlyData.days)) return lewesHourlyData;
      const generation = archiveGeneration;
      const payload = await fetchJson(LEWES_HOURLY_URL, { cache: "default" });
      if (generation !== archiveGeneration) throw new Error("Archive request superseded by Reload");
      return payload;
    }

    function refreshObservedArchiveUi() {
      if (!observedData) return;
      observedDaysCache = null;
      observedMonthKeys = buildObservedMonthKeysFromDays(getObservedDays());
      topTideEvents = buildTopTideEvents();
      renderTopTides();
      populateCalendarSelectors();
      if (currentDataMode === "observed") {
        renderCalendar().catch(error => console.warn("Observed calendar refresh failed.", error));
      }
    }

    async function ensureLewesArchiveIndex() {
      if (!surrogateEnabled() || !LEWES_ARCHIVE_INDEX_URL) return null;
      if (lewesArchiveIndexData) return lewesArchiveIndexData;
      if (lewesArchiveIndexPromise) return lewesArchiveIndexPromise;
      const generation = archiveGeneration;
      lewesArchiveIndexPromise = fetchJson(LEWES_ARCHIVE_INDEX_URL, { cache: "default" })
        .then(index => {
          if (generation !== archiveGeneration) throw new Error("Archive request superseded by Reload");
          const cutoff = primaryArchiveStartDate();
          // Lewes has real date gaps. Require only days the canonical source
          // identifies as available from this gauge before the archive cutoff.
          const canonicalDays = Array.isArray(canonicalDailyData?.days) ? canonicalDailyData.days : [];
          const indexedDates = canonicalDays
            .filter(row => row?.[2] === "N" && Number.isFinite(row[1]) && row[0] < cutoff)
            .map(row => row[0]);
          validateArchiveDays(index, "lewes", { summary: true, indexedDates });
          lewesArchiveIndexData = index;
          lewesHourlyData = {
            stationId: index?.stationId || surrogateStationId(),
            stationName: index?.gaugeName || surrogateStationName(),
            stoneHarborCutoffDate: cutoff
          };
          mergeObservedArchiveIndex(index, "lewes");
          refreshObservedArchiveUi();
          return index;
        })
        .catch(error => {
          if (generation !== archiveGeneration) return null;
          lewesArchiveIndexPromise = null;
          console.warn(`${surrogateStationShort()} archive day index will retry when requested.`, error);
          return null;
        });
      return lewesArchiveIndexPromise;
    }

    function scheduleLewesArchiveIndexWarmup() {
      if (!surrogateEnabled()) return;
      if (lewesArchiveIndexWarmupScheduled || lewesArchiveIndexData) return;
      lewesArchiveIndexWarmupScheduled = true;
      const start = () => ensureLewesArchiveIndex().catch(() => null);
      if (typeof window.requestIdleCallback === "function") {
        window.requestIdleCallback(start, { timeout: 5000 });
      } else {
        window.setTimeout(start, 1800);
      }
    }

    function getObservedArchiveSourceForDate(dateStr) {
      const day = getObservedDayRecord(String(dateStr || ""));
      if (surrogateEnabled() && String(dateStr || "") < primaryArchiveStartDate()) return "lewes";
      if (day?.pipelineSource === "N") return "lewes";
      if (day?.pipelineSource === "U" || day?.pipelineSource === "C") return "stone-harbor";
      const cutoff = primaryArchiveStartDate();
      return surrogateEnabled() && String(dateStr || "") < cutoff ? "lewes" : "stone-harbor";
    }

    function getObservedArchiveShardUrl(source, year) {
      const index = source === "lewes" ? lewesArchiveIndexData : observed15MinuteData;
      const fallback = `./observed_archive/${source}/{year}.json`;
      const configuredTemplate = source === "lewes" ? configuredSurrogate().shardPathTemplate : "";
      const template = String(configuredTemplate || index?.shardPathTemplate || fallback);
      const url = new URL(template.replace("{year}", String(year)), APP_BASE);
      if (source === "stone-harbor") url.searchParams.set("policy", "20260921-usgs-first");
      return url.href;
    }

    function validateArchiveDays(payload, source, { summary = false, year = null, indexedDates = [] } = {}) {
      const expectedInterval = source === "lewes" ? 60 : 15;
      const legacyArchive = TOWN_CONFIG.observed?.archiveContract === "legacy";
      const legacyIndex = legacyArchive && summary && /(?:^|-)observed-day-index-v[12]$/.test(String(payload?.schema || ""));
      const intervalMinutes = payload?.intervalMinutes ?? (legacyIndex ? expectedInterval : NaN);
      if (Number(intervalMinutes) !== expectedInterval) {
        throw new Error(`Invalid ${source} archive interval; expected ${expectedInterval} minutes.`);
      }
      const primaryAlias = summary
        ? String(payload.shardPathTemplate || "").match(/observed_archive\/([a-z0-9-]+)\/\{year\}\.json$/i)?.[1]
        : observed15MinuteData?.source;
      const publishedSource = legacyArchive ? (source === "lewes" ? configuredSurrogate().key : primaryAlias) : null;
      if (payload.source && payload.source !== source && payload.source !== publishedSource) {
        throw new Error("Archive source mismatch.");
      }
      const expectedStation = source === "lewes" ? surrogateStationId() : String(TOWN_CONFIG?.observed?.usgsGaugeId);
      if (String(payload.stationId || payload.site) !== expectedStation) throw new Error("Archive gauge mismatch.");
      if (payload.datum && payload.datum !== "NAVD88") throw new Error("Archive datum mismatch.");
      if (year && payload.year != null && String(payload.year) !== String(year)) throw new Error("Archive year mismatch.");
      const days = payload.days;
      if (!Array.isArray(days) || !days.length) throw new Error("Archive has no days.");
      const dates = new Set();
      for (const day of days) {
        const date = day?.d;
        const civilDate = new Date(`${date}T00:00:00Z`);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(civilDate.getTime()) ||
            civilDate.toISOString().slice(0, 10) !== date) throw new Error("Invalid archive day.");
        if (year && !date.startsWith(`${year}-`)) throw new Error(`Archive day ${date} is outside ${year}.`);
        if (dates.has(date)) throw new Error(`Duplicate archive day ${date}.`);
        dates.add(date);
        if (summary && day.v === undefined) continue;
        if (!Array.isArray(day.v)) throw new Error(`Archive day ${date} has no sample array.`);
        const start = parseStoredLocalNyToDate(`${date}T00:00`);
        const end = parseStoredLocalNyToDate(`${addDaysToDateKey(date, 1)}T00:00`);
        const slots = start && end ? (end - start) / (expectedInterval * 60000) : 0;
        if (day.v.length !== slots || Number(day.u) * 1000 !== start?.getTime()) {
          throw new Error(`Invalid ${source} sample cadence for ${date}.`);
        }
        if (day.v.some(value => value !== null && !Number.isFinite(value))) throw new Error("Invalid archive sample.");
      }
      const { archiveStartDate: first, archiveEndDate: last } = payload;
      const publishedArchive = ["north-wildwood-observed-day-index-v1", "north-wildwood-observed-15min-v1",
        "north-wildwood-lewes-hourly-surrogate-v1"].includes(payload.schema);
      if (publishedArchive || (first && last) || (summary && (first || last))) {
        if (!dates.has(first) || !dates.has(last) || days.some(day => day.d < first || day.d > last)) {
          throw new Error("Archive does not match its published bounds.");
        }
        // The primary USGS index represents outages as explicit dates. The
        // Lewes index is legitimately sparse and must keep that coverage.
        if (source === "stone-harbor" && (!legacyArchive || publishedArchive) && dates.size !== (Date.parse(last) - Date.parse(first)) / 86400000 + 1) {
          throw new Error("Primary archive is missing dates in its published bounds.");
        }
      }
      if (indexedDates.some(date => !dates.has(date))) throw new Error("Archive details omit an indexed date.");
      return days;
    }

    function addArchiveShardDays(payload, source, options) {
      const days = validateArchiveDays(payload, source, options);
      const cache = source === "lewes" ? lewesHourlyDaysByDate : observed15MinuteDaysByDate;
      days.forEach(day => {
        if (!day?.d || !Array.isArray(day.v)) return;
        cache.set(day.d, day);
        if (!observedData) return;
        const existing = getObservedDayRecord(day.d);
        if (!existing) {
          observedData.days.push({
            date: day.d,
            classification: day.c || "none",
            peakNAVD88: day.p != null && Number.isFinite(Number(day.p)) ? source === "lewes" ? decodeSurrogateHundredths(day.p) : Number(day.p) / 100 : null,
            hours: [],
            isLewesSurrogate: source === "lewes",
            surrogateStationId: source === "lewes" ? surrogateStationId() : null,
            surrogateStationName: source === "lewes" ? surrogateStationName() : null
          });
        } else if (source !== "lewes" || existing.isLewesSurrogate) {
          existing.isHistoricalCrestOnly = false;
        }
      });
      if (observedData) {
        observedData.days.sort((a, b) => String(a?.date || "").localeCompare(String(b?.date || "")));
      }
      observedDaysCache = null;
      clearExportAvailabilityCache();
    }

    async function ensureObservedArchiveYear(source, year) {
      const generation = archiveGeneration;
      const key = `${source}:${year}`;
      if (observedArchiveLoadedYears.has(key)) return true;
      if (observedArchiveUnavailableYears.has(key)) return false;
      if (observedArchiveYearPromises.has(key)) return observedArchiveYearPromises.get(key);
      if (source === "stone-harbor") await ensureObserved15MinuteArchive();
      const index = source === "lewes" ? await ensureLewesArchiveIndex() : observed15MinuteData;
      if (generation !== archiveGeneration) throw new Error("Archive request superseded by Reload");
      const indexedDates = (index?.days || []).filter(day => day.d.startsWith(`${year}-`)).map(day => day.d);
      if (index?.days?.length && !indexedDates.length) {
        observedArchiveUnavailableYears.add(key);
        return false;
      }
      const install = (payload, shardYear = null) => {
        if (generation !== archiveGeneration) throw new Error("Archive request superseded by Reload");
        const covered = Array.isArray(payload?.days) &&
          payload.days.some(day => day?.d?.startsWith(`${year}-`) && Array.isArray(day.v));
        if (!covered) throw new Error(`Archive does not cover ${source} ${year}.`);
        addArchiveShardDays(payload, source, { year: shardYear, indexedDates });
        observedArchiveLoadedYears.add(key);
        return true;
      };
      const promise = fetchJson(getObservedArchiveShardUrl(source, year), { cache: "default" })
        .then(payload => install(payload, year))
        .catch(async error => {
          if (generation !== archiveGeneration) throw error;
          console.warn(`Optimized ${source} ${year} archive unavailable.`, error);
          try {
            const fallback = source === "stone-harbor"
              ? await fetchJson(OBSERVED_15MIN_URL, { cache: "default" })
              : await ensureLewesHourlyArchive();
            const loaded = install(fallback);
            if (source === "lewes") lewesHourlyData = fallback;
            return loaded;
          } catch (fallbackError) {
            if (generation !== archiveGeneration) throw fallbackError;
            // A network failure remains retryable. Never mark an uncovered
            // year as loaded or silently borrow a different gauge's samples.
            console.warn(`Detailed ${source} ${year} history unavailable; daily peaks only.`, fallbackError);
            return false;
          }
        }).finally(() => {
          if (observedArchiveYearPromises.get(key) === promise) observedArchiveYearPromises.delete(key);
        });
      observedArchiveYearPromises.set(key, promise);
      return promise;
    }

    async function ensureObservedArchiveForDate(dateStr) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ""))) return false;
      const generation = archiveGeneration;
      const source = getObservedArchiveSourceForDate(dateStr);
      await ensureObservedArchiveYear(source, String(dateStr).slice(0, 4));
      if (generation !== archiveGeneration) return false;
      // Hydraulic history crosses calendar boundaries. Load adjacent shards
      // before constructing a day so January 1 has its preceding crest and
      // December 31 has the next same-gauge endpoint.
      const previousDate = addDaysToDateKey(dateStr, -1);
      const nextDate = addDaysToDateKey(dateStr, 1);
      for (const adjacentDate of [previousDate, nextDate]) {
        if (adjacentDate.slice(0, 4) !== dateStr.slice(0, 4)
            && getObservedArchiveSourceForDate(adjacentDate) === source) {
          await ensureObservedArchiveYear(source, adjacentDate.slice(0, 4));
          if (generation !== archiveGeneration) return false;
        }
      }
      if (generation !== archiveGeneration) return false;
      // Recent primary dates can include unpublished readings. Reuse the
      // live cooldown when selecting one again, including yesterday's tail.
      if (source === "stone-harbor" && typeof extendObservedArchiveThroughToday === "function") {
        const today = getTodayNyDateKey();
        const refresh = observedData?.liveObservedRefresh;
        const firstRecentDate = refresh?.retryStartDate || (refresh?.publishedEndDate &&
          refresh.publishedEndDate < today ? addDaysToDateKey(today, -1) : today);
        if (dateStr >= firstRecentDate && dateStr <= today) {
          await extendObservedArchiveThroughToday();
          if (generation !== archiveGeneration) return false;
        }
      }
      return (source === "lewes" ? lewesHourlyDaysByDate : observed15MinuteDaysByDate).has(dateStr);
    }

    async function ensureObservedArchiveRange(startDate, endDate) {
      const startKey = getExportDayKeyFromDate(startDate);
      const endKey = getExportDayKeyFromDate(endDate);
      if (!startKey || !endKey) return;
      const keys = new Set();
      let cursor = startKey < endKey ? startKey : endKey;
      const finalKey = startKey < endKey ? endKey : startKey;
      while (cursor && cursor <= finalKey) {
        keys.add(`${getObservedArchiveSourceForDate(cursor)}:${cursor.slice(0, 4)}`);
        cursor = addDaysToDateKey(cursor, 1);
      }
      await Promise.all(Array.from(keys).map(key => {
        const [source, year] = key.split(":");
        return ensureObservedArchiveYear(source, year);
      }));
      await ensureObservedArchiveForDate(startKey < endKey ? startKey : endKey);
      if (startKey !== endKey) await ensureObservedArchiveForDate(finalKey);
    }

    function decodeLewesHourlyDay(dayRecord) {
      const compact = dayRecord?.lewesCompactDay;
      if (!compact || !Number.isFinite(Number(compact.u)) || !Array.isArray(compact.v)) return [];
      const sixMinuteIndexes = new Set(Array.isArray(compact.x) ? compact.x.map(Number) : []);
      return compact.v.map((encoded, index) => {
        const timeMs = (Number(compact.u) + index * 3600) * 1000;
        const stage = encoded == null ? null : decodeSurrogateHundredths(encoded);
        return setTimelineSlotFields({
          navd88StageFt: stage,
          stageFt: stage,
          value: stage,
          source: sixMinuteIndexes.has(index) ? `noaa-${configuredSurrogate().key || "surrogate"}-verified-6min` : `noaa-${configuredSurrogate().key || "surrogate"}-verified-hourly`,
          sourceStationId: lewesHourlyData?.stationId || surrogateStationId(),
          sourceStation: lewesHourlyData?.stationName || surrogateStationName(),
          sourceStationShort: surrogateStationShort(),
          sourceResolutionMinutes: sixMinuteIndexes.has(index) ? 6 : 60,
          isLewesSurrogate: true,
          surrogateForPrimaryGauge: true,
          isMissingObservedHour: !Number.isFinite(stage)
        }, timeMs, 60, { observedDate: dayRecord.date });
      });
    }

    function decodeObserved15MinuteDay(day) {
      if (!day || !Number.isFinite(Number(day.u)) || !Array.isArray(day.v)) return [];
      return day.v.map((encoded, index) => {
        const timeMs = (Number(day.u) + index * 900) * 1000;
        const stage = encoded == null ? null : Number(encoded) / 100;
        return setTimelineSlotFields({
          navd88StageFt: stage, stageFt: stage, value: stage,
          sourceResolutionMinutes: Number(observed15MinuteData?.sourceResolutionMinutes) || 6,
          sourceStationId: (day.s || "")[index] === "N" ? "1005" : (day.s || "")[index] === "L" ? surrogateStationId() : String(TOWN_CONFIG?.observed?.usgsGaugeId || TOWN_CONFIG?.site?.usgsGaugeId || ""),
          stormReplay: day.replay || null,
          observationQuality: (day.q || "")[index] || "unknown",
          isMeasuredQuarterHourArchive: (day.q || "")[index] === "M",
          isInterpolatedTimelineFrame: (day.q || "")[index] === "I",
          interpolationSpanSeconds: Array.isArray(day.g) ? day.g[index] : null,
          isMissingObservedHour: !Number.isFinite(stage)
        }, timeMs, 15, { observedDate: day.d });
      });
    }

    function buildObservedQuarterHourDisplaySeries(dayRecord, dateStr) {
      return buildObservedCanonicalSeries(dayRecord, dateStr);
    }

    function buildObservedCanonicalSeries(dayRecord, dateStr) {
      let source = getObservedSourceHoursForDay(dayRecord);
      if (source.length && source.every(entry => entry.isDailyPeakOnly)) return source;
      const start = parseStoredLocalNyToDate(`${dateStr}T00:00`);
      const end = parseStoredLocalNyToDate(`${dateStr}T23:45`);
      let contextStart = start;
      const previousDate = addDaysToDateKey(dateStr, -1);
      const previousDay = getObservedDayRecord(previousDate);
      // Keep the existing eight-hour crest search on the same gauge. Missing
      // observations stay missing; the normal interpolation gap limit applies.
      if (start && previousDay && Boolean(previousDay.isLewesSurrogate) === Boolean(dayRecord?.isLewesSurrogate)) {
        const firstStation = source.find(entry => !entry.isDailyPeakOnly && Number.isFinite(getStageValue(entry)))?.sourceStationId;
        const preceding = getObservedSourceHoursForDay(previousDay).filter(entry => {
          const time = entryTimeMs(entry);
          return !entry.isDailyPeakOnly && Number.isFinite(time) &&
            time >= start.getTime() - 8 * 60 * 60 * 1000 && time < start.getTime() &&
            (!firstStation || !entry.sourceStationId || entry.sourceStationId === firstStation);
        });
        if (preceding.length) {
          contextStart = new Date(start.getTime() - 8 * 60 * 60 * 1000);
          source = preceding.concat(source);
        }
      }
      if (dayRecord?.isLewesSurrogate) {
        const nextDate = addDaysToDateKey(dateStr, 1);
        const nextDay = getObservedDayRecord(nextDate);
        const midnight = parseStoredLocalNyToDate(`${nextDate}T00:00`);
        // Use a real, loaded sample from the same gauge. Never extrapolate
        // past the last reading or turn a date-only crest into a timed sample.
        if (nextDay?.isLewesSurrogate && midnight) {
          source = source.concat(getObservedSourceHoursForDay(nextDay).filter(entry =>
            !entry.isDailyPeakOnly && entryTimeMs(entry) === midnight.getTime()
          ));
        }
      }
      const sourceResolutionMinutes = detectSeriesResolutionMinutes(source);
      const series = buildQuarterHourTimelineSeries(source, {
        kind: "observed",
        observedDate: dateStr,
        startMs: contextStart ? contextStart.getTime() : null,
        endMs: end ? end.getTime() : null,
        sourceResolutionMinutes,
        fillMissingSlots: true,
        // Lewes archive samples are hourly; the primary archive is 15-minute.
        // Allow adjacent hourly readings, but keep missing hourly readings blank.
        maxGapMinutes: dayRecord?.isLewesSurrogate ? 60 : 30
      });

      const annotated = annotateHydraulicSeries(series);
      const antecedents = start ? annotated.filter(entry => entryTimeMs(entry) < start.getTime()) : [];
      return annotated.filter(entry => !start || entryTimeMs(entry) >= start.getTime()).map((entry, idx) => ({
        ...entry,
        ...(antecedents.length ? { hydraulicAntecedents: antecedents } : {}),
        observedDate: dateStr,
        quarterHourIndex: idx,
        classification: dayRecord?.classification || entry.classification || "none",
        peakNAVD88: dayRecord?.peakNAVD88 ?? entry.peakNAVD88,
        sourceResolutionMinutes: entry.isLiveObservedBackfill ? entry.sourceResolutionMinutes : sourceResolutionMinutes
      }));
    }

    function sampleCanonicalHydraulicSeries(entries = [], intervalMinutes = getTimelineIntervalMinutes()) {
      const canonical = Array.isArray(entries) ? entries : [];
      if (canonical.length && canonical.every(entry => entry.isDailyPeakOnly)) return canonical.slice();
      if (intervalMinutes === 15) {
        return canonical.map(entry => ({
          ...entry,
          timelineIntervalMinutes: 15,
          observationInterval: "15min"
        }));
      }
      if (intervalMinutes !== 60) return canonical.slice();

      return canonical
        .filter(entry => {
          const date = getEntryESTDate(entry);
          const parts = date ? getNyParts(date) : null;
          return parts && Number(parts.minute) === 0;
        })
        .map(entry => ({
          ...entry,
          timelineIntervalMinutes: 60,
          observationInterval: "1hour",
          sampledFromCanonical15MinuteHistory: true
        }));
    }

function setDatumHelpOpen(isOpen) {
      const modal = document.getElementById("datumModal");
      const btn = document.getElementById("datumHelpBtn");
      if (!modal || !btn) return;
      modal.hidden = !isOpen;
      modal.classList.toggle("open", isOpen);
      btn.setAttribute("aria-expanded", String(isOpen));
      if (isOpen) {
        document.getElementById("datumModalCloseBtn")?.focus();
      }
    }

    const HELP_COPY = {
      dataSource: {
        title: "Flood data",
        body: `
          <p><strong>Forecast</strong> shows expected tides ahead. <strong>Past</strong> shows measured tide gauge readings. <strong>Modeled Floods</strong> shows sample floods that are possible over time.</p>
        `
      },
      forecastType: {
        title: "Forecast type",
        body: `
          <p>Choose Lower End, Mean, or Upper End to compare forecast scenarios based on NOAA PETSS guidance. Upper End shows the upper water-depth estimate for this forecast.</p>
        `
      },
      overlay: {
        title: "Overlay",
        body: `
          <p><strong>Flood Depth</strong> shows the estimated water depth above the ground, in inches below 1 foot and feet at 1 foot or more.</p>
          <p><strong>Flood Stages</strong> groups flooding as minor, moderate, or major.</p>
          <p><strong>Roads with 6+ Inches of Water</strong> highlights road centerlines where modeled water depth above ground exceeds 0.5 ft. At bridges, the estimate uses the modeled surface below the deck.</p>
        `
      },
      satellite: {
        title: "Satellite",
        body: "<p>Shows aerial imagery beneath the flood map.</p>"
      },
      buildings: {
        title: "Buildings",
        body: "<p>Shows buildings on the map. Tap one for more details.</p>"
      },
      parcels: {
        title: "Parcels",
        body: "<p>Shows property lines. Tap a lot to see how much of it may flood.</p>"
      },
      structuralImpacts: {
        title: "Structural Impacts",
        body: "<p>Shows where floodwater could reach a garage, crawlspace, or first floor.</p>"
      },
      roadImpacts: {
        title: "Roads with 6+ Inches of Water",
        body: "<p>Highlights road sections with more than 6 inches of estimated water. At bridges, the estimate is for the surface below the deck.</p>"
      },
      roadNames: {
        title: "Road Names",
        body: "<p>Shows street names so you can see which roads are near flooding.</p>"
      },
      cameras: {
        title: "Cameras",
        body: "<p>Shows camera locations. Tap a camera to see its feed or open the camera's website.</p>"
      },
      timelineDetail: {
        title: "Timeline detail",
        body: `
          <p><strong>Hourly</strong> shows one point per hour. <strong>15-Min</strong> shows four points per hour when available. <strong>Daily Max</strong> shows each day's highest water level.</p>
        `
      },
      returnIntervals: {
        title: "Modeled floods",
        body: `
          <p><strong>Every 100 Years</strong> means about a 1% chance in any year. It does not mean the flood can happen only once every 100 years.</p>
          <p>Each choice shows a sample 24-hour storm whose surge peak is aligned to the first high tide in the window.</p>
        `
      },
      depthLegend: {
        title: "Flood Depth Key",
        body: `
          <p>Light blue is shallow water. Darker blue is deeper water.</p>
          <p><strong>Uncertainty</strong> marks terrain below the selected water level that the connected flood model does not classify as flooded under the current filling conditions. Marshes and beaches are never changed just to complete a street route. During drainage, lag-retained street water is blue.</p>
        `
      },
      stageLegend: {
        title: "Flood Stages Key",
        body: `
          <p>Flood Stages colors terrain below the selected water level by its existing Minor, Moderate, or Major category.</p>
          <p><strong>Green uncertainty areas</strong> are the same areas shown in Flood Depth for the selected time. They replace the stage color wherever Flood Depth marks uncertain flooding. Uncertainty is separate from flood severity; it is not a stage below Minor. Physics forecast frames do not provide this green uncertainty layer.</p>
          <ul>
            <li><strong>Minor:</strong> low roads and public areas may flood.</li>
            <li><strong>Moderate:</strong> roads and some buildings may flood. Evacuations may be needed.</li>
            <li><strong>Major:</strong> many roads and buildings may flood. Larger evacuations may be needed.</li>
          </ul>
        `
      }
    };

