import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as rpc from 'vscode-jsonrpc/node';
import type { Registration, RequestTiming, ServerCapabilities, ServerConfig } from './types.js';

/** Minimal types we need from LSP (avoids cross-package type conflicts) */
interface InitializeResult {
    capabilities: ServerCapabilities;
}

interface PublishDiagnosticsParams {
    uri: string;
    version?: number;
    diagnostics: Diagnostic[];
}

export interface Diagnostic {
    range: unknown;
    message: string;
    severity?: number;
    code?: string | number;
    source?: string;
    [key: string]: unknown;
}

/** Which save related notifications the server wants, from static and dynamic registration */
export interface SaveSyncOptions {
    /** server wants textDocument/didSave */
    didSave: boolean;
    /** didSave should carry the full document text */
    includeText: boolean;
    /** server wants textDocument/willSave */
    willSave: boolean;
    /** server wants textDocument/willSaveWaitUntil */
    willSaveWaitUntil: boolean;
}

/**
 * How long after a didClose the first empty, unversioned publish following a reopen may
 * still be the server clearing the closed document (a later patch may expose this)
 */
export const CLOSE_PUBLISH_WINDOW_MS = 1000;

/**
 * What a tracker has learned about its server: `publishes` when it clears closed documents
 * with a publish, `silent` when it does not, `unknown` until either was observed
 */
export type ClosePublishBehavior = 'unknown' | 'publishes' | 'silent';

/**
 * How a tracker has learned its server delivers diagnostics: `push` once a publish for an
 * opened document arrived, `pull` once an auto mode pull resolved without a push in the
 * meantime, `unknown` until either happened. A pull that resolved empty only learns `pull`
 * tentatively (see DiagnosticsTracker.deliveryTentative), since a server still loading may
 * answer pulls with an empty placeholder and push later. A publish always flips it to `push`
 */
export type DiagnosticsDelivery = 'unknown' | 'push' | 'pull';

/** A textDocument/publishDiagnostics notification as received, stamped with the document state */
export interface DiagnosticsPublish {
    uri: string;
    diagnostics: Diagnostic[];
    /** the document version the server computed these for, when it sent one */
    version?: number;
    /** process.hrtime.bigint() at receipt */
    receivedAt: bigint;
    /** open generation the publish belongs to, normally the generation current at receipt */
    generation: number;
    /** position in the order of sync notifications and publishes for all documents */
    seq: number;
}

/**
 * How the tracker classified a publish on receipt: `current` for the open document state,
 * `stale` for an older version or a publish credited to the closed generation, `closed` while
 * the document is closed, `close candidate` when held as the possible clearing publish of a
 * close, `unopened` for a document never opened
 */
export type PublishStatus = 'current' | 'stale' | 'closed' | 'close candidate' | 'unopened';

/** Options of DiagnosticsTracker.waitForPublishes */
export interface PublishWaitOptions {
    /** give up after this many milliseconds */
    timeoutMs: number;
    /** the first accepted publish passing this resolves the wait (or starts the quiet period) */
    until?: (publish: DiagnosticsPublish) => boolean;
    /** after the resolving publish, wait until no accepted publish arrived for this long */
    settleMs?: number;
    /** aborting ends the wait at once, resolving with what it saw so far and `aborted` set */
    signal?: AbortSignal;
}

/** What DiagnosticsTracker.waitForPublishes resolved with */
export interface PublishWaitResult {
    /** the latest accepted publish, also on timeout, undefined when none arrived */
    publish?: DiagnosticsPublish;
    /** how many accepted publishes the wait saw, the cached one included */
    publishes: number;
    /** the timeout fired before an accepted publish passed `until` */
    timedOut: boolean;
    /** the wait was ended through `signal`, `timedOut` is then false */
    aborted?: boolean;
}

/** What the client last told the server about a document */
export interface DocumentSyncState {
    /** bumps on each didOpen, 0 before the first */
    generation: number;
    open: boolean;
    /** version from the latest didOpen or didChange */
    version?: number;
    /** process.hrtime.bigint() of the latest didOpen or didChange */
    syncedAt: bigint;
    /** seq of the latest didOpen or didChange, comparable with DiagnosticsPublish.seq */
    syncSeq: number;
    /** which notification last synced the document, undefined before the first */
    syncedBy?: 'didOpen' | 'didChange';
    /**
     * publishes for the closed generation since the latest didClose: received while the
     * document was closed, or after the reopen and credited to the close. 0 before a close
     */
    closePublishes: number;
}

interface TrackedDocument extends DocumentSyncState {
    /** time of the latest didClose, until its close window ends */
    closedAt?: bigint;
    /** ends the close window */
    closeTimer?: NodeJS.Timeout;
    /** whether any publish arrived since the latest didClose */
    publishedSinceClose?: boolean;
    /** a publish after the reopen that may still be the clearing publish of the close */
    candidate?: DiagnosticsPublish;
}

/**
 * Tracks document sync notifications and diagnostics publishes per URI, so waits can tell
 * a publish for the current document state from a stale one. Publishes received while a
 * document is closed keep the closed generation and never match a later open.
 *
 * Many servers clear a closed document with an empty, unversioned publish, which can land
 * after a quick reopen and look like the publish for the new generation. Until the tracker
 * knows how its server behaves, the first such publish within the close window is held as
 * a tentative candidate: a further publish before the window ends supersedes it, otherwise
 * it is accepted with its own receipt time when the window ends. What happens teaches the
 * tracker whether the server publishes on close, and only then is the candidate dropped
 * right away (`publishes`) or the rule turned off (`silent`). Some servers clear a closed
 * document more than once, so once the server is known to publish on close, a further
 * empty, unversioned publish within the window is credited to the close too when the server
 * versions its other publishes, and held as a candidate otherwise. It also learns whether the
 * server pushes diagnostics at all, see `delivery`. One tracker serves one server process,
 * `clear()` forgets what it learned.
 *
 * URIs are matched after decoding percent-encoding, so a server publishing
 * `file:///a%20b.ts` matches the document opened as `file:///a b.ts`. On platforms whose
 * file systems are usually case-insensitive (darwin, win32) they are also compared
 * case-insensitively, as some servers lowercase the URIs they publish. Elsewhere a publish
 * for an unopened URI that matches an open document apart from case is logged as a hint.
 */
export class DiagnosticsTracker {
    private documents = new Map<string, TrackedDocument>();
    private latest = new Map<string, DiagnosticsPublish>();
    private listeners = new Map<string, Set<(publish: DiagnosticsPublish) => void>>();
    private seq = 0;
    private _closeBehavior: ClosePublishBehavior = 'unknown';
    private _delivery: DiagnosticsDelivery = 'unknown';
    private _deliveryTentative = false;
    /** whether the server sent a version with a publish for an opened document */
    private versionsPublishes = false;
    private deliveryListeners = new Set<(delivery: DiagnosticsDelivery) => void>();
    /** whether URIs are compared case-insensitively, from the platform */
    private readonly caseInsensitive: boolean;
    /** URI keys already hinted at as matching an open document apart from case */
    private caseHinted = new Set<string>();

    constructor(
        private log: (msg: string) => void = () => {},
        private closeWindowMs = CLOSE_PUBLISH_WINDOW_MS,
        /** called for each received publish with its classification, before any wait sees it */
        private onPublish: (publish: DiagnosticsPublish, status: PublishStatus) => void = () => {},
        /** decides whether URIs are compared case-insensitively (darwin, win32), injectable for tests */
        platform: NodeJS.Platform = process.platform,
    ) {
        this.caseInsensitive = platform === 'darwin' || platform === 'win32';
    }

    /** The key a URI is tracked under: percent-decoded, and lowercased on case-insensitive platforms */
    private key(uri: string): string {
        let decoded = uri;
        try {
            decoded = decodeURIComponent(uri);
        } catch {
            // malformed percent-encoding, match the URI as it is
        }
        return this.caseInsensitive ? decoded.toLowerCase() : decoded;
    }

