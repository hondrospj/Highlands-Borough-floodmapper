"""Screening exceedance statistics for Highlands; reused CDF method from the reference mapper."""
import numpy as np
import math,bisect
from collections import defaultdict
from datetime import datetime,timezone
CURRENT_YEAR=2026
YEARS=list(range(2026,2101))
ELEVATION_GRID_FT=np.round(np.arange(-2,40.01,.1),1)
MINIMUM_FLOOD_DEPTH_FT=.1
EXPECTED_HIGH_TIDES_PER_YEAR=705.
KDE_GRID_STEP_FT=.002
KDE_KERNEL_TRUNCATION_SD=6.
KDE_BOOTSTRAP_REPLICATES=400
KDE_BOOTSTRAP_SEED=20261016
NOAA_SCENARIO_NAMES={'low':'Low','intermediateLow':'Intermediate-Low','intermediate':'Intermediate','intermediateHigh':'Intermediate-High','high':'High'}
SCENARIO_LABELS={'observedTrend':'Observed trend','low':'Low','intermediateLow':'Intermediate Low','intermediate':'Intermediate','intermediateHigh':'Intermediate High','high':'High'}

def fit_local_gauge_trend(times: list[int], levels: list[float]) -> tuple[float, dict]:
    """Fit the existing local trend to equally weighted monthly means."""
    daily: dict[str, list[float]] = defaultdict(list)
    for stamp, level in zip(times, levels):
        day = datetime.fromtimestamp(stamp, timezone.utc).strftime("%Y-%m-%d")
        daily[day].append(float(level))

    monthly: dict[str, list[float]] = defaultdict(list)
    for day, values in daily.items():
        if values:
            monthly[day[:7]].append(float(np.mean(values)))

    xs: list[float] = []
    ys: list[float] = []
    for month, values in sorted(monthly.items()):
        if not values:
            continue
        year, month_number = map(int, month.split("-"))
        xs.append(year + (month_number - 0.5) / 12.0)
        ys.append(float(np.mean(values)))
    if len(xs) < 24:
        raise RuntimeError("At least 24 local-gauge monthly means are required to fit the observed trend")

    slope, intercept = np.polyfit(np.asarray(xs), np.asarray(ys), 1)
    fitted = np.asarray(xs) * slope + intercept
    residual = np.asarray(ys) - fitted
    return float(slope), {
        "method": "ordinary least squares on equal-weight monthly means of the existing Sea Bright hourly-max archive",
        "monthlyMeanCount": len(xs),
        "firstMonth": min(monthly),
        "lastMonth": max(monthly),
        "slopeFtPerYear": round(float(slope), 8),
        "interceptFt": round(float(intercept), 6),
        "residualStandardErrorFt": round(float(np.std(residual, ddof=2)), 4),
    }

def fit_quadratic_slr_deltas(noaa_payload: dict, annual_trend_ft: float) -> tuple[dict[str, list[float]], dict]:
    rows = noaa_payload.get("SlrProjections", [])
    deltas: dict[str, list[float]] = {
        "observedTrend": [round(annual_trend_ft * (year - CURRENT_YEAR), 4) for year in YEARS]
    }
    curve_metadata: dict[str, dict] = {
        "observedTrend": {
            "label": SCENARIO_LABELS["observedTrend"],
            "type": "linear",
            "baseYear": CURRENT_YEAR,
            "coefficientsForXYearMinus2026": {"a": 0.0, "b": round(annual_trend_ft, 10), "c": 0.0},
        }
    }

    for key, noaa_name in NOAA_SCENARIO_NAMES.items():
        selected = [
            row
            for row in rows
            if row.get("scenario") == noaa_name
            and CURRENT_YEAR - 6 <= int(row.get("projectionYear", 0)) <= 2100
        ]
        if len(selected) < 3:
            raise RuntimeError(f"NOAA 2022 payload did not contain enough {noaa_name} projection points")
        projection_years = np.asarray([float(row["projectionYear"]) - CURRENT_YEAR for row in selected], dtype=float)
        projection_feet = np.asarray([float(row["projectionRsl"]) / 30.48 for row in selected], dtype=float)
        a, b, c = np.polyfit(projection_years, projection_feet, 2)
        base_value = c
        deltas[key] = [
            round(max(0.0, float(a * (year - CURRENT_YEAR) ** 2 + b * (year - CURRENT_YEAR) + c - base_value)), 4)
            for year in YEARS
        ]
        curve_metadata[key] = {
            "label": SCENARIO_LABELS[key],
            "type": "quadratic",
            "baseYear": CURRENT_YEAR,
            "sourceScenario": noaa_name,
            "fitProjectionYears": [int(min(row["projectionYear"] for row in selected)), int(max(row["projectionYear"] for row in selected))],
            "coefficientsForXYearMinus2026": {
                "a": round(float(a), 12),
                "b": round(float(b), 10),
                "c": 0.0,
            },
        }
    return deltas, curve_metadata

