"""Run the candidate's disposable-only package CLI. Never apply to installed Hermes."""
from pathlib import Path
import sys

if __name__ == '__main__':
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'config/hermes-compat/stellar-background-v1'))
    from stellar_background.fixture_cli import main
    main()
