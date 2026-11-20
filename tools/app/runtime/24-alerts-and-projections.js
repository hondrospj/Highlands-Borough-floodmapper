    function formatLocalBannerTime(value) {
      if (!value) return "";
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return "";
      return formatFixedESTFromUtc(d.toISOString());
    }

    async function checkNwsAlerts() {
      if (TOWN_CONFIG?.alerts?.enabled === false) {
        setBanner(false);
        document.body.dataset.nwsAlertState = "disabled";
        return "disabled";
      }
      if (nwsAlertPromise) return nwsAlertPromise;
      nwsAlertPromise = (async () => {
        const zoneCodes = new Set((TOWN_CONFIG?.alerts?.zoneCodes || []).filter(Boolean).map(String));
        let incomplete = false;
        if (NWS_POINT_URL) {
          try {
            const point = await fetchJson(NWS_POINT_URL, { timeoutMs: 15000 });
            [point?.properties?.forecastZone, point?.properties?.county].forEach(url => {
              const code = String(url || "").split("/").pop();
              if (code) zoneCodes.add(code);
            });
          } catch (error) {
            incomplete = true;
            // A failed point lookup can still refresh zones discovered earlier.
            for (const zoneCode of lastSuccessfulNwsAlerts?.byZone?.keys() || []) zoneCodes.add(zoneCode);
          }
        }
        const allFeatures = [];
        const cachedFeatures = [];
        const byZone = new Map();
        await Promise.all(Array.from(zoneCodes, async zoneCode => {
          try {
            const alerts = await fetchJson(`https://api.weather.gov/alerts/active?zone=${encodeURIComponent(zoneCode)}`,
              { timeoutMs: 15000 });
            if (!Array.isArray(alerts?.features)) throw new Error("Invalid alert response");
            byZone.set(zoneCode, alerts.features);
            allFeatures.push(...alerts.features);
          } catch (error) {
            incomplete = true;
            const cached = lastSuccessfulNwsAlerts?.byZone?.get(zoneCode);
            if (cached) {
              byZone.set(zoneCode, cached);
              cachedFeatures.push(...cached);
            }
          }
        }));
        // Only failed zones reuse cached alerts. A healthy empty response is
        // authoritative for its own zone; fresh copies win across zone overlap.
        const candidates = allFeatures.concat(cachedFeatures);
        const now = Date.now();
        const seen = new Set();
        const floodAlerts = candidates.filter(feature => {
          const id = String(feature?.id || feature?.properties?.id || "");
          if (id && seen.has(id)) return false;
          if (id) seen.add(id);
          const expires = Date.parse(feature?.properties?.expires || "");
          if (Number.isFinite(expires) && expires <= now) return false;
          return /(coastal flood|storm surge|lakeshore flood|flood warning|flood watch|flood advisory)/i.test(feature?.properties?.event || "");
        });
        const alertPriority = feature => /warning/i.test(feature?.properties?.event || "") ? 3
          : /watch/i.test(feature?.properties?.event || "") ? 2 : 1;
        floodAlerts.sort((a, b) => alertPriority(b) - alertPriority(a));
        const unavailable = incomplete || !zoneCodes.size;
        if (byZone.size || lastSuccessfulNwsAlerts) {
          lastSuccessfulNwsAlerts = { features: floodAlerts, byZone,
            checkedAt: unavailable ? lastSuccessfulNwsAlerts?.checkedAt : new Date().toISOString() };
        }
        const shown = floodAlerts;
        const state = unavailable ? (lastSuccessfulNwsAlerts?.checkedAt || shown.length ? "stale" : "unavailable") : shown.length ? "active" : "none";
        document.body.dataset.nwsAlertState = state;
        const primary = shown[0]?.properties || {};
        const checked = lastSuccessfulNwsAlerts?.checkedAt;
        const meta = unavailable
          ? `Alert updates unavailable${checked ? "; last checked " + formatLocalBannerTime(checked) : ". Please check weather.gov"}`
          : [primary.severity, primary.expires ? `Until ${formatLocalBannerTime(primary.expires)}` : ""].filter(Boolean).join(" • ");
        setBanner(unavailable || shown.length > 0, primary.event || (unavailable ? "Flood alert status unavailable" : "No active flood alerts"), meta, shown.length);
        const countLabel = document.getElementById("bannerCount");
        if (unavailable && countLabel) countLabel.textContent = shown.length ? `${shown.length} last reported` : "Status unknown";
        return state;
      })().finally(() => { nwsAlertPromise = null; });
      return nwsAlertPromise;
    }

    function startNwsAlertRefresh() {
      if (nwsAlertRefreshTimer !== null) window.clearInterval(nwsAlertRefreshTimer);
      nwsAlertRefreshTimer = null;
      if (TOWN_CONFIG?.alerts?.enabled === false) { setBanner(false); return; }
      checkNwsAlerts().catch(error => console.warn("Flood alert refresh failed.", error));
      nwsAlertRefreshTimer = window.setInterval(() => {
        checkNwsAlerts().catch(error => console.warn("Flood alert refresh failed.", error));
      }, 5 * 60 * 1000);
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

    const FLOOD_PROJECTION_SCENARIOS = {
      observedTrend: { label: "Existing trend", color: "#e2e8f0" },
      low: { label: "NOAA Low", color: "#2dd4bf" },
      intermediateLow: { label: "NOAA Int. Low", color: "#38bdf8" },
      intermediate: { label: "NOAA Intermediate", color: "#facc15" },
      intermediateHigh: { label: "NOAA Int. High", color: "#fb923c" },
      high: { label: "NOAA High", color: "#fb7185" }
    };
    let selectedFloodProjectionScenario = "intermediate";
    let floodHistoryRequest = 0;
    let parcelAreaStagesPromise = null;
    const PARCEL_PROJECTION_SHARES = [25, 50, 75];
    const pendingPropertyGestureUpdates = new WeakSet();

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
      let topPadding = mobilePopup ? 126 : 16;
      const bottomPadding = mobilePopup
        ? Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--shorely-mobile-timeline-height")) + 16 || 140
        : 16;
      let rightPadding = mobilePopup ? 10 : desktopRightRailWidth + 30;
      if (isHouseAlertPopup || isDepthQueryPopup || String(html).includes("nsi-structure-popup")) {
        const directionControl = document.getElementById("nwDefaultNavControl")?.getBoundingClientRect();
        if (directionControl?.width && directionControl.left >= viewportPopupWidth + 36) {
          rightPadding = Math.max(rightPadding, Math.ceil(window.innerWidth - directionControl.left + 12));
        } else if (mobilePopup && directionControl?.height &&
          directionControl.bottom + 64 <= window.innerHeight - bottomPadding) {
          // A wide card cannot fit to the left of the controls on a phone.
          topPadding = Math.max(topPadding, Math.ceil(directionControl.bottom + 12));
        }
      }
      const popup = L.popup({
        className: isDepthQueryPopup ? "shorely-flood-popup shorely-depth-popup" : "shorely-flood-popup",
        maxWidth: viewportPopupWidth,
        minWidth: 0,
        autoClose: false,
        closeOnClick: false,
        closeButton: true,
        keepInView: !document.body.classList.contains("map-3d-ready"),
        autoPan: !document.body.classList.contains("map-3d-ready"),
        autoPanPaddingTopLeft: L.point(mobilePopup ? 10 : 16, topPadding),
        autoPanPaddingBottomRight: L.point(rightPadding, bottomPadding)
      })
        .setLatLng(latlng)
        .setContent(html)
        .addTo(map);
      persistentFloodPopup = popup;
      document.body.classList.add("persistent-flood-popup-open");
      if (isHouseAlertPopup) wireShortLeafletPopup(popup);
      popup.once("remove", () => {
        if (persistentFloodPopup === popup) {
          persistentFloodPopup = null;
          persistentDepthQueryContext = null;
          document.body.classList.remove("persistent-flood-popup-open");
        }
      });
      return popup;
    }

    function wireShortLeafletPopup(popup) {
      const element = popup.getElement();
      const pane = element.parentElement;
      const app = document.getElementById("app");
      const shortLayout = window.matchMedia("(orientation:landscape) and (max-height:420px)");
      const autoPan = popup.options.autoPan;
      const content = element.querySelector(".leaflet-popup-content");
      function reveal(control) {
        if (!element.classList.contains("nw-short-leaflet-popup") || !content.contains(control) ||
            content.scrollHeight <= content.clientHeight) return;
        const top = content.getBoundingClientRect().top + content.clientTop;
        const bottom = top + content.clientHeight;
        const bounds = control.getBoundingClientRect();
        if (bounds.top < top) content.scrollTop += bounds.top - top - 4;
        else if (bounds.bottom > bottom) content.scrollTop += bounds.bottom - bottom + 4;
      }
      let anchorFrame = 0;
      function updateAnchor() {
        const compact = isCompactFloodmapperLayout();
        const dock = document.getElementById("timelineDock")?.getBoundingClientRect();
        const rail = document.getElementById("rightRail")?.getBoundingClientRect();
        const panel = document.getElementById("leftPanel")?.getBoundingClientRect();
        const right = Math.ceil(rail?.width || 0) + 30;
        const left = Math.ceil(panel?.right || 0) + 12;
        const fitsBetweenPanels = left + right + element.offsetWidth <= innerWidth;
        popup.options.autoPanPaddingTopLeft = compact ? L.point(10, 126) : L.point(fitsBetweenPanels ? left : 16, 16);
        popup.options.autoPanPaddingBottomRight = compact
          ? L.point(10, dock?.height ? innerHeight - dock.top + 8 : 140)
          : L.point(right, 16);
        popup.options.autoPan = autoPan;
        popup.setLatLng(popup.getLatLng());
      }
      let renderer3d = document.body.classList.contains("map-3d-ready");
      function sync(event) {
        if (renderer3d) {
          popup.options.autoPan = false;
          cancelAnimationFrame(anchorFrame);
          return;
        }
        const short = innerHeight <= 420 && innerWidth > innerHeight;
        const parent = short ? app : pane;
        if (short || event) {
          // Leaflet's moveend can run before the surrounding controls finish
          // their resize. Recompute padding after the new layout is in place.
          popup.options.autoPan = false;
          cancelAnimationFrame(anchorFrame);
          if (!short) anchorFrame = requestAnimationFrame(() => {
            anchorFrame = requestAnimationFrame(updateAnchor);
          });
        }
        if (element.parentElement === parent) {
          if (short) reveal(document.activeElement);
          return;
        }
        const focused = element.contains(document.activeElement) ? document.activeElement : null;
        // A short card needs its own scroll surface above the map controls.
        // Keep it in the app's modal-isolation branch and preserve its map anchor.
        element.classList.toggle("nw-short-leaflet-popup", short);
        parent.appendChild(element);
        if (focused && document.activeElement === document.body && !focused.closest("[inert]")) {
          focused.focus({ preventScroll: true });
        }
      }
      element.addEventListener("focusin", event => reveal(event.target));
      window.addEventListener("resize", sync, true);
      shortLayout.addEventListener("change", sync);
      const rendererObserver = new MutationObserver(() => {
        const ready = document.body.classList.contains("map-3d-ready");
        if (ready === renderer3d) return;
        renderer3d = ready;
        // A graphics fallback can return to Leaflet without a viewport resize.
        sync(true);
      });
      rendererObserver.observe(document.body, { attributeFilter: ["class"] });
      popup.once("remove", () => {
        rendererObserver.disconnect();
        cancelAnimationFrame(anchorFrame);
        window.removeEventListener("resize", sync, true);
        shortLayout.removeEventListener("change", sync);
      });
      sync();
    }

    function deferPropertyPopupUpdate(element, refresh) {
      const active = element?.querySelector(".house-alert-cta:active, .property-help summary:active");
      if (!active) return false;
      if (!pendingPropertyGestureUpdates.has(active)) {
        pendingPropertyGestureUpdates.add(active);
        const controller = new AbortController();
        const finish = () => {
          controller.abort();
          pendingPropertyGestureUpdates.delete(active);
          requestAnimationFrame(refresh);
        };
        for (const event of ["pointerup", "pointercancel", "keyup", "blur"]) {
          window.addEventListener(event, finish, { capture: true, signal: controller.signal });
        }
      }
      return true;
    }

    function updatePropertyPopup(popup, html) {
      if (popup.getContent() === html) return;
      const element = popup.getElement?.();
      const selector = ".house-alert-cta, .property-help summary";
      // Leave the control connected until its pointer or keyboard gesture ends.
      if (deferPropertyPopupUpdate(element, () => {
        if (persistentFloodPopup === popup) updatePersistentDepthQueryPopup();
      })) return;
      const controls = Array.from(element?.querySelectorAll(selector) || []);
      const focusedIndex = controls.indexOf(document.activeElement);
      const helpOpen = element?.querySelector(".property-help")?.open;
      popup.setContent(html);
      popup.update();
      if (element?.isConnected) {
        const help = element.querySelector(".property-help");
        if (help) help.open = Boolean(helpOpen);
        element.querySelectorAll(selector)[focusedIndex]?.focus({ preventScroll: true });
      }
    }

    function buildHouseAlertPopup(feature) {
      const p = feature?.properties || {};
      const firstFloor = getNsiFirstOccupiedFloorNavd88(p);
      const crawlspaceDepth = Number(p.foundationHeightFt ?? p.nsi2026FoundationHeightFt);
      const stage = getSelectedStageNavd88();
      const difference = Number.isFinite(stage) && Number.isFinite(firstFloor) ? stage - firstFloor : null;
      const address = escapeTownAddressHtml(p.address || `Selected ${TOWN_CONFIG.site.name} parcel`);
      const focusRestoreKey = p.parcelId == null ? "" : ` data-focus-restore-key="${escapeTownAddressHtml("parcel-profile:" + p.parcelId)}"`;
      const waterStatus = !Number.isFinite(firstFloor)
        ? ""
        : difference == null
        ? "Choose a water level to compare."
        : Math.abs(difference) <= 0.1
          ? "Current water is at the estimated occupied floor."
          : difference > 0
            ? `Current water is ${formatWaterDepth(difference, 1)} above the estimated occupied floor.`
            : `Current water is ${formatWaterDepth(Math.abs(difference), 1)} below the estimated occupied floor.`;
      return '<div class="house-alert-popup building-info-card">' +
        '<span class="house-alert-kicker">Building</span>' +
        '<h3>' + address + '</h3>' +
        '<div class="building-info-facts">' +
          '<div><span>Crawlspace / garage depth</span><strong>' +
            (Number.isFinite(crawlspaceDepth) ? formatWaterDepth(crawlspaceDepth, 1) : 'Not available') +
          '</strong></div>' +
          (waterStatus ? '<p>' + escapeTownAddressHtml(waterStatus) + '</p>' : '') +
        '</div>' +
        '<button class="house-alert-cta" type="button"' + focusRestoreKey + '>See Flood History &amp; Projections</button>' +
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

    function hasValidFloodProjectionData(data) {
      if (!/flood-history-projections-v4$/.test(String(data?.schema || ""))) return false;
      const { years, elevationGridFtNavd88: elevations, historicFloodEventCountByElevation: historic, scenarioOrder } = data;
      const increasing = (values, valid) => Array.isArray(values) && values.length > 0 &&
        values.every((value, index) => valid(value) && (index === 0 || value > values[index - 1]));
      const minimumDepth = data.floodDefinition?.minimumDepthFt;
      const maximumCount = data.independentTidesPerYear;
      if (!increasing(years, Number.isInteger) || !increasing(elevations, Number.isFinite) ||
          !Number.isFinite(minimumDepth) || minimumDepth < 0 || !Number.isFinite(maximumCount) || maximumCount <= 0 ||
          !Array.isArray(historic) || historic.length !== elevations.length ||
          !historic.every((count, index) => Number.isInteger(count) && count >= 0 && (index === 0 || count <= historic[index - 1])) ||
          !Array.isArray(scenarioOrder) || !scenarioOrder.length || new Set(scenarioOrder).size !== scenarioOrder.length) return false;
      return scenarioOrder.every(key => {
        if (typeof key !== "string" || !key || !Object.hasOwn(data.annualFloodEventCount || {}, key)) return false;
        const record = data.annualFloodEventCount[key];
        return ["estimate", "lower95", "upper95"].every(band => {
          const rows = record?.[band];
          return Array.isArray(rows) && rows.length === elevations.length && rows.every(row =>
            Array.isArray(row) && row.length === years.length &&
            row.every(count => Number.isFinite(count) && count >= 0 && count <= maximumCount));
        }) && record.lower95.every((row, i) => row.every((count, j) => count <= record.upper95[i][j]));
      });
    }

    async function ensureFloodProjectionData() {
      if (houseAlertCdfData) return houseAlertCdfData;
      if (!HOUSE_ALERT_CDF_URL) throw new Error("Flood projection data is not configured.");
      if (!houseAlertCdfPromise) {
        houseAlertCdfPromise = fetchJson(HOUSE_ALERT_CDF_URL, { cache: "no-cache" })
          .then(payload => {
            if (!hasValidFloodProjectionData(payload)) {
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
      ++floodHistoryRequest;
      const backdrop = document.getElementById("floodHistoryBackdrop");
      if (!backdrop) return;
      backdrop.hidden = true;
      backdrop.setAttribute("aria-hidden", "true");
      backdrop.querySelector(".property-help")?.removeAttribute("open");
      document.body.classList.remove("flood-history-open");
    }

    function hasValidParcelProjectionData(data) {
      const validTable = (table, width) => {
        if (!table || typeof table !== "object" || Array.isArray(table)) return false;
        const rows = Object.values(table);
        return rows.length > 0 && rows.every(row => Array.isArray(row) && row.length === width &&
          row.every(value => value === null || Number.isInteger(value)));
      };
      if (data?.schema !== "north-wildwood-parcel-area-stages-v1" ||
          data.catalogVersion !== OVERLAY_CACHE_VERSIONS.hydraulic ||
          !Array.isArray(data.sharesPercent) || data.sharesPercent.length !== PARCEL_PROJECTION_SHARES.length ||
          !PARCEL_PROJECTION_SHARES.every((share, i) => data.sharesPercent[i] === share) ||
          !validTable(data.stagesInTenthsFtNavd88, PARCEL_PROJECTION_SHARES.length)) return false;
      if (data.endpointSharesPercent == null && data.endpointStagesInTenthsFtNavd88 == null) return true;
      const endpoints = data.endpointStagesInTenthsFtNavd88;
      const parcelIds = Object.keys(data.stagesInTenthsFtNavd88);
      return Array.isArray(data.endpointSharesPercent) && data.endpointSharesPercent.length === 2 &&
        data.endpointSharesPercent[0] === 0 && data.endpointSharesPercent[1] === 100 &&
        validTable(endpoints, 2) && Object.keys(endpoints).length === parcelIds.length &&
        parcelIds.every(id => Object.hasOwn(endpoints, id));
    }

    async function getParcelProjectionOptions(feature, data) {
      if (!PARCEL_AREA_STAGES_URL) return [];
      if (!parcelAreaStagesPromise) {
        parcelAreaStagesPromise = fetchJson(PARCEL_AREA_STAGES_URL, { cache: "no-cache" })
          .then(payload => {
            if (!hasValidParcelProjectionData(payload)) {
              throw new Error("The parcel-area projection dataset needs to be refreshed.");
            }
            return payload;
          }).catch(error => {
            parcelAreaStagesPromise = null;
            throw error;
          });
      }
      const payload = await parcelAreaStagesPromise;
      if (payload.catalogVersion !== OVERLAY_CACHE_VERSIONS.hydraulic) {
        parcelAreaStagesPromise = null;
        throw new Error("The parcel-area projection dataset needs to be refreshed.");
      }
      const stages = payload.stagesInTenthsFtNavd88?.[String(feature.id)];
      if (!Array.isArray(stages)) return [];
      const endpoints = payload.endpointSharesPercent?.length === 2 &&
        payload.endpointSharesPercent[0] === 0 && payload.endpointSharesPercent[1] === 100
        ? payload.endpointStagesInTenthsFtNavd88?.[String(feature.id)] : null;
      const thresholds = [
        [0, endpoints?.[0]],
        ...PARCEL_PROJECTION_SHARES.map((share, index) => [share, stages[index]]),
        [100, endpoints?.[1]]
      ];
      const minimumDepth = Number(data.floodDefinition?.minimumDepthFt);
      return thresholds.map(([share, stageTenths]) => {
        const stage = Number.isInteger(stageTenths) ? stageTenths / 10 : null;
        // Existing CDF rows use gauge level > elevation + minimum depth.
        const elevationIndex = stage == null ? -1 : data.elevationGridFtNavd88.findIndex(
          value => Math.abs(Number(value) + minimumDepth - stage) < 1e-6);
        return { share, stage, elevationIndex };
      });
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

    function renderFloodHistoryProjection(feature, data, parcelOptions = null, selectedShare = null, yearIndex = null) {
      const body = document.getElementById("floodHistoryBody");
      if (!body) return;
      const p = feature?.properties || {};
      const years = Array.isArray(data.years) ? data.years : [];
      const supportedParcelOptions = parcelOptions?.filter(option => option.elevationIndex >= 0);
      const parcelOption = supportedParcelOptions?.find(option => option.share === selectedShare) ??
        supportedParcelOptions?.find(option => option.share > 0 && option.share < 100) ??
        supportedParcelOptions?.[0];
      if (parcelOptions && !parcelOption) {
        body.innerHTML = '<div class="flood-history-error">Parcel-area projections are unavailable within the model’s coverage.</div>';
        return;
      }
      const elevationIndex = parcelOption?.elevationIndex ?? findProjectionElevationIndex(feature, data);
      const firstFloor = getNsiFirstOccupiedFloorNavd88(p);
      const hasModeledFloor = Number.isFinite(firstFloor);
      const historic = finiteStructureNumber(parcelOption ? data.historicFloodEventCountByElevation?.[elevationIndex] : hasModeledFloor
        ? p.nsi2026HistoricFirstFloorExceedanceCount
        : p.historicFloodEventCount);
      const defaultYearIndex = yearIndex ?? Math.max(0, years.indexOf(2050));
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
            <span>${parcelOption ? "Past Tides Above Area Threshold" : hasModeledFloor ? "Past Floods Above Floor" : "Past Floods at Parcel"}</span>
            <strong>${Number.isFinite(historic) ? historic.toLocaleString() : "—"}</strong>
          </div>
          <div class="flood-summary-item">
            <span>${parcelOption ? "Estimated Area Threshold" : hasModeledFloor ? "Estimated Occupied Floor" : "Parcel Ground"}</span>
            <strong>${parcelOption ? parcelOption.stage.toFixed(1) : hasModeledFloor ? firstFloor.toFixed(1) : Number(p.elevationNavd88Ft).toFixed(1)} <small>ft NAVD88</small></strong>
          </div>
        </div>
        <section class="flood-history-section">
          <div class="flood-history-section-head">
            <h3>${parcelOption ? "Future Floods by Parcel Area" : hasModeledFloor ? "Future Floods Above Floor" : "Future Floods at Parcel"}</h3>
            ${parcelOption ? `<label class="flood-scenario-field flood-area-field">
              Flooded area
              <select id="floodProjectionAreaSelect" class="flood-scenario-select">
                ${parcelOptions.map(option => {
                  const label = option.share === 0 ? "Any Flooding (&gt;0%)"
                    : option.share === 100 ? "Entire Parcel (100%)" : `At least ${option.share}%`;
                  const available = option.elevationIndex >= 0;
                  const state = !available ? " disabled" : option === parcelOption ? " selected" : "";
                  return `<option value="${option.share}"${state}>${label}${available ? "" : " (unavailable)"}</option>`;
                }).join("")}
              </select>
            </label>` : ""}
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
          <div class="flood-projection-layout">
            <div id="floodProjectionChart">${renderProjectionChart(data, selectedFloodProjectionScenario, elevationIndex, defaultYearIndex)}</div>
            <ul class="flood-projection-key" aria-label="Projection key">
              <li><i class="projection-key-line" aria-hidden="true"></i>Floods per year</li>
              <li><i class="projection-key-band" aria-hidden="true"></i>95% range</li>
            </ul>
          </div>
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
      const currentYearIndex = () => Number(document.getElementById("floodProjectionYearSlider")?.value ?? defaultYearIndex);
      document.getElementById("floodProjectionScenarioSelect")?.addEventListener("change", event => {
        selectedFloodProjectionScenario = event.target.value;
        renderFloodHistoryProjection(feature, data, parcelOptions, parcelOption?.share, currentYearIndex());
        document.getElementById("floodProjectionScenarioSelect")?.focus({ preventScroll: true });
      });
      document.getElementById("floodProjectionAreaSelect")?.addEventListener("change", event => {
        renderFloodHistoryProjection(feature, data, parcelOptions, Number(event.target.value), currentYearIndex());
        document.getElementById("floodProjectionAreaSelect")?.focus({ preventScroll: true });
      });
    }

    async function openFloodHistoryPane(feature, kind = "building", opener) {
      if (!feature) return;
      const request = ++floodHistoryRequest;
      selectedParcelFeature = feature;
      const backdrop = document.getElementById("floodHistoryBackdrop");
      const body = document.getElementById("floodHistoryBody");
      const address = document.getElementById("floodHistoryAddress");
      if (!backdrop || !body) return;
      const parcel = kind === "parcel";
      const properties = feature.properties || {};
      address.textContent = properties.address || `Selected ${TOWN_CONFIG.site.name} parcel`;
      document.getElementById("floodHistoryTitle").textContent = parcel ? "Parcel Flood Projections" : "Flood History & Projections";
      const help = document.getElementById("floodHistoryHelpText");
      help.textContent = parcel
        ? "Any Flooding means water covers more than 0% of the parcel. Projections include water already inside the parcel and require a threshold within the model’s range."
        : Number.isFinite(getNsiFirstOccupiedFloorNavd88(properties))
          ? "Past tides show how often water rose above the estimated floor. Future estimates show how that could change as sea level rises."
          : "Past tides and future estimates use parcel ground elevation.";
      body.innerHTML = '<div class="flood-history-loading" aria-hidden="true"></div>';
      backdrop.hidden = false;
      backdrop.setAttribute("aria-hidden", "false");
      document.body.classList.add("flood-history-open");
      if (opener) document.dispatchEvent(new CustomEvent("nww:modalchange", { detail: { opener } }));
      document.getElementById("floodHistoryCloseBtn")?.focus({ preventScroll: true });
      try {
        const data = await ensureFloodProjectionData();
        const parcelOptions = parcel ? await getParcelProjectionOptions(feature, data) : null;
        if (request === floodHistoryRequest && !backdrop.hidden) {
          const archive = data.observedArchive || {};
          const start = parcel ? archive.startDate : properties.historicStartDate || archive.startDate;
          const end = parcel ? archive.endDate : properties.historicEndDate || archive.endDate;
          const dates = [start, end].map(date => {
            const parsed = new Date(`${date}T00:00:00Z`);
            return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date
              ? formatSelectedObservedDate(date) : "";
          });
          if (dates.every(Boolean)) help.textContent += ` Historical counts cover ${dates[0]} through ${dates[1]}.`;
          renderFloodHistoryProjection(feature, data, parcelOptions);
        }
      } catch (error) {
        if (request === floodHistoryRequest && !backdrop.hidden) {
          body.innerHTML = `<div class="flood-history-error"><strong>This projection could not be loaded.</strong><br>${escapeTownAddressHtml(error?.message || "Please try again in a moment.")}</div>`;
        }
      }
    }

    function wireFloodHistoryPane() {
      const backdrop = document.getElementById("floodHistoryBackdrop");
      document.getElementById("floodHistoryCloseBtn")?.addEventListener("click", closeFloodHistoryPane);
      backdrop?.addEventListener("click", event => {
        if (event.target === backdrop) closeFloodHistoryPane();
      });
      document.addEventListener("click", event => {
        const button = event.target?.closest?.(".house-alert-cta");
        if (button && selectedParcelFeature) openFloodHistoryPane(selectedParcelFeature, button.dataset.propertyProfile, button);
      });
      document.addEventListener("keydown", event => {
        if (event.key === "Escape" && backdrop && !backdrop.hidden) closeFloodHistoryPane();
      });
    }

