
    const APP_BASE = new URL(".", window.location.href);
    const UI_ASSET_BASE = new URL("../", document.currentScript?.src || new URL("assets/app/runtime.js", APP_BASE));
    let FORECAST_URL = "";
    let OBSERVED_URL = "";
    let CANONICAL_DAILY_URL = "";
    let OBSERVED_15MIN_URL = "";
    let OBSERVED_ARCHIVE_INDEX_URL = "";
    let LEWES_ARCHIVE_INDEX_URL = "";
    let LEWES_HOURLY_URL = "";
    let TOP_TIDES_URL = "";
    let RETURN_INTERVALS_URL = "";
    let DEPTH_QUERY_PNG_URL = "";
    let DEVELOPED_QUERY_PNG_URL = "";
    let DEPTH_QUERY_COG_URL = "";
    let PHYSICS_FORECAST_POINTER_URL = "";
    let PHYSICS_FORECAST_CYCLE_POINTER_TEMPLATE = "";
    let PARCELS_URL = "";
    let PARCEL_AREA_STAGES_URL = "";
    let HOUSE_ALERT_CDF_URL = "";
    let PARCEL_BOUNDARY_PNG_URL = "";
    let NSI_STRUCTURES_URL = "";

    function withFreshJsonUrl(url) {
      const fresh = new URL(url, window.location.href);
      fresh.searchParams.set("_ts", String(Date.now()));
      return fresh.href;
    }

    const OPTIONAL_SCRIPT_URLS = {
      html2canvas: new URL("vendor/html2canvas-1.4.1.min.js", UI_ASSET_BASE).href,
      jszip: "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js",
      geotiff: "https://cdn.jsdelivr.net/npm/geotiff@2.1.3/dist-browser/geotiff.js"
    };
    const optionalScriptPromises = new Map();
    const OPTIONAL_SCRIPT_TIMEOUT_MS = 12000;

    function loadOptionalScript(key, isReady) {
      if (isReady()) return Promise.resolve();
      if (optionalScriptPromises.has(key)) return optionalScriptPromises.get(key);
      const url = OPTIONAL_SCRIPT_URLS[key];
      const promise = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        let settled = false;
        const finish = error => {
          if (settled) return;
          settled = true;
          window.clearTimeout(deadline);
          script.onload = script.onerror = null;
          if (error) {
            script.remove();
            reject(error);
          } else resolve();
        };
        const deadline = window.setTimeout(() => finish(new Error(`${key} took too long to load. Please try again.`)), OPTIONAL_SCRIPT_TIMEOUT_MS);
        script.src = url;
        script.async = true;
        script.dataset.optionalLibrary = key;
        script.onload = () => finish(isReady() ? null : new Error(`${key} loaded without exposing its browser API.`));
        script.onerror = () => finish(new Error(`${key} could not be loaded.`));
        document.head.appendChild(script);
      }).catch(error => {
        if (optionalScriptPromises.get(key) === promise) optionalScriptPromises.delete(key);
        throw error;
      });
      optionalScriptPromises.set(key, promise);
      return promise;
    }

    async function ensureExportLibraries(format, frameCount = 1) {
      document.body.dataset.exportLibraries = "loading";
      const loads = [loadOptionalScript("html2canvas", () => typeof window.html2canvas === "function")];
      if (format === "png" && frameCount > 1) loads.push(loadOptionalScript("jszip", () => typeof window.JSZip === "function"));
      try {
        await Promise.all(loads);
        document.body.dataset.exportLibraries = "ready";
      } catch (error) {
        document.body.dataset.exportLibraries = "unavailable";
        throw error;
      }
    }

    function warmExportLibraries() {
      const format = getDownloadFormatValue();
      const estimatedFrameCount = format === "png" ? Math.max(1, getDownloadFrameItems().length) : 1;
      ensureExportLibraries(format, estimatedFrameCount).catch(error => {
        console.warn("Export tools will retry when export begins.", error);
      });
    }

    async function ensureDepthQueryLibrary() {
      await loadOptionalScript("geotiff", () => Boolean(window.GeoTIFF?.fromUrl));
    }



    const MIN_STAGE = -4.0;
    const MIN_DEPTH_STAGE = 0.0;
    const MAX_STAGE = 20.0;
    const STAGE_STEP = 0.1;
    const DEFAULT_OVERLAY_MODE = "depth";
    const DEFAULT_DATA_MODE = "forecast";
    const DEFAULT_OPACITY = 0.75;
    const TOP_TIDE_DISPLAY_COUNT = 3;
    const TOP_TIDE_SELECT_COUNT = 10;
    const TOP_TIDE_WINDOW_HOURS = 12;
    const ROAD_LABEL_ZOOM = 10;
    const EXPORT_RANGE_MAX_HOURS = 84;
    const EXPORT_RANGE_MAX_MS = EXPORT_RANGE_MAX_HOURS * 60 * 60 * 1000;
    const EXPORT_INTERVALS = {
      hourly: { value: "hourly", label: "Hourly", minutes: 60, frameLimit: EXPORT_RANGE_MAX_HOURS + 1 },
      "15min": { value: "15min", label: "15-Minute", minutes: 15, frameLimit: (EXPORT_RANGE_MAX_HOURS * 4) + 1 },
      daily: { value: "daily", label: "Daily Maximum", minutes: 1440, frameLimit: 5 }
    };
    const PLAYBACK_DAY_CONFIRMATION_INTERVAL = 20;
    const PLAYBACK_SIMULATED_HOUR_MS = 950;
    const PLAYBACK_MINIMUM_FRAME_DELAY_MS = 20;
    const EXPORT_CAPTURE_DELAY_MS = 1;
    const EXPORT_GIF_SPEEDS = {
      slow: { value: "slow", label: "Slow", delayMs: 2000 },
      normal: { value: "normal", label: "Normal", delayMs: 1000 },
      fast: { value: "fast", label: "Fast", delayMs: 500 }
    };
    const EXPORT_GIF_QUALITY = 1;
    const EXPORT_CAPTURE_SCALE = 1;
    const EXPORT_GIF_DITHER = false;
    const EXPORT_PNG_SELECTION_LIMIT = EXPORT_INTERVALS["15min"].frameLimit;
    const GIF_WORKER_URL = new URL("vendor/gif.worker.js?v=ef4ff2db1b2c1116", UI_ASSET_BASE).href;
    const EXPORT_GIF_ASPECTS = {
      "16:9": { value: "16:9", width: 2400, height: 1350, pngWidth: 3840, pngHeight: 2160, label: "Wide 16:9" },
      "9:16": { value: "9:16", width: 1350, height: 2400, pngWidth: 2160, pngHeight: 3840, label: "Story 9:16" },
      "1:1": { value: "1:1", width: 1500, height: 1500, pngWidth: 2160, pngHeight: 2160, label: "Square 1:1" }
    };
    const EXPORT_PROGRESS_UPDATE_EVERY = 8;



    let TOWN_CONFIG = null;
    let OVERLAY_ROOTS = { depth: [], dynamic: [] };
    let OVERLAY_PHASE_ROOTS = { depth: {}, dynamic: {} };
    let OVERLAY_CACHE_VERSIONS = {};
    let NWS_POINT_URL = "";
    let SITE_CONFIG = {};
    let MUNICIPAL_BOUNDARY_QUERY_CANDIDATES = [];
    let MUNICIPAL_BOUNDARY_QUERY_URL = "";
    let MUNICIPAL_BOUNDARY_OUTFIELDS = "";
    let DATUM_OFFSETS = { navd88: 0, mllw: 0 };
    let FALLBACK_TOWN_MASK_RING = [];
    let FALLBACK_LATLNG_BOUNDS = null;
    let MUNICIPAL_BOUNDARY_BUNNY_URL = "";
    let MINOR_FLOOD_FT = 0;
    let MODERATE_FLOOD_FT = 0;
    let MAJOR_FLOOD_FT = 0;

    const MINOR_VERTICAL_PENALTY_FT = 0.75;
    const MODERATE_VERTICAL_PENALTY_FT = 0.25;
    const MAJOR_VERTICAL_PENALTY_FT = 0;

    function formatOffsetWithSign(value, digits = 2) {
      const n = Number(value) || 0;
      const sign = n >= 0 ? "+" : "";
      return `${sign}${n.toFixed(digits)}`;
    }

    function formatDatumToggleLabel() {
      return `MLLW (${formatOffsetWithSign(DATUM_OFFSETS.mllw, 2)} ft)`;
    }

    function buildOverlayRoots(rootList) {
      const list = Array.isArray(rootList) ? rootList : (rootList ? [rootList] : []);
      return list.map(path => new URL(path, APP_BASE).href);
    }

    function configuredSurrogate() {
      return TOWN_CONFIG?.observed?.surrogate || { enabled: false };
    }

    function surrogateEnabled() {
      return configuredSurrogate().enabled === true;
    }

    function surrogateStationId() {
      return String(configuredSurrogate().stationId || "");
    }

    function surrogateStationName() {
      return String(configuredSurrogate().stationName || "NOAA surrogate");
    }

    function surrogateStationShort() {
      return String(configuredSurrogate().stationShort || surrogateStationName());
    }

    function surrogateBiasCorrectionFt() {
      const value = Number(configuredSurrogate().biasCorrectionFt);
      return Number.isFinite(value) ? value : 0;
    }

    function decodeSurrogateHundredths(value) {
      if (value == null || value === "") return null;
      const raw = Number(value);
      return Number.isFinite(raw) ? raw / 100 + surrogateBiasCorrectionFt() : null;
    }

    function primaryArchiveStartDate() {
      return String(TOWN_CONFIG?.observed?.primaryArchiveStartDate || "2007-10-01");
    }

    function primaryGaugeName() {
      return String(TOWN_CONFIG?.site?.gaugeName || TOWN_CONFIG?.site?.name || "Primary gauge");
    }

    function optionalAppUrl(value) {
      return value ? new URL(value, APP_BASE).href : "";
    }

    function normalizeConfiguredDataset(payload, kind = "") {
      const zoneId = TOWN_CONFIG?.data?.zoneId;
      const zone = zoneId && payload?.zones?.[zoneId] ? payload.zones[zoneId] : null;
      if (!zone) return payload;
      return (kind && zone?.[kind]) || zone?.forecast || zone?.observed || zone;
    }


    function decodeHtmlText(value) {
      const el = document.createElement("textarea");
      el.innerHTML = String(value ?? "");
      return el.value;
    }

    let mapTitleFitRaf = 0;

    function fitMapTitleBadgeToViewport() {
      if(document.body.hasAttribute("data-county-viewport")) return;
      if (document.documentElement.classList.contains("avalon-mobile-ui") && isCompactFloodmapperLayout()) return;
      mapTitleFitRaf = 0;
      const badge = document.getElementById("mapTitleBadge");
      const text = document.getElementById("mapTitleText");
      if (!badge || !text) return;

      const viewportWidth = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0);
      const compact = isCompactFloodmapperLayout();
      let leftLimit = 12;
      let rightLimit = viewportWidth - 12;

      if (!compact) {
        const leftPanel = document.getElementById("leftPanel");
        const rightRail = document.getElementById("rightRail");
        const leftRect = leftPanel?.getBoundingClientRect();
        const rightRect = rightRail?.getBoundingClientRect();
        if (leftRect?.width && getComputedStyle(leftPanel).display !== "none") {
          leftLimit = Math.max(leftLimit, leftRect.right + 14);
        }
        if (rightRect?.width && getComputedStyle(rightRail).display !== "none") {
          rightLimit = Math.min(rightLimit, rightRect.left - 14);
        }
        const navigation = document.getElementById("nwDefaultNavControl");
        const navigationRect = navigation?.getBoundingClientRect();
        if (navigationRect?.width && navigationRect.top < badge.getBoundingClientRect().bottom + 8) {
          rightLimit = Math.min(rightLimit, navigationRect.left - 14);
        }
      }

      if (rightLimit - leftLimit < 180) {
        leftLimit = 12;
        rightLimit = viewportWidth - 12;
      }
      const availableWidth = Math.max(156, rightLimit - leftLimit);
      const center = leftLimit + (availableWidth / 2);
      badge.style.setProperty("left", `${center}px`, "important");
      badge.style.setProperty("max-width", `${availableWidth}px`, "important");
      badge.style.setProperty("width", compact ? `${availableWidth}px` : "auto", "important");

      const maximumFontSize = compact
        ? Math.min(25, Math.max(17, viewportWidth * 0.056))
        : viewportWidth <= 1080
          ? Math.min(32, Math.max(20, viewportWidth * 0.028))
          : viewportWidth <= 1280
            ? Math.min(36, Math.max(24, viewportWidth * 0.026))
            : Math.min(42, Math.max(28, viewportWidth * 0.024));
      const maximumLogoWidth = compact
        ? (viewportWidth <= 430 ? 0 : Math.min(68, availableWidth * 0.17))
        : viewportWidth <= 1080
          ? 0
          : Math.min(viewportWidth <= 1280 ? 122 : 150, availableWidth * 0.2);
      badge.style.setProperty("--nww-title-font-size", `${maximumFontSize}px`);
      text.style.setProperty("font-size", `${maximumFontSize}px`, "important");
      badge.style.setProperty("--nww-title-logo-max", `${maximumLogoWidth}px`);
      badge.querySelectorAll(".shorely-title-logo").forEach(logo => {
        logo.style.setProperty("max-width", `${maximumLogoWidth}px`, "important");
      });

      const badgeStyle = getComputedStyle(badge);
      const paddingWidth = (parseFloat(badgeStyle.paddingLeft) || 0) + (parseFloat(badgeStyle.paddingRight) || 0);
      const children = Array.from(badge.children).filter(child => {
        const rect = child.getBoundingClientRect();
        const style = getComputedStyle(child);
        return child !== text && rect.width > 0 && style.display !== "none" && style.visibility !== "hidden";
      });
      const gap = parseFloat(badgeStyle.columnGap || badgeStyle.gap) || 0;
      const fixedWidth = paddingWidth
        + children.reduce((sum, child) => sum + child.getBoundingClientRect().width, 0)
        + gap * Math.max(0, children.length);
      const naturalTextWidth = Math.max(text.scrollWidth, text.getBoundingClientRect().width, 1);
      const availableTextWidth = Math.max(80, availableWidth - fixedWidth);
      const minimumFontSize = compact ? 12 : viewportWidth <= 1080 ? 11 : 16;
      const fittedFontSize = Math.max(
        minimumFontSize,
        Math.min(maximumFontSize, maximumFontSize * (availableTextWidth / naturalTextWidth))
      );
      let finalFontSize = fittedFontSize;
      for (let pass = 0; pass < 3; pass += 1) {
        badge.style.setProperty("--nww-title-font-size", `${finalFontSize.toFixed(2)}px`);
        text.style.setProperty("font-size", `${finalFontSize.toFixed(2)}px`, "important");
        if (text.scrollWidth <= text.clientWidth + 1 || !text.scrollWidth) break;
        const correction = Math.max(0.5, Math.min(0.99, text.clientWidth / text.scrollWidth));
        finalFontSize = Math.max(minimumFontSize, finalFontSize * correction * 0.985);
      }

      const rect = badge.getBoundingClientRect();
      badge.dataset.viewportContained = String(
        rect.left >= leftLimit - 1 && rect.right <= rightLimit + 1 && rect.left >= -1 && rect.right <= viewportWidth + 1
      );
      badge.dataset.textContained = String(text.scrollWidth <= text.clientWidth + 1);
    }

    function scheduleMapTitleFit() {
      // Wait for the navigation controls before measuring the title's lane.
      if (document.readyState === "loading") {
        if (mapTitleFitRaf) return;
        mapTitleFitRaf = -1;
        document.addEventListener("DOMContentLoaded", () => {
          mapTitleFitRaf = 0;
          scheduleMapTitleFit();
        }, { once:true });
        return;
      }
      if (mapTitleFitRaf > 0) cancelAnimationFrame(mapTitleFitRaf);
      mapTitleFitRaf = requestAnimationFrame(fitMapTitleBadgeToViewport);
    }

    function setExportLogoImage(id, src, alt = "") {
      const img = document.getElementById(id);
      if (!img) return;
      if (src) {
        img.src = src;
        img.alt = alt || "";
        img.classList.add("is-visible");
        img.style.display = "";
        img.onerror = function(){
          this.classList.remove("is-visible");
          this.style.display = "none";
        };
      } else {
        img.removeAttribute("src");
        img.alt = "";
        img.classList.remove("is-visible");
        img.style.display = "none";
      }
    }

    function syncExportBrandLogos(config) {
      const assets = config?.assets || {};
      setExportLogoImage("exportTownLogo", assets.titleLogoPath, assets.titleLogoAlt || config?.site?.name || "");
      const partner = document.getElementById("exportPartnerLogo");
      const logo = assets.partnerLogoPath || assets.rightRailLogoPath;
      setExportLogoImage("exportPartnerLogo", logo && (partner?.dataset.exportBrandSrc || logo),
        assets.partnerLogoAlt || assets.rightRailLogoAlt || "ShorelySafe");
    }

    function applyTownConfig(config) {
      if (!config) throw new Error("Missing TOWN_CONFIG at bottom of HTML.");
      TOWN_CONFIG = config;
      FORECAST_URL = new URL(config.data?.forecastPath || "./forecast.json", APP_BASE).href;
      OBSERVED_URL = new URL(config.data?.observedPath || "./observed.json", APP_BASE).href;
      CANONICAL_DAILY_URL = optionalAppUrl(config.data?.canonicalDailyPath);
      OBSERVED_15MIN_URL = new URL(config.data?.observed15MinPath || "./observed15min.json", APP_BASE).href;
      OBSERVED_ARCHIVE_INDEX_URL = new URL(config.data?.observedArchiveIndexPath || "./observed_archive_index.json", APP_BASE).href;
      LEWES_ARCHIVE_INDEX_URL = optionalAppUrl(config.data?.surrogateArchiveIndexPath || config.data?.lewesArchiveIndexPath);
      LEWES_HOURLY_URL = optionalAppUrl(config.data?.surrogateHourlyPath || config.data?.lewesHourlyPath);
      TOP_TIDES_URL = new URL(config.data?.topTidesPath || "./toptides.json", APP_BASE).href;
      RETURN_INTERVALS_URL = new URL(config.data?.returnIntervalsPath || "./return_intervals.json", APP_BASE).href;
      DEPTH_QUERY_PNG_URL = optionalAppUrl(config.overlays?.depthQueryPngPath);
      DEVELOPED_QUERY_PNG_URL = config.overlays?.developedQueryPngPath
        ? new URL(config.overlays.developedQueryPngPath, APP_BASE).href
        : "";
      DEPTH_QUERY_COG_URL = config.overlays?.depthQueryCogPath
        ? new URL(config.overlays.depthQueryCogPath, APP_BASE).href
        : "";
      PHYSICS_FORECAST_POINTER_URL = config.overlays?.physicsForecastPointerPath
        ? new URL(config.overlays.physicsForecastPointerPath, APP_BASE).href
        : "";
      PHYSICS_FORECAST_CYCLE_POINTER_TEMPLATE =
        config.overlays?.physicsForecastCyclePointerTemplatePath || "";
      PARCELS_URL = optionalAppUrl(config.parcels?.geojsonPath);
      PARCEL_AREA_STAGES_URL = optionalAppUrl(config.parcels?.areaStagesPath);
      HOUSE_ALERT_CDF_URL = optionalAppUrl(config.parcels?.houseAlertCdfPath);
      PARCEL_BOUNDARY_PNG_URL = optionalAppUrl(config.parcels?.boundaryPngPath);
      NSI_STRUCTURES_URL = config.structures?.nsi2026GeojsonPath
        ? new URL(config.structures.nsi2026GeojsonPath, APP_BASE).href
        : "";
      MUNICIPAL_BOUNDARY_QUERY_URL = config.boundary?.queryUrl || "";
      MUNICIPAL_BOUNDARY_OUTFIELDS = config.boundary?.outFields || "";

      document.title = config.pageTitle || `${config.site?.name || "Town"} Flood Map`;

      const siteTitleLine1 = document.getElementById("siteTitleLine1");
      const siteTitleLine2 = document.getElementById("siteTitleLine2");
      if (siteTitleLine1) siteTitleLine1.textContent = decodeHtmlText(config.brandTitleLine1 || config.site?.name || "Flood");
      if (siteTitleLine2) siteTitleLine2.textContent = decodeHtmlText(config.brandTitleLine2 || "Flood Map");

      const mapTitleText = document.getElementById("mapTitleText");
      if (mapTitleText) mapTitleText.textContent = decodeHtmlText(config.mapTitle || config.pageTitle || `${config.site?.name || "Town"} Flood Map`);

      const mapTitleLogo = document.getElementById("mapTitleLogo");
      if (mapTitleLogo) {
        if (config.assets?.titleLogoPath) {
          mapTitleLogo.src = config.assets.titleLogoPath;
          mapTitleLogo.alt = config.assets?.titleLogoAlt || "";
          mapTitleLogo.style.display = "";
          mapTitleLogo.onload = scheduleMapTitleFit;
          mapTitleLogo.onerror = function(){ this.style.display = "none"; scheduleMapTitleFit(); };
        } else {
          mapTitleLogo.remove();
        }
      }

      const mapTitlePartnerLogo = document.getElementById("mapTitlePartnerLogo");
      if (mapTitlePartnerLogo) {
        if (config.assets?.partnerLogoPath) {
          mapTitlePartnerLogo.src = floodmapperUiLogoUrl(config.assets.partnerLogoPath, config.assets?.partnerLogoPath || config.assets?.partnerLogoPath);
          mapTitlePartnerLogo.alt = config.assets?.partnerLogoAlt || "";
          mapTitlePartnerLogo.style.display = "";
          mapTitlePartnerLogo.onload = scheduleMapTitleFit;
          mapTitlePartnerLogo.onerror = function(){
            if (config.assets?.partnerLogoFallbackPath && !this.dataset.logoFallback) {
              this.dataset.logoFallback = "1";
              this.src = config.assets.partnerLogoFallbackPath;
            } else {
              this.style.display = "none";
              scheduleMapTitleFit();
            }
          };
        } else {
          mapTitlePartnerLogo.removeAttribute("src");
          mapTitlePartnerLogo.style.display = "none";
        }
      }
      scheduleMapTitleFit();

      const rightLogoLink = document.getElementById("rightLogoLink");
      if (rightLogoLink) {
        rightLogoLink.href = config.links?.partnerUrl || "#";
        rightLogoLink.setAttribute("aria-label", config.links?.partnerAriaLabel || "Visit partner site");
      }

      const rightRailLogo = document.getElementById("rightRailLogo");
      if (rightRailLogo) {
        if (config.assets?.rightRailLogoPath || config.assets?.partnerLogoPath) {
          rightRailLogo.src = floodmapperUiLogoUrl(config.assets?.rightRailLogoPath || config.assets.partnerLogoPath, config.assets?.rightRailLogoPath || config.assets?.partnerLogoPath);
          rightRailLogo.alt = config.assets?.rightRailLogoAlt || config.assets?.partnerLogoAlt || "";
          rightRailLogo.style.display = "";
          rightRailLogo.onerror = function(){
            if (config.assets?.partnerLogoFallbackPath && !this.dataset.logoFallback) {
              this.dataset.logoFallback = "1";
              this.src = config.assets.partnerLogoFallbackPath;
            } else {
              this.style.display = "none";
            }
          };
        } else {
          rightRailLogo.removeAttribute("src");
          rightRailLogo.style.display = "none";
        }
      }

      syncExportBrandLogos(config);

      const addressTitle = document.getElementById("townAddressTitle");
      if (addressTitle) addressTitle.textContent = decodeHtmlText(config.addressLookup?.title || `Find a ${config.site?.name || "Town"} Address`);
      const addressInput = document.getElementById("townAddressInput");
      if (addressInput) addressInput.placeholder = config.addressLookup?.placeholder || "Example: 3100 Main St";
      const addressSearchBtn = document.getElementById("townAddressSearchBtn");
      if (addressSearchBtn) addressSearchBtn.textContent = config.addressLookup?.buttonText || `Search ${config.site?.name || "Town"}`;

      const datumMllwOffsetLabel = document.getElementById("datumMllwOffsetLabel");
      if (datumMllwOffsetLabel) datumMllwOffsetLabel.textContent = `${formatOffsetWithSign(config.datums?.offsets?.mllw || 0, 2)} ft`;

      const datumHelpTownLine = document.getElementById("datumHelpTownLine");
      if (datumHelpTownLine) {
        datumHelpTownLine.textContent = config.datums?.helpText || "Changing the reference changes the number shown, not the mapped flood area.";
      }

      OVERLAY_ROOTS = {
        depth: buildOverlayRoots(config.overlays?.depthRoots),
        dynamic: buildOverlayRoots(config.overlays?.dynamicRoots)
      };
      const configuredFamilyRoots = config.overlays?.familyRoots || config.overlays?.phaseRoots || {};
      OVERLAY_PHASE_ROOTS = {
        depth: Object.fromEntries(Object.entries(configuredFamilyRoots.depth || {}).map(([family, roots]) => [family, buildOverlayRoots(roots)])),
        dynamic: Object.fromEntries(Object.entries(configuredFamilyRoots.dynamic || {}).map(([family, roots]) => [family, buildOverlayRoots(roots)]))
      };
      OVERLAY_CACHE_VERSIONS = config.overlays?.cacheVersions || {};

      SITE_CONFIG = {
        name: config.site?.name,
        municipalityName: config.site?.municipalityName,
        county: config.site?.county,
        usgsGaugeId: config.site?.usgsGaugeId,
        noaaGaugeId: config.site?.noaaGaugeId,
        petssGaugeId: config.site?.petssGaugeId,
        gaugeName: config.site?.gaugeName,
        navd88OffsetFromMllwFt: config.datums?.navd88OffsetFromMllwFt,
        floodThresholdsMllwFt: config.thresholds?.mllw,
        floodThresholdsNavd88Ft: config.thresholds?.navd88,
        depthPngPrefix: config.overlays?.depthPngPrefix,
        stagePngPrefix: config.overlays?.stagePngPrefix
      };

      const point = config.nwsPoint || config.map?.center;
      NWS_POINT_URL = point ? `https://api.weather.gov/points/${point.lat},${point.lon}` : "";

      MUNICIPAL_BOUNDARY_QUERY_CANDIDATES = config.boundary?.queryCandidates || [];
      DATUM_OFFSETS = config.datums?.offsets || { navd88: 0, mllw: 0 };
      MUNICIPAL_BOUNDARY_BUNNY_URL = config.boundary?.bunnyBoundaryPath || config.boundary?.boundaryUrl || "";
      FALLBACK_TOWN_MASK_RING = [];
      FALLBACK_LATLNG_BOUNDS = null;

      MINOR_FLOOD_FT = Number(config.thresholds?.navd88?.minor || 0);
      MODERATE_FLOOD_FT = Number(config.thresholds?.navd88?.moderate || 0);
      MAJOR_FLOOD_FT = Number(config.thresholds?.navd88?.major || 0);

      DYNAMIC_LEGEND = buildDynamicLegend();

      if (typeof municipalBoundaryRings !== "undefined") {
        municipalBoundaryFeature = null;
        municipalBoundaryRings = [];
        seedMunicipalBoundary(config.boundary?.startupFeature);
      }
    }

    function buildDynamicLegend() {
      const navd = SITE_CONFIG.floodThresholdsNavd88Ft || {};
      const mllw = SITE_CONFIG.floodThresholdsMllwFt || {};
      const minorHighNavd = (Number(navd.moderate) - 0.01).toFixed(2);
      const moderateHighNavd = (Number(navd.major) - 0.01).toFixed(2);
      const minorHighMllw = (Number(mllw.moderate) - 0.01).toFixed(2);
      const moderateHighMllw = (Number(mllw.major) - 0.01).toFixed(2);
      return [
        { label: `Minor (${Number(navd.minor).toFixed(2)}–${minorHighNavd} ft NAVD88 / ${Number(mllw.minor).toFixed(1)}–${minorHighMllw} ft MLLW)`, color: "var(--minor)" },
        { label: `Moderate (${Number(navd.moderate).toFixed(2)}–${moderateHighNavd} ft NAVD88 / ${Number(mllw.moderate).toFixed(1)}–${moderateHighMllw} ft MLLW)`, color: "var(--moderate)" },
        { label: `Major (${Number(navd.major).toFixed(2)}+ ft NAVD88 / ${Number(mllw.major).toFixed(1)}+ ft MLLW)`, color: "var(--major)" }
      ];
    }

    const ESRI_API_KEY = window.ESRI_API_KEY || "";
    const ESRI_OSM_VECTOR_TILE_URL = "https://basemaps.arcgis.com/arcgis/rest/services/OpenStreetMap_v2/VectorTileServer";
    const ESRI_WORLD_IMAGERY_URL = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
    const FALLBACK_BASEMAP_URL = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
    const ROAD_LABELS_URL = "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}";

    const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const NEW_YORK_TIME_ZONE = "America/New_York";

    const NY_PARTS_FORMATTER = new Intl.DateTimeFormat("en-US", {
      timeZone: NEW_YORK_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZoneName: "short"
    });

    // Depths stay in feet internally; only their display units change.
    function formatWaterDepth(depth, feetDigits = 2) {
      if (!Number.isFinite(depth)) return "N/A";
      if (Math.abs(depth) < 1) return `${Number((depth * 12).toFixed(1))} in`;
      return `${depth.toFixed(feetDigits)} ft`;
    }

    const DEPTH_LEGEND = [
      { label: "< 1.2 in", color: "var(--depth-0)" },
      { label: "1.2–3 in", color: "var(--depth-1)" },
      { label: "3–6 in", color: "var(--depth-2)" },
      { label: "6–12 in", color: "var(--depth-3)" },
      { label: "1.00–1.50 ft", color: "var(--depth-4)" },
      { label: "1.50–2.00 ft", color: "var(--depth-5)" },
      { label: "2.00–2.50 ft", color: "var(--depth-6)" },
      { label: "2.50–3.00 ft", color: "var(--depth-7)" },
      { label: "3.00–4.00 ft", color: "var(--depth-8)" },
      { label: "4.00–5.00 ft", color: "var(--depth-9)" },
      { label: "5.00+ ft", color: "var(--depth-10)" }
    ];

    let DYNAMIC_LEGEND = [];


