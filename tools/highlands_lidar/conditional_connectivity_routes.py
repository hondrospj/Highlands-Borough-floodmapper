#!/usr/bin/env python3
"""Reusable lowest-road feeder routing for conditional flood connectivity.

The caller supplies aligned arrays, so the algorithm is independent of town,
CRS, raster dimensions, source threshold, and penalty formula. The source mask
is expected to have already applied the town's source qualification rule (for
North Wildwood: terrain <= 2.00 ft NAVD88 and at least 101 connected cells).
"""

from __future__ import annotations

import heapq

import numpy as np
from scipy.ndimage import (
    binary_dilation,
    label as ndimage_label,
)


FOUR_NEIGHBOUR_STRUCTURE = np.asarray(
    (
        (0, 1, 0),
        (1, 1, 1),
        (0, 1, 0),
    ),
    dtype=np.uint8,
)


def _require_aligned(*arrays: np.ndarray) -> tuple[int, int]:
    if not arrays or arrays[0].ndim != 2:
        raise ValueError("Conditional-connectivity arrays must be two-dimensional")
    shape = arrays[0].shape
    if any(array.shape != shape for array in arrays[1:]):
        raise ValueError(
            "Conditional-connectivity arrays are not aligned: "
            + ", ".join(str(array.shape) for array in arrays)
        )
    return shape


def _retain_source_connected(
    flooded: np.ndarray,
    source: np.ndarray,
) -> np.ndarray:
    labels, component_count = ndimage_label(
        flooded,
        structure=FOUR_NEIGHBOUR_STRUCTURE,
    )
    if component_count == 0:
        return flooded
    source_labels = np.unique(labels[flooded & source])
    source_labels = source_labels[source_labels > 0]
    keep = np.zeros(component_count + 1, dtype=bool)
    keep[source_labels] = True
    return flooded & keep[labels]


def source_block_geodesic_distance(
    qualified_source: np.ndarray,
    traversable: np.ndarray,
    cell_size_ft: float = 1.0,
) -> tuple[np.ndarray, dict[str, int | float | str]]:
    """Measure shared-side travel from immutable qualified source blocks.

    Only cells in ``qualified_source`` seed the multi-source breadth-first
    traversal. Existing water, visible feeders, and newly admitted penalty
    cells never become new origins. The resulting field is therefore reusable
    for every water stage and tidal phase in any aligned town model.
    """
    _require_aligned(qualified_source, traversable)
    size_ft = float(cell_size_ft)
    if not np.isfinite(size_ft) or size_ft <= 0:
        raise ValueError("cell_size_ft must be positive")
    source = np.asarray(qualified_source, dtype=bool)
    allowed = np.asarray(traversable, dtype=bool)
    seeds = source & allowed
    seed_positions = np.flatnonzero(seeds).astype(np.int32, copy=False)
    if seed_positions.size == 0:
        raise ValueError("No qualified source cells intersect the traversable mask")

    height, width = source.shape
    allowed_flat = allowed.ravel()
    steps = np.full(source.size, -1, dtype=np.int32)
    queue = np.empty(int(np.count_nonzero(allowed)), dtype=np.int32)
    queue[: seed_positions.size] = seed_positions
    steps[seed_positions] = 0
    head = 0
    tail = int(seed_positions.size)

    while head < tail:
        position = int(queue[head])
        head += 1
        next_step = int(steps[position]) + 1
        x = position % width
        for neighbor in (
            position - width if position >= width else -1,
            position - 1 if x > 0 else -1,
            position + 1 if x + 1 < width else -1,
            position + width if position + width < source.size else -1,
        ):
            if neighbor < 0 or steps[neighbor] >= 0 or not allowed_flat[neighbor]:
                continue
            steps[neighbor] = next_step
            queue[tail] = neighbor
            tail += 1

    reachable = steps >= 0
    distance_ft = np.full(source.size, np.inf, dtype=np.float32)
    distance_ft[reachable] = steps[reachable].astype(np.float32) * size_ft
    distance_ft = distance_ft.reshape(source.shape)
    maximum_distance = (
        float(distance_ft[reachable.reshape(source.shape)].max())
        if np.any(reachable)
        else 0.0
    )
    return distance_ft, {
        "method": "four-neighbour geodesic distance from immutable qualified source blocks",
        "sourcePixels": int(seed_positions.size),
        "traversablePixels": int(np.count_nonzero(allowed)),
        "reachablePixels": int(tail),
        "unreachableTraversablePixels": int(np.count_nonzero(allowed) - tail),
        "cellSizeFt": size_ft,
        "maximumDistanceFt": maximum_distance,
    }


