import { randomBytes } from 'node:crypto';

const artifactIdPattern = /^[a-f0-9]{32}$/;
const scopePattern = /^[A-Za-z0-9._:-]{1,160}$/;

export class ArtifactUnavailableError extends Error {
  constructor(category) {
    super(`Trusted output artifact unavailable (${category}).`);
    this.name = 'ArtifactUnavailableError';
    this.category = category;
  }
}

/**
 * In-memory, trusted-process-only artifact storage for staging experiments.
 * Identifiers are opaque and paths/metadata are never exposed. The store does
 * not add an Hermes tool or wire itself into the live worker.
 */
export class TrustedArtifactStore {
  #entries = new Map();
  #expiredIds = new Map();
  #bytes = 0;
  #closed = false;

  constructor({
    now = Date.now,
    createId = () => randomBytes(16).toString('hex'),
    maxArtifacts = 16,
    maxArtifactBytes = 1_048_576,
    maxTotalBytes = 4_194_304,
    ttlMs = 60_000,
    maxTtlMs = 300_000,
    scheduleExpiry = (callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      timer.unref?.();
      return () => clearTimeout(timer);
    },
  } = {}) {
    if (!Number.isInteger(maxArtifacts) || maxArtifacts < 1)
      throw new TypeError('maxArtifacts must be a positive integer.');
    if (!Number.isInteger(maxArtifactBytes) || maxArtifactBytes < 1)
      throw new TypeError('maxArtifactBytes must be a positive integer.');
    if (!Number.isInteger(maxTotalBytes) || maxTotalBytes < maxArtifactBytes)
      throw new TypeError('maxTotalBytes must be at least maxArtifactBytes.');
    if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > maxTtlMs)
      throw new TypeError('ttlMs must be positive and within maxTtlMs.');
    this.now = now;
    this.createId = createId;
    this.maxArtifacts = maxArtifacts;
    this.maxArtifactBytes = maxArtifactBytes;
    this.maxTotalBytes = maxTotalBytes;
    this.ttlMs = ttlMs;
    this.scheduleExpiry = scheduleExpiry;
  }

  put(scope, content) {
    this.#assertOpen();
    this.#validateScope(scope);
    if (typeof content !== 'string')
      throw new TypeError('Artifact content must be text.');
    this.#expire();

    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > this.maxArtifactBytes)
      throw new ArtifactUnavailableError('size-limit');
    if (this.#entries.size >= this.maxArtifacts)
      throw new ArtifactUnavailableError('count-limit');
    if (this.#bytes + bytes > this.maxTotalBytes)
      throw new ArtifactUnavailableError('total-size-limit');

    let artifactId;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      artifactId = this.createId();
      if (artifactIdPattern.test(artifactId) && !this.#entries.has(artifactId))
        break;
      artifactId = undefined;
    }
    if (!artifactId) throw new ArtifactUnavailableError('identifier-failure');

    const entry = {
      scope,
      content,
      bytes,
      expiresAt: this.now() + this.ttlMs,
    };
    entry.cancelExpiry = this.scheduleExpiry(
      () => this.#expireEntry(artifactId, entry),
      this.ttlMs,
    );
    this.#entries.set(artifactId, entry);
    this.#bytes += bytes;
    return artifactId;
  }

  retrieve(scope, artifactId, { firstLine, lastLine }) {
    this.#assertOpen();
    this.#validateScope(scope);
    if (!artifactIdPattern.test(artifactId ?? ''))
      throw new ArtifactUnavailableError('invalid-reference');
    this.#expire();
    const entry = this.#entries.get(artifactId);
    if (!entry && this.#expiredIds.get(artifactId)?.scope === scope)
      throw new ArtifactUnavailableError('expired');
    if (!entry || entry.scope !== scope)
      throw new ArtifactUnavailableError('not-found');

    const offsets = [0];
    for (let index = 0; index < entry.content.length; index += 1) {
      if (entry.content[index] === '\n') offsets.push(index + 1);
    }
    const lineCount = entry.content === '' ? 0 : offsets.length;
    if (
      !Number.isInteger(firstLine) ||
      !Number.isInteger(lastLine) ||
      firstLine < 1 ||
      lastLine < firstLine ||
      lastLine > lineCount
    )
      throw new ArtifactUnavailableError('invalid-range');

    const start = offsets[firstLine - 1];
    const end = offsets[lastLine] ?? entry.content.length;
    return {
      content: entry.content.slice(start, end),
      firstLine,
      lastLine,
    };
  }

  cleanupScope(scope) {
    this.#assertOpen();
    this.#validateScope(scope);
    for (const [artifactId, entry] of this.#entries) {
      if (entry.scope === scope) this.#delete(artifactId, entry);
    }
  }

  close() {
    if (this.#closed) return;
    for (const [artifactId, entry] of this.#entries) {
      this.#delete(artifactId, entry);
    }
    this.#entries.clear();
    this.#expiredIds.clear();
    this.#bytes = 0;
    this.#closed = true;
  }

  get stats() {
    this.#assertOpen();
    this.#expire();
    return { artifacts: this.#entries.size, bytes: this.#bytes };
  }

  #assertOpen() {
    if (this.#closed) throw new ArtifactUnavailableError('store-closed');
  }

  #validateScope(scope) {
    if (typeof scope !== 'string' || !scopePattern.test(scope))
      throw new ArtifactUnavailableError('invalid-scope');
  }

  #expire() {
    const now = this.now();
    for (const [artifactId, entry] of this.#entries) {
      if (entry.expiresAt <= now) {
        this.#expireEntry(artifactId, entry);
      }
    }
    while (this.#expiredIds.size > this.maxArtifacts) {
      this.#expiredIds.delete(this.#expiredIds.keys().next().value);
    }
  }

  #delete(artifactId, entry) {
    entry.cancelExpiry?.();
    this.#entries.delete(artifactId);
    this.#bytes -= entry.bytes;
  }

  #expireEntry(artifactId, entry) {
    if (this.#entries.get(artifactId) !== entry) return;
    this.#delete(artifactId, entry);
    this.#expiredIds.set(artifactId, {
      scope: entry.scope,
      expiredAt: this.now(),
    });
    while (this.#expiredIds.size > this.maxArtifacts) {
      this.#expiredIds.delete(this.#expiredIds.keys().next().value);
    }
  }
}
