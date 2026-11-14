"""Optional Hermes no-agent cron entry point. Always silent; records observations only."""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path


def main():
    try:
        from hermes_constants import get_hermes_home

        folder = Path(__file__).resolve().parent
        name = 'stellar_herdr_observer'
        spec = importlib.util.spec_from_file_location(name, folder / '__init__.py',
                                                     submodule_search_locations=[str(folder)])
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
        module.operate(Path(get_hermes_home()), {'action': 'reconcile'})
    except Exception:
        # A no-agent script's nonzero exit creates a scheduler alert, even after opt-out.
        print('Stellar observation tick unavailable; no notification was attempted.', file=sys.stderr)
    # Cron stdout is a delivery surface. Never print the local records onto an unpinned route.
    print('{"wakeAgent": false}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