    /** On case-sensitive platforms, log once per URI when an unopened publish matches an open document apart from case */
    private hintCaseMismatch(key: string, uri: string): void {
        if (this.caseInsensitive || this.caseHinted.has(key)) {
            return;
        }
        const lower = key.toLowerCase();
        for (const [docKey, doc] of this.documents) {
            if (doc.generation > 0 && docKey !== key && docKey.toLowerCase() === lower) {
                this.caseHinted.add(key);
                this.log(
                    `Publish for unopened ${uri} matches opened ${docKey} apart from case, ` +
                        'the server may be changing the case of URIs; it is not matched on this platform',
                );
                return;
            }
        }
    }

    /** Update document state from an outgoing notification, other methods are ignored */
    noteNotification(method: string, params: unknown): void {
        const textDocument = (params as { textDocument?: { uri?: unknown; version?: unknown } } | null)?.textDocument;
        if (typeof textDocument?.uri !== 'string') {
            return;
        }
        const uri = this.key(textDocument.uri);
        const version = typeof textDocument.version === 'number' ? textDocument.version : undefined;
        const doc = this.documents.get(uri) ?? {
            generation: 0,
            open: false,
            syncedAt: 0n,
            syncSeq: 0,
            closePublishes: 0,
        };
        if (method === 'textDocument/didOpen') {
            doc.generation++;
            doc.open = true;
            doc.version = version;
            this.markSynced(doc, 'didOpen');
        } else if (method === 'textDocument/didChange') {
            doc.version = version ?? doc.version;
            this.markSynced(doc, 'didChange');
        } else if (method === 'textDocument/didClose') {
            doc.open = false;
            this.startCloseWindow(textDocument.uri, doc);
        } else {
            return;
        }
        this.documents.set(uri, doc);
    }

    /** Record a publish and hand it to the listeners of its URI, unless it is held as a candidate */
    receive(params: PublishDiagnosticsParams): DiagnosticsPublish {
        const receivedAt = process.hrtime.bigint();
        const key = this.key(params.uri);
        const doc = this.documents.get(key);
        let generation = doc?.generation ?? 0;
        let tentative = false;
        let status: PublishStatus = !doc || doc.generation === 0 ? 'unopened' : 'current';
        if (status === 'unopened') {
            this.hintCaseMismatch(key, params.uri);
        }
        if (doc && doc.generation > 0 && !doc.open) {
            status = 'closed';
            doc.closePublishes++;
            this.learn('publishes', `publish for ${params.uri} while it is closed`);
        } else if (doc?.candidate) {
            // a further publish after the reopen: the candidate was the close publish
            this.log(`Publish for ${params.uri} supersedes the tentative empty publish after didClose`);
            doc.candidate = undefined;
            this.learn('publishes', `a publish superseded the empty one after closing ${params.uri}`);
        } else if (doc?.closedAt !== undefined && params.diagnostics.length === 0 && params.version === undefined) {
            const sinceCloseMs = (Number(receivedAt - doc.closedAt) / 1_000_000).toFixed(1);
            if (!doc.publishedSinceClose) {
                // the first publish after the reopen may be the server clearing the closed document
                if (this._closeBehavior === 'publishes') {
                    generation--;
                    status = 'stale';
                    this.log(
                        `Empty publish for ${params.uri} ${sinceCloseMs}ms after didClose, ` +
                            `credited to closed generation ${generation}`,
                    );
                } else if (this._closeBehavior === 'unknown') {
                    tentative = true;
                    status = 'close candidate';
                    this.log(`Empty publish for ${params.uri} ${sinceCloseMs}ms after didClose, held as tentative`);
                }
            } else if (this._closeBehavior === 'publishes') {
                // a server may clear a closed document more than once (rust-analyzer sends two or
                // three empty publishes per close), so a further one can land after the reopen
                // even though one already arrived. A server versioning its publishes for open
                // documents leaves the version out only for a closed one, so the publish is the
                // close's; otherwise it is held like the first, until a further publish or the
                // end of the window shows what it was
                if (this.versionsPublishes) {
                    generation--;
                    status = 'stale';
                    this.log(
                        `Further unversioned empty publish for ${params.uri} ${sinceCloseMs}ms after didClose, ` +
                            `credited to closed generation ${generation}: the server versions its publishes`,
                    );
                } else {
                    tentative = true;
                    status = 'close candidate';
                    this.log(
                        `Further empty publish for ${params.uri} ${sinceCloseMs}ms after didClose, held as tentative`,
                    );
                }
            }
        }
        if (doc && generation < doc.generation) {
            doc.closePublishes++;
        }
        if (params.version !== undefined && doc && doc.generation > 0) {
            this.versionsPublishes = true;
        }
        if (doc?.closedAt !== undefined) {
            doc.publishedSinceClose = true;
        }
        const publish: DiagnosticsPublish = {
            uri: params.uri,
            diagnostics: params.diagnostics,
            receivedAt,
            generation,
            seq: ++this.seq,
        };
        if (params.version !== undefined) {
            publish.version = params.version;
            if (status === 'current' && doc?.version !== undefined && params.version !== doc.version) {
                status = 'stale';
            }
        }
        // only a publish for a document the client opened shows that the server pushes for the
        // documents it is waited on for, servers may publish for files never opened (ts7 clears
        // tsconfig.json right after the first didOpen) and still answer only pulls for the rest.
        // A stale one (outdated version) counts, a held close window candidate does not
        if (this._delivery !== 'push' && (status === 'current' || status === 'closed' || status === 'stale')) {
            this.log(`Server pushes diagnostics (publish for ${params.uri}), auto waits wait for pushes`);
            this.setDelivery('push', false);
        }
        this.onPublish(publish, status);
        if (tentative && doc) {
            doc.candidate = publish;
        } else {
            this.deliver(publish);
        }
        return publish;
    }

    /** What the tracker learned about the server publishing on close */
    get closeBehavior(): ClosePublishBehavior {
        return this._closeBehavior;
    }

    /** What the tracker learned about how the server delivers diagnostics */
    get delivery(): DiagnosticsDelivery {
        return this._delivery;
    }

    /**
     * Whether `pull` was learned only from empty pulls, which a server still loading may
     * answer with a placeholder before it starts pushing. False for `push` and `unknown`
     */
    get deliveryTentative(): boolean {
        return this._deliveryTentative;
    }

    /**
     * Learn that the server answers pulls but does not push, ignored once a publish was seen.
     * A tentative learn (from an empty pull) does not settle it: a later non tentative one
     * does, and a publish still flips it to `push` either way
     */
    markPullOnly(reason: string, tentative = false): void {
        if (this._delivery === 'push' || (this._delivery === 'pull' && (tentative || !this._deliveryTentative))) {
            return;
        }
        if (tentative) {
            this.log(
                `Server answered a pull with no diagnostics (${reason}), tentatively pull only: ` +
                    'auto waits pull at once, pulls are marked tentative until the server pushes or returns diagnostics',
            );
        } else {
            this.log(`Server only answers pulls (${reason}), auto waits pull at once`);
        }
        this.setDelivery('pull', tentative);
    }

    /**
     * Start from a delivery learned by an earlier tracker, as the runner does for each server
     * it restarts. A carried `pull` keeps its tentative flag, so a push still flips it, and a
     * carried `unknown` changes nothing. Ignored once this tracker learned anything itself
     */
    seedDelivery(delivery: DiagnosticsDelivery, tentative: boolean): void {
        if (delivery === 'unknown' || this._delivery !== 'unknown') {
            return;
        }
        const carriedTentative = delivery === 'pull' && tentative;
        this.log(
            `Carrying diagnostics delivery from the previous server: ${delivery}${carriedTentative ? ' (tentative)' : ''}`,
        );
        this.setDelivery(delivery, carriedTentative);
    }

    /** Call `listener` whenever the learned delivery changes, returns a function removing it */
    onDeliveryChange(listener: (delivery: DiagnosticsDelivery) => void): () => void {
        this.deliveryListeners.add(listener);
        return () => this.deliveryListeners.delete(listener);
    }

    /** The state of a document, from the notifications sent for it */
    document(uri: string): DocumentSyncState | undefined {
        const doc = this.documents.get(this.key(uri));
        if (!doc) {
            return undefined;
        }
        const { generation, open, version, syncedAt, syncSeq, syncedBy, closePublishes } = doc;
        return { generation, open, version, syncedAt, syncSeq, syncedBy, closePublishes };
    }

    /** The latest publish received for a URI */
    latestPublish(uri: string): DiagnosticsPublish | undefined {
        return this.latest.get(this.key(uri));
    }