def gaussian_kde_bandwidth(samples: np.ndarray) -> float:
    """Silverman's normal-reference bandwidth for a one-dimensional Gaussian KDE."""
    if samples.size < 2:
        return 0.05
    standard_deviation = float(np.std(samples, ddof=1))
    if not math.isfinite(standard_deviation) or standard_deviation <= 0.0:
        return 0.05
    return max(0.02, 1.06 * standard_deviation * samples.size ** (-0.2))

def historic_flood_count(sorted_peaks: list[float], elevation_ft: float) -> int:
    """Count peaks producing strictly more than 0.1 ft above parcel elevation."""
    threshold = float(elevation_ft) + MINIMUM_FLOOD_DEPTH_FT
    return len(sorted_peaks) - bisect.bisect_right(sorted_peaks, threshold)

def _smoothed_cdf_from_histogram(
    histogram: np.ndarray,
    kernel_fft: np.ndarray,
    fft_size: int,
    kernel_center: int,
) -> np.ndarray:
    smoothed = np.fft.irfft(np.fft.rfft(histogram, fft_size) * kernel_fft, fft_size)
    smoothed = np.maximum(smoothed[kernel_center : kernel_center + histogram.size], 0.0)
    cumulative = np.cumsum(smoothed)
    total = float(cumulative[-1]) if cumulative.size else 0.0
    if total <= 0.0:
        return np.zeros(histogram.size, dtype=np.float64)
    return cumulative / total

