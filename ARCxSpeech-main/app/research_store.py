import json
import os
import tempfile
import numpy as np
from statistics import mode
from statistics import StatisticsError
from collections import Counter
import math
from sklearn.decomposition import PCA

_APP_ROOT = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
)

RND_FILE = os.path.join(_APP_ROOT, "research_sessions.json")
BASELINE_FILE = os.path.join(_APP_ROOT, "baseline.json")


def _atomic_write_json(filepath, data):
    """
    Writes JSON to `filepath` atomically: data is written to a temp file
    in the same directory, flushed to disk, then moved into place with
    os.replace (atomic on both POSIX and Windows). This means a crash or
    power loss mid-write can never leave `filepath` truncated or corrupt --
    either the old file is intact, or the new one is.
    """

    directory = os.path.dirname(filepath) or "."

    fd, tmp_path = tempfile.mkstemp(
        dir=directory,
        prefix=".tmp_",
        suffix=".json"
    )

    try:

        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=4)
            f.flush()
            os.fsync(f.fileno())

        os.replace(tmp_path, filepath)

    except Exception:

        try:
            os.remove(tmp_path)
        except OSError:
            pass

        raise


def _load_json_or_raise(filepath, empty_default):

    if not os.path.exists(filepath):
        _atomic_write_json(filepath, empty_default)

    try:

        with open(filepath, "r") as f:
            return json.load(f)

    except json.JSONDecodeError as e:

        raise RuntimeError(
            f"Data file at {filepath} is corrupted and could not be "
            f"read ({e}). No data was modified. Restore from a backup "
            "before continuing."
        ) from e


def load_research_data():
    return _load_json_or_raise(RND_FILE, {})


def _compute_aggregate(batch_metrics):
    """
    Given a list of metrics dicts (one per recording, all for the same
    preprocessing stage), computes mean/median/mode/std per metric.
    """

    aggregate = {}

    if not batch_metrics:
        return aggregate

    metric_keys = batch_metrics[0].keys()

    for key in metric_keys:

        values = []

        for metrics in batch_metrics:

            value = metrics.get(key)

            if isinstance(value, (int, float)):
                values.append(value)

        if values:

            rounded_values = [

                round(v, 2)

                for v in values
            ]

            try:

                mode_value = mode(
                    rounded_values
                )

            except StatisticsError:

                mode_value = "N/A"

            aggregate[key] = {

                "mean": round(
                    float(np.mean(values)),
                    4
                ),

                "median": round(
                    float(np.median(values)),
                    4
                ),

                "mode": mode_value,

                "std": round(
                    float(np.std(values)),
                    4
                )
            }

    return aggregate


def save_batch(
    batch_name,
    task,
    recordings,
    speaker_id,
    device,
    environment,
    distance,
    notes
):
    """
    recordings: list of
        {
            "filepath": str,
            "stages": {
                stage_key: {
                    "label": str,
                    "layers_applied": [...],
                    "metrics": {...}
                },
                ...
            },
            "feature_vector": [...]   (drawn from the full 2-layer stage,
                                        used by PCA exactly as before)
        }

    Computes an aggregate (mean/median/mode/std per metric) independently
    for each preprocessing stage ("No Layer" / "1 Layer" / "2 Layers"),
    stored under "aggregate_by_stage", so R&D History can show how each
    layer shifts biomarker values relative to raw audio.

    "aggregate" (top-level, flat) is kept for backward compatibility with
    Set Baseline / Compute Drift / Rank Survivability / PCA, which are
    stage-agnostic and continue to operate on the fully preprocessed
    ("2 Layers") stage, exactly as they did before staged extraction was
    added.
    """

    data = load_research_data()

    stage_keys = []

    if recordings:
        stage_keys = list(recordings[0]["stages"].keys())

    aggregate_by_stage = {}

    for stage_key in stage_keys:

        batch_metrics = [
            recording["stages"][stage_key]["metrics"]
            for recording in recordings
            if stage_key in recording["stages"]
        ]

        aggregate_by_stage[stage_key] = _compute_aggregate(batch_metrics)

    stage_labels = {}

    if recordings:
        stage_labels = {
            stage_key: recordings[0]["stages"][stage_key]["label"]
            for stage_key in stage_keys
        }

    # Backward-compatible flat aggregate: the full-preprocessing stage
    # (last stage key) if staged data exists, else empty.
    full_stage_key = stage_keys[-1] if stage_keys else None
    flat_aggregate = aggregate_by_stage.get(full_stage_key, {}) if full_stage_key else {}

    data[batch_name] = {

        "task": task,

        "speaker_id": speaker_id,

        "device": device,

        "environment": environment,

        "distance_cm": distance,

        "notes": notes,

        "recordings": recordings,

        "stage_labels": stage_labels,

        # Per-stage aggregates, keyed by stage key -- powers the R&D
        # History radio-button stage comparison.
        "aggregate_by_stage": aggregate_by_stage,

        # Flat aggregate for Set Baseline / Compute Drift / Rank
        # Survivability / PCA (stage-agnostic, uses full pipeline).
        "aggregate": flat_aggregate
    }

    _atomic_write_json(RND_FILE, data)


# =====================================
# SAVE BASELINE
# =====================================

def save_baseline(
    batch_name,
    aggregate
):

    baseline = {

        "batch_name": batch_name,

        "aggregate": aggregate
    }

    _atomic_write_json(BASELINE_FILE, baseline)

# =====================================
# LOAD BASELINE
# =====================================

