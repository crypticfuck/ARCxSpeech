from fastapi import APIRouter, HTTPException, UploadFile, File, Form
from fastapi.responses import FileResponse
from pydantic import BaseModel
from typing import List, Optional
import os
import tempfile

import numpy as np
import soundfile as sf

from app.feature_extractor import extract_vowel_features, extract_ddk_features, extract_ddk_contour, load_audio, compute_spectrogram
from app.recorder import record_audio, prepare_serial, release_prepared, RecordingError, RecordingTimeoutError, SilentRecordingError
from app.preprocessing import remove_dc_offset, apply_frequency_filtering
from app.ambient_analyzer import extract_ambient_metrics
from app.verifier import verify_audio
from app.recording_quality import (
    analyze_recording_quality,
    classify_recording_quality,
    aggregate_recording_quality_metrics,
)
from app import subject_store, recording_store, project_store
from app.project_paths import project_dir, subjects_root, recording_dir, recording_stem, date_key
from app.clinical_history import (
    build_assessment_record,
    build_trial_scores,
    get_patient_assessment_history,
)
from app.baseline import compute_patient_baseline, evaluate_against_baseline
from app.change_detector import analyze_patient_trajectory
from app.motor_fatigue_curve import analyze_fatigue_curve

router = APIRouter()


def _require_project(project_id: str) -> dict:
    """Every route below operates on data that lives inside one
    project's folder -- this 404s up front (rather than letting a
    bogus project_id silently create an empty new folder the first
    time a store is touched) if the project doesn't actually exist."""
    project = project_store.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found.")
    return project


def _recording_abspath(project_id: str, rel_path: str) -> str:
    """Recordings are stored as paths relative to the PROJECT's own
    folder (e.g. "recordings/patient_audio/x.wav") in that project's
    recordings.json; resolve against this project's directory to get a
    real filesystem path."""
    if os.path.isabs(rel_path):
        return rel_path
    return os.path.join(project_dir(project_id), rel_path)


def _safe_recording_path(project_id: str, rel_path: str) -> str:
    """Resolves a recording path the CLIENT supplied into a real
    filesystem path, refusing anything that isn't safely inside THIS
    project's recordings directory.

    Client-controlled input needs this extra containment check --
    absolute paths, "../" segments, or a symlink inside recordings/
    pointing elsewhere could otherwise be used to read arbitrary files
    off disk, including another project's recordings. os.path.commonpath
    (rather than a startswith() string check) is what actually catches
    lookalike-prefix escapes."""
    if not rel_path or os.path.isabs(rel_path):
        raise HTTPException(status_code=400, detail="Invalid recording path.")

    recordings_dir = os.path.normpath(subjects_root(project_id))
    candidate = os.path.normpath(os.path.join(project_dir(project_id), rel_path))

    if os.path.commonpath([candidate, recordings_dir]) != recordings_dir:
        raise HTTPException(status_code=400, detail="Invalid recording path.")

    if not os.path.isfile(candidate):
        raise HTTPException(status_code=404, detail="Recording not found.")

    return candidate


def _delete_unreferenced_recordings(project_id: str, candidate_paths: List[str], surviving_recordings: List[dict]):
    """Deletes each candidate recording file from disk, UNLESS some other
    surviving recording (any session, any subject, within this same
    project) still points at that same path -- mock/demo data can reuse
    a couple of shared sample WAVs across multiple recordings, so a
    naive delete would break those too."""
    still_referenced = set()
    for r in surviving_recordings:
        if r.get("patient_filepath"):
            still_referenced.add(r["patient_filepath"])
        if r.get("ambient_filepath"):
            still_referenced.add(r["ambient_filepath"])

    for rel_path in candidate_paths:
        if not rel_path or rel_path in still_referenced:
            continue
        try:
            abspath = _recording_abspath(project_id, rel_path)
            if os.path.exists(abspath):
                os.remove(abspath)
        except OSError:
            pass


# =====================================
# PROJECTS
# =====================================

class ProjectCreate(BaseModel):
    name: str
    icon: Optional[str] = None
    color: Optional[str] = None


class ProjectUpdate(BaseModel):
    name: Optional[str] = None
    status: Optional[str] = None  # "active" | "review" | "archived"


@router.get("/api/projects")
def get_projects():
    return project_store.load_projects()


