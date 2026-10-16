/* Highlands feature parity with the Highlands UI. Local data and flood engine remain authoritative. */
let buildingsLayer = null;
let parcelsLayer = null;
let nsiStructuresLayer = null;
let parcelFeatures = [];
let nsiStructureFeatures = [];
let houseAlertCdfData = null;
let houseAlertCdfPromise = null;
let parcelLoadPromise = null;
let nsiStructureLoadPromise = null;
let parcelLayerGeneration = 0;
let nsiLayerGeneration = 0;
let nsiStructureRenderer = null;
let persistentFloodPopup = null;
let persistentDepthQueryContext = null;
let selectedParcelFeature = null;
let mapClickMode = "building";
let exportBuildingsLayer = null;
let exportParcelsLayer = null;
let returnIntervalData = null;
let currentReturnIntervalYears = 10;
const RETURN_INTERVAL_OPTIONS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
let selectionGeneration = 0;
const FLOOD_PROJECTION_SCENARIOS = {
      observedTrend: { label: "Existing trend", color: "#e2e8f0" },
      low: { label: "NOAA Low", color: "#2dd4bf" },
      intermediateLow: { label: "NOAA Int. Low", color: "#38bdf8" },
      intermediate: { label: "NOAA Intermediate", color: "#facc15" },
      intermediateHigh: { label: "NOAA Int. High", color: "#fb923c" },
      high: { label: "NOAA High", color: "#fb7185" }
    };
let selectedFloodProjectionScenario = "intermediate";
const MAPPER_TUTORIAL_STEPS = [
      {
        title: "Welcome to the Floodmapper",
        target: "#mapTitleBadge",
        body: "<p>This map turns water levels into a street-level picture of potential flooding. You can explore the next several days, replay measured events, click the map for modeled depth, inspect parcels, and export what you see.</p><p><strong>Every mapped depth is referenced to the selected water level and the ground-elevation model.</strong></p>"
      },
      {
        title: "Start with the forecast",
        target: ".data-source-card",
        body: "<p>Select <strong>Forecast</strong> to explore the forecast water levels and mapped flooding.</p><p>The map and timeline update together, so the selected hour is always the water level being mapped.</p>"
      },
      {
        title: "Switch to observations",
        target: ".data-source-card",
        body: "<p>Select <strong>Observed</strong> to explore the tide-gauge archive. Use <strong>Interval</strong> in the left pane to switch among Hourly, 15-Min, and Daily Max views.</p>"
      },
      {
        title: "Choose a historic flood",
        target: "#calendarCard",
        body: "<p>The calendar is your archive. Colored dates mark flood thresholds; choose a day or type a date to replay it. Crest-only records show the maximum extent when a full time series was not preserved.</p>"
      },
      {
        title: "Move through time",
        target: "#timelineDock",
        body: "<p>Drag the slider to move the map through time, or press Play to animate it. The selected date, time, water level, and mapped depth always stay synchronized.</p>"
      },
      {
        title: "Control map layers",
        target: ".layers-card",
        body: "<p>Turn the simulation boundary, road labels, or <strong>Parcels</strong> on and off. Click a parcel to see how many times that structure has flooded in the historic record.</p>"
      },
      {
        title: "Jump to the largest floods",
        target: ".mobile-top-tides-card, .top-tides-card",
        body: "<p>The Top 10 list is the fastest way to inspect the archive's highest crests. Select an event to move the calendar, timeline, water-level readout, and inundation map to that flood.</p>"
      },
      {
        title: "Export and share",
        target: "#downloadCard",
        body: "<p>Open the export panel to save a single PNG, a PNG sequence, or an animated GIF. Set the time range, frame interval, layout, speed, and labels before export.</p><p>Exports preserve the map, timestamp, datum, depth key, and branding so the result can stand on its own.</p>"
      }
    ];
