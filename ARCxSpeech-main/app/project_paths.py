"""
Central place that resolves a project_id (+ subject/session/task, for
recordings) into filesystem paths. Every per-project store
(subject_store, session_store, recording_store) and the recorder call
through here instead of hardcoding paths themselves, so "where does
project X's data live on disk" is answered in exactly one place.

Layout on disk:

    ARCxSpeech-main/
        projects.json                <- registry of all projects (project_store.py)
        projects/
            <project name>/
                subjects.json
                sessions.json
                recordings.json
                research_sessions.json
                baseline.json
                Subjects/
                    <subject id>/
                        Sessions/
                            <session name> (<short session id>)/
                                DDK/
                                    01_live/          <- both channels of take 1
                                    02_uploaded/       <- patient channel only
                                Sustained/
                                    01_live/

Deleting a project is therefore just removing its one directory under
projects/ (see project_store.delete_project).

NOTE on project folders being name-based: the project's `id` (UUID)
is still the primary key everywhere -- every API route, and every
foreign key inside subjects.json/sessions.json/recordings.json --
this file is the ONLY place that resolves id -> current on-disk
folder. That resolution is done fresh on every call (by looking the
project up in projects.json), which is what lets project_store.py
rename the folder in place when a project's name changes (see
update_project) without anything else in the app needing to know or
care that the folder name and the project name are the same thing.
"""

import os
import re
import datetime

APP_ROOT = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
)

PROJECTS_ROOT = os.path.join(APP_ROOT, "projects")

# Characters Windows forbids in filenames, plus control characters.
# (macOS/Linux are more permissive, but sanitizing to the stricter
# Windows rule keeps one project folder portable across all three,
# which matters since this app ships as a Windows desktop build.)
_UNSAFE_CHARS_RE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_WHITESPACE_RE = re.compile(r"\s+")
_WINDOWS_RESERVED = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}
_MAX_COMPONENT_LEN = 150  # generous, but keeps deeply nested paths under Windows' MAX_PATH


def sanitize_folder_name(raw: str, fallback: str = "untitled") -> str:
    """Turns an arbitrary string (project name, subject id, session
    name, ...) into one filesystem-safe path COMPONENT. Never raises --
    worst case it falls back to `fallback` -- since this is used to
    build folder names from user-entered text, not to validate input."""
    name = (raw or "").strip()
    name = _UNSAFE_CHARS_RE.sub("_", name)
    name = _WHITESPACE_RE.sub(" ", name).strip()
    name = name.rstrip(" .")  # Windows disallows trailing space/dot
    if not name:
        name = fallback
    if name.upper() in _WINDOWS_RESERVED:
        name = f"_{name}"
    return name[:_MAX_COMPONENT_LEN]


def _guard_id(value: str, label: str) -> str:
    """Rejects anything that isn't a bare directory-name-safe id --
    ids sometimes arrive straight from a URL path parameter, so this
    is the one guard that stops a crafted id like "../../etc" from
    escaping its parent directory entirely, before any file path is
    ever built from it."""
    if not value or value in (".", "..") or "/" in value or "\\" in value:
        raise ValueError(f"Invalid {label}: {value!r}")
    return value


def project_dir(project_id: str) -> str:
    """Root folder for one project's data, named after the project's
    CURRENT name (not its id). Looking this up fresh every call (via
    project_store) is what lets a rename take effect immediately
    everywhere, with no cache to invalidate."""
    _guard_id(project_id, "project_id")

    # Local import: project_store imports APP_ROOT/project_dir from
    # this module, so importing project_store at module load time
    # here would be circular. Deferring the import to call time avoids
    # that while still sharing one project_store as the source of
    # truth for id -> name.
    from app.project_store import get_project

    project = get_project(project_id)
    if project is None:
        raise ValueError(f"Unknown project_id: {project_id!r}")

    return os.path.join(PROJECTS_ROOT, sanitize_folder_name(project["name"], fallback="untitled"))