    /** The current sequence number, a publish received after now has a larger seq */
    currentSeq(): number {
        return this.seq;
    }

    /**
     * Resolve with the first publish for uri that `accept` takes, checking the cached latest
     * publish first so a wait registered after the notification still sees it. Resolves
     * undefined exactly when the timeout timer fires, so callers never infer a timeout from
     * elapsed time (timers can fire slightly early)
     */
    async waitFor(
        uri: string,
        accept: (publish: DiagnosticsPublish) => boolean,
        timeoutMs: number,
    ): Promise<DiagnosticsPublish | undefined> {
        const result = await this.waitForPublishes(uri, accept, { timeoutMs });
        return result.timedOut ? undefined : result.publish;
    }

    /**
     * Wait on the publishes for uri that `accept` takes, the cached latest one included.
     * Without options this resolves on the first of them. With `until`, accepted publishes
     * failing it are counted but do not resolve. With `settleMs`, once a publish resolved
     * the wait (passing `until`, when given), it keeps going until no accepted publish
     * arrived for `settleMs`, then resolves with the latest. Quiet time counts from the
     * receipt of the latest accepted publish, so a cached publish or a close window
     * candidate delivered late has already been quiet for a while. The timeout caps the
     * whole wait; it only counts as timed out when no publish resolved the wait, a timeout
     * during the quiet period resolves with the latest accepted publish
     */
    waitForPublishes(
        uri: string,
        accept: (publish: DiagnosticsPublish) => boolean,
        options: PublishWaitOptions,
    ): Promise<PublishWaitResult> {
        const { timeoutMs, until, settleMs, signal } = options;
        const key = this.key(uri);
        return new Promise((resolve, reject) => {
            if (signal?.aborted) {
                resolve({ publishes: 0, timedOut: false, aborted: true });
                return;
            }
            let listeners = this.listeners.get(key);
            if (!listeners) {
                listeners = new Set();
                this.listeners.set(key, listeners);
            }
            let latest: DiagnosticsPublish | undefined;
            let publishes = 0;
            let satisfied = false;
            let quietTimer: NodeJS.Timeout | undefined;
            let finished = false;
            const cleanup = () => {
                finished = true;
                clearTimeout(timer);
                clearTimeout(quietTimer);
                signal?.removeEventListener('abort', onAbort);
                listeners.delete(listener);
                if (listeners.size === 0 && this.listeners.get(key) === listeners) {
                    this.listeners.delete(key);
                }
            };
            const finish = (timedOut: boolean) => {
                cleanup();
                resolve({ publish: latest, publishes, timedOut });
            };
            // count an accepted publish, then resolve or (re)start the quiet period
            const take = (publish: DiagnosticsPublish) => {
                if (finished || !accept(publish)) {
                    return;
                }
                publishes++;
                latest = publish;
                if (!satisfied) {
                    if (until && !until(publish)) {
                        return;
                    }
                    satisfied = true;
                }
                if (settleMs === undefined) {
                    finish(false);
                    return;
                }
                const quietMs = Number(process.hrtime.bigint() - publish.receivedAt) / 1_000_000;
                clearTimeout(quietTimer);
                quietTimer = setTimeout(() => finish(false), Math.max(0, settleMs - quietMs));
            };
            // a throwing accept or until rejects the wait instead of the publish handler
            const listener = (publish: DiagnosticsPublish) => {
                try {
                    take(publish);
                } catch (err) {
                    cleanup();
                    reject(err);
                }
            };
            const timer = setTimeout(() => {
                if (satisfied) {
                    this.log(`Settle period for ${uri} cut short by the ${timeoutMs}ms timeout`);
                }
                finish(!satisfied);
            }, timeoutMs);
            const onAbort = () => {
                cleanup();
                resolve({ publish: latest, publishes, timedOut: false, aborted: true });
            };
            signal?.addEventListener('abort', onAbort);
            listeners.add(listener);
            const cached = this.latest.get(key);
            if (cached) {
                listener(cached);
            }
        });
    }

    /** Forget all documents, publishes and learned behavior, pending waits run into their timeout */
    clear(): void {
        for (const doc of this.documents.values()) {
            clearTimeout(doc.closeTimer);
        }
        this._closeBehavior = 'unknown';
        this.versionsPublishes = false;
        this.setDelivery('unknown', false);
        this.documents.clear();
        this.latest.clear();
        this.listeners.clear();
        this.caseHinted.clear();
    }

    private setDelivery(delivery: DiagnosticsDelivery, tentative: boolean): void {
        const changed = delivery !== this._delivery;
        this._delivery = delivery;
        this._deliveryTentative = tentative;
        if (changed) {
            for (const listener of this.deliveryListeners) {
                listener(delivery);
            }
        }
    }

    /** Make a publish the latest for its URI and hand it to the listeners */
    private deliver(publish: DiagnosticsPublish): void {
        const key = this.key(publish.uri);
        this.latest.set(key, publish);
        for (const cb of this.listeners.get(key) ?? []) {
            cb(publish);
        }
    }

    /** Open a close window, dropping a candidate still held from an earlier close */
    private startCloseWindow(uri: string, doc: TrackedDocument): void {
        clearTimeout(doc.closeTimer);
        doc.candidate = undefined;
        doc.closedAt = process.hrtime.bigint();
        doc.publishedSinceClose = false;
        doc.closePublishes = 0;
        doc.closeTimer = setTimeout(() => this.endCloseWindow(uri, doc), this.closeWindowMs);
        // a pending window must not keep the process alive
        doc.closeTimer.unref();
    }

    /** At the end of the close window, accept a held candidate and learn from what arrived */
    private endCloseWindow(uri: string, doc: TrackedDocument): void {
        doc.closeTimer = undefined;
        doc.closedAt = undefined;
        const candidate = doc.candidate;
        if (candidate) {
            doc.candidate = undefined;
            this.log(`No further publish for ${uri} within the close window, accepting the empty one`);
            // a candidate held after a publish already cleared the closed document says nothing
            // about whether the server publishes on close
            if (this._closeBehavior !== 'publishes') {
                this.learn('silent', `the empty publish after reopening ${uri} was not superseded`);
            }
            this.deliver(candidate);
        } else if (!doc.publishedSinceClose) {
            this.learn('silent', `no publish for ${uri} within ${this.closeWindowMs}ms of didClose`);
        }
    }

    private learn(behavior: Exclude<ClosePublishBehavior, 'unknown'>, reason: string): void {
        if (this._closeBehavior === behavior) {
            return;
        }
        this._closeBehavior = behavior;
        this.log(
            behavior === 'publishes'
                ? `Server publishes on close (${reason}), empty publishes after a reopen are credited to the close`
                : `Server does not publish on close (${reason}), the close window rule is off`,
        );
    }

    private markSynced(doc: TrackedDocument, by: 'didOpen' | 'didChange'): void {
        doc.syncedAt = process.hrtime.bigint();
        doc.syncSeq = ++this.seq;
        doc.syncedBy = by;
    }
}

/** How long the server must stay idle before an idle wait resolves */
export const DEFAULT_IDLE_QUIET_MS = 100;

/** A progress token, as sent in window/workDoneProgress/create and $/progress */
export type ProgressToken = number | string;

/** The params of a $/progress notification, `value` is only checked for work done progress */
interface ProgressParams {
    token: ProgressToken;
    value?: { kind?: unknown; title?: unknown; message?: unknown; percentage?: unknown };
}

/** The params of rust-analyzer's experimental/serverStatus notification */
export interface ServerStatusParams {
    health?: 'ok' | 'warning' | 'error';
    /** false while the server still has work queued, e.g. loading the workspace */
    quiescent: boolean;
    message?: string;
}

/** Options of ProgressTracker.waitForIdle */
export interface IdleWaitOptions {
    /** give up after this many milliseconds */
    timeoutMs: number;
    /** how long the server must stay idle before the wait resolves (default DEFAULT_IDLE_QUIET_MS) */
    quietMs?: number;
}

/** What an idle wait resolved with */
export interface IdleWaitResult {
    /** whether the server was idle when the wait resolved, also on timeout (then without a full quiet period) */
    idle: boolean;
    /** the timeout fired before the server stayed idle for the quiet period */
    timedOut: boolean;
    /**
     * milliseconds from the start of the wait until the server became idle for the last
     * time, 0 when it already was; the quiet period is not included. On timeout, the
     * time until the timeout
     */
    ms: number;
}