let mapperTutorialIndex = 0;
let mapperTutorialResizeHandler = null;
const EXPORT_INTERVALS = {
      hourly: { value: "hourly", label: "Hourly", minutes: 60, frameLimit: EXPORT_RANGE_MAX_HOURS + 1 },
      "15min": { value: "15min", label: "15-Minute", minutes: 15, frameLimit: (EXPORT_RANGE_MAX_HOURS * 4) + 1 },
      daily: { value: "daily", label: "Daily Maximum", minutes: 1440, frameLimit: 5 }
    };
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
function buildReturnIntervalDisplaySeries(entries = currentRawSeriesHours) {
      const source = annotateHydraulicSeries(Array.isArray(entries) ? entries : []);
      if (getTimelineIntervalMinutes() === 1440) {
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
      if (!returnIntervalData || options.forceRefresh) {
        const payload = await fetchJson(withFreshJsonUrl(RETURN_INTERVALS_URL));
        if (generation !== selectionGeneration) return;
        returnIntervalData = payload;
      }
      const record = getReturnIntervalRecord();
      if (!record || !Array.isArray(record.series15min) || !record.series15min.length) {
        throw new Error(`${getReturnIntervalLabel()} synthetic storm is unavailable.`);
      }

      clearExportAvailabilityCache();
      currentRawSeriesHours = annotateHydraulicSeries(record.series15min);
      currentSeriesHours = buildReturnIntervalDisplaySeries(currentRawSeriesHours);
      currentDataMode = "return-interval";
      currentViewType = "return-interval";
      currentTopTideIndex = null;
      currentSelectedLabel = `${getReturnIntervalLabel()} Flood`;
      const targetNavd88Ft = Number(record.targetNavd88Ft ?? record.weightedNavd88Ft ?? record.naccsNavd88Ft);
      if (!Number.isFinite(targetNavd88Ft)) {
        throw new Error(`${getReturnIntervalLabel()} target water level is unavailable.`);
      }
      currentSelectedSubLabel = `${targetNavd88Ft.toFixed(2)} ft NAVD88`;
      currentRangeLabel = `${returnIntervalData.windowHours || 84}-hour sample storm`;

      syncSliderBounds();
      currentHourIndex = preferredEntry
        ? findClosestEntryIndex(currentSeriesHours, preferredEntry)
        : getPeakHourIndex(currentSeriesHours);
      document.getElementById("hourSlider").value = String(currentHourIndex);
      updateReturnIntervalButtons();
    }
async function switchReturnInterval(years) {
      const requested = Number(years);
      if (!RETURN_INTERVAL_OPTIONS.includes(requested)) return;
      if (requested === currentReturnIntervalYears && currentDataMode === "return-interval") return;
      stopPlayback();
      toast("");
      currentReturnIntervalYears = requested;
      currentDataMode = "return-interval";
      currentViewType = "return-interval";
      updateDataModeButtons();
      clearFloodLayer();
      await loadReturnInterval();
      await renderHour(currentHourIndex);
    }
function formatExpectedFloodCount(value) {
      const n = Number(value);
      if (!Number.isFinite(n)) return "—";
      if (n > 0 && n < 1) return "<1";
      return n >= 100 ? Math.round(n).toLocaleString() : n.toFixed(n < 10 ? 1 : 0);
    }
function formatFloodIntervalValue(value) {
      const n = Number(value);
      if (!Number.isFinite(n)) return "—";
      if (n <= 0) return "0";
      if (n < 0.1) return "<0.1";
      if (n < 10) return n.toFixed(1);
      return n >= 100 ? Math.round(n).toLocaleString() : Math.round(n).toString();
    }
function openPersistentFloodPopup(latlng, html, maxWidth = 360) {
      if (!map) ensureMap();
      persistentDepthQueryContext = null;
      if (persistentFloodPopup && map.hasLayer(persistentFloodPopup)) {
        map.removeLayer(persistentFloodPopup);
      }
      const mobilePopup = isCompactFloodmapperLayout();
      const compactLandscapePopup = mobilePopup && window.innerHeight <= 560 && window.innerWidth > window.innerHeight;
      const desktopRightRailWidth = mobilePopup
        ? 0
        : Math.ceil(document.getElementById("rightRail")?.getBoundingClientRect().width || 0);
      const isHouseAlertPopup = String(html).includes("house-alert-popup");
      const isDepthQueryPopup = String(html).includes("depth-query-popup");
      const requestedPopupWidth = compactLandscapePopup && isHouseAlertPopup ? 520 : maxWidth;
      const viewportPopupWidth = mobilePopup
        ? Math.max(240, Math.min(requestedPopupWidth, window.innerWidth - 28))
        : requestedPopupWidth;
      const popup = L.popup({
        className: isDepthQueryPopup ? "shorely-flood-popup shorely-depth-popup" : "shorely-flood-popup",
        maxWidth: viewportPopupWidth,
        minWidth: 0,
        autoClose: false,
        closeOnClick: false,
        closeButton: true,
        keepInView: !document.body.classList.contains("map-3d-ready"),
        autoPan: !document.body.classList.contains("map-3d-ready"),
        autoPanPaddingTopLeft: mobilePopup ? L.point(10, 126) : L.point(16, 16),
        autoPanPaddingBottomRight: mobilePopup
          ? L.point(10, Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--shorely-mobile-timeline-height")) + 16 || 140)
          : L.point(desktopRightRailWidth + 30, 16)
      })
        .setLatLng(latlng)
        .setContent(html)
        .addTo(map);
      persistentFloodPopup = popup;
      document.body.classList.add("persistent-flood-popup-open");
      popup.once("remove", () => {
        if (persistentFloodPopup === popup) {
          persistentFloodPopup = null;
          persistentDepthQueryContext = null;
          document.body.classList.remove("persistent-flood-popup-open");
        }
      });
      return popup;
    }
function buildHouseAlertPopup(feature) {
      const p = feature?.properties || {};
      const firstFloor = getNsiFirstOccupiedFloorNavd88(p);
      const crawlspaceDepth = Number(p.foundationHeightFt ?? p.nsi2026FoundationHeightFt);
      const stage = getSelectedStageNavd88();
      const difference = Number.isFinite(stage) && Number.isFinite(firstFloor) ? stage - firstFloor : null;
      const address = escapeTownAddressHtml(p.address || "Selected Highlands parcel");
      const waterStatus = difference == null
        ? "No modeled occupied floor is available for this parcel."
        : Math.abs(difference) <= 0.1
          ? "Selected gauge level is at the estimated occupied floor."
          : difference > 0
            ? `Selected gauge level is ${formatWaterDepth(difference, 1)} above the estimated occupied floor. This is a screening comparison, not a surveyed flood depth.`
            : `Selected gauge level is ${formatWaterDepth(Math.abs(difference), 1)} below the estimated occupied floor.`;
      return '<div class="house-alert-popup building-info-card">' +
        '<span class="house-alert-kicker">Building</span>' +
        '<h3>' + address + '</h3>' +
        '<div class="building-info-facts">' +
          '<div><span>Modeled foundation height</span><strong>' +
            (Number.isFinite(crawlspaceDepth) ? formatWaterDepth(crawlspaceDepth, 1) : 'Not available') +
          '</strong></div>' +
          '<p>' + escapeTownAddressHtml(waterStatus) + '</p>' +
        '</div>' +
        '<button class="house-alert-cta" type="button">See Flood History &amp; Projections</button>' +
        '</div>';
    }
function openParcelFloodPrompt(feature, latlng) {
      selectedParcelFeature = feature;
      const p = feature?.properties || {};
      const popupLatLng = latlng || L.latLng(
        Number(p.centroidLat || p.analysisLat),
        Number(p.centroidLon || p.analysisLon)
      );
      const popup = openPersistentFloodPopup(popupLatLng, buildHouseAlertPopup(feature), 460);
      persistentDepthQueryContext = { popup, kind: "building", feature };
      return popup;
    }
async function ensureFloodProjectionData() {
      if (houseAlertCdfData) return houseAlertCdfData;
      if (!HOUSE_ALERT_CDF_URL) throw new Error("Flood projection data is not configured.");
      if (!houseAlertCdfPromise) {
        houseAlertCdfPromise = fetchJson(HOUSE_ALERT_CDF_URL, { cache: "force-cache" })
          .then(payload => {
            if (!/flood-history-projections-v4$/.test(String(payload?.schema || ""))) {
              throw new Error("The flood projection dataset needs to be refreshed.");
            }
            houseAlertCdfData = payload;
            return payload;
          })
          .catch(error => {
            houseAlertCdfPromise = null;
            throw error;
          });
      }
      return houseAlertCdfPromise;
    }
function closeFloodHistoryPane() {
      const backdrop = document.getElementById("floodHistoryBackdrop");
      if (!backdrop) return;
      backdrop.hidden = true;
      backdrop.setAttribute("aria-hidden", "true");
      document.body.classList.remove("flood-history-open");
    }
function findProjectionElevationIndex(feature, data) {
      const grid = Array.isArray(data?.elevationGridFtNavd88) ? data.elevationGridFtNavd88 : [];
      const preferred = Number(
        feature?.properties?.nsi2026ModelElevationIndex ?? feature?.properties?.modelElevationIndex
      );
      if (Number.isInteger(preferred) && preferred >= 0 && preferred < grid.length) return preferred;
      const elevation = Number(
        feature?.properties?.nsi2026ModelElevationNavd88Ft ??
        feature?.properties?.nsi2026ModeledFirstFloorNavd88Ft ??
        feature?.properties?.modelElevationNavd88Ft ??
        feature?.properties?.elevationNavd88Ft
      );
      let bestIndex = 0;
      let bestDifference = Infinity;
      grid.forEach((candidate, index) => {
        const difference = Math.abs(Number(candidate) - elevation);
        if (difference < bestDifference) {
          bestDifference = difference;
          bestIndex = index;
        }
      });
      return bestIndex;
    }
function niceProjectionMaximum(value) {
      const n = Math.max(1, Number(value) || 1);
      const magnitude = 10 ** Math.floor(Math.log10(n));
      const normalized = n / magnitude;
      const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
      return nice * magnitude;
    }
function renderProjectionChart(data, scenarioKey, elevationIndex, selectedYearIndex) {
      const years = data.years || [];
      const record = data.annualFloodEventCount?.[scenarioKey] || {};
      const estimate = record.estimate?.[elevationIndex] || [];
      const lower = record.lower95?.[elevationIndex] || [];
      const upper = record.upper95?.[elevationIndex] || [];
      const width = 420;
      const height = 168;
      const plot = { left: 42, right: 9, top: 10, bottom: 25 };
      const plotWidth = width - plot.left - plot.right;
      const plotHeight = height - plot.top - plot.bottom;
      const maxValue = niceProjectionMaximum(Math.max(...upper.map(Number).filter(Number.isFinite), 1));
      const x = index => plot.left + (years.length > 1 ? index / (years.length - 1) : 0) * plotWidth;
      const y = value => plot.top + plotHeight - Math.min(1, Math.max(0, Number(value) / maxValue)) * plotHeight;
      const line = estimate.map((value, index) => `${x(index).toFixed(1)},${y(value).toFixed(1)}`).join(" ");
      const band = upper.map((value, index) => `${x(index).toFixed(1)},${y(value).toFixed(1)}`)
        .concat(lower.map((value, index) => `${x(lower.length - 1 - index).toFixed(1)},${y(lower[lower.length - 1 - index]).toFixed(1)}`))
        .join(" ");
      const gridValues = [0, maxValue / 2, maxValue];
      const selectedIndex = Math.max(0, Math.min(years.length - 1, selectedYearIndex));
      const tickYears = [2026, 2050, 2075, 2100].filter(year => years.includes(year));
      return `
        <svg class="flood-projection-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Expected annual flood exceedances with 95 percent uncertainty">
          ${gridValues.map(value => `<line class="flood-chart-grid" x1="${plot.left}" x2="${width - plot.right}" y1="${y(value)}" y2="${y(value)}"></line><text class="flood-chart-axis" x="${plot.left - 6}" y="${y(value) + 3}" text-anchor="end">${formatExpectedFloodCount(value)}</text>`).join("")}
          <polygon class="flood-chart-band" points="${band}"></polygon>
          <polyline class="flood-chart-line" points="${line}"></polyline>
          ${tickYears.map(year => {
            const index = years.indexOf(year);
            return `<text class="flood-chart-axis" x="${x(index)}" y="${height - 7}" text-anchor="${year === years[0] ? "start" : year === years[years.length - 1] ? "end" : "middle"}">${year}</text>`;
          }).join("")}
          <circle class="flood-chart-dot" cx="${x(selectedIndex)}" cy="${y(estimate[selectedIndex])}" r="4"></circle>
        </svg>`;
    }
function renderFloodHistoryProjection(feature, data) {
      const body = document.getElementById("floodHistoryBody");
      if (!body) return;
      const p = feature?.properties || {};
      const years = Array.isArray(data.years) ? data.years : [];
      const elevationIndex = findProjectionElevationIndex(feature, data);
      const firstFloor = getNsiFirstOccupiedFloorNavd88(p);
      const hasModeledFloor = Number.isFinite(firstFloor);
      const historic = Number(hasModeledFloor
        ? p.nsi2026HistoricFirstFloorExceedanceCount
        : p.historicFloodEventCount);
      const defaultYearIndex = Math.max(0, years.indexOf(2050));
      const scenarioKey = data.annualFloodEventCount?.[selectedFloodProjectionScenario]
        ? selectedFloodProjectionScenario
        : (data.scenarioOrder || []).find(key => data.annualFloodEventCount?.[key]);
      selectedFloodProjectionScenario = scenarioKey || "intermediate";
      const scenario = FLOOD_PROJECTION_SCENARIOS[selectedFloodProjectionScenario] || FLOOD_PROJECTION_SCENARIOS.intermediate;
      const record = data.annualFloodEventCount[selectedFloodProjectionScenario];
      const estimate = record.estimate[elevationIndex];
      const lower = record.lower95[elevationIndex];
      const upper = record.upper95[elevationIndex];
      body.style.setProperty("--scenario-color", scenario.color);
      body.innerHTML = `
        <div class="flood-history-summary">
          <div class="flood-summary-item">
            <span>${hasModeledFloor ? "Past gauge peaks above floor" : "Past gauge peaks above ground"}</span>
            <strong>${Number.isFinite(historic) ? historic.toLocaleString() : "—"}</strong>
          </div>
          <div class="flood-summary-item">
            <span>${hasModeledFloor ? "Estimated occupied floor" : "Parcel ground"}</span>
            <strong>${hasModeledFloor ? firstFloor.toFixed(1) : Number(p.elevationNavd88Ft).toFixed(1)} <small>ft NAVD88</small></strong>
          </div>
        </div>
        <section class="flood-history-section">
          <div class="flood-history-section-head">
            <div><h3>${hasModeledFloor ? "Projected floor exceedances" : "Projected ground exceedances"}</h3><p>Gauge-level screening · events/year · sampling range</p></div>
            <label class="flood-scenario-field">
              Sea-level scenario
              <select id="floodProjectionScenarioSelect" class="flood-scenario-select" aria-label="Sea level projection curve">
                ${(data.scenarioOrder || Object.keys(data.annualFloodEventCount)).map(key => {
                  const item = FLOOD_PROJECTION_SCENARIOS[key] || { label: key };
                  return `<option value="${escapeTownAddressHtml(key)}"${key === selectedFloodProjectionScenario ? " selected" : ""}>${escapeTownAddressHtml(item.label)}</option>`;
                }).join("")}
              </select>
            </label>
          </div>
          <div id="floodProjectionChart">${renderProjectionChart(data, selectedFloodProjectionScenario, elevationIndex, defaultYearIndex)}</div>
          <div class="flood-year-control">
            <input id="floodProjectionYearSlider" type="range" min="0" max="${Math.max(0, years.length - 1)}" value="${defaultYearIndex}" step="1" aria-label="Projection year">
            <div id="floodProjectionYearReadout" class="flood-year-readout">
              <span>${years[defaultYearIndex] || "—"}</span>
              <strong>${formatExpectedFloodCount(estimate[defaultYearIndex])}/yr</strong>
              <small>95%: ${formatFloodIntervalValue(lower[defaultYearIndex])}–${formatFloodIntervalValue(upper[defaultYearIndex])}</small>
            </div>
          </div>
        </section>
      `;

      const updateSelectedYear = index => {
        const selectedIndex = Math.max(0, Math.min(years.length - 1, Number(index) || 0));
        const readout = document.getElementById("floodProjectionYearReadout");
        const chart = document.getElementById("floodProjectionChart");
        if (readout) {
          readout.innerHTML = `<span>${years[selectedIndex]}</span><strong>${formatExpectedFloodCount(estimate[selectedIndex])}/yr</strong><small>95%: ${formatFloodIntervalValue(lower[selectedIndex])}–${formatFloodIntervalValue(upper[selectedIndex])}</small>`;
        }
        if (chart) chart.innerHTML = renderProjectionChart(data, selectedFloodProjectionScenario, elevationIndex, selectedIndex);
      };
      document.getElementById("floodProjectionYearSlider")?.addEventListener("input", event => updateSelectedYear(event.target.value));
      document.getElementById("floodProjectionScenarioSelect")?.addEventListener("change", event => {
        selectedFloodProjectionScenario = event.target.value;
        renderFloodHistoryProjection(feature, data);
      });
    }
async function openFloodHistoryPane(feature) {
      if (!feature) return;
      selectedParcelFeature = feature;
      const backdrop = document.getElementById("floodHistoryBackdrop");
      const body = document.getElementById("floodHistoryBody");
      const address = document.getElementById("floodHistoryAddress");
      if (!backdrop || !body) return;
      address.textContent = feature?.properties?.address || "Selected Highlands parcel";
      const provenance = document.getElementById("floodHistoryProvenance");
      if (provenance) provenance.textContent = "";
      body.innerHTML = '<div class="flood-history-loading" role="status"><span class="flood-history-spinner" aria-hidden="true"></span><strong>Preparing this building’s flood profile…</strong><span>Loading the projection model only when you need it.</span></div>';
      backdrop.hidden = false;
      backdrop.setAttribute("aria-hidden", "false");
      document.body.classList.add("flood-history-open");
      document.getElementById("floodHistoryCloseBtn")?.focus();
      try {
        const data = await ensureFloodProjectionData();
        if (selectedParcelFeature === feature && !backdrop.hidden) {
          const notice = document.getElementById("floodHistoryProvenance");
          const basis = data.site?.name || data.sources?.observed || "Archived model";
          if (notice) notice.textContent = `Model basis: ${basis}. Observations through ${data.observedArchive?.endDate || "an unspecified date"}. Generated ${(data.generatedUtc || "unknown").slice(0, 10)}.${data.qualityPolicyVersion ? "" : " This older model predates the current observation quality review and is not recalculated from the selected tide archive."}`;
          renderFloodHistoryProjection(feature, data);
        }
      } catch (error) {
        body.innerHTML = `<div class="flood-history-error"><strong>This projection could not be loaded.</strong><br>${escapeTownAddressHtml(error?.message || "Please try again in a moment.")}</div>`;
      }
    }
function wireFloodHistoryPane() {
      const backdrop = document.getElementById("floodHistoryBackdrop");
      document.getElementById("floodHistoryCloseBtn")?.addEventListener("click", closeFloodHistoryPane);
      backdrop?.addEventListener("click", event => {
        if (event.target === backdrop) closeFloodHistoryPane();
      });
      document.addEventListener("click", event => {
        if (event.target?.closest?.(".house-alert-cta") && selectedParcelFeature) {
          openFloodHistoryPane(selectedParcelFeature);
        }
      });
      document.addEventListener("keydown", event => {
        if (event.key === "Escape" && backdrop && !backdrop.hidden) closeFloodHistoryPane();
      });
    }
function getSelectedStageNavd88() {
      const entry = currentSeriesHours[currentHourIndex];
      const stage = normalizeStageValue(getStageValue(entry));
      return Number.isFinite(stage) ? stage : null;
    }
function finiteStructureNumber(value) {
      if (value == null || String(value).trim() === "") return null;
      const number = Number(value);
      return Number.isFinite(number) ? number : null;
    }
function getNsiFirstOccupiedFloorNavd88(properties) {
      const p = properties || {};
      const localGround = finiteStructureNumber(p.localGroundNavd88Ft ?? p.nsi2026LocalGroundNavd88Ft);
      const riseToOccupiedFloor = finiteStructureNumber(p.foundationHeightFt ?? p.nsi2026FoundationHeightFt);
      if (localGround != null && riseToOccupiedFloor != null) {
        return localGround + Math.max(0, riseToOccupiedFloor);
      }
      return finiteStructureNumber(p.modeledFirstFloorNavd88Ft ?? p.nsi2026ModeledFirstFloorNavd88Ft);
    }
function getNsiStructureImpactStyle(properties, stage = getSelectedStageNavd88()) {
      const firstFloor = getNsiFirstOccupiedFloorNavd88(properties);
      if (!Number.isFinite(firstFloor) || !Number.isFinite(stage)) {
        return { radius: 2.7, color: "#94a3b8", weight: 0.7, opacity: 0.8, fillColor: "#64748b", fillOpacity: 0.42 };
      }
      const waterAboveFloor = stage - firstFloor;
      if (waterAboveFloor > 0.1) {
        return { radius: 4.3, color: "#fff1f2", weight: 1.1, opacity: 0.95, fillColor: "#fb7185", fillOpacity: 0.95 };
      }
      if (waterAboveFloor >= -0.5) {
        return { radius: 3.6, color: "#fff7d6", weight: 1.0, opacity: 0.95, fillColor: "#fbbf24", fillOpacity: 0.88 };
      }
      return { radius: 2.7, color: "#d9fdff", weight: 0.7, opacity: 0.72, fillColor: "#22d3ee", fillOpacity: 0.48 };
    }
function formatNsiImpactStatus(properties, stage = getSelectedStageNavd88()) {
      const firstFloor = getNsiFirstOccupiedFloorNavd88(properties);
      if (!Number.isFinite(firstFloor) || !Number.isFinite(stage)) return "No modeled occupied floor is available for this parcel.";
      const difference = stage - firstFloor;
      if (difference > 0.1) return `Selected gauge level is ${formatWaterDepth(difference, 1)} above the estimated first occupied floor.`;
      if (difference >= -0.1) return "Selected gauge level is at the estimated first occupied floor.";
      return `Selected gauge level is ${formatWaterDepth(Math.abs(difference), 1)} below the estimated first occupied floor.`;
    }
function buildNsiStructurePopup(feature) {
      const p = feature?.properties || {};
      const firstFloor = getNsiFirstOccupiedFloorNavd88(p);
      const address = escapeTownAddressHtml(p.address || "Modeled Highlands structure");
      return '<div class="nsi-structure-popup">' +
        '<span class="house-alert-kicker">Estimated floor flooding</span>' +
        '<h3>' + address + '</h3>' +
        '<div class="nsi-structure-grid">' +
          '<span>Estimated first occupied floor</span><strong>' + (Number.isFinite(firstFloor) ? firstFloor.toFixed(1) + ' ft NAVD88' : '—') + '</strong>' +
        '</div>' +
        '<div class="nsi-impact-status">' + escapeTownAddressHtml(formatNsiImpactStatus(p)) + '</div>' +
        '<div class="house-alert-note">Screening estimate; local connectivity and barriers may change actual inundation.</div>' +
        '</div>';
    }
function updateNsiStructureImpactLayer() {
      if (!nsiStructuresLayer) return;
      const stage = getSelectedStageNavd88();
      nsiStructuresLayer.eachLayer(layer => {
        if (layer?.feature?.properties && typeof layer.setStyle === "function") {
          layer.setStyle(getNsiStructureImpactStyle(layer.feature.properties, stage));
        }
      });
    }
function findNsiStructureFeatureForLocation(lat, lon, maximumDistanceMeters = 24) {
      let nearest = null;
      let nearestDistance = Infinity;
      const longitudeScale = Math.cos(Number(lat) * Math.PI / 180);
      nsiStructureFeatures.forEach(feature => {
        const coordinates = feature?.geometry?.coordinates || [];
        const dLat = Number(coordinates[1]) - Number(lat);
        const dLon = (Number(coordinates[0]) - Number(lon)) * longitudeScale;
        const meters = Math.hypot(dLat, dLon) * 111320;
        if (Number.isFinite(meters) && meters < nearestDistance) {
          nearestDistance = meters;
          nearest = feature;
        }
      });
      return nearestDistance <= maximumDistanceMeters ? nearest : null;
    }
async function ensureNsiStructureAssets() {
      if (nsiStructuresLayer) return nsiStructuresLayer;
      if (!NSI_STRUCTURES_URL) throw new Error("USACE NSI structures are not configured.");
      if (!nsiStructureLoadPromise) {
        nsiStructureLoadPromise = fetchJson(NSI_STRUCTURES_URL, { cache: "force-cache" })
          .then(payload => {
            if (!/highlands-structure-floor-v1$/.test(String(payload?.metadata?.schema || ""))) {
              throw new Error("The USACE NSI structure asset needs to be refreshed.");
            }
            nsiStructureFeatures = Array.isArray(payload.features) ? payload.features : [];
            nsiStructureRenderer = nsiStructureRenderer || L.canvas({ pane: "structuresPane", padding: 0.5, tolerance: 7 });
            nsiStructuresLayer = L.geoJSON(payload, {
              pane: "structuresPane",
              renderer: nsiStructureRenderer,
              pointToLayer: (feature, latlng) => L.circleMarker(latlng, {
                ...getNsiStructureImpactStyle(feature?.properties),
                pane: "structuresPane",
                renderer: nsiStructureRenderer,
                bubblingMouseEvents: false,
                interactive: true
              }),
              onEachFeature: (feature, layer) => {
                layer.on("click", event => {
                  if (event?.originalEvent) event.originalEvent._parcelHandled = true;
                  openPersistentFloodPopup(event.latlng, buildNsiStructurePopup(feature), 360);
                });
              }
            });
            return nsiStructuresLayer;
          })
          .catch(error => {
            nsiStructureLoadPromise = null;
            throw error;
          });
      }
      return nsiStructureLoadPromise;
    }
async function setNsiStructuresEnabled(enabled) {
      const generation = ++nsiLayerGeneration;
      const shouldEnable = Boolean(enabled);
      const toggle = document.getElementById("nsiStructuresToggle");
      if (toggle) {
        toggle.classList.toggle("on", shouldEnable);
        toggle.setAttribute("aria-checked", String(shouldEnable));
      }
      if (!map) ensureMap();
      if (!shouldEnable) {
        if (nsiStructuresLayer && map.hasLayer(nsiStructuresLayer)) map.removeLayer(nsiStructuresLayer);
        updateMapClickModeControl();
        toast("");
        return;
      }
      let layer;
      try {
        layer = await ensureNsiStructureAssets();
      } catch (error) {
        if (generation !== nsiLayerGeneration) return;
        throw error;
      }
      if (generation !== nsiLayerGeneration) return;
      updateNsiStructureImpactLayer();
      if (!map.hasLayer(layer)) layer.addTo(map);
      setMapClickMode("building", { closePopup: false });
      toast("Crawlspace/Garage impacts: red is above, gold is close, cyan is below.");
    }
async function setParcelsEnabled(enabled) {
      const generation = ++parcelLayerGeneration;
      const shouldEnable = Boolean(enabled);
      const toggle = document.getElementById("parcelsToggle");
      if (toggle) {
        toggle.classList.toggle("on", shouldEnable);
        toggle.setAttribute("aria-checked", String(shouldEnable));
      }
      if (!map) ensureMap();
      if (!shouldEnable) {
        if (parcelsLayer && map.hasLayer(parcelsLayer)) map.removeLayer(parcelsLayer);
        updateMapClickModeControl();
        toast("");
        return;
      }
      let layer;
      try {
        layer = await ensureParcelAssets();
      } catch (error) {
        if (generation !== parcelLayerGeneration) return;
        throw error;
      }
      if (generation !== parcelLayerGeneration) return;
      if (!map.hasLayer(layer)) layer.addTo(map);
      setMapClickMode("building", { closePopup: false });
      toast("");
    }
function pointInRing(lon, lat, ring) {
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = Number(ring[i]?.[0]), yi = Number(ring[i]?.[1]);
        const xj = Number(ring[j]?.[0]), yj = Number(ring[j]?.[1]);
        const intersects = ((yi > lat) !== (yj > lat)) && (lon < ((xj - xi) * (lat - yi)) / ((yj - yi) || Number.EPSILON) + xi);
        if (intersects) inside = !inside;
      }
      return inside;
    }
function pointInParcelFeature(feature, lat, lon) {
      const geometry = feature?.geometry;
      if (!geometry) return false;
      const polygons = geometry.type === "Polygon" ? [geometry.coordinates] :
        (geometry.type === "MultiPolygon" ? geometry.coordinates : []);
      return polygons.some(rings => {
        if (!Array.isArray(rings?.[0]) || !pointInRing(lon, lat, rings[0])) return false;
        return !rings.slice(1).some(hole => pointInRing(lon, lat, hole));
      });
    }
async function findParcelFeatureForLocation(lat, lon, options = {}) {
      await ensureParcelAssets();
      const containing = parcelFeatures.find(feature => pointInParcelFeature(feature, lat, lon));
      if (containing) return containing;
      if (options.allowNearest === false) return null;
      let nearest = null;
      let nearestDistance = Infinity;
      parcelFeatures.forEach(feature => {
        const p = feature?.properties || {};
        const dLat = Number(p.centroidLat) - lat;
        const dLon = (Number(p.centroidLon) - lon) * Math.cos(lat * Math.PI / 180);
        const meters = Math.hypot(dLat, dLon) * 111320;
        if (Number.isFinite(meters) && meters < nearestDistance) {
          nearestDistance = meters;
          nearest = feature;
        }
      });
      return nearestDistance <= 90 ? nearest : null;
    }
function parcelInfoInteractionEnabled() {
      return Boolean(
        document.getElementById("parcelsToggle")?.classList.contains("on") ||
        document.getElementById("buildingsToggle")?.classList.contains("on") ||
        document.getElementById("nsiStructuresToggle")?.classList.contains("on")
      );
    }
function updateMapClickModeControl() {
      const control = document.getElementById("mapClickModeControl");
      const buildingButton = document.getElementById("mapClickBuildingBtn");
      const depthButton = document.getElementById("mapClickDepthBtn");
      if (!control || !buildingButton || !depthButton) return;
      control.hidden = !parcelInfoInteractionEnabled();
      buildingButton.textContent = "Building Info";
      depthButton.textContent = "Flood Depth";
      buildingButton.classList.toggle("active", mapClickMode === "building");
      depthButton.classList.toggle("active", mapClickMode === "depth");
      buildingButton.setAttribute("aria-pressed", String(mapClickMode === "building"));
      depthButton.setAttribute("aria-pressed", String(mapClickMode === "depth"));
      if (!control.hidden) requestAnimationFrame(positionMapClickModeControl);
    }
function positionMapClickModeControl() {
      const control = document.getElementById("mapClickModeControl");
      const title = document.getElementById("mapTitleBadge");
      if (!control || !title || control.hidden) return;
      const titleRect = title.getBoundingClientRect();
      if (!Number.isFinite(titleRect.bottom) || titleRect.height < 2) return;
      control.style.setProperty("--map-click-mode-top", `${Math.ceil(titleRect.bottom + 7)}px`);
    }
function setMapClickMode(mode, options = {}) {
      mapClickMode = mode === "depth" ? "depth" : "building";
      updateMapClickModeControl();
      if (options.closePopup !== false && persistentFloodPopup && map?.hasLayer(persistentFloodPopup)) {
        map.removeLayer(persistentFloodPopup);
      }
    }
async function setBuildingsEnabled(enabled) {
      const shouldEnable = Boolean(enabled);
      const toggle = document.getElementById("buildingsToggle");
      if (toggle) {
        toggle.classList.toggle("on", shouldEnable);
        toggle.setAttribute("aria-checked", String(shouldEnable));
      }
      if (!map) ensureMap();
      if (!shouldEnable) {
        if (buildingsLayer && map.hasLayer(buildingsLayer)) map.removeLayer(buildingsLayer);
        updateExportBuildingsLayer();
        updateMapClickModeControl();
        toast("");
        return;
      }

      if (!buildingsLayer) {
        buildingsLayer = makeEsriBuildingForegroundLayer("buildingsPane");
        if (!buildingsLayer) throw new Error("The exact building layer is unavailable in this browser.");
        buildingsLayer.on("error", () => {
          setBuildingsEnabled(false).catch(() => {});
          toast("The exact building layer could not be loaded.");
        });
      }
      if (!map.hasLayer(buildingsLayer)) buildingsLayer.addTo(map);
      setMapClickMode("building", { closePopup: false });
      updateExportBuildingsLayer();
      toast("");
      ensureParcelAssets().catch(error => console.warn("Building parcel matching will retry when requested.", error));
    }
function getVisibleTutorialTarget(selector) {
      document.dispatchEvent(new CustomEvent("nww:reveal-control", {detail:selector}));
      return Array.from(document.querySelectorAll(selector)).find(element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 4 && rect.height > 4 && style.display !== "none" && style.visibility !== "hidden";
      }) || document.querySelector(selector);
    }
