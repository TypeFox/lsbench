import * as fs from 'node:fs';
import * as path from 'node:path';
import { supportsMethod } from './capabilities.js';
import {
    type Diagnostic,
    type DiagnosticsPublish,
    type DocumentSyncState,
    type LspHarness,
    type PublishWaitResult,
    pathToUri,
} from './harness.js';
import type {
    BenchContext,
    EditOperation,
    OpenDocumentOptions,
    Position,
    Range,
    Registration,
    RequestError,
    RequestResult,
    RequestTiming,
    ServerCapabilities,
    WaitForDiagnosticsOptions,
    WaitForDiagnosticsResult,
    WaitForIdleOptions,
    WaitForIdleResult,
} from './types.js';

/** JSON-RPC error code a server sends when a document change invalidated the result */
const CONTENT_MODIFIED = -32801;
/** JSON-RPC error code a server sends when it cancelled a request, e.g. a pull it wants retriggered */
const SERVER_CANCELLED = -32802;

/** auto mode: how long a diagnostics wait waits for a push from an unknown server before pulling */
const DEFAULT_PULL_AFTER_MS = 1000;
/** first wait between two pulls, doubling up to PULL_MAX_BACKOFF_MS */
const PULL_BACKOFF_MS = 25;
const PULL_MAX_BACKOFF_MS = 250;

/** A textDocument/diagnostic response, a full or an unchanged report */
interface DocumentDiagnosticReport {
    kind?: 'full' | 'unchanged';
    resultId?: string;
    items?: Diagnostic[];
}

/**
 * How a pulling wait ended: resolved, failed, ran out of time, not sent at all, or (auto
 * mode) stopped because the server was learned to push meanwhile
 */
type PullOutcome = 'ok' | 'error' | 'timeout' | 'skipped' | 'push';

/** The latest pulled report of a document, with unchanged reports resolved */
interface PulledDiagnostics {
    diagnostics: Diagnostic[];
    resultId?: string;
}

export interface BenchContextOptions {
    /** How often a request rejected with ContentModified is retried (default 3) */
    contentModifiedRetries?: number;
    /** Wait before retry n is n times this many milliseconds (default 20) */
    retryBackoffMs?: number;
    /** Skip requests whose provider the server does not advertise, recording them as skipped (default true) */
    skipUnsupported?: boolean;
}

/**
 * Concrete implementation of BenchContext.
 * Each LSP request is timed with high-resolution timers.
 * Accumulated timings are collected after each iteration.
 */
export class BenchContextImpl implements BenchContext {
    readonly workspaceRoot: string;
    private harness: LspHarness;
    private timings: RequestTiming[] = [];
    private openDocuments = new Map<string, { uri: string; version: number; text: string }>();
    private verbose: boolean;
    private contentModifiedRetries: number;
    private retryBackoffMs: number;
    private skipUnsupported: boolean;
    private _lastError: RequestError | undefined;
    /** the latest pulled diagnostics per URI, for previousResultId and unchanged reports */
    private pulled = new Map<string, PulledDiagnostics>();

    constructor(harness: LspHarness, workspaceRoot: string, verbose = false, options: BenchContextOptions = {}) {
        this.harness = harness;
        this.workspaceRoot = workspaceRoot;
        this.verbose = verbose;
        this.contentModifiedRetries = options.contentModifiedRetries ?? 3;
        this.retryBackoffMs = options.retryBackoffMs ?? 20;
        this.skipUnsupported = options.skipUnsupported ?? true;
    }

    get lastError(): RequestError | undefined {
        return this._lastError;
    }

    get capabilities(): Readonly<ServerCapabilities> | null {
        return this.harness.capabilities;
    }

    get registrations(): readonly Registration[] {
        return this.harness.registrations;
    }

    supports(method: string): boolean {
        return supportsMethod(this.harness.capabilities, this.harness.registrations, method);
    }

    /** Drain and return all collected timings, resetting for the next iteration */
    collectTimings(): RequestTiming[] {
        const result = [...this.timings];
        this.timings = [];
        return result;
    }

    /** Reset open document state (e.g. between iterations without restart) */
    async resetDocuments(): Promise<void> {
        for (const [, doc] of this.openDocuments) {
            try {
                this.harness.sendNotification('textDocument/didClose', {
                    textDocument: { uri: doc.uri },
                });
            } catch {
                // ignore
            }
        }
        this.openDocuments.clear();
        this.pulled.clear();
    }

    // ── Document lifecycle ──────────────────────────────────────────────

    async openDocument(relativePath: string, options?: OpenDocumentOptions): Promise<void> {
        const absPath = path.resolve(this.workspaceRoot, relativePath);
        const uri = pathToUri(absPath);

        if (this.openDocuments.has(relativePath)) {
            return; // Already open
        }

        const text = fs.readFileSync(absPath, 'utf-8');
        const languageId = options?.languageId ?? detectLanguageId(absPath);

        const doc = { uri, version: 1, text };
        this.openDocuments.set(relativePath, doc);

        this.harness.sendNotification('textDocument/didOpen', {
            textDocument: {
                uri,
                languageId,
                version: doc.version,
                text,
            },
        });

        this.log(`Opened ${relativePath} (${languageId})`);
    }

