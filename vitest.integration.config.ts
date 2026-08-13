import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // integration tests drive an actual LS for sanity checking
        include: ['test-integration/**/*.test.ts'],
        environment: 'node',
        // provisioning (clone + install + build of minilogo) happens once globally
        globalSetup: ['test-integration/setup.ts'],
        // cold clone/build and server startup are slow; give them room
        testTimeout: 120_000,
        hookTimeout: 600_000,
    },
});
