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
  const scalarFields = new Set(["role", "claim_session", "runtime_session", "attempt", "incarnation",
    "terminal", "branch", "target", "baseline", "process", "status", "tests", "review", "merge",
    "source", "issue_source", "summary"]);
  const required = ["issue", "role", "claim_session", "runtime_session", "incarnation", "terminal",
    "process", "status", "exit_code", "tests", "review", "merge", "source"];
  const nonemptyStrings = ["role", "claim_session", "incarnation", "terminal", "process", "status",
    "tests", "review", "merge", "source"];
  if (value.workers.length > 20 || value.coverage.length > 1024 || value.warnings.length > 32 ||
      value.warnings.some((warning) => typeof warning !== "string")) {
    throw new Error("Snapshot exceeds its bounded contract.");
  }
  const workers = value.workers.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row) ||
        required.some((key) => !Object.hasOwn(row, key))) {
      throw new Error("Snapshot contains a malformed worker identity.");
    }
    if (!Number.isSafeInteger(row.issue) || row.issue < 1 ||
        (row.exit_code !== null && !Number.isSafeInteger(row.exit_code)) ||
        (row.observed_at !== undefined && row.observed_at !== null &&
          (typeof row.observed_at !== "number" || !Number.isFinite(row.observed_at))) ||
        nonemptyStrings.some((key) => typeof row[key] !== "string" || !row[key].length)) {
      throw new Error("Snapshot contains a malformed worker value.");
    }
    for (const key of safeWorkerFields) {
      if (!Object.hasOwn(row, key)) continue;
      const valid = scalarFields.has(key)
        ? (typeof row[key] === "string" && row[key].length <= 2048) ||
          (key === "runtime_session" && row[key] === null)
        : key === "issue" ? Number.isSafeInteger(row[key]) && row[key] > 0
          : key === "exit_code" ? row[key] === null || Number.isSafeInteger(row[key])
            : key === "observed_at" ? row[key] === null ||
              (typeof row[key] === "number" && Number.isFinite(row[key]))
              : false;
      if (!valid) throw new Error(`Snapshot contains a malformed ${key} field.`);
    }
    return Object.fromEntries(safeWorkerFields.filter((key) => Object.hasOwn(row, key))
      .map((key) => [key, row[key]]));
  });
  return {
    schemaVersion: 1,
    generated_at: value.generated_at,
    available: true,
    coverage: value.coverage,
    warnings: value.warnings.map((warning) => warning.slice(0, 512)),
    workers,
  };
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
