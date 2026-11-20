export const POLL_MS = 5000;
export const MAX_BYTES = 65536;

export function validateSnapshot(value) {
  if (!value || value.schemaVersion !== 1 || value.available !== true ||
      !Array.isArray(value.workers) || typeof value.generated_at !== "number" ||
      !Number.isFinite(value.generated_at) || value.generated_at < 0 ||
      typeof value.coverage !== "string" || !Array.isArray(value.warnings)) {
    throw new Error("Snapshot is malformed or unavailable.");
  }
  const safeWorkerFields = ["issue", "role", "claim_session", "runtime_session", "attempt", "incarnation",
    "terminal", "branch", "target", "baseline", "process", "status", "exit_code", "tests", "review",
    "merge", "observed_at", "source", "issue_source", "summary"];
  const workers = value.workers.slice(0, 20).filter((row) => row && typeof row === "object").map((row) =>
    Object.fromEntries(safeWorkerFields.filter((key) => Object.hasOwn(row, key)).map((key) => [key, row[key]])));
  return { ...value, workers, warnings: value.warnings.slice(0, 32).map((warning) => String(warning).slice(0, 512)) };
}

export function freshness(timestamp, now = Date.now()) {
  const age = now - timestamp * 1000;
  if (!Number.isFinite(age) || age < 0) return "Freshness unknown";
  return age > 60000 ? `Snapshot stale · ${Math.floor(age / 1000)}s old` : "Snapshot current";
}

export class RetainedSnapshot {
  snapshot = null;
  warning = "Waiting for retained worker snapshot.";

  accept(raw, now = Date.now()) {
    if (typeof raw !== "string") throw new Error("Snapshot file is unavailable.");
    if (new TextEncoder().encode(raw).length > MAX_BYTES) throw new Error("Snapshot exceeds 64 KiB.");
    const next = validateSnapshot(JSON.parse(raw));
    this.snapshot = next;
    this.warning = next.warnings.length ? next.warnings.join(" · ") : "";
    const fresh = freshness(next.generated_at, now);
    if (fresh !== "Snapshot current") this.warning = [this.warning, fresh].filter(Boolean).join(" · ");
    return next;
  }

  fail(error) {
    this.warning = `${String(error?.message ?? error)} · Showing retained last-good data.`;
  }
}

export class RefreshController {
  constructor(read, notify, schedule) {
    this.read = read;
    this.notify = notify;
    this.schedule = schedule;
    this.closed = false;
    this.inFlight = false;
    this.task = null;
  }

  start() { this.queue(0); }

  queue(delay) {
    if (!this.closed) this.task = this.schedule(delay, (cx) => this.tick(cx));
  }

  async tick(cx) {
    if (this.closed || this.inFlight) return;
    this.inFlight = true;
    try { await this.read(); } catch { /* RetainedSnapshot owns visible failures. */ }
    finally {
      this.inFlight = false;
      if (!this.closed) {
        try { this.notify(cx); } catch { this.close(); }
        this.queue(POLL_MS);
      }
    }
  }

  close() {
    this.closed = true;
    this.task?.cancel();
  }
}