def project_file(project_id: str, filename: str) -> str:
    """Path to one JSON store file inside a project's folder, creating
    the folder on first use so a brand-new project doesn't need an
    explicit mkdir before its first subject/session is written."""
    d = project_dir(project_id)
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, filename)


def subjects_root(project_id: str) -> str:
    """The tree that holds every recording in this project. Also the
    containment boundary api/routes.py checks client-supplied
    recording paths against (see _safe_recording_path)."""
    return os.path.join(project_dir(project_id), "Subjects")


def subject_dir(project_id: str, subject_id: str) -> str:
    _guard_id(subject_id, "subject_id")
    return os.path.join(subjects_root(project_id), sanitize_folder_name(subject_id))


def session_dir(project_id: str, subject_id: str, session_id: str, session_name: str = None) -> str:
    """Session folders are named "<session name> (<short id>)". The
    name alone isn't guaranteed unique -- default names like "Session
    1" can repeat after a delete + re-add -- so the first 8 chars of
    the session's uuid are always appended, which is guaranteed
    unique and keeps the folder readable at the same time."""
    _guard_id(session_id, "session_id")
    label = sanitize_folder_name(session_name, fallback="Session") if session_name else "Session"
    folder = f"{label} ({session_id[:8]})"
    return os.path.join(subject_dir(project_id, subject_id), "Sessions", folder)


# Display task names (as stored on each recording row) -> the folder
# name they live under. Anything not in this map falls back to a
# sanitized version of the task string itself, so a future third task
# type doesn't silently break path resolution.
_TASK_FOLDER_NAMES = {
    "Sustained Vowel": "Sustained",
    "DDK": "DDK",
}


def task_folder_name(task: str) -> str:
    return _TASK_FOLDER_NAMES.get(task, sanitize_folder_name(task, fallback="Task"))


def recording_stem(subject_id: str, task: str, when: "datetime.datetime" = None) -> str:
    """Human-readable stem for a recording file, task/time/subject only
    -- the caller prefixes their own channel, e.g. "patient_" /
    "ambient_": "<channel>_<task>_<date>-<time>_<subject id>", e.g.
    "patient_DDK_20260910-143205_RD-83331.wav".

    Compact "YYYYmmdd-HHMMSS" stamp (no "-"/":" to worry about) --
    sanitize_folder_name() is still run over the result as a safety
    net for whatever's in subject_id itself."""
    when = when or datetime.datetime.now()
    label = task_folder_name(task)
    stamp = when.strftime("%Y%m%d-%H%M%S")
    return sanitize_folder_name(f"{label}_{stamp}_{subject_id}")


def task_dir(project_id: str, subject_id: str, session_id: str, session_name: str, task: str) -> str:
    return os.path.join(
        session_dir(project_id, subject_id, session_id, session_name),
        task_folder_name(task),
    )


def recording_dir(
    project_id: str, subject_id: str, session_id: str, session_name: str,
    task: str, serial: int, source: str,
) -> str:
    """One folder per take, named "<serial>_<source>" (e.g.
    "01_live", "02_uploaded") -- `serial` is the take's 1-based
    position within this session+task, `source` is "live" or
    "uploaded", matching the `source` field already stored on each
    recording row. This folder holds BOTH the patient and ambient
    audio for a live take (uploaded takes only ever have patient
    audio -- there's no ambient channel for an upload).

    If a folder for that exact serial+source already exists (e.g. an
    earlier take in this slot was deleted and the caller's serial
    guess -- typically len(existing takes) + 1 -- collides with one
    that's still on disk), the serial is bumped until a free folder
    name is found, so two different takes can never land in the same
    directory."""
    base = task_dir(project_id, subject_id, session_id, session_name, task)
    n = max(int(serial), 1)
    while True:
        candidate = os.path.join(base, f"{n:02d}_{source}")
        if not os.path.exists(candidate):
            return candidate
        n += 1


def project_exists(project_id: str) -> bool:
    try:
        return os.path.isdir(project_dir(project_id))
    except ValueError:
        return False
