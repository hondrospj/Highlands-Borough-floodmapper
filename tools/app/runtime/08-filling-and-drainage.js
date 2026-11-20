    function isDisconnectedRasterPixel(values, offset) {
      return values[offset + 3] > 0 &&
        Math.abs(values[offset] - 99) <= 4 &&
        Math.abs(values[offset + 1] - 212) <= 4 &&
        Math.abs(values[offset + 2] - 113) <= 4;
    }

    function isWetRasterPixel(values, offset) {
      return values[offset + 3] > 0 && !isDisconnectedRasterPixel(values, offset);
    }

    function getDrainageDepthColor(depthFt) {
      for (let index = 0; index < DRAINAGE_DEPTH_BREAKS_FT.length; index += 1) {
        if (depthFt < DRAINAGE_DEPTH_BREAKS_FT[index]) return DRAINAGE_DEPTH_COLORS[index];
      }
      return DRAINAGE_DEPTH_COLORS[DRAINAGE_DEPTH_COLORS.length - 1];
    }

    function getDrainageStageColor(stageFt) {
      if (stageFt >= MAJOR_FLOOD_FT) return DRAINAGE_STAGE_COLORS[2];
      if (stageFt >= MODERATE_FLOOD_FT) return DRAINAGE_STAGE_COLORS[1];
      return DRAINAGE_STAGE_COLORS[0];
    }

    function getFillingStageFraction(rawStageFt, lowerStageFt) {
      const raw = Number(rawStageFt);
      const lower = Number(lowerStageFt);
      if (!Number.isFinite(raw) || !Number.isFinite(lower)) return 0;
      return Math.max(0, Math.min(1, (raw - lower) / STAGE_STEP));
    }

    function getFillingTransitionBlend(stageFraction) {
      const fraction = Math.max(0, Math.min(1, Number(stageFraction) || 0));
      // Ease the whole newly connected surface in together. A spatial wipe
      // exposes the one-pixel routing skeleton first, which reads as long
      // lines and leaves large pure-green gaps between catalog stages. Treat
      // each catalog tenth as representing values that round to that tenth,
      // so the upper frame is fully established at the half-tenth boundary.
      const nearestFrameProgress = Math.min(1, fraction * 2);
      return nearestFrameProgress * nearestFrameProgress * (3 - 2 * nearestFrameProgress);
    }

    function isDevelopedRasterPixel(developedPixels, offset) {
      return Boolean(developedPixels && developedPixels[offset + 2] >= 128);
    }

    function isFillingTransitionCandidate(lowerPixels, upperPixels, developedPixels, pixel) {
      const offset = pixel * 4;
      return !isWetRasterPixel(lowerPixels, offset) &&
        isWetRasterPixel(upperPixels, offset) &&
        isDevelopedRasterPixel(developedPixels, offset);
    }

    function isShallowFillingTransitionPixel(depthPixels, pixel) {
      if (!depthPixels) return false;
      const offset = pixel * 4;
      const shallow = DRAINAGE_DEPTH_COLORS[0];
      return depthPixels[offset + 3] > 0 &&
        Math.abs(depthPixels[offset] - shallow[0]) <= 4 &&
        Math.abs(depthPixels[offset + 1] - shallow[1]) <= 4 &&
        Math.abs(depthPixels[offset + 2] - shallow[2]) <= 4;
    }

    function getFillingTransitionPixelDepth(queryPixels, developedPixels, pixel, rawStageFt) {
      if (!queryPixels || !developedPixels || queryPixels.length !== developedPixels.length) return null;
      const offset = pixel * 4;
      const encodedGround = queryPixels[offset] * 256 + queryPixels[offset + 1];
      if (!encodedGround) return null;
      const groundFt = (encodedGround - 32768) / 10;
      const connectionCode = queryPixels[offset + 2];
      const stageFt = Number(rawStageFt);
      // The upper catalog raster already limits this interpolation to cells
      // that connect during the current tenth-foot interval. Do not compare
      // its quantized connection code to the in-between gauge value or the
      // whole surface remains green until the next catalog frame.
      if (!Number.isFinite(stageFt) || connectionCode === 255) return null;
      const developed = isDevelopedRasterPixel(developedPixels, offset);
      const adjustedStageFt = stageFt - (developed ? getVerticalBathtubPenalty(stageFt) : 0);
      if (groundFt > adjustedStageFt + 1e-9) return null;
      // Use the same local water surface as the query and catalog depth model.
      return Math.max(0.005, adjustedStageFt - groundFt);
    }

    function buildFillingTransitionQueue(
      lowerPixels,
      upperPixels,
      developedPixels,
      width,
      height,
      depthPixels = upperPixels
    ) {
      const pixelCount = width * height;
      const candidateState = new Uint8Array(pixelCount);
      const shallowState = new Uint8Array(pixelCount);
      // The upper catalog raster is the authority for where the next tenth
      // may flood. Restrict the in-between front to developed pixels and never
      // invent water outside that authoritative mask.
      for (let pixel = 0; pixel < pixelCount; pixel += 1) {
        if (isFillingTransitionCandidate(lowerPixels, upperPixels, developedPixels, pixel)) {
          candidateState[pixel] = 1;
          if (isShallowFillingTransitionPixel(depthPixels, pixel)) shallowState[pixel] = 1;
        }
      }
      const hasLowerWetNeighbour = pixel => {
        const x = pixel % width;
        const y = Math.floor(pixel / width);
        return (x > 0 && isWetRasterPixel(lowerPixels, (pixel - 1) * 4)) ||
          (x + 1 < width && isWetRasterPixel(lowerPixels, (pixel + 1) * 4)) ||
          (y > 0 && isWetRasterPixel(lowerPixels, (pixel - width) * 4)) ||
          (y + 1 < height && isWetRasterPixel(lowerPixels, (pixel + width) * 4));
      };

      const neighboursOf = pixel => {
        const x = pixel % width;
        const y = Math.floor(pixel / width);
        const neighbours = [];
        if (x > 0) neighbours.push(pixel - 1);
        if (x + 1 < width) neighbours.push(pixel + 1);
        if (y > 0) neighbours.push(pixel - width);
        if (y + 1 < height) neighbours.push(pixel + width);
        return neighbours;
      };

      // Feeder cells are deliberately encoded by the hydraulic generator as
      // the 0.00-0.10 ft depth class. Reveal each source-connected shallow
      // component before widening the surrounding basin. This preserves the
      // visible source-to-basin trickle at fractional tenth-foot stages.
      const shallowVisited = new Uint8Array(pixelCount);
      const shallowComponents = [];
      for (let pixel = 0; pixel < pixelCount; pixel += 1) {
        if (shallowState[pixel] !== 1 || shallowVisited[pixel]) continue;
        const members = [];
        const componentQueue = [pixel];
        let seed = -1;
        shallowVisited[pixel] = 1;
        for (let head = 0; head < componentQueue.length; head += 1) {
          const current = componentQueue[head];
          members.push(current);
          if (seed < 0 && hasLowerWetNeighbour(current)) seed = current;
          for (const neighbour of neighboursOf(current)) {
            if (shallowState[neighbour] !== 1 || shallowVisited[neighbour]) continue;
            shallowVisited[neighbour] = 1;
            componentQueue.push(neighbour);
          }
        }
        if (seed < 0) continue;

        // Trace one shortest source-to-interior spine through the component.
        // The upper depth raster already encodes the generator's feeder as
        // shallow water, so this reaches the end of that feeder before area
        // is spent widening its edges.
        const memberSet = new Set(members);
        const seeds = members.filter(hasLowerWetNeighbour);
        const ordered = seeds.slice();
        const predecessor = new Map(seeds.map(current => [current, -1]));
        const distance = new Map(seeds.map(current => [current, 1]));
        let farthest = seed;
        for (let head = 0; head < ordered.length; head += 1) {
          const current = ordered[head];
          const currentDistance = distance.get(current);
          if (currentDistance > distance.get(farthest) ||
              (currentDistance === distance.get(farthest) && current < farthest)) {
            farthest = current;
          }
          for (const neighbour of neighboursOf(current)) {
            if (!memberSet.has(neighbour) || predecessor.has(neighbour)) continue;
            predecessor.set(neighbour, current);
            distance.set(neighbour, currentDistance + 1);
            ordered.push(neighbour);
          }
        }
        const spine = [];
        for (let current = farthest; current >= 0; current = predecessor.get(current)) {
          spine.push(current);
        }
        spine.reverse();
        shallowComponents.push({ first: pixel, size: members.length, ordered, spine });
      }

      shallowComponents.sort((left, right) =>
        right.size - left.size || left.first - right.first
      );
      const queue = [];
      const queued = new Set();
      for (const component of shallowComponents) {
        for (const pixel of component.spine) {
          queue.push(pixel);
          queued.add(pixel);
        }
      }
      for (const component of shallowComponents) {
        for (const pixel of component.ordered) {
          if (queued.has(pixel)) continue;
          queue.push(pixel);
          queued.add(pixel);
        }
      }

      // Then expand through every remaining eligible pixel by sides. Filtering
      // the shallow prefix out of this ordinary BFS keeps the result monotonic
      // while preserving the same final upper-stage footprint.
      const expansionQueue = [];
      for (let pixel = 0; pixel < pixelCount; pixel += 1) {
        if (candidateState[pixel] !== 1 || !hasLowerWetNeighbour(pixel)) continue;
        candidateState[pixel] = 2;
        expansionQueue.push(pixel);
      }
      for (let head = 0; head < expansionQueue.length; head += 1) {
        const pixel = expansionQueue[head];
        for (const neighbour of neighboursOf(pixel)) {
          if (candidateState[neighbour] !== 1) continue;
          candidateState[neighbour] = 2;
          expansionQueue.push(neighbour);
        }
      }
      for (const pixel of expansionQueue) {
        if (!queued.has(pixel)) queue.push(pixel);
      }
      return queue;
    }

    function applyFillingTransitionPixels(
      lowerPixels,
      upperPixels,
      developedPixels,
      width,
      height,
      rawStageFt,
      lowerStageFt,
      mode,
      depthPixels = upperPixels,
      queryPixels = null
    ) {
      if (!lowerPixels || !upperPixels || lowerPixels.length !== upperPixels.length ||
          !developedPixels || developedPixels.length !== lowerPixels.length ||
          !queryPixels || queryPixels.length !== lowerPixels.length ||
          width * height * 4 !== lowerPixels.length) return 0;
      const fraction = getFillingStageFraction(rawStageFt, lowerStageFt);
      if (!(fraction > 0)) return 0;
      const blend = getFillingTransitionBlend(fraction);
      const transitionStageRgb = getDrainageStageColor(rawStageFt);
      let added = 0;
      const pixelCount = width * height;
      for (let pixel = 0; pixel < pixelCount; pixel += 1) {
        if (!isFillingTransitionCandidate(lowerPixels, upperPixels, developedPixels, pixel)) continue;
        const depthFt = getFillingTransitionPixelDepth(
          queryPixels,
          developedPixels,
          pixel,
          rawStageFt
        );
        if (!Number.isFinite(depthFt)) continue;
        const offset = pixel * 4;
        const color = mode === "depth"
          ? getDrainageDepthColor(depthFt)
          : transitionStageRgb;
        const sourceAlpha = lowerPixels[offset + 3];
        if (sourceAlpha > 0) {
          lowerPixels[offset] = Math.round(lowerPixels[offset] * (1 - blend) + color[0] * blend);
          lowerPixels[offset + 1] = Math.round(lowerPixels[offset + 1] * (1 - blend) + color[1] * blend);
          lowerPixels[offset + 2] = Math.round(lowerPixels[offset + 2] * (1 - blend) + color[2] * blend);
          lowerPixels[offset + 3] = Math.round(sourceAlpha * (1 - blend) + 225 * blend);
        } else {
          lowerPixels[offset] = color[0];
          lowerPixels[offset + 1] = color[1];
          lowerPixels[offset + 2] = color[2];
          lowerPixels[offset + 3] = Math.round(225 * blend);
        }
        added += 1;
      }
      return added;
    }

    function applyDrainageRetentionPixels(currentPixels, historicalPixelSets, queryPixels, stageFt, mode) {
      const pixelCount = Math.floor(currentPixels.length / 4);
      if (!pixelCount || !queryPixels || queryPixels.length !== currentPixels.length) return 0;
      const history = (historicalPixelSets || []).filter(
        values => values && values.length === currentPixels.length
      );
      if (!history.length) return 0;
      // The first history raster is the crest footprint. A falling limb may
      // retain water from that footprint, but it must never admit a pixel that
      // was not present at crest merely because a phase penalty was released.
      // A confirmed blue pixel over the full crest footprint stays blue; it
      // may become shallower or disappear, but it never downgrades to green.
      const crestPixels = history[0];
      let modified = 0;
      for (let pixel = 0, offset = 0; pixel < pixelCount; pixel += 1, offset += 4) {
        if (!isWetRasterPixel(currentPixels, offset) || crestPixels[offset + 3] > 0) continue;
        currentPixels[offset] = 0;
        currentPixels[offset + 1] = 0;
        currentPixels[offset + 2] = 0;
        currentPixels[offset + 3] = 0;
        modified += 1;
      }
      const retained = new Uint8Array(pixelCount);
      for (const historyPixels of history) {
        for (let pixel = 0, offset = 0; pixel < pixelCount; pixel += 1, offset += 4) {
          if (!retained[pixel] && crestPixels[offset + 3] > 0 &&
              isWetRasterPixel(historyPixels, offset)) retained[pixel] = 1;
        }
      }

      const retainedStageRgb = getDrainageStageColor(stageFt);
      for (let pixel = 0, offset = 0; pixel < pixelCount; pixel += 1, offset += 4) {
        if (!retained[pixel] || isWetRasterPixel(currentPixels, offset)) continue;
        const encodedGround = queryPixels[offset] * 256 + queryPixels[offset + 1];
        if (!encodedGround) continue;
        const groundFt = (encodedGround - 32768) / 10;
        const depthFt = Number(stageFt) - groundFt;
        if (!(depthFt > 0.005)) continue;
        const color = mode === "depth" ? getDrainageDepthColor(depthFt) : retainedStageRgb;
        currentPixels[offset] = color[0];
        currentPixels[offset + 1] = color[1];
        currentPixels[offset + 2] = color[2];
        currentPixels[offset + 3] = 225;
        modified += 1;
      }
      return modified;
    }

    function getDrainageRetentionMilestones(entry, series = currentRawSeriesHours) {
      const phase = getHydraulicPhaseForEntry(entry, null, series);
      const crestStage = Number(entry?.hydraulicCrestStageFt);
      const currentTime = entryTimeMs(entry);
      const crestTime = Date.parse(entry?.hydraulicCrestTimeUtc || "");
      if (!phase.startsWith("draining") || !Number.isFinite(crestStage) ||
          crestStage < MINOR_FLOOD_FT || !Number.isFinite(currentTime) || !Number.isFinite(crestTime)) return [];

      const visible = Array.isArray(series) ? series : [];
      const antecedents = entry?.hydraulicAntecedents ||
        visible.find(row => Array.isArray(row.hydraulicAntecedents))?.hydraulicAntecedents || [];
      const rows = antecedents.concat(visible)
        .filter(row => {
          const time = entryTimeMs(row);
          return Number.isFinite(time) && time >= crestTime && time < currentTime && Number.isFinite(getStageValue(row));
        });
      const selected = new Map();
      for (const row of rows) {
        const rowPhase = getHydraulicPhaseForEntry(row, null, series);
        if (rowPhase === "filling") continue;
        const existing = selected.get(rowPhase);
        if (!existing || getStageValue(row) > getStageValue(existing)) selected.set(rowPhase, row);
      }
      return Array.from(selected.values()).sort((a, b) => entryTimeMs(a) - entryTimeMs(b));
    }

