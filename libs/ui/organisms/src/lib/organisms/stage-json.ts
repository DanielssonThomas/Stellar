export function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Reflect.ownKeys(value).every(
      (key) =>
        typeof key === 'string' &&
        'value' in (Object.getOwnPropertyDescriptor(value, key) ?? {}) &&
        Object.getOwnPropertyDescriptor(value, key)?.enumerable === true,
    )
  );
}

export function boundedJson(value: unknown, maximumBytes: number): boolean {
  let remaining = 256;
  function visit(entry: unknown, depth: number): boolean {
    if (--remaining < 0 || depth > 8) return false;
    if (entry === null || typeof entry === 'boolean') return true;
    if (typeof entry === 'number') return Number.isFinite(entry);
    if (typeof entry === 'string') return entry.length <= maximumBytes;
    if (Array.isArray(entry)) {
      if (
        entry.length > 128 ||
        Reflect.ownKeys(entry).length !== entry.length + 1
      )
        return false;
      for (let index = 0; index < entry.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(
          entry,
          String(index),
        );
        if (
          !descriptor ||
          !('value' in descriptor) ||
          !visit(descriptor.value, depth + 1)
        )
          return false;
      }
      return true;
    }
    if (!plainRecord(entry)) return false;
    const keys = Object.keys(entry);
    return (
      keys.length <= 128 &&
      keys.every(
        (key) => key.length <= maximumBytes && visit(entry[key], depth + 1),
      )
    );
  }
  try {
    return (
      visit(value, 0) &&
      new TextEncoder().encode(JSON.stringify(value)).byteLength <= maximumBytes
    );
  } catch {
    return false;
  }
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (plainRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

export function freezeJson<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}
