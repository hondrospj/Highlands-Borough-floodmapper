    function wireLayerToggles() {
      for (const [id, mode] of [["mapClickBuildingBtn", "building"], ["mapClickParcelBtn", "parcel"], ["mapClickDepthBtn", "depth"]]) {
        document.getElementById(id)?.addEventListener("click", () => {
          if (cancelPendingTownAddressLookup()) setTownAddressStatus("");
          setMapClickMode(mode);
        });
      }
      document.getElementById("structuralImpactsKeyClose")?.addEventListener("click", () => {
        document.getElementById("structuralImpactsKey").hidden = true;
        document.getElementById("timelineDock")?.querySelector("#playBtn")?.focus({ preventScroll: true });
      });
      ["roadsToggle"].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        const toggleLayer = () => {
          el.classList.toggle("on");
          el.setAttribute("aria-checked", String(el.classList.contains("on")));
          if (id === "roadsToggle") updateRoadLayerAppearance({ retry3dRoads: el.classList.contains("on") });
        };
        el.addEventListener("click", toggleLayer);
        el.addEventListener("keydown", event => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            toggleLayer();
          }
        });
      });
      const satelliteToggle = document.getElementById("satelliteToggle");
      const toggleSatellite = () => {
        setSatelliteEnabled(!satelliteToggle?.classList.contains("on"));
      };
      satelliteToggle?.addEventListener("click", toggleSatellite);
      satelliteToggle?.addEventListener("keydown", event => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          toggleSatellite();
        }
      });
      const buildingsToggle = document.getElementById("buildingsToggle");
      const toggleBuildings = () => {
        ++townAddressBuildingChoiceGeneration;
        const enabled = !buildingsToggle?.classList.contains("on");
        setBuildingsEnabled(enabled).catch(error => {
          setBuildingsEnabled(false, { rollback: true }).catch(() => {});
          toast(error?.message || "Buildings could not be loaded.");
        });
      };
      buildingsToggle?.addEventListener("click", toggleBuildings);
      buildingsToggle?.addEventListener("keydown", event => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          toggleBuildings();
        }
      });
      const parcelsToggle = document.getElementById("parcelsToggle");
      const toggleParcels = () => {
        const enabled = !parcelsToggle.classList.contains("on");
        setParcelsEnabled(enabled).catch(err => {
          setParcelsEnabled(false);
          toast(err.message || "Parcels could not be loaded.");
        });
      };
      parcelsToggle?.addEventListener("click", toggleParcels);
      parcelsToggle?.addEventListener("keydown", event => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          toggleParcels();
        }
      });
      const nsiStructuresToggle = document.getElementById("nsiStructuresToggle");
      const toggleNsiStructures = () => {
        const enabled = !nsiStructuresToggle?.classList.contains("on");
        setNsiStructuresEnabled(enabled).catch(error => {
          setNsiStructuresEnabled(false).catch(() => {});
          toast(error?.message || "USACE NSI 2026 structures could not be loaded.");
        });
      };
      nsiStructuresToggle?.addEventListener("click", toggleNsiStructures);
      nsiStructuresToggle?.addEventListener("keydown", event => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          toggleNsiStructures();
        }
      });
    }


    function ensureMobileControlShell() {
      let toggle = document.getElementById("mobileControlsToggle");
      if (!toggle) {
        toggle = document.createElement("button");
        toggle.id = "mobileControlsToggle";
        toggle.type = "button";
        toggle.innerHTML = '<span class="mobile-controls-icon" aria-hidden="true"><i></i><i></i><i></i></span>';
        toggle.setAttribute("aria-label", "Open controls");
        toggle.setAttribute("title", "Open controls");
        toggle.setAttribute("aria-controls", "leftPanel");
        toggle.setAttribute("aria-expanded", "false");
        document.body.appendChild(toggle);
      }

      let backdrop = document.getElementById("mobileDrawerBackdrop");
      if (!backdrop) {
        backdrop = document.createElement("div");
        backdrop.id = "mobileDrawerBackdrop";
        backdrop.setAttribute("aria-hidden", "true");
        document.body.appendChild(backdrop);
      }

      let mobileRailMount = document.getElementById("mobileRailMount");
      if (!mobileRailMount) {
        mobileRailMount = document.createElement("div");
        mobileRailMount.id = "mobileRailMount";
      }

      let closeBtn = document.getElementById("mobileControlsClose");
      if (!closeBtn) {
        closeBtn = document.createElement("button");
        closeBtn.id = "mobileControlsClose";
        closeBtn.type = "button";
        closeBtn.innerHTML = "&times;";
        closeBtn.className = "centered-close-control";
        closeBtn.setAttribute("aria-label", "Close controls");
        closeBtn.setAttribute("title", "Close controls");
      }
      // Bind both the initial HTML button and any replacement made on resize.
      if (closeBtn.dataset.mobileCloseWired !== "1") {
        closeBtn.dataset.mobileCloseWired = "1";
        closeBtn.addEventListener("click", event => {
          event.preventDefault();
          event.stopPropagation();
          setMobileControlsOpen(false);
        });
      }


      return { toggle, backdrop, mobileRailMount, closeBtn };
    }

    function setMobileControlsOpen(isOpen) {
      const open = Boolean(isOpen);
      document.body.classList.toggle("mobile-controls-open", open);
      const toggle = document.getElementById("mobileControlsToggle");
      if (toggle) {
        toggle.setAttribute("aria-expanded", String(open));
        toggle.innerHTML = '<span class="mobile-controls-icon" aria-hidden="true"><i></i><i></i><i></i></span>';
        toggle.setAttribute("aria-label", open ? "Close controls" : "Open controls");
        toggle.setAttribute("title", open ? "Close controls" : "Open controls");
      }
      setTimeout(() => {
        if (map) {
          map.invalidateSize();
          updateColorBasemapClip();
        }
        positionTimelineBubble();
        fitSnapshotTimeText();
      }, 80);
    }

    function syncMobileControlsLayout() {
      const isMobile = isCompactFloodmapperLayout();
      const leftPanel = document.getElementById("leftPanel");
      const rightRail = document.getElementById("rightRail");
      const app = document.getElementById("app");
      if (!leftPanel || !rightRail || !app) return;
      const wasMobile = document.body.classList.contains("mobile-optimized");
      const focused = document.activeElement;
      const movingFocus = wasMobile !== isMobile && (leftPanel.contains(focused) || rightRail.contains(focused));

      const { mobileRailMount, closeBtn } = ensureMobileControlShell();

      if (isMobile) {
        document.body.classList.add("mobile-optimized");
        if (!wasMobile) {
          leftPanel.scrollTop = 0;
          rightRail.scrollTop = 0;
        }
        const mobileCloseBtn = document.getElementById("mobileControlsClose") || closeBtn;
        if (mobileCloseBtn && mobileCloseBtn.parentNode !== leftPanel) {
          leftPanel.insertBefore(mobileCloseBtn, leftPanel.firstChild);
        }
        if (!mobileRailMount.parentNode) leftPanel.appendChild(mobileRailMount);
        Array.from(rightRail.children).forEach(node => mobileRailMount.appendChild(node));

      } else {
        document.body.classList.remove("mobile-optimized");
        document.body.classList.remove("mobile-legend-open");
        setMobileControlsOpen(false);
        if (wasMobile) {
          leftPanel.scrollTop = 0;
          rightRail.scrollTop = 0;
        }

        const mobileCloseBtn = document.getElementById("mobileControlsClose");
        if (mobileCloseBtn && mobileCloseBtn.parentNode === leftPanel) {
          leftPanel.removeChild(mobileCloseBtn);
        }

        Array.from(mobileRailMount.children).forEach(node => {
          rightRail.appendChild(node);
        });

        if (mobileRailMount.parentNode) mobileRailMount.parentNode.removeChild(mobileRailMount);
      }
      syncLegendPlacement();
      // Wait for the unified layout and modal isolation to release the moved control.
      if (movingFocus) requestAnimationFrame(() => requestAnimationFrame(() => {
        if (document.activeElement !== document.body || isMobile !== isCompactFloodmapperLayout()) return;
        const target = isMobile ? document.getElementById("mobileControlsToggle") : focused;
        if (target?.getClientRects().length && !target.closest("[inert]")) target.focus();
      }));
    }

    function wireMobileControlShell() {
      const { toggle, backdrop } = ensureMobileControlShell();
      toggle.addEventListener("click", () => {
        setMobileControlsOpen(!document.body.classList.contains("mobile-controls-open"));
      });
      backdrop.addEventListener("click", () => setMobileControlsOpen(false));
      document.addEventListener("keydown", e => {
        if (e.key === "Escape" && !e.defaultPrevented && !document.body.hasAttribute("data-floodmapper-unified")) {
          setMobileControlsOpen(false);
        }
      });
      document.addEventListener("click", e => {
        if (!document.body.classList.contains("mobile-controls-open")) return;
        const target = e.target;
        const toggleBtn = document.getElementById("mobileControlsToggle");
        if (toggleBtn?.contains(target)) return;
      }, false);
      syncMobileControlsLayout();
    }

    function syncLegendPlacement() {
      if(document.body.hasAttribute("data-floodmapper-unified")) return;
      if(document.body.hasAttribute("data-floodmapper-reference")) return;
      if(document.body.hasAttribute("data-county-viewport")) return;
      const legend = document.getElementById("legendDock");
      const panel = document.getElementById("leftPanel");
      if (!legend || !panel) return;
      legend.classList.add("panel-card", "compact-card", "left-lower-legend-card");
      legend.classList.remove("map-floating", "legend-floating-user", "legend-collapsed", "legend-expanded");
      if (isCompactFloodmapperLayout()) {
        if (legend.parentElement !== document.body) document.body.appendChild(legend);
      } else {
        const interval = document.getElementById("timelineIntervalCard");
        const next = interval?.parentElement === panel ? interval.nextSibling : null;
        if (legend.parentElement !== panel || (next && next !== legend)) panel.insertBefore(legend, next);
      }
    }

    function escapeTownAddressHtml(value) {
      return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function getTownAddressConfig() {
      return TOWN_CONFIG?.addressLookup || {};
    }

    function getTownAddressDisplayName() {
      return getTownAddressConfig().displayName || TOWN_CONFIG?.site?.name || "this town";
    }

    function setTownAddressStatus(message = "", type = "") {
      const status = document.getElementById("townAddressStatus");
      if (!status) return;
      status.textContent = message;
      status.classList.toggle("error", type === "error");
      status.classList.toggle("success", type === "success");
    }

    let townAddressLookupController = null;
    let townAddressPopup = null;
    let townAddressBuildingChoiceGeneration = 0;

    function cancelPendingTownAddressLookup() {
      if (!townAddressLookupController) return false;
      ++townAddressSearchGeneration;
      townAddressLookupController.abort();
      townAddressLookupController = null;
      const button = document.getElementById("townAddressSearchBtn");
      if (button) button.disabled = false;
      return true;
    }

    function clearTownAddressLookup() {
      cancelPendingTownAddressLookup();
      const input = document.getElementById("townAddressInput");
      if (input) input.value = "";
      setTownAddressStatus("");
      if (townAddressMarker && map && map.hasLayer(townAddressMarker)) {
        map.removeLayer(townAddressMarker);
      }
      townAddressMarker = null;
      window.NORTH_WILDWOOD_3D?.setAddressMarker?.(null);
      townAddressPopup?.remove();
      input?.focus();
    }

    function escapeRegExp(value) {
      return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    function normalizeTownAddressQuery(value) {
      const cfg = getTownAddressConfig();
      const trailingTerms = [
        cfg.displayName,
        TOWN_CONFIG?.site?.name,
        TOWN_CONFIG?.site?.municipalityName,
        cfg.city,
        cfg.state,
        cfg.stateName,
        cfg.postalCode
      ].filter(Boolean).map(escapeRegExp).join("|");
      let cleaned = String(value || "").replace(/\s+/g, " ").trim();
      if (trailingTerms) {
        cleaned = cleaned.replace(new RegExp(`,?\\s*(${trailingTerms})(\\s*,?\\s*(${trailingTerms}))*\\s*$`, "i"), "").trim();
      }
      return cleaned;
    }

    function isInsideTownLookupBox(lat, lon) {
      const box = getTownAddressConfig().bbox || {};
      const south = Number(box.south);
      const north = Number(box.north);
      const west = Number(box.west);
      const east = Number(box.east);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
      if ([south, north, west, east].every(Number.isFinite) &&
          (lat < south || lat > north || lon < west || lon > east)) return false;
      return !municipalBoundaryFeature || pointInParcelFeature(municipalBoundaryFeature, lat, lon);
    }

    function normalizeTownAddressText(value, keepPlaceNames = false) {
      const cfg = getTownAddressConfig();
      const removable = [
        cfg.displayName,
        TOWN_CONFIG?.site?.name,
        TOWN_CONFIG?.site?.municipalityName,
        cfg.city,
        cfg.state,
        cfg.stateName,
        cfg.postalCode,
        "borough",
        "township",
        "city",
        cfg.countryCode,
        cfg.sourceCountry,
        "united",
        "states"
      ].filter(Boolean).map(v => String(v).toLowerCase());
      const removablePattern = removable.length ? new RegExp(`\\b(${removable.map(escapeRegExp).join("|")})\\b`, "g") : null;
      let cleaned = String(value || "")
        .toLowerCase()
        .replace(/&/g, " and ")
        .replace(/\b(avenue|ave\.?|av)\b/g, "ave")
        .replace(/\b(street|st\.?)\b/g, "st")
        .replace(/\b(road|rd\.?)\b/g, "rd")
        .replace(/\b(drive|dr\.?)\b/g, "dr")
        .replace(/\b(place|pl\.?)\b/g, "pl")
        .replace(/\b(court|ct\.?)\b/g, "ct")
        .replace(/\b(lane|ln\.?)\b/g, "ln")
        .replace(/\b(boulevard|blvd\.?)\b/g, "blvd")
        .replace(/\b(north|n)\b/g, "n")
        .replace(/\b(south|s)\b/g, "s")
        .replace(/\b(east|e)\b/g, "e")
        .replace(/\b(west|w)\b/g, "w")
        .replace(/[^a-z0-9\s]/g, " ");
      if (!keepPlaceNames && removablePattern) cleaned = cleaned.replace(removablePattern, " ");
      return cleaned.replace(/\s+/g, " ").trim();
    }

    function getTownAddressHouseNumber(value) {
      return String(value || "").trim().match(/^\d+[a-z]?(?:-\d+[a-z]?)?(?=\s|,|$)/i)?.[0].toLowerCase() || "";
    }

    function normalizeTownStreetAddress(value) {
      const street = String(value || "").split(",", 1)[0]
        .replace(/\s+(?:apt|unit|suite|ste)\.?\s+.*$|\s*#.*$/i, "");
      return normalizeTownAddressText(street, true);
    }

    function levenshteinTownAddress(a, b) {
      a = normalizeTownAddressText(a);
      b = normalizeTownAddressText(b);
      if (!a) return b.length;
      if (!b) return a.length;
      const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
      const curr = new Array(b.length + 1);
      for (let i = 1; i <= a.length; i++) {
        curr[0] = i;
        for (let j = 1; j <= b.length; j++) {
          const cost = a[i - 1] === b[j - 1] ? 0 : 1;
          curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
        }
        for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
      }
      return prev[b.length];
    }

    function similarityTownAddress(a, b) {
      const aa = normalizeTownAddressText(a);
      const bb = normalizeTownAddressText(b);
      const maxLen = Math.max(aa.length, bb.length, 1);
      return 1 - (levenshteinTownAddress(aa, bb) / maxLen);
    }

    function resultHasTownPlaceText(result) {
      const cfg = getTownAddressConfig();
      const address = result && result.address ? result.address : {};
      const displayName = String(result && result.display_name ? result.display_name : "").toLowerCase();
      const placeText = [
        address.city,
        address.town,
        address.village,
        address.municipality,
        address.borough,
        address.suburb,
        address.county,
        displayName
      ].filter(Boolean).join(" ").toLowerCase();
      const placeTerms = [cfg.displayName, TOWN_CONFIG?.site?.name, TOWN_CONFIG?.site?.municipalityName, cfg.city]
        .filter(Boolean)
        .map(value => String(value).toLowerCase());
      const postcode = String(address.postcode || "").trim();
      return placeTerms.some(term => placeText.includes(term)) || (cfg.postalCode && postcode === String(cfg.postalCode));
    }

    function isLikelyTownResult(result) {
      const lat = Number(result && result.lat);
      const lon = Number(result && result.lon);
      return isInsideTownLookupBox(lat, lon) && resultHasTownPlaceText(result);
    }

    function formatTownAddressLabel(result) {
      if (result && result.label) return String(result.label);
      const address = result && result.address ? result.address : {};
      const parts = [];
      const houseRoad = [address.house_number, address.road].filter(Boolean).join(" ").trim();
      if (houseRoad) parts.push(houseRoad);
      if (address.city || address.town || address.village || address.municipality || address.borough) {
        parts.push(address.city || address.town || address.village || address.municipality || address.borough);
      }
      if (address.state) parts.push(address.state);
      if (address.postcode) parts.push(address.postcode);
      return parts.length ? parts.join(", ") : String(result.display_name || "address");
    }

    function townAddressCandidateScore(candidate, cleanQuery) {
      const label = formatTownAddressLabel(candidate);
      const normalizedQuery = normalizeTownAddressText(cleanQuery);
      const normalizedLabel = normalizeTownAddressText(label);
      let score = Number(candidate.score || 0);
      if (candidate.source === "arcgis") score = Math.max(score, Number(candidate.arcgisScore || 0) / 100);
      if (normalizedQuery && normalizedLabel) {
        if (normalizedLabel.includes(normalizedQuery)) score += 0.40;
        score += Math.max(0, similarityTownAddress(normalizedQuery, normalizedLabel)) * 0.45;
      }
      const queryHouseNumber = (normalizedQuery.match(/^\d+\b/) || [""])[0];
      if (queryHouseNumber && normalizedLabel.startsWith(queryHouseNumber)) score += 0.15;
      return score;
    }

    function normalizeNominatimTownCandidate(result, cleanQuery) {
      if (!isLikelyTownResult(result)) return null;
      const address = result.address || {};
      const houseNumber = getTownAddressHouseNumber(cleanQuery);
      if (!address.road || String(address.house_number || "").toLowerCase() !== houseNumber) return null;
      const lat = Number(result.lat);
      const lon = Number(result.lon);
      const candidate = {
        source: "nominatim",
        lat,
        lon,
        label: formatTownAddressLabel(result),
        address,
        streetAddress: houseNumber ? normalizeTownStreetAddress(`${address.house_number} ${address.road}`) : "",
        display_name: result.display_name || "",
        score: 0.45
      };
      candidate.score = townAddressCandidateScore(candidate, cleanQuery);
      return candidate;
    }

    function normalizeArcgisTownCandidate(candidate, cleanQuery) {
      const lon = Number(candidate?.location?.x);
      const lat = Number(candidate?.location?.y);
      if (!isInsideTownLookupBox(lat, lon)) return null;
      const attrs = candidate.attributes || {};
      const label = String(attrs.Match_addr || candidate.address || "address").replace(/,\s*USA$/i, "");
      const houseNumber = getTownAddressHouseNumber(cleanQuery);
      const addressTypes = houseNumber ? ["PointAddress", "Subaddress", "StreetAddress"] : ["StreetName", "StreetInt"];
      if (!addressTypes.includes(attrs.Addr_type) || getTownAddressHouseNumber(label) !== houseNumber) return null;
      const normalized = {
        source: "arcgis",
        lat,
        lon,
        label,
        streetAddress: houseNumber ? normalizeTownStreetAddress(label) : "",
        arcgisScore: Number(candidate.score || attrs.Score || 0),
        score: 0
      };
      normalized.score = townAddressCandidateScore(normalized, cleanQuery);
      return normalized;
    }

    async function fetchTownAddressJson(url, searchSignal) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      let timeout;
      const deadline = new Promise((resolve, reject) => {
        controller.signal.addEventListener("abort", () => {
          reject(new Error(searchSignal?.aborted ? "Address lookup canceled." : "Address provider timed out."));
        }, { once: true });
        if (searchSignal?.aborted) abort();
        else {
          searchSignal?.addEventListener("abort", abort, { once: true });
          timeout = setTimeout(abort, 8000);
        }
      });
      try {
        // Bound the body read as well as the initial response. The explicit
        // deadline also releases the UI if a provider ignores an abort.
        return await Promise.race([deadline, (async () => {
          const response = await fetch(url, {
            headers: { "Accept": "application/json" }, signal: controller.signal
          });
          return response.ok ? response.json() : null;
        })()]);
      } finally {
        clearTimeout(timeout);
        searchSignal?.removeEventListener("abort", abort);
      }
    }

    async function fetchNominatimTownCandidates(clean, signal) {
      const cfg = getTownAddressConfig();
      const city = cfg.city || TOWN_CONFIG?.site?.name || "";
      const state = cfg.state || "";
      const postalCode = cfg.postalCode || "";
      const box = cfg.bbox || {};
      const params = new URLSearchParams({
        format: "jsonv2",
        q: [clean, city, state, postalCode].filter(Boolean).join(", "),
        addressdetails: "1",
        limit: "10",
        countrycodes: cfg.countryCode || ""
      });
      if ([box.west, box.north, box.east, box.south].every(value => Number.isFinite(Number(value)))) {
        params.set("viewbox", `${box.west},${box.north},${box.east},${box.south}`);
        params.set("bounded", "1");
      }
      const results = await fetchTownAddressJson(`https://nominatim.openstreetmap.org/search?${params.toString()}`, signal);
      return Array.isArray(results) ? results.map(item => normalizeNominatimTownCandidate(item, clean)).filter(Boolean) : [];
    }

    async function fetchArcgisTownCandidates(clean, signal) {
      const cfg = getTownAddressConfig();
      const city = cfg.city || TOWN_CONFIG?.site?.name || "";
      const state = cfg.state || "";
      const postalCode = cfg.postalCode || "";
      const center = cfg.geocodeCenter || TOWN_CONFIG?.map?.center || {};
      const params = new URLSearchParams({
        f: "json",
        SingleLine: [clean, city, state, postalCode].filter(Boolean).join(", "),
        outFields: "Match_addr,Addr_type,Score",
        maxLocations: "10",
        sourceCountry: cfg.sourceCountry || "",
        category: "Address,Street Address,Postal,Populated Place",
        outSR: "4326",
        forStorage: "false"
      });
      if (Number.isFinite(Number(center.lon)) && Number.isFinite(Number(center.lat))) {
        params.set("location", `${center.lon},${center.lat}`);
      }
      if (cfg.searchDistanceMeters) params.set("distance", String(cfg.searchDistanceMeters));
      const data = await fetchTownAddressJson(`https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates?${params.toString()}`, signal);
      const candidates = Array.isArray(data?.candidates) ? data.candidates : [];
      return candidates.map(item => normalizeArcgisTownCandidate(item, clean)).filter(Boolean);
    }

    function pickBestTownAddressCandidate(candidates, clean) {
      const seen = new Set();
      const unique = [];
      candidates.forEach(candidate => {
        const key = `${candidate.lat.toFixed(6)},${candidate.lon.toFixed(6)}`;
        if (seen.has(key)) return;
        seen.add(key);
        candidate.score = townAddressCandidateScore(candidate, clean);
        unique.push(candidate);
      });
      unique.sort((a, b) => b.score - a.score);
      return unique[0] || null;
    }

    function getCurrentFloodThresholdsForDatum() {
      return currentDatum === "mllw"
        ? (SITE_CONFIG.floodThresholdsMllwFt || {})
        : (SITE_CONFIG.floodThresholdsNavd88Ft || {});
    }

    function classifyFloodStageForDisplay(rawNavdStage) {
      const display = convertStageForDisplay(rawNavdStage);
      const thresholds = getCurrentFloodThresholdsForDatum();
      const minor = Number(thresholds.minor);
      const moderate = Number(thresholds.moderate);
      const major = Number(thresholds.major);
      if (!Number.isFinite(display) || !Number.isFinite(minor) || !Number.isFinite(moderate) || !Number.isFinite(major)) {
        return classifyFloodStage(rawNavdStage);
      }
      if (display < minor) return "none";
      if (display < moderate) return "minor";
      if (display < major) return "moderate";
      return "major";
    }

    function updateSnapshotWaterLevelSeverity(rawNavdStage) {
      const waterBox = document.getElementById("stageText")?.closest(".stat-box");
      if (!waterBox) return;
      waterBox.classList.remove("snapshot-water-minor", "snapshot-water-moderate", "snapshot-water-major");
      const severity = classifyFloodStageForDisplay(rawNavdStage);
      if (severity === "minor" || severity === "moderate" || severity === "major") {
        waterBox.classList.add(`snapshot-water-${severity}`);
      }
    }

    function getShorelySafeAddressIcon() {
      return L.divIcon({
        className: "shorely-address-marker-wrap",
        html: '<span class="shorely-address-marker"><span></span></span>',
        iconSize: [26, 26],
        iconAnchor: [13, 13],
        popupAnchor: [0, -14]
      });
    }

    async function searchTownAddress(rawValue) {
      const generation = ++townAddressSearchGeneration;
      townAddressLookupController?.abort();
      const controller = new AbortController();
      townAddressLookupController = controller;
      const button = document.getElementById("townAddressSearchBtn");
      const clean = normalizeTownAddressQuery(rawValue);
      const townName = getTownAddressDisplayName();
      if (!clean) {
        townAddressLookupController = null;
        if (button) button.disabled = false;
        setTownAddressStatus(`Enter a ${townName} address or street first.`, "error");
        return;
      }
      if (!map) ensureMap();

      ++mapQueryGeneration;
      const buildingChoice = townAddressBuildingChoiceGeneration;
      if (button) button.disabled = true;
      setTownAddressStatus(`Finding the closest ${townName} match…`);

      try {
        const candidateSets = await Promise.allSettled([
          fetchArcgisTownCandidates(clean, controller.signal),
          fetchNominatimTownCandidates(clean, controller.signal)
        ]);
        if (generation !== townAddressSearchGeneration) return;
        const candidates = candidateSets.flatMap(result => result.status === "fulfilled" && Array.isArray(result.value) ? result.value : []);
        const match = pickBestTownAddressCandidate(candidates, clean);
        if (!match) {
          setTownAddressStatus(`No close ${townName} match found. Try a street number and street name.`, "error");
          return;
        }

        const latLng = L.latLng(match.lat, match.lon);
        const label = formatTownAddressLabel(match);
        let parcelFeature = null;
        if (match.streetAddress) {
          try {
            parcelFeature = await findParcelFeatureForLocation(match.lat, match.lon, {
              matchesFeature: feature => normalizeTownStreetAddress(feature?.properties?.address) === match.streetAddress
            });
            if (generation !== townAddressSearchGeneration) return;
            if (parcelFeature && buildingChoice === townAddressBuildingChoiceGeneration) await setBuildingsEnabled(true);
          } catch (parcelErr) {
            if (generation !== townAddressSearchGeneration) return;
            console.warn("House Alert parcel match was unavailable.", parcelErr);
          }
        }

        if (generation !== townAddressSearchGeneration) return;
        if (townAddressMarker && map.hasLayer(townAddressMarker)) {
          townAddressMarker.setLatLng(latLng);
          townAddressMarker.options.title = label;
          const markerElement = townAddressMarker.getElement();
          if (markerElement) markerElement.title = label;
        } else {
          townAddressMarker = L.marker(latLng, {
            title: label,
            riseOnHover: true,
            icon: getShorelySafeAddressIcon()
          }).addTo(map);
        }

        map.setView(latLng, Math.max(map.getZoom(), 17), { animate: true });
        window.NORTH_WILDWOOD_3D?.setAddressMarker?.(latLng, label);
        if (document.body.classList.contains("mobile-optimized")) {
          document.getElementById("townAddressInput")?.blur();
          setMobileControlsOpen(false);
        }
        const popup = parcelFeature
          ? openParcelFloodPrompt(parcelFeature, latLng)
          : openPersistentFloodPopup(
            latLng,
            '<div class="town-address-popup"><strong>Closest match</strong><br>' + escapeTownAddressHtml(label) + "</div>",
            370
          );
        townAddressPopup = popup;
        popup.once("remove", () => {
          if (townAddressPopup === popup) townAddressPopup = null;
        });
        setTownAddressStatus(parcelFeature ? `Building flood profile found: ${label}` : `Closest match: ${label}`, "success");
      } catch (err) {
        if (generation !== townAddressSearchGeneration) return;
        setTownAddressStatus(err && err.message ? err.message : "Address lookup failed. Please try again.", "error");
      } finally {
        if (generation === townAddressSearchGeneration) {
          townAddressLookupController = null;
          if (button) button.disabled = false;
        }
      }
    }

    function wireTownAddressLookup() {
      const form = document.getElementById("townAddressForm");
      const input = document.getElementById("townAddressInput");
      const clearBtn = document.getElementById("townAddressClearBtn");
      if (!form || !input || form.dataset.wired === "1") return;
      form.dataset.wired = "1";
      form.addEventListener("submit", e => {
        e.preventDefault();
        searchTownAddress(input.value);
      });
      input.addEventListener("input", () => {
        if (cancelPendingTownAddressLookup()) setTownAddressStatus("");
      });
      clearBtn?.addEventListener("click", clearTownAddressLookup);
    }

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
        body: "<p>Select <strong>Past</strong> to explore the tide-gauge archive. Use <strong>Interval</strong> in the left pane to switch among Hourly, 15-Min, and Daily Max views.</p>"
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
        body: "<p>Turn on <strong>Buildings</strong> for floor flood history and projections, or <strong>Parcels</strong> for flooded area and depth.</p>"
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

