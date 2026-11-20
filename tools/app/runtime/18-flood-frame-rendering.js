    function setFloodFrameStatus(message, state = "info") {
      if (state === "loading" || (state === "info" && /^Loading\b/i.test(String(message || "")))) message = "";
      if (state === "info") message = String(message || "").split(" • ").filter(note => note !== "Interpolated" && note !== `${TOWN_CONFIG.site.gaugeName} USGS`).join(" • ");
      const status = document.getElementById("floodFrameStatus");
      if (!status) return;
      status.dataset.frameMessage = String(message || "");
      status.dataset.frameState = state;
      scheduleForecastFreshnessNotice();
    }

    function updateFloodFrameStatus() {
      const status = document.getElementById("floodFrameStatus");
      if (!status) return;
      const freshness = currentDataMode === "forecast" ? getForecastFreshness(getForecastSourceForNotice()) : null;
      const forecastNotice = freshness?.state === "stale"
        ? `Forecast from ${formatFixedESTFromUtc(freshness.timestamp, true)} is over 72 hours old. Select Forecast to check for an update.`
        : "";
      const message = [forecastNotice, status.dataset.frameMessage].filter(Boolean).join(" ");
      const timeline = document.getElementById("timelineDock");
      const top = timeline?.getBoundingClientRect().top;
      if (Number.isFinite(top)) status.style.setProperty("--flood-status-bottom", `${Math.max(24, window.innerHeight - top + 70)}px`);
      if (status.textContent !== message) status.textContent = message;
      status.dataset.state = status.dataset.frameState || "info";
      status.hidden = !message;
    }

    async function decodeFloodFrameImage(image) {
      if (!image || !image.complete || !image.naturalWidth) return false;
      if (typeof image.decode === "function") {
        try { await image.decode(); } catch (_) { return false; }
      }
      return image.complete && image.naturalWidth > 0;
    }

    async function renderFloodFrameWithRetry(renderFrame, token) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (token !== lastRenderToken) return false;
        try {
          if (await renderFrame()) return token === lastRenderToken;
        } catch (error) {
          if (token !== lastRenderToken) return false;
          if (attempt === 1) console.warn("The selected flood frame could not load.", error);
        }
        if (token !== lastRenderToken) return false;
        if (attempt === 0) {
          document.body.dataset.floodFrameRecovery = "retrying";
          await new Promise(resolve => window.setTimeout(resolve, 250));
        }
      }
      return false;
    }

    function reportFloodFrameFailure() {
      const retained = Boolean(currentFloodLayer && map?.hasLayer(currentFloodLayer));
      const message = retained
        ? "Could not load the selected flood image. The previous image and time are still shown. Select a time to retry."
        : "The flood image could not load. Select a time to retry.";
      if (typeof floodFrameState !== "undefined") floodFrameState = "failed";
      document.body.dataset.floodFrame = "failed";
      document.body.dataset.floodFrameRecovery = "failed";
      if (typeof setFloodFrameStatus === "function") setFloodFrameStatus(message, "error");
      toast(message);
      if (!retained && typeof markInitialFloodFrameFailed === "function") markInitialFloodFrameFailed();
      if (typeof stopPlayback === "function") stopPlayback();
    }

    function waitForRecoveryFloodLayer(layer, token, onReady) {
      return new Promise(resolve => {
        let settled = false;
        let timeout = null;
        const finish = ready => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timeout);
          layer.off("load", handleLoad);
          layer.off("error", handleError);
          layer.off("remove", handleRemove);
          if (!ready) {
            if (pendingFloodLayer === layer) pendingFloodLayer = null;
            preloadPromiseCache.delete(layer._url);
            if (typeof disposeFloodLayer === "function") disposeFloodLayer(layer);
            else {
              if (map.hasLayer(layer)) map.removeLayer(layer);
              const image = layer.getElement();
              if (image) image.src = "";
            }
          }
          resolve(ready);
        };
        const handleLoad = async () => {
          if (settled || token !== lastRenderToken) return finish(false);
          if (!await decodeFloodFrameImage(layer.getElement())) return finish(false);
          await new Promise(requestAnimationFrame);
          if (settled || token !== lastRenderToken || !map.hasLayer(layer)) return finish(false);
          try {
            const ready = await onReady();
            if (ready === false || settled || token !== lastRenderToken || !map.hasLayer(layer)) return finish(false);
            finish(true);
          }
          catch (error) { console.warn("The flood image could not be displayed.", error); finish(false); }
        };
        const handleError = () => finish(false);
        const handleRemove = () => { if (currentFloodLayer !== layer) finish(false); };
        layer.on("load", handleLoad);
        layer.on("error", handleError);
        layer.on("remove", handleRemove);
        timeout = window.setTimeout(() => finish(false), 20000);
        try { layer.addTo(map); } catch (_) { finish(false); }
      });
    }

    function cancelPendingFloodFrame(invalidate = true) {
      if (invalidate) ++lastRenderToken;
      cancelTimelineSelection();
      requestedTimelineSelection = null;
      const pending = pendingFloodLayer;
      pendingFloodLayer = null;
      if (pending && pending !== currentFloodLayer && map?.hasLayer(pending)) {
        if (typeof disposeFloodLayer === "function") disposeFloodLayer(pending);
        else map.removeLayer(pending);
      }
      if (typeof floodFrameState !== "undefined") floodFrameState = "loading";
      document.body.dataset.floodFrame = "loading";
      if (persistentDepthQueryContext?.kind === "physics") updatePersistentDepthQueryPopup();
      if (typeof setFloodFrameStatus === "function") setFloodFrameStatus(currentFloodLayer ? "" : "", "loading");
      return lastRenderToken;
    }

    function clearFloodLayer() {
      floodFrameState = "unavailable";
      document.body.dataset.floodFrame = floodFrameState;
      if (persistentDepthQueryContext?.kind === "physics") updatePersistentDepthQueryPopup();
      renderedFloodPixelCache = null;
      if (pendingFloodLayer && map?.hasLayer(pendingFloodLayer)) map.removeLayer(pendingFloodLayer);
      if (currentFloodLayer && map?.hasLayer(currentFloodLayer)) map.removeLayer(currentFloodLayer);
      pendingFloodLayer = null;
      currentFloodLayer = null;
      updateNsiStructureImpactLayer();
      updatePersistentDepthQueryPopup();
      scheduleRasterObjectUrlCleanup();
    }

    function applyOverlayOpacity() {
      if (currentFloodLayer?.setOpacity) currentFloodLayer.setOpacity(overlayOpacity);
    }

    function formatFixedESTFromUtc(isoString, includeYear = false) {
      if (!isoString) return "--";
      const d = new Date(isoString);
      if (Number.isNaN(d.getTime())) return "--";
      const parts = getNyParts(d);
      if (!parts) return "--";
      const year = includeYear ? `, ${parts.year}` : "";
      return `${MONTH_NAMES[Number(parts.month) - 1]} ${Number(parts.day)}${year}, ${parts.hour}:${parts.minute} ${parts.dayPeriod || ""} ${parts.timeZoneName || "ET"}`.replace(/\s+/g, " ").trim();
    }