    async closeDocument(relativePath: string): Promise<void> {
        const doc = this.openDocuments.get(relativePath);
        if (!doc) {
            return;
        }

        this.harness.sendNotification('textDocument/didClose', {
            textDocument: { uri: doc.uri },
        });

        this.openDocuments.delete(relativePath);
        this.pulled.delete(doc.uri);
        this.log(`Closed ${relativePath}`);
    }

    async saveDocument(relativePath: string): Promise<void> {
        const doc = this.getOpenDocument(relativePath);
        const { didSave, includeText } = this.harness.saveSyncOptions();
        if (!didSave) {
            this.log(`Skipped didSave for ${relativePath}: server did not ask for it`);
            return;
        }

        this.harness.sendNotification('textDocument/didSave', {
            textDocument: { uri: doc.uri },
            ...(includeText ? { text: doc.text } : {}),
        });

        this.log(`Saved ${relativePath}`);
    }

    async willSave(relativePath: string, reason = 1): Promise<void> {
        const doc = this.getOpenDocument(relativePath);
        if (!this.harness.saveSyncOptions().willSave) {
            this.log(`Skipped willSave for ${relativePath}: server did not ask for it`);
            return;
        }

        this.harness.sendNotification('textDocument/willSave', {
            textDocument: { uri: doc.uri },
            reason,
        });
    }

    async willSaveWaitUntil(relativePath: string, reason = 1): Promise<unknown | null> {
        const doc = this.getOpenDocument(relativePath);
        return this.timedRequest('textDocument/willSaveWaitUntil', {
            textDocument: { uri: doc.uri },
            reason,
        });
    }

    // ── Timed LSP requests ──────────────────────────────────────────────

    async hover(relativePath: string, line: number, character: number): Promise<unknown | null> {
        return this.timedRequest('textDocument/hover', {
            textDocument: { uri: this.getUri(relativePath) },
            position: { line, character },
        });
    }

    async completion(relativePath: string, line: number, character: number): Promise<unknown | null> {
        return this.timedRequest('textDocument/completion', {
            textDocument: { uri: this.getUri(relativePath) },
            position: { line, character },
        });
    }

    async definition(relativePath: string, line: number, character: number): Promise<unknown | null> {
        return this.timedRequest('textDocument/definition', {
            textDocument: { uri: this.getUri(relativePath) },
            position: { line, character },
        });
    }

    async references(relativePath: string, line: number, character: number): Promise<unknown | null> {
        return this.timedRequest('textDocument/references', {
            textDocument: { uri: this.getUri(relativePath) },
            position: { line, character },
            context: { includeDeclaration: true },
        });
    }

    async documentSymbol(relativePath: string): Promise<unknown | null> {
        return this.timedRequest('textDocument/documentSymbol', {
            textDocument: { uri: this.getUri(relativePath) },
        });
    }

    async formatting(relativePath: string): Promise<unknown | null> {
        return this.timedRequest('textDocument/formatting', {
            textDocument: { uri: this.getUri(relativePath) },
            options: FORMATTING_OPTIONS,
        });
    }

    async rangeFormatting(relativePath: string, range: Range): Promise<unknown | null> {
        return this.timedRequest('textDocument/rangeFormatting', {
            textDocument: { uri: this.getUri(relativePath) },
            range: toLspRange(range),
            options: FORMATTING_OPTIONS,
        });
    }

    async onTypeFormatting(relativePath: string, line: number, character: number, ch: string): Promise<unknown | null> {
        return this.timedRequest('textDocument/onTypeFormatting', {
            textDocument: { uri: this.getUri(relativePath) },
            position: { line, character },
            ch,
            options: FORMATTING_OPTIONS,
        });
    }

    async rename(relativePath: string, line: number, character: number, newName: string): Promise<unknown | null> {
        return this.timedRequest('textDocument/rename', {
            textDocument: { uri: this.getUri(relativePath) },
            position: { line, character },
            newName,
        });
    }

    async codeAction(
        relativePath: string,
        range: Range,
        diagnosticCodes?: (string | number)[],
    ): Promise<unknown | null> {
        const uri = this.getUri(relativePath);
        const diagnostics = diagnosticCodes ? filterDiagnosticsByCode(this.diagnosticsFor(uri), diagnosticCodes) : [];

        return this.timedRequest('textDocument/codeAction', {
            textDocument: { uri },
            range: toLspRange(range),
            context: { diagnostics },
        });
    }

    async signatureHelp(relativePath: string, line: number, character: number): Promise<unknown | null> {
        return this.timedRequest('textDocument/signatureHelp', {
            textDocument: { uri: this.getUri(relativePath) },
            position: { line, character },
        });
    }

    async typeDefinition(relativePath: string, line: number, character: number): Promise<unknown | null> {
        return this.timedRequest('textDocument/typeDefinition', {
            textDocument: { uri: this.getUri(relativePath) },
            position: { line, character },
        });
    }

    async implementation(relativePath: string, line: number, character: number): Promise<unknown | null> {
        return this.timedRequest('textDocument/implementation', {
            textDocument: { uri: this.getUri(relativePath) },
            position: { line, character },
        });
    }

    async declaration(relativePath: string, line: number, character: number): Promise<unknown | null> {
        return this.timedRequest('textDocument/declaration', {
            textDocument: { uri: this.getUri(relativePath) },
            position: { line, character },
        });
    }

