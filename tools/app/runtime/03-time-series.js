    function getNyParts(date) {
      if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
      const parts = {};
      for (const part of NY_PARTS_FORMATTER.formatToParts(date)) {
        if (part.type !== "literal") parts[part.type] = part.value;
      }
      const hour12 = Number(parts.hour || 0) % 12;
      const dayPeriod = String(parts.dayPeriod || "").toUpperCase();
      parts.hour24 = String(dayPeriod === "PM" ? hour12 + 12 : hour12);
      return parts;
    }

    function getNyDateTimeLabel(date, options = {}) {
      const parts = getNyParts(date);
      if (!parts) return "--";
      const weekday = parts.weekday || "";
      const month = parts.month || "00";
      const day = parts.day || "00";
      const year = parts.year || "0000";
      const hour = parts.hour || "--";
      const minute = parts.minute || "00";
      const tz = parts.timeZoneName || "ET";
      const includeWeekday = options.includeWeekday !== false;
      const includeDate = options.includeDate !== false;
      const includeZone = options.includeZone !== false;
      const compact = options.compact === true;
      const dateText = includeDate ? `${month}/${day}/${year}` : "";
      const timeText = compact ? `${hour}:${minute} ${parts.dayPeriod || ""}`.trim() : `(${hour}:${minute} ${parts.dayPeriod || ""})`;
      return [
        includeWeekday ? weekday : "",
        dateText,
        timeText,
        includeZone ? tz : ""
      ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    }

    function formatNyLocalIso(date) {
      const parts = getNyParts(date);
      if (!parts) return "";
      return `${parts.year}-${parts.month}-${parts.day}T${pad2(Number(parts.hour24))}:${parts.minute}`;
    }

function detectSeriesResolutionMinutes(entries = []) {
      const times = entries
        .map(entryTimeMs)
        .filter(t => Number.isFinite(t))
        .sort((a, b) => a - b);

      const diffs = [];
      for (let i = 1; i < times.length; i++) {
        const diffMinutes = (times[i] - times[i - 1]) / 60000;
        if (diffMinutes > 0) diffs.push(diffMinutes);
      }
      if (!diffs.length) return null;
      diffs.sort((a, b) => a - b);
      return diffs[Math.floor(diffs.length / 2)];
    }

    function getLocalNyDateCandidates(timeEST) {
      const match = String(timeEST || "").match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
      if (!match) return [];
      const [, y, m, d, hh, mm] = match;
      const targetLocalMs = Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm));
      // New York uses UTC-4/UTC-5 throughout the supported gauge archive.
      // Round-trip both offsets: spring-forward has no candidate and fall-back
      // has two distinct instants, in chronological order.
      return [4, 5].map(offset => new Date(targetLocalMs + offset * 60 * 60 * 1000)).filter(date => {
        const parts = getNyParts(date);
        return parts && parts.year === y && parts.month === m && parts.day === d &&
          Number(parts.hour24) === Number(hh) && parts.minute === mm;
      });
    }