function parseStoredESTToDate(timeEST) {
      return parseStoredLocalNyToDate(timeEST);
    }

    function formatReturnStormOffset(entry, options = {}) {
      const offset = Number(entry?.offsetHours);
      if (!Number.isFinite(offset)) return "Synthetic storm";
      if (Math.abs(offset) < 1e-8) return options.compact ? "Storm peak" : "Storm Peak • First High Tide";
      const absolute = Math.abs(offset);
      const value = Number.isInteger(absolute)
        ? String(absolute)
        : absolute.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
      return `${value} hr ${offset < 0 ? "before" : "after"} peak`;
    }

    function formatHourEntryTime(entry) {
      if (entry?.isDailyPeakOnly && entry.peakTimeKnown !== true) return `${formatSelectedObservedDate(entry.observedDate)} • Peak time unknown`;
      if (entry?.topTideDateOnly) return formatTopTideDateLabelFromEntry(entry);
      if (entry?.returnIntervalYears) return formatReturnStormOffset(entry);
      const d = getEntryESTDate(entry);
      if (!d) return "--";
      return formatFixedESTFromUtc(d.toISOString());
    }

    function formatHourEntryTimeCompact(entry) {
      if (entry?.isDailyPeakOnly && entry.peakTimeKnown !== true) return `${formatSelectedObservedDate(entry.observedDate)} • Daily peak`;
      if (entry?.topTideDateOnly) return formatTopTideDateLabelFromEntry(entry);
      if (entry?.returnIntervalYears) return formatReturnStormOffset(entry, { compact: true });
      const d = getEntryESTDate(entry);
      if (!d) return "--";
      const parts = getNyParts(d);
      if (!parts) return "--";
      return `${parts.month}/${parts.day} ${parts.hour}:${parts.minute} ${parts.dayPeriod || ""}`.replace(/\s+/g, " ").trim();
    }

    function formatSnapshotTime(entry) {
      if (entry?.isDailyPeakOnly && entry.peakTimeKnown !== true) return `${formatSelectedObservedDate(entry.observedDate)} • Peak time unknown`;
      if (entry?.topTideDateOnly) return formatTopTideDateLabelFromEntry(entry);
      if (entry?.returnIntervalYears) return formatReturnStormOffset(entry);
      const est = getEntryESTDate(entry);
      if (!est) return "--";
      return getNyDateTimeLabel(est, { includeWeekday: true, includeDate: true, includeZone: true, compact: false });
    }

