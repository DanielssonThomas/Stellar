export function disabledIntegrationFallback() {
  return Object.freeze({
    allowed: false,
    label: 'Not Architect approved',
    reasons: ['fallback-disabled'],
  });
}