/**
 * Tracks work done progress ($/progress begin, report and end) and rust-analyzer's
 * experimental/serverStatus, so a wait can tell when the server has finished background
 * work such as loading or indexing a workspace. The server is idle while no progress
 * token is active and, once it ever sent a server status, the latest one is quiescent.
 * Tokens are tracked whether or not the server created them first through
 * window/workDoneProgress/create. One tracker serves one server process, `clear()`
 * forgets all state.
 *
 * Separately, `busy` tells whether the server is still loading, for auto mode diagnostics
 * waits that must not take an empty pull for real diagnostics, see `busy`
 */
export class ProgressTracker {
    /** active tokens with the title of their begin */
    private active = new Map<ProgressToken, string>();
    private status: ServerStatusParams | undefined;
    /** process.hrtime.bigint() of the latest change from busy to idle, or of creation */
    private idleSince = process.hrtime.bigint();
    private listeners = new Set<() => void>();
    private idleListeners = new Set<() => void>();

    constructor(private log: (msg: string) => void = () => {}) {}

    /**
     * Whether the server reports it is still loading: once it ever sent a server status,
     * exactly while the latest one is not quiescent, otherwise while a progress token is
     * active. The server status takes precedence because rust-analyzer keeps reporting
     * progress after it turned quiescent: flycheck (cargo check) runs under a $/progress
     * token about 130ms after quiescence, and diagnostics waits must not wait for it
     */
    get busy(): boolean {
        if (this.status !== undefined) {
            return !this.status.quiescent;
        }
        return this.active.size > 0;
    }

    /** Call `listener` whenever the server turns from busy to not busy, see `busy`; returns a function removing it */
    onNotBusy(listener: () => void): () => void {
        this.idleListeners.add(listener);
        return () => this.idleListeners.delete(listener);
    }

    /** Whether no token is active and the latest server status, if any, is quiescent */
    get idle(): boolean {
        return this.active.size === 0 && (this.status === undefined || this.status.quiescent);
    }

    /** The titles of the active progress tokens */
    get activeTitles(): string[] {
        return [...this.active.values()];
    }

    /** The latest experimental/serverStatus, undefined when none arrived */
    get serverStatus(): ServerStatusParams | undefined {
        return this.status;
    }

    /** Note a window/workDoneProgress/create request, the token only counts once it begins */
    create(token: ProgressToken): void {
        this.log(`Progress token ${token} created`);
    }

    /** Update the active tokens from a $/progress notification, other than work done progress is ignored */
    progress(params: ProgressParams): void {
        const { token, value } = params;
        const kind = value?.kind;
        this.update(() => {
            if (kind === 'begin') {
                const title = typeof value?.title === 'string' ? value.title : String(token);
                this.active.set(token, title);
                const message = typeof value?.message === 'string' ? ` (${value.message})` : '';
                this.log(`Progress begin: ${title}${message}`);
            } else if (kind === 'end') {
                const title = this.active.get(token);
                if (title === undefined) {
                    this.log(`Progress end for unknown token ${token}`);
                    return;
                }
                this.active.delete(token);
                const message = typeof value?.message === 'string' ? ` (${value.message})` : '';
                this.log(`Progress end: ${title}${message}`);
            }
        });
    }

    /** Record an experimental/serverStatus notification */
    serverStatusChanged(params: ServerStatusParams): void {
        this.update(() => {
            const changed = this.status?.quiescent !== params.quiescent || this.status?.health !== params.health;
            this.status = params;
            if (changed) {
                const message = params.message ? `: ${params.message}` : '';
                this.log(
                    `Server status ${params.health ?? 'ok'}, ${params.quiescent ? 'quiescent' : 'busy'}${message}`,
                );
            }
        });
    }

    /**
     * Resolve once the server has been idle for `quietMs`, counting from the later of the
     * start of the wait and the latest change to idle, so back to back progress tokens do
     * not resolve the wait in between and a server that never reports progress resolves
     * after the quiet period. Resolves with timedOut set exactly when the timeout timer fires
     */
    waitForIdle(options: IdleWaitOptions): Promise<IdleWaitResult> {
        const { timeoutMs, quietMs = DEFAULT_IDLE_QUIET_MS } = options;
        const startedAt = process.hrtime.bigint();
        const sinceStart = (at: bigint) => Math.max(0, Number(at - startedAt) / 1_000_000);
        return new Promise((resolve) => {
            let quietTimer: NodeJS.Timeout | undefined;
            const finish = (result: IdleWaitResult) => {
                clearTimeout(timer);
                clearTimeout(quietTimer);
                this.listeners.delete(check);
                resolve(result);
            };
            // (re)start the quiet period when idle, cancel it when busy
            const check = () => {
                clearTimeout(quietTimer);
                if (!this.idle) {
                    return;
                }
                const quietFrom = this.idleSince > startedAt ? this.idleSince : startedAt;
                const quietSoFar = Number(process.hrtime.bigint() - quietFrom) / 1_000_000;
                quietTimer = setTimeout(
                    () => finish({ idle: true, timedOut: false, ms: sinceStart(quietFrom) }),
                    Math.max(0, quietMs - quietSoFar),
                );
            };
            const timer = setTimeout(() => {
                if (!this.idle) {
                    this.log(`Server not idle after ${timeoutMs}ms, active: ${this.describeBusy()}`);
                }
                finish({ idle: this.idle, timedOut: true, ms: sinceStart(process.hrtime.bigint()) });
            }, timeoutMs);
            this.listeners.add(check);
            check();
        });
    }

    /** Forget all tokens and the server status, pending waits see the server as idle */
    clear(): void {
        this.update(() => {
            this.active.clear();
            this.status = undefined;
        });
    }

    /** Apply a change, note when the server turned idle and let the waits recheck */
    private update(change: () => void): void {
        const wasIdle = this.idle;
        const wasBusy = this.busy;
        change();
        if (!wasIdle && this.idle) {
            this.idleSince = process.hrtime.bigint();
        }
        for (const check of this.listeners) {
            check();
        }
        if (wasBusy && !this.busy) {
            for (const listener of this.idleListeners) {
                listener();
            }
        }
    }

    private describeBusy(): string {
        const parts = this.activeTitles;
        if (this.status && !this.status.quiescent) {
            parts.push('server status not quiescent');
        }
        return parts.join(', ');
    }
}

/** default time to wait for a shutdown reply before giving up on the server */
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5000;

/** How the server process ended */
export interface ServerExit {
    code: number | null;
    signal: NodeJS.Signals | null;
    /** the server exited on its own before replying to shutdown, or with a failure after it */
    abnormal: boolean;
    /** the server exited after a replied shutdown with a non zero code in ServerConfig.allowExitCodes */
    tolerated?: boolean;
    /** human readable description of the exit */
    reason: string;
}

/** Options of LspHarness beyond the server config */
export interface LspHarnessOptions {
    /** append server stderr and log messages to this file instead of the console */
    serverLog?: string;
}

/**
 * Manages a language server process and its JSON-RPC connection.
 */
export class LspHarness {
    private process: cp.ChildProcess | null = null;
    private connection: rpc.MessageConnection | null = null;
    private diagnostics: DiagnosticsTracker;
    private progress: ProgressTracker;
    private _capabilities: ServerCapabilities | null = null;
    /** dynamic registrations by registration id */
    private _registrations = new Map<string, Registration>();
    private verbose: boolean;
    /** resolves once the server process has exited */
    private exited: Promise<void> = Promise.resolve();
    private _exit: ServerExit | null = null;
    /** set once the server replies to shutdown, so a following exit is expected */
    private shutdownReplied = false;
    /** set once we signal the process, so the resulting exit is not abnormal */
    private killRequested = false;
    /** set while stop() runs, an exit then is part of our own shutdown */
    private stopping = false;
    /** set once the server exited outside stop(), requests and notifications then fail with it */
    private exitError: Error | null = null;
    /** rejecters of the requests sent through sendRequest still awaiting a reply */
    private pendingRequests = new Set<(err: Error) => void>();
    /** lifecycle timings (spawn, initialize, shutdown) not yet taken by the runner */
    private lifecycleTimings: RequestTiming[] = [];
    /** ServerConfig.settings with dotted keys expanded, undefined when none are given */
    private settings: Record<string, unknown> | undefined;
    /** routes server stderr and log messages to the server log file or the console */
    private output: ServerOutput;