    async documentHighlight(relativePath: string, line: number, character: number): Promise<unknown | null> {
        return this.timedRequest('textDocument/documentHighlight', {
            textDocument: { uri: this.getUri(relativePath) },
            position: { line, character },
        });
    }

    async prepareRename(relativePath: string, line: number, character: number): Promise<unknown | null> {
        return this.timedRequest('textDocument/prepareRename', {
            textDocument: { uri: this.getUri(relativePath) },
            position: { line, character },
        });
    }

    async foldingRange(relativePath: string): Promise<unknown | null> {
        return this.timedRequest('textDocument/foldingRange', {
            textDocument: { uri: this.getUri(relativePath) },
        });
    }

    async selectionRange(relativePath: string, positions: Position[]): Promise<unknown | null> {
        return this.timedRequest('textDocument/selectionRange', {
            textDocument: { uri: this.getUri(relativePath) },
            positions: positions.map((p) => ({ line: p.line, character: p.character })),
        });
    }

    async documentLink(relativePath: string): Promise<unknown | null> {
        return this.timedRequest('textDocument/documentLink', {
            textDocument: { uri: this.getUri(relativePath) },
        });
    }

    async codeLens(relativePath: string): Promise<unknown | null> {
        return this.timedRequest('textDocument/codeLens', {
            textDocument: { uri: this.getUri(relativePath) },
        });
    }

    async inlayHint(relativePath: string, range: Range): Promise<unknown | null> {
        return this.timedRequest('textDocument/inlayHint', {
            textDocument: { uri: this.getUri(relativePath) },
            range: toLspRange(range),
        });
    }

    async semanticTokensFull(relativePath: string): Promise<unknown | null> {
        return this.timedRequest('textDocument/semanticTokens/full', {
            textDocument: { uri: this.getUri(relativePath) },
        });
    }

    async semanticTokensRange(relativePath: string, range: Range): Promise<unknown | null> {
        return this.timedRequest('textDocument/semanticTokens/range', {
            textDocument: { uri: this.getUri(relativePath) },
            range: toLspRange(range),
        });
    }

    async semanticTokensDelta(relativePath: string, previousResultId: string): Promise<unknown | null> {
        return this.timedRequest('textDocument/semanticTokens/full/delta', {
            textDocument: { uri: this.getUri(relativePath) },
            previousResultId,
        });
    }

    async workspaceSymbol(query: string): Promise<unknown | null> {
        return this.timedRequest('workspace/symbol', { query });
    }

    async prepareCallHierarchy(relativePath: string, line: number, character: number): Promise<unknown | null> {
        return this.timedRequest('textDocument/prepareCallHierarchy', {
            textDocument: { uri: this.getUri(relativePath) },
            position: { line, character },
        });
    }

    async callHierarchyIncomingCalls(item: unknown): Promise<unknown | null> {
        return this.timedRequest('callHierarchy/incomingCalls', { item });
    }

    async callHierarchyOutgoingCalls(item: unknown): Promise<unknown | null> {
        return this.timedRequest('callHierarchy/outgoingCalls', { item });
    }

    async prepareTypeHierarchy(relativePath: string, line: number, character: number): Promise<unknown | null> {
        return this.timedRequest('textDocument/prepareTypeHierarchy', {
            textDocument: { uri: this.getUri(relativePath) },
            position: { line, character },
        });
    }

    async typeHierarchySupertypes(item: unknown): Promise<unknown | null> {
        return this.timedRequest('typeHierarchy/supertypes', { item });
    }

    async typeHierarchySubtypes(item: unknown): Promise<unknown | null> {
        return this.timedRequest('typeHierarchy/subtypes', { item });
    }

    async documentDiagnostic(relativePath: string, previousResultId?: string): Promise<unknown | null> {
        return this.timedRequest('textDocument/diagnostic', {
            textDocument: { uri: this.getUri(relativePath) },
            ...(previousResultId !== undefined ? { previousResultId } : {}),
        });
    }

    async workspaceDiagnostic(previousResultIds: { uri: string; value: string }[] = []): Promise<unknown | null> {
        return this.timedRequest('workspace/diagnostic', { previousResultIds });
    }

    // resolve requests send the raw item from a prior request as the params, unwrapped
    async completionItemResolve(item: unknown): Promise<unknown | null> {
        return this.timedRequest('completionItem/resolve', item);
    }

    async codeLensResolve(codeLens: unknown): Promise<unknown | null> {
        return this.timedRequest('codeLens/resolve', codeLens);
    }

    async inlayHintResolve(hint: unknown): Promise<unknown | null> {
        return this.timedRequest('inlayHint/resolve', hint);
    }

    async codeActionResolve(action: unknown): Promise<unknown | null> {
        return this.timedRequest('codeAction/resolve', action);
    }

    async documentLinkResolve(link: unknown): Promise<unknown | null> {
        return this.timedRequest('documentLink/resolve', link);
    }

    async workspaceSymbolResolve(symbol: unknown): Promise<unknown | null> {
        return this.timedRequest('workspaceSymbol/resolve', symbol);
    }

    // ── Document mutations ──────────────────────────────────────────────

