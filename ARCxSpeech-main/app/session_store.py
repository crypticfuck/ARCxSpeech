import json
import os
import tempfile
import uuid
from datetime import datetime

from app.project_paths import project_file
from app.store_lock import locked


def _sessions_file(project_id):
    return project_file(project_id, "sessions.json")


def _atomic_write_json(filepath, data):
    """Same atomic-write pattern as the other stores -- see
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


def load_sessions(project_id):
    sessions_file = _sessions_file(project_id)

    if not os.path.exists(sessions_file):
        _atomic_write_json(sessions_file, [])

    try:
        with open(sessions_file, "r") as f:
            return json.load(f)

    except json.JSONDecodeError as e:
        raise RuntimeError(
            f"Session data file at {sessions_file} is corrupted and could "
            f"not be read ({e}). No data was modified. Restore from a "
            "backup before continuing, since this file holds every "
            "session in this project."
        ) from e


def get_sessions_for_subject(project_id, subject_id):
    sessions = load_sessions(project_id)
    return [s for s in sessions if s.get("subject_id") == subject_id]


def get_session(project_id, session_id):
    sessions = load_sessions(project_id)
    return next((s for s in sessions if s.get("session_id") == session_id), None)

@locked
def create_session(project_id, subject_id, name=None):
    """Creates and persists an empty session container under a subject.
    `name` auto-fills as "Session N" (N = existing session count for this
    subject + 1) when left blank, matching the new UI's Add Session
    modal. No tasks or recordings are required to create one -- those
    get added later via recording_store.py."""

    sessions = load_sessions(project_id)

    if not name:
        existing_count = len(get_sessions_for_subject(project_id, subject_id))
        name = f"Session {existing_count + 1}"

    session = {
        "session_id": str(uuid.uuid4()),
        "subject_id": subject_id,
        "name": name,
        "created_at": datetime.now().isoformat(),
    }

    sessions.append(session)
    _atomic_write_json(_sessions_file(project_id), sessions)

    return session

@locked
def delete_session(project_id, session_id):
    """Removes the session row only. Cascading delete of that session's
    recordings/files is deliberately NOT done here -- it belongs in
    api/routes.py, same deferral pattern as subject_store.delete_subject.
    Returns True if a session was actually removed, False if session_id
    didn't exist."""

    sessions = load_sessions(project_id)
    remaining = [s for s in sessions if s.get("session_id") != session_id]

    if len(remaining) == len(sessions):
        return False

    _atomic_write_json(_sessions_file(project_id), remaining)
    return True
