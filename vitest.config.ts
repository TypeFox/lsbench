import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // tests exercise the public API exported from src/index.ts
        include: ['test/**/*.test.ts'],
        environment: 'node',
    },
});