@router.post("/api/projects")
def create_project(project: ProjectCreate):
    try:
        return project_store.create_project(
            name=project.name,
            icon=project.icon,
            color=project.color,
        )
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))


@router.get("/api/projects/{project_id}")
def get_project(project_id: str):
    return _require_project(project_id)


@router.patch("/api/projects/{project_id}")
def update_project(project_id: str, patch: ProjectUpdate):
    _require_project(project_id)
    try:
        updated = project_store.update_project(project_id, name=patch.name, status=patch.status)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    if not updated:
        raise HTTPException(status_code=404, detail="Project not found.")
    return updated


@router.delete("/api/projects/{project_id}")
def delete_project(project_id: str):
    """Deletes a project and every subject/recording/audio file inside
    it -- see project_store.delete_project for why no separate
    per-entity cascade is needed here."""
    _require_project(project_id)
    project_store.delete_project(project_id)
    return {"status": "success", "deleted_project_id": project_id}


# =====================================
# SUBJECTS (scoped to one project)
# =====================================

class Subject(BaseModel):
    id: Optional[str] = None
    name: str
    sex: str = ""
    age: str = ""
    group: str = ""


@router.get("/api/projects/{project_id}/subjects")
def get_subjects(project_id: str):
    _require_project(project_id)
    return subject_store.load_subjects(project_id)


@router.post("/api/projects/{project_id}/subjects")
def add_subject(project_id: str, subject: Subject):
    _require_project(project_id)
    created = subject_store.add_subject(
        project_id,
        name=subject.name,
        subject_id=subject.id,
        sex=subject.sex,
        age=subject.age,
        group=subject.group,
    )
    project_store.touch_project(project_id)
    return created


@router.delete("/api/projects/{project_id}/subjects/{subject_id}")
def delete_subject(project_id: str, subject_id: str):
    """Deletes a subject entirely: their record, every recording they
    have, and any recording files on disk that no other surviving
    recording in this project still references."""
    _require_project(project_id)
    subject = subject_store.get_subject(project_id, subject_id)
    if not subject:
        raise HTTPException(status_code=404, detail="Subject not found.")

    deleted_recordings = recording_store.delete_recordings_for_subject(project_id, subject_id)

    subject_store.delete_subject(project_id, subject_id)

    candidate_paths = []
    for r in deleted_recordings:
        if r.get("patient_filepath"):
            candidate_paths.append(r["patient_filepath"])
        if r.get("ambient_filepath"):
            candidate_paths.append(r["ambient_filepath"])
    _delete_unreferenced_recordings(project_id, candidate_paths, recording_store.load_recordings(project_id))

    project_store.touch_project(project_id)
    return {"status": "success", "deleted_subject_id": subject_id}


@router.get("/api/projects/{project_id}/subjects/{subject_id}/summary")
def get_subject_summary(project_id: str, subject_id: str):
    """Live-computed mean/SD summary built from every recording this
    subject has in this project."""
    _require_project(project_id)
    if not subject_store.get_subject(project_id, subject_id):
        raise HTTPException(status_code=404, detail="Subject not found.")

    return recording_store.compute_subject_summary(project_id, subject_id)


class RecordingsSummaryRequest(BaseModel):
    recording_ids: List[str]


@router.post("/api/projects/{project_id}/recordings/summary")
def get_recordings_summary(project_id: str, body: RecordingsSummaryRequest):
    """Same live-computed Assessment-shaped summary as the subject
    summary route, but for an arbitrary, caller-picked set of
    recordings (e.g. hand-selected across the Select Recording
    dropdown) instead of everything a subject has. POST (not GET)
    because the recording id list can be long and doesn't belong in a
    query string."""
    _require_project(project_id)
    if not body.recording_ids:
        raise HTTPException(status_code=400, detail="recording_ids must not be empty.")
    return recording_store.compute_recordings_summary(project_id, body.recording_ids)


# =====================================
# RECORDING PLAYBACK
# =====================================
# Lets the frontend play back a saved recording (e.g. an <audio> tag
# pointed at this URL). `path` is the same relative path already handed
# to the frontend -- patient_filepath/ambient_filepath from a recording
# row, relative to this project's own folder -- so no new ID scheme or
# lookup is needed.
@router.get("/api/projects/{project_id}/recordings/audio")
def get_recording_audio(project_id: str, path: str):
    _require_project(project_id)
    abspath = _safe_recording_path(project_id, path)
    return FileResponse(
        abspath,
        media_type="audio/wav",
        filename=os.path.basename(abspath),
    )