    constructor(
        private config: ServerConfig,
        private workspaceRoot: string,
        verbose = false,
        options: LspHarnessOptions = {},
    ) {
        this.verbose = verbose;
        this.settings = config.settings ? expandSettings(config.settings) : undefined;
        this.output = new ServerOutput(options.serverLog, verbose);
        this.diagnostics = new DiagnosticsTracker(
            (msg) => this.log(msg),
            CLOSE_PUBLISH_WINDOW_MS,
            (publish, status) => {
                if (this.verbose) {
                    this.log(formatPublishLine(publish, status, this.workspaceRoot));
                }
            },
        );
        this.progress = new ProgressTracker((msg) => this.log(msg));
    }

    /** How the server process ended, or null while it is still running */
    get exit(): ServerExit | null {
        return this._exit;
    }

    get capabilities(): ServerCapabilities | null {
        return this._capabilities;
    }

    /** The dynamic registrations the server currently holds */
    get registrations(): Registration[] {
        return [...this._registrations.values()];
    }

    /** Save related sync options, merging the static textDocumentSync capability with dynamic registrations */
    saveSyncOptions(): SaveSyncOptions {
        const options = staticSaveSyncOptions(this._capabilities?.textDocumentSync);
        for (const reg of this._registrations.values()) {
            if (reg.method === 'textDocument/didSave') {
                options.didSave = true;
                if (hasIncludeText(reg.registerOptions)) {
                    options.includeText = true;
                }
            } else if (reg.method === 'textDocument/willSave') {
                options.willSave = true;
            } else if (reg.method === 'textDocument/willSaveWaitUntil') {
                options.willSaveWaitUntil = true;
            }
        }
        return options;
    }

    /** Drain and return the recorded lifecycle/spawn, lifecycle/initialize and lifecycle/shutdown timings */
    takeLifecycleTimings(): RequestTiming[] {
        const result = this.lifecycleTimings;
        this.lifecycleTimings = [];
        return result;
    }

    get conn(): rpc.MessageConnection {
        if (!this.connection) {
            throw new Error('LSP connection not initialized');
        }
        return this.connection;
    }

