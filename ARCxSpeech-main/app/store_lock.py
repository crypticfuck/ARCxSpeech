import threading
from functools import wraps

# One process-wide re-entrant lock shared by project/subject/session/
# recording stores. FastAPI runs the sync routes in a thread pool, so
# two simultaneous load->modify->save cycles could otherwise drop one.
STORE_LOCK = threading.RLock()


def locked(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        with STORE_LOCK:
            return fn(*args, **kwargs)
    return wrapper