function renderMapperTutorialStep() {
      const step = MAPPER_TUTORIAL_STEPS[mapperTutorialIndex];
      if (!step) return;
      const tutorialModePromise = mapperTutorialIndex === 1 && currentDataMode !== "forecast"
        ? switchDataMode("forecast")
        : (mapperTutorialIndex === 3 && currentDataMode !== "observed" ? switchDataMode("observed") : Promise.resolve());
      const target = getVisibleTutorialTarget(step.target);
      const compactTutorial = isCompactFloodmapperLayout();
      if (compactTutorial && target) {
        const needsDrawer = Boolean(target.closest("#leftPanel, #mobileRailMount"));
        setMobileControlsOpen(needsDrawer);
      }
      document.getElementById("mapperTutorialProgress").textContent = (mapperTutorialIndex + 1) + " of " + MAPPER_TUTORIAL_STEPS.length;
      document.getElementById("mapperTutorialTitle").textContent = step.title;
      document.getElementById("mapperTutorialBody").innerHTML = step.body;
      const back = document.getElementById("mapperTutorialBack");
      const next = document.getElementById("mapperTutorialNext");
      back.disabled = mapperTutorialIndex === 0;
      next.textContent = mapperTutorialIndex === MAPPER_TUTORIAL_STEPS.length - 1 ? "Finish" : "Next";
      window.setTimeout(async () => {
        try { await tutorialModePromise; } catch (err) {}
        const resolved = getVisibleTutorialTarget(step.target);
        const mobileBlockByStep = { 1: "start", 3: "end", 6: "end", 7: "start" };
        const block = compactTutorial ? (mobileBlockByStep[mapperTutorialIndex] || "center") : "center";
        resolved?.scrollIntoView({ block, inline: "center", behavior: "auto" });
        window.setTimeout(positionMapperTutorial, 80);
        window.setTimeout(positionMapperTutorial, 320);
      }, 40);
    }