    /** Spawn the language server and perform LSP initialize/initialized handshake */
    async start(): Promise<void> {
        const { command, args = [], env } = this.config;

        this.log(`Spawning: ${command} ${args.join(' ')}`);
        this.output.open(command, args);
        const spawnStart = process.hrtime.bigint();

        // spawn from the current working directory, not the workspace: the server
        // command may be a path relative to cwd, while the workspace is communicated
        // to the server via rootUri/workspaceFolders in the initialize params below
        this.process = cp.spawn(command, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, ...env },
        });
        this._exit = null;
        this.shutdownReplied = false;
        this.killRequested = false;
        this.stopping = false;
        this.exitError = null;
        const child = this.process;
        const spawned = new Promise<void>((resolve) => child.once('spawn', () => resolve()));
        this.exited = new Promise((resolve) => {
            child.once('exit', () => resolve());
            // a process that failed to spawn never emits exit
            child.once('error', () => {
                if (child.pid === undefined) {
                    resolve();
                }
            });
        });

        // capture stderr, and retain the tail so we can report it if the server dies
        let stderrTail = '';
        this.process.stderr?.on('data', (chunk: Buffer) => {
            const text = chunk.toString();
            stderrTail = (stderrTail + text).slice(-4000);
            this.output.stderr(text);
        });
        this.process.stderr?.on('end', () => this.output.flush());

        // reject the initialize handshake if the process dies or fails to spawn,
        // otherwise sendRequest('initialize') hangs forever with no response
        let onEarlyExit: (reason: Error) => void = () => {};
        const earlyExit = new Promise<never>((_, reject) => {
            onEarlyExit = reject;
        });

        this.process.on('error', (err) => {
            if (child.pid === undefined) {
                this._exit = { code: null, signal: null, abnormal: true, reason: `failed to spawn (${err.message})` };
            }
            onEarlyExit(new Error(`Server process failed to spawn: ${err.message}`));
        });

        this.process.on('exit', (code, signal) => {
            this.log(`Server exited: code=${code} signal=${signal}`);
            this._exit = this.describeExit(code, signal);
            if (!this.stopping) {
                this.failPendingRequests(child, `server ${this._exit.reason}`);
            }
            onEarlyExit(
                new Error(
                    `Server exited before initialize (code=${code} signal=${signal}).` +
                        (stderrTail ? `\nServer stderr:\n${stderrTail}` : ''),
                ),
            );
        });

        // Create JSON-RPC connection over stdio
        const input = this.process.stdout!;
        const output = this.process.stdin!;
        this.connection = rpc.createMessageConnection(
            new rpc.StreamMessageReader(input),
            new rpc.StreamMessageWriter(output),
        );

        this.connection.listen();

        // Subscribe to diagnostics notifications
        this.connection.onNotification('textDocument/publishDiagnostics', (params: PublishDiagnosticsParams) => {
            this.diagnostics.receive(params);
        });

        // route the server's own log output with its stderr
        this.connection.onNotification('window/logMessage', (params: { type: number; message: string }) => {
            this.output.message(params.message);
        });
        this.connection.onNotification('window/showMessage', (params: { type: number; message: string }) => {
            this.output.message(`showMessage: ${params.message}`);
        });
        this.connection.onNotification('$/logTrace', (params: { message: string; verbose?: string }) => {
            this.output.message(`trace: ${params.message}${params.verbose ? `\n${params.verbose}` : ''}`);
        });

        // answer workspace/configuration from the settings, or {} per item when none are given
        this.connection.onRequest('workspace/configuration', (params: { items: Array<{ section?: string }> }) => {
            const settings = this.settings;
            return params.items.map((item) => {
                if (!settings) {
                    return {};
                }
                return resolveConfigurationSection(settings, item.section);
            });
        });

        // acknowledge pull diagnostic refresh requests, we never cache pulled results
        this.connection.onRequest('workspace/diagnostic/refresh', () => {
            return;
        });

        // acknowledge refresh requests, we hold no cached state to invalidate
        const noOpRequests = [
            'workspace/semanticTokens/refresh',
            'workspace/inlayHint/refresh',
            'workspace/codeLens/refresh',
            'workspace/inlineValue/refresh',
        ];
        for (const method of noOpRequests) {
            this.connection.onRequest(method, () => null);
        }

        // track work done progress and rust-analyzer's server status for idle waits
        this.connection.onRequest('window/workDoneProgress/create', (params: { token: ProgressToken }) => {
            this.progress.create(params.token);
            return null;
        });
        this.connection.onNotification('$/progress', (params: ProgressParams) => {
            this.progress.progress(params);
        });
        this.connection.onNotification('experimental/serverStatus', (params: ServerStatusParams) => {
            this.progress.serverStatusChanged(params);
        });

        // accept and remember all dynamic registrations
        this.connection.onRequest('client/registerCapability', (params: { registrations?: Registration[] }) => {
            for (const reg of params.registrations ?? []) {
                this._registrations.set(reg.id, reg);
                this.log(`Registered ${reg.method}`);
            }
        });

        // the LSP spec really does spell this field 'unregisterations'
        this.connection.onRequest('client/unregisterCapability', (params: { unregisterations?: Registration[] }) => {
            for (const reg of params.unregisterations ?? []) {
                this._registrations.delete(reg.id);
            }
        });

        // no user is present to pick an action, so dismiss the prompt
        this.connection.onRequest('window/showMessageRequest', (params: { type: number; message: string }) => {
            this.log(`Dismissed window/showMessageRequest: ${params.message}`);
            return null;
        });

        // lsbench never mutates the workspace on the server's behalf
        this.connection.onRequest('workspace/applyEdit', (params: { label?: string }) => {
            this.log(`Declined workspace/applyEdit${params.label ? `: ${params.label}` : ''}`);
            return { applied: false, failureReason: 'lsbench does not apply workspace edits' };
        });

        // time spawn up to the OS reporting the process as started
        try {
            await Promise.race([spawned, earlyExit]);
            this.recordLifecycle('lifecycle/spawn', spawnStart);
        } catch (err: unknown) {
            this.recordLifecycle('lifecycle/spawn', spawnStart, err);
            throw err;
        }

        // Perform LSP initialize
        const workspaceUri = pathToUri(this.workspaceRoot);

        const initParams = {
            processId: process.pid,
            rootUri: workspaceUri,
            rootPath: this.workspaceRoot,
            workspaceFolders: [{ uri: workspaceUri, name: path.basename(this.workspaceRoot) }],
            capabilities: mergeCapabilities(defaultClientCapabilities(), this.config.clientCapabilities ?? {}),
            initializationOptions: this.config.initializationOptions ?? {},
        };

        this.log('Sending initialize...');
        // race the handshake against an early process exit so a server that dies
        // (bad command, missing module, crash on startup) surfaces as a rejection
        // instead of hanging on a response that will never come
        const initStart = process.hrtime.bigint();
        let result: InitializeResult;
        try {
            result = (await Promise.race([
                this.connection.sendRequest('initialize', initParams),
                earlyExit,
            ])) as InitializeResult;
            this.recordLifecycle('lifecycle/initialize', initStart);
        } catch (err: unknown) {
            this.recordLifecycle('lifecycle/initialize', initStart, err);
            throw err;
        }
        this._capabilities = result.capabilities;

        // Send initialized notification
        this.connection.sendNotification('initialized', {});
        this.log('Server initialized.');

        // push the settings once, for servers that read them from didChangeConfiguration
        if (this.settings) {
            this.connection.sendNotification('workspace/didChangeConfiguration', { settings: this.settings });
        }
    }

    /**
     * Shut down the server, always settling: the shutdown request is raced against
     * the process exiting and a timeout, then the server is sent exit and killed if
     * it is still running. Returns how the process ended.
     */
    async stop(timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS): Promise<ServerExit | null> {
        const connection = this.connection;
        const child = this.process;
        if (!connection) {
            return this._exit;
        }
        this.stopping = true;

        if (!this._exit) {
            const shutdownStart = process.hrtime.bigint();
            const shutdown = connection.sendRequest('shutdown').then(
                () => {
                    this.shutdownReplied = true;
                    return 'replied' as const;
                },
                () => 'failed' as const,
            );
            const outcome = await raceTimeout([shutdown, this.exited.then(() => 'exited' as const)], timeoutMs);
            // time shutdown from request to reply, or to however it failed
            const shutdownErrors = {
                replied: undefined,
                failed: new Error('shutdown request failed'),
                exited: new Error('server exited before replying to shutdown'),
                timeout: new Error(`no shutdown reply within ${timeoutMs}ms`),
            };
            this.recordLifecycle('lifecycle/shutdown', shutdownStart, shutdownErrors[outcome]);
            if (outcome === 'replied') {
                try {
                    await connection.sendNotification('exit');
                } catch {
                    // the server may have closed its input already
                }
                // give the server a moment to exit on its own before signaling it
                await raceTimeout([this.exited], Math.min(timeoutMs, 1000));
            } else if (outcome === 'timeout') {
                this.log(`No shutdown reply within ${timeoutMs}ms, killing the server`);
            }
        }

        connection.dispose();
        this.connection = null;

        if (child && !this._exit) {
            this.killRequested = true;
            child.kill('SIGTERM');
            // force kill a server that ignores SIGTERM, `killed` only reports that a
            // signal was sent, so check the recorded exit instead
            if ((await raceTimeout([this.exited], 3000)) === 'timeout') {
                child.kill('SIGKILL');
                await this.exited;
            }
        }
        this.process = null;
        await this.output.close();
        this.diagnostics.clear();
        this.progress.clear();
        this._registrations.clear();
        return this._exit;
    }

    /**
     * After an exit outside stop(), fail new requests and notifications at once, and the
     * requests awaiting a reply once the server's output is drained, since vscode-jsonrpc
     * rejects them only on dispose. A reply written just before the exit still arrives
     */
    private failPendingRequests(child: cp.ChildProcess, message: string): void {
        const error = new Error(message);
        this.exitError = error;
        const connection = this.connection;
        const drained = new Promise<void>((resolve) => {
            const stdout = child.stdout;
            if (!stdout || stdout.readableEnded || stdout.destroyed) {
                resolve();
                return;
            }
            stdout.once('end', () => resolve());
            stdout.once('close', () => resolve());
        });
        // a grandchild may keep stdout open, so do not wait on it for long
        void raceTimeout([drained], 200).then(() => {
            // a restart may have replaced the connection meanwhile
            if (this.exitError !== error) {
                return;
            }
            const pending = [...this.pendingRequests];
            this.pendingRequests.clear();
            if (pending.length > 0) {
                this.log(`Failing ${pending.length} pending request(s): ${message}`);
            }
            for (const reject of pending) {
                reject(error);
            }
            if (connection && this.connection === connection) {
                connection.dispose();
            }
        });
    }

    /** Record a lifecycle timing from startNs to now, failed when error is given */
    private recordLifecycle(method: string, startNs: bigint, error?: unknown): void {
        const ms = Number(process.hrtime.bigint() - startNs) / 1_000_000;
        const timing: RequestTiming = {
            method,
            duration_ms: Math.round(ms * 1000) / 1000,
            success: error === undefined,
            // lifecycle steps have no meaningful payload (shutdown even replies null by spec)
            result: error === undefined ? 'ok' : 'error',
        };
        if (error !== undefined) {
            timing.error = (error instanceof Error ? error.message : String(error)).split('\n')[0];
        }
        this.lifecycleTimings.push(timing);
    }

    /** Classify a process exit, signals we sent and a clean (or allowed) exit after shutdown are normal */
    private describeExit(code: number | null, signal: NodeJS.Signals | null): ServerExit {
        const status = signal ? `signal ${signal}` : `code ${code}`;
        if (this.killRequested) {
            return { code, signal, abnormal: false, reason: `killed by lsbench (${status})` };
        }
        if (!this.shutdownReplied) {
            return { code, signal, abnormal: true, reason: `exited unexpectedly (${status})` };
        }
        if (signal === null && code !== null && code !== 0 && this.config.allowExitCodes?.includes(code)) {
            return {
                code,
                signal,
                abnormal: false,
                tolerated: true,
                reason: `exited after shutdown with ${status} (allowed)`,
            };
        }
        if (code !== 0) {
            return { code, signal, abnormal: true, reason: `exited after shutdown with ${status}` };
        }
        return { code, signal, abnormal: false, reason: 'exited cleanly' };
    }

    /** Get cached diagnostics for a URI */
    getDiagnostics(uri: string): Diagnostic[] {
        return this.diagnostics.latestPublish(uri)?.diagnostics ?? [];
    }

    /** The latest publish received for a URI, with its version, receipt time and generation */
    latestPublish(uri: string): DiagnosticsPublish | undefined {
        return this.diagnostics.latestPublish(uri);
    }

    /** What lsbench last told the server about a document through didOpen, didChange and didClose */
    documentState(uri: string): DocumentSyncState | undefined {
        return this.diagnostics.document(uri);
    }

    /** How the server was learned to deliver diagnostics, see DiagnosticsTracker.delivery */
    diagnosticsDelivery(): DiagnosticsDelivery {
        return this.diagnostics.delivery;
    }

    /** Whether `pull` delivery was learned only tentatively, see DiagnosticsTracker.deliveryTentative */
    diagnosticsDeliveryTentative(): boolean {
        return this.diagnostics.deliveryTentative;
    }

    /** Learn that the server answers pulls but does not push, see DiagnosticsTracker.markPullOnly */
    markPullOnly(reason: string, tentative = false): void {
        this.diagnostics.markPullOnly(reason, tentative);
    }

    /** Start from a delivery learned by an earlier server, see DiagnosticsTracker.seedDelivery */
    seedDiagnosticsDelivery(delivery: DiagnosticsDelivery, tentative: boolean): void {
        this.diagnostics.seedDelivery(delivery, tentative);
    }

    /** Call `listener` whenever the learned delivery changes, see DiagnosticsTracker.onDeliveryChange */
    onDiagnosticsDeliveryChange(listener: (delivery: DiagnosticsDelivery) => void): () => void {
        return this.diagnostics.onDeliveryChange(listener);
    }

    /** The current publish sequence number, a publish received after now has a larger seq */
    currentPublishSeq(): number {
        return this.diagnostics.currentSeq();
    }

    /**
     * Wait on the publishes for uri that `accept` takes, the cached latest one included,
     * see DiagnosticsTracker.waitForPublishes
     */
    waitForPublishes(
        uri: string,
        accept: (publish: DiagnosticsPublish) => boolean,
        options: PublishWaitOptions,
    ): Promise<PublishWaitResult> {
        return this.diagnostics.waitForPublishes(uri, accept, options);
    }

    /** Whether the server reports it is still loading, see ProgressTracker.busy */
    isServerBusy(): boolean {
        return this.progress.busy;
    }

    /** Call `listener` whenever the server stops being busy, see ProgressTracker.onNotBusy */
    onServerNotBusy(listener: () => void): () => void {
        return this.progress.onNotBusy(listener);
    }

    /** Resolve once the server has finished its background work, see ProgressTracker.waitForIdle */
    waitForIdle(options: IdleWaitOptions): Promise<IdleWaitResult> {
        return this.progress.waitForIdle(options);
    }

    /**
     * Wait for the server to become idle and record the wait as lifecycle/idle, result ok
     * or timeout, for use right after start()
     */
    async waitForIdleAfterStart(options: IdleWaitOptions): Promise<IdleWaitResult> {
        const result = await this.progress.waitForIdle(options);
        this.lifecycleTimings.push({
            method: 'lifecycle/idle',
            duration_ms: Math.round(result.ms * 1000) / 1000,
            success: !result.timedOut,
            result: result.timedOut ? 'timeout' : 'ok',
        });
        this.log(`Server ${result.timedOut ? 'not idle' : 'idle'} after ${result.ms.toFixed(1)}ms`);
        return result;
    }

    /** Wait for the next diagnostics publication for a URI, falling back to the cached ones on timeout */
    async onDiagnostics(uri: string, timeoutMs: number): Promise<Diagnostic[]> {
        const after = this.diagnostics.currentSeq();
        const publish = await this.diagnostics.waitFor(uri, (p) => p.seq > after, timeoutMs);
        return publish?.diagnostics ?? this.getDiagnostics(uri);
    }

    /** Send a typed LSP request */
    sendRequest<R>(method: string, params: unknown): Promise<R> {
        if (this.exitError) {
            return Promise.reject(this.exitError);
        }
        return new Promise<R>((resolve, reject) => {
            // settle once, by the reply or by the server exiting before it
            let settled = false;
            const fail = (err: unknown) => {
                if (!settled) {
                    settled = true;
                    this.pendingRequests.delete(fail);
                    reject(err);
                }
            };
            this.pendingRequests.add(fail);
            let request: Promise<unknown>;
            try {
                request = this.conn.sendRequest(method, params);
            } catch (err: unknown) {
                fail(err);
                return;
            }
            request.then((value) => {
                if (!settled) {
                    settled = true;
                    this.pendingRequests.delete(fail);
                    resolve(value as R);
                }
            }, fail);
        });
    }

    /** Send an LSP notification, throwing once the server has exited outside stop() */
    sendNotification(method: string, params: unknown): void {
        if (this.exitError) {
            throw new Error(`cannot send ${method}: ${this.exitError.message}`);
        }
        // a write to a server that just closed its input rejects, which is not ours to surface
        this.conn.sendNotification(method, params).catch((err: unknown) => {
            this.log(`Failed to send ${method}: ${err instanceof Error ? err.message : String(err)}`);
        });
        this.diagnostics.noteNotification(method, params);
    }

    private log(msg: string): void {
        if (this.verbose) {
            console.error(`[lsbench] ${msg}`);
        }
    }
}