    async edit(relativePath: string, edits: EditOperation | EditOperation[]): Promise<void> {
        const doc = this.getOpenDocument(relativePath);

        const editArray = Array.isArray(edits) ? edits : [edits];
        doc.version++;

        const contentChanges: { range: unknown; text: string }[] = editArray.map((e) => ({
            range: toLspRange(e.range),
            text: e.text,
        }));

        // mirror the change locally, each edit applies to the result of the previous one
        for (const e of editArray) {
            doc.text = applyEdit(doc.text, e);
        }

        this.harness.sendNotification('textDocument/didChange', {
            textDocument: { uri: doc.uri, version: doc.version },
            contentChanges,
        });
    }

    // ── Synchronization helpers ─────────────────────────────────────────

    /**
     * Wait for diagnostics matching the current state of the document. An open document
     * resolves at once when such a publish is already cached; a document that is not open
     * waits for the next publish. `until` skips current publishes failing it, and
     * `settleMs` keeps waiting after the resolving publish until no current publish arrived
     * for that long, resolving with the latest. On timeout the latest current publish (or
     * the cached diagnostics) is returned with `timedOut` set, unless `until` was already
     * satisfied. Each wait records a timing labeled by what the latest sync was:
     * `diagnostics/open` or `diagnostics/edit`, timed from that didOpen or didChange to the
     * resolving publish (the latest one after settling, without the quiet period), or
     * `diagnostics/wait`, timed from the call, for a document that is not open.
     *
     * In `pull` mode diagnostics are pulled instead, see pullDiagnostics. In `auto` mode a
     * server that advertises diagnosticProvider is handled by what the harness learned of it:
     * a server seen pushing is waited on for pushes, a pull only one is pulled at once, and
     * an unknown one is waited on for a push up to `pullAfterMs` (half the timeout when that
     * is not shorter), then pulled. A pull resolving without any push in the meantime marks
     * the server pull only, but only tentatively when it returned no diagnostics: a server
     * still loading may answer with an empty placeholder and push later, so such pulls are
     * marked `tentative` until a pull returns diagnostics. A publish teaching push while a
     * pull is in flight switches the wait to waiting for pushes for the rest of its timeout
     */
    async waitForDiagnostics(
        relativePath: string,
        options: WaitForDiagnosticsOptions | number = {},
    ): Promise<WaitForDiagnosticsResult> {
        const {
            timeout = 30000,
            until,
            settleMs,
            mode = 'auto',
            pullAfterMs = DEFAULT_PULL_AFTER_MS,
        } = typeof options === 'number' ? { timeout: options } : options;
        const uri = this.getUri(relativePath);
        const calledAt = process.hrtime.bigint();
        if (mode === 'pull') {
            return (await this.pullDiagnostics(relativePath, uri, timeout, until)).result;
        }

        // auto mode pulls only from a server that advertises diagnosticProvider, depending on
        // what the harness learned about it: never once it pushed, at once when it only answers
        // pulls, and after a grace period without any publish while unknown. When the server is
        // learned to push while a pull is in flight, the wait goes on waiting for pushes
        const auto = mode === 'auto' && this.harness.capabilities !== null && this.supports('textDocument/diagnostic');
        const remainingMs = () => Math.max(0, timeout - Number(process.hrtime.bigint() - calledAt) / 1_000_000);
        let pullReason: string | undefined;
        let wait: PublishWaitResult;
        for (;;) {
            const delivery = auto ? this.harness.diagnosticsDelivery() : 'push';
            if (pullReason === undefined && delivery === 'pull') {
                pullReason = `a pull for ${relativePath}`;
            }
            if (pullReason !== undefined && delivery !== 'push') {
                const pulled = await this.pullDiagnostics(relativePath, uri, remainingMs(), until, pullReason);
                if (pulled.outcome !== 'push') {
                    return pulled.result;
                }
                pullReason = undefined;
                continue;
            }
            const abort = new AbortController();
            let graceTimer: NodeJS.Timeout | undefined;
            let graceMs = 0;
            if (delivery === 'unknown') {
                graceMs = timeout <= pullAfterMs ? timeout / 2 : pullAfterMs;
                graceTimer = setTimeout(
                    () => {
                        if (this.harness.diagnosticsDelivery() === 'unknown') {
                            abort.abort();
                        }
                    },
                    Math.min(graceMs, remainingMs()),
                );
            }
            const after = this.harness.currentPublishSeq();
            wait = await this.harness.waitForPublishes(
                uri,
                (p) => {
                    const doc = this.harness.documentState(uri);
                    return doc?.open ? isCurrentPublish(p, doc) : p.seq > after;
                },
                {
                    timeoutMs: remainingMs(),
                    signal: abort.signal,
                    ...(until ? { until: (p: DiagnosticsPublish) => until(p.diagnostics) } : {}),
                    ...(settleMs !== undefined ? { settleMs } : {}),
                },
            );
            clearTimeout(graceTimer);
            if (!wait.aborted) {
                break;
            }
            this.log(`No publish from the server within ${graceMs}ms, pulling diagnostics for ${relativePath}`);
            pullReason = `a pull for ${relativePath} resolved after ${graceMs}ms without a push`;
        }
        const { publish, publishes, timedOut } = wait;

        // only the timer firing means a timeout, elapsed time is never compared to it
        const endedAt = publish && !timedOut ? publish.receivedAt : process.hrtime.bigint();
        const diagnostics = publish?.diagnostics ?? this.harness.getDiagnostics(uri);

        // the document state at resolution is what the accepted publish matched
        const doc = this.harness.documentState(uri);
        let method = 'diagnostics/wait';
        let startedAt = calledAt;
        if (doc?.open && doc.syncedBy !== undefined) {
            method = doc.syncedBy === 'didOpen' ? 'diagnostics/open' : 'diagnostics/edit';
            startedAt = doc.syncedAt;
        }
        const ms = Math.max(0, Number(endedAt - startedAt) / 1_000_000); // nanoseconds → milliseconds

        const timing: RequestTiming = {
            method,
            duration_ms: Math.round(ms * 1000) / 1000, // 3 decimal places
            success: !timedOut,
            result: timedOut ? 'timeout' : classifyResult(diagnostics),
            diagnostics: diagnostics.length,
        };
        this.timings.push(timing);
        this.log(
            `${method} ${relativePath}: ${ms.toFixed(1)}ms ${timing.result}, ` +
                `${diagnostics.length} diagnostics, ${publishes} publishes`,
        );
        if (timedOut && publishes === 0 && method === 'diagnostics/open' && doc && doc.closePublishes > 0) {
            const seen = doc.closePublishes === 1 ? 'the publish' : `the ${doc.closePublishes} publishes`;
            this.log(
                `The reopen of ${relativePath} saw only ${seen} clearing its close: the server may not ` +
                    'republish a clean file on reopen, use `until` or a short timeout for this wait',
            );
        }

        return { diagnostics, timedOut, publishes, source: 'push', pulls: 0, ms: timing.duration_ms };
    }

