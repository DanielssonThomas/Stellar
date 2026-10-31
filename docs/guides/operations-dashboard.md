# Local operations dashboard

The dashboard in `apps/stellar-web` shows read-only observations from local Hermes profiles and the public Stellar GitHub issue and pull-request feeds. It does not start agents, grant approvals, or infer a running process from a configured profile or a recorded session.

## Launch

Use Node 22 and install the repository dependencies with `corepack pnpm install --offline --frozen-lockfile` when the local pnpm store is populated. Start these two commands in separate terminals from the repository checkout:

```powershell
$env:STELLAR_HERMES_ROOT = 'D:\Hermes'
$env:STELLAR_DESIGN_ROOT = 'D:\ai-repositories\Stellar-Design'
node tools/dashboard/status-server.mjs
```

```powershell
corepack pnpm exec nx serve stellar-web --host=127.0.0.1 --port=4200
```

Open `http://127.0.0.1:4200/`. The status adapter binds only to `127.0.0.1:4211`. The browser polls its fixed `GET /api/status` route every 30 seconds and provides a manual refresh. Two fixed image routes serve the contract reference and latest unapproved comparison for `stellar-assistant`; neither accepts a path parameter. The comparison route permits only a numeric observation revision so a fresh status observation reloads an already visible image. Its CORS response permits the local Angular origin on port 4200. No path, command, or credential is accepted from the browser. The adapter reads only the named profile `config.yaml` model/provider fields and selected numeric/timestamp columns from each profile's `state.db`, opened read-only. It never returns prompts, transcripts, tokens, auth files, raw error text, or arbitrary local paths. Node 22 currently marks its built-in SQLite module experimental.

The GitHub feed uses unauthenticated public API requests with a four-second timeout and follows all open issue and PR pages (up to a defensive 30-page ceiling). The five recently completed issues come from the latest closed-issue page and are labeled as such. The adapter caches successful GitHub reads for five minutes; on a later failure, it labels the last result stale and retains its source timestamp. If no result exists, counts and the approval queue show unavailable rather than an empty queue. Session counts and last activity are recorded history, not proof that an agent is running. No process-level execution telemetry is connected, so agent execution is `unknown` even for an `in-progress` issue; the running metric is unavailable. `queued` means an issue is labeled `status:ready`; `blocked`, `completed`, and review stages come from GitHub issue labels. A recorded session failure is a historical timeline event, not a current failed agent. Missing session databases produce unavailable or partial aggregate usage, never an observed zero. Usage totals are local recorded model calls and tokens; subscription quota and billing are not part of this adapter. The cloud Peon profile is displayed as unqualified for coding, separate from the governed local route.

Character Studio reads the local `Stellar-Design` checkout, not the Stellar engineering repository. For the fixed `stellar-assistant` identifier, the authoritative inputs are `characters/stellar-assistant/design-contract.yaml`, `phase-state.json`, `phase1-progress.json`, and the optional `designer-session-audit.json`. The contract reference comes from its fixed reference set; the UI labels it approved only when the contract records approval; the latest comparison is an exploratory, unapproved image named by the progress record. The adapter exposes only the character ID, contract approval, requirement totals and a bounded list of outstanding IDs/statuses, recorded Designer session count and bounded technical audit state, phase and handoff flags, blocker, image availability, and source file modification time. The outstanding count is computed before truncating the displayed list and excludes achieved requirements and approved differences. Pipeline stages derive from contract/reference approval, Phase 1 records, promoted source/export, Blender launch authorization, and recorded Blender sessions; unsupported stages show unknown, and final review is never marked done without a connected evidence source. Next-action guidance follows those same records. It never returns raw notes, session traces, session IDs, filesystem paths, or hashes. The current records show Phase 1 fidelity refinement, a blocked visual approval handoff, and no promoted source/export or Blender session. Older exploratory Blender renders are not Phase 2 completion evidence. A missing checkout or malformed record produces an explicit unavailable state. The recorded Designer assignment and prior sessions do not establish that Designer is executing now.

To capture both running views after launch:

```powershell
node tools/dashboard/capture-screenshots.mjs 'C:\absolute\output\folder'
```

The command saves `stellar-operations.png` and `stellar-character-studio.png` in that folder.

The dashboard adapter has a dedicated Nx test target. The required affected CI check runs its source and HTTP boundary regression suite when adapter files change.
