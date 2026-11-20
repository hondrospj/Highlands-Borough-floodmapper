    function isWindowsShell() {
      return document.documentElement.classList.contains("os-windows");
    }

    function closeWindowsDatebarMenus(exceptField = null) {
      if (!isWindowsShell()) return;
      document.querySelectorAll(".windows-datebar-field.open").forEach(field => {
        if (field !== exceptField) {
          field.classList.remove("open");
          const btn = field.querySelector(".windows-datebar-button");
          if (btn) btn.setAttribute("aria-expanded", "false");
        }
      });
    }

    function buildWindowsDatebarMenu(kind) {
      const select = document.getElementById(kind === "month" ? "monthSelect" : "yearSelect");
      const field = document.querySelector(`.windows-datebar-field[data-kind="${kind}"]`);
      if (!select || !field) return;

      const button = field.querySelector(".windows-datebar-button");
      const menu = field.querySelector(".windows-datebar-menu");
      if (!button || !menu) return;

      const selectedOption = select.options[select.selectedIndex];
      button.textContent = selectedOption ? selectedOption.textContent : "--";
      button.setAttribute("title", selectedOption ? selectedOption.textContent : "");
      menu.innerHTML = "";

      Array.from(select.options).forEach(option => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "windows-datebar-option";
        item.textContent = option.textContent;
        item.dataset.value = option.value;
        const active = option.value === select.value;
        item.classList.toggle("active", active);
        item.setAttribute("aria-selected", active ? "true" : "false");
        item.addEventListener("click", event => {
          event.preventDefault();
          event.stopPropagation();
          select.value = option.value;
          select.dispatchEvent(new Event("change", { bubbles:true }));
          buildWindowsDatebarMenu(kind);
          closeWindowsDatebarMenus();
        });
        menu.appendChild(item);
      });
    }

    function syncWindowsCalendarDatebar() {
      if (!isWindowsShell()) return;
      buildWindowsDatebarMenu("month");
      buildWindowsDatebarMenu("year");
    }

    function initWindowsCalendarDatebar() {
      if (!isWindowsShell()) return;
      const popover = document.getElementById("calendarPopover");
      const grid = popover?.querySelector(".calendar-popover-grid");
      const monthSelect = document.getElementById("monthSelect");
      const yearSelect = document.getElementById("yearSelect");
      const goBtn = document.getElementById("calendarGoBtn");
      if (!popover || !grid || !monthSelect || !yearSelect || !goBtn || grid.querySelector(".windows-datebar-controls")) return;

      popover.classList.add("windows-datebar");
      monthSelect.closest("label")?.classList.add("native-datebar-field");
      yearSelect.closest("label")?.classList.add("native-datebar-field");

      const controls = document.createElement("div");
      controls.className = "windows-datebar-controls";
      controls.innerHTML = `
        <div class="windows-datebar-field" data-kind="month">
          <span class="windows-datebar-label">Month</span>
          <button class="windows-datebar-button" type="button" aria-haspopup="listbox" aria-expanded="false">--</button>
          <div class="windows-datebar-menu" role="listbox" aria-label="Month"></div>
        </div>
        <div class="windows-datebar-field" data-kind="year">
          <span class="windows-datebar-label">Year</span>
          <button class="windows-datebar-button" type="button" aria-haspopup="listbox" aria-expanded="false">--</button>
          <div class="windows-datebar-menu" role="listbox" aria-label="Year"></div>
        </div>
      `;
      grid.insertBefore(controls, goBtn);

      controls.querySelectorAll(".windows-datebar-button").forEach(button => {
        button.addEventListener("click", event => {
          event.preventDefault();
          event.stopPropagation();
          const field = button.closest(".windows-datebar-field");
          const willOpen = !field.classList.contains("open");
          closeWindowsDatebarMenus(field);
          field.classList.toggle("open", willOpen);
          button.setAttribute("aria-expanded", willOpen ? "true" : "false");
        });
      });

      [monthSelect, yearSelect].forEach(select => {
        select.addEventListener("change", syncWindowsCalendarDatebar);
      });

      document.addEventListener("click", event => {
        if (!popover.contains(event.target)) closeWindowsDatebarMenus();
      });

      document.addEventListener("keydown", event => {
        if (event.key === "Escape") closeWindowsDatebarMenus();
      });

      syncWindowsCalendarDatebar();
    }

    function setObservedCalendarOpen(open) {
      const modal = document.getElementById("observedCalendarModal");
      const trigger = document.getElementById("observedCalendarOpenBtn");
      if (!modal) return;
      // The full calendar is outside the control rail, so opening it cannot
      // move the datum, overlay, interval, or legend below the timeline.
      if (modal.parentElement !== document.body) document.body.appendChild(modal);
      if (!open && modal.hidden) return;
      if (open && isCompactFloodmapperLayout()) setMobileControlsOpen(false);
      if (!open) setCalendarPopoverOpen(false);
      modal.hidden = !open;
      trigger?.setAttribute("aria-expanded", String(open));
      if (open) document.getElementById("observedCalendarCloseBtn")?.focus({ preventScroll: true });
      else if (isCompactFloodmapperLayout()) requestAnimationFrame(() => {
        // Wait for the modal focus controller to release background isolation.
        if (modal.hidden) document.getElementById("mobileControlsToggle")?.focus({ preventScroll: true });
      });
    }

    function ensureCalendarPopoverIsBodyChild() {
      const popover = document.getElementById("calendarPopover");
      if (popover && popover.parentElement !== document.body) {
        document.body.appendChild(popover);
      }
      const grid = popover?.querySelector(".calendar-popover-grid");
      const close = document.getElementById("calendarPopoverCloseBtn");
      if (grid && close && close.parentElement !== grid) grid.prepend(close);
      if (grid) {
        grid.setAttribute("role", "dialog");
        grid.setAttribute("aria-modal", "true");
        grid.setAttribute("aria-label", "Choose month");
      }
      return popover;
    }

    function setCalendarPopoverOpen(open, opener = null) {
      const popover = ensureCalendarPopoverIsBodyChild();
      if (!popover) return;
      if (open) populateCalendarSelectors();
      popover.classList.toggle("open", !!open);
      popover.setAttribute("aria-hidden", open ? "false" : "true");

      if (open) {
        popover.style.setProperty("position", "fixed", "important");
        popover.style.setProperty("top", "50%", "important");
        popover.style.setProperty("left", "50%", "important");
        popover.style.setProperty("right", "auto", "important");
        popover.style.setProperty("bottom", "auto", "important");
        popover.style.setProperty("transform", "translate(-50%, -50%)", "important");
        popover.style.setProperty("z-index", "12000", "important");
        if (opener) document.dispatchEvent(new CustomEvent("nww:modalchange", { detail: { opener } }));
        document.getElementById("calendarPopoverCloseBtn")?.focus({ preventScroll: true });
      }

      document.body.classList.remove("calendar-picker-open");
      if (!open) closeWindowsDatebarMenus();
      requestAnimationFrame(syncLeftPanelLayout);
      setTimeout(syncLeftPanelLayout, 80);
    }