def connect_penalty_basins_by_lowest_road_route(
    adjusted_flooded: np.ndarray,
    baseline_flooded: np.ndarray,
    qualified_source: np.ndarray,
    public_road_corridor: np.ndarray,
    ground_elevation: np.ndarray,
    penalized_uncertainty: np.ndarray | None = None,
    feeder_half_width_cells: int = 1,
) -> tuple[np.ndarray, np.ndarray, dict[str, int | float | str]]:
    """Connect penalty-separated basins by their lowest eligible road route.

    The route starts only where an adjusted-wet qualified source cell overlaps
    or shares a side with an eligible road. A priority flood minimizes the
    maximum ground elevation encountered (the controlling route crest), then
    minimizes path length among equal-crest alternatives. This is a physical
    lowest-route criterion, not an unconstrained geometric shortcut.

    Only public-road pixels inside the explicitly supplied penalty-held
    uncertainty mask may be painted. This prevents the visualization from
    converting a disconnected marsh/beach cell into water. In addition to
    routes toward flooded road pieces, a narrow lowest-crest bridge is traced
    across each held road segment that touches source-connected blue water at
    separated points. This preserves the visible inlet even when the whole
    blue area is already connected through an off-road route. The default
    half-width of one display cell produces a feeder up to three display cells
    wide.
    """
    _require_aligned(
        adjusted_flooded,
        baseline_flooded,
        qualified_source,
        public_road_corridor,
        ground_elevation,
    )
    if feeder_half_width_cells < 0:
        raise ValueError("feeder_half_width_cells cannot be negative")

    adjusted = np.asarray(adjusted_flooded, dtype=bool)
    baseline = np.asarray(baseline_flooded, dtype=bool)
    source = np.asarray(qualified_source, dtype=bool)
    roads = np.asarray(public_road_corridor, dtype=bool)
    ground = np.asarray(ground_elevation, dtype=np.float32)
    paintable = (
        baseline & ~adjusted
        if penalized_uncertainty is None
        else np.asarray(penalized_uncertainty, dtype=bool)
    )
    _require_aligned(adjusted, paintable)
    if np.any(paintable & (~baseline | adjusted)):
        raise ValueError(
            "Penalty-held feeder mask must be inside baseline and outside adjusted water"
        )
    empty = np.zeros(adjusted.shape, dtype=bool)

    labels, component_count = ndimage_label(
        adjusted,
        structure=FOUR_NEIGHBOUR_STRUCTURE,
    )
    if component_count == 0:
        return adjusted, empty, {
            "detachedComponentsJoined": 0,
            "detachedComponentsRoadUnreachable": 0,
            "roadWaterComponentsRouted": 0,
            "sourceConnectedRoadGapsBridged": 0,
            "feederPixels": 0,
            "maximumFeederLengthPixels": 0,
            "maximumFeederRouteCrestFt": 0.0,
            "routeCriterion": "minimum crest, then minimum length",
        }

    source_labels = np.unique(labels[adjusted & source])
    source_labels = source_labels[source_labels > 0]
    detached_labels = np.setdiff1d(
        np.arange(1, component_count + 1, dtype=np.int32),
        source_labels,
        assume_unique=True,
    )
    if detached_labels.size == 0 and not np.any(paintable):
        return adjusted, empty, {
            "detachedComponentsJoined": 0,
            "detachedComponentsRoadUnreachable": 0,
            "roadWaterComponentsRouted": 0,
            "sourceConnectedRoadGapsBridged": 0,
            "feederPixels": 0,
            "maximumFeederLengthPixels": 0,
            "maximumFeederRouteCrestFt": 0.0,
            "routeCriterion": "minimum crest, then minimum length",
        }
    route_domain = baseline & roads & np.isfinite(ground)
    adjusted_source_water = adjusted & source
    route_origin = route_domain & (
        adjusted_source_water
        | binary_dilation(
            adjusted_source_water,
            structure=FOUR_NEIGHBOUR_STRUCTURE,
        )
    )
    height, width = adjusted.shape
    pixel_count = height * width
    flat_route = route_domain.ravel()
    flat_ground = ground.ravel()
    route_crest = np.full(pixel_count, np.inf, dtype=np.float32)
    route_length = np.full(
        pixel_count,
        np.iinfo(np.int32).max,
        dtype=np.int32,
    )
    predecessor = np.full(pixel_count, -1, dtype=np.int32)
    queue: list[tuple[float, int, int]] = []
    for position in np.flatnonzero(route_origin):
        position = int(position)
        crest = float(flat_ground[position])
        route_crest[position] = crest
        route_length[position] = 0
        heapq.heappush(queue, (crest, 0, position))

    while queue:
        crest, length, position = heapq.heappop(queue)
        if (
            crest != float(route_crest[position])
            or length != int(route_length[position])
        ):
            continue
        y, x = divmod(position, width)
        for neighbor in (
            position - width if y > 0 else -1,
            position - 1 if x > 0 else -1,
            position + 1 if x + 1 < width else -1,
            position + width if y + 1 < height else -1,
        ):
            if neighbor < 0 or not flat_route[neighbor]:
                continue
            next_crest = max(crest, float(flat_ground[neighbor]))
            next_length = length + 1
            if (
                next_crest < float(route_crest[neighbor])
                or (
                    next_crest == float(route_crest[neighbor])
                    and next_length < int(route_length[neighbor])
                )
            ):
                route_crest[neighbor] = next_crest
                route_length[neighbor] = next_length
                predecessor[neighbor] = position
                heapq.heappush(
                    queue,
                    (next_crest, next_length, neighbor),
                )

    detached_lookup = np.zeros(component_count + 1, dtype=bool)
    detached_lookup[detached_labels] = True
    target_positions: list[np.ndarray] = []
    target_labels: list[np.ndarray] = []
    position_grid = np.arange(pixel_count, dtype=np.int32).reshape(adjusted.shape)
    for route_view, label_view, position_view in (
        (route_domain, labels, position_grid),
        (route_domain[:-1, :], labels[1:, :], position_grid[:-1, :]),
        (route_domain[1:, :], labels[:-1, :], position_grid[1:, :]),
        (route_domain[:, :-1], labels[:, 1:], position_grid[:, :-1]),
        (route_domain[:, 1:], labels[:, :-1], position_grid[:, 1:]),
    ):
        touches_detached = route_view & detached_lookup[label_view]
        if np.any(touches_detached):
            target_positions.append(position_view[touches_detached])
            target_labels.append(label_view[touches_detached])

    # A whole adjusted-water component can already touch the source through a
    # marsh, yard, or other non-road pixel while the actual street leading from
    # that source remains green. Component-labeling only ``adjusted`` therefore
    # misses the visible feeder people expect to see. Label the blue road pieces
    # independently and route to each one. Existing blue pixels cost nothing to
    # paint because the final feeder is still clipped to ``paintable``; this
    # simply exposes the missing green source-to-street segment.
    road_water_labels, road_water_component_count = ndimage_label(
        adjusted & roads,
        structure=FOUR_NEIGHBOUR_STRUCTURE,
    )
    road_water = road_water_labels > 0
    if np.any(road_water) and np.any(paintable):
        target_positions.append(position_grid[road_water])
        target_labels.append(
            road_water_labels[road_water].astype(np.int64, copy=False)
            + component_count
        )

    paths = np.zeros(adjusted.shape, dtype=bool)
    bridge_paths = np.zeros(adjusted.shape, dtype=bool)
    maximum_length = 0
    maximum_crest = 0.0
    routed_road_components = 0
    bridged_road_gaps = 0
    if target_positions:
        candidates = np.concatenate(target_positions)
        candidate_labels = np.concatenate(target_labels)
        reachable = np.isfinite(route_crest[candidates])
        candidates = candidates[reachable]
        candidate_labels = candidate_labels[reachable]
        if candidates.size:
            ordering = np.lexsort(
                (
                    route_length[candidates],
                    route_crest[candidates],
                    candidate_labels,
                )
            )
            ordered_labels = candidate_labels[ordering]
            first_for_label = np.concatenate(
                (
                    np.asarray([True]),
                    ordered_labels[1:] != ordered_labels[:-1],
                )
            )
            endpoints = candidates[ordering][first_for_label]
            endpoint_labels = candidate_labels[ordering][first_for_label]
            routed_road_components = int(
                np.count_nonzero(endpoint_labels > component_count)
            )
            maximum_length = int(
                np.max(route_length[endpoints], initial=0)
            )
            maximum_crest = float(
                np.max(route_crest[endpoints], initial=0.0)
            )
            flat_paths = paths.ravel()
            for endpoint in endpoints:
                position = int(endpoint)
                while position >= 0 and not flat_paths[position]:
                    flat_paths[position] = True
                    position = int(predecessor[position])

    # The full blue water mask can be one source-connected component through a
    # yard or marsh even while a held street segment visibly separates two blue
    # contacts. For each such green road segment, bridge its farthest blue-touch
    # endpoints using the same minimum-crest, then minimum-length criterion.
    connected_blue = _retain_source_connected(adjusted, source)
    held_road = paintable & roads & np.isfinite(ground)
    held_labels, _ = ndimage_label(
        held_road,
        structure=FOUR_NEIGHBOUR_STRUCTURE,
    )
    blue_touch = held_road & binary_dilation(
        connected_blue,
        structure=FOUR_NEIGHBOUR_STRUCTURE,
    )
    boundary_positions = position_grid[blue_touch]
    boundary_labels = held_labels[blue_touch]
    if boundary_positions.size:
        ordering = np.argsort(boundary_labels, kind="stable")
        boundary_positions = boundary_positions[ordering]
        boundary_labels = boundary_labels[ordering]
        unique_labels, starts = np.unique(boundary_labels, return_index=True)
        stops = np.r_[starts[1:], boundary_labels.size]
        flat_held_labels = held_labels.ravel()
        flat_bridge_paths = bridge_paths.ravel()
        for held_label, start, stop in zip(unique_labels, starts, stops):
            contacts = boundary_positions[start:stop]
            if contacts.size < 2:
                continue
            contact_y, contact_x = np.divmod(contacts, width)
            first_y = int(contact_y[0])
            first_x = int(contact_x[0])
            endpoint_a = int(
                contacts[
                    np.argmax(
                        (contact_y - first_y) ** 2
                        + (contact_x - first_x) ** 2
                    )
                ]
            )
            a_y, a_x = divmod(endpoint_a, width)
            endpoint_b = int(
                contacts[
                    np.argmax(
                        (contact_y - a_y) ** 2 + (contact_x - a_x) ** 2
                    )
                ]
            )
            b_y, b_x = divmod(endpoint_b, width)
            if abs(a_y - b_y) + abs(a_x - b_x) < 2:
                continue

            best_crest = {endpoint_a: float(flat_ground[endpoint_a])}
            best_length = {endpoint_a: 0}
            local_predecessor: dict[int, int] = {endpoint_a: -1}
            local_queue: list[tuple[float, int, int]] = [
                (best_crest[endpoint_a], 0, endpoint_a)
            ]
            while local_queue:
                crest, length, position = heapq.heappop(local_queue)
                if (
                    crest != best_crest.get(position)
                    or length != best_length.get(position)
                ):
                    continue
                if position == endpoint_b:
                    break
                y, x = divmod(position, width)
                for neighbor in (
                    position - width if y > 0 else -1,
                    position - 1 if x > 0 else -1,
                    position + 1 if x + 1 < width else -1,
                    position + width if y + 1 < height else -1,
                ):
                    if neighbor < 0 or flat_held_labels[neighbor] != held_label:
                        continue
                    next_crest = max(crest, float(flat_ground[neighbor]))
                    next_length = length + 1
                    if (
                        next_crest < best_crest.get(neighbor, np.inf)
                        or (
                            next_crest == best_crest.get(neighbor, np.inf)
                            and next_length < best_length.get(neighbor, pixel_count)
                        )
                    ):
                        best_crest[neighbor] = next_crest
                        best_length[neighbor] = next_length
                        local_predecessor[neighbor] = position
                        heapq.heappush(
                            local_queue,
                            (next_crest, next_length, neighbor),
                        )
            if endpoint_b not in local_predecessor:
                continue
            bridged_road_gaps += 1
            maximum_length = max(maximum_length, best_length[endpoint_b])
            maximum_crest = max(maximum_crest, best_crest[endpoint_b])
            position = endpoint_b
            while position >= 0 and not flat_bridge_paths[position]:
                flat_bridge_paths[position] = True
                position = local_predecessor[position]

    widened_paths = paths
    for _ in range(feeder_half_width_cells):
        widened_paths = binary_dilation(
            widened_paths,
            structure=FOUR_NEIGHBOUR_STRUCTURE,
        )
    widened_bridge_paths = bridge_paths
    for _ in range(feeder_half_width_cells):
        widened_bridge_paths = binary_dilation(
            widened_bridge_paths,
            structure=FOUR_NEIGHBOUR_STRUCTURE,
        )
    road_feeder = widened_paths & roads & paintable
    bridge_feeder = widened_bridge_paths & roads & paintable
    feeder = road_feeder | bridge_feeder
    if np.any(feeder & ~roads):
        raise RuntimeError("A lowest-route feeder escaped the public-road corridor")

    flooded = _retain_source_connected(adjusted | feeder, source)
    feeder &= flooded
    joined_labels = np.unique(labels[flooded & adjusted])
    joined_labels = joined_labels[joined_labels > 0]
    joined_detached = np.intersect1d(
        joined_labels,
        detached_labels,
        assume_unique=False,
    )
    return flooded, feeder, {
        "detachedComponentsJoined": int(joined_detached.size),
        "detachedComponentsRoadUnreachable": int(
            detached_labels.size - joined_detached.size
        ),
        "roadWaterComponentsRouted": routed_road_components,
        "sourceConnectedRoadGapsBridged": bridged_road_gaps,
        "feederPixels": int(np.count_nonzero(feeder)),
        "maximumFeederLengthPixels": maximum_length,
        "maximumFeederRouteCrestFt": maximum_crest,
        "routeCriterion": "minimum crest, then minimum length",
    }