# =====================================
# HARDWARE PREPARE/RELEASE -- NOT project-scoped
# =====================================
# There is exactly one serial device attached to the machine regardless
# of which project's recording is being captured into, so "warm up
# the mic" has no per-project meaning. These two stay global; the project
# association happens down in add_live_recording below, once the
# recording itself is being saved.

@router.post("/api/recording/prepare")
def prepare_recording():
    """Opens + settles the serial connection ahead of a timed capture,
    so that settle time can happen during the UI's pre-record
    countdown instead of after the actual recording request lands.
    Call this when the countdown starts, then pass the returned token
    to POST /api/projects/{id}/subjects/{id}/recordings."""

    try:
        token = prepare_serial()
    except RecordingError as e:
        raise HTTPException(
            status_code=503,
            detail={"error_type": "hardware_not_connected", "detail": str(e)},
        )

    return {"token": token}


@router.delete("/api/recording/prepare/{token}")
def release_recording_prepare(token: str):
    """Discards a prepared-but-unused connection, e.g. when the user
    cancels the pre-record countdown before it finishes. Best-effort --
    an unknown/already-expired token is a no-op, not an error."""

    release_prepared(token)
    return {"released": True}


def _extract_features(filepath: str, task: str) -> dict:
    if task == "DDK":
        return extract_ddk_features(filepath)
    return extract_vowel_features(filepath)


def _preprocess_and_extract(patient_filepath: str, task: str) -> dict:
    """Same 2-layer preprocessing pipeline as before (DC offset removal,
    then frequency filtering) on a temp WAV, then feature extraction on
    that cleaned copy. Pulled out into its own helper so it can run
    either inline (old behavior) or deferred, batched across a whole
    subject's recordings (see /recordings/extract below)."""
    raw_audio, sr = sf.read(patient_filepath, dtype="float32", always_2d=False)
    audio_dc = remove_dc_offset(raw_audio)
    audio_clean = apply_frequency_filtering(audio_dc, sr)

    fd, temp_path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)

    try:
        safe_audio = np.clip(audio_clean, -1.0, 1.0).astype(np.float32)
        sf.write(temp_path, safe_audio, sr, subtype="PCM_16")
        return _extract_features(temp_path, task)
    finally:
        try:
            os.remove(temp_path)
        except OSError:
            pass


class LiveRecordingRequest(BaseModel):
    task: str  # "Sustained Vowel" | "DDK"
    duration: float
    # Token from /api/recording/prepare, when the client warmed up the
    # serial connection during the pre-record countdown. Lets
    # record_audio() start reading immediately instead of spending ~2s
    # opening + settling the port after this request lands -- which is
    # what previously made real capture start (and, since a fixed
    # duration's worth of samples is read, end) run late relative to
    # the on-screen countdown/progress bar.
    prepare_token: Optional[str] = None