    /**
     * Pull diagnostics through textDocument/diagnostic until a report passes `until` (any
     * report without it) or `timeoutMs` ran out, re-pulling with a growing backoff. An
     * `unchanged` report reuses the diagnostics of the previous report, whose resultId is
     * sent as previousResultId. ContentModified and ServerCancelled rejections are retried
     * like a failing `until`, other rejections end the wait as an error. The timing is
     * labeled `diagnostics/pull/open`, `diagnostics/pull/edit` or `diagnostics/pull/wait`
     * and runs from the first request to the resolving response, since a pull has no server
     * debounce and is not comparable with time to a push.
     *
     * An auto mode pull passes `learnReason`: a resolving pull teaches the harness the server
     * is pull only, tentatively when it returned no diagnostics, and the timing is marked
     * tentative while that is not settled. A publish teaching push during the pull stops it
     * with outcome `push` and records nothing, the caller then waits for pushes
     */
    private async pullDiagnostics(
        relativePath: string,
        uri: string,
        timeoutMs: number,
        until: ((diagnostics: Diagnostic[]) => boolean) | undefined,
        learnReason?: string,
    ): Promise<{ result: WaitForDiagnosticsResult; outcome: PullOutcome }> {
        this._lastError = undefined;
        if (this.skipUnsupported && !this.supports('textDocument/diagnostic')) {
            const method = pullTimingMethod(this.harness.documentState(uri));
            this.timings.push({ method, duration_ms: 0, success: false, result: 'skipped' });
            this.log(`${method} ${relativePath}: skipped, the server does not advertise diagnosticProvider`);
            const diagnostics = this.diagnosticsFor(uri);
            return {
                result: { diagnostics, timedOut: false, publishes: 0, source: 'pull', pulls: 0, ms: 0 },
                outcome: 'skipped',
            };
        }

        const startedAt = process.hrtime.bigint();
        const deadline = startedAt + BigInt(Math.round(timeoutMs * 1_000_000));
        const remainingMs = () => Number(deadline - process.hrtime.bigint()) / 1_000_000;
        let pulls = 0;
        let diagnostics: Diagnostic[] | undefined;
        let failure: RequestError | undefined;
        let outcome: Exclude<PullOutcome, 'skipped'> = 'timeout';
        let endedAt: bigint | undefined;
        let backoffMs = PULL_BACKOFF_MS;
        // in auto mode, a publish teaching push cuts the pending request or backoff short
        let pushed = false;
        let onPushed = () => {};
        const pushedSignal = new Promise<null>((resolve) => {
            onPushed = () => resolve(null);
        });
        const unsubscribe =
            learnReason === undefined
                ? () => {}
                : this.harness.onDiagnosticsDeliveryChange((delivery) => {
                      if (delivery === 'push') {
                          pushed = true;
                          onPushed();
                      }
                  });
        while (remainingMs() > 0) {
            const previous = this.pulled.get(uri);
            pulls++;
            const request = this.harness.sendRequest<DocumentDiagnosticReport | null>('textDocument/diagnostic', {
                textDocument: { uri },
                ...(previous?.resultId !== undefined ? { previousResultId: previous.resultId } : {}),
            });
            const response = await raceDeadline(Promise.race([request, pushedSignal]), remainingMs());
            if (pushed) {
                outcome = 'push';
                break;
            }
            if (!response) {
                break;
            }
            endedAt = process.hrtime.bigint();
            if ('error' in response) {
                failure = toRequestError('textDocument/diagnostic', response.error);
                if (failure.code !== CONTENT_MODIFIED && failure.code !== SERVER_CANCELLED) {
                    outcome = 'error';
                    break;
                }
                this.log(`textDocument/diagnostic ${relativePath}: ${failure.message}, pulling again`);
            } else {
                failure = undefined;
                diagnostics = this.storePulled(uri, response.value, previous);
                if (!until || until(diagnostics)) {
                    outcome = 'ok';
                    break;
                }
            }
            await Promise.race([this.sleep(Math.max(0, Math.min(backoffMs, remainingMs()))), pushedSignal]);
            if (pushed) {
                outcome = 'push';
                break;
            }
            backoffMs = Math.min(backoffMs * 2, PULL_MAX_BACKOFF_MS);
        }
        unsubscribe();
        if (outcome === 'push') {
            this.log(
                `Server pushed diagnostics while pulling them for ${relativePath} (${pulls} pulls), ` +
                    'waiting for pushes instead',
            );
            const diagnostics = this.harness.getDiagnostics(uri);
            return {
                result: { diagnostics, timedOut: false, publishes: 0, source: 'pull', pulls, ms: 0 },
                outcome,
            };
        }

        const timedOut = outcome === 'timeout';
        if (timedOut || endedAt === undefined) {
            endedAt = process.hrtime.bigint();
        }
        const result = diagnostics ?? this.diagnosticsFor(uri);
        // an empty answer may be the placeholder of a server still loading, it does not settle pull
        let tentative = false;
        if (learnReason !== undefined && outcome === 'ok') {
            this.harness.markPullOnly(learnReason, result.length === 0);
            tentative = this.harness.diagnosticsDelivery() !== 'pull' || this.harness.diagnosticsDeliveryTentative();
        }
        const method = pullTimingMethod(this.harness.documentState(uri));
        const ms = Number(endedAt - startedAt) / 1_000_000; // nanoseconds → milliseconds
        const timing: RequestTiming = {
            method,
            duration_ms: Math.round(ms * 1000) / 1000, // 3 decimal places
            success: outcome === 'ok',
            result: outcome === 'ok' ? classifyResult(result) : outcome,
            diagnostics: result.length,
        };
        if (tentative) {
            timing.tentative = true;
        }
        if (failure) {
            timing.error = failure.message;
            this._lastError = failure;
        }
        this.timings.push(timing);
        this.log(
            `${method} ${relativePath}: ${ms.toFixed(1)}ms ${timing.result}` +
                `${tentative ? ' (tentative, the server may still push)' : ''}, ` +
                `${result.length} diagnostics, ${pulls} pulls${failure ? ` ERROR: ${failure.message}` : ''}`,
        );

        return {
            result: {
                diagnostics: result,
                timedOut,
                publishes: 0,
                source: 'pull',
                pulls,
                ms: timing.duration_ms,
                ...(tentative ? { tentative: true as const } : {}),
            },
            outcome,
        };
    }