/**
 * The client capabilities lsbench advertises by default, modeled on what
 * VS Code sends. ServerConfig.clientCapabilities is deep merged over these.
 */
export function defaultClientCapabilities(): Record<string, unknown> {
    return {
        // servers report background work such as indexing through $/progress, see waitForIdle
        window: { workDoneProgress: true },
        // rust-analyzer reports whether it finished loading through experimental/serverStatus
        experimental: { serverStatusNotification: true },
        workspace: {
            workspaceFolders: true,
            configuration: true,
            didChangeConfiguration: { dynamicRegistration: true },
            // advertised so servers rely on the client for file watching, as they do under VS Code;
            // the resulting registrations are tracked but no file events are ever sent
            didChangeWatchedFiles: { dynamicRegistration: true, relativePatternSupport: true },
            symbol: {
                dynamicRegistration: true,
                symbolKind: {
                    valueSet: Array.from({ length: 26 }, (_, i) => i + 1),
                },
                resolveSupport: { properties: ['location.range'] },
            },
        },
        textDocument: {
            synchronization: {
                dynamicRegistration: true,
                willSave: true,
                willSaveWaitUntil: true,
                didSave: true,
            },
            hover: {
                dynamicRegistration: true,
                contentFormat: ['markdown', 'plaintext'],
            },
            completion: {
                dynamicRegistration: true,
                completionItem: {
                    snippetSupport: true,
                    commitCharactersSupport: true,
                    documentationFormat: ['markdown', 'plaintext'],
                    resolveSupport: {
                        properties: ['documentation', 'detail', 'additionalTextEdits'],
                    },
                },
                contextSupport: true,
            },
            definition: { dynamicRegistration: true, linkSupport: true },
            declaration: { dynamicRegistration: true, linkSupport: true },
            typeDefinition: { dynamicRegistration: true, linkSupport: true },
            implementation: { dynamicRegistration: true, linkSupport: true },
            references: { dynamicRegistration: true },
            documentHighlight: { dynamicRegistration: true },
            documentSymbol: {
                dynamicRegistration: true,
                hierarchicalDocumentSymbolSupport: true,
                symbolKind: {
                    valueSet: Array.from({ length: 26 }, (_, i) => i + 1),
                },
            },
            formatting: { dynamicRegistration: true },
            rangeFormatting: { dynamicRegistration: true },
            onTypeFormatting: { dynamicRegistration: true },
            rename: { dynamicRegistration: true, prepareSupport: true },
            codeAction: {
                dynamicRegistration: true,
                codeActionLiteralSupport: {
                    codeActionKind: {
                        valueSet: [
                            '',
                            'quickfix',
                            'refactor',
                            'refactor.extract',
                            'refactor.inline',
                            'refactor.rewrite',
                            'source',
                            'source.organizeImports',
                        ],
                    },
                },
                dataSupport: true,
                resolveSupport: { properties: ['edit'] },
            },
            signatureHelp: {
                dynamicRegistration: true,
                signatureInformation: {
                    documentationFormat: ['markdown', 'plaintext'],
                    parameterInformation: { labelOffsetSupport: true },
                },
            },
            foldingRange: { dynamicRegistration: true, lineFoldingOnly: false },
            selectionRange: { dynamicRegistration: true },
            documentLink: { dynamicRegistration: true, tooltipSupport: true },
            codeLens: { dynamicRegistration: true },
            inlayHint: {
                dynamicRegistration: true,
                resolveSupport: {
                    properties: ['tooltip', 'textEdits', 'label.tooltip', 'label.location', 'label.command'],
                },
            },
            callHierarchy: { dynamicRegistration: true },
            typeHierarchy: { dynamicRegistration: true },
            semanticTokens: {
                dynamicRegistration: true,
                requests: {
                    range: true,
                    full: { delta: true },
                },
                tokenTypes: [
                    'namespace',
                    'type',
                    'class',
                    'enum',
                    'interface',
                    'struct',
                    'typeParameter',
                    'parameter',
                    'variable',
                    'property',
                    'enumMember',
                    'event',
                    'function',
                    'method',
                    'macro',
                    'keyword',
                    'modifier',
                    'comment',
                    'string',
                    'number',
                    'regexp',
                    'operator',
                    'decorator',
                ],
                tokenModifiers: [
                    'declaration',
                    'definition',
                    'readonly',
                    'static',
                    'deprecated',
                    'abstract',
                    'async',
                    'modification',
                    'documentation',
                    'defaultLibrary',
                ],
                formats: ['relative'],
                overlappingTokenSupport: false,
                multilineTokenSupport: false,
            },
            // textDocument.diagnostic is intentionally not advertised: servers built on
            // vscode-languageserver (the VS Code CSS, HTML and JSON servers, ESLint) stop pushing
            // when it is present, which would turn push timings into pull timings. Servers that
            // advertise diagnosticProvider anyway are pulled by waitForDiagnostics in auto mode
            publishDiagnostics: {
                relatedInformation: true,
                tagSupport: { valueSet: [1, 2] },
            },
        },
    };
}