@router.post("/api/projects/{project_id}/subjects/{subject_id}/recordings")
def add_live_recording(project_id: str, subject_id: str, payload: LiveRecordingRequest):
    _require_project(project_id)
    if not subject_store.get_subject(project_id, subject_id):
        raise HTTPException(status_code=404, detail="Subject not found.")

    date = date_key()
    # Serial = this take's 1-based position within this subject+date+task.
    # Just a starting guess -- recording_dir() bumps it if a folder
    # for that exact serial+"live" is already on disk (e.g. an
    # earlier take here was deleted).
    serial = len(recording_store.get_recordings_for_subject_date_task(project_id, subject_id, date, payload.task)) + 1
    take_dir = recording_dir(
        project_id, subject_id, date,
        payload.task, serial, "live",
    )

    base_name = recording_stem(subject_id, payload.task)

    try:
        patient_filepath, ambient_filepath, _audio = record_audio(
            payload.duration,
            take_dir,
            take_dir,
            base_name,
            prepare_token=payload.prepare_token,
        )
    except RecordingTimeoutError as e:
        raise HTTPException(
            status_code=504,
            detail={"error_type": "recording_timeout", "detail": str(e)},
        )
    except SilentRecordingError as e:
        raise HTTPException(
            status_code=422,
            detail={"error_type": "silent_recording", "detail": str(e)},
        )
    except RecordingError as e:
        raise HTTPException(
            status_code=503,
            detail={"error_type": "hardware_not_connected", "detail": str(e)},
        )

    # record_audio() builds these from take_dir (an absolute path). All
    # the processing below (verification, ambient/quality analysis,
    # feature extraction) needs those real absolute paths -- but what
    # gets persisted to this project's recordings.json must stay
    # relative to the project's own folder, same convention
    # _save_upload() uses below, since _safe_recording_path() (used by
    # the audio-playback endpoint) rejects absolute paths outright as a
    # path-traversal guard. Without this conversion, every live
    # recording's patient_filepath/ambient_filepath would be stored
    # absolute and fail to play back.
    project_folder = project_dir(project_id)
    stored_patient_filepath = (
        os.path.relpath(patient_filepath, project_folder)
        if os.path.isabs(patient_filepath) else patient_filepath
    )
    stored_ambient_filepath = (
        os.path.relpath(ambient_filepath, project_folder)
        if os.path.isabs(ambient_filepath) else ambient_filepath
    )

    # Chain-of-custody verification (peak/clipping check + SHA256 hash),
    # logged server-side for the audit trail -- same as the old /api/verify.
    verification = {
        "patient": verify_audio(patient_filepath),
        "ambient": verify_audio(ambient_filepath),
    }

    # Ambient + recording-quality analysis, same as the old
    # /api/analyze_quality -- failures here don't block the trial, they
    # just leave that metric set empty, same as before.
    ambient_metrics = None
    quality_metrics = None
    quality_classification = None

    try:
        ambient_metrics = extract_ambient_metrics(ambient_filepath)
    except Exception as e:
        print(f"Ambient analysis failed for {ambient_filepath}: {e}")

    try:
        quality_metrics = analyze_recording_quality(patient_filepath, ambient_filepath)
    except Exception as e:
        print(f"Quality analysis failed for {patient_filepath}: {e}")

    if quality_metrics:
        try:
            quality_classification = classify_recording_quality(quality_metrics)
        except (KeyError, TypeError):
            quality_classification = None

    # Preprocessing (DC offset removal + frequency filtering) and feature
    # extraction are NOT run here anymore -- the take is logged with
    # features={} the moment it's quality-confirmed, and the frontend's
    # "Extract Features" button (top-right of the recording modal) is
    # what triggers /api/projects/{id}/subjects/{id}/recordings/extract
    # to batch-run this pipeline over every pending recording this
    # subject has at once.
    recording = recording_store.add_recording(
        project_id,
        subject_id=subject_id,
        date=date,
        task=payload.task,
        source="live",
        patient_filepath=stored_patient_filepath,
        features={},
        ambient_filepath=stored_ambient_filepath,
        ambient_metrics=ambient_metrics,
        quality_metrics=quality_metrics,
        quality_classification=quality_classification,
    )

    project_store.touch_project(project_id)
    return {**recording, "verification": verification}


# =====================================
# UPLOAD -- any number of files, added to a subject directly,
# callable repeatedly
# =====================================
# Deliberately does NOT touch the clinical pipeline (verifier,
# recording_quality, quality_thresholds, ambient_analyzer) -- there's no
# ambient channel or live hardware involved for an uploaded file. Features
# are extracted directly from the uploaded file with plain
# extract_vowel_features/extract_ddk_features -- no DC-offset removal or
# frequency filtering, so uploaded recordings show raw, unprocessed
# biomarkers, same as the old upload path.

def _save_upload(project_id: str, subject_id: str, date: str, upload: UploadFile, task: str, serial: int) -> str:
    ext = os.path.splitext(upload.filename or "")[1] or ".wav"
    filename = f"patient_{recording_stem(subject_id, task)}{ext}"
    # Uploaded files are patient-side only -- there's no ambient
    # channel or live hardware involved (see module docstring above).
    upload_dir = recording_dir(project_id, subject_id, date, task, serial, "uploaded")
    os.makedirs(upload_dir, exist_ok=True)
    filepath = os.path.join(upload_dir, filename)
    with open(filepath, "wb") as f:
        f.write(upload.file.read())
    # Stored (and later returned to the client) as a path relative to
    # this PROJECT's own folder -- e.g.
    # "Subjects/RD-83331/Recordings/2026-09-12/DDK/01_uploaded/patient_DDK_20260910-143205_RD-83331.wav" --
    # matching the convention record_audio() already uses. Without this,
    # patient_filepath would be saved as a full filesystem path, which
    # _safe_recording_path() (used by the audio-playback endpoint below)
    # rejects outright, since an absolute path from a client is exactly
    # what that check exists to block.
    return os.path.relpath(filepath, project_dir(project_id))


