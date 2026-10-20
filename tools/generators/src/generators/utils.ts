export function assertKebabCase(value: string, label: string): string {
  const normalized = value.trim();
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(normalized)) {
    throw new Error(`${label} must use lowercase kebab-case.`);
  }
  return normalized;
}

export function toPascalCase(value: string): string {
  return value
    .split('-')
    .map((segment) => segment[0].toUpperCase() + segment.slice(1))
    .join('');
}
