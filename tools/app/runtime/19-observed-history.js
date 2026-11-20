    function scoreObservedDayRecord(day) {
      const hours = Array.isArray(day?.hours) ? day.hours : [];
      let validStages = 0;
      hours.forEach(hour => {
        if (Number.isFinite(getStageValue(hour))) validStages++;
      });
      return validStages * 1000 + hours.length;
    }

    function mergeObservedDayRecords(records = []) {
      if (!records.length) return null;
      const sortedRecords = records.slice().sort((a, b) => scoreObservedDayRecord(a) - scoreObservedDayRecord(b));
      const base = { ...sortedRecords[sortedRecords.length - 1] };
      const byHour = new Map();
      const timelineRawHours = [];

      sortedRecords.forEach(record => {
        const hours = Array.isArray(record?.hours) ? record.hours : [];
        const sourceResolutionMinutes = detectSeriesResolutionMinutes(hours);
        const fullArchiveDay = hours.length >= 20 && (!sourceResolutionMinutes || sourceResolutionMinutes >= 45);
        hours.forEach((hour, idx) => {
          if (entryTimeMs(hour) != null) {
            timelineRawHours.push({
              ...hour,
              observedDate: record.date,
              classification: record.classification || base.classification || "none",
              peakNAVD88: record.peakNAVD88 ?? base.peakNAVD88,
              sourceHourIndex: idx,
              sourceResolutionMinutes
            });
          }

          let hourIndex = getStoredEntryHourIndex(hour);
          if (!(hourIndex >= 0 && hourIndex <= 23) && fullArchiveDay && idx >= 0 && idx <= 23) {
            hourIndex = idx;
          }
          if (!(hourIndex >= 0 && hourIndex <= 23)) {
            const direct = Number(hour?.hourIndex);
            hourIndex = Number.isInteger(direct) && direct >= 0 && direct <= 23 ? direct : null;
          }
          if (!(hourIndex >= 0 && hourIndex <= 23)) return;

          const nextStage = getStageValue(hour);
          const existing = byHour.get(hourIndex);
          const existingStage = existing ? getStageValue(existing) : null;

          if (!existing || (!Number.isFinite(existingStage) && Number.isFinite(nextStage))) {
            byHour.set(hourIndex, {
              ...hour,
              hourIndex,
              observedDate: record.date,
              classification: record.classification || base.classification || "none",
              peakNAVD88: record.peakNAVD88 ?? base.peakNAVD88,
              sourceHourIndex: idx
            });
          }
        });
      });

      if (byHour.size) {
        base.hours = Array.from(byHour.entries())
          .sort((a, b) => a[0] - b[0])
          .map(([hourIndex, hour]) => ({
            ...hour,
            hourIndex,
            displayTimeEST: hour.displayTimeEST || hour.timeEST || hour.timeEst || `${base.date}T${pad2(hourIndex)}:00`
          }));
      } else {
        base.hours = Array.isArray(base.hours) ? base.hours : [];
      }

      if (timelineRawHours.length) {
        base.timelineRawHours = timelineRawHours
          .sort((a, b) => (entryTimeMs(a) ?? 0) - (entryTimeMs(b) ?? 0));
      } else {
        base.timelineRawHours = Array.isArray(base.hours) ? base.hours : [];
      }

      return base;
    }

    function getObservedDays() {
      if (observedDaysCache) return observedDaysCache;
      const rawDays = Array.isArray(observedData?.days) ? observedData.days : [];
      if (!rawDays.length) {
        observedDaysCache = [];
        return observedDaysCache;
      }
      const byDate = new Map();
      rawDays.forEach(day => {
        const date = String(day?.date || "");
        if (!date) return;
        if (!byDate.has(date)) byDate.set(date, []);
        byDate.get(date).push(day);
      });
      observedDaysCache = Array.from(byDate.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([, records]) => mergeObservedDayRecords(records))
        .filter(Boolean);
      return observedDaysCache;
    }

    function getMonthKeyFromDate(dateStr) {
      return String(dateStr).slice(0, 7);
    }

    function buildObservedMonthKeysFromDays(days) {
      const keys = new Set();
      days.forEach(day => {
        if (day?.date) keys.add(getMonthKeyFromDate(day.date));
      });
      return Array.from(keys).sort();
    }

    function getObservedDayRecord(dateStr) {
      return getObservedDays().find(d => d.date === dateStr) || null;
    }

    function getObservedDaysForMonth(monthKey) {
      return getObservedDays().filter(d => getMonthKeyFromDate(d.date) === monthKey);
    }

    function getLatestObservedDate() {
      const days = getObservedDays();
      if (!days.length) return null;
      for (let index = days.length - 1; index >= 0; index -= 1) {
        const day = days[index];
        const hasPeak = day?.peakNAVD88 != null && Number.isFinite(Number(day.peakNAVD88));
        const hasMeasuredHour = getObservedSourceHoursForDay(day).some(entry => Number.isFinite(getStageValue(entry)));
        if (hasPeak || hasMeasuredHour) return day.date;
      }
      return days[days.length - 1].date;
    }

