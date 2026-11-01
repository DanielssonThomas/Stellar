export class DesktopContractError extends Error {
  constructor(
    readonly kind: 'malformed' | 'unsupported-version' | 'unknown-variant',
  ) {
    super(`Desktop contract: ${kind}`);
  }
}

export function record(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new DesktopContractError('malformed');
  const result = value as Record<string, unknown>;
  if (
    required.some((key) => !Object.hasOwn(result, key)) ||
    Object.keys(result).some(
      (key) => !required.includes(key) && !optional.includes(key),
    )
  )
    throw new DesktopContractError('malformed');
  return result;
}

export function version(value: unknown): 1 {
  if (
    !Number.isInteger(value) ||
    typeof value !== 'number' ||
    value < 0 ||
    value > 65535
  )
    throw new DesktopContractError('malformed');
  if (value !== 1) throw new DesktopContractError('unsupported-version');
  return value;
}

export function boundedString(value: unknown, bytes: number): string {
  if (
    typeof value !== 'string' ||
    value.length > bytes ||
    new TextEncoder().encode(value).length > bytes
  )
    throw new DesktopContractError('malformed');
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (character.length === 1 && code >= 0xd800 && code <= 0xdfff)
      throw new DesktopContractError('malformed');
  }
  return value;
}

export function sequence(value: unknown): string {
  const result = boundedString(value, 20);
  if (
    !/^(0|[1-9][0-9]{0,19})$/.test(result) ||
    BigInt(result) > 18446744073709551615n
  )
    throw new DesktopContractError('malformed');
  return result;
}
