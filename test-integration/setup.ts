import { ensureMinilogo } from './minilogo.js';

// vitest globalSetup: provision the minilogo language server once before the
// integration suite runs. Cloning + building can take a while on a cold cache,
// so integration tests use a generous per-test timeout (see the config).
export default function setup(): void {
    ensureMinilogo();
}
