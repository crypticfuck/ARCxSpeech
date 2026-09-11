import json
import os
import tempfile
import uuid
from datetime import datetime
from typing import List

from app.project_paths import project_file
from app.store_lock import locked


def _recordings_file(project_id):
    return project_file(project_id, "recordings.json")


def _atomic_write_json(filepath, data):
    """Same atomic-write pattern as the other stores -- see
    subject_store.py's copy for the full explanation. allow_nan=False
    makes a NaN/Inf fail loudly here instead of silently poisoning
    the file for every later read."""
    directory = os.path.dirname(filepath) or "."
    fd, tmp_path = tempfile.mkstemp(dir=directory, prefix=".tmp_", suffix=".json")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2, allow_nan=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, filepath)
    except Exception:
        try:
            os.remove(tmp_path)
        except OSError:
            pass
        raise


def _old_atomic_write_json(filepath, data):
    """(superseded)

    subject_store.py's copy for the full explanation."""

    directory = os.path.dirname(filepath) or "."

    fd, tmp_path = tempfile.mkstemp(
        dir=directory,
        prefix=".tmp_",
        suffix=".json"
    )

    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2)
            f.flush()
            os.fsync(f.fileno())

        os.replace(tmp_path, filepath)

    except Exception:
        try:
            os.remove(tmp_path)
        except OSError:
            pass
        raise


def load_recordings(project_id):
    recordings_file = _recordings_file(project_id)

    if not os.path.exists(recordings_file):
        _atomic_write_json(recordings_file, [])

    try:
        with open(recordings_file, "r") as f:
            return json.load(f)

    except json.JSONDecodeError as e:
        raise RuntimeError(
            f"Recording data file at {recordings_file} is corrupted and "
            f"could not be read ({e}). No data was modified. Restore "
            "from a backup before continuing, since this file holds "
            "every recording in this project."
        ) from e


def get_recordings_for_session(project_id, session_id):
    recordings = load_recordings(project_id)
    return [r for r in recordings if r.get("session_id") == session_id]


def get_recordings_for_session_task(project_id, session_id, task):
    return [
        r for r in get_recordings_for_session(project_id, session_id)
        if r.get("task") == task
    ]


def get_recording(project_id, recording_id):
    recordings = load_recordings(project_id)
    return next(
        (r for r in recordings if r.get("recording_id") == recording_id),
        None
    )

@locked
def add_recording(
    project_id,
    session_id,
    task,
    source,
    patient_filepath,
    features,
    ambient_filepath=None,
    ambient_metrics=None,
    quality_metrics=None,
    quality_classification=None,
):
    """Appends ONE recording row to this project's recordings.json.
    Callable any number of times, at any point after the session
    exists. `source` is "live" or "uploaded". `patient_filepath`/
    `ambient_filepath` are stored relative to this project's own
    folder (see project_paths.project_dir), not APP_ROOT."""

    recordings = load_recordings(project_id)

    recording = {
        "recording_id": str(uuid.uuid4()),
        "session_id": session_id,
        "task": task,
        "source": source or "live",
        "created_at": datetime.now().isoformat(),
        "patient_filepath": patient_filepath,
        "ambient_filepath": ambient_filepath,
        "features": features or {},
        "ambient_metrics": ambient_metrics,
        "quality_metrics": quality_metrics,
        "quality_classification": quality_classification,
    }

    recordings.append(recording)
    _atomic_write_json(_recordings_file(project_id), recordings)

    return recording

@locked
def update_recording_features(project_id, recording_id, features):
    """Patches just the `features` dict on an existing recording row --
    used by the deferred extraction flow. Returns the updated row, or
    None if recording_id didn't exist."""

    recordings = load_recordings(project_id)
    target = None
    for r in recordings:
        if r.get("recording_id") == recording_id:
            r["features"] = features
            target = r
            break

    if target is None:
        return None

    _atomic_write_json(_recordings_file(project_id), recordings)
    return target

@locked
def delete_recording(project_id, recording_id):
    """Removes the recording row only. Returns the deleted row (so the
    caller -- api/routes.py -- can decide whether its file should be
    removed from disk), or None if recording_id didn't exist."""

    recordings = load_recordings(project_id)
    target = next(
        (r for r in recordings if r.get("recording_id") == recording_id),
        None
    )

    if target is None:
        return None

    remaining = [r for r in recordings if r.get("recording_id") != recording_id]
    _atomic_write_json(_recordings_file(project_id), remaining)

    return target

