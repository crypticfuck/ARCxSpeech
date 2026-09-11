"""
Performance Instrumentation
============================

Two pieces:

- `measure_performance` -- decorator applied to every verify_* function.
  Wraps the ENTIRE test (signal generation + extraction + comparison)
  and records wall-clock Run Time, CPU Time, and incremental RAM use,
  writing them into result["extra"].

- `timed_extract` -- wraps just ONE call into the real pipeline
  (extract_vowel_features / extract_ddk_features), returning its result
  plus that call's latency in ms. This is "Latency" in the report:
  the pipeline's own processing time, separate from Run Time (which
  also includes synthetic signal generation and ground-truth diffing
  that only exist because this is a test, not real usage).

Uses psutil if available for a real before/after RSS delta (how much
memory THIS test actually consumed). Falls back to `resource.ru_maxrss`
(process-lifetime peak, not a clean per-call delta) if psutil isn't
installed, and labels it accordingly so the report isn't misleading.
"""

import functools
import time

try:
    import psutil
    _PROCESS = psutil.Process()
    _HAS_PSUTIL = True
except ImportError:
    _HAS_PSUTIL = False
    _PROCESS = None

try:
    import resource
    _HAS_RESOURCE = True
except ImportError:
    _HAS_RESOURCE = False


def _rss_mb():
    return _PROCESS.memory_info().rss / (1024 ** 2)


def measure_performance(fn):
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        wall_start = time.perf_counter()
        cpu_start = time.process_time()
        rss_start = _rss_mb() if _HAS_PSUTIL else None

        result = fn(*args, **kwargs)

        wall_s = time.perf_counter() - wall_start
        cpu_s = time.process_time() - cpu_start

        if _HAS_PSUTIL:
            ram_mb = max(_rss_mb() - rss_start, 0.0)
            ram_label = "delta"
        elif _HAS_RESOURCE:
            ram_mb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024  # KB -> MB (Linux)
            ram_label = "process_peak"
        else:
            ram_mb = None
            ram_label = "unavailable"

        if isinstance(result, dict):
            result.setdefault("extra", {})
            result["extra"]["run_time_ms"] = round(wall_s * 1000, 2)
            result["extra"]["cpu_time_ms"] = round(cpu_s * 1000, 2)
            result["extra"]["ram_mb"] = round(ram_mb, 3)
            result["extra"]["ram_label"] = ram_label

        return result

    return wrapper


def timed_extract(fn, *args, **kwargs):
    """Runs fn(*args, **kwargs), returns (result, latency_ms)."""
    t0 = time.perf_counter()
    result = fn(*args, **kwargs)
    latency_ms = (time.perf_counter() - t0) * 1000
    return result, latency_ms


def mean_latency(latencies_ms):
    return round(sum(latencies_ms) / len(latencies_ms), 3) if latencies_ms else None
