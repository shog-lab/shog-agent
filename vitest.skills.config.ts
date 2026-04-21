import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['.pi/skills/**/tests/*.test.ts'],
  },
});