function populateCalendarSelectors() {
      const monthSelect = document.getElementById("monthSelect");
      const yearSelect = document.getElementById("yearSelect");

      const years = Array.from(new Set(observedMonthKeys.map(key => key.slice(0, 4)))).sort();
      monthSelect.innerHTML = MONTH_NAMES.map((name, i) => `<option value="${i + 1}">${name}</option>`).join("");
      yearSelect.innerHTML = years.map(year => `<option value="${year}">${year}</option>`).join("");

      if (currentMonthKey) {
        const [y, m] = currentMonthKey.split("-");
        monthSelect.value = String(Number(m));
        yearSelect.value = y;
      }
      syncWindowsCalendarDatebar();
    }

    async function renderCalendar() {
      if (!observedData || !currentMonthKey) return;
      const monthLabel = document.getElementById("monthLabel");
      const monthText = prettyMonthShort(currentMonthKey);
      if (monthLabel.textContent !== monthText) monthLabel.textContent = monthText;

      const grid = document.getElementById("calendarGrid");
      grid.innerHTML = "";

      const [year, monthNum] = currentMonthKey.split("-").map(Number);
      const first = new Date(Date.UTC(year, monthNum - 1, 1));
      const lastDay = new Date(Date.UTC(year, monthNum, 0)).getUTCDate();
      const firstWeekday = first.getUTCDay();
      const monthDays = getObservedDaysForMonth(currentMonthKey);
      const daysByDate = new Map(monthDays.map(day => [day.date, day]));

      for (let i = 0; i < firstWeekday; i++) {
        const blank = document.createElement("div");
        blank.className = "calendar-day empty";
        grid.appendChild(blank);
      }

      for (let day = 1; day <= lastDay; day++) {
        const dateStr = `${year}-${pad2(monthNum)}-${pad2(day)}`;
        const meta = daysByDate.get(dateStr);
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "calendar-day";
        btn.textContent = String(day);

        if (!meta) {
          btn.classList.add("day-none");
          btn.disabled = true;
          grid.appendChild(btn);
          continue;
        }

        const derivedClass = classifyFloodEntries(Array.isArray(meta.hours) ? meta.hours : []);
        const storedClass = String(meta.classification || "none").toLowerCase();
        const cls = ["minor", "moderate", "major"].includes(storedClass) ? storedClass : derivedClass;
        btn.classList.add(`day-${cls}`);
        if (selectedObservedDate === dateStr && currentViewType !== "top-tide") btn.classList.add("selected");
        btn.title = `${formatSelectedObservedDate(dateStr)} • ${cls}`;
        btn.addEventListener("click", () => {
          setObservedCalendarOpen(false);
          loadObservedDay(dateStr).catch(err => toast(err.message));
        });

        grid.appendChild(btn);
      }

      const monthIndex = observedMonthKeys.indexOf(currentMonthKey);
      document.getElementById("prevMonthBtn").disabled = monthIndex <= 0;
      document.getElementById("nextMonthBtn").disabled = monthIndex === -1 || monthIndex >= observedMonthKeys.length - 1;
      updateDayNav();
      populateCalendarSelectors();
      syncLeftPanelLayout();
    }

    function setObservedDaySelection(dateStr, dayRecord) {
      selectedObservedDate = dateStr;
      currentMonthKey = dateStr.slice(0, 7);
      const rankedEvent = topTideEvents.find(event => event?.dateKey === dateStr);
      currentSelectedLabel = dateStr;
      if (rankedEvent) {
        currentSelectedSubLabel = `${formatStageForDisplay(rankedEvent.peakStage)} peak`;
      } else if (dayRecord?.peakNAVD88 != null) {
        currentSelectedSubLabel = `${formatStageForDisplay(normalizeStageValue(dayRecord.peakNAVD88))} peak`;
      } else {
        const derived = classifyFloodEntries(dayRecord?.hours || []);
        currentSelectedSubLabel = derived === "none" ? "Observed" : derived.charAt(0).toUpperCase() + derived.slice(1);
      }
      currentRangeLabel = dateStr;
    }

    async function loadObservedDay(dateStr, preferredHourIndex = null, preferredEntry = null, options = {}) {
      cancelPendingFloodFrame();
      const generation = ++selectionGeneration;
      loadObservedDay.pendingSelection = { generation, dateStr };
      try {
      let archiveAvailable = true;
      try {
        await ensureObservedArchiveForDate(dateStr);
      } catch {
        archiveAvailable = false;
      }
      if (generation !== selectionGeneration) return false;
      const dayRecord = archiveAvailable ? getObservedDayRecord(dateStr) : null;
      if (!dayRecord) {
        currentDataMode = "observed";
        currentRawSeriesHours = [];
        currentSeriesHours = [];
        currentHourIndex = 0;
        currentViewType = "observed-day";
        currentTopTideIndex = null;
        currentSelectedLabel = "Observed";
        currentSelectedSubLabel = "";
        currentRangeLabel = "";
        updateDataModeButtons();
        syncSliderBounds();
        document.getElementById("hourSlider").value = "0";
        clearFloodLayer();
        renderSelectionMeta(null, null, null);
        document.getElementById("stageSubText").textContent = "Observed data could not load";
        renderTimelineMeta();
        if (typeof reportFloodFrameFailure === "function") reportFloodFrameFailure();
        const message = "Observed data could not load. Try another selection or reload.";
        if (typeof setFloodFrameStatus === "function") setFloodFrameStatus(message, "error");
        toast(message);
        return false;
      }

      const preservePlayback = Boolean(options && options.preservePlayback);
      if (!preservePlayback) stopPlayback();
      currentDataMode = "observed";
      updateDataModeButtons();

      // Once data is committed, an interval change must rebuild this series
      // rather than only updating the cadence of a still-pending request.
      if (loadObservedDay.pendingSelection?.generation === generation) loadObservedDay.pendingSelection = null;
      topTideEvents = buildTopTideEvents();
      setObservedDaySelection(dateStr, dayRecord);
      currentRawSeriesHours = buildObservedCanonicalSeries(dayRecord, dateStr);
      currentSeriesHours = getTimelineIntervalMinutes() === 1440
        ? buildObservedDailyMaximumSeries(dateStr.slice(0, 7))
        : sampleCanonicalHydraulicSeries(currentRawSeriesHours, getTimelineIntervalMinutes());
      currentViewType = "observed-day";
      currentTopTideIndex = null;

      syncSliderBounds();
      if (preferredEntry) {
        currentHourIndex = findClosestMeasuredEntryIndex(currentSeriesHours, preferredEntry);
      } else if (getTimelineIntervalMinutes() === 1440) {
        const selectedDayIndex = currentSeriesHours.findIndex(entry => entry?.observedDate === dateStr);
        currentHourIndex = selectedDayIndex >= 0 ? selectedDayIndex : getPeakHourIndex(currentSeriesHours);
      } else if (options.dayStep) {
        currentHourIndex = options.dayStep < 0 ? Math.max(0, currentSeriesHours.length - 1) : 0;
      } else if (preferredHourIndex != null) {
        currentHourIndex = Math.max(0, Math.min(preferredHourIndex, Math.max(0, currentSeriesHours.length - 1)));
      } else {
        currentHourIndex = getPeakHourIndex(currentSeriesHours);
      }
      document.getElementById("hourSlider").value = String(currentHourIndex);

      await renderCalendar();
      if (generation !== selectionGeneration) return false;
      const rendered = await renderHour(currentHourIndex);
      if (rendered === false || generation !== selectionGeneration) return false;
      renderTopTides();
      } finally {
        if (loadObservedDay.pendingSelection?.generation === generation) loadObservedDay.pendingSelection = null;
      }
    }

    async function loadTopTideEvent(index, preferredEntry = null) {
      const generation = ++selectionGeneration;
      if (!topTideEvents[index]) throw new Error("Top 10 flood crest not available.");
      stopPlayback();
      let floodSelectionToken = cancelPendingFloodFrame();
      // A click on the currently active data mode still cancels this pending
      // historical selection. Only this request may clear its owner stamp.
      loadTopTideEvent.pendingSelectionGeneration = generation;
      const requestedEvent = topTideEvents[index];
      const requestedDate = requestedEvent.dateKey || requestedEvent.entry?.observedDate || null;

      try {
      if (!observedData) await warmBackgroundData();
      if (generation !== selectionGeneration) return false;
      let event = topTideEvents.find(candidate => candidate?.dateKey === requestedDate) || requestedEvent;
      if (requestedDate) {
        const archiveSource = getObservedArchiveSourceForDate(requestedDate);
        // Finish the compact Lewes day index before loading a pre-Stone Harbor
        // record. Otherwise its idle refresh can replace the event catalog
        // after this click has already captured the crest-only placeholder,
        // leaving the first replay stuck at "Maximum extent" until the user
        // changes the timeline interval.
        if (archiveSource === "lewes") await ensureLewesArchiveIndex();
        if (generation !== selectionGeneration) return false;
        const crestStage = getOverlayStage(event.peakStage);
        // Flood Stages uses the same resolved depth raster for uncertainty.
        const crestAssetPromise = crestStage == null
          ? Promise.resolve(null)
          : getOverlayRecord("depth", crestStage, "slack")
              .then(record => record?.url ? preloadImage(record.url, "high") : null)
              .catch(() => null);
        await Promise.all([
          ensureObservedArchiveForDate(requestedDate),
          crestAssetPromise,
        ]);
        if (generation !== selectionGeneration) return false;
        topTideEvents = buildTopTideEvents();
        event = topTideEvents.find(candidate => candidate?.dateKey === requestedDate) || event;
      }
      currentBaseModeBeforeTopTide = currentDataMode;
      currentDataMode = "observed";
      updateDataModeButtons();
      // Overlay/cadence changes belonged to this data request while it loaded.
      // Once its series commits, later controls rebuild that historical series.
      if (loadTopTideEvent.pendingSelectionGeneration === generation) {
        loadTopTideEvent.pendingSelectionGeneration = null;
      }
      floodSelectionToken = lastRenderToken;
      currentViewType = "top-tide";
      currentTopTideIndex = Math.max(0, topTideEvents.indexOf(event));
      currentSelectedLabel = `Flood #${event.rank}`;
      currentSelectedSubLabel = formatStageForDisplay(event.peakStage);
      currentRangeLabel = `${event.title}`;
      selectedObservedDate = event.dateKey || event.entry.observedDate || null;
      if (selectedObservedDate) currentMonthKey = selectedObservedDate.slice(0, 7);

      const eventSeries = (event.series && event.series.length ? event.series : [event.entry]);
      const eventCanonicalSeries = event.canonicalSeries && event.canonicalSeries.length
        ? event.canonicalSeries
        : eventSeries;
      const isCrestOnly = event.sourceType === "historical" || eventCanonicalSeries.length <= 1;
      currentRawSeriesHours = eventCanonicalSeries.map((entry, idx) => ({
        ...entry,
        topTideHourIndex: idx,
        topTideDateOnly: isCrestOnly,
        topTideDisplayDate: event.title,
        observationInterval: isCrestOnly ? "crest" : (entry.observationInterval || "1hour"),
        isHistoricalTopTide: isCrestOnly && Boolean(entry.isHistoricalTopTide || event.sourceType === "historical")
      }));
      if (isCrestOnly) {
        currentSeriesHours = currentRawSeriesHours.slice(0, 1);
      } else if (getTimelineIntervalMinutes() === 1440) {
        currentSeriesHours = [{
          ...currentRawSeriesHours[getPeakHourIndex(currentRawSeriesHours)],
          observationInterval: "daily",
          timelineIntervalMinutes: 1440,
          isDailyMaximum: true
        }];
      } else {
        currentSeriesHours = sampleCanonicalHydraulicSeries(
          currentRawSeriesHours,
          getTimelineIntervalMinutes()
        ).map((entry, idx) => ({ ...entry, topTideHourIndex: idx }));
      }

      syncSliderBounds();
      currentHourIndex = isCrestOnly
        ? 0
        : preferredEntry
          ? findClosestMeasuredEntryIndex(currentSeriesHours, preferredEntry)
          : getPeakHourIndex(currentSeriesHours);
      document.getElementById("hourSlider").value = String(currentHourIndex);

      await renderCalendar();
      if (floodSelectionToken !== lastRenderToken || generation !== selectionGeneration) return false;
      const rendering = renderHour(currentHourIndex);
      // renderHour creates its own render token synchronously.
      floodSelectionToken = lastRenderToken;
      await rendering;
      if (floodSelectionToken !== lastRenderToken || generation !== selectionGeneration) return false;
      renderTopTides();
      scheduleHistoricalTopTideWarmup();
      } catch (error) {
        if (generation !== selectionGeneration) return false;
        if (loadTopTideEvent.pendingSelectionGeneration !== generation && floodSelectionToken !== lastRenderToken) return false;
        throw error;
      } finally {
        if (loadTopTideEvent.pendingSelectionGeneration === generation) {
          loadTopTideEvent.pendingSelectionGeneration = null;
        }
      }
    }

    async function setTimelineIntervalMinutes(minutes) {
      const requested = Number(minutes);
      const nextMinutes = requested === 15 || requested === 1440 ? requested : 60;
      const previousMinutes = getTimelineIntervalMinutes();
      if (nextMinutes === previousMinutes) return;

      // Interval choices belong to a pending data selection. They must not
      // cancel its request or preserve a timestamp from the previous mode.
      const observedSelectionPending = currentDataMode === "observed" && (
        loadObservedDay.pendingSelection?.generation === selectionGeneration ||
        switchDataMode.pendingObservedSelectionGeneration === selectionGeneration
      );
      const modeledSelectionPending = currentDataMode === "return-interval" &&
        loadReturnInterval.pendingSelection?.generation === selectionGeneration;
      const topTideSelectionPending = loadTopTideEvent.pendingSelectionGeneration === selectionGeneration;
      const forecastSelectionPending = currentDataMode === "forecast" && loadForecast.pendingSelectionGeneration === selectionGeneration;
      if (observedSelectionPending || modeledSelectionPending || topTideSelectionPending || forecastSelectionPending) {
        stopPlayback();
        toast("");
        currentTimelineIntervalMinutes = nextMinutes;
        updateTimelineIntervalUI();
        overlayPreloadGeneration += 1;
        return;
      }
      const referenceEntry = currentSeriesHours[getTimelineNavigationIndex()] || null;
      const observedDate = referenceEntry?.observedDate || selectedObservedDate;
      const generation = ++selectionGeneration;
      const floodSelectionToken = cancelPendingFloodFrame();
      stopPlayback();
      toast("");
      currentTimelineIntervalMinutes = nextMinutes;
      updateTimelineIntervalUI();
      overlayPreloadGeneration += 1;

      if (currentDataMode === "observed" && nextMinutes !== 60) {
        try {
          if (observedDate) await ensureObservedArchiveForDate(observedDate);
        } catch (error) {
          if (generation !== selectionGeneration || floodSelectionToken !== lastRenderToken) return false;
          currentTimelineIntervalMinutes = previousMinutes;
          updateTimelineIntervalUI();
          floodFrameState = currentFloodLayer ? "ready" : "failed";
          document.body.dataset.floodFrame = floodFrameState;
          const message = "Observed detail could not load. Previous interval shown. Select an interval to retry.";
          setFloodFrameStatus(message, "error");
          toast(message);
          return false;
        }
      }
      if (generation !== selectionGeneration || floodSelectionToken !== lastRenderToken) return false;

      if (currentViewType === "return-interval" || currentDataMode === "return-interval") {
        currentDataMode = "return-interval";
        currentViewType = "return-interval";
        updateDataModeButtons();
        const loaded = await loadReturnInterval(referenceEntry, { generation });
        if (generation !== selectionGeneration || loaded === false) return false;
        await renderHour(currentHourIndex);
        return;
      }

      if (currentViewType === "forecast" || currentDataMode === "forecast") {
        currentDataMode = "forecast";
        currentViewType = "forecast";
        updateDataModeButtons();
        await loadForecast(referenceEntry, { generation });
        if (generation !== selectionGeneration || floodSelectionToken !== lastRenderToken) return false;
        renderTopTides();
        await renderHour(currentHourIndex);
        return;
      }

      if (currentViewType === "observed-day" && observedDate) {
        await loadObservedDay(observedDate, null, referenceEntry);
        return;
      }

      if (currentViewType === "top-tide" && currentTopTideIndex != null) {
        topTideEvents = buildTopTideEvents();
        const nextIndex = Math.min(currentTopTideIndex, Math.max(0, topTideEvents.length - 1));
        if (topTideEvents[nextIndex]) {
          await loadTopTideEvent(nextIndex, referenceEntry);
        }
        return;
      }

      refreshCurrentDisplayText();
    }

    async function switchOverlayMode(mode) {
      if (mode === currentOverlayMode) return;

      const index = getTimelineNavigationIndex();
      stopPlayback();
      const forecastSelectionPending = currentDataMode === "forecast" &&
        loadForecast.pendingSelectionGeneration === selectionGeneration;
      if (!forecastSelectionPending) cancelPendingFloodFrame();
      toast("");
      currentOverlayMode = mode;
      updateModeButtons();

      if (forecastSelectionPending || loadTopTideEvent.pendingSelectionGeneration === selectionGeneration) return;
      if (currentDataMode === "return-interval" && loadReturnInterval.pendingSelection?.generation === selectionGeneration) {
        setFloodFrameStatus(currentFloodLayer
          ? ""
          : "", "info");
        return;
      }
      await renderHour(index);
    }

    async function switchDataMode(mode) {
      let modeFailureToken = lastRenderToken;
      let modeFailureGeneration = null;
      let modeFailureRequest = null;
      try {
      if (mode === currentDataMode &&
          ((mode === "forecast" && loadForecast.pendingSelectionGeneration === selectionGeneration) ||
           (mode === "return-interval" && loadReturnInterval.pendingSelection?.generation === selectionGeneration))) return;
      const retryStale = mode === "forecast" && Boolean(getForecastFreshness(getForecastSourceForNotice()).state);
      const replayEntry = retryStale && currentViewType === "forecast" ? currentSeriesHours[currentHourIndex] : null;
      if (!retryStale && mode === currentDataMode && currentViewType !== "top-tide" && currentSeriesHours.length
          && loadTopTideEvent.pendingSelectionGeneration !== selectionGeneration) return;
      const generation = ++selectionGeneration;
      modeFailureGeneration = generation;
      ++lastRenderToken;
      cancelPendingFloodFrame(false);
      stopPlayback();
      const floodSelectionToken = cancelPendingFloodFrame();
      modeFailureToken = floodSelectionToken;
      toast("");

      if (mode === "forecast") {
        currentDataMode = "forecast";
        updateDataModeButtons();
        await loadForecast(replayEntry, { generation, forceRefresh: retryStale, retryStale, selectCurrent: retryStale });
      if (floodSelectionToken !== lastRenderToken) return false;
        if (generation !== selectionGeneration) return;
        renderTopTides();
        await renderHour(currentHourIndex);
        return;
      }

      if (mode === "return-interval") {
        currentDataMode = "return-interval";
        currentViewType = "return-interval";
        updateDataModeButtons();
        cancelPendingFloodFrame(false);
        const loaded = await loadReturnInterval(null, { generation });
        if (generation !== selectionGeneration || loaded === false) return false;
        renderTopTides();
        await renderHour(currentHourIndex);
        return;
      }

      currentDataMode = "observed";
      switchDataMode.pendingObservedSelectionGeneration = generation;
      updateDataModeButtons();
      const preferredObservedDate = currentViewType === "top-tide" ? null : selectedObservedDate;
      // The old image may remain visible while loading, but its forecast
      // timeline and labels must not be presented as observations.
      currentViewType = "observed-day";
      currentTopTideIndex = null;
      currentRawSeriesHours = [];
      currentSeriesHours = [];
      currentHourIndex = 0;
      currentSelectedLabel = "Observed";
      currentSelectedSubLabel = "";
      currentRangeLabel = "";
      syncSliderBounds();
      document.getElementById("hourSlider").value = "0";
      renderSelectionMeta(null, null, null);
      document.getElementById("stageSubText").textContent = "";
      renderTimelineMeta();
      renderTimelineDays();
      const loadingMessage = currentFloodLayer
        ? ""
        : "";
      setFloodFrameStatus(loadingMessage, "info");
      await warmBackgroundData();
      if (generation !== selectionGeneration) return;
      await renderCalendar();
      if (generation !== selectionGeneration) return;

      const defaultDate = preferredObservedDate || getLatestObservedDate();
      if (defaultDate) {
        await loadObservedDay(defaultDate);
        scheduleHistoricalTopTideWarmup();
      } else {
        throw new Error("No observed dates were found in observed.json.");
      }
      } catch (error) {
        if ((mode !== "observed" && modeFailureToken !== lastRenderToken) || currentDataMode !== mode) return false;
        if (modeFailureGeneration !== null && modeFailureGeneration !== selectionGeneration) return false;
        const failedMode = mode;
        const failedLabel = failedMode === "forecast" ? "Forecast" : failedMode === "return-interval" ? "Modeled flood" : "Observed";
        currentDataMode = failedMode;
        currentRawSeriesHours = [];
        currentSeriesHours = [];
        currentHourIndex = 0;
        currentViewType = failedMode === "observed" ? "observed-day" : failedMode;
        currentTopTideIndex = null;
        currentSelectedLabel = failedMode === "forecast" ? getForecastScenarioLabel() : failedLabel;
        currentSelectedSubLabel = "";
        currentRangeLabel = "";
        updateDataModeButtons();
        syncSliderBounds();
        document.getElementById("hourSlider").value = "0";
        clearFloodLayer();
        renderSelectionMeta(null, null, null);
        document.getElementById("stageSubText").textContent = `${failedLabel} data could not load`;
        renderTimelineMeta();
        if (typeof reportFloodFrameFailure === "function") reportFloodFrameFailure();
        const message = `${failedLabel} data could not load. Try another selection or reload.`;
        if (typeof setFloodFrameStatus === "function") setFloodFrameStatus(message, "error");
        toast(message);
        return false;
      } finally {
        if (switchDataMode.pendingObservedSelectionGeneration === modeFailureGeneration) {
          switchDataMode.pendingObservedSelectionGeneration = null;
        }
      }
    }

