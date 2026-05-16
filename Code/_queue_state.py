"""
Persistent queue state for the Streamlit UI.

This module is imported by ui.py. Python caches imports in sys.modules,
so the state defined here survives Streamlit's per-interaction script reruns
(unlike top-level statements in ui.py itself, which re-execute every run).
"""

import threading
from concurrent.futures import ThreadPoolExecutor

LOCK: threading.Lock = threading.Lock()
TASKS: dict[str, dict] = {}        # task_id -> state dict
CANCEL: threading.Event = threading.Event()
EXECUTOR: ThreadPoolExecutor | None = None
EXECUTOR_WORKERS: int = 0