function formatSelectedObservedDate(dateStr) {
      const match = String(dateStr || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!match) return dateStr || "Pick a day";
      const [, y, m, d] = match;
      return `${MONTH_NAMES[Number(m) - 1]} ${Number(d)}, ${y}`;
    }

    function prettyMonthShort(monthKey) {
      if (!monthKey) return "--";
      const [y, m] = monthKey.split("-");
      return `${MONTH_NAMES[Number(m) - 1]} ${y}`;
    }

    function getChronologicalDateIndex(dateStr) {
      return getObservedDays().findIndex(d => d.date === dateStr);
    }

    function getNeighborObservedDate(dateStr, direction) {
      const days = getObservedDays();
      const idx = getChronologicalDateIndex(dateStr);
      if (idx < 0) return null;
      const nextIdx = idx + direction;
      if (nextIdx < 0 || nextIdx >= days.length) return null;
      return days[nextIdx]?.date || null;
    }

    function updateDayNav() {
      const center = document.getElementById("dayNavCenter");
      const input = document.getElementById("observedDateInput");
      const prevBtn = document.getElementById("prevDayBtn");
      const nextBtn = document.getElementById("nextDayBtn");

      const displayValue = selectedObservedDate ? formatSelectedObservedDate(selectedObservedDate) : "";

      if (input) {
        if (document.activeElement !== input) input.value = displayValue;
        input.placeholder = selectedObservedDate ? displayValue : "Type a date";
      } else if (center) {
        center.textContent = displayValue || "Pick a day";
      }

      if (!selectedObservedDate) {
        prevBtn.disabled = true;
        nextBtn.disabled = true;
        return;
      }

      prevBtn.disabled = !getNeighborObservedDate(selectedObservedDate, -1);
      nextBtn.disabled = !getNeighborObservedDate(selectedObservedDate, 1);
    }

    function parseTypedObservedDate(value) {
      const raw = String(value || "").trim();
      if (!raw) return null;

      const dateKey = (year, month, day) => {
        const key = `${String(year).padStart(4, "0")}-${pad2(month)}-${pad2(day)}`;
        const date = new Date(key + "T00:00:00Z");
        return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === key ? key : null;
      };
      let match = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
      if (match) return dateKey(match[1], match[2], match[3]);

      match = raw.match(/^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?$/);
      if (match) {
        let y = match[3] ? Number(match[3]) : (currentMonthKey ? Number(currentMonthKey.slice(0, 4)) : new Date().getFullYear());
        if (y < 100) y += 2000;
        return dateKey(y, match[1], match[2]);
      }

      const monthFirst = raw.match(/^([a-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/i);
      const dayFirst = raw.match(/^(\d{1,2})\s+([a-z]+)\.?,?\s+(\d{4})$/i);
      if (!monthFirst && !dayFirst) return null;
      const [, monthText, day, year] = monthFirst || [null, dayFirst[2], dayFirst[1], dayFirst[3]];
      const monthNames = ["january", "february", "march", "april", "may", "june",
        "july", "august", "september", "october", "november", "december"];
      const name = monthText.toLowerCase().replace(/^sept$/, "sep");
      const month = monthNames.findIndex(full => full === name || full.slice(0, 3) === name) + 1;
      return month ? dateKey(year, month, day) : null;
    }

    async function submitTypedObservedDate() {
      const input = document.getElementById("observedDateInput");
      if (!input) return;
      const parsed = parseTypedObservedDate(input.value);
      if (!parsed) {
        input.value = selectedObservedDate ? formatSelectedObservedDate(selectedObservedDate) : "";
        toast("Enter a date like Apr 19, 2026 or 04/19/2026.");
        return;
      }
      const available = getObservedDays().some(day => day.date === parsed);
      if (!available) {
        input.value = selectedObservedDate ? formatSelectedObservedDate(selectedObservedDate) : "";
        toast(`No observed data available for ${formatSelectedObservedDate(parsed)}.`);
        return;
      }
      const pending = submitTypedObservedDate.pending;
      if (pending?.date === parsed && pending.generation === selectionGeneration) return;
      const request = { date: parsed };
      submitTypedObservedDate.pending = request;
      try {
        const load = loadObservedDay(parsed);
        request.generation = selectionGeneration;
        const loaded = await load;
        if (loaded === false || request.generation !== selectionGeneration || selectedObservedDate !== parsed ||
            parseTypedObservedDate(input.value) !== parsed) return;
        input.value = formatSelectedObservedDate(parsed);
        input.blur();
      } finally {
        if (submitTypedObservedDate.pending === request) submitTypedObservedDate.pending = null;
      }
    }

    function entryTimeMs(entry) {
      const d = getEntryESTDate(entry);
      return d ? d.getTime() : null;
    }

    function formatTopTideDateLabelFromDateKey(dateKey) {
      return formatSelectedObservedDate(dateKey);
    }

    function formatTopTideDateLabelFromEntry(entry) {
      if (entry?.topTideDisplayDate) return entry.topTideDisplayDate;
      if (entry?.display_date) return entry.display_date;
      if (entry?.displayDate) return entry.displayDate;
      if (entry?.observedDate) return formatTopTideDateLabelFromDateKey(entry.observedDate);
      const d = getEntryESTDate(entry);
      if (!d) return "--";
      const parts = getNyParts(d);
      if (!parts) return "--";
      return `${MONTH_NAMES[Number(parts.month) - 1]} ${Number(parts.day)}, ${parts.year}`;
    }

    function normalizeTopTidesJsonEntry(item, idx) {
      if (!item || typeof item !== "object") return null;
      const height = Number(item.height_ft ?? item.heightFt ?? item.navd88 ?? item.NAVD88 ?? item.stage_ft ?? item.stageFt);
      const date = String(item.date || item.crest_date || item.crestDate || "").slice(0, 10);
      if (!Number.isFinite(height) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
      const standardTime = item.time_est || item.timeEST;
      const rawTime = String(standardTime || item.crest_time || item.crestTime || "").trim();
      // NWIS peak times are reported in local standard time, even in summer.
      let crestDate = null;
      if (/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(rawTime)) {
        const stamp = `${date}T${rawTime}`;
        crestDate = standardTime ? new Date(`${stamp}:00-05:00`) : parseStoredLocalNyToDate(stamp);
      }
      const crestTimeKnown = Number.isFinite(crestDate?.getTime());
      const localTime = crestTimeKnown ? formatNyLocalIso(crestDate) : `${date}T12:00`;
      const observedDate = localTime.slice(0, 10);
      const displayDate = String((observedDate === date && (item.display_date || item.displayDate))
        || formatTopTideDateLabelFromDateKey(observedDate));
      const sourceArea = String(item.source_area || item.sourceArea || "historical");
      const sourceSite = String(item.site_no || item.siteNo || "");
      const sourceStation = String(item.station_name || item.stationName || "");
      const sourceStationShort = String(item.station_short || item.stationShort || (sourceArea === "stone-harbor" ? "Stone Harbor" : ""));

      return {
        navd88StageFt: height,
        observedDate,
        displayTimeEST: localTime,
        timeEST: localTime,
        ...(crestTimeKnown ? { timeUtc: crestDate.toISOString() } : {}),
        topTideDateOnly: true,
        topTideDisplayDate: displayDate,
        topTideSource: "historical",
        topTideSourceIndex: idx,
        crestTimeKnown,
        sourceArea,
        sourceSite,
        sourceStation,
        sourceStationShort,
        stationPriority: Number(item.station_priority ?? item.stationPriority ?? (sourceArea === "stone-harbor" ? 3 : 1)),
        recordType: String(item.record_type || item.recordType || "USGS storm-tide crest"),
        eventName: String(item.event_name || item.eventName || ""),
        sourceUrl: String(item.source_url || item.sourceUrl || ""),
        observationInterval: "crest",
        isHistoricalTopTide: true
      };
    }

    async function loadHistoricalTopTides() {
      if (historicTopTideEntries.length) return historicTopTideEntries;
      if (historicalTopTidesPromise) return historicalTopTidesPromise;
      const generation = archiveGeneration;
      const request = fetchJson(TOP_TIDES_URL, { cache: "default" })
        .then(data => {
          if (generation !== archiveGeneration) throw new Error("Historical crest request superseded by Reload");
          const rows = Array.isArray(data?.toptides) ? data.toptides : Array.isArray(data) ? data : [];
          historicTopTideEntries = rows.map(normalizeTopTidesJsonEntry).filter(Boolean);
          return historicTopTideEntries;
        })
        .catch(error => {
          if (historicalTopTidesPromise === request) {
            historicalTopTidesPromise = null;
            historicTopTideEntries = [];
          }
          throw error;
        });
      historicalTopTidesPromise = request;
      return historicalTopTidesPromise;
    }

    function mergeHistoricalCrestsIntoObservedIndex() {
      if (!observedData || !Array.isArray(observedData.days) || !historicTopTideEntries.length) return;
      const bestCrestByDate = new Map();
      historicTopTideEntries.forEach(entry => {
        const dateKey = String(entry?.observedDate || "");
        if (!dateKey || !Number.isFinite(getStageValue(entry))) return;
        const existing = bestCrestByDate.get(dateKey);
        const nextPriority = Number(entry.stationPriority) || 0;
        const existingPriority = Number(existing?.stationPriority) || 0;
        if (!existing || nextPriority > existingPriority || (nextPriority === existingPriority && getStageValue(entry) > getStageValue(existing))) {
          bestCrestByDate.set(dateKey, entry);
        }
      });
      let changed = false;
      bestCrestByDate.forEach((entry, dateKey) => {
        const stage = getStageValue(entry);
        const crestEntry = {
          ...entry,
          observedDate: dateKey,
          observationInterval: "crest",
          isHistoricalTopTide: true,
          isHistoricalCrestOnly: true
        };
        const existingDays = observedData.days.filter(day => String(day?.date || "") === dateKey);
        if (existingDays.length) {
          existingDays.forEach(day => {
            day.classification = classifyFloodStage(stage);
            day.peakNAVD88 = stage;
            day.peakMLLW = stage + (DATUM_OFFSETS.mllw || 0);
            day.officialCrestEntry = crestEntry;
            day.officialCrestStageFt = stage;
            day.crestSourceSite = entry.sourceSite;
            day.crestSourceStation = entry.sourceStation;
          });
          changed = true;
          return;
        }
        observedData.days.push({
          date: dateKey,
          classification: classifyFloodStage(stage),
          peakNAVD88: stage,
          peakMLLW: stage + (DATUM_OFFSETS.mllw || 0),
          isHistoricalCrestOnly: true,
          crestSourceSite: entry.sourceSite,
          crestSourceStation: entry.sourceStation,
          hours: [crestEntry],
          timelineRawHours: [crestEntry]
        });
        changed = true;
      });
      if (changed) {
        observedData.days.sort((a, b) => String(a?.date || "").localeCompare(String(b?.date || "")));
        observedData.archiveStartDate = observedData.days[0]?.date || observedData.archiveStartDate;
        observedDaysCache = null;
        clearExportAvailabilityCache();
      }
    }

    function buildModernTopTideCandidates() {
      // Rank the day index before any replay year is downloaded. Detailed
      // samples enrich the selected event; they must not decide its rank.
      const daysByDate = new Map((observed15MinuteData?.days || []).map(day => [day.d, {
        date: day.d,
        peakNAVD88: normalizeStageValue(day.p) == null ? null : Number(day.p) / 100,
        classification: day.c || "none",
        hours: []
      }]));
      getObservedDays().forEach(day => daysByDate.set(day.date, day));
      const officialDates = new Set(historicTopTideEntries
        .filter(entry => Number.isFinite(getStageValue(entry)))
        .map(entry => entry.observedDate));
      const sortedDays = Array.from(daysByDate.values())
        .filter(day => !day?.isHistoricalCrestOnly && !day?.isLewesSurrogate && !day?.officialCrestEntry
          && !officialDates.has(day.date) && Number.isFinite(normalizeStageValue(day?.peakNAVD88)))
        .slice()
        .sort((a, b) => Number(b.peakNAVD88) - Number(a.peakNAVD88));

      const chosen = [];
      const minGapMs = TOP_TIDE_WINDOW_HOURS * 60 * 60 * 1000;

      for (const dayRecord of sortedDays) {
        const dateKey = String(dayRecord?.date || "");
        const t = Date.parse(`${dateKey}T12:00:00Z`);
        if (!dateKey || !Number.isFinite(t)) continue;
        const overlaps = chosen.some(existing => {
          const et = Date.parse(`${existing.dateKey}T12:00:00Z`);
          return Number.isFinite(et) && Math.abs(et - t) < minGapMs;
        });
        if (overlaps) continue;

        const canonicalSeries = buildObservedCanonicalSeries(dayRecord, dateKey);
        const daySeries = canonicalSeries.every(entry => entry.isDailyPeakOnly)
          ? canonicalSeries
          : getTimelineIntervalMinutes() === 1440
            ? buildObservedDailyMaximumSeries(dateKey.slice(0, 7))
            : sampleCanonicalHydraulicSeries(canonicalSeries, getTimelineIntervalMinutes());
        if (!daySeries.some(item => Number.isFinite(getStageValue(item)))) continue;
        const dailyEventIndex = getTimelineIntervalMinutes() === 1440
          ? daySeries.findIndex(item => item?.observedDate === dateKey)
          : -1;
        const peakLocalIndex = dailyEventIndex >= 0 ? dailyEventIndex : getPeakHourIndex(daySeries);
        const sourceEntry = daySeries[peakLocalIndex];

        const entry = {
          ...sourceEntry,
          observedDate: dateKey,
          topTideDateOnly: false,
          topTideDisplayDate: formatTopTideDateLabelFromDateKey(dateKey),
          topTideSource: "modern",
          sourceArea: "stone-harbor",
          sourceSite: String(TOWN_CONFIG?.observed?.usgsGaugeId || TOWN_CONFIG?.site?.usgsGaugeId || ""),
          sourceStation: TOWN_CONFIG.observed?.primaryStationLabel ?? TOWN_CONFIG.site.gaugeName,
          sourceStationShort: primaryGaugeName(),
          stationPriority: 3,
          isHistoricalTopTide: false
        };

        chosen.push({
          entry,
          dateKey,
          peakStage: Number(dayRecord.peakNAVD88),
          title: formatTopTideDateLabelFromDateKey(dateKey),
          subtitle: "",
          series: daySeries,
          canonicalSeries,
          peakLocalIndex,
          sourceType: "modern",
          sourceArea: "stone-harbor",
          stationPriority: 3
        });

        if (chosen.length >= Math.max(TOP_TIDE_SELECT_COUNT * 2, TOP_TIDE_SELECT_COUNT + 5)) break;
      }
      return chosen;
    }

    function injectOfficialStoneHarborCrest(series, crestEntry) {
      const cloned = (Array.isArray(series) ? series : []).map(entry => ({ ...entry }));
      if (!cloned.length) return cloned;
      const officialStage = getStageValue(crestEntry);
      if (!Number.isFinite(officialStage)) return cloned;
      // Explicit calibrated replays already have their own fitted time and shape.
      // Their published maximum is distinct from the agency's recorded instant.
      if (cloned.some(entry => entry.stormReplay?.crestStationId === crestEntry.sourceSite &&
          Number(entry.stormReplay?.targetNavd88Ft) === officialStage &&
          getStageValue(entry) === officialStage)) return cloned;
      const targetIndex = crestEntry?.crestTimeKnown
        ? findClosestEntryIndex(cloned, crestEntry)
        : getPeakHourIndex(cloned);
      if (targetIndex < 0 || targetIndex >= cloned.length) return cloned;
      const archiveStage = getStageValue(cloned[targetIndex]);
      if (Number.isFinite(archiveStage) && archiveStage >= officialStage) return cloned;
      cloned[targetIndex] = {
        ...cloned[targetIndex],
        navd88StageFt: officialStage,
        stageFt: officialStage,
        value: officialStage,
        officialCrestStageFt: officialStage,
        officialCrestSourceSite: crestEntry.sourceSite,
        sourceStationShort: crestEntry.sourceStationShort,
        observationQuality: "C",
        isMissingObservedHour: false,
        isMissingTimelineFrame: false,
        isMeasuredQuarterHourArchive: false,
        isInterpolatedTimelineFrame: false,
        interpolationSpanSeconds: null,
        crestTimeEstimated: !crestEntry.crestTimeKnown,
        isOfficialCrestFrame: true
      };
      return cloned;
    }

    function fitLewesSurrogateTideToCrest(series, crestEntry) {
      const cloned = (Array.isArray(series) ? series : []).map(entry => ({ ...entry }));
      const officialStage = getStageValue(crestEntry);
      if (!cloned.length || !Number.isFinite(officialStage)) return cloned;

      const targetIndex = getPeakHourIndex(cloned);
      if (targetIndex < 0 || targetIndex >= cloned.length) return cloned;

      const sourcePeak = getStageValue(cloned[targetIndex]);
      const targetTime = entryTimeMs(cloned[targetIndex]);
      if (!Number.isFinite(sourcePeak) || !Number.isFinite(targetTime)) return cloned;

      const delta = officialStage - sourcePeak;
      const halfWindowHours = 6;
      cloned.forEach((entry, index) => {
        const stage = getStageValue(entry);
        const time = entryTimeMs(entry);
        if (!Number.isFinite(stage) || !Number.isFinite(time)) return;
        const distanceHours = Math.abs(time - targetTime) / (60 * 60 * 1000);
        if (distanceHours > halfWindowHours) return;
        const weight = 0.5 * (1 + Math.cos(Math.PI * distanceHours / halfWindowHours));
        const adjusted = Number((stage + delta * weight).toFixed(4));
        cloned[index] = {
          ...entry,
          navd88StageFt: adjusted,
          stageFt: adjusted,
          value: adjusted,
          sourceStationShort: surrogateStationShort(),
          surrogateForStoneHarbor: true,
          crestFitMethod: "raised-cosine-12-hour-tide-window",
          observationQuality: "C",
          crestTimeEstimated: !crestEntry.crestTimeKnown,
          fittedStoneHarborCrestStageFt: officialStage,
          isFittedCrestFrame: index === targetIndex
        };
      });

      cloned[targetIndex] = {
        ...cloned[targetIndex],
        navd88StageFt: officialStage,
        stageFt: officialStage,
        value: officialStage,
        isFittedCrestFrame: true
      };
      return cloned;
    }

    function buildHistoricalTopTideCandidates() {
      return historicTopTideEntries
        .filter(entry => Number.isFinite(getStageValue(entry)))
        .map(entry => {
          const dateKey = entry.observedDate || "";
          const dayRecord = dateKey ? getObservedDayRecord(dateKey) : null;
          const usesStoneHarborReplayShape = true;
          const canUseStoneHarborArchive = Boolean(
            dayRecord && !dayRecord.isHistoricalCrestOnly && !dayRecord.isLewesSurrogate && usesStoneHarborReplayShape
          );
          const canUseLewesSurrogate = Boolean(
            dayRecord && dayRecord.isLewesSurrogate
          );
          let canonicalSeries = (canUseStoneHarborArchive || canUseLewesSurrogate)
            ? buildObservedCanonicalSeries(dayRecord, dateKey)
            : [];
          const gaugeOutageHours = getLongestGaugeOutageHours(canonicalSeries);
          const forceCrestOnly = gaugeOutageHours > GAUGE_OUTAGE_THRESHOLD_HOURS;
          if (forceCrestOnly) canonicalSeries = [];
          if (canonicalSeries.length > 1) {
            canonicalSeries = canUseLewesSurrogate
              ? fitLewesSurrogateTideToCrest(canonicalSeries, entry)
              : injectOfficialStoneHarborCrest(canonicalSeries, entry);
            canonicalSeries = annotateHydraulicSeries(canonicalSeries);
          }
          const replayable = canonicalSeries.length > 1 && canonicalSeries.some(item => Number.isFinite(getStageValue(item)));
          const series = !replayable
            ? []
            : getTimelineIntervalMinutes() === 1440
              ? [{
                  ...canonicalSeries[getPeakHourIndex(canonicalSeries)],
                  observationInterval: "daily",
                  timelineIntervalMinutes: 1440,
                  isDailyMaximum: true
                }]
              : sampleCanonicalHydraulicSeries(canonicalSeries, getTimelineIntervalMinutes());
          const dailyEventIndex = replayable && getTimelineIntervalMinutes() === 1440
            ? series.findIndex(item => item?.observedDate === dateKey)
            : -1;
          const useRecordedCrestTime = entry.crestTimeKnown && !canonicalSeries.some(item => item.stormReplay);
          const peakLocalIndex = replayable
            ? (dailyEventIndex >= 0 ? dailyEventIndex : (useRecordedCrestTime ? findClosestEntryIndex(series, entry) : getPeakHourIndex(series)))
            : 0;
          return {
            entry,
            dateKey,
            peakStage: getStageValue(entry),
            title: formatTopTideDateLabelFromEntry(entry),
            subtitle: entry.sourceStationShort || "USGS crest",
            series: replayable ? series : [{ ...entry, topTideHourIndex: 0, observationInterval: "crest" }],
            canonicalSeries: replayable ? canonicalSeries : [],
            peakLocalIndex,
            sourceType: replayable ? (canUseLewesSurrogate ? "lewes-surrogate-crest" : "archive-crest") : "historical",
            sourceArea: entry.sourceArea,
            surrogateSource: canUseLewesSurrogate ? `NOAA ${surrogateStationShort()} ${surrogateStationId()}` : "",
            stationPriority: Number(entry.stationPriority) || 0,
            forceCrestOnly,
            gaugeOutageHours
          };
        });
    }

    function buildTopTideEvents() {
      const combined = [
        ...buildModernTopTideCandidates(),
        ...buildHistoricalTopTideCandidates()
      ].filter(event => Number.isFinite(event.peakStage)
        // User-reported invalid sensor peaks; exclude both feed paths before ranking.
        && !["2026-09-21", "2026-08-23"].includes(event.dateKey));

      const bestByDate = new Map();
      combined.forEach(event => {
        const key = event.dateKey || event.title || `${event.sourceType}-${bestByDate.size}`;
        const existing = bestByDate.get(key);
        if (!existing) {
          bestByDate.set(key, event);
          return;
        }
        const eventPriority = Number(event.stationPriority) || (event.sourceType === "modern" ? 3 : 0);
        const existingPriority = Number(existing.stationPriority) || (existing.sourceType === "modern" ? 3 : 0);
        const eventReplayable = Array.isArray(event.series) && event.series.length > 1;
        const existingReplayable = Array.isArray(existing.series) && existing.series.length > 1;
        const shouldReplace = (event.forceCrestOnly && !existing.forceCrestOnly)
          || (!existing.forceCrestOnly && eventPriority > existingPriority)
          || (!existing.forceCrestOnly && eventPriority === existingPriority && eventReplayable && !existingReplayable)
          || (event.forceCrestOnly === existing.forceCrestOnly && eventPriority === existingPriority && eventReplayable === existingReplayable && event.peakStage > existing.peakStage);
        if (shouldReplace) bestByDate.set(key, event);
      });

      return Array.from(bestByDate.values())
        .sort((a, b) => b.peakStage - a.peakStage)
        .slice(0, TOP_TIDE_SELECT_COUNT)
        .map((event, idx) => ({
          ...event,
          rank: idx + 1,
          title: event.title || formatTopTideDateLabelFromEntry(event.entry),
          series: (event.series || [event.entry]).map((entry, localIdx) => ({
            ...entry,
            topTideHourIndex: localIdx,
            topTideDateOnly: event.sourceType === "historical" || (event.series || []).length <= 1,
            topTideDisplayDate: event.title || formatTopTideDateLabelFromEntry(entry),
            observationInterval: event.sourceType === "historical" ? "crest" : (entry.observationInterval || "1hour")
          }))
        }));
    }

    function createTopTideButton(event, idx, options = {}) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = options.extraClass ? `top-tide-item ${options.extraClass}` : "top-tide-item";
      btn.dataset.floodDate = event.dateKey || "";
      btn.dataset.sourceType = event.sourceType || "unknown";
      if (event.surrogateSource) btn.dataset.surrogateSource = event.surrogateSource;
      btn.classList.toggle("active", currentViewType === "top-tide" && currentTopTideIndex === idx);
      const stage = formatStageForDisplay(event.peakStage);
      const title = options.inline
        ? event.title.replace(/^[A-Za-z]{4,}(?=\s+\d)/, month => month.slice(0, 3))
        : event.title;
      for (const [className, value] of [
        ["top-tide-rank", `#${event.rank}`], ["top-tide-main", title], ["top-tide-sub", stage]
      ]) {
        const cell = document.createElement("div");
        cell.className = className;
        cell.textContent = value;
        btn.appendChild(cell);
      }
      btn.setAttribute("aria-label", `#${event.rank} ${event.title}, ${stage}`);
      btn.addEventListener("click", () => {
        const closesDrawer = btn.closest("#topTidesModalList") && document.body.classList.contains("mobile-controls-open");
        // Close the parent before restoring focus from the child, so the
        // modal cannot return focus to a drawer that is about to disappear.
        if (closesDrawer) setMobileControlsOpen(false);
        setTopTidesModalOpen(false);
        if (closesDrawer) document.getElementById("mobileControlsToggle")?.focus({ preventScroll: true });
        loadTopTideEvent(idx).catch(err => toast(err.message));
      });
      return btn;
    }

    function renderTopTidesModal() {
      const list = document.getElementById("topTidesModalList");
      if (!list) return;
      const focusedDate = list.contains(document.activeElement) ? document.activeElement.dataset.floodDate : "";
      list.innerHTML = "";
      const modalEvents = topTideEvents.slice(0, TOP_TIDE_SELECT_COUNT);
      if (!modalEvents.length) {
        const empty = document.createElement("div");
        empty.className = "muted";
        empty.textContent = "No flood crests are available.";
        list.appendChild(empty);
        return;
      }
      modalEvents.forEach((event, globalIdx) => {
        list.appendChild(createTopTideButton(event, globalIdx, { extraClass: "top-tide-modal-item" }));
      });
      if (focusedDate) {
        const sameEvent = [...list.children].find(button => button.dataset.floodDate === focusedDate);
        (sameEvent || document.getElementById("topTidesModalCloseBtn"))?.focus({ preventScroll: true });
      }
    }

    function setTopTidesModalOpen(open, opener = null) {
      const modal = document.getElementById("topTidesModal");
      if (!modal || modal.hidden === !open) return;
      if (modal.parentElement !== document.body) document.body.appendChild(modal);
      if (open) renderTopTidesModal();
      modal.hidden = !open;
      modal.classList.toggle("open", !!open);
      modal.setAttribute("aria-hidden", open ? "false" : "true");
      document.body.classList.toggle("top-tides-modal-open", !!open);
      document.querySelectorAll(".top-tide-more-btn").forEach(button => {
        button.setAttribute("aria-expanded", String(open && button === opener));
      });
      document.dispatchEvent(new CustomEvent("nww:modalchange", { detail: { opener } }));
      if (open) document.getElementById("topTidesModalCloseBtn")?.focus();
    }

    function renderTopTides() {
      const wraps = [document.getElementById("topTideList"), document.getElementById("topTideListMobile")].filter(Boolean);
      const hasMore = topTideEvents.length > TOP_TIDE_DISPLAY_COUNT;

      wraps.forEach(wrap => {
        const focusedDate = wrap.contains(document.activeElement) ? document.activeElement.dataset.floodDate : "";
        const more = hasMore ? wrap.querySelector(".top-tide-more-btn") : null;
        for (const child of [...wrap.children]) {
          if (child !== more) child.remove();
        }

        if (!topTideEvents.length) {
          const empty = document.createElement("div");
          empty.className = "muted";
          empty.textContent = "No archive data.";
          wrap.appendChild(empty);
          return;
        }

        topTideEvents.slice(0, TOP_TIDE_DISPLAY_COUNT).forEach((event, idx) => {
          const button = createTopTideButton(event, idx, { inline: true });
          wrap.insertBefore(button, more);
          if (focusedDate && event.dateKey === focusedDate) button.focus({ preventScroll: true });
        });

        if (hasMore && !more) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "top-tide-more-btn";
          button.setAttribute("aria-controls", "topTidesModal");
          button.setAttribute("aria-expanded", "false");
          button.setAttribute("aria-haspopup", "dialog");
          button.innerHTML = '<span class="unified-more-plus" aria-hidden="true">+</span><span>Show more</span>';
          button.addEventListener("click", () => setTopTidesModalOpen(true, button));
          wrap.appendChild(button);
        }
      });
      renderTopTidesModal();
    }

