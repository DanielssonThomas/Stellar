import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tools/desktop-probe/src/**/*.spec.ts'],
    environment: 'node',
  },
});