    /** Remember a pulled report, resolving an `unchanged` one to the diagnostics of the previous */
    private storePulled(
        uri: string,
        report: DocumentDiagnosticReport | null,
        previous: PulledDiagnostics | undefined,
    ): Diagnostic[] {
        let diagnostics: Diagnostic[];
        if (report?.kind === 'unchanged') {
            diagnostics = previous?.diagnostics ?? [];
        } else {
            diagnostics = Array.isArray(report?.items) ? report.items : [];
        }
        const resultId = typeof report?.resultId === 'string' ? report.resultId : undefined;
        this.pulled.set(uri, { diagnostics, ...(resultId !== undefined ? { resultId } : {}) });
        return diagnostics;
    }

    /** The pushed diagnostics of a document, or the pulled ones when the server never published for it */
    private diagnosticsFor(uri: string): Diagnostic[] {
        const pulled = this.pulled.get(uri);
        if (pulled && !this.harness.latestPublish(uri)) {
            return pulled.diagnostics;
        }
        return this.harness.getDiagnostics(uri);
    }

    async waitForIdle(options: WaitForIdleOptions | number = {}): Promise<WaitForIdleResult> {
        const { timeout = 30000, quietMs } = typeof options === 'number' ? { timeout: options } : options;
        const result = await this.harness.waitForIdle({
            timeoutMs: timeout,
            ...(quietMs !== undefined ? { quietMs } : {}),
        });
        const timing: RequestTiming = {
            method: 'server/idle',
            duration_ms: Math.round(result.ms * 1000) / 1000, // 3 decimal places
            success: !result.timedOut,
            result: result.timedOut ? 'timeout' : 'ok',
        };
        this.timings.push(timing);
        this.log(`server/idle: ${result.ms.toFixed(1)}ms ${timing.result}`);
        return { ...result, ms: timing.duration_ms };
    }

    async sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    // ── Custom timing ───────────────────────────────────────────────────

    async request<R>(method: string, params: unknown, label?: string): Promise<R> {
        return this.timedRequest<R>(method, params, label);
    }

    notify(method: string, params: unknown): void {
        this.harness.sendNotification(method, params);
    }

    // ── Internal helpers ────────────────────────────────────────────────

    private getOpenDocument(relativePath: string): { uri: string; version: number; text: string } {
        const doc = this.openDocuments.get(relativePath);
        if (!doc) {
            throw new Error(`Document ${relativePath} is not open. Call openDocument() first.`);
        }
        return doc;
    }

    private getUri(relativePath: string): string {
        const doc = this.openDocuments.get(relativePath);
        if (doc) {
            return doc.uri;
        }
        // If not opened yet, compute the URI anyway
        return pathToUri(path.resolve(this.workspaceRoot, relativePath));
    }

