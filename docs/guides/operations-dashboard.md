# Local operations dashboard

The dashboard in `apps/stellar-web` shows read-only observations from local Hermes profiles and the public Stellar GitHub issue and pull-request feeds. It does not start agents, grant approvals, or infer a running process from a configured profile or a recorded session.

## Launch

Use Node 22 and install the repository dependencies with `corepack pnpm install --offline --frozen-lockfile` when the local pnpm store is populated. Start these two commands in separate terminals from the repository checkout:

```powershell
$env:STELLAR_HERMES_ROOT = 'D:\Hermes'
node tools/dashboard/status-server.mjs
```

```powershell
corepack pnpm exec nx serve stellar-web --host=127.0.0.1 --port=4200
```

Open `http://127.0.0.1:4200/`. The status adapter binds only to `127.0.0.1:4211`; the browser requests its single `GET /api/status` route. Its CORS response permits the local Angular origin on port 4200. No path, command, or credential is accepted from the browser. The adapter reads only the named profile `config.yaml` model/provider fields and selected numeric/timestamp columns from each profile's `state.db`, opened read-only. It never returns prompts, transcripts, tokens, auth files, raw error text, or arbitrary local paths. Node 22 currently marks its built-in SQLite module experimental.

The GitHub feed uses unauthenticated public API requests with a four-second timeout. If it is unavailable or rate-limited, issue and PR counts show an unavailable state while local status still loads. Session counts and last activity are recorded history, not proof that an agent is running. Missing session databases produce unavailable or partial aggregate usage, never an observed zero. Usage totals are local recorded model calls and tokens; subscription quota and billing are not part of this adapter. The cloud Peon profile is displayed as unqualified for coding, separate from the governed local route.

Character Studio currently has no linked approved design contract, references, VRoid/Blender progress source, renders, character session mapping, or handoff record in the repository. Each panel shows an explicit empty state until a genuine source is connected. It does not fabricate production progress.

To capture both running views after launch:

```powershell
node tools/dashboard/capture-screenshots.mjs 'C:\absolute\output\folder'
```

The command saves `stellar-operations.png` and `stellar-character-studio.png` in that folder.
