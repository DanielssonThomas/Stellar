import { describe, expect, it } from 'vitest';

describe('MSW test setup', () => {
  it('intercepts HTTP requests with the shared handler', async () => {
    const response = await fetch('http://localhost/api/health');

    expect(response.ok).toBe(true);
    expect(await response.json()).toEqual({ status: 'ok' });
  });
});