    /**
     * Send a request and record its timing and result. A ContentModified rejection is retried
     * after a short backoff, and only the final attempt is timed, since the earlier ones and
     * the backoff measure the edit race rather than the request itself. A request whose
     * provider the server does not advertise is not sent but recorded as skipped
     */
    private async timedRequest<R>(method: string, params: unknown, label?: string): Promise<R> {
        this._lastError = undefined;
        if (this.skipUnsupported && !this.supports(method)) {
            this.timings.push({ method, label, duration_ms: 0, success: false, result: 'skipped' });
            this.log(`${method}${label ? ` [${label}]` : ''}: skipped, the server does not advertise it`);
            return null as R;
        }
        let retries = 0;
        for (;;) {
            const start = process.hrtime.bigint();
            let result: R;
            let failure: RequestError | undefined;
            try {
                result = await this.harness.sendRequest<R>(method, params);
            } catch (err: unknown) {
                failure = toRequestError(method, err);
                result = null as R;
            }
            const duration_ms = Number(process.hrtime.bigint() - start) / 1_000_000; // nanoseconds → milliseconds

            if (failure?.code === CONTENT_MODIFIED && retries < this.contentModifiedRetries) {
                retries++;
                this.log(`${method}: content modified, retry ${retries} of ${this.contentModifiedRetries}`);
                await this.sleep(this.retryBackoffMs * retries);
                continue;
            }

            const timing: RequestTiming = {
                method,
                label,
                duration_ms: Math.round(duration_ms * 1000) / 1000, // 3 decimal places
                success: failure === undefined,
                result: failure ? 'error' : classifyResult(result),
                error: failure?.message,
            };
            if (retries > 0) {
                timing.retries = retries;
            }
            this.timings.push(timing);
            this._lastError = failure;

            this.log(
                `${method}${label ? ` [${label}]` : ''}: ${duration_ms.toFixed(1)}ms ${timing.result}` +
                    `${failure ? ` ERROR: ${failure.message}` : ''}`,
            );

            return result;
        }
    }

    private log(msg: string): void {
        if (this.verbose) {
            console.error(`[lsbench:ctx] ${msg}`);
        }
    }
}

// ── Utilities ─────────────────────────────────────────────────────────────

/** The timing label of a pull, by what the latest sync of the document was */
function pullTimingMethod(doc: DocumentSyncState | undefined): string {
    if (doc?.open && doc.syncedBy !== undefined) {
        return doc.syncedBy === 'didOpen' ? 'diagnostics/pull/open' : 'diagnostics/pull/edit';
    }
    return 'diagnostics/pull/wait';
}

