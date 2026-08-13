import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// shared location + build info for the minilogo language server, used by both the
// global setup (which provisions it) and the test (which spawns it).

const here = path.dirname(fileURLToPath(import.meta.url));

/** repo root of lsbench */
const repoRoot = path.resolve(here, '..');

/** gitignored cache dir where the minilogo checkout lives */
const cacheDir = path.join(repoRoot, '.integration');

/** the cloned minilogo working copy */
const minilogoDir = path.join(cacheDir, 'langium-minilogo');

/** the built language server entry point we drive over stdio */
export const serverEntry = path.join(minilogoDir, 'out', 'language-server', 'main.js');

/** examples shipped with minilogo, used as the benchmark workspace */
export const examplesDir = path.join(minilogoDir, 'examples');

const MINILOGO_REPO = 'https://github.com/TypeFox/langium-minilogo';

/** true once minilogo has been cloned, installed, and built */
function isBuilt(): boolean {
    return fs.existsSync(serverEntry);
}

function run(command: string, args: string[], cwd: string): void {
    const result = cp.spawnSync(command, args, {
        cwd,
        stdio: 'inherit',
        // langium-cli / esbuild resolve better with the full env
        env: process.env,
    });
    if (result.status !== 0) {
        throw new Error(`command failed (${result.status}): ${command} ${args.join(' ')}`);
    }
}

/**
 * Clone, install, and build the minilogo language server if it isn't already
 * present. Idempotent: a completed build short-circuits, so repeated runs are
 * cheap. Set LSBENCH_INTEGRATION_REBUILD=1 to force a clean rebuild.
 */
export function ensureMinilogo(): void {
    const forceRebuild = process.env.LSBENCH_INTEGRATION_REBUILD === '1';

    if (isBuilt() && !forceRebuild) {
        return;
    }

    if (forceRebuild) {
        fs.rmSync(minilogoDir, { recursive: true, force: true });
    }

    fs.mkdirSync(cacheDir, { recursive: true });

    if (!fs.existsSync(path.join(minilogoDir, '.git'))) {
        fs.rmSync(minilogoDir, { recursive: true, force: true });
        console.log(`[integration] cloning ${MINILOGO_REPO} ...`);
        run('git', ['clone', '--depth', '1', MINILOGO_REPO, minilogoDir], cacheDir);
    }

    console.log('[integration] installing minilogo dependencies ...');
    run('npm', ['install'], minilogoDir);

    console.log('[integration] building minilogo ...');
    run('npm', ['run', 'build'], minilogoDir);

    if (!isBuilt()) {
        throw new Error(`minilogo build did not produce expected server entry: ${serverEntry}`);
    }

    console.log('[integration] minilogo ready.');
}
