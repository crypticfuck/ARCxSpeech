import json
import os
import shutil
import tempfile
import uuid
from datetime import datetime

from app.project_paths import APP_ROOT, PROJECTS_ROOT, project_dir, sanitize_folder_name
from app.store_lock import locked

PROJECTS_FILE = os.path.join(APP_ROOT, "projects.json")

DEFAULT_ICON_COLORS = ["#6ea8fe", "#e8a33d", "#8f8f95", "#e5484d", "#5fd07a", "#c792ea"]


def _atomic_write_json(filepath, data):
    """Same atomic-write pattern as the other stores (see
    subject_store.py) -- kept as its own copy so project_store has no
    import-time dependency on them."""

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


def load_projects():
    if not os.path.exists(PROJECTS_FILE):
        _atomic_write_json(PROJECTS_FILE, [])

    try:
        with open(PROJECTS_FILE, "r") as f:
            return json.load(f)

    except json.JSONDecodeError as e:
        raise RuntimeError(
            f"Project registry at {PROJECTS_FILE} is corrupted and could "
            f"not be read ({e}). No data was modified. Restore from a "
            "backup before continuing, since this file lists every "
            "project in the workspace."
        ) from e


def get_project(project_id):
    return next((p for p in load_projects() if p.get("id") == project_id), None)


def _default_icon(name: str) -> str:
    words = (name or "").split()
    letters = "".join(w[0] for w in words[:2]).upper()
    return letters or "PR"

@locked
def create_project(name, icon=None, color=None):
    projects = load_projects()

    normalized = name.strip().lower()
    if any(p["name"].strip().lower() == normalized for p in projects):
        raise ValueError(f'A project named "{name}" already exists.')

    # Checked (and the folder pre-built) BEFORE the registry write
    # below: two different names could in theory sanitize to the same
    # folder (e.g. "Test/A" vs "Test A"), and since name uniqueness
    # above is checked against the raw name, a pre-existing folder at
    # this point means a real collision, not a rerun -- silently
    # reusing it would mix two projects' data. Doing this check first
    # means a collision fails BEFORE projects.json is touched, instead
    # of leaving a registered project with no folder.
    candidate_dir = os.path.join(PROJECTS_ROOT, sanitize_folder_name(name, fallback="untitled"))
    if os.path.exists(candidate_dir):
        raise ValueError(
            f'A project folder for "{name}" already exists on disk '
            f"({candidate_dir!r}) -- rename or remove it before creating this project."
        )

    now = datetime.now().isoformat()
    project = {
        "id": str(uuid.uuid4()),
        "name": name,
        "icon": icon or _default_icon(name),
        "color": color or DEFAULT_ICON_COLORS[len(projects) % len(DEFAULT_ICON_COLORS)],
        "status": "active",
        "createdAt": now,
        "lastEditedAt": now,
    }

    projects.append(project)
    _atomic_write_json(PROJECTS_FILE, projects)

    # Materialize the project's folder immediately (rather than lazily
    # on first subject/session write) so it shows up as a real,
    # browsable directory the moment it's created.
    os.makedirs(project_dir(project["id"]))

    return project

@locked
def update_project(project_id, name=None, status=None):
    """Patches name and/or status (active/review/archived) on an
    existing project. Returns the updated row, or None if project_id
    didn't exist.

    Since a project's on-disk folder is named after its `name` (see
    project_paths.project_dir), a rename here has to rename that
    folder too -- otherwise the project's data would stay parked
    under its old name while every store starts looking for it under
    the new one, orphaning it. old_dir is resolved BEFORE the name is
    patched/written, and the move happens AFTER, so the folder rename
    always reflects the name that's actually persisted."""
    projects = load_projects()

    if name is not None:
        normalized = name.strip().lower()
        if any(p["id"] != project_id and p["name"].strip().lower() == normalized for p in projects):
            raise ValueError(f'A project named "{name}" already exists.')

    old_dir = project_dir(project_id) if name is not None else None
    new_dir = None
    if name is not None:
        new_dir = os.path.join(PROJECTS_ROOT, sanitize_folder_name(name, fallback="untitled"))
        if old_dir != new_dir and os.path.exists(new_dir):
            # Checked BEFORE the registry write below, same reasoning
            # as create_project: fail before the name change is
            # persisted, rather than persisting a name whose folder
            # rename then fails and leaves data parked under the old
            # folder while every lookup expects the new one.
            #
            # Raised as ValueError (not RuntimeError) on purpose: it's
            # the same exception type -- and therefore the same 409 +
            # message shape -- as the "name already exists" check
            # above, so the frontend's existing duplicate-name error
            # handling (red input, etc.) covers this case for free,
            # with no separate error path to add.
            raise ValueError(
                f'A project folder for "{name}" already exists on disk '
                f"({new_dir!r}) -- rename or remove it before using this name."
            )

    target = None
    for p in projects:
        if p.get("id") == project_id:
            if name is not None:
                p["name"] = name
            if status is not None:
                p["status"] = status
            target = p
            break

    if target is None:
        return None

    # Move the folder FIRST: if Windows refuses (a WAV is open), nothing
    # has been persisted yet and the project still points at old_dir.
    if old_dir is not None and old_dir != new_dir and os.path.isdir(old_dir):
        try:
            shutil.move(old_dir, new_dir)
        except OSError as e:
            raise ValueError(
                f"Could not rename the project folder ({e}). Close any open "
                "recordings from this project and try again."
            ) from e

    _atomic_write_json(PROJECTS_FILE, projects)

    return target

@locked
def touch_project(project_id):
    """Bumps lastEditedAt to now. Call this from api/routes.py whenever
    a project's underlying data changes (new subject, session,
    recording, etc.) so the home page's "edited 2h ago" labels and
    most-recently-edited sort stay accurate without every store needing
    to know about the project registry itself."""
    projects = load_projects()
    for p in projects:
        if p.get("id") == project_id:
            p["lastEditedAt"] = datetime.now().isoformat()
            _atomic_write_json(PROJECTS_FILE, projects)
            return p
    return None

@locked
def delete_project(project_id):
    """Removes the project row AND its entire data directory
    (subjects/sessions/recordings/audio files -- everything). Returns
    True if a project was actually removed, False if project_id didn't
    exist. There is no separate per-entity cascade needed here (unlike
    subject/session deletion) because a project's whole folder is one
    unit of storage."""
    projects = load_projects()
    remaining = [p for p in projects if p.get("id") != project_id]

    if len(remaining) == len(projects):
        return False

    # Resolve the on-disk folder BEFORE removing the project's row --
    # project_dir() looks the project up via get_project(), which reads
    # projects.json fresh from disk, so calling it after the row is
    # already gone raises "Unknown project_id" instead of finding the
    # folder to delete.
    d = project_dir(project_id)

    _atomic_write_json(PROJECTS_FILE, remaining)

    if os.path.isdir(d):
        shutil.rmtree(d, ignore_errors=True)

    return True