@router.post("/api/projects/{project_id}/subjects/{subject_id}/recordings/upload")
def upload_recordings(
    project_id: str,
    subject_id: str,
    task: str = Form(...),
    files: List[UploadFile] = File(...),
):
    _require_project(project_id)
    if not subject_store.get_subject(project_id, subject_id):
        raise HTTPException(status_code=404, detail="Subject not found.")
    if len(files) < 1:
        raise HTTPException(status_code=400, detail="At least 1 .wav file is required.")

    date = date_key()
    created = []
    errors = []
    next_serial = len(recording_store.get_recordings_for_subject_date_task(project_id, subject_id, date, task)) + 1
    for upload in files:
        rel_filepath = None
        try:
            rel_filepath = _save_upload(project_id, subject_id, date, upload, task, next_serial)
            next_serial += 1
            abs_path = _recording_abspath(project_id, rel_filepath)
            # Same DC-offset + filtering pipeline the live path uses, so
            # uploaded and live takes are comparable in one date group's mean.
            features = _preprocess_and_extract(abs_path, task)
            created.append(
                recording_store.add_recording(
                    project_id,
                    subject_id=subject_id,
                    date=date,
                    task=task,
                    source="uploaded",
                    patient_filepath=rel_filepath,
                    features=features,
                )
            )
        except Exception as e:
            # Per-file failure: drop the orphaned file, keep going, report it.
            if rel_filepath:
                try:
                    os.remove(_recording_abspath(project_id, rel_filepath))
                except OSError:
                    pass
            errors.append({"filename": upload.filename, "error": str(e)})

    if not created:
        raise HTTPException(status_code=422, detail=f"Feature extraction failed: {errors}")

    project_store.touch_project(project_id)
    return {"created": created, "errors": errors}


@router.post("/api/projects/{project_id}/subjects/{subject_id}/recordings/extract")
def extract_subject_features(project_id: str, subject_id: str):
    """Batch-runs preprocessing + feature extraction over every recording
    this subject has that's still pending it (features == {}) -- i.e.
    every take logged via the live-recording flow since add_live_recording
    no longer extracts inline. Triggered by the "Extract Features" button
    at the top-right of the recording modal. A recording failing
    extraction doesn't block the rest; it's reported back in `errors` and
    stays pending so a re-run can retry it."""

    _require_project(project_id)
    if not subject_store.get_subject(project_id, subject_id):
        raise HTTPException(status_code=404, detail="Subject not found.")

    pending = [
        r for r in recording_store.get_recordings_for_subject(project_id, subject_id)
        if not r.get("features")
    ]

    updated = []
    errors = []

    for r in pending:
        try:
            abs_patient_path = _recording_abspath(project_id, r["patient_filepath"])
            features = _preprocess_and_extract(abs_patient_path, r["task"])
            updated_row = recording_store.update_recording_features(project_id, r["recording_id"], features)
            if updated_row:
                updated.append(updated_row)
        except Exception as e:
            errors.append({"recording_id": r["recording_id"], "error": str(e)})

    return {"updated": updated, "errors": errors}


@router.get("/api/projects/{project_id}/subjects/{subject_id}/recordings")
def get_recordings(project_id: str, subject_id: str):
    _require_project(project_id)
    if not subject_store.get_subject(project_id, subject_id):
        raise HTTPException(status_code=404, detail="Subject not found.")
    return recording_store.get_recordings_for_subject(project_id, subject_id)


# =====================================
# SPECTROGRAM (real STFT, not the frontend's scalar-feature stand-in)
# =====================================
# The Spectrogram graph widget (UI/js/project.js) used to synthesize a
# fake-but-plausible harmonic image from F0/F1/F2/HNR alone -- never a
# real STFT of the waveform. compute_spectrogram() in
# app/feature_extractor.py already did the real work but was never
# wired to an endpoint. This exposes it per-recording: load that
# recording's patient audio (same 16kHz-resampled signal every other
# feature is measured from, so it lines up with F0/formant readouts),
# run the STFT, and return the freq/time/magnitude grid as JSON for
# the frontend to paint directly instead of synthesizing.
#
# Trimmed to 0-4kHz (same range the widget already displays) and
# rounded before serializing -- an untrimmed 16kHz STFT is ~513 freq
# bins, most of which are above where vowel/formant energy lives and
# would roughly double the payload for no visual benefit at this
# widget's size.
SPECTROGRAM_MAX_FREQ_HZ = 4000