def fit_continuous_exceedance_cdf(
    rebased_peaks: list[float],
    events: list[dict],
    evaluation_thresholds: list[np.ndarray],
) -> tuple[list[np.ndarray], list[np.ndarray], list[np.ndarray], dict]:
    """Fit a continuous Gaussian-kernel CDF and bootstrap its 95% interval by year."""
    samples = np.asarray(rebased_peaks, dtype=np.float64)
    if samples.size < 2:
        raise RuntimeError("At least two rebased high-tide peaks are required to fit the CDF")
    bandwidth = gaussian_kde_bandwidth(samples)
    threshold_min = min(float(np.min(values)) for values in evaluation_thresholds)
    threshold_max = max(float(np.max(values)) for values in evaluation_thresholds)
    margin = KDE_KERNEL_TRUNCATION_SD * bandwidth
    grid_min = math.floor((min(float(np.min(samples)), threshold_min) - margin) / KDE_GRID_STEP_FT) * KDE_GRID_STEP_FT
    grid_max = math.ceil((max(float(np.max(samples)), threshold_max) + margin) / KDE_GRID_STEP_FT) * KDE_GRID_STEP_FT
    grid = np.arange(grid_min, grid_max + KDE_GRID_STEP_FT * 0.5, KDE_GRID_STEP_FT, dtype=np.float64)
    edges = np.concatenate(
        (
            np.asarray([grid[0] - KDE_GRID_STEP_FT / 2.0]),
            grid + KDE_GRID_STEP_FT / 2.0,
        )
    )

    kernel_radius = int(math.ceil(KDE_KERNEL_TRUNCATION_SD * bandwidth / KDE_GRID_STEP_FT))
    kernel_offsets = np.arange(-kernel_radius, kernel_radius + 1, dtype=np.float64) * KDE_GRID_STEP_FT
    kernel = np.exp(-0.5 * (kernel_offsets / bandwidth) ** 2)
    kernel /= np.sum(kernel)
    fft_size = 1 << (grid.size + kernel.size - 2).bit_length()
    kernel_fft = np.fft.rfft(kernel, fft_size)
    kernel_center = (kernel.size - 1) // 2

    central_histogram = np.histogram(samples, bins=edges)[0].astype(np.float64)
    central_cdf = _smoothed_cdf_from_histogram(
        central_histogram, kernel_fft, fft_size, kernel_center
    )

    peak_blocks: dict[int, list[float]] = defaultdict(list)
    for event in events:
        rebased = event.get("rebasedNavd88Ft")
        if rebased is not None and math.isfinite(float(rebased)):
            peak_blocks[int(event["year"])].append(float(rebased))
    block_histograms = np.asarray(
        [np.histogram(values, bins=edges)[0] for _, values in sorted(peak_blocks.items())],
        dtype=np.float64,
    )
    if block_histograms.shape[0] < 2:
        raise RuntimeError("At least two calendar-year blocks are required for CDF uncertainty")

    rng = np.random.default_rng(KDE_BOOTSTRAP_SEED)
    block_weights = rng.multinomial(
        block_histograms.shape[0],
        np.full(block_histograms.shape[0], 1.0 / block_histograms.shape[0]),
        size=KDE_BOOTSTRAP_REPLICATES,
    )
    bootstrap_cdfs = np.empty((KDE_BOOTSTRAP_REPLICATES, grid.size), dtype=np.float32)
    for index, weights in enumerate(block_weights):
        bootstrap_histogram = weights @ block_histograms
        bootstrap_cdfs[index] = _smoothed_cdf_from_histogram(
            bootstrap_histogram, kernel_fft, fft_size, kernel_center
        )

    estimates: list[np.ndarray] = []
    lower95: list[np.ndarray] = []
    upper95: list[np.ndarray] = []
    for thresholds in evaluation_thresholds:
        flat_thresholds = thresholds.ravel()
        central_survival = 1.0 - np.interp(
            flat_thresholds, grid, central_cdf, left=0.0, right=1.0
        )
        bootstrap_survival = np.empty(
            (KDE_BOOTSTRAP_REPLICATES, flat_thresholds.size), dtype=np.float32
        )
        for index, bootstrap_cdf in enumerate(bootstrap_cdfs):
            bootstrap_survival[index] = 1.0 - np.interp(
                flat_thresholds, grid, bootstrap_cdf, left=0.0, right=1.0
            )
        interval = np.percentile(bootstrap_survival, [2.5, 97.5], axis=0)
        shape = thresholds.shape
        estimates.append(central_survival.reshape(shape))
        lower95.append(interval[0].reshape(shape))
        upper95.append(interval[1].reshape(shape))

    return estimates, lower95, upper95, {
        "type": "continuous Gaussian-kernel CDF",
        "bandwidthMethod": "Silverman normal-reference rule",
        "bandwidthFt": round(bandwidth, 6),
        "evaluationGridStepFt": KDE_GRID_STEP_FT,
        "kernelTruncationStandardDeviations": KDE_KERNEL_TRUNCATION_SD,
        "uncertaintyMethod": "calendar-year block bootstrap percentile interval",
        "bootstrapReplicates": KDE_BOOTSTRAP_REPLICATES,
        "bootstrapSeed": KDE_BOOTSTRAP_SEED,
        "bootstrapBlockCount": int(block_histograms.shape[0]),
    }

