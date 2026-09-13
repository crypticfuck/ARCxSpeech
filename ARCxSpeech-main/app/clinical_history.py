"""
Clinical History Adapter

The clinical inference engine (speech_motor_state.py, change_detector.py,
trajectory_mapper.py, baseline.py) was originally written against
assessment_store.py's flat, patient_id-keyed blob: a list of
"assessment" dicts, each carrying patient_id, timestamp, vowel_mean/
ddk_mean, recording_quality_mean/recording_quality_classification, and
(once scored) a speech_motor_state block.

The app's data model has since moved to subject_store.py +
recording_store.py, with per-date-group summaries computed live on
read (recording_store.compute_date_summary) instead of being written
once and going stale. Sessions have been removed from the data model;
one calendar-day date group (see project_paths.date_key) is now the
"one point in time" unit this adapter builds off of, replacing what
used to be one session per point. This is a minimal swap to keep this
adapter and its three callers working -- the engine modules below
(and whether a date group is really the right unit) haven't been
revisited yet.

This module is the ONLY bridge between the two: it builds
assessment-shaped records on the fly from the new stores so the engine
modules above can be ported over unmodified. Nothing in this file
changes the engine's own logic or thresholds.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from app import subject_store, recording_store
from app.speech_motor_state import compute_speech_motor_state
from app.quality_thresholds import (
    SCORE_5_STAR,
    SCORE_4_STAR,
    SCORE_3_STAR,
    SCORE_2_STAR,
)

VALID_SEX_CATEGORIES = {"Male", "Female"}


def _score_to_star_rating(score: Optional[float]) -> str:
    """Maps a numeric Recording Quality Score (0-100) to the star-rating
    string baseline.py's and trajectory_mapper.py's quality gates key
    off of. Session-level scores are already an average across that
    session's recordings (recording_store._compute_mean on each
    recording's quality_metrics), so this reclassifies the *averaged*
    score using the same cut points recording_quality.py's
    classify_recording_quality() uses per-recording, rather than
    duplicating star-rating logic in a second place."""
    if not isinstance(score, (int, float)):
        return "★★★☆☆"
    if score >= SCORE_5_STAR:
        return "★★★★★"
    if score >= SCORE_4_STAR:
        return "★★★★☆"
    if score >= SCORE_3_STAR:
        return "★★★☆☆"
    if score >= SCORE_2_STAR:
        return "★★☆☆☆"
    return "★☆☆☆☆"


def build_assessment_record(project_id: str, subject_id: str, date: str, sex: str) -> Dict[str, Any]:
    """Builds one assessment-shaped record for a single date group: the
    input shape change_detector.py, trajectory_mapper.py, and
    baseline.py all read (patient_id, timestamp, vowel_mean/ddk_mean,
    recording_quality_mean/recording_quality_classification,
    speech_motor_state).

    Raises ValueError if `sex` isn't exactly "Male" or "Female" --
    compute_speech_motor_state has no fallback for that, by design
    (see speech_motor_state.py), and this adapter doesn't invent one
    either since guessing sex would silently bias the formant/pitch
    normalization. Callers should skip subjects without a recorded sex
    rather than pass a guess.
    """
    summary = recording_store.compute_date_summary(project_id, subject_id, date)

    rq_mean = summary.get("recording_quality_mean") or {}
    rating = _score_to_star_rating(summary.get("recording_quality_score_mean"))

    # The engine reads BOTH "Clipping Detected" (a metrics-mean key) and
    # "Recording Quality Rating" (a classification key) off this one
    # dict, so hand it the union.
    rq_for_engine = {**rq_mean, "Recording Quality Rating": rating}

    motor_state = compute_speech_motor_state(
        sex=sex,
        vowel_mean=summary.get("vowel_mean"),
        ddk_mean=summary.get("ddk_mean"),
        vowel_sd=summary.get("vowel_sd"),
        ddk_sd=summary.get("ddk_sd"),
        rq_classification=rq_for_engine,
    )

    return {
        "patient_id": subject_id,
        "date": date,
        "timestamp": date,
        "vowel_mean": summary.get("vowel_mean", {}),
        "vowel_sd": summary.get("vowel_sd", {}),
        "ddk_mean": summary.get("ddk_mean", {}),
        "ddk_sd": summary.get("ddk_sd", {}),
        "recording_quality_mean": rq_mean,
        "recording_quality_sd": summary.get("recording_quality_sd", {}),
        "recording_quality_classification": {
            "Recording Quality Rating": rating,
        },
        "speech_motor_state": motor_state,
    }


def build_trial_scores(project_id: str, subject_id: str, date: str, task: str, sex: str) -> List[Dict[str, Any]]:
    """Per-trial motor-state scores for one task within a date group, in
    capture order -- the input shape motor_fatigue_curve.analyze_fatigue_curve
    expects (trial_id, score, phase).

    Unlike build_assessment_record (which scores a date group's mean/SD
    across all its recordings), this scores each individual recording on
    its own, since fatigue analysis is specifically about the
    trial-to-trial trajectory within a date group, not the date group's
    average.

    Simplification: there's currently no "rest period" concept anywhere
    in the data model (no field marks a recording as coming after a
    deliberate break), so every trial is labeled phase="continuous".
    Recovery/post-rest analysis in analyze_fatigue_curve will simply
    never trigger until that's added to the capture flow -- this isn't
    a bug, just an honest reflection of what the current protocol
    actually captures.

    A trial is only included if compute_speech_motor_state was able to
    derive a composite_index from its raw features (e.g. a DDK-task
    recording scores Timing/Coordination; a Vowel-task recording scores
    Stability/Phonatory Control). Trials that score no domains at all
    are skipped rather than assigned a fabricated number.
    """
    recordings = recording_store.get_recordings_for_subject_date_task(project_id, subject_id, date, task)
    recordings.sort(key=lambda r: r.get("created_at") or "")

    trials = []
    for idx, recording in enumerate(recordings, start=1):
        features = recording.get("features") or {}
        is_ddk = "DDK Repetition Rate" in features or "DDK Regularity" in features

        motor_state = compute_speech_motor_state(
            sex=sex,
            vowel_mean=None if is_ddk else features,
            ddk_mean=features if is_ddk else None,
            vowel_sd={},
            ddk_sd={},
            rq_classification={
                **(recording.get("quality_metrics") or {}),
                **(recording.get("quality_classification") or {}),
            },
        )

        score = motor_state.get("composite_index")
        if score is None:
            continue

        trials.append({
            "trial_id": idx,
            "score": score,
            "phase": "continuous",
        })

    return trials


def get_patient_assessment_history(project_id: str, subject_id: str) -> List[Dict[str, Any]]:
    """Chronological, assessment-shaped history for one subject, built
    live from recording_store, grouped by calendar date (see
    project_paths.date_key) -- one date group is now the "point in
    time" unit, replacing the old one-session-per-point grouping.
    Drop-in replacement for the old assessment_store.load_assessments()
    -backed history lookup -- used by baseline.py
    (get_valid_patient_history), and available for
    change_detector.analyze_patient_trajectory /
    trajectory_mapper.generate_time_bounded_trajectory, both of which
    just want a list of these records.

    Returns an empty list (rather than guessing) if the subject has no
    sex on file, since compute_speech_motor_state requires an exact
    "Male"/"Female" value and this adapter won't invent one.
    """
    subject = subject_store.get_subject(project_id, subject_id)
    sex = (subject or {}).get("sex")
    if sex not in VALID_SEX_CATEGORIES:
        return []

    recordings = recording_store.get_recordings_for_subject(project_id, subject_id)
    dates = sorted({r["date"] for r in recordings if r.get("date")})

    records = []
    for date in dates:
        summary = recording_store.compute_date_summary(project_id, subject_id, date)
        if not summary.get("vowel_mean") and not summary.get("ddk_mean"):
            # No extracted-feature recordings yet on this date (e.g.
            # only raw captures pending "Extract Features") -- nothing
            # for the engine to score, so skip rather than emit an
            # all-null assessment.
            continue
        records.append(build_assessment_record(project_id, subject_id, date, sex))

    return records