@router.get("/api/projects/{project_id}/subjects/{subject_id}/recordings/{recording_id}/spectrogram")
def get_recording_spectrogram(project_id: str, subject_id: str, recording_id: str):
    _require_project(project_id)
    recording = recording_store.get_recording(project_id, recording_id)
    if not recording or recording.get("subject_id") != subject_id:
        raise HTTPException(status_code=404, detail="Recording not found.")

    patient_filepath = recording.get("patient_filepath")
    if not patient_filepath:
        raise HTTPException(status_code=404, detail="No audio on this recording.")

    abspath = _recording_abspath(project_id, patient_filepath)
    if not os.path.isfile(abspath):
        raise HTTPException(status_code=404, detail="Audio file missing on disk.")

    patient_audio, _ambient_audio, sr, _duration, _sound = load_audio(abspath)
    freqs, times, magnitude_db = compute_spectrogram(patient_audio, sr)

    freq_mask = freqs <= SPECTROGRAM_MAX_FREQ_HZ
    freqs = freqs[freq_mask]
    magnitude_db = magnitude_db[freq_mask, :]

    return {
        "freqs": [round(float(f), 1) for f in freqs],
        "times": [round(float(t), 3) for t in times],
        # [freq_bins][time_bins], low frequency first -- matches freqs
        # order above; the frontend flips it when painting (low
        # frequency at the bottom of the image).
        # Whole dB, not one decimal -- a color-mapped heatmap doesn't
        # need sub-dB precision, and this is the bulk of the payload
        # (up to ~150k values for a longer DDK clip), so trimming it
        # to integers noticeably shrinks the response.
        "magnitude_db": [[round(float(v)) for v in row] for row in magnitude_db],
    }


# =====================================
# DDK CONTOUR (real per-frame data for the DDK Peak Tracker / Interval
# Bar Chart / Regularity Trend graph widgets -- see extract_ddk_contour()
# in app/feature_extractor.py for the array shapes returned)
# =====================================
DDK_WAVEFORM_ENVELOPE_BINS = 600


@router.get("/api/projects/{project_id}/subjects/{subject_id}/recordings/{recording_id}/ddk-contour")
def get_recording_ddk_contour(project_id: str, subject_id: str, recording_id: str):
    _require_project(project_id)
    recording = recording_store.get_recording(project_id, recording_id)
    if not recording or recording.get("subject_id") != subject_id:
        raise HTTPException(status_code=404, detail="Recording not found.")

    patient_filepath = recording.get("patient_filepath")
    if not patient_filepath:
        raise HTTPException(status_code=404, detail="No audio on this recording.")

    abspath = _recording_abspath(project_id, patient_filepath)
    if not os.path.isfile(abspath):
        raise HTTPException(status_code=404, detail="Audio file missing on disk.")

    contour = extract_ddk_contour(abspath, waveform_bins=DDK_WAVEFORM_ENVELOPE_BINS)

    return {
        "duration": round(contour["duration"], 3),
        "intensity_times": [round(t, 3) for t in contour["intensity_times"]],
        "intensity_values": [round(v, 1) for v in contour["intensity_values"]],
        "threshold": round(contour["threshold"], 1),
        "peak_times": [round(t, 3) for t in contour["peak_times"]],
        "intervals": [round(v, 3) for v in contour["intervals"]],
        "interval_local_irregularity": [round(v, 1) for v in contour["interval_local_irregularity"]],
        "waveform_min": [round(v, 4) for v in contour["waveform_min"]],
        "waveform_max": [round(v, 4) for v in contour["waveform_max"]],
    }


@router.delete("/api/projects/{project_id}/subjects/{subject_id}/recordings/{recording_id}")
def delete_recording(project_id: str, subject_id: str, recording_id: str):
    _require_project(project_id)
    deleted = recording_store.delete_recording(project_id, recording_id)
    if not deleted or deleted.get("subject_id") != subject_id:
        raise HTTPException(status_code=404, detail="Recording not found.")

    candidate_paths = []
    if deleted.get("patient_filepath"):
        candidate_paths.append(deleted["patient_filepath"])
    if deleted.get("ambient_filepath"):
        candidate_paths.append(deleted["ambient_filepath"])
    _delete_unreferenced_recordings(project_id, candidate_paths, recording_store.load_recordings(project_id))

    project_store.touch_project(project_id)
    return {"status": "success"}


