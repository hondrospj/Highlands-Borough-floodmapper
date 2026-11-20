    function renderTimelineMeta(currentEntry = null) {
      syncSliderBounds();
      const timelineValue = document.getElementById("timelineValue");
      const timelineMeta = document.getElementById("timelineMeta");
      const timelineStart = document.getElementById("timelineStart");
      const timelineEnd = document.getElementById("timelineEnd");
      const label = document.getElementById("timelineLabel");
      const bubble = document.getElementById("timelineBubble");

      const first = currentSeriesHours[0];
      const last = currentSeriesHours[currentSeriesHours.length - 1];
      const entry = currentEntry || currentSeriesHours[currentHourIndex];

      if (!currentSeriesHours.length) {
        timelineValue.textContent = "--";
        timelineMeta.textContent = "--";
        timelineStart.textContent = "--";
        timelineEnd.textContent = "--";
        label.textContent = "Replay";
        document.getElementById("timelineDock")?.classList.remove("top-tide-crest-only");
        if (bubble) bubble.textContent = "--";
        updateTimelineAccessibility();
        return;
      }

      const currentTime = formatHourEntryTime(entry);
      timelineValue.textContent = currentTime;

      if (currentViewType === "forecast") {
        label.textContent = `${getForecastScenarioLabel()} • ${getTimelineIntervalLabel()}`;
      } else if (currentViewType === "return-interval") {
        label.textContent = `${getReturnIntervalLabel()} Flood • ${getTimelineIntervalLabel()}`;
      } else if (currentViewType === "observed-day") {
        label.textContent = entry?.isDailyPeakOnly ? "Observed • Daily peak only" : entry?.observationInterval === "crest" ? "Observed • USGS crest" : `Observed • ${getTimelineIntervalLabel()}`;
      } else {
        label.textContent = "Top 10 Highest Floods";
      }

      const crestOnlyTopTide = (currentViewType === "top-tide" && (entry?.isHistoricalTopTide || currentSeriesHours.length <= 1 || entry?.observationInterval === "crest"))
        || (currentSeriesHours.length <= 1 && entry?.observationInterval === "crest");
      const timelineDock = document.getElementById("timelineDock");
      if (timelineDock) timelineDock.classList.toggle("top-tide-crest-only", Boolean(crestOnlyTopTide));

      if (crestOnlyTopTide) {
        const crestStation = entry?.sourceStationShort ? `${entry.sourceStationShort} USGS` : "USGS";
        const msg = entry?.isDailyPeakOnly
          ? "Only the daily peak water level is available; maximum flood extent is plotted."
          : `Only the ${crestStation} storm-tide crest is available; maximum flood extent is plotted.`;
        timelineMeta.textContent = msg;
        timelineStart.textContent = msg;
        timelineEnd.textContent = "";
        if (bubble) {
          const stageValue = getStageValue(entry);
          const stageText = Number.isFinite(stageValue) ? formatStageForDisplay(stageValue) : "--";
          const stageClass = Number.isFinite(stageValue) ? classifyFloodStage(stageValue) : "none";
          bubble.innerHTML = `<span class="timeline-bubble-current">Maximum extent</span><span class="timeline-bubble-stage timeline-bubble-stage-${stageClass}">${stageText}</span>`;
        }
      } else {
        if (timelineDock) timelineDock.classList.remove("top-tide-crest-only");
        timelineMeta.textContent = "";

        timelineStart.textContent = "";
        timelineEnd.textContent = "";
        if (timelineStart) timelineStart.setAttribute("aria-hidden", "true");
        if (timelineEnd) timelineEnd.setAttribute("aria-hidden", "true");
        if (bubble) {
          const stageValue = getStageValue(entry);
          if (!Number.isFinite(stageValue)) {
            const outageLabel = hasDisplayedLongGaugeOutage(currentSeriesHours) ? "Gauge inoperable" : "No gauge level";
            bubble.innerHTML = `<span class="timeline-bubble-current">${formatTimelineBubbleText(entry)}</span><span class="timeline-bubble-stage timeline-bubble-stage-gauge">${outageLabel}</span>`;
          } else {
            const stageText = formatStageForDisplay(stageValue);
            const stageClass = classifyFloodStage(stageValue);
            bubble.innerHTML = `<span class="timeline-bubble-current">${formatTimelineBubbleText(entry)}</span><span class="timeline-bubble-stage timeline-bubble-stage-${stageClass}">${stageText}</span>`;
          }
        }
      }
      updateTimelineAccessibility();
      renderTimelineDays();
      updateDownloadSummary();
      requestAnimationFrame(positionTimelineBubble);
    }

    function updateTimelineAccessibility() {
      const slider = document.getElementById("hourSlider");
      const bubble = document.getElementById("timelineBubble");
      if (!slider) return;
      slider.setAttribute("aria-label", currentDataMode === "observed" ? "Observed flood time"
        : currentDataMode === "return-interval" ? "Modeled flood time" : "Flood forecast time");
      const parts = bubble ? [...bubble.querySelectorAll(".timeline-bubble-current,.timeline-bubble-stage")]
        .map(part => part.textContent.trim()) : [];
      const valueText = (parts.length ? parts.join(" ") : bubble?.textContent)?.replace(/\s+/g, " ").trim();
      slider.setAttribute("aria-valuetext", valueText || "No time available");
      slider.disabled = !currentSeriesHours.length || slider.min === slider.max;
    }

    function getSnapshotSubLabel(entry) {
      if (entry?.isDailyPeakOnly) return "Daily peak only • detailed observations unavailable";
      if (currentViewType === "forecast") return getForecastScenarioPercentileLabel();
      if (currentViewType === "return-interval") return `Synthetic ${returnIntervalData?.windowHours || 84}-hour storm`;
      if (entry?.observationInterval === "crest" && currentSeriesHours.length <= 1) return "Maximum extent only";
      if (currentViewType === "top-tide") {
        return (entry?.isHistoricalTopTide || currentSeriesHours.length <= 1 || entry?.observationInterval === "crest")
          ? "Maximum extent only"
          : `${getTimelineIntervalLabel()} record`;
      }
      return "";
    }

    function renderSelectionMeta(entry, rawStage, displayStage) {
      currentSelectionQualityNote = "";
      document.getElementById("timeText").textContent = formatSnapshotTime(entry);
      if (entry?.isMissingObservedHour || !Number.isFinite(rawStage)) {
        const gaugeInoperable = currentDataMode === "observed" && hasDisplayedLongGaugeOutage(currentSeriesHours);
        document.getElementById("stageText").textContent = gaugeInoperable ? "Gauge inoperable" : "No data";
        document.getElementById("stageSubText").textContent = gaugeInoperable
          ? `More than ${GAUGE_OUTAGE_THRESHOLD_HOURS} consecutive hours are unavailable`
          : "No observed record for this time";
      } else {
        document.getElementById("stageText").textContent = formatStageForDisplay(rawStage);
        const stageSub = currentViewType === "forecast"
          ? getForecastScenarioLabel()
          : currentViewType === "return-interval"
            ? `${getReturnIntervalLabel()} synthetic • ${getDatumLabel()}`
            : currentViewType === "top-tide"
              ? ((entry?.isHistoricalTopTide || currentSeriesHours.length <= 1 || entry?.observationInterval === "crest") ? "Maximum extent only" : `${getTimelineIntervalLabel()} record`)
              : entry?.observationInterval === "crest"
                ? `USGS crest • ${getDatumLabel()}`
                : `${classifyFloodStage(rawStage) === "none" ? "No flooding" : `${classifyFloodStage(rawStage).charAt(0).toUpperCase() + classifyFloodStage(rawStage).slice(1)} flooding`} • ${getDatumLabel()}`;
        const stationNote = currentDataMode !== "observed" ? "" : entry?.sourceStationId === String(TOWN_CONFIG?.observed?.usgsGaugeId || TOWN_CONFIG?.site?.usgsGaugeId || "") ? `${TOWN_CONFIG.site.gaugeName} USGS` : entry?.sourceStationId === surrogateStationId() ? `${surrogateStationShort()} tide shape` : "";
        const qualityNote = entry?.observationQuality === "I" || entry?.isInterpolatedTimelineFrame
          ? "Interpolated" : entry?.observationQuality === "U" || entry?.observationQuality === "unknown"
            ? "Sampling quality not recorded" : entry?.observationQuality === "C"
              ? (entry.isDailyPeakOnly && entry.peakTimeKnown === true ? "USGS storm-tide crest" : "Calibrated storm replay") : "";
        const peakNote = entry?.isDailyPeakOnly
          ? (entry.peakTimeKnown === true ? "Daily peak only" : "Daily peak only • peak time unknown") : "";
        currentSelectionQualityNote = [stationNote, qualityNote, entry?.crestTimeEstimated ? "Replay timing estimated from source tide" : "", peakNote].filter(Boolean).join(" • ");
        document.getElementById("stageSubText").textContent = [stageSub, currentSelectionQualityNote].filter(Boolean).join(" • ");
      }
      updateSnapshotWaterLevelSeverity(rawStage);
      document.getElementById("selectedText").textContent = currentSelectedLabel;
      document.getElementById("selectedSubText").textContent = currentSelectedSubLabel;
      const snapshotSubLabel = getSnapshotSubLabel(entry);
      const timeSubText = document.getElementById("timeSubText");
      timeSubText.textContent = snapshotSubLabel;
      timeSubText.style.display = snapshotSubLabel ? "" : "none";
      requestAnimationFrame(fitSnapshotTimeText);
    }

    async function setFloodLayer(mode, stageValue, phase, token, entry = null, series = currentRawSeriesHours) {
      const frameEntry = typeof entry !== "undefined" && entry ? entry : currentSeriesHours[currentHourIndex];
      const frameStage = getStageValue(frameEntry);
      const frameMetadata = { entry: frameEntry, stage: Number.isFinite(frameStage) ? frameStage : stageValue,
        phase, dataMode: currentDataMode, overlayMode: mode, overlayStage: stageValue, series,
        forecastSource: currentDataMode === "forecast" && forecastData
          ? { petssCycleUtc: forecastData.petssCycleUtc, forecastEndUtc: forecastData.forecastEndUtc } : null };

      let releaseRaster = null;
      try {
        toast("");
        ensureMap();

        const match = await getHydraulicOverlayRecord(mode, stageValue, phase, entry, series);
        if (token !== lastRenderToken) return;

        if (!match) {
          toast(`Overlay missing for ${stageValue.toFixed(1)} ft. Check your folder path or file naming.`);
          return;
        }

        const overlayUrl = match.url;
        releaseRaster = retainRasterObjectUrl(overlayUrl);
        const loaded = await preloadImage(overlayUrl, "high");
        if (token !== lastRenderToken) return;
        if (!loaded) {
          return false;
        }

        try {
          await ensureOverlayBounds(overlayUrl);
        } catch (err) {
          toast(err.message);
          return;
        }

        if (token !== lastRenderToken) return;

        if (pendingFloodLayer && map.hasLayer(pendingFloodLayer)) {
          map.removeLayer(pendingFloodLayer);
          pendingFloodLayer = null;
        }

        const previousLayer = currentFloodLayer;
        const nextLayer = createHydraulicImageOverlay(
          overlayUrl,
          {
            opacity: 0,
            interactive: false,
            crossOrigin: true,
            zIndex: 500,
            pane: "floodPane",
            className: currentDataMode === "return-interval" && mode === "depth"
              ? "return-interval-depth-overlay"
              : ""
          }
        );

        pendingFloodLayer = nextLayer;
        return await waitForRecoveryFloodLayer(nextLayer, token, async () => {
          // Leaflet also backs the visible WebGL map. Its hidden image being
          // decoded is only the first half of a frame commit in pitched 3D.
          if (typeof window !== "undefined" && window.NORTH_WILDWOOD_3D?.prepareFloodFrame &&
              !await window.NORTH_WILDWOOD_3D.prepareFloodFrame(nextLayer, frameMetadata, token)) return false;
          if (token !== lastRenderToken || pendingFloodLayer !== nextLayer || !map.hasLayer(nextLayer)) return false;
          nextLayer.setOpacity(overlayOpacity);
          nextLayer._floodmapperFrame = frameMetadata;
          currentFloodLayer = nextLayer;
          floodFrameState = "ready";
          document.body.dataset.floodFrame = "ready";
          pendingFloodLayer = null;
  
          if (previousLayer && map.hasLayer(previousLayer)) {
            map.removeLayer(previousLayer);
          }
  
          updatePersistentDepthQueryPopup();
  
          if (!mapHasFit && floodLatLngBounds) {
            const townBounds = getBoundaryDrivenOverlayBounds();
            map.fitBounds(townBounds || floodLatLngBounds, { padding: [16, 16] });
            if (document.body.classList.contains("mobile-optimized")) {
              map.setZoom(Math.min(map.getZoom() + 1, map.getMaxZoom()), { animate: false });
            }
            mapHasFit = true;
          }
          markInitialFloodFrameReady();
        });
      } finally {
        releaseRaster?.();
      }
    }

    async function setPhysicsFloodLayer(asset, token, entry = null, phase = "slack") {
      const frameEntry = typeof entry !== "undefined" && entry ? entry : currentSeriesHours[currentHourIndex];
      const frameStage = getStageValue(frameEntry);
      const frameMetadata = { entry: frameEntry, stage: Number.isFinite(frameStage) ? frameStage : (typeof stageValue !== "undefined" ? stageValue : null), phase: typeof phase !== "undefined" ? phase : "slack", dataMode: currentDataMode,
        forecastSource: currentDataMode === "forecast" && forecastData
          ? { petssCycleUtc: forecastData.petssCycleUtc, forecastEndUtc: forecastData.forecastEndUtc } : null };

      toast("");
      ensureMap();
      const overlayUrl = getPhysicsDisplayRecord(asset)?.url;
      const bounds = getActivePhysicsManifest()?.boundsWgs84;
      if (!overlayUrl || !Array.isArray(bounds) || bounds.length !== 2) {
        throw new Error("The selected physics frame is incomplete.");
      }
      const loaded = await preloadImage(overlayUrl, "high");
      if (token !== lastRenderToken) return;
      if (!loaded) {
        return false;
      }
      floodLatLngBounds = L.latLngBounds(bounds[0], bounds[1]);
      floodOverlayGeometryMode = "axis-aligned";

      if (pendingFloodLayer && map.hasLayer(pendingFloodLayer)) {
        map.removeLayer(pendingFloodLayer);
        pendingFloodLayer = null;
      }
      const previousLayer = currentFloodLayer;
      const nextLayer = L.imageOverlay(overlayUrl, floodLatLngBounds, {
        opacity: 0,
        interactive: false,
        crossOrigin: true,
        zIndex: 500,
        pane: "floodPane"
      });
      pendingFloodLayer = nextLayer;
      return await waitForRecoveryFloodLayer(nextLayer, token, async () => {
        if (typeof window !== "undefined" && window.NORTH_WILDWOOD_3D?.prepareFloodFrame &&
            !await window.NORTH_WILDWOOD_3D.prepareFloodFrame(nextLayer, frameMetadata, token)) return false;
        if (token !== lastRenderToken || pendingFloodLayer !== nextLayer || !map.hasLayer(nextLayer)) return false;
        nextLayer.setOpacity(overlayOpacity);
        nextLayer._floodmapperFrame = frameMetadata;
        currentFloodLayer = nextLayer;
        floodFrameState = "ready";
        document.body.dataset.floodFrame = "ready";
        pendingFloodLayer = null;
        renderedFloodPixelCache = null;
        if (previousLayer && map.hasLayer(previousLayer)) map.removeLayer(previousLayer);
        if (!mapHasFit) {
          map.fitBounds(getBoundaryDrivenOverlayBounds() || floodLatLngBounds, { padding: [16, 16] });
          if (document.body.classList.contains("mobile-optimized")) {
            map.setZoom(Math.min(map.getZoom() + 1, map.getMaxZoom()), { animate: false });
          }
          mapHasFit = true;
        }
        markInitialFloodFrameReady();
      });
    }

    async function renderHour(index) {
      cancelTimelineSelection();
      if (!currentSeriesHours.length) return;

      const entry = currentSeriesHours[index];
      if (!entry) return;

      const previousHourIndex = currentHourIndex;
      const requestedSeries = currentSeriesHours;
      const token = ++lastRenderToken;
      requestedTimelineSelection = { series: requestedSeries, index, token };
      // Keep the last displayed frame visible while its replacement loads.
      floodFrameState = "loading";
      setFloodFrameStatus("", "loading");
      document.body.dataset.floodFrame = floodFrameState;

      const rawStage = getStageValue(entry);
      const displayStage = getOverlayStage(rawStage);
      const hydraulicPhase = getHydraulicPhaseForEntry(entry, index, currentSeriesHours);
      const observedDate = entry.isDailyMaximum && currentViewType === "observed-day" &&
        entry.observedDate !== selectedObservedDate ? entry.observedDate : null;
      const observedDay = observedDate ? getObservedDayRecord(observedDate) : null;
      const rawSeries = observedDay ? buildObservedCanonicalSeries(observedDay, observedDate) : currentRawSeriesHours;
      const commitSelection = () => {
        currentHourIndex = index;
        if (observedDay) {
          // The month-wide Daily Max slider can change the selected day.
          // Commit its date and tide context only when this frame is displayed.
          setObservedDaySelection(observedDate, observedDay);
          currentRawSeriesHours = rawSeries;
          renderCalendar().catch(error => toast(error.message));
        }
        renderSelectionMeta(entry, rawStage, displayStage);
        renderTimelineMeta(entry);
      };

      updatePersistentDepthQueryPopup({ useRenderedFlood: false });

      const slider = document.getElementById("hourSlider");
      slider.value = String(index);
      updateSliderProgress();

      if (displayStage == null) {
        commitSelection();
        toast(currentDataMode === "observed" && hasDisplayedLongGaugeOutage(currentSeriesHours)
          ? `Gauge inoperable: more than ${GAUGE_OUTAGE_THRESHOLD_HOURS} consecutive hours are unavailable.`
          : "No observed record for this time.");
        ++lastRenderToken;
        requestedTimelineSelection = null;
        clearFloodLayer();
        setFloodFrameStatus("Water-level data are unavailable for this time.", "error");
        return;
      }

      const initialFramePending = document.body.dataset.initialFloodFrame === "loading";
      const physicsAsset = currentOverlayMode === "depth" ? getPhysicsAssetForEntry(entry) : null;
      const physicsUiWasActive = document.body.classList.contains("physics-forecast-active");
      const physicsUiIsActive = Boolean(physicsAsset);
      const physicsDailyUiWasActive = document.body.classList.contains("physics-daily-maximum-active");
      const physicsDailyUiIsActive = Boolean(physicsAsset && entry?.isDailyMaximum);
      document.body.classList.toggle("physics-forecast-active", physicsUiIsActive);
      document.body.classList.toggle("physics-daily-maximum-active", physicsDailyUiIsActive);
      if (
        physicsUiWasActive !== physicsUiIsActive ||
        physicsDailyUiWasActive !== physicsDailyUiIsActive
      ) renderLegend();
      const note = physicsAsset
        ? (entry?.isDailyMaximum
          ? (currentOverlayMode === "dynamic"
            ? "Modeled flood-impact bands reached during this local day."
            : "Cell-by-cell maximum depth from every 15-minute physics frame in this local day.")
          : (currentOverlayMode === "dynamic"
            ? "Flood-impact bands reached by this exact 15-minute shallow-water simulation."
            : "Exact 15-minute nonlinear shallow-water simulation for this PETSS boundary level."))
        : buildNotes(rawStage, displayStage);
      toast(note);

      const ready = await renderFloodFrameWithRetry(() => physicsAsset
        ? setPhysicsFloodLayer(physicsAsset, token, entry, hydraulicPhase)
        : setFloodLayer(currentOverlayMode, displayStage, hydraulicPhase, token, entry, rawSeries), token);
      if (token !== lastRenderToken || requestedSeries !== currentSeriesHours) return false;
      if (!ready) {
        requestedTimelineSelection = null;
        currentHourIndex = previousHourIndex;
        slider.value = String(previousHourIndex);
        updateSliderProgress();
        document.body.classList.toggle("physics-forecast-active", physicsUiWasActive);
        document.body.classList.toggle("physics-daily-maximum-active", physicsDailyUiWasActive);
        if (physicsUiWasActive !== physicsUiIsActive || physicsDailyUiWasActive !== physicsDailyUiIsActive) renderLegend();
        reportFloodFrameFailure();
        return false;
      }
      requestedTimelineSelection = null;
      commitSelection();
      updateNsiStructureImpactLayer();
      floodFrameState = "ready";
      document.body.dataset.floodFrame = "ready";
      document.body.dataset.floodFrameRecovery = "ready";
      setFloodFrameStatus("", "info");
      if (initialFramePending) scheduleOverlayCatalogWarmup(index);
      else preloadAroundHour(index);
    }

    // Coalesce drag events into one render per animation frame. A final change
    // flushes immediately; any other navigation cancels the queued selection.
    let timelineSelectionFrame = 0;
    let pendingTimelineSelection = null;
    let requestedTimelineSelection = null;
    function getTimelineNavigationIndex() {
      if (pendingTimelineSelection?.series === currentSeriesHours) return pendingTimelineSelection.index;
      if (requestedTimelineSelection?.series === currentSeriesHours) return requestedTimelineSelection.index;
      return currentHourIndex;
    }
    function cancelTimelineSelection() {
      if (timelineSelectionFrame) cancelAnimationFrame(timelineSelectionFrame);
      timelineSelectionFrame = 0;
      pendingTimelineSelection = null;
    }
    function flushTimelineSelection() {
      const pending = pendingTimelineSelection;
      cancelTimelineSelection();
      if (!pending || pending.series !== currentSeriesHours) return;
      if (pending.index === currentHourIndex && floodFrameState === "ready") return;
      renderHour(pending.index).catch(error => toast(error.message));
    }
    function queueTimelineSelection(index, commit = false) {
      const selected = Math.max(0, Math.min(currentSeriesHours.length - 1, Math.round(index)));
      if (!currentSeriesHours.length || !Number.isFinite(selected)) return;
      pendingTimelineSelection = {index: selected, series: currentSeriesHours};
      if (commit) flushTimelineSelection();
      else if (!timelineSelectionFrame) timelineSelectionFrame = requestAnimationFrame(flushTimelineSelection);
    }
    function stepTimeline(direction) {
      stopPlayback();
      const selected = getTimelineNavigationIndex();
      queueTimelineSelection(selected + direction, true);
    }

    let timelineGradientCache = null;
    function updateSliderProgress() {
      const slider = document.getElementById("hourSlider");
      if (!slider) return;
      const min = Number(slider.min) || 0;
      const max = Number(slider.max) || 0;
      const value = Number(slider.value) || 0;
      const percent = max > min ? Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100)) : 0;
      slider.style.setProperty("--timeline-progress", percent.toFixed(3) + "%");
      const key = `${min}:${max}:${currentOverlayMode}`;
      if (timelineGradientCache?.series !== currentSeriesHours || timelineGradientCache.key !== key) {
        const gradient = buildTimelineGroupGradient(min, max, true);
        slider.style.setProperty("--nww-stage-gradient", gradient || "linear-gradient(#94a3b8,#94a3b8)");
        timelineGradientCache = {series: currentSeriesHours, key};
      }
    }

    function isMobileTimeline() {
      return isCompactFloodmapperLayout();
    }

    let timelineBoundsCache = null;
    function getTimelineSliderBounds() {
      const last = Math.max(0, currentSeriesHours.length - 1);
      const selected = Math.max(0, Math.min(currentHourIndex, last));
      let start = 0, end = last;
      // The phone shows one day. Give that day's hours the whole touch track;
      // retain global indices so rendering, playback, and exports stay in sync.
      if (isMobileTimeline() && currentSeriesHours.length) {
        if (timelineBoundsCache?.series === currentSeriesHours && selected >= timelineBoundsCache.start && selected <= timelineBoundsCache.end) {
          ({start, end} = timelineBoundsCache);
        } else {
          start = end = selected;
          while (start > 0 && sameEntryESTDay(currentSeriesHours[start - 1], currentSeriesHours[selected])) start--;
          while (end < last && sameEntryESTDay(currentSeriesHours[end + 1], currentSeriesHours[selected])) end++;
          timelineBoundsCache = {series: currentSeriesHours, start, end};
        }
      }
      return { start, end, selected };
    }

    const timelineScaleTimeFormatter = new Intl.DateTimeFormat("en-US", {timeZone:"America/New_York", hour:"numeric", minute:"2-digit"});
    let timelineScaleCache = null;
    function syncSliderBounds() {
      const slider = document.getElementById("hourSlider");
      if (!slider) return;
      const { start, end, selected } = getTimelineSliderBounds();
      document.getElementById("timelineDock").dataset.singleTimelineTime = String(start === end);
      slider.min = String(start);
      slider.max = String(end);
      slider.value = String(selected);
      if (timelineScaleCache?.series !== currentSeriesHours || timelineScaleCache.start !== start || timelineScaleCache.end !== end) {
        const middle = Math.round((start + end) / 2);
        for (const [id, index] of [["timelineFirstTime", start], ["timelineMiddleTime", middle], ["timelineLastTime", end]]) {
          const label = document.getElementById(id);
          const date = getEntryESTDate(currentSeriesHours[index]);
          if (label) label.textContent = date ? timelineScaleTimeFormatter.format(date).replace(":00", "") : "";
        }
        const midLabel = document.getElementById("timelineMiddleTime");
        if (midLabel) {
          midLabel.style.left = `${end > start ? 100 * (middle - start) / (end - start) : 50}%`;
          midLabel.hidden = end - start < 3;
        }
        timelineScaleCache = {series: currentSeriesHours, start, end};
      }
      const minutes = getTimelineIntervalMinutes();
      const stepLabel = minutes === 1440 ? "1d" : minutes === 60 ? "1h" : `${minutes}m`;
      for (const [id, direction] of [["timelineStepBack", -1], ["timelineStepForward", 1]]) {
        const button = document.getElementById(id);
        if (!button) continue;
        button.disabled = !currentSeriesHours.length || selected + direction < 0 || selected + direction >= currentSeriesHours.length;
        button.textContent = `${direction < 0 ? "−" : "+"}${stepLabel}`;
        const target = currentSeriesHours[selected + direction];
        button.setAttribute("aria-label", `${direction < 0 ? "Previous" : "Next"} time${target ? ": " + formatHourEntryTime(target) : " unavailable"}`);
        button.title = button.getAttribute("aria-label");
      }
      updateSliderProgress();
    }

