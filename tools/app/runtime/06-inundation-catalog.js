    function clampStage(value) {
      return Math.max(MIN_STAGE, Math.min(MAX_STAGE, value));
    }

    function roundToCatalogPrecision(value) {
      return Number(value.toFixed(2));
    }

    function floorToCatalogStep(value) {
      const stepped = Math.floor((value + 1e-9) / STAGE_STEP) * STAGE_STEP;
      return roundToCatalogPrecision(stepped);
    }

    function getOverlayStage(value) {
      const n = normalizeStageValue(value);
      if (!Number.isFinite(n)) return null;
      const minimum = MIN_DEPTH_STAGE;
      const clamped = Math.max(minimum, Math.min(MAX_STAGE, n));
      return Math.max(minimum, floorToCatalogStep(clamped));
    }

    function getVerticalBathtubPenalty(stageValue) {
      const stage = Number(stageValue);
      if (!Number.isFinite(stage)) return null;
      const configured = TOWN_CONFIG?.overlays?.depthPenalty;
      if (configured) {
        const low = Number(configured.atOrBelowMinorFt);
        const high = Number(configured.atOrAboveMajorFt);
        const decay = Number(configured.exponentialDecayRate);
        const lowPenalty = Number.isFinite(low) ? low : 0;
        const highPenalty = Number.isFinite(high) ? high : 0;
        if (stage <= MINOR_FLOOD_FT) return lowPenalty;
        if (stage >= MAJOR_FLOOD_FT) return highPenalty;
        const progress = (stage - MINOR_FLOOD_FT) / (MAJOR_FLOOD_FT - MINOR_FLOOD_FT);
        if (Number.isFinite(decay) && decay > 0) {
          const residual = Math.exp(-decay);
          const normalized = (Math.exp(-decay * progress) - residual) / (1 - residual);
          return highPenalty + (lowPenalty - highPenalty) * normalized;
        }
        return lowPenalty + (highPenalty - lowPenalty) * progress;
      }
      if (stage < MINOR_FLOOD_FT) return 0;
      if (stage >= MAJOR_FLOOD_FT) return MAJOR_VERTICAL_PENALTY_FT;
      const x0 = MINOR_FLOOD_FT;
      const x1 = MODERATE_FLOOD_FT;
      const x2 = MAJOR_FLOOD_FT;
      const l0 = ((stage - x1) * (stage - x2)) / ((x0 - x1) * (x0 - x2));
      const l1 = ((stage - x0) * (stage - x2)) / ((x1 - x0) * (x1 - x2));
      const l2 = ((stage - x0) * (stage - x1)) / ((x2 - x0) * (x2 - x1));
      return Math.max(0,
        MINOR_VERTICAL_PENALTY_FT * l0 +
        MODERATE_VERTICAL_PENALTY_FT * l1 +
        MAJOR_VERTICAL_PENALTY_FT * l2
      );
    }

    function getPenaltyRemainingFraction(stageValue, phase = "slack") {
      if (TOWN_CONFIG?.overlays?.phaseModelEnabled === false) return 1;
      const stage = Number(stageValue);
      const normalizedPhase = normalizeHydraulicPhase(phase);
      const penalty = getVerticalBathtubPenalty(stage);
      if (!Number.isFinite(penalty) || penalty <= 0 || normalizedPhase === "draining") return 0;
      if (normalizedPhase === "filling" || normalizedPhase === "slack") return 1;
      if (normalizedPhase === "draining-release-15") {
        return stage < MODERATE_FLOOD_FT ? 2 / 3 : 1 / 2;
      }
      if (normalizedPhase === "draining-release-30") {
        return stage < MODERATE_FLOOD_FT ? 1 / 3 : 0;
      }
      return 0;
    }

    function getPenalizedConnectedDepth(stageValue, groundValue, developed = true, phase = "slack", sourceDistanceFt = null) {
      const stage = Number(stageValue);
      const ground = Number(groundValue);
      const polynomialPenalty = getVerticalBathtubPenalty(stage);
      if (!Number.isFinite(stage) || !Number.isFinite(ground) || !Number.isFinite(polynomialPenalty)) return null;
      const rawDepth = Math.max(0, stage - ground);
      const configuredPenalty = TOWN_CONFIG?.overlays?.depthPenalty;
      const maximumLocalFraction = Number(configuredPenalty?.maximumLocalDepthFraction);
      const staticPenaltyModel = TOWN_CONFIG?.overlays?.phaseModelEnabled === false;
      const appliedPenalty = developed
        ? (staticPenaltyModel && Number.isFinite(maximumLocalFraction)
          ? Math.min(polynomialPenalty, rawDepth * maximumLocalFraction)
          : polynomialPenalty)
        : 0;
      const normalizedPhase = normalizeHydraulicPhase(phase);
      const penaltyRemainingFraction = getPenaltyRemainingFraction(stage, normalizedPhase);
      const adjustment = -appliedPenalty * penaltyRemainingFraction;
      const adjustedStage = stage + adjustment;
      const postCrest = staticPenaltyModel ? false : normalizedPhase.startsWith("draining");
      const waterSurface = postCrest ? stage : adjustedStage;
      const depth = Math.max(0, waterSurface - ground);
      return {
        rawDepth,
        polynomialPenalty,
        appliedPenalty,
        penaltyRemainingFraction,
        sourceDistanceFt,
        adjustment,
        adjustedStage,
        depth,
        localWaterSurface: waterSurface
      };
    }

    function getDepthTimelineColor(stageValue) {
      const n = Number(stageValue);
      if (!Number.isFinite(n)) return "rgba(121,221,90,.92)";
      if (n < MINOR_FLOOD_FT) return "rgba(121,221,90,.92)";
      if (n < MODERATE_FLOOD_FT) return "rgba(213,138,0,.92)";
      if (n < MAJOR_FLOOD_FT) return "rgba(216,75,103,.92)";
      return "rgba(124,92,224,.92)";
    }

    function getImpactTimelineColor(stageValue) {
      const n = Number(stageValue);
      if (!Number.isFinite(n)) return "rgba(121,221,90,.92)";
      if (n < MINOR_FLOOD_FT) return "rgba(121,221,90,.92)";
      if (n < MODERATE_FLOOD_FT) return "rgba(213,138,0,.92)";
      if (n < MAJOR_FLOOD_FT) return "rgba(216,75,103,.92)";
      return "rgba(124,92,224,.92)";
    }

    function getTimelineHourColor(entry) {
      const rawStage = getStageValue(entry);
      if (currentOverlayMode === "dynamic") {
        return getImpactTimelineColor(rawStage);
      }
      return getDepthTimelineColor(rawStage);
    }

    function buildTimelineGroupGradient(startIndex, endIndex, sampleCenters = false) {
      const entries = currentSeriesHours.slice(startIndex, endIndex + 1);
      if (!entries.length) return "";
      // Whole-series day bands meet halfway between adjacent frame centers.
      // A selected-day mobile slider instead spans its first and last centers.
      const firstEdge = sampleCenters ? startIndex : Math.max(0, startIndex - 0.5);
      const lastEdge = sampleCenters ? endIndex : Math.min(currentSeriesHours.length - 1, endIndex + 0.5);
      const span = lastEdge - firstEdge;
      if (span <= 0) return `linear-gradient(90deg, ${getTimelineHourColor(entries[0])}, ${getTimelineHourColor(entries[0])})`;
      const stops = [];
      entries.forEach((entry, idx) => {
        const color = getStageValue(entry) == null ? "#94a3b8" : getTimelineHourColor(entry);
        const startPct = 100 * (Math.max(firstEdge, startIndex + idx - 0.5) - firstEdge) / span;
        const endPct = 100 * (Math.min(lastEdge, startIndex + idx + 0.5) - firstEdge) / span;
        stops.push(`${color} ${startPct.toFixed(3)}%`, `${color} ${endPct.toFixed(3)}%`);
      });
      return `linear-gradient(90deg, ${stops.join(", ")})`;
    }

    function stageToCode(stageValue) {
      const n = Number(stageValue);
      const sign = n < 0 ? "m" : "p";
      const scale = Number(TOWN_CONFIG?.overlays?.stageCodeScale) || 10;
      const width = Number(TOWN_CONFIG?.overlays?.stageCodeWidth) || (scale >= 100 ? 4 : 3);
      const units = Math.round(Math.abs(n) * scale);
      return `${sign}${String(units).padStart(width, "0")}`;
    }

    function normalizeHydraulicPhase(value) {
      const phase = String(value || "").toLowerCase();
      const supported = new Set([
        "filling",
        "slack",
        "draining-release-15",
        "draining-release-30",
        "draining"
      ]);
      return supported.has(phase) ? phase : "slack";
    }

    function getHydraulicFrameMinutes(entry, fallback = 15) {
      const explicitMinutes = Number(entry?.timelineIntervalMinutes);
      if (Number.isFinite(explicitMinutes) && explicitMinutes > 0) return explicitMinutes;
      if (entry?.observationInterval === "15min") return 15;
      if (entry?.observationInterval === "1hour") return 60;
      return fallback;
    }

    function findHydraulicCrestIndex(series = [], resolvedIndex = 0) {
      const rows = Array.isArray(series) ? series : [];
      if (!rows.length) return -1;
      const safeIndex = Math.max(0, Math.min(Number(resolvedIndex) || 0, rows.length - 1));
      const currentTime = entryTimeMs(rows[safeIndex]);
      const maximumLookbackMinutes = 8 * 60;
      const separatingDropFt = 0.4;
      let crestIndex = safeIndex;
      let crestStage = getStageValue(rows[safeIndex]);

      for (let candidate = safeIndex - 1; candidate >= 0; candidate -= 1) {
        const candidateTime = entryTimeMs(rows[candidate]);
        if (Number.isFinite(currentTime) && Number.isFinite(candidateTime) &&
            currentTime - candidateTime > maximumLookbackMinutes * 60 * 1000) break;
        if (!Number.isFinite(currentTime) && safeIndex - candidate > 32) break;
        const candidateStage = getStageValue(rows[candidate]);
        if (!Number.isFinite(candidateStage)) continue;
        if (!Number.isFinite(crestStage) || candidateStage > crestStage + 1e-9 ||
            (Math.abs(candidateStage - crestStage) <= 1e-9 && candidate > crestIndex)) {
          crestStage = candidateStage;
          crestIndex = candidate;
        } else if (candidate < crestIndex && candidateStage < crestStage - separatingDropFt) {
          // This is the pre-crest trough. Stop before an earlier, potentially
          // higher tide can replace the active event's local high water.
          break;
        }
      }
      return crestIndex;
    }

    function getHydraulicElapsedMinutes(rows, crestIndex, resolvedIndex) {
      const crestTime = entryTimeMs(rows[crestIndex]);
      const currentTime = entryTimeMs(rows[resolvedIndex]);
      if (Number.isFinite(crestTime) && Number.isFinite(currentTime)) {
        return Math.max(0, (currentTime - crestTime) / 60000);
      }
      return Math.max(0, resolvedIndex - crestIndex) * getHydraulicFrameMinutes(rows[resolvedIndex]);
    }

    function inferHydraulicPhaseForIndex(series = [], index = 0) {
      const rows = Array.isArray(series) ? series : [];
      const resolvedIndex = Math.max(0, Math.min(Number(index) || 0, rows.length - 1));
      if (resolvedIndex < 0) return "slack";

      const current = getStageValue(rows[resolvedIndex]);
      const previous = resolvedIndex > 0 ? getStageValue(rows[resolvedIndex - 1]) : null;
      const next = resolvedIndex + 1 < rows.length ? getStageValue(rows[resolvedIndex + 1]) : null;
      const before = Number.isFinite(current) && Number.isFinite(previous) ? current - previous : null;
      const after = Number.isFinite(next) && Number.isFinite(current) ? next - current : null;
      const epsilon = 0.025;

      if (Number.isFinite(before) && Number.isFinite(after) && before > epsilon && after <= epsilon) return "slack";
      if (Number.isFinite(before) && Number.isFinite(after) && before >= 0 && after < -epsilon) return "slack";
      if (Number.isFinite(before) && Number.isFinite(after) && before < -epsilon && after >= -epsilon) return "draining";
      if (Number.isFinite(before) && Number.isFinite(after) && before <= epsilon && after > epsilon) {
        return before < 0 ? "draining" : "slack";
      }

      // Once the series is falling, recover the latest local high tide and
      // release the admission penalty using North Wildwood's calibrated
      // 45/30/0-minute minor/moderate/major durations.
      const falling = (Number.isFinite(before) && before < -epsilon) ||
        (Number.isFinite(after) && after < -epsilon && Number.isFinite(before) && before < 0);
      if (falling) {
        const crestIndex = findHydraulicCrestIndex(rows, resolvedIndex);
        const crestStage = getStageValue(rows[crestIndex]);
        const minutesSinceCrest = getHydraulicElapsedMinutes(rows, crestIndex, resolvedIndex);
        if (crestStage < MINOR_FLOOD_FT || crestStage >= MAJOR_FLOOD_FT) return "draining";
        if (crestStage >= MODERATE_FLOOD_FT) {
          return minutesSinceCrest <= 15 ? "draining-release-15" : "draining";
        }
        if (minutesSinceCrest <= 15) return "draining-release-15";
        if (minutesSinceCrest <= 30) return "draining-release-30";
        return "draining";
      }

      const delta = Number.isFinite(after) && (!Number.isFinite(before) || Math.abs(after) >= Math.abs(before)) ? after : before;
      if (Number.isFinite(delta) && delta > epsilon) return "filling";
      if (Number.isFinite(delta) && delta < -epsilon) return "draining";
      return "slack";
    }

    function annotateHydraulicSeries(series = []) {
      const selected = (Array.isArray(series) ? series : []).map(entry => ({ ...entry }));
      // Historical day timelines retain their preceding measurements as
      // context, including when Top 10 or an off-grid export reannotates them.
      const history = selected.find(entry => Array.isArray(entry.hydraulicAntecedents))?.hydraulicAntecedents || [];
      const firstTime = entryTimeMs(selected[0]);
      const antecedents = history.filter(entry => Number.isFinite(firstTime) && entryTimeMs(entry) < firstTime);
      const rows = antecedents.concat(selected);
      const phases = rows.map((entry, index) => (
        Number.isFinite(getStageValue(entry)) ? inferHydraulicPhaseForIndex(rows, index) : "slack"
      ));
      return rows.map((entry, index) => {
        const phase = phases[index];
        const annotated = {
          ...entry,
          hydraulicPhase: phase,
          hydraulicPhaseCanonical: true
        };
        if (!phase.startsWith("draining")) return annotated;
        const crestIndex = findHydraulicCrestIndex(rows, index);
        const crestEntry = rows[crestIndex];
        return {
          ...annotated,
          hydraulicCrestIndex: crestIndex,
          hydraulicCrestTimeUtc: Number.isFinite(entryTimeMs(crestEntry))
            ? new Date(entryTimeMs(crestEntry)).toISOString()
            : null,
          hydraulicCrestStageFt: getStageValue(crestEntry),
          hydraulicElapsedMinutes: getHydraulicElapsedMinutes(rows, crestIndex, index)
        };
      }).slice(antecedents.length);
    }

    function getHydraulicPhaseForEntry(entry, index = null, series = currentSeriesHours) {
      if (entry?.hydraulicPhaseCanonical && entry?.hydraulicPhase) {
        return normalizeHydraulicPhase(entry.hydraulicPhase);
      }
      const rows = Array.isArray(series) ? series : [];
      let resolvedIndex = Number.isInteger(index) ? index : rows.indexOf(entry);
      if (resolvedIndex < 0 && entry) resolvedIndex = findClosestEntryIndex(rows, entry);
      if (resolvedIndex < 0) return entry?.hydraulicPhase
        ? normalizeHydraulicPhase(entry.hydraulicPhase)
        : "slack";
      return inferHydraulicPhaseForIndex(rows, resolvedIndex);
    }

    function getOverlayFilename(mode, stageValue) {
      const code = stageToCode(stageValue);
      if (mode === "depth") return `${SITE_CONFIG.depthPngPrefix}${code}.png`;
      return `${SITE_CONFIG.stagePngPrefix}${code}.png`;
    }

    function getOverlayFilenameCandidates(mode, stageValue) {
      const png = getOverlayFilename(mode, stageValue);
      return [png.replace(/\.png$/, ".webp"), png];
    }

    function getOverlayCandidates(mode, stageValue, phase = "slack") {
      const normalizedPhase = normalizeHydraulicPhase(phase);
      const phaseRoots = OVERLAY_PHASE_ROOTS?.[mode]?.[normalizedPhase] || [];
      const roots = phaseRoots.length ? phaseRoots : (OVERLAY_ROOTS[mode] || []);
      // Keep the current bundled catalog. The old Bunny v37 filling images
      // do not match it, so they must not replace an unavailable current frame.
      const orderedRoots = roots.filter(root => {
        const url = new URL(root);
        return !(url.hostname === "floodmapperv1.b-cdn.net" && url.pathname.includes("/v37/"));
      });
      const filenames = getOverlayFilenameCandidates(mode, stageValue);
      const candidates = orderedRoots.flatMap(root => filenames.map(name => {
        const url = new URL(name, root);
        const version = OVERLAY_CACHE_VERSIONS?.hydraulic || OVERLAY_CACHE_VERSIONS?.[mode];
        if (version) url.searchParams.set("v", version);
        return url.href;
      }));
      if (!["cupajoe.live", "www.cupajoe.live"].includes(APP_BASE.hostname)) return candidates;
      // Use the identical published atlas directly; retain the local copy if
      // that host is unavailable. Live forecast JSON stays on its own route.
      const atlasPath = `${APP_BASE.pathname}assets/hydraulic-v29/`;
      const staticBase = new URL(TOWN_CONFIG.staticSiteBase);
      return candidates.flatMap(candidate => {
        const url = new URL(candidate);
        if (url.origin !== APP_BASE.origin || !url.pathname.startsWith(atlasPath)) return [candidate];
        const direct = new URL(url.pathname.slice(APP_BASE.pathname.length), staticBase);
        direct.search = url.search;
        return [direct.href, candidate];
      });
    }

    function latLngBoundsFromRing(ring) {
      if (!Array.isArray(ring) || ring.length < 3) return null;
      const points = ring
        .filter(point => Array.isArray(point) && point.length >= 2)
        .map(([lat, lng]) => L.latLng(Number(lat), Number(lng)))
        .filter(point => Number.isFinite(point.lat) && Number.isFinite(point.lng));
      if (!points.length) return null;
      return L.latLngBounds(points);
    }

    function getBoundaryDrivenOverlayBounds(preferMunicipalBoundary = true) {
      // Keep the startup camera independent of whether geometry was bundled
      // or fetched later. Other callers still use the authoritative extent.
      if (preferMunicipalBoundary) {
        try {
          if (cityBoundaryOutline && typeof cityBoundaryOutline.getBounds === "function") {
            const boundaryBounds = cityBoundaryOutline.getBounds();
            if (boundaryBounds && boundaryBounds.isValid && boundaryBounds.isValid()) {
              return boundaryBounds;
            }
          }
        } catch (err) {
          console.warn("Could not read drawn municipal boundary bounds; falling back to boundary ring.", err);
        }

        const ringBounds = latLngBoundsFromRing(getPrimaryMunicipalBoundaryRing());
        if (ringBounds && ringBounds.isValid && ringBounds.isValid()) {
          return ringBounds;
        }

        if (FALLBACK_LATLNG_BOUNDS && FALLBACK_LATLNG_BOUNDS.isValid && FALLBACK_LATLNG_BOUNDS.isValid()) {
          return FALLBACK_LATLNG_BOUNDS;
        }
      }

      const center = TOWN_CONFIG?.map?.center || {};
      const lat = Number(center.lat);
      const lon = Number(center.lon);
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        return L.latLngBounds([lat - 0.03, lon - 0.04], [lat + 0.03, lon + 0.04]);
      }

      return L.latLngBounds([0, 0], [0.01, 0.01]);
    }