# =====================================
# CLINICAL INFERENCE ENGINE
# =====================================
# Ported over from the standalone speech_motor_state / change_detector /
# trajectory_mapper / baseline modules. app.clinical_history bridges
# subject/recording data into the assessment-shaped records those
# modules expect -- see that file for the full explanation. One
# calendar-date group (see project_paths.date_key) is the "point in
# time" unit these routes score, replacing the old one-session-per-
# point scoring -- this is a minimal swap, not a redesign of the
# engine itself (see clinical_history.py's module docstring).


@router.get("/api/projects/{project_id}/subjects/{subject_id}/dates/{date}/motor-state")
def get_date_motor_state(project_id: str, subject_id: str, date: str):
    """Speech motor-state domain scores (Stability, Timing, Coordination,
    Phonatory Control) for one subject's recordings on one calendar date,
    computed live from those recordings. 404s if the subject doesn't
    exist; 422 if the subject has no sex on file, since the scoring
    model requires one."""
    _require_project(project_id)
    subject = subject_store.get_subject(project_id, subject_id)
    if not subject:
        raise HTTPException(status_code=404, detail="Subject not found.")

    sex = (subject or {}).get("sex")
    if sex not in ("Male", "Female"):
        raise HTTPException(
            status_code=422,
            detail="Subject sex must be set to 'Male' or 'Female' before motor-state scoring is available.",
        )

    return build_assessment_record(project_id, subject_id, date, sex)


@router.get("/api/projects/{project_id}/subjects/{subject_id}/insights")
def get_subject_insights(project_id: str, subject_id: str):
    """Longitudinal clinical insights for a subject: rolling baseline,
    the latest date group's deviation from that baseline, and the full
    change-detector trajectory (deltas/Z-scores/alerts) across their
    quality-gated date-group history within this project.

    Date groups that failed the quality gate (low recording quality or
    detected clipping) are excluded from history the same way the
    original assessment_store-backed engine excluded them -- see
    baseline.get_valid_patient_history.
    """
    _require_project(project_id)
    if not subject_store.get_subject(project_id, subject_id):
        raise HTTPException(status_code=404, detail="Subject not found.")

    history = get_patient_assessment_history(project_id, subject_id)

    baseline = compute_patient_baseline(project_id, subject_id, exclude_latest=True)
    trajectory = analyze_patient_trajectory(history)

    deviation = None
    if history and baseline.get("status") == "active":
        latest = history[-1]
        deviation = evaluate_against_baseline(
            baseline,
            latest.get("vowel_mean", {}),
            latest.get("ddk_mean", {}),
        )

    return {
        "subject_id": subject_id,
        "dates_analyzed": len(history),
        "baseline": baseline,
        "deviation_from_baseline": deviation,
        "trajectory": trajectory,
    }


@router.get("/api/projects/{project_id}/subjects/{subject_id}/dates/{date}/fatigue")
def get_date_fatigue(project_id: str, subject_id: str, date: str, task: str):
    """Within-date-group fatigue curve for one task (e.g. task=DDK):
    scores each recording in that task individually, in capture order,
    and runs them through motor_fatigue_curve.analyze_fatigue_curve.

    Every trial is currently labeled "continuous" -- there's no
    rest-period field anywhere in the data model yet, so recovery/
    post-rest metrics will always read as unavailable rather than
    reflect a real rest break. See build_trial_scores in
    clinical_history.py for the full explanation.
    """
    _require_project(project_id)
    subject = subject_store.get_subject(project_id, subject_id)
    if not subject:
        raise HTTPException(status_code=404, detail="Subject not found.")

    sex = (subject or {}).get("sex")
    if sex not in ("Male", "Female"):
        raise HTTPException(
            status_code=422,
            detail="Subject sex must be set to 'Male' or 'Female' before fatigue scoring is available.",
        )

    trials = build_trial_scores(project_id, subject_id, date, task, sex)
    if not trials:
        raise HTTPException(
            status_code=422,
            detail=f"No scoreable recordings found for task '{task}' on this date.",
        )

    return analyze_fatigue_curve(trials)
