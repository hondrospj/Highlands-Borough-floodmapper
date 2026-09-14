#!/usr/bin/env python3
"""Site-agnostic stabilization for raster hydraulic-mask sequences.

The hydraulic model remains authoritative for candidate wet cells.  This
module only applies temporal invariants that any rising/falling water sequence
must satisfy and, when an eligibility mask is supplied, repairs tiny enclosed
render-grid holes without crossing dry terrain or a modeled barrier.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


def _neighbour_count(mask: np.ndarray) -> np.ndarray:
    values = np.asarray(mask, dtype=np.uint8)
    count = np.zeros(values.shape, dtype=np.uint8)
    count[1:, :] += values[:-1, :]
    count[:-1, :] += values[1:, :]
    count[:, 1:] += values[:, :-1]
    count[:, :-1] += values[:, 1:]
    return count


def _square_dilate(mask: np.ndarray, radius: int) -> np.ndarray:
    source = np.asarray(mask, dtype=bool)
    if radius <= 0:
        return source.copy()
    padded = np.pad(source, radius, mode="constant", constant_values=False)
    result = np.zeros(source.shape, dtype=bool)
    height, width = source.shape
    for dy in range(2 * radius + 1):
        for dx in range(2 * radius + 1):
            result |= padded[dy : dy + height, dx : dx + width]
    return result


def _square_erode(mask: np.ndarray, radius: int) -> np.ndarray:
    source = np.asarray(mask, dtype=bool)
    if radius <= 0:
        return source.copy()
    padded = np.pad(source, radius, mode="constant", constant_values=False)
    result = np.ones(source.shape, dtype=bool)
    height, width = source.shape
    for dy in range(2 * radius + 1):
        for dx in range(2 * radius + 1):
            result &= padded[dy : dy + height, dx : dx + width]
    return result


def repair_narrow_seams(
    footprint: np.ndarray,
    eligible: np.ndarray | None,
    radius_pixels: int = 0,
) -> tuple[np.ndarray, int]:
    """Close narrow raster cracks without expanding the outer footprint.

    Binary closing is idempotent and only contributes pixels allowed by the
    caller's current-stage eligibility mask.  Unioning the original footprint
    protects wet cells that touch the raster boundary from erosion.
    """
    source = np.asarray(footprint, dtype=bool)
    if eligible is None or radius_pixels <= 0 or not np.any(source):
        return source.copy(), 0
    allowed = np.asarray(eligible, dtype=bool)
    if allowed.shape != source.shape:
        raise ValueError("Footprint and seam eligibility masks must align")
    closed = _square_erode(_square_dilate(source, radius_pixels), radius_pixels)
    repaired = source | (closed & allowed)
    return repaired, int(np.count_nonzero(repaired & ~source))


def _small_enclosed_components(
    target: np.ndarray,
    enclosure: np.ndarray,
    max_size: int,
) -> list[np.ndarray]:
    """Return small target components completely surrounded by enclosure.

    The candidate search is limited to target pixels adjacent to the enclosure,
    so large exterior dry regions are not traversed.  This NumPy/Python hybrid
    deliberately avoids requiring SciPy in browser-export environments.
    """
    if max_size <= 0:
        return []
    target_mask = np.asarray(target, dtype=bool)
    enclosure_mask = np.asarray(enclosure, dtype=bool)
    potential = target_mask & (_neighbour_count(enclosure_mask) > 0)
    height, width = target_mask.shape
    flat_target = target_mask.ravel()
    flat_enclosure = enclosure_mask.ravel()
    flat_potential = potential.ravel()
    pending = set(int(value) for value in np.flatnonzero(potential))
    components: list[np.ndarray] = []
    while pending:
        seed = pending.pop()
        queue = [seed]
        component = [seed]
        closed = True
        for position in queue:
            y, x = divmod(position, width)
            if y == 0 or x == 0 or y + 1 == height or x + 1 == width:
                closed = False
            for neighbor in (
                position - width if y > 0 else -1,
                position - 1 if x > 0 else -1,
                position + 1 if x + 1 < width else -1,
                position + width if y + 1 < height else -1,
            ):
                if neighbor < 0 or flat_enclosure[neighbor]:
                    continue
                if not flat_target[neighbor]:
                    closed = False
                    continue
                if not flat_potential[neighbor]:
                    closed = False
                    continue
                if neighbor in pending:
                    pending.remove(neighbor)
                    queue.append(neighbor)
                    component.append(neighbor)
        if closed and len(component) <= max_size:
            components.append(np.asarray(component, dtype=np.int64))
    return components


def normalize_motion(value: str | None) -> str:
    """Return ``filling``, ``draining``, or ``slack`` for any phase label."""
    phase = str(value or "slack").strip().lower()
    if phase.startswith(("fill", "ris")):
        return "filling"
    if phase.startswith(("drain", "fall", "recess")):
        return "draining"
    return "slack"


def repair_small_enclosed_holes(
    wet: np.ndarray,
    eligible: np.ndarray | None,
    max_hole_pixels: int = 0,
) -> tuple[np.ndarray, int]:
    """Fill only small, fully enclosed holes that are hydraulically eligible.

    No repair is attempted without an explicit eligibility mask.  Therefore a
    generic caller cannot accidentally bridge high ground, a bulkhead, or a
    model-domain boundary merely to make the raster look smoother.
    """
    candidate = np.asarray(wet, dtype=bool)
    if eligible is None or max_hole_pixels <= 0 or not np.any(candidate):
        return candidate.copy(), 0
    allowed = np.asarray(eligible, dtype=bool)
    if allowed.shape != candidate.shape:
        raise ValueError(
            f"Wet and eligibility masks are not aligned: "
            f"{candidate.shape} != {allowed.shape}"
        )

    repaired = candidate.copy()
    components = _small_enclosed_components(
        ~candidate & allowed,
        candidate,
        int(max_hole_pixels),
    )
    for component in components:
        repaired.ravel()[component] = True
    count = sum(int(component.size) for component in components)
    return repaired, count


def repair_small_nodata_values(
    values: np.ndarray,
    max_hole_pixels: int = 0,
) -> tuple[np.ndarray, int]:
    """Interpolate tiny enclosed NoData components from their valid perimeter.

    Large gaps and all components touching the raster edge remain NoData.  A
    perimeter median is deliberately used instead of a broad blur so the
    repair cannot smear a water surface across the surrounding terrain.
    """
    source = np.asarray(values, dtype=np.float32)
    if source.ndim != 2:
        raise ValueError("Ground/eligibility rasters must be two-dimensional")
    if max_hole_pixels <= 0:
        return source.copy(), 0
    invalid = ~np.isfinite(source)
    repaired = source.copy()
    repaired_count = 0
    for component in _small_enclosed_components(
        invalid,
        ~invalid,
        int(max_hole_pixels),
    ):
        perimeter_values: list[float] = []
        for position in component:
            y, x = divmod(int(position), source.shape[1])
            for neighbor_y, neighbor_x in (
                (y - 1, x),
                (y, x - 1),
                (y, x + 1),
                (y + 1, x),
            ):
                if (
                    0 <= neighbor_y < source.shape[0]
                    and 0 <= neighbor_x < source.shape[1]
                    and np.isfinite(repaired[neighbor_y, neighbor_x])
                ):
                    perimeter_values.append(
                        float(repaired[neighbor_y, neighbor_x])
                    )
        if perimeter_values:
            repaired.ravel()[component] = float(np.median(perimeter_values))
            repaired_count += int(component.size)
    return repaired, repaired_count


@dataclass
class HydraulicMaskDiagnostics:
    frames: int = 0
    filling_pixels_preserved: int = 0
    draining_pixels_rejected: int = 0
    lookahead_pixels_admitted: int = 0
    narrow_seam_pixels_repaired: int = 0
    enclosed_hole_pixels_repaired: int = 0


class HydraulicMaskSequence:
    """Stabilize candidate masks without creating additional time frames.

    Filling and a crest approached from filling can only preserve or add wet
    cells.  Draining and a trough approached from draining can only preserve
    or remove wet cells.  Direction changes use the immediately preceding
    stabilized mask, making the class suitable for arbitrary sites and any
    number of tidal cycles.
    """

    def __init__(
        self,
        max_hole_pixels: int = 0,
        max_seam_width_pixels: int = 0,
    ) -> None:
        if max_hole_pixels < 0:
            raise ValueError("max_hole_pixels cannot be negative")
        if max_seam_width_pixels < 0:
            raise ValueError("max_seam_width_pixels cannot be negative")
        self.max_hole_pixels = int(max_hole_pixels)
        self.max_seam_width_pixels = int(max_seam_width_pixels)
        self.previous: np.ndarray | None = None
        self.last_motion: str | None = None
        self.diagnostics = HydraulicMaskDiagnostics()

    def reset(self) -> None:
        self.previous = None
        self.last_motion = None
        self.diagnostics = HydraulicMaskDiagnostics()

    def update(
        self,
        candidate_wet: np.ndarray,
        phase: str | None,
        eligible: np.ndarray | None = None,
        lookahead_wet: np.ndarray | None = None,
    ) -> np.ndarray:
        candidate = np.asarray(candidate_wet, dtype=bool)
        if candidate.ndim != 2:
            raise ValueError("Hydraulic masks must be two-dimensional")
        candidate, repaired_seams = repair_narrow_seams(
            candidate,
            eligible,
            self.max_seam_width_pixels,
        )
        candidate, repaired_before = repair_small_enclosed_holes(
            candidate,
            eligible,
            self.max_hole_pixels,
        )
        motion = normalize_motion(phase)
        effective_motion = (
            self.last_motion if motion == "slack" and self.last_motion else motion
        )

        # A caller may provide the immediately following catalog frame to
        # resolve sub-step stages.  Admit only cells that the next hydraulic
        # solution marks wet *and* the caller's current-stage physics marks
        # eligible.  One lookahead is sufficient, so source-frame reads are
        # capped at 2x and no synthetic hydraulic state is invented.
        if lookahead_wet is not None and effective_motion == "filling":
            if eligible is None:
                raise ValueError("Lookahead admission requires an eligibility mask")
            lookahead = np.asarray(lookahead_wet, dtype=bool)
            allowed = np.asarray(eligible, dtype=bool)
            if lookahead.shape != candidate.shape or allowed.shape != candidate.shape:
                raise ValueError("Candidate, lookahead, and eligibility masks must align")
            admitted = lookahead & allowed & ~candidate
            candidate |= admitted
            self.diagnostics.lookahead_pixels_admitted += int(
                np.count_nonzero(admitted)
            )
            candidate, bracket_seams = repair_narrow_seams(
                candidate,
                eligible,
                self.max_seam_width_pixels,
            )
            repaired_seams += bracket_seams

        if self.previous is None:
            stable = candidate
        else:
            if self.previous.shape != candidate.shape:
                raise ValueError(
                    f"Hydraulic mask dimensions changed inside a sequence: "
                    f"{self.previous.shape} != {candidate.shape}"
                )
            if effective_motion == "filling":
                stable = candidate | self.previous
                self.diagnostics.filling_pixels_preserved += int(
                    np.count_nonzero(self.previous & ~candidate)
                )
            elif effective_motion == "draining":
                stable = candidate & self.previous
                self.diagnostics.draining_pixels_rejected += int(
                    np.count_nonzero(candidate & ~self.previous)
                )
            else:
                stable = candidate

        # Temporal union/intersection can itself enclose a tiny eligible gap.
        # Repair once more on the final state so a single tool run is stable.
        final_eligible = eligible
        if (
            effective_motion == "draining"
            and self.previous is not None
            and eligible is not None
        ):
            final_eligible = np.asarray(eligible, dtype=bool) & self.previous
        stable, repaired_after = repair_small_enclosed_holes(
            stable,
            final_eligible,
            self.max_hole_pixels,
        )

        self.previous = stable.copy()
        if motion != "slack":
            self.last_motion = motion
        self.diagnostics.frames += 1
        self.diagnostics.enclosed_hole_pixels_repaired += (
            repaired_before + repaired_after
        )
        self.diagnostics.narrow_seam_pixels_repaired += repaired_seams
        return stable


def assert_temporal_invariant(
    previous: np.ndarray,
    current: np.ndarray,
    phase: str,
) -> None:
    """Raise when a pair of masks violates its declared tidal direction."""
    before = np.asarray(previous, dtype=bool)
    after = np.asarray(current, dtype=bool)
    if before.shape != after.shape:
        raise AssertionError("Hydraulic mask dimensions changed between frames")
    motion = normalize_motion(phase)
    if motion == "filling" and np.any(before & ~after):
        raise AssertionError("A filling frame lost previously wet pixels")
    if motion == "draining" and np.any(after & ~before):
        raise AssertionError("A draining frame introduced new wet pixels")