def build_cdf_payload(
    observed_payload: dict,
    events: list[dict],
    rebased_peaks: list[float],
    annual_trend_ft: float,
    slr_payload: dict,
    trend_metadata: dict,
) -> dict:
    years_with_data = sorted({row["year"] for row in events})
    if len(events) >= 2:
        first_event = datetime.fromisoformat(events[0]["timeUtc"].replace("Z", "+00:00"))
        last_event = datetime.fromisoformat(events[-1]["timeUtc"].replace("Z", "+00:00"))
        observed_duration_years = max(1.0, (last_event - first_event).total_seconds() / (365.2425 * 86400))
    else:
        observed_duration_years = 1.0
    detected_tides_per_year = len(events) / observed_duration_years
    tides_per_year = EXPECTED_HIGH_TIDES_PER_YEAR
    slr_deltas, curve_metadata = fit_quadratic_slr_deltas(slr_payload, annual_trend_ft)
    evaluation_thresholds = [
        ELEVATION_GRID_FT[:, np.newaxis]
        + MINIMUM_FLOOD_DEPTH_FT
        - np.asarray(deltas, dtype=np.float64)[np.newaxis, :]
        for deltas in slr_deltas.values()
    ]
    estimates, lowers, uppers, cdf_fit_metadata = fit_continuous_exceedance_cdf(
        rebased_peaks, events, evaluation_thresholds
    )
    annual_counts: dict[str, dict[str, list[list[float]]]] = {}
    for index, scenario in enumerate(slr_deltas):
        estimate_rows = np.clip(estimates[index] * tides_per_year, 0.0, tides_per_year)
        lower_rows = np.clip(lowers[index] * tides_per_year, 0.0, tides_per_year)
        upper_rows = np.clip(uppers[index] * tides_per_year, 0.0, tides_per_year)
        annual_counts[scenario] = {
            "estimate": np.round(estimate_rows, 2).tolist(),
            "lower95": np.round(lower_rows, 2).tolist(),
            "upper95": np.round(upper_rows, 2).tolist(),
        }

    historic_peak_levels = sorted(float(row["navd88Ft"]) for row in events)
    historical_counts = [
        historic_flood_count(historic_peak_levels, float(elevation))
        for elevation in ELEVATION_GRID_FT
    ]
    return {
        "schema": "highlands-flood-history-projections-v4",
        "generatedUtc": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "currentYear": CURRENT_YEAR,
        "site": {
            "name": "Sea Bright USGS 01407600",
                        "usgsId": "01407600",
            "noaaScenarioStationId": "8531680",
            "noaaScenarioStationName": "Sandy Hook",
        },
        "sources": {
            "observed": "Existing Sea Bright USGS 01407600 hourly-max archive",
            "seaLevelScenarios": "NOAA CO-OPS 2022 Interagency Sea Level Report station projections",
            "scenarioReportYear": 2022,
            "localObservedTrend": "Equal-weight monthly means of the existing hourly-max archive",
        },
        "observedArchive": {"startDate": observed_payload.get("archiveStartDate"), "endDate": observed_payload.get("archiveEndDate")},
        "method": {
            "historic": "independent city-primary composite high-tide peaks separated by at least six hours; a parcel floods only when depth is strictly greater than 0.1 foot above the parcel's highest intersecting original five-foot DEM cell",
            "baselineRebase": f"each observed local-gauge peak adjusted to 1 January {CURRENT_YEAR} using the fitted local observed trend",
            "seaLevelCurves": f"quadratic least-squares fits to each NOAA 2022 median scenario, evaluated annually and rebased to zero in {CURRENT_YEAR}; the observed local trend remains linear",
            "cdf": "continuous Gaussian-kernel CDF fitted to present-year-rebased independent high-tide peaks",
            "uncertainty": "two-sided 95 percent calendar-year block-bootstrap percentile interval for the fitted exceedance probability at every elevation, year, and curve",
            "future": "continuous fitted CDF probability of water level being strictly greater than parcel elevation plus 0.1 foot, with its 95 percent bounds multiplied by 705 expected astronomical high tides per year",
        },
        "floodDefinition": {
            "comparison": "strictlyGreaterThan",
            "minimumDepthFt": MINIMUM_FLOOD_DEPTH_FT,
            "elevationRule": "highest original five-foot DEM cell whose center intersects the parcel",
        },
        "cdfFit": cdf_fit_metadata,
        "annualRelativeSeaLevelTrendFt": round(annual_trend_ft, 6),
        "observedTrendFit": trend_metadata,
        "highTidePeakCount": len(events),
        "calendarYearCount": len(years_with_data),
        "observedDurationYears": round(observed_duration_years, 3),
        "detectedIndependentTidesPerObservedYear": round(detected_tides_per_year, 3),
        "independentTidesPerYear": tides_per_year,
        "elevationGridFtNavd88": ELEVATION_GRID_FT.tolist(),
        "years": YEARS,
        "scenarioSlrDeltaFtFrom2026": slr_deltas,
        "scenarioCurves": curve_metadata,
        "scenarioOrder": list(slr_deltas),
        "historicFloodEventCountByElevation": historical_counts,
        "annualFloodEventCount": annual_counts,
    }