/**
 * Deep merge `override` over `base` without mutating either: plain objects merge
 * recursively, arrays and scalars in `override` replace the value in `base`.
 */
export function mergeCapabilities(
    base: Record<string, unknown>,
    override: Record<string, unknown>,
): Record<string, unknown> {
    const result: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(override)) {
        const current = result[key];
        if (isPlainObject(current) && isPlainObject(value)) {
            result[key] = mergeCapabilities(current, value);
        } else {
            result[key] = value;
        }
    }
    return result;
}

/**
 * Expands dotted keys into nested objects at every level, as VS Code does for
 * settings.json: { "html.format": { "enable": true } } becomes { html: { format: { enable: true } } }.
 * Keys meeting at the same path deep merge; on a conflict a key without dots wins
 * over a dotted one. The input is not mutated.
 */
export function expandSettings(settings: Record<string, unknown>): Record<string, unknown> {
    const dotted: Array<[string, unknown]> = [];
    const plain: Array<[string, unknown]> = [];
    for (const entry of Object.entries(settings)) {
        (entry[0].includes('.') ? dotted : plain).push(entry);
    }
    // dotted keys go in first so plain keys merge over them
    const result: Record<string, unknown> = {};
    for (const [key, value] of [...dotted, ...plain]) {
        const segments = key.split('.');
        const last = segments.pop() as string;
        let target = result;
        for (const segment of segments) {
            if (!isPlainObject(target[segment])) {
                target[segment] = {};
            }
            target = target[segment] as Record<string, unknown>;
        }
        const expanded = isPlainObject(value) ? expandSettings(value) : value;
        const current = target[last];
        if (isPlainObject(current) && isPlainObject(expanded)) {
            target[last] = mergeCapabilities(current, expanded);
        } else {
            target[last] = expanded;
        }
    }
    return result;
}

/**
 * Resolves a workspace/configuration section as a dotted path into settings already
 * expanded by expandSettings. Returns the whole settings for no section, and null for
 * an unknown one, as the spec allows.
 */
export function resolveConfigurationSection(settings: Record<string, unknown>, section?: string | null): unknown {
    if (!section) {
        return settings;
    }
    let value: unknown = settings;
    for (const segment of section.split('.')) {
        if (!isPlainObject(value) || !Object.hasOwn(value, segment)) {
            return null;
        }
        value = value[segment];
    }
    return value === undefined ? null : value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads save options from a static textDocumentSync capability. A bare TextDocumentSyncKind
 * number implies didSave without text, matching vscode-languageclient.
 */
function staticSaveSyncOptions(sync: unknown): SaveSyncOptions {
    const options: SaveSyncOptions = { didSave: false, includeText: false, willSave: false, willSaveWaitUntil: false };
    if (typeof sync === 'number') {
        options.didSave = true;
    } else if (typeof sync === 'object' && sync !== null) {
        const { save, willSave, willSaveWaitUntil } = sync as {
            save?: unknown;
            willSave?: unknown;
            willSaveWaitUntil?: unknown;
        };
        if (save === true) {
            options.didSave = true;
        } else if (typeof save === 'object' && save !== null) {
            options.didSave = true;
            options.includeText = hasIncludeText(save);
        }
        options.willSave = willSave === true;
        options.willSaveWaitUntil = willSaveWaitUntil === true;
    }
    return options;
}

function hasIncludeText(options: unknown): boolean {
    return (
        typeof options === 'object' && options !== null && (options as { includeText?: unknown }).includeText === true
    );
}

/** Convert an absolute file path to a file:// URI */
export function pathToUri(filePath: string): string {
    const resolved = path.resolve(filePath);
    return `file://${resolved}`;
}

/** Convert a file:// URI back to an absolute path */
export function uriToPath(uri: string): string {
    if (uri.startsWith('file://')) {
        return uri.slice(7);
    }
    return uri;
}

/** Longest first diagnostic message shown in a verbose publish line */
const PUBLISH_MESSAGE_MAX = 100;

/**
 * One verbose log line for a publish: the workspace relative path (the URI when outside the
 * workspace or not a file), the version or `-`, the diagnostic count, the tracker's
 * classification and the first message on one line, truncated
 */
export function formatPublishLine(
    publish: Pick<DiagnosticsPublish, 'uri' | 'version' | 'diagnostics'>,
    status: PublishStatus,
    workspaceRoot: string,
): string {
    let where = publish.uri;
    if (publish.uri.startsWith('file://')) {
        const rel = path.relative(path.resolve(workspaceRoot), uriToPath(publish.uri));
        if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
            where = rel;
        }
    }
    let line = `Publish ${where} v=${publish.version ?? '-'} n=${publish.diagnostics.length} ${status}`;
    const first = publish.diagnostics[0];
    if (first) {
        let message = String(first.message).replace(/\s+/g, ' ').trim();
        if (message.length > PUBLISH_MESSAGE_MAX) {
            message = `${message.slice(0, PUBLISH_MESSAGE_MAX - 3)}...`;
        }
        line += `: ${message}`;
    }
    return line;
}

/** Header written to a server log file each time a server starts */
function formatServerLogHeader(command: string, args: string[], date = new Date()): string {
    return `===== ${date.toISOString()} server start: ${[command, ...args].join(' ')}`;
}

/**
 * Where server output (stderr, window/logMessage, window/showMessage, $/logTrace) goes: appended
 * to a file when one is given, else to stderr prefixed `[server]` in verbose mode, else nowhere.
 * Stderr arrives in chunks, so partial lines are held until their newline or `flush()`
 */
export class ServerOutput {
    private stream: fs.WriteStream | null = null;
    private partial = '';

    constructor(
        private file: string | undefined,
        private verbose: boolean,
        private toConsole: (text: string) => void = (text) => process.stderr.write(text),
    ) {}

    /** Begin output for a newly started server, writing the header line to the file */
    open(command: string, args: string[]): void {
        this.close();
        if (this.file === undefined) {
            return;
        }
        const stream = fs.createWriteStream(this.file, { flags: 'a' });
        stream.on('error', (err) => {
            console.error(`[lsbench] Cannot write server log ${this.file}: ${err.message}`);
            this.stream = null;
        });
        this.stream = stream;
        stream.write(`${formatServerLogHeader(command, args)}\n`);
    }

    /** A raw stderr chunk, possibly ending mid line */
    stderr(chunk: string): void {
        const text = this.partial + chunk;
        const end = text.lastIndexOf('\n');
        this.partial = text.slice(end + 1);
        if (end >= 0) {
            this.write(text.slice(0, end));
        }
    }

    /** A complete message, which may span lines */
    message(text: string): void {
        this.write(text);
    }

    /** Write out a held partial stderr line */
    flush(): void {
        if (this.partial) {
            const text = this.partial;
            this.partial = '';
            this.write(text);
        }
    }

    /** Flush and end the file stream, resolving once it is written */
    close(): Promise<void> {
        this.flush();
        const stream = this.stream;
        this.stream = null;
        if (!stream) {
            return Promise.resolve();
        }
        return new Promise((resolve) => stream.end(() => resolve()));
    }

    private write(text: string): void {
        const lines = text.replace(/\r/g, '').split('\n');
        if (this.file !== undefined) {
            // never fall back to the console, output after close or a write error is dropped
            this.stream?.write(`${lines.join('\n')}\n`);
        } else if (this.verbose) {
            let out = '';
            for (const line of lines) {
                out += `[server] ${line}\n`;
            }
            this.toConsole(out);
        }
    }
}

/** Resolve with the first promise to settle, or 'timeout' once timeoutMs has passed */
async function raceTimeout<T>(promises: Array<Promise<T>>, timeoutMs: number): Promise<T | 'timeout'> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    try {
        return await Promise.race([...promises, timeout]);
    } finally {
        clearTimeout(timer);
    }
}