function setMapperTutorialOpen(open, startIndex = 0) {
      const tutorial = document.getElementById("mapperTutorial");
      if (!tutorial) return;
      tutorial.hidden = !open;
      tutorial.setAttribute("aria-hidden", open ? "false" : "true");
      document.body.classList.toggle("tutorial-active", Boolean(open));
      if (open) {
        mapperTutorialIndex = Math.max(0, Math.min(startIndex, MAPPER_TUTORIAL_STEPS.length - 1));
        renderMapperTutorialStep();
        mapperTutorialResizeHandler = () => positionMapperTutorial();
        window.addEventListener("resize", mapperTutorialResizeHandler);
        document.getElementById("mapperTutorialNext")?.focus();
      } else if (mapperTutorialResizeHandler) {
        window.removeEventListener("resize", mapperTutorialResizeHandler);
        mapperTutorialResizeHandler = null;
      }
    }
function wireMapperTutorial() {
      document.getElementById("mapperTutorialBtn")?.addEventListener("click", () => setMapperTutorialOpen(true, 0));
      document.getElementById("mapperTutorialClose")?.addEventListener("click", () => setMapperTutorialOpen(false));
      document.getElementById("mapperTutorialBack")?.addEventListener("click", () => {
        if (mapperTutorialIndex > 0) {
          mapperTutorialIndex -= 1;
          renderMapperTutorialStep();
        }
      });
      document.getElementById("mapperTutorialNext")?.addEventListener("click", () => {
        if (mapperTutorialIndex >= MAPPER_TUTORIAL_STEPS.length - 1) setMapperTutorialOpen(false);
        else {
          mapperTutorialIndex += 1;
          renderMapperTutorialStep();
        }
      });
      document.addEventListener("keydown", event => {
        if (document.getElementById("mapperTutorial")?.hidden) return;
        if (event.key === "Escape") setMapperTutorialOpen(false);
        if (event.key === "ArrowRight") document.getElementById("mapperTutorialNext")?.click();
        if (event.key === "ArrowLeft") document.getElementById("mapperTutorialBack")?.click();
      });
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
function getDownloadExtentValue() {
      const hiddenExtent = document.getElementById("downloadExtentSelect");
      const activeExtentButton = document.querySelector("#downloadExtentControl button[data-extent].active");
      const raw = hiddenExtent?.value || activeExtentButton?.dataset?.extent || "current";
      const normalized = raw === "town" ? "town" : "current";
      if (hiddenExtent && hiddenExtent.value !== normalized) hiddenExtent.value = normalized;
      return normalized;
    }
function getExportAspectConfig(aspect = null) {
      if ((aspect || getDownloadAspectValue()) === "viewport") return getExportViewportAspect();
      const base = EXPORT_GIF_ASPECTS[aspect || getDownloadAspectValue()] || EXPORT_GIF_ASPECTS["4:5"];
      if (getDownloadFormatValue() !== "png") return base;
      return {
        ...base,
        width: base.pngWidth || base.width,
        height: base.pngHeight || base.height,
        resolutionLabel: `${base.pngWidth || base.width} × ${base.pngHeight || base.height}`
      };
    }
function applyExportStageAspect(aspect = null) {
      const config = getExportAspectConfig(aspect);
      const stageHost = document.getElementById("exportStage");
      const stageFrame = document.getElementById("exportStageFrame");
      const legendDock = document.getElementById("exportLegendDock");
      const timestamp = document.getElementById("exportTimestampLabel");
      if (stageHost) {
        stageHost.style.width = `${config.width}px`;
        stageHost.style.height = `${config.height}px`;
      }
      if (stageFrame) {
        stageFrame.style.width = `${config.width}px`;
        stageFrame.style.height = `${config.height}px`;
        stageFrame.dataset.exportAspect = config.value;
        stageFrame.dataset.exportCompact = String(config.width < 1000);
      }
      if (legendDock) {
        legendDock.style.width = `${config.value === "9:16" ? 176 : config.value === "1:1" ? 184 : 192}px`;
      }
      if (timestamp) {
        timestamp.style.removeProperty("max-width");
      }
      if (exportMap) exportMap.invalidateSize(false);
      return config;
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
function buildQuarterHourRangeFrameItems(entries, range, sourceSeries = new Map()) {
      if (!Array.isArray(entries) || !entries.length || !range) return [];
      const sourceMode = entries.find(entry => entry.exportSourceMode)?.exportSourceMode || "observed";
      const series = buildQuarterHourTimelineSeries(entries, {
        kind: sourceMode,
        startMs: range.startMs,
        endMs: range.endMs,
        fillMissingSlots: false,
        maxGapMinutes: 75
      });
      return series
        .filter(entry => Number.isFinite(getStageValue(entry)))
        .map((entry, idx) => {
          const exportEntry = {
            ...entry,
            exportSourceMode: entry.exportSourceMode || sourceMode,
            observationInterval: "15min",
            timelineIntervalMinutes: 15,
            exportInterval: "15min"
          };
          const fallbackIndex = exportEntry.exportSourceMode === "observed"
            ? idx
            : findClosestEntryIndex(currentSeriesHours, exportEntry);
          return getDownloadFrameItemFromEntry(exportEntry, fallbackIndex, sourceSeries);
        })
        .filter(Boolean);
    }
function buildDailyMaximumRangeFrameItems(entries, range, sourceSeries = new Map()) {
      if (!Array.isArray(entries) || !entries.length || !range) return [];
      const inRange = entries.filter(entry => {
        const time = entryTimeMs(entry);
        return Number.isFinite(time) && time >= range.startMs && time <= range.endMs && Number.isFinite(getStageValue(entry));
      });
      return buildDailyMaximumSeries(inRange, "export")
        .map((entry, idx) => {
          const exportEntry = {
            ...entry,
            exportSourceMode: entry.exportSourceMode || "observed",
            observationInterval: "daily",
            timelineIntervalMinutes: 1440,
            exportInterval: "daily"
          };
          const fallbackIndex = exportEntry.exportSourceMode === "observed"
            ? idx
            : findClosestEntryIndex(currentSeriesHours, exportEntry);
          return getDownloadFrameItemFromEntry(exportEntry, fallbackIndex, sourceSeries);
        })
        .filter(Boolean);
    }
function buildExportRangeFrameItems(entries, range, intervalValue = getDownloadIntervalValue()) {
      if (intervalValue === "daily") return buildDailyMaximumRangeFrameItems(entries, range);
      const timed = entries.filter(entry => !entry.isDailyPeakOnly);
      const dailyOnly = buildDailyMaximumRangeFrameItems(entries.filter(entry => entry.isDailyPeakOnly), range);
      const frames = intervalValue === "15min"
        ? buildQuarterHourRangeFrameItems(timed, range)
        : buildHourlyRangeFrameItems(timed, range);
      // Unknown peak times must never become interpolation endpoints or gain
      // an hourly/quarter-hour label merely because of the export selection.
      return [...frames, ...dailyOnly].sort((a, b) => entryTimeMs(a.entry) - entryTimeMs(b.entry));
    }
function getDownloadRangeSummaryFrameCount(range) {
      if (!range || !Number.isFinite(range.startMs) || !Number.isFinite(range.endMs)) return 0;
      const startMs = Math.min(range.startMs, range.endMs);
      const endMs = Math.max(range.startMs, range.endMs);
      const interval = getDownloadIntervalConfig();
      if (interval.value === "daily") {
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
      return Math.max(1, Math.floor((endMs - startMs) / stepMs) + 1);
    }
function getDownloadFrameItems(scope = null) {
      const mode = scope || getDownloadScopeValue();
      const currentEntry = getDownloadCurrentEntry();

      if (mode === "current") {
        if (!currentEntry) return [];
        const item = getDownloadFrameItemFromEntry(currentEntry, currentHourIndex);
        return item ? [item] : [];
      }

      const range = getDownloadRangeRequest();
      if (!range) return [];

      const entries = getDownloadSourceEntries(true, range.startDate, range.endDate)
        .filter(entry => entryTimeMs(entry) != null)
        .sort((a, b) => entryTimeMs(a) - entryTimeMs(b));
      if (!entries.length) return [];

      const items = buildExportRangeFrameItems(entries, range, getDownloadIntervalValue());
      const frameLimit = getDownloadFrameLimit();
      if (items.length > frameLimit) {
        return items.slice(0, frameLimit);
      }
      return items;
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
      applyExportStageAspect("viewport");
      updateDownloadSummary();
      setTimeout(() => document.getElementById("downloadResetBtn")?.blur(), 0);
    }
const PARCELS_URL = new URL('assets/highlands-data/parcels.geojson', APP_BASE).href;
const PARCEL_BOUNDARY_PNG_URL = new URL('assets/highlands-data/parcel-boundaries.png', APP_BASE).href;
const NSI_STRUCTURES_URL = new URL('assets/highlands-data/structures.geojson', APP_BASE).href;
const HOUSE_ALERT_CDF_URL = new URL('assets/highlands-data/flood-projections.json', APP_BASE).href;
const RETURN_INTERVALS_URL = new URL('assets/highlands-data/return-intervals.json', APP_BASE).href;
function getActiveFloodOverlayCoordinates() {
  const b = currentFloodLayer?.getBounds?.() || floodLatLngBounds;
  return b ? [[b.getWest(),b.getNorth()],[b.getEast(),b.getNorth()],[b.getEast(),b.getSouth()],[b.getWest(),b.getSouth()]] : null;
}
function getConfiguredWorldFileCoordinates() { return getActiveFloodOverlayCoordinates(); }
async function setPhysicsFloodLayer() { throw new Error('Highlands uses its existing phase-aware raster catalog.'); }
function makeEsriBuildingForegroundLayer() { return null; }
function updateExportBuildingsLayer() {
  if (!exportMap) return;
  if (exportBuildingsLayer) { exportMap.removeLayer(exportBuildingsLayer); exportBuildingsLayer=null; }
  const gl=window.NORTH_WILDWOOD_3D?.getMap?.();
  if (!document.getElementById('buildingsToggle')?.classList.contains('on') || !gl) return;
  const source=gl.getSource('county-building-footprints');
  const data=source?._data;
  if(data?.features?.length) exportBuildingsLayer=L.geoJSON(data,{interactive:false,style:{color:'#bdb5a5',weight:.6,fillColor:'#ddd7cb',fillOpacity:1}}).addTo(exportMap);
}
function updateExportParcelsLayer() {
  if(!exportMap)return;
  if(exportParcelsLayer){exportMap.removeLayer(exportParcelsLayer);exportParcelsLayer=null;}
  if(document.getElementById('parcelsToggle')?.classList.contains('on')&&parcelFeatures.length)exportParcelsLayer=L.geoJSON({type:'FeatureCollection',features:parcelFeatures},{interactive:false,style:{color:'#f87171',weight:1,fill:false}}).addTo(exportMap);
}
async function ensureParcelAssets() {
  if(parcelsLayer)return parcelsLayer;
  if(!parcelLoadPromise)parcelLoadPromise=(async()=>{
    const geojson=await fetchJson(PARCELS_URL,{cache:'force-cache'});
    parcelFeatures=geojson.features||[];
    if(!map.getPane('parcelsPane'))map.createPane('parcelsPane');
    map.getPane('parcelsPane').style.zIndex='610';
    parcelsLayer=L.geoJSON(geojson,{pane:'parcelsPane',style:{color:'#f87171',weight:1.2,fillOpacity:0},onEachFeature:(feature,layer)=>{
      layer.on('click',event=>{if(mapClickMode!=='building')return;if(event.originalEvent)event.originalEvent._parcelHandled=true;openParcelFloodPrompt(feature,event.latlng);});
    }});
    return parcelsLayer;
  })().catch(error=>{parcelLoadPromise=null;throw error;});
  return parcelLoadPromise;
}
async function handleDepthQueryClick(event) {
  if(!event?.latlng||event.originalEvent?._parcelHandled)return;
  if(parcelInfoInteractionEnabled()&&mapClickMode==='building'){
    try{
      const feature=await findParcelFeatureForLocation(event.latlng.lat,event.latlng.lng,{allowNearest:false});
      if(feature){openParcelFloodPrompt(feature,event.latlng);return;}
      const structure=findNsiStructureFeatureForLocation(event.latlng.lat,event.latlng.lng,16);
      if(structure){openPersistentFloodPopup(event.latlng,buildNsiStructurePopup(structure),360);return;}
    }catch(error){console.warn('Building information unavailable',error);}
  }
  const popup=openPersistentFloodPopup(event.latlng,'<div class="depth-query-popup">Loading modeled depth…</div>',360);
  persistentDepthQueryContext={popup,kind:'depth',latlng:event.latlng};
  await updatePersistentDepthQueryPopup();
}
async function updatePersistentDepthQueryPopup() {
  const context=persistentDepthQueryContext;
  if(!context?.popup||context.popup!==persistentFloodPopup||!map?.hasLayer(context.popup))return;
  if(context.kind==='building'){
    context.popup.setContent(buildHouseAlertPopup(context.feature));return;
  }
  if(context.kind!=='depth'||!window.HighlandsDepthQuery)return;
  const token=lastRenderToken;
  try{
    const value=await window.HighlandsDepthQuery.sample(context.latlng);
    if(token!==lastRenderToken||context!==persistentDepthQueryContext)return;
    context.popup.setContent(window.HighlandsDepthQuery.html(value.value,value.state));
  }catch(error){if(context===persistentDepthQueryContext)context.popup.setContent('<div class="depth-query-popup">Depth unavailable for this location.</div>');}
}
function updateDownloadModeCopy() {
  const summary=document.getElementById('modeledFloodNotice');
  if(summary)summary.hidden=currentDataMode!=='return-interval';
}
function initializeHighlandsFeatures() {
  // Explicitly local sources; no North Wildwood levels, parcels, or structures.
  TOWN_CONFIG.structures={nsi2026GeojsonPath:'assets/highlands-data/structures.geojson'};
  TOWN_CONFIG.parcels={geojsonPath:'assets/highlands-data/parcels.geojson',boundaryPngPath:'assets/highlands-data/parcel-boundaries.png',houseAlertCdfPath:'assets/highlands-data/flood-projections.json'};
  const oldEnsureMap=ensureMap;
  ensureMap=function(){const result=oldEnsureMap.apply(this,arguments);for(const [name,z]of [['structuresPane',715],['buildingsPane',600],['parcelsPane',610]]){if(!map.getPane(name))map.createPane(name);map.getPane(name).style.zIndex=String(z);}return result;};
  const roadKey=document.getElementById('roadImpactsKey');document.getElementById('legendDock').append(roadKey);
  const structureKey=document.createElement('div');structureKey.id='structuresImpactKey';structureKey.hidden=true;structureKey.innerHTML='<b style="background:#fb7185"></b>Above floor <b style="background:#fbbf24"></b>Near floor <b style="background:#22d3ee"></b>Below floor<br>Selected gauge level vs estimated floor; screening only.';document.getElementById('legendDock').append(structureKey);
  const oldNsi=setNsiStructuresEnabled;setNsiStructuresEnabled=async function(enabled){const result=await oldNsi.apply(this,arguments);structureKey.hidden=!enabled;return result;};
  const oldMode=updateDataModeButtons;
  updateDataModeButtons=function(){
    oldMode();const modeled=currentDataMode==='return-interval';
    document.getElementById('returnIntervalDataBtn').classList.toggle('active',modeled);
    document.getElementById('returnIntervalCard').style.display=modeled?'':'none';
    document.body.classList.toggle('return-interval-mode',modeled);
    if(modeled)document.getElementById('dataModePill').textContent=getReturnIntervalLabel();
    updateReturnIntervalButtons();updateDownloadModeCopy();
  };
  const oldSwitch=switchDataMode;
  switchDataMode=async function(mode){if(mode==='return-interval')return switchReturnInterval(currentReturnIntervalYears);return oldSwitch.apply(this,arguments);};
  const oldInterval=setTimelineIntervalMinutes;
  setTimelineIntervalMinutes=async function(minutes){
    if(currentDataMode!=='return-interval')return oldInterval.apply(this,arguments);
    const reference=currentSeriesHours[currentHourIndex];stopPlayback();currentTimelineIntervalMinutes=[15,1440].includes(Number(minutes))?Number(minutes):60;updateTimelineIntervalUI();await loadReturnInterval(reference);await renderHour(currentHourIndex);
  };
  const oldRender=renderHour;
  renderHour=async function(){const result=await oldRender.apply(this,arguments);updateNsiStructureImpactLayer();await updatePersistentDepthQueryPopup();return result;};
  const oldFormat=formatHourEntryTime;
  formatHourEntryTime=function(entry){return entry?.syntheticStorm?`Sample storm ${Number(entry.offsetHours)>=0?'+':''}${Number(entry.offsetHours).toFixed(2).replace(/\.00$/,'')}h`:oldFormat.apply(this,arguments);};
  const oldBubble=formatTimelineBubbleText;
  formatTimelineBubbleText=function(entry){return entry?.syntheticStorm?`Sample storm · ${Number(entry.offsetHours)>=0?'+':''}${Number(entry.offsetHours)}h`:oldBubble.apply(this,arguments);};
  const oldDay=formatTimelineDayLabel;
  formatTimelineDayLabel=function(entry){return entry?.syntheticStorm?'Illustrative 24-hour storm':oldDay.apply(this,arguments);};
  const oldDays=renderTimelineDays;
  renderTimelineDays=function(){
    if(currentDataMode!=='return-interval')return oldDays.apply(this,arguments);
    const wrap=document.getElementById('timelineDayTabs');wrap.replaceChildren();
    const button=document.createElement('button');button.type='button';button.className='timeline-day active';button.textContent='Illustrative 24-hour storm';button.style.flex='1';
    const gradient=buildTimelineGroupGradient(0,currentSeriesHours.length-1);if(gradient)button.style.backgroundImage=gradient;
    button.addEventListener('click',()=>renderHour(getPeakHourIndex(currentSeriesHours)));wrap.append(button);
  };
  const oldDownload=getDownloadSourceEntries;
  getDownloadSourceEntries=function(){if(currentDataMode==='return-interval')return currentRawSeriesHours.map(e=>({...e,exportSourceMode:'return-interval'}));return oldDownload.apply(this,arguments);};
  const oldSetParcels=setParcelsEnabled;
  setParcelsEnabled=async function(){const result=await oldSetParcels.apply(this,arguments);updateExportParcelsLayer();return result;};
  const oldHistory=openFloodHistoryPane;
  openFloodHistoryPane=async function(feature){
    const p=feature?.properties;
    if(p?.elevationNavd88Ft==null&&getNsiFirstOccupiedFloorNavd88(p)==null){toast('No local terrain or modeled floor estimate is available for this parcel.');return;}
    await oldHistory.apply(this,arguments);
    const notice=document.getElementById('floodHistoryProvenance');
    if(notice)notice.textContent='Screening estimates from Sea Bright hourly gauge maxima (2007–2026), local terrain and USACE modeled foundations, with NOAA 2022 Sandy Hook sea-level scenarios. The 95% band reflects sampling variation only. It excludes floor, terrain, sea-level-scenario and hydraulic uncertainty. Gauge exceedance does not prove water reached this property.';
  };
  for(const [id,handler]of [['buildingsToggle',setBuildingsEnabled],['parcelsToggle',setParcelsEnabled],['nsiStructuresToggle',setNsiStructuresEnabled]]){
    const toggle=document.getElementById(id);
    const act=()=>{const requested=!toggle.classList.contains('on');const current=id==='buildingsToggle'?setBuildingsEnabled:id==='parcelsToggle'?setParcelsEnabled:setNsiStructuresEnabled;Promise.resolve(current(requested)).catch(error=>{toggle.classList.remove('on');toggle.setAttribute('aria-checked','false');toast(error.message);});};
    toggle.addEventListener('click',act);toggle.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();act();}});
  }
  document.getElementById('returnIntervalDataBtn').addEventListener('click',()=>switchDataMode('return-interval').catch(e=>toast(e.message)));
  for(const button of document.querySelectorAll('[data-return-years]'))button.addEventListener('click',()=>switchReturnInterval(Number(button.dataset.returnYears)).catch(e=>toast(e.message)));
  document.getElementById('mapClickBuildingBtn')?.addEventListener('click',()=>setMapClickMode('building'));
  document.getElementById('mapClickDepthBtn')?.addEventListener('click',()=>setMapClickMode('depth'));
  const notice=document.createElement('p');notice.id='modeledFloodNotice';notice.className='modeled-flood-notice';notice.textContent='NACCS 2015 still-water levels · nearby Sandy Hook Bay station 11544. Illustrative 24-hour shape; duration is not modeled. These scenarios are not forecasts.';document.getElementById('returnIntervalCard').append(notice);
  document.getElementById('returnIntervalHelpBtn').addEventListener('click',event=>{
    event.stopPropagation();setInfoModalOpen(true,'Modeled flood scenarios','<p>Published USACE NACCS 2015 still-water return levels from Sandy Hook Bay save point 11544 beside Highlands. A 100-year return period describes a long-term average exceedance rate, not a promise of one event every 100 years.</p><p>The 24-hour rise and fall is illustrative, with the crest set to the published level. Its duration and shape do not have a return period. These are screening scenarios, not forecasts or a new validated local hydraulic simulation.</p><p>Levels above the raster catalog’s 14 ft NAVD88 maximum retain their numerical value, but the map stops at the published raster limit.</p>');
  });
  for(const button of document.querySelectorAll('[data-export-interval]'))button.addEventListener('click',()=>{
    document.getElementById('downloadIntervalSelect').value=button.dataset.exportInterval;updateExportSegmentedUI();scheduleExportTimePickerRender(true);updateDownloadSummary();
  });
  wireFloodHistoryPane();wireMapperTutorial();updateMapClickModeControl();updateDataModeButtons();
  document.body.dataset.highlandsModern='20261016';
}

// PNG dimensions are defined by the selected layout; avoid multiplying them a second time by display DPI.
function getExportCaptureScale() {
  if(getDownloadFormatValue()==='png')return 1;
  const dpr=Number(window.devicePixelRatio)||1;
  return Math.max(1,Math.min(EXPORT_CAPTURE_SCALE,dpr>1?dpr:EXPORT_CAPTURE_SCALE));
}