/** Settle a promise against a deadline, undefined when the deadline passed first */
async function raceDeadline<T>(
    promise: Promise<T>,
    ms: number,
): Promise<{ value: T } | { error: unknown } | undefined> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), Math.max(0, ms));
    });
    try {
        return await Promise.race([
            promise.then(
                (value) => ({ value }),
                (error: unknown) => ({ error }),
            ),
            deadline,
        ]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Whether a publish describes the current state of an open document: it must belong to the
 * current open generation, and carry the current version. A publish without a version only
 * counts when it arrived after the latest didOpen or didChange. Versions newer than the
 * current one cannot belong to this generation, so they are treated as stale too
 */
export function isCurrentPublish(publish: DiagnosticsPublish, doc: DocumentSyncState): boolean {
    if (!doc.open || publish.generation !== doc.generation) {
        return false;
    }
    if (publish.version !== undefined && doc.version !== undefined) {
        return publish.version === doc.version;
    }
    return publish.seq > doc.syncSeq;
}

/** Turn a rejection into a RequestError, keeping the JSON-RPC code of a ResponseError */
function toRequestError(method: string, err: unknown): RequestError {
    const failure: RequestError = { method, message: err instanceof Error ? err.message : String(err) };
    if (typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'number') {
        failure.code = err.code;
    }
    return failure;
}

/**
 * Classify a request result. Besides plain empty arrays, list wrappers count as empty when
 * their list is: CompletionList and diagnostic reports (`items`), SemanticTokens (`data`)
 * and SemanticTokensDelta (`edits`). Since `data` is also the opaque payload of resolvable
 * items, `data` and `edits` only count on objects with no keys besides `resultId`
 */
export function classifyResult(result: unknown): Exclude<RequestResult, 'error' | 'skipped' | 'timeout'> {
    if (result === null || result === undefined) {
        return 'null';
    }
    if (Array.isArray(result)) {
        return result.length === 0 ? 'empty' : 'ok';
    }
    if (typeof result !== 'object') {
        return 'ok';
    }
    const record = result as Record<string, unknown>;
    if (Array.isArray(record.items)) {
        return record.items.length === 0 ? 'empty' : 'ok';
    }
    for (const key of ['data', 'edits']) {
        const list = record[key];
        if (Array.isArray(list) && Object.keys(record).every((k) => k === key || k === 'resultId')) {
            return list.length === 0 ? 'empty' : 'ok';
        }
    }
    return 'ok';
}

/** formatting options shared by all formatting requests */
const FORMATTING_OPTIONS = { tabSize: 2, insertSpaces: true };

function toLspRange(range: Range): {
    start: { line: number; character: number };
    end: { line: number; character: number };
} {
    return {
        start: { line: range.start.line, character: range.start.character },
        end: { line: range.end.line, character: range.end.character },
    };
}

/** Replace the text covered by `edit.range` with `edit.text` */
function applyEdit(text: string, edit: EditOperation): string {
    const lineStarts = computeLineStarts(text);
    let start = positionToOffset(text, lineStarts, edit.range.start);
    let end = positionToOffset(text, lineStarts, edit.range.end);
    if (start > end) {
        [start, end] = [end, start];
    }
    return text.slice(0, start) + edit.text + text.slice(end);
}

/** Offsets at which each line begins, treating \n, \r\n and \r as line breaks like LSP does */
function computeLineStarts(text: string): number[] {
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
        const ch = text.charCodeAt(i);
        if (ch === 13 /* \r */) {
            if (text.charCodeAt(i + 1) === 10 /* \n */) {
                i++;
            }
            starts.push(i + 1);
        } else if (ch === 10 /* \n */) {
            starts.push(i + 1);
        }
    }
    return starts;
}

/**
 * Convert an LSP position to a string offset. Characters are UTF-16 code units, which is
 * what JS string indices count. Out of range positions are clamped as the LSP spec requires:
 * a character past the line end maps to the line end, a line past the last maps to the end.
 */
function positionToOffset(text: string, lineStarts: number[], pos: Position): number {
    if (pos.line < 0) {
        return 0;
    }
    if (pos.line >= lineStarts.length) {
        return text.length;
    }
    const lineStart = lineStarts[pos.line];
    let lineEnd = pos.line + 1 < lineStarts.length ? lineStarts[pos.line + 1] : text.length;
    // exclude the line break itself, so a position can never land inside \r\n
    if (lineEnd > lineStart && text.charCodeAt(lineEnd - 1) === 10) {
        lineEnd--;
    }
    if (lineEnd > lineStart && text.charCodeAt(lineEnd - 1) === 13) {
        lineEnd--;
    }
    return Math.min(lineStart + Math.max(pos.character, 0), lineEnd);
}

/**
 * Keeps diagnostics whose `code` is in `codes`, falling back to `data.code`
 * for servers (such as Langium) that carry their issue code in the opaque `data` payload.
 */
function filterDiagnosticsByCode(diagnostics: Diagnostic[], codes: (string | number)[]): Diagnostic[] {
    const matched: Diagnostic[] = [];
    for (const d of diagnostics) {
        if (d.code !== undefined && codes.includes(d.code)) {
            matched.push(d);
            continue;
        }
        const data = d.data;
        if (typeof data === 'object' && data !== null && 'code' in data) {
            const dataCode = (data as { code: unknown }).code;
            if ((typeof dataCode === 'string' || typeof dataCode === 'number') && codes.includes(dataCode)) {
                matched.push(d);
            }
        }
    }
    return matched;
}

/**
 * Mapping of extensions -> language ids
 */
const RegisteredLanguages: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'typescriptreact',
    '.mts': 'typescript',
    '.cts': 'typescript',
    '.js': 'javascript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.jsx': 'javascriptreact',
    '.json': 'json',
    '.jsonc': 'jsonc',
    '.html': 'html',
    '.css': 'css',
    '.scss': 'scss',
    '.less': 'less',
    '.vue': 'vue',
    '.svelte': 'svelte',
    '.py': 'python',
    '.rs': 'rust',
    '.go': 'go',
    '.java': 'java',
    '.c': 'c',
    '.cpp': 'cpp',
    '.h': 'c',
    '.hpp': 'cpp',
    '.cs': 'csharp',
    '.rb': 'ruby',
    '.php': 'php',
    '.swift': 'swift',
    '.kt': 'kotlin',
    '.md': 'markdown',
    '.yaml': 'yaml',
    '.yml': 'yaml',
    '.toml': 'toml',
    '.xml': 'xml',
    '.sql': 'sql',
    '.sh': 'shellscript',
    '.bash': 'shellscript',
    '.zsh': 'shellscript',
    '.lua': 'lua',
    '.zig': 'zig',
    '.ex': 'elixir',
    '.exs': 'elixir',
    '.ipl': 'ipl',
    '.ipld': 'ipl',
    '.langium': 'langium',
};

/**
 * Adds a new registered language via a new extension -> name mapping
 * @param languageId To be picked up by the correct language server
 * @param extension That should correlate with the given id (ex. `.ts`, or `.c`, or `.langium`)
 */
export function addRegisteredLanguage(languageId: string, extension: string) {
    // normalize to match detectLanguageId, which looks up lowercased extensions
    extension = extension.trim().toLowerCase();
    if (!extension.startsWith('.')) {
        extension = '.' + extension;
    }
    RegisteredLanguages[extension] = languageId;
}

/**
 * Will attempt to resolve the language id via the extension of the given file path.
 * Will default to 'plaintext' if the language id is unrecognized.
 * In such cases, `addRegisteredLanguage` should be invoked before opening any document.
 * @param filePath To extract extension from (expecting at least `abc.xyz`), no extension-less files here
 * @returns Associated language ID, or 'plaintext'
 */
function detectLanguageId(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    return RegisteredLanguages[ext] ?? 'plaintext';
}
