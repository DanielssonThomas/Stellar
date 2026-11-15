export const statuses = ['active', 'completed', 'failed', 'interrupted'];
export const complexities = ['small', 'medium', 'large'];
export const maxTokens = 1_000_000_000_000;

export function integer(value, label, min, max, optional = false) {
  if (value == null && optional) return null;
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`Invalid ${label}`);
  return value;
}

export function choice(value, label, options, optional = false) {
  if (value == null && optional) return null;
  if (!options.includes(value)) throw new Error(`Invalid ${label}`);
  return value;
}

export function timestamp(value, optional = false) {
  if (value == null && optional) return null;
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)
  ) {
    throw new Error('Invalid UTC timestamp');
  }
  const date = new Date(value);
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 19) !== value.slice(0, 19)
  ) {
    throw new Error('Invalid UTC timestamp');
  }
  return date.toISOString();
}

export function identifier(value, label, optional = false) {
  if (value == null && optional) return null;
  if (
    typeof value !== 'string' ||
    !/^[a-z0-9][a-z0-9_.:/-]{0,95}$/i.test(value) ||
    /(?:sk-|gh[opusr]_|github_pat_|xox[baprs]-)/i.test(value) ||
    value.includes('..') ||
    value.includes('://')
  ) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

export function tokenCount(value, label, optional = false) {
  return integer(value, label, 0, maxTokens, optional);
}

export function opaqueId(value, label, optional = false) {
  if (value == null && optional) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > 512)
    throw new Error(`Invalid ${label}`);
  return value;
}