function cloneStyleObject(value) {
      return JSON.parse(JSON.stringify(value || {}));
    }

    function styleEsriBuildingBasemap(style) {
      const next = cloneStyleObject(style);
      if (!Array.isArray(next.layers)) return next;

      // The default MapLibre light intensity produces extreme contrast
      // between roof and wall faces. With thousands of aligned shore-town
      // footprints, those dark wall faces collapse into long horizontal
      // bands at overview scale. A soft viewport light preserves true 3D
      // geometry and the existing material color without the stripe effect.
      next.light = {
        ...(next.light || {}),
        anchor: "viewport",
        color: "#ffffff",
        intensity: 0.18
      };

      next.layers = next.layers.map(layer => {
        const id = String(layer?.id || "").toLowerCase();
        const sourceLayer = String(layer?.["source-layer"] || "").toLowerCase();
        const joined = `${id} ${sourceLayer}`;
        const isSymbolTextLayer = layer?.type === "symbol";
        const isBuildingLayer = /(building|footprint|structure)/.test(joined);

        if (isSymbolTextLayer || /(label|poi|place-name|road-name|road-label|reference-label|admin-label|marine-label|water-label)/.test(joined)) {
          return {
            ...layer,
            layout: {
              ...(layer.layout || {}),
              visibility: "none"
            }
          };
        }

        if (isBuildingLayer) {
          const paint = { ...(layer.paint || {}) };
          if (layer.type === "fill") {
            paint["fill-color"] = "#d8d2c6";
            paint["fill-opacity"] = 0.98;
            // Esri publishes a fill edge and a separate outline for every
            // footprint. At overview scale the stacked edges collapse into
            // the dark dashes and bands visible in dense building blocks.
            // Preserve the established beige fill while neutralizing its edge.
            paint["fill-outline-color"] = "#d8d2c6";
          }
          if (layer.type === "line") {
            return {
              ...layer,
              layout: {
                ...(layer.layout || {}),
                visibility: "none"
              }
            };
          }
          return { ...layer, paint };
        }

        return layer;
      });

      return next;
    }

    function styleEsriBuildingForeground(style) {
      const next = cloneStyleObject(style);
      if (!Array.isArray(next.layers)) return next;

      next.layers = next.layers.map(layer => {
        const id = String(layer?.id || "").toLowerCase();
        const sourceLayer = String(layer?.["source-layer"] || "").toLowerCase();
        const isBuildingLayer = /(building|footprint|structure)/.test(`${id} ${sourceLayer}`);
        const isBuildingGeometry = isBuildingLayer && (layer?.type === "fill" || layer?.type === "line");
        if (!isBuildingGeometry) {
          return {
            ...layer,
            layout: {
              ...(layer.layout || {}),
              visibility: "none"
            }
          };
        }

        const paint = { ...(layer.paint || {}) };
        if (layer.type === "fill") {
          paint["fill-color"] = "#ddd7cb";
          paint["fill-opacity"] = 0.98;
          paint["fill-outline-color"] = "#bcb2a2";
        } else {
          paint["line-color"] = "#b8ad9d";
          paint["line-opacity"] = 1;
          paint["line-width"] = 1.05;
        }
        return { ...layer, paint };
      });
      return next;
    }

    function makeEsriBuildingBasemapLayer(paneName = "basemapColorPane") {
      if (!(window.L && L.esri && L.esri.Vector && L.esri.Vector.vectorTileLayer)) return null;

      const options = {
        pane: paneName,
        preserveDrawingBuffer: true,
        style: styleEsriBuildingBasemap
      };
      if (ESRI_API_KEY) options.apikey = ESRI_API_KEY;

      return L.esri.Vector.vectorTileLayer(ESRI_OSM_VECTOR_TILE_URL, options);
    }

    function makeEsriBuildingForegroundLayer(paneName = "buildingsPane") {
      if (!(window.L && L.esri && L.esri.Vector && L.esri.Vector.vectorTileLayer)) return null;
      const options = {
        pane: paneName,
        preserveDrawingBuffer: true,
        style: styleEsriBuildingForeground
      };
      if (ESRI_API_KEY) options.apikey = ESRI_API_KEY;
      const layer = L.esri.Vector.vectorTileLayer(ESRI_OSM_VECTOR_TILE_URL, options);
      const { onAdd, onRemove } = layer;
      let pendingAdd;
      // Esri 4.3.2 cannot remove a vector layer until its metadata creates
      // the inner renderer. Cancel the deferred attachment on an early off.
      layer.onAdd = function (targetMap) {
        if (this._ready) return onAdd.call(this, targetMap);
        pendingAdd = () => {
          pendingAdd = null;
          onAdd.call(this, targetMap);
        };
        this.once("ready", pendingAdd);
      };
      layer.onRemove = function (targetMap) {
        if (pendingAdd) {
          this.off("ready", pendingAdd);
          pendingAdd = null;
        } else if (this._ready) {
          onRemove.call(this, targetMap);
        }
      };
      return layer;
    }

    let map = null;
    let basemapGrayLayer = null;
    let basemapColorLayer = null;
    let satelliteLayer = null;
    let roadsLayer = null;
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
    let depthQueryGridPromise = null;
    let developedQueryGridPromise = null;
    let depthQueryImagePromise = null;
    let physicsForecastManifests = {};
    let physicsQueryImageCache = new Map();
    let renderedFloodPixelCache = null;
    let drainageRasterImageCache = new Map();
    let fillingCompositeCache = new Map();
    let drainageCompositeCache = new Map();
    let bathtubStageOverlayCache = new Map();
    let overlayPreloadGeneration = 0;
    let historicalTopTideWarmupScheduled = false;
    let historicalTopTideWarmupGeneration = 0;
    let cityBoundaryOutline = null;
    let cityBoundaryMask = null;
    let cityBoundaryGuide = null;
    let townAddressMarker = null;
    let townAddressSearchGeneration = 0;
    let persistentFloodPopup = null;
    let persistentDepthQueryContext = null;
    let selectedParcelFeature = null;
    let mapClickMode = "building";
    let mapQueryGeneration = 0;

    let exportMap = null;
    let exportBasemapColorLayer = null;
    let exportSatelliteLayer = null;
    let exportRoadsLayer = null;
    let exportBuildingsLayer = null;
    let exportParcelsLayer = null;
    let exportBoundaryOutline = null;
    let exportBoundaryMask = null;
    let exportBoundaryGeometryRings = null;
    let exportBoundaryGeometryFeature = null;
    let exportFloodLayer = null;
    let municipalBoundaryLoadPromise = null;
    let municipalBoundaryFeature = null;
    let municipalBoundaryRings = [];
    let currentFloodLayer = null;
    let pendingFloodLayer = null;
    let floodLatLngBounds = null;
    let floodOverlayGeometryMode = "world-file";
    let mapHasFit = false;
    let deferredMapLayersStarted = false;

    let forecastData = null;
    let currentForecastScenario = "mean";
    const FORECAST_SCENARIOS = {
      lowEnd: { label: "Lower End", percentile: "", buttonId: "forecastLowBtn" },
      mean: { label: "Mean", percentile: "", buttonId: "forecastMeanBtn" },
      highEnd: { label: "Upper End", percentile: "", buttonId: "forecastHighBtn" }
    };
    let returnIntervalData = null;
    let currentReturnIntervalYears = 10;
    const RETURN_INTERVAL_OPTIONS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
    let observedData = null;
    let canonicalDailyData = null;
    let observed15MinuteData = null;
    let observedArchiveIndexTextPromise = null;
    let observed15MinuteDaysByDate = new Map();
    // Distinct caches: identical dates do not imply identical gauge or cadence.
    let lewesHourlyDaysByDate = new Map();
    let observedArchiveUnavailableYears = new Set();
    let lewesHourlyData = null;
    let lewesArchiveIndexData = null;
    let lewesArchiveIndexPromise = null;
    let lewesArchiveIndexWarmupScheduled = false;
    let observedArchiveYearPromises = new Map();
    let observedArchiveLoadedYears = new Set();
    let observedDaysCache = null;
    let observedMonthKeys = [];
    let topTideEvents = [];
    let historicTopTideEntries = [];
    let historicalTopTidesPromise = null;
    let backgroundDataPromise = null;
    let currentMonthKey = null;
    let selectedObservedDate = null;

    let currentDataMode = DEFAULT_DATA_MODE;
    let currentOverlayMode = DEFAULT_OVERLAY_MODE;
    let currentSeriesHours = [];
    let currentHourIndex = 0;
    let currentSelectedLabel = "Forecast";
    let currentSelectedSubLabel = "--";
    let currentViewType = "forecast";
    let currentTopTideIndex = null;
    let currentRangeLabel = "--";
    let currentBaseModeBeforeTopTide = "observed";
    let currentDatum = "mllw";
    let currentObservedResolution = "1hour";
    let currentTimelineIntervalMinutes = 60;
    let currentRawSeriesHours = [];

