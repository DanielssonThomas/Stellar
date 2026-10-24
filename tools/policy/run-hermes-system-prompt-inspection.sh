#!/bin/sh
set -eu

venv_python="$(python3 -c 'import json; from pathlib import Path; root=Path("/opt/hermes/installs"); facts=next(root.glob("*/facts.json")); print(json.loads(facts.read_text())["packages"]["venv"]["environment"] + "/bin/python")')"
exec "${venv_python}" /usr/local/libexec/hermes-worker-git-askpass "$@"
