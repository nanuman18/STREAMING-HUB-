import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          // Llamadas reales a TMDB: más margen de tiempo y sin paralelismo.
          testTimeout: 180_000,
          hookTimeout: 600_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
