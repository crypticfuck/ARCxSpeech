"""
Recording Quality percentage scale.

Star ratings have been removed app-wide. "Recording Quality Rating" is
now an integer percentage (0-100) derived from the analyzer's raw
composite score, which itself is built from the ambient/patient
channel metrics (cross-channel SNR, noise floor, low-SNR frames,
clipping, silence -- see app/recording_quality.py).

Two helpers live here so every consumer (classifier, motor-state
confidence, baseline / trajectory quality gates, change detector,
clinical history) shares ONE definition:

    score_to_quality_percent(raw_score)  raw 0-100 -> percentage 0-100
    quality_percent(rating)              any stored rating -> percentage
                                         (int/float passthrough, legacy
                                         "★★★★☆" strings converted, None
                                         -> DEFAULT_QUALITY_PCT)
"""

from typing import Any

from app.quality_thresholds import (
    RAW_SCORE_EXCELLENT,
    RAW_SCORE_GOOD,
    RAW_SCORE_MODERATE,
    RAW_SCORE_POOR,
    QUALITY_EXCELLENT_PCT,
    QUALITY_GOOD_PCT,
    QUALITY_MODERATE_PCT,
    QUALITY_POOR_PCT,
    DEFAULT_QUALITY_PCT,
)

# (raw_score, percentage) anchor points -- piecewise linear in between.
_ANCHORS = [
    (0, 0),
    (RAW_SCORE_POOR, QUALITY_POOR_PCT),
    (RAW_SCORE_MODERATE, QUALITY_MODERATE_PCT),
    (RAW_SCORE_GOOD, QUALITY_GOOD_PCT),
    (RAW_SCORE_EXCELLENT, QUALITY_EXCELLENT_PCT),
    (100, 100),
]

# Legacy star-string support for recordings.json rows written before
# the percentage scale existed. Filled-star count -> percentage.
_LEGACY_STARS_TO_PCT = {
    5: QUALITY_EXCELLENT_PCT,
    4: QUALITY_GOOD_PCT,
    3: QUALITY_MODERATE_PCT,
    2: QUALITY_POOR_PCT,
    1: QUALITY_POOR_PCT - 10,
}


def score_to_quality_percent(score: Any) -> int:
    """Maps the raw 0-100 composite score onto the operator-facing
    percentage. Returns an int, clamped to 0-100."""
    try:
        s = float(score)
    except (TypeError, ValueError):
        return DEFAULT_QUALITY_PCT

    s = max(0.0, min(100.0, s))

    for (x0, y0), (x1, y1) in zip(_ANCHORS, _ANCHORS[1:]):
        if s <= x1:
            if x1 == x0:
                return int(round(y1))
            return int(round(y0 + (s - x0) * (y1 - y0) / (x1 - x0)))

    return 100


def quality_percent(rating: Any) -> int:
    """Normalises whatever is stored under "Recording Quality Rating"
    to an integer percentage. Accepts a number (new format), a legacy
    star string, or None/garbage (-> DEFAULT_QUALITY_PCT)."""
    if isinstance(rating, bool):
        return DEFAULT_QUALITY_PCT

    if isinstance(rating, (int, float)):
        return int(round(max(0.0, min(100.0, float(rating)))))

    if isinstance(rating, str):
        filled = rating.count("★")
        if filled:
            return _LEGACY_STARS_TO_PCT.get(filled, DEFAULT_QUALITY_PCT)
        try:
            return quality_percent(float(rating.strip().rstrip("%")))
        except ValueError:
            return DEFAULT_QUALITY_PCT

    return DEFAULT_QUALITY_PCT