@locked
def delete_recordings_for_session(project_id, session_id):
    """Removes every recording row belonging to a session (used when a
    whole session is deleted). Returns the list of deleted rows so the
    caller can clean up their files on disk."""

    recordings = load_recordings(project_id)
    to_delete = [r for r in recordings if r.get("session_id") == session_id]

    if not to_delete:
        return []

    remaining = [r for r in recordings if r.get("session_id") != session_id]
    _atomic_write_json(_recordings_file(project_id), remaining)

    return to_delete


def _is_number(v) -> bool:
    # bool is a subclass of int -- keep flags like "F0 Near Search
    # Ceiling" out of the numeric rollups.
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _numeric_values(feature_dicts: List[dict]) -> dict:
    """key -> list of numeric values across ALL dicts (union of keys,
    None / bool / missing skipped), so a pending or other-task first
    row can't blank out the whole summary."""
    values = {}
    for d in feature_dicts:
        for key, v in d.items():
            if _is_number(v):
                values.setdefault(key, []).append(v)
    return values


def _compute_mean(feature_dicts: List[dict]) -> dict:
    result = {}
    for key, values in _numeric_values(feature_dicts).items():
        result[key] = round(sum(values) / len(values), 3)
    return result


def _compute_sd(feature_dicts: List[dict]) -> dict:
    result = {}
    for key, values in _numeric_values(feature_dicts).items():
        if len(values) > 1:
            mean = sum(values) / len(values)
            variance = sum((v - mean) ** 2 for v in values) / len(values)
            result[key] = round(variance ** 0.5, 3)
    return result


def compute_session_summary(project_id, session_id):
    """Builds an Assessment-shaped summary for a session ON READ, from
    whatever recordings currently belong to it in THIS project. Add a
    recording tomorrow and the next call to this function reflects it
    automatically."""

    vowel_recs = get_recordings_for_session_task(project_id, session_id, "Sustained Vowel")
    ddk_recs = get_recordings_for_session_task(project_id, session_id, "DDK")

    def _tag_trial(r):
        return {**r["features"], "_created_at": r.get("created_at"), "_recording_id": r.get("recording_id"), "_session_id": r.get("session_id")}

    vowel_trials = [_tag_trial(r) for r in vowel_recs]
    ddk_trials = [_tag_trial(r) for r in ddk_recs]

    ambient_metrics_all = [
        r["ambient_metrics"] for r in (vowel_recs + ddk_recs)
        if r.get("ambient_metrics")
    ]
    quality_metrics_all = [
        r["quality_metrics"] for r in (vowel_recs + ddk_recs)
        if r.get("quality_metrics")
    ]
    quality_scores = [
        r["quality_classification"]["Recording Quality Score"]
        for r in (vowel_recs + ddk_recs)
        if isinstance((r.get("quality_classification") or {}).get("Recording Quality Score"), (int, float))
    ]
    quality_score_mean = round(sum(quality_scores) / len(quality_scores), 3) if quality_scores else None

    return {
        "session_id": session_id,
        "vowel_trials": vowel_trials,
        "vowel_mean": _compute_mean(vowel_trials),
        "vowel_sd": _compute_sd(vowel_trials),
        "vowel_recordings": [r["patient_filepath"] for r in vowel_recs],
        "ddk_trials": ddk_trials,
        "ddk_mean": _compute_mean(ddk_trials),
        "ddk_sd": _compute_sd(ddk_trials),
        "ddk_recordings": [r["patient_filepath"] for r in ddk_recs],
        "ambient_mean": _compute_mean(ambient_metrics_all),
        "ambient_sd": _compute_sd(ambient_metrics_all),
        "recording_quality_mean": _compute_mean(quality_metrics_all),
        "recording_quality_sd": _compute_sd(quality_metrics_all),
        "recording_quality_score_mean": quality_score_mean,
    }
    


def compute_subject_summary(project_id, subject_id, session_ids):
    """Same Assessment-shaped summary as compute_session_summary, but
    aggregated across every recording in every one of the subject's
    sessions (session_ids) within this project."""

    vowel_trials = []
    ddk_trials = []

    def _tag_trial(r):
        return {**r["features"], "_created_at": r.get("created_at"), "_recording_id": r.get("recording_id"), "_session_id": r.get("session_id")}

    for session_id in session_ids:
        vowel_trials.extend(
            _tag_trial(r) for r in get_recordings_for_session_task(project_id, session_id, "Sustained Vowel")
        )
        ddk_trials.extend(
            _tag_trial(r) for r in get_recordings_for_session_task(project_id, session_id, "DDK")
        )

    return {
        "subject_id": subject_id,
        "vowel_trials": vowel_trials,
        "vowel_mean": _compute_mean(vowel_trials),
        "vowel_sd": _compute_sd(vowel_trials),
        "ddk_trials": ddk_trials,
        "ddk_mean": _compute_mean(ddk_trials),
        "ddk_sd": _compute_sd(ddk_trials),
    }
