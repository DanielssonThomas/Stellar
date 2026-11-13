"""Retained byte-pinned disposable operator entry; never a managed-runtime installer."""
from pathlib import Path
import sys

if __name__ == '__main__':
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from stellar_background.fixture_cli import main
    main()