function getEntryESTDate(entry) {
      // Calendar ordering anchor only, never an asserted observation timestamp.
      if (entry?.isDailyPeakOnly && entry.peakTimeKnown !== true) return parseStoredLocalNyToDate(`${entry.observedDate}T00:00`);
      const d = entry?.timeUtc
        ? new Date(entry.timeUtc)
        : entry?.displayTimeUtc
          ? new Date(entry.displayTimeUtc)
          : entry?.displayTimeEST
            ? parseStoredESTToDate(entry.displayTimeEST)
            : entry?.displayTimeEst
              ? parseStoredESTToDate(entry.displayTimeEst)
              : entry?.timeEST
                ? parseStoredESTToDate(entry.timeEST)
                : (entry?.timeEst ? parseStoredESTToDate(entry.timeEst) : null);
      if (!d || Number.isNaN(d.getTime())) return null;
      return d;
    }

    function formatTimelineBubbleText(entry) {
      if (entry?.isDailyPeakOnly && entry.peakTimeKnown !== true) return isMobileTimeline() ? "Daily peak only" : `${formatSelectedObservedDate(entry.observedDate)} • Daily peak only`;
      if (entry?.topTideDateOnly) return formatTopTideDateLabelFromEntry(entry);
      if (entry?.returnIntervalYears) return formatReturnStormOffset(entry, { compact: true });
      const est = getEntryESTDate(entry);
      if (!est) return "--";
      const parts = getNyParts(est);
      if (!parts) return "--";
      if (isMobileTimeline()) {
        const time = new Intl.DateTimeFormat("en-US", {
          timeZone: "America/New_York", hour: "numeric", minute: "2-digit", timeZoneName: "short"
        }).format(est).replace(":00", "");
        return `<span class="timeline-sr-date">${formatTimelineDayLabel(entry)} · </span>${time}`;
      }
      const minuteText = parts.minute === "00" ? "" : `:${parts.minute}`;
      return `${parts.weekday} ${Number(parts.day)} · ${parts.hour}${minuteText} ${parts.dayPeriod || ""}`.replace(/\s+/g, " ").trim();
    }

    function formatTimelineDayLabel(entry) {
      if (entry?.topTideDateOnly) return formatTopTideDateLabelFromEntry(entry);
      if (entry?.returnIntervalYears) {
        const halfWindow = Number(returnIntervalData?.windowHours || 84) / 2;
        const dayNumber = Math.max(1, Math.floor((Number(entry.offsetHours) + halfWindow) / 24) + 1);
        return `Day ${dayNumber}`;
      }
      const est = getEntryESTDate(entry);
      if (!est) return "--";
      const parts = getNyParts(est);
      if (!parts) return "--";
      return `${parts.weekday} ${Number(parts.day)}`;
    }

    function sameEntryESTDay(a, b) {
      if (a?.returnIntervalYears || b?.returnIntervalYears) {
        if (!(a?.returnIntervalYears && b?.returnIntervalYears)) return false;
        const halfWindow = Number(returnIntervalData?.windowHours || 84) / 2;
        const dayFor = entry => Math.max(1, Math.floor((Number(entry.offsetHours) + halfWindow) / 24) + 1);
        return dayFor(a) === dayFor(b);
      }
      const da = getEntryESTDate(a);
      const db = getEntryESTDate(b);
      if (!da || !db) return false;
      const pa = getNyParts(da);
      const pb = getNyParts(db);
      if (!pa || !pb) return false;
      return pa.year === pb.year && pa.month === pb.month && pa.day === pb.day;
    }

    function positionTimelineBubble() {
      if(document.body.hasAttribute("data-county-viewport")) return;
      const dock = document.getElementById("timelineDock");
      const slider = document.getElementById("hourSlider");
      const bubble = document.getElementById("timelineBubble");
      if (!dock || !slider || !bubble || !currentSeriesHours.length) return;

      const min = Number(slider.min) || 0;
      const max = Number(slider.max) || 0;
      const pct = max > min ? (currentHourIndex - min) / (max - min) : 0.5;
      const dockRect = dock.getBoundingClientRect();
      const sliderRect = slider.getBoundingClientRect();
      const thumbSize = parseFloat(getComputedStyle(slider).getPropertyValue("--nww-thumb-size")) || 16;
      const usableWidth = Math.max(0, sliderRect.width - thumbSize);
      const x = (sliderRect.left - dockRect.left) + (thumbSize / 2) + (pct * usableWidth);
      const bubbleHalf = Math.max(72, (bubble.offsetWidth / 2) + 8);
      const safe = Math.max(bubbleHalf, Math.min(dockRect.width - bubbleHalf, x));
      bubble.style.left = `${safe}px`;
    }

    function fitTextToSingleLine(el, maxPx, minPx = 11) {
      if (!el) return;
      el.style.fontSize = `${maxPx}px`;
      while (el.scrollWidth > el.clientWidth + 1 && maxPx > minPx) {
        maxPx -= 0.5;
        el.style.fontSize = `${maxPx}px`;
      }
    }

    function fitSnapshotTimeText() {
      const timeEl = document.getElementById("timeText");
      if (!timeEl) return;
      timeEl.style.fontSize = "";
      const observed = document.body.classList.contains("observed-mode");
      fitTextToSingleLine(timeEl, observed ? 17 : 20, 11.5);
    }

    function getTimelineClockMinutes(entry) {
      if (entry?.isDailyPeakOnly || entry?.topTideDateOnly) return null;
      if (entry?.returnIntervalYears) return ((Number(entry.offsetHours) * 60 % 1440) + 1440) % 1440;
      const date = getEntryESTDate(entry);
      const parts = date && getNyParts(date);
      if (!parts) return null;
      const hour = Number(parts.hour) % 12 + (parts.dayPeriod === "PM" ? 12 : 0);
      return hour * 60 + Number(parts.minute);
    }

    function getTimelineDaySelection(start, end) {
      // Compare the same local clock time across days, clamping partial days
      // to their nearest available sample. Daily maxima keep their own peak.
      if (currentHourIndex >= start && currentHourIndex <= end) return currentHourIndex;
      const minute = getTimelineClockMinutes(currentSeriesHours[currentHourIndex]);
      if (minute == null || !Number.isFinite(minute)) return start;
      let selected = start, distance = Infinity;
      for (let index = start; index <= end; index++) {
        const candidate = getTimelineClockMinutes(currentSeriesHours[index]);
        if (candidate == null || !Number.isFinite(candidate)) continue;
        const delta = Math.abs(candidate - minute);
        if (delta < distance) { selected = index; distance = delta; }
      }
      return selected;
    }

    function revealTimelineDay(button, wrap) {
      if (!button || !isMobileTimeline()) return;
      requestAnimationFrame(() => {
        // Scroll only the day strip, never the map or page.
        if (button.offsetLeft < wrap.scrollLeft || button.offsetLeft + button.offsetWidth > wrap.scrollLeft + wrap.clientWidth) {
          wrap.scrollLeft = button.offsetLeft - (wrap.clientWidth - button.offsetWidth) / 2;
        }
      });
    }

    let timelineDayCache = null;
    function renderTimelineDays() {
      const wrap = document.getElementById("timelineDayTabs");
      if (!wrap) return;
      const cacheKey = `${currentDataMode}:${currentOverlayMode}:${isMobileTimeline()}`;
      if (timelineDayCache?.series === currentSeriesHours && timelineDayCache.key === cacheKey) {
        for (const {button, start, end} of timelineDayCache.groups) {
          const active = currentHourIndex >= start && currentHourIndex <= end;
          if (button.classList.contains("active") !== active) {
            button.classList.toggle("active", active);
            button.setAttribute("aria-current", String(active));
            if (active) revealTimelineDay(button, wrap);
          }
        }
        return;
      }
      wrap.innerHTML = "";
      timelineDayCache = {series: currentSeriesHours, key: cacheKey, groups: []};
      if (!currentSeriesHours.length) return;

      const groups = [];
      let startIndex = 0;
      for (let i = 1; i <= currentSeriesHours.length; i++) {
        if (i === currentSeriesHours.length || !sameEntryESTDay(currentSeriesHours[i - 1], currentSeriesHours[i])) {
          groups.push({
            start: startIndex,
            end: i - 1,
            label: formatTimelineDayLabel(currentSeriesHours[startIndex]),
            hours: (i - startIndex)
          });
          startIndex = i;
        }
      }

      groups.forEach(group => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "timeline-day";
        const gaugeInoperable = currentDataMode === "observed" && hasDisplayedLongGaugeOutage(currentSeriesHours, group.start, group.end);
        btn.classList.toggle("gauge-inoperable", gaugeInoperable);
        btn.textContent = gaugeInoperable ? "Gauge inoperable" : group.label;
        if (gaugeInoperable) {
          const outageHours = getDisplayedGaugeOutageHours(currentSeriesHours, group.start, group.end);
          btn.setAttribute("aria-label", `Gauge inoperable for more than ${GAUGE_OUTAGE_THRESHOLD_HOURS} hours`);
          btn.title = `${outageHours.toFixed(0)} consecutive hours without a usable ${TOWN_CONFIG.observed?.gaugeOutageLabel ?? TOWN_CONFIG.site.gaugeName} gauge level`;
        }
        // The first and last frames occupy half a slider interval.
        const timelineFrameWeight = currentSeriesHours.length <= 1 ? 1
          : Math.min(currentSeriesHours.length - 1, group.end + 0.5) - Math.max(0, group.start - 0.5);
        btn.dataset.start = String(group.start);
        btn.dataset.end = String(group.end);
        btn.style.setProperty("--shorely-timeline-frame-weight", String(timelineFrameWeight));
        // Inline priority survives the town/reference styles' equal-flex rules.
        btn.style.setProperty("flex", "var(--shorely-timeline-day-flex, 1) 1 0", "important");
        const tideGradient = gaugeInoperable ? null : buildTimelineGroupGradient(group.start, group.end, isMobileTimeline());
        if (tideGradient) {
          btn.style.setProperty("--timeline-day-gradient", tideGradient);
          btn.style.backgroundImage = `linear-gradient(180deg, rgba(10,18,32,.18), rgba(10,18,32,.18)), ${tideGradient}`;
        } else if (gaugeInoperable) {
          btn.style.backgroundImage = "none";
        }
        const active = currentHourIndex >= group.start && currentHourIndex <= group.end;
        btn.classList.toggle("active", active);
        btn.setAttribute("aria-current", String(active));
        timelineDayCache.groups.push({button: btn, start: group.start, end: group.end});
        btn.addEventListener("click", () => {
          stopPlayback();
          renderHour(getTimelineDaySelection(group.start, group.end)).catch(err => toast(err.message));
        });
        wrap.appendChild(btn);
        if (active) revealTimelineDay(btn, wrap);
      });
    }

    function getRawStageValue(entry) {
      if (!entry) return null;
      // Validate primitive values before coercion; town datum adjustment runs once downstream.
      const readRawStage = value => {
      if (value == null || typeof value === "boolean" ||
          (typeof value !== "number" && typeof value !== "string") ||
          (typeof value === "string" && !value.trim())) return null;
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
      };
      const keys = [
        "navd88StageFt",
        "stageFt",
        "value",
        "waterLevel",
        "waterLevelFt",
        "waterLevelNAVD88",
        "waterLevelNavd88",
        "navd88",
        "NAVD88",
        "navd88_ft",
        "navd88Ft",
        "stage_navd88_ft",
        "stageNAVD88",
        "stageNavd88",
        "water_level",
        "water_level_ft",
        "water_level_navd88",
        "wl_navd88_ft"
      ];
      for (const key of keys) {
        if (entry[key] == null || entry[key] === "") continue;
        const n = readRawStage(entry[key]);
        if (Number.isFinite(n)) return n;
      }

      for (const key of Object.keys(entry)) {
        const k = key.toLowerCase();
        if (!/(navd|stage|water|level|height)/.test(k)) continue;
        if (/(peak|max|min|hour|index|rank|date|time|class|source)/.test(k)) continue;
        // Explicit alternate-datum values are not a NAVD88 fallback.
        if (/(mllw|mhhw|mhw|mlw|msl|ngvd)/.test(k)) continue;
        if (entry[key] == null || entry[key] === "") continue;
        const n = readRawStage(entry[key]);
        if (Number.isFinite(n)) return n;
      }
      return null;
    }

    function getStageValue(entry) {
      const raw = getRawStageValue(entry);
      return raw == null ? null : normalizeStageValue(raw);
    }

    function classifyFloodStage(stageValue) {
      const n = Number(stageValue);
      if (!Number.isFinite(n)) return "none";
      if (n < MINOR_FLOOD_FT) return "none";
      if (n < MODERATE_FLOOD_FT) return "minor";
      if (n < MAJOR_FLOOD_FT) return "moderate";
      return "major";
    }

    function classifyFloodEntries(entries = []) {
      let severity = "none";
      const rank = { none: 0, minor: 1, moderate: 2, major: 3 };
      entries.forEach(entry => {
        const next = classifyFloodStage(getStageValue(entry));
        if ((rank[next] || 0) > (rank[severity] || 0)) severity = next;
      });
      return severity;
    }

    function buildNotes(rawStage, matchedStage) {
      const notes = [];
      if (!Number.isFinite(rawStage) || !Number.isFinite(matchedStage)) return "";
      if (Math.abs(rawStage - matchedStage) > 0.0001) {
        notes.push(`The displayed water level stays exact, but the called raster is rounded down to the nearest published overlay at ${matchedStage.toFixed(1)} ft NAVD88.`);
      }
      if (rawStage > MAX_STAGE) {
        notes.push(`The adjusted water level was above the published range and the raster call was clamped to ${matchedStage.toFixed(1)} ft NAVD88.`);
      } else if (rawStage < MIN_STAGE) {
        notes.push(`The adjusted water level was below the published range and the raster call was clamped to ${matchedStage.toFixed(1)} ft NAVD88.`);
      }
      return notes.join(" ");
    }

    function getPeakHourIndex(hours = currentSeriesHours) {
      if (!hours.length) return 0;
      let maxIndex = 0;
      let maxVal = -Infinity;
      hours.forEach((h, i) => {
        const v = getStageValue(h);
        if (Number.isFinite(v) && v > maxVal) {
          maxVal = v;
          maxIndex = i;
        }
      });
      return maxIndex;
    }