def load_baseline():

    if not os.path.exists(
        BASELINE_FILE
    ):

        return None

    try:

        with open(
            BASELINE_FILE,
            "r"
        ) as f:

            return json.load(f)

    except json.JSONDecodeError as e:

        raise RuntimeError(
            f"Baseline data file at {BASELINE_FILE} is corrupted and "
            f"could not be read ({e}). Re-run 'Set Baseline' or restore "
            "from a backup."
        ) from e

# =====================================
# COMPUTE DRIFT
# =====================================

# REPLACEMENT:
def compute_drift(
    baseline_aggregate,
    noise_aggregate
):
    """
    Returns (drift_results, skipped) where `skipped` lists (feature,
    reason) for every feature that could NOT get a drift value, so
    callers can tell the user something was left out instead of
    silently showing a shorter table.
    """

    drift_results = {}
    skipped = []

    for feature in baseline_aggregate.keys():

        if feature not in noise_aggregate:

            skipped.append((feature, "not present in this batch"))
            continue

        baseline_mean = baseline_aggregate[
            feature
        ]["mean"]

        noise_mean = noise_aggregate[
            feature
        ]["mean"]

        if baseline_mean == 0:

            # Relative drift is undefined at a zero baseline. Report
            # absolute drift instead of just dropping the feature --
            # count/percentage-type metrics (Silence %, Clipping %,
            # Low-SNR Frame %) are exactly the ones most likely to
            # have a legitimate zero baseline, and they're often the
            # most diagnostically relevant ones to NOT lose silently.
            drift_results[feature] = round(abs(noise_mean), 6)

            skipped.append((
                feature,
                "zero baseline -- reported as absolute, not relative, drift"
            ))

            continue

        drift = abs(
            noise_mean - baseline_mean
        ) / abs(baseline_mean)

        drift_results[feature] = round(
            drift,
            6
        )

    return drift_results, skipped  

# =====================================
# FEATURE SURVIVABILITY RANKING
# =====================================

# REPLACEMENT:
def rank_feature_survivability(
    baseline_aggregate,
    research_data
):
    """
    Returns (ranking, skipped_features) -- skipped_features lists
    every baseline feature that produced NO ranking entry (zero
    baseline mean, or no batch had any data for it) so the caller can
    tell the user it was excluded instead of it just quietly not
    appearing in the table.
    """

    feature_drifts = {}
    zero_baseline_features = set()

    baseline_features = baseline_aggregate.keys()

    for feature in baseline_features:

        feature_drifts[feature] = []

        baseline_mean = baseline_aggregate[
            feature
        ]["mean"]

        if baseline_mean == 0:

            # Same reasoning as compute_drift(): don't just drop a
            # feature because its baseline happens to be zero -- that
            # disproportionately excludes count/percentage metrics
            # that are often the most clinically interesting ones.
            zero_baseline_features.add(feature)

        for batch_name, batch_data in research_data.items():

            aggregate = batch_data.get(
                "aggregate",
                {}
            )

            if feature not in aggregate:
                continue

            noise_mean = aggregate[
                feature
            ]["mean"]

            if baseline_mean == 0:

                drift = abs(noise_mean)

            else:

                drift = abs(
                    noise_mean - baseline_mean
                ) / abs(baseline_mean)

            feature_drifts[
                feature
            ].append(drift)

    ranking = []
    skipped_features = []

    for feature, drifts in feature_drifts.items():

        if len(drifts) == 0:

            skipped_features.append(feature)
            continue

        mean_drift = float(
            np.mean(drifts)
        )

        ranking.append({

            "feature": feature,

            "mean_drift": round(
                mean_drift,
                6
            ),

            "absolute_drift": feature in zero_baseline_features
        })

    ranking = sorted(

        ranking,

        key=lambda x: x[
            "mean_drift"
        ]
    )

    return ranking, skipped_features

# =====================================
# PCA ANALYSIS
# =====================================

def perform_pca_analysis(
    research_data
):

    feature_vectors = []

    labels = []

    for batch_name, batch_data in research_data.items():

        recordings = batch_data[
            "recordings"
        ]

        for recording in recordings:

            vector = recording.get(
                "feature_vector",
                []
            )

            if len(vector) == 0:
                continue

            feature_vectors.append(
                vector
            )

            labels.append(
                batch_name
            )

    if len(feature_vectors) < 2:

        return None, None, None, 0

    # REPLACEMENT:
    # Different batches can carry feature vectors of different lengths --
    # either because they mix tasks (Sustained Vowel vs DDK produce a
    # different number of features), or because they were saved under an
    # older/newer version of feature_extractor.py. PCA needs one
    # consistent length across all rows, so keep only the vectors
    # matching the most common length and drop the rest instead of
    # crashing with a ragged-array error.

    lengths = [
        len(vector)
        for vector in feature_vectors
    ]

    most_common_length = Counter(
        lengths
    ).most_common(1)[0][0]

    total_before = len(feature_vectors)

    filtered = [
        (vector, label)
        for vector, label in zip(feature_vectors, labels)
        if len(vector) == most_common_length
    ]

    dropped_count = total_before - len(filtered)

    if len(filtered) < 2:

        return None, None, None, dropped_count

    feature_vectors, labels = zip(*filtered)

    feature_vectors = list(feature_vectors)

    labels = list(labels)

    X = np.array(
        feature_vectors
    )

    if X.shape[0] < 2 or X.shape[1] < 2:

        return None, None, None, dropped_count

    pca = PCA(
        n_components=2
    )

    transformed = pca.fit_transform(X)

    explained_variance = pca.explained_variance_ratio_

    return (
        transformed,
        labels,
        explained_variance,
        dropped_count
    )