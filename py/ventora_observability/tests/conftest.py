from __future__ import annotations
import sys
from pathlib import Path

# Ensure src is importable when running tests directly
src_path = Path(__file__).parents[1] / "src"
if str(src_path) not in sys.path:
    sys.path.insert(0, str(src_path))