function parseStoredLocalNyToDate(timeEST) {
      // Legacy wall-time records retain the earlier repeated hour. Interactive
      // export editors expose both candidates and keep their selected instant.
      return getLocalNyDateCandidates(timeEST)[0] || null;
    }


    function getStoredEntryHourIndex(entry) {
      const raw = String(entry?.displayTimeEST || entry?.timeEST || entry?.timeEst || "");
      const match = raw.match(/^\d{4}-\d{2}-\d{2}T(\d{2}):/);
      if (match) {
        const hour = Number(match[1]);
        if (Number.isInteger(hour) && hour >= 0 && hour <= 23) return hour;
      }

      const d = getEntryESTDate(entry);
      const parts = d ? getNyParts(d) : null;
      const fallback = Number(parts?.hour24);
      if (Number.isInteger(fallback) && fallback >= 0 && fallback <= 23) return fallback;

      const direct = Number(entry?.hourIndex);
      return Number.isInteger(direct) && direct >= 0 && direct <= 23 ? direct : null;
    }

    const GAUGE_OUTAGE_THRESHOLD_HOURS = 12;

    function getTimelineFrameHours(entry) {
      const explicitMinutes = Number(entry?.timelineIntervalMinutes);
      if (Number.isFinite(explicitMinutes) && explicitMinutes > 0) return explicitMinutes / 60;
      if (entry?.observationInterval === "15min") return 0.25;
      if (entry?.observationInterval === "daily") return 24;
      return getTimelineIntervalMinutes() === 15 ? 0.25 : 1;
    }

    function getLongestGaugeOutageHours(series = [], startIndex = 0, endIndex = null, options = null) {
      if (!Array.isArray(series) || !series.length) return 0;
      options = options || {};
      const start = Math.max(0, Number(startIndex) || 0);
      let end = Math.min(series.length - 1, endIndex == null ? series.length - 1 : Number(endIndex));
      if (options.ignoreTrailingGap) {
        while (end >= start) {
          const entry = series[end];
          const missing = entry?.isMissingObservedHour || entry?.isMissingTimelineFrame || !Number.isFinite(getStageValue(entry));
          if (!missing) break;
          end -= 1;
        }
      }
      let longest = 0;
      let current = 0;
      for (let index = start; index <= end; index++) {
        const entry = series[index];
        const missing = entry?.isMissingObservedHour || entry?.isMissingTimelineFrame || !Number.isFinite(getStageValue(entry));
        if (missing) {
          current += getTimelineFrameHours(entry);
          longest = Math.max(longest, current);
        } else {
          current = 0;
        }
      }
      return Number(longest.toFixed(2));
    }

    function hasLongGaugeOutage(series = [], startIndex = 0, endIndex = null, options = {}) {
      return getLongestGaugeOutageHours(series, startIndex, endIndex, options) > GAUGE_OUTAGE_THRESHOLD_HOURS;
    }

    function isLatestObservedSeriesSegment(series = [], startIndex = 0, endIndex = null) {
      if (!Array.isArray(series) || !series.length) return false;
      const latestDate = getLatestObservedDate();
      if (!latestDate) return false;
      const start = Math.max(0, Number(startIndex) || 0);
      const end = Math.min(series.length - 1, endIndex == null ? series.length - 1 : Number(endIndex));
      return series.slice(start, end + 1).some(entry =>
        entry?.observedDate === latestDate
        && !entry?.isMissingObservedHour
        && !entry?.isMissingTimelineFrame
        && Number.isFinite(getStageValue(entry))
      );
    }

    function getDisplayedGaugeOutageHours(series = [], startIndex = 0, endIndex = null) {
      return getLongestGaugeOutageHours(series, startIndex, endIndex, {
        ignoreTrailingGap: isLatestObservedSeriesSegment(series, startIndex, endIndex)
      });
    }

    function hasDisplayedLongGaugeOutage(series = [], startIndex = 0, endIndex = null) {
      return getDisplayedGaugeOutageHours(series, startIndex, endIndex) > GAUGE_OUTAGE_THRESHOLD_HOURS;
    }

    function findClosestEntryIndex(series, referenceEntry) {
      if (!Array.isArray(series) || !series.length || !referenceEntry) return 0;
      const target = entryTimeMs(referenceEntry);
      if (target == null) return 0;
      let bestIndex = 0;
      let bestDiff = Infinity;
      series.forEach((entry, idx) => {
        const t = entryTimeMs(entry);
        if (t == null) return;
        const diff = Math.abs(t - target);
        if (diff < bestDiff) {
          bestDiff = diff;
          bestIndex = idx;
        }
      });
      return bestIndex;
    }

    function findClosestMeasuredEntryIndex(series, referenceEntry) {
      if (!Array.isArray(series) || !series.length) return 0;
      const measured = series
        .map((entry, idx) => ({ entry, idx, time: entryTimeMs(entry) }))
        .filter(item =>
          Number.isFinite(item.time)
          && Number.isFinite(getStageValue(item.entry))
          && !item.entry?.isMissingObservedHour
          && !item.entry?.isMissingTimelineFrame
        );
      if (!measured.length) return findClosestEntryIndex(series, referenceEntry);

      const target = entryTimeMs(referenceEntry);
      if (!Number.isFinite(target)) return measured[measured.length - 1].idx;

      let best = measured[0];
      let bestDiff = Math.abs(best.time - target);
      measured.slice(1).forEach(item => {
        const diff = Math.abs(item.time - target);
        if (diff < bestDiff || (diff === bestDiff && item.time > best.time)) {
          best = item;
          bestDiff = diff;
        }
      });
      return best.idx;
    }

    function applyObservedCrestToSource(dayRecord, entries) {
      if (!dayRecord?.officialCrestEntry || entries.length <= 1) return entries;
      return dayRecord.isLewesSurrogate
        ? fitLewesSurrogateTideToCrest(entries, dayRecord.officialCrestEntry)
        : injectOfficialStoneHarborCrest(entries, dayRecord.officialCrestEntry);
    }

    function getObservedSourceHoursForDay(dayRecord, { includeNativeLive = false } = {}) {
      const dateStr = dayRecord?.date || dayRecord?.d;
      const dense = Array.isArray(dayRecord?.timelineRawHours) ? dayRecord.timelineRawHours : [];
      if (dayRecord?.isLewesSurrogate) {
        const compact = dayRecord?.lewesCompactDay || lewesHourlyDaysByDate.get(dateStr);
        if (compact) return applyObservedCrestToSource(dayRecord, decodeLewesHourlyDay({ ...dayRecord, lewesCompactDay: compact }));
      } else if (dateStr) {
        const quarterDay = observed15MinuteDaysByDate.get(dateStr);
        const live = (dense.length ? dense : (Array.isArray(dayRecord?.hours) ? dayRecord.hours : []))
          .filter(entry => entry?.isLiveObservedBackfill && Number.isFinite(getStageValue(entry)));
        if (live.length) {
          const byTime = new Map((quarterDay ? decodeObserved15MinuteDay(quarterDay) : [])
            .map(entry => [entryTimeMs(entry), entry]));
          // IV readings are six-minute measurements. Only exact quarter-hour
          // readings are measured anchors; interpolate the intervening slots
          // within the same thirty-minute gap limit as the primary archive.
          const fresh = buildQuarterHourTimelineSeries(live, {
            kind: "observed", observedDate: dateStr, fillMissingSlots: false,
            requireExactSamples: true, sourceResolutionMinutes: 6, maxGapMinutes: 30
          });
          fresh.forEach(entry => byTime.set(entryTimeMs(entry), entry.isInterpolatedTimelineFrame
            ? { ...entry, observationQuality: "I" } : entry));
          const source = applyObservedCrestToSource(dayRecord, Array.from(byTime.entries())
            .sort((a, b) => a[0] - b[0]).map(([, entry]) => entry));
          if (!includeNativeLive) return source;
          // A daily maximum can occur at a real IV instant between replay slots.
          // Add those readings without changing the quarter-hour replay or crest override.
          return source.concat(live.filter(entry => !byTime.has(entryTimeMs(entry))))
            .sort((a, b) => entryTimeMs(a) - entryTimeMs(b));
        }
        if (quarterDay?.v?.some(value => value != null)) return applyObservedCrestToSource(dayRecord, decodeObserved15MinuteDay(quarterDay));
      }
      if (dense.length) return dense;
      const official = dayRecord?.officialCrestEntry;
      const crestTime = official?.crestTimeKnown ? getEntryESTDate(official) : null;
      if (crestTime && Number.isFinite(getStageValue(official))) {
        return [{
          ...official,
          timeUtc: crestTime.toISOString(),
          sourceStationId: official.sourceSite,
          observationQuality: "C",
          observationInterval: "daily",
          timelineIntervalMinutes: 1440,
          topTideDateOnly: false,
          isDailyPeakOnly: true,
          peakTimeKnown: true
        }];
      }
      const fallbackPeak = normalizeStageValue(dayRecord?.peakNAVD88);
      if (Number.isFinite(fallbackPeak) && dayRecord?.date) {
        return [{
          observedDate: dayRecord.date,
          navd88StageFt: fallbackPeak, stageFt: fallbackPeak, value: fallbackPeak,
          observationInterval: "daily", timelineIntervalMinutes: 1440,
          isDailyPeakOnly: true, peakTimeKnown: false,
          source: "canonical-daily-peak-fallback", pipelineSource: dayRecord.pipelineSource || ""
        }];
      }
      return Array.isArray(dayRecord?.hours) ? dayRecord.hours : [];
    }

    function setTimelineSlotFields(entry, slotMs, intervalMinutes, options = {}) {
      const date = new Date(slotMs);
      const localIso = formatNyLocalIso(date);
      const dateKey = localIso ? localIso.slice(0, 10) : (options.observedDate || entry?.observedDate || "");
      const hourIndex = localIso ? Number(localIso.slice(11, 13)) : (entry?.hourIndex ?? null);
      const minuteIndex = localIso ? Number(localIso.slice(14, 16)) : (entry?.minuteIndex ?? null);
      return {
        ...entry,
        timeUtc: date.toISOString(),
        displayTimeUtc: date.toISOString(),
        displayTimeEST: localIso || entry?.displayTimeEST || entry?.timeEST || "",
        timeEST: localIso || entry?.timeEST || entry?.displayTimeEST || "",
        observedDate: dateKey,
        hourIndex,
        minuteIndex,
        timelineIntervalMinutes: intervalMinutes,
        observationInterval: intervalMinutes === 15 ? "15min" : "1hour"
      };
    }

    function makeMissingTimelineEntry(slotMs, intervalMinutes, options = {}) {
      const date = new Date(slotMs);
      const localIso = formatNyLocalIso(date);
      const dateKey = localIso ? localIso.slice(0, 10) : (options.observedDate || "");
      return {
        displayTimeEST: localIso,
        timeEST: localIso,
        displayTimeUtc: date.toISOString(),
        timeUtc: date.toISOString(),
        observedDate: dateKey,
        hourIndex: localIso ? Number(localIso.slice(11, 13)) : null,
        minuteIndex: localIso ? Number(localIso.slice(14, 16)) : null,
        navd88StageFt: null,
        stageFt: null,
        value: null,
        observationInterval: intervalMinutes === 15 ? "15min" : "1hour",
        timelineIntervalMinutes: intervalMinutes,
        sourceResolutionMinutes: options.sourceResolutionMinutes ?? null,
        isMissingObservedHour: options.kind !== "forecast",
        isMissingTimelineFrame: true
      };
    }

    function makeInterpolatedTimelineEntry(beforeItem, afterItem, slotMs, intervalMinutes, options = {}) {
      const beforeStage = getStageValue(beforeItem?.entry);
      const afterStage = getStageValue(afterItem?.entry);
      if (!Number.isFinite(beforeStage) || !Number.isFinite(afterStage) || afterItem.t <= beforeItem.t) {
        return makeMissingTimelineEntry(slotMs, intervalMinutes, options);
      }

      const ratio = (slotMs - beforeItem.t) / (afterItem.t - beforeItem.t);
      const stage = Number((beforeStage + ((afterStage - beforeStage) * ratio)).toFixed(4));
      return setTimelineSlotFields({
        ...beforeItem.entry,
        hydraulicPhase: null,
        navd88StageFt: stage,
        stageFt: stage,
        value: stage,
        sourceResolutionMinutes: options.sourceResolutionMinutes ?? detectSeriesResolutionMinutes(options.sourceEntries || []),
        isInterpolatedTimelineFrame: true,
        isMeasuredQuarterHourArchive: false,
        isMissingObservedHour: false,
        isMissingTimelineFrame: false,
        isFittedCrestFrame: false,
        isOfficialCrestFrame: false,
        observationQuality: "interpolated",
        interpolationSpanSeconds: (afterItem.t - beforeItem.t) / 1000,
        interpolationStartUtc: new Date(beforeItem.t).toISOString(),
        interpolationEndUtc: new Date(afterItem.t).toISOString()
      }, slotMs, intervalMinutes, options);
    }

    function buildQuarterHourTimelineSeries(entries = [], options = {}) {
      const intervalMinutes = 15;
      const stepMs = intervalMinutes * 60 * 1000;
      const valid = (Array.isArray(entries) ? entries : [])
        .map((entry, idx) => ({ entry, idx, t: entryTimeMs(entry) }))
        .filter(item => !item.entry?.isDailyPeakOnly && Number.isFinite(item.t) && Number.isFinite(getStageValue(item.entry)))
        .sort((a, b) => a.t - b.t || a.idx - b.idx);

      const sourceResolutionMinutes = options.sourceResolutionMinutes ?? detectSeriesResolutionMinutes(entries);
      const startMs = Number.isFinite(options.startMs)
        ? options.startMs
        : (valid.length ? Math.ceil(valid[0].t / stepMs) * stepMs : null);
      const endMs = Number.isFinite(options.endMs)
        ? options.endMs
        : (valid.length ? Math.floor(valid[valid.length - 1].t / stepMs) * stepMs : null);
      const maxGapMs = (Number(options.maxGapMinutes) || 75) * 60 * 1000;
      const fillMissingSlots = options.fillMissingSlots !== false;

      if (!valid.length) {
        if (!fillMissingSlots || !Number.isFinite(startMs) || !Number.isFinite(endMs)) return [];
        const missing = [];
        for (let slot = startMs; slot <= endMs; slot += stepMs) {
          missing.push(makeMissingTimelineEntry(slot, intervalMinutes, {
            ...options,
            sourceResolutionMinutes
          }));
        }
        return missing;
      }

      const exactBySlot = new Map();
      valid.forEach(item => {
        const slot = Math.round(item.t / stepMs) * stepMs;
        if (options.requireExactSamples && item.t !== slot) return;
        if (Math.abs(item.t - slot) > stepMs / 2) return;
        const existing = exactBySlot.get(slot);
        if (!existing || Math.abs(item.t - slot) < Math.abs(existing.t - slot)) exactBySlot.set(slot, item);
      });

      const out = [];
      let cursor = 0;
      for (let slot = startMs; slot <= endMs; slot += stepMs) {
        const exact = exactBySlot.get(slot);
        if (exact && Number.isFinite(getStageValue(exact.entry))) {
          out.push(setTimelineSlotFields({
            ...exact.entry,
            sourceResolutionMinutes: exact.entry.isLiveObservedBackfill
              ? exact.entry.sourceResolutionMinutes : sourceResolutionMinutes
          }, slot, intervalMinutes, options));
          continue;
        }

        while (cursor < valid.length - 1 && valid[cursor + 1].t < slot) cursor += 1;
        const before = valid[cursor];
        const after = valid[cursor + 1];
        if (before && after && before.t <= slot && after.t >= slot && after.t - before.t <= maxGapMs) {
          const frame = makeInterpolatedTimelineEntry(before, after, slot, intervalMinutes, {
            ...options,
            sourceResolutionMinutes,
            sourceEntries: entries
          });
          if (!frame.isMissingTimelineFrame || fillMissingSlots) out.push(frame);
        } else if (fillMissingSlots) {
          out.push(makeMissingTimelineEntry(slot, intervalMinutes, {
            ...options,
            sourceResolutionMinutes
          }));
        }
      }

      return out;
    }

    function buildForecastDisplaySeries(entries = currentRawSeriesHours) {
      const source = Array.isArray(entries) ? entries : [];
      if (getTimelineIntervalMinutes() === 1440) {
        return buildDailyMaximumSeries(source, { kind: "forecast" });
      }
      return sampleCanonicalHydraulicSeries(
        buildForecastCanonicalSeries(source),
        getTimelineIntervalMinutes()
      );
    }

    function buildForecastCanonicalSeries(entries = []) {
      return annotateHydraulicSeries(buildQuarterHourTimelineSeries(entries, {
        kind: "forecast",
        fillMissingSlots: false,
        maxGapMinutes: 75
      }));
    }

    function buildDailyMaximumSeries(entries = [], options = {}) {
      const bestByDate = new Map();
      (Array.isArray(entries) ? entries : []).forEach(entry => {
        const date = getEntryESTDate(entry);
        const parts = date ? getNyParts(date) : null;
        const key = parts ? `${parts.year}-${parts.month}-${parts.day}` : (entry?.observedDate || "");
        const stage = getStageValue(entry);
        if (!key || !Number.isFinite(stage)) return;
        const existing = bestByDate.get(key);
        if (!existing || stage > getStageValue(existing)) bestByDate.set(key, entry);
      });
      return Array.from(bestByDate.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([dateKey, entry]) => ({
        ...entry,
        observedDate: dateKey,
        observationInterval: "daily",
        timelineIntervalMinutes: 1440,
        isDailyMaximum: true,
        dailyMaximumKind: options.kind || "observed"
      }));
    }

    function buildObservedDailyMaximumSeries(monthKey) {
      const out = [];
      for (const day of getObservedDaysForMonth(monthKey)) {
        const dateKey = day?.date;
        if (!dateKey) continue;
        const entries = getObservedSourceHoursForDay(day, { includeNativeLive: true });
        const daily = buildDailyMaximumSeries(entries, { kind: "observed" })[0];
        if (daily) {
          const canonical = buildObservedCanonicalSeries(day, dateKey);
          const time = entryTimeMs(daily);
          let peak = canonical.find(entry => entryTimeMs(entry) === time && getStageValue(entry) === getStageValue(daily));
          if (!peak && Number.isFinite(time)) {
            // A six-minute measured peak may fall between timeline slots.
            // Keep its native instant and stage while resolving its tide phase.
            peak = annotateHydraulicSeries([
              ...canonical.filter(entry => entryTimeMs(entry) !== time), daily
            ].sort((a, b) => entryTimeMs(a) - entryTimeMs(b))).find(entry => entryTimeMs(entry) === time);
          }
          const resolved = { ...daily };
          for (const field of ["hydraulicPhase", "hydraulicPhaseCanonical", "hydraulicCrestIndex",
            "hydraulicCrestTimeUtc", "hydraulicCrestStageFt", "hydraulicElapsedMinutes", "hydraulicAntecedents"]) {
            if (peak && field in peak) resolved[field] = peak[field];
          }
          out.push({ ...resolved, observedDate: dateKey, peakNAVD88: getStageValue(daily),
            observationInterval: "daily", timelineIntervalMinutes: 1440,
            isDailyMaximum: true, dailyMaximumKind: "observed" });
        } else if (Number.isFinite(normalizeStageValue(day.peakNAVD88))) {
          out.push({
            navd88StageFt: Number(day.peakNAVD88), stageFt: Number(day.peakNAVD88), value: Number(day.peakNAVD88),
            observedDate: dateKey, observationInterval: "daily", isDailyPeakOnly: true, peakTimeKnown: false,
            timelineIntervalMinutes: 1440, isDailyMaximum: true, peakNAVD88: Number(day.peakNAVD88)
          });
        }
      }
      return out.sort((a, b) => String(a.observedDate).localeCompare(String(b.observedDate)));
    }


