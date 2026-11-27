import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import type { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as rpc from 'vscode-jsonrpc/node';
import type {
    ClientHooks,
    Registration,
    RequestTiming,
    ServerCapabilities,
    ServerConfig,
    ServerTransport,
    SetupScript,
} from './types.js';
import { prefix, style } from './log.js';
import { errorMessage, round } from './util.js';

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

export type CloseClears = 'unknown' | 'once' | 'more';

const CLOSE_CLEARS_ONCE_STREAK = 3;

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
    /**
     * an empty publish for an opened document received while the server reported it was not
     * quiescent (experimental/serverStatus), which may be a placeholder of a server still loading
     */
    placeholder?: true;
    /** process.hrtime.bigint() when the server turned quiescent after a placeholder was received */
    trustedAt?: bigint;
    /**
     * process.hrtime.bigint() when a publish held as a close window candidate was delivered at
     * the end of the window, absent for a publish delivered on receipt
     */
    acceptedAt?: bigint;
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
    /**
     * how many of `closePublishes` arrived after the reopen and were credited to the close
     * because the server was learned to publish on close. 0 before a close
     */
    closePublishesAfterReopen: number;
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
    /** the tracker's sync count right after the latest didClose, see DiagnosticsTracker.syncs */
    closeSync?: number;
    clears?: number;
    acceptedAtOnce?: boolean;
}

interface ReadState {
    generation: number;
    open: boolean;
    closedAt?: bigint;
    syncs: number;
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
 * right away (`publishes`) or the rule turned off (`silent`). A publish for a closed document
 * teaches `publishes` only when it is empty, the first since the didClose and no other document
 * was synced in between, since servers revalidating dependent documents publish for closed
 * ones too. Some servers clear a closed
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
    private reads = new WeakMap<object, ReadState>();
    /** counts didOpen, didChange and didClose notifications of any document */
    private syncs = 0;
    private _closeBehavior: ClosePublishBehavior = 'unknown';
    private _closeClears: CloseClears = 'unknown';
    private onceStreak = 0;
    private _delivery: DiagnosticsDelivery = 'unknown';
    private _deliveryTentative = false;
    /** whether the server sent a version with a publish for an opened document */
    private versionsPublishes = false;
    private deliveryListeners = new Set<(delivery: DiagnosticsDelivery) => void>();
    /** whether URIs are compared case-insensitively, from the platform */
    private readonly caseInsensitive: boolean;
    /** URI keys already hinted at as matching an open document apart from case */
    private caseHinted = new Set<string>();
    private closeClearHinted = false;
    private malformedPublishWarned = false;
    warn: (msg: string) => void = (msg) => console.error(msg);
    /** whether the server currently reports it is loading, an empty publish then is a placeholder */
    private loading: () => boolean = () => false;

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
            closePublishesAfterReopen: 0,
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
        this.syncs++;
        if (method === 'textDocument/didClose') {
            doc.closeSync = this.syncs;
        }
        this.documents.set(uri, doc);
    }

    noteRead(params: PublishDiagnosticsParams): void {
        if (typeof params?.uri !== 'string') {
            return;
        }
        this.reads.set(params, this.readState(this.documents.get(this.key(params.uri))));
    }

    private readState(doc: TrackedDocument | undefined): ReadState {
        return {
            generation: doc?.generation ?? 0,
            open: doc?.open ?? false,
            closedAt: doc?.closedAt,
            syncs: this.syncs,
        };
    }

    /** Record a publish and hand it to the listeners of its URI, unless it is held as a candidate */
    receive(params: PublishDiagnosticsParams): DiagnosticsPublish {
        const receivedAt = process.hrtime.bigint();
        const key = this.key(params.uri);
        const doc = this.documents.get(key);
        const read = this.reads.get(params) ?? this.readState(doc);
        this.reads.delete(params);
        if (!Array.isArray(params.diagnostics)) {
            if (!this.malformedPublishWarned) {
                this.malformedPublishWarned = true;
                this.warn(
                    `[lsbench] Warning: publishDiagnostics for ${params.uri} has no diagnostics array, taken as empty`,
                );
            }
            params = { ...params, diagnostics: [] };
        }
        let generation = read.generation;
        let tentative = false;
        let clearsClose = false;
        let status: PublishStatus = read.generation === 0 ? 'unopened' : 'current';
        if (status === 'unopened') {
            this.hintCaseMismatch(key, params.uri);
        }
        if (doc && read.generation > 0 && !read.open) {
            status = 'closed';
            clearsClose = params.diagnostics.length === 0;
            doc.closePublishes++;
            const clearing = this.isClearingPublish(params, doc, read.syncs);
            this.learnFromClosedPublish(params, doc, read.syncs);
            if (clearing) {
                this.countClear(params.uri, doc);
            }
        } else if (doc && read.generation > 0 && (read.generation < doc.generation || !doc.open)) {
            if (read.generation < doc.generation) {
                status = 'stale';
            }
            this.log(
                `Publish for ${params.uri} read for generation ${read.generation} before the document was ` +
                    `${doc.open ? 'reopened' : 'closed'}, kept with that generation`,
            );
        } else if (doc?.candidate) {
            // a further publish after the reopen: the candidate was the close publish
            this.log(`Publish for ${params.uri} supersedes the tentative empty publish after didClose`);
            doc.candidate = undefined;
            this.learn('publishes', `a publish superseded the empty one after closing ${params.uri}`);
            this.countClear(params.uri, doc);
        } else if (doc?.closedAt !== undefined && params.diagnostics.length === 0 && params.version === undefined) {
            clearsClose = true;
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
                } else if (doc.acceptedAtOnce) {
                    doc.acceptedAtOnce = false;
                    tentative = true;
                    status = 'close candidate';
                    this.log(
                        `Further empty publish for ${params.uri} ${sinceCloseMs}ms after didClose, ` +
                            'after one was accepted at once: a second clear, held as tentative',
                    );
                    this.learnClears('more', `a second empty publish after reopening ${params.uri}`);
                } else if (this._closeClears === 'once' && doc.clears === 1) {
                    doc.acceptedAtOnce = true;
                    this.log(
                        `Further empty publish for ${params.uri} ${sinceCloseMs}ms after didClose, ` +
                            'accepted at once: the server clears each close once',
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
        if (doc && generation < read.generation) {
            doc.closePublishes++;
            doc.closePublishesAfterReopen++;
            this.countClear(params.uri, doc);
        }
        if (params.version !== undefined && doc && read.generation > 0) {
            this.versionsPublishes = true;
        }
        if (doc?.closedAt !== undefined && read.closedAt === doc.closedAt) {
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
        // an empty publish for an opened document while the server is loading may be a placeholder
        // (rust-analyzer publishes one before it turned quiescent and then only sends refreshes)
        if (
            doc?.open &&
            (status === 'current' || status === 'stale') &&
            params.diagnostics.length === 0 &&
            this.loading()
        ) {
            publish.placeholder = true;
            this.log(`Empty publish for ${params.uri} while the server is not quiescent, a placeholder until it is`);
        }
        // only a publish for a document the client opened shows that the server pushes for the
        // documents it is waited on for, servers may publish for files never opened (ts7 clears
        // tsconfig.json right after the first didOpen) and still answer only pulls for the rest.
        // A stale one (outdated version) counts, a held close window candidate and a placeholder do not
        if (
            this._delivery !== 'push' &&
            !publish.placeholder &&
            (status === 'current' || status === 'closed' || status === 'stale')
        ) {
            if (clearsClose) {
                if (!this.closeClearHinted) {
                    this.closeClearHinted = true;
                    this.log(`Empty publish clearing closed ${params.uri} does not show the server pushes`);
                }
            } else {
                this.log(`Server pushes diagnostics (publish for ${params.uri}), auto waits wait for pushes`);
                this.setDelivery('push', false);
            }
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

    get closeClears(): CloseClears {
        return this._closeClears;
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
     * Learn that the server delivers through pulls from a pull on workspace/diagnostic/refresh
     * that returned diagnostics: settles `pull`, even after `push` was learned, since the
     * server then reports its diagnostics through refreshes (rust-analyzer stops pushing for
     * a document once it was pulled). A later publish for an opened document flips it back
     */
    markPullFromRefresh(reason: string): void {
        if (this._delivery === 'pull' && !this._deliveryTentative) {
            return;
        }
        const was = this._delivery === 'push' ? ', no longer waiting for pushes' : '';
        this.log(`Server delivered diagnostics through ${reason}${was}: pull only, auto waits pull at once`);
        this.setDelivery('pull', false);
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

    /**
     * Mark empty publishes for opened documents received while `loading` returns true as
     * placeholders, see DiagnosticsPublish.placeholder. A placeholder does not teach push
     */
    markPlaceholdersWhile(loading: () => boolean): void {
        this.loading = loading;
    }

    /** Stamp the latest publishes still marked as placeholders as trusted from now, once the server finished loading */
    trustPlaceholders(): void {
        const now = process.hrtime.bigint();
        for (const publish of this.latest.values()) {
            if (publish.placeholder && publish.trustedAt === undefined) {
                publish.trustedAt = now;
            }
        }
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
        const { generation, open, version, syncedAt, syncSeq, syncedBy, closePublishes, closePublishesAfterReopen } =
            doc;
        return { generation, open, version, syncedAt, syncSeq, syncedBy, closePublishes, closePublishesAfterReopen };
    }

    /** The latest publish received for a URI */
    latestPublish(uri: string): DiagnosticsPublish | undefined {
        return this.latest.get(this.key(uri));
    }

    closeWindowEndsAt(uri: string): bigint | undefined {
        const doc = this.documents.get(this.key(uri));
        const closedAt = doc?.closedAt;
        if (closedAt === undefined || this._closeBehavior === 'silent' || doc?.acceptedAtOnce) {
            return undefined;
        }
        return closedAt + BigInt(Math.round(this.closeWindowMs * 1_000_000));
    }

    /** The current sequence number, a publish received after now has a larger seq */
    currentSeq(): number {
        return this.seq;
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
        this._closeClears = 'unknown';
        this.onceStreak = 0;
        this.versionsPublishes = false;
        this.setDelivery('unknown', false);
        this.documents.clear();
        this.latest.clear();
        this.listeners.clear();
        this.caseHinted.clear();
        this.closeClearHinted = false;
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
        doc.closePublishesAfterReopen = 0;
        doc.clears = 0;
        doc.acceptedAtOnce = false;
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
            } else {
                this.learnFromAcceptedCandidate(uri, doc);
            }
            candidate.acceptedAt = process.hrtime.bigint();
            this.deliver(candidate);
        } else if (!doc.publishedSinceClose) {
            this.learn('silent', `no publish for ${uri} within ${this.closeWindowMs}ms of didClose`);
        }
    }

    /**
     * Learn `publishes` from a publish for a closed document only when it is plausibly the
     * close's clearing publish: the first publish since the didClose, within the close window,
     * empty, and with no other document synced since. Servers revalidating dependent documents
     * (Langium on didOpen or didChange of a referencing one) publish for closed documents
     * without clearing them on close, so a publish following another sync proves nothing.
     * It never overrides a learned `silent`
     */
    private learnFromClosedPublish(params: PublishDiagnosticsParams, doc: TrackedDocument, syncs: number): void {
        if (this._closeBehavior !== 'unknown') {
            return;
        }
        if (doc.closedAt === undefined || doc.publishedSinceClose || params.diagnostics.length > 0) {
            return;
        }
        if (doc.closeSync !== syncs) {
            this.log(
                `Publish for ${params.uri} while it is closed follows a sync of another document, ` +
                    'it may be revalidation, not learning that the server publishes on close',
            );
            return;
        }
        this.learn('publishes', `empty publish for ${params.uri} right after its didClose`);
    }

    private isClearingPublish(params: PublishDiagnosticsParams, doc: TrackedDocument, syncs: number): boolean {
        if (doc.closedAt === undefined || params.diagnostics.length > 0 || doc.closeSync !== syncs) {
            return false;
        }
        return !doc.publishedSinceClose || (doc.clears ?? 0) > 0;
    }

    private countClear(uri: string, doc: TrackedDocument): void {
        doc.clears = (doc.clears ?? 0) + 1;
        if (doc.clears > 1) {
            this.learnClears('more', `${doc.clears} publishes cleared closing ${uri}`);
        }
    }

    private learnFromAcceptedCandidate(uri: string, doc: TrackedDocument): void {
        if (this._closeClears !== 'unknown') {
            return;
        }
        if (doc.clears !== 1) {
            this.onceStreak = 0;
            return;
        }
        this.onceStreak++;
        if (this.onceStreak >= CLOSE_CLEARS_ONCE_STREAK) {
            this.learnClears('once', `${this.onceStreak} closes in a row cleared by one publish, the latest of ${uri}`);
        }
    }

    private learnClears(clears: Exclude<CloseClears, 'unknown'>, reason: string): void {
        if (this._closeClears === clears || this._closeClears === 'more') {
            return;
        }
        this._closeClears = clears;
        this.log(
            clears === 'once'
                ? `Server clears each close once (${reason}), further empty publishes after a reopen are accepted at once`
                : `Server may clear a close more than once (${reason}), further empty publishes after a reopen are not accepted at once`,
        );
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

/**
 * Let `diagnostics` mark empty publishes as placeholders while the server reports
 * experimental/serverStatus quiescent:false, and trust them once it no longer is busy. Only
 * the server status counts (not $/progress), so other push servers are not affected. Call it
 * before any wait subscribes to `progress`, so placeholders are trusted before waits hear of it
 */
export function linkPlaceholders(diagnostics: DiagnosticsTracker, progress: ProgressTracker): void {
    diagnostics.markPlaceholdersWhile(() => progress.serverStatus?.quiescent === false);
    progress.onNotBusy(() => diagnostics.trustPlaceholders());
}

/** default time to wait for a shutdown reply before giving up on the server */
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5000;
const KILL_WAIT_MS = 3000;
const KILL_TIMEOUT_REASON = 'did not exit after SIGKILL';
export const DEFAULT_CONNECT_TIMEOUT_MS = 10000;
const CONNECT_RETRY_MS = 100;
const CLOSE_EXIT_WAIT_MS = 200;
const SOCKET_CLOSE_WAIT_MS = 500;
const LISTEN_HOST = '127.0.0.1';

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
    /** record every message exchanged with the server to this trace, shared across restarts */
    trace?: WireTrace;
    setup?: SetupScript;
    quiet?: boolean;
}

/**
 * Manages a language server process and its JSON-RPC connection.
 */
export class LspHarness {
    private process: cp.ChildProcess | null = null;
    private socket: net.Socket | null = null;
    private closingSocket = false;
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
    private shutdownSent = false;
    private shutdownErrored = false;
    /** set once we signal the process, so the resulting exit is not abnormal */
    private readonly sentSignals = new Set<NodeJS.Signals>();
    /** set while stop() runs, an exit then is part of our own shutdown */
    private stopping = false;
    /** set once the server exited outside stop(), requests and notifications then fail with it */
    private exitError: Error | null = null;
    private writeFailed: Promise<Error> = new Promise(() => {});
    /** rejecters of the requests sent through sendRequest still awaiting a reply */
    private pendingRequests = new Set<(err: Error) => void>();
    /** lifecycle timings (spawn, initialize, shutdown) not yet taken by the runner */
    private lifecycleTimings: RequestTiming[] = [];
    /** ServerConfig.settings with dotted keys expanded, undefined when none are given */
    private settings: Record<string, unknown> | undefined;
    /** routes server stderr and log messages to the server log file or the console */
    private output: ServerOutput;
    /** records the messages exchanged with the server, when tracing */
    private trace: WireTrace | undefined;
    /** called on each workspace/diagnostic/refresh from the server */
    private refreshListeners = new Set<() => void>();
    private setup: SetupScript | undefined;

    constructor(
        private config: ServerConfig,
        private workspaceRoot: string,
        verbose = false,
        options: LspHarnessOptions = {},
    ) {
        this.verbose = verbose;
        this.settings = config.settings ? expandSettings(config.settings) : undefined;
        this.output = new ServerOutput(options.serverLog, verbose);
        this.trace = options.trace;
        this.setup = options.setup;
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
        if (options.quiet) {
            this.diagnostics.warn = () => {};
        }
        linkPlaceholders(this.diagnostics, this.progress);
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

    changeSyncKind(): ChangeSyncKind {
        let dynamic: ChangeSyncKind | null = null;
        for (const reg of this._registrations.values()) {
            if (reg.method === 'textDocument/didChange') {
                const syncKind = toChangeSyncKind(
                    (reg.registerOptions as { syncKind?: unknown } | undefined)?.syncKind,
                );
                if (syncKind !== null && (dynamic === null || CHANGE_SYNC_RANK[syncKind] > CHANGE_SYNC_RANK[dynamic])) {
                    dynamic = syncKind;
                }
            }
        }
        return dynamic ?? staticChangeSyncKind(this._capabilities?.textDocumentSync);
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
        const { env } = this.config;
        const transport: ServerTransport = this.config.transport ?? { kind: 'stdio' };
        if (this.config.command === undefined && transport.kind !== 'connect') {
            throw new Error('a server command is required unless the transport is connect');
        }

        this._exit = null;
        this.shutdownReplied = false;
        this.shutdownSent = false;
        this.shutdownErrored = false;
        this.sentSignals.clear();
        this.stopping = false;
        this.exitError = null;
        this.socket = null;
        this.closingSocket = false;

        let listener: SocketListener | null = null;
        let port: number | undefined;
        if (transport.kind === 'socket') {
            listener = await listenForServer(transport.port);
            port = listener.port;
        } else if (transport.kind === 'connect') {
            port = transport.port;
        }
        const fillPort = (value: string) => (port === undefined ? value : value.replaceAll('{port}', String(port)));
        const command = this.config.command === undefined ? undefined : fillPort(this.config.command);
        const args = (this.config.args ?? []).map(fillPort);
        const endpoint =
            transport.kind === 'stdio'
                ? undefined
                : `${transport.kind} ${transport.kind === 'connect' ? transport.host : LISTEN_HOST}:${port}`;

        if (command === undefined) {
            this.log(`Connecting: ${endpoint}`);
        } else {
            this.log(`Spawning: ${command} ${args.join(' ')}${endpoint ? ` (${endpoint})` : ''}`);
        }
        this.output.open(command ?? String(endpoint), command === undefined ? [] : args);
        this.trace?.spawn(command, args, endpoint);
        const spawnStart = process.hrtime.bigint();

        // spawn from the current working directory, not the workspace: the server
        // command may be a path relative to cwd, while the workspace is communicated
        // to the server via rootUri/workspaceFolders in the initialize params below
        const child =
            command === undefined
                ? null
                : cp.spawn(command, args, {
                      stdio: ['pipe', 'pipe', 'pipe'],
                      env: { ...process.env, ...env },
                  });
        this.process = child;
        let onSocketClosed: () => void = () => {};
        const socketClosed = new Promise<void>((resolve) => {
            onSocketClosed = resolve;
        });
        const spawned = child
            ? new Promise<void>((resolve) => child.once('spawn', () => resolve()))
            : Promise.resolve();
        const gone = child
            ? new Promise<void>((resolve) => {
                  child.once('exit', () => resolve());
                  // a process that failed to spawn never emits exit
                  child.once('error', () => {
                      if (child.pid === undefined) {
                          resolve();
                      }
                  });
              })
            : socketClosed;
        this.exited = gone;

        // reject the initialize handshake if the process dies or fails to spawn,
        // otherwise sendRequest('initialize') hangs forever with no response
        let onEarlyExit: (reason: Error) => void = () => {};
        const earlyExit = new Promise<never>((_, reject) => {
            onEarlyExit = reject;
        });

        let stderrTail = '';
        let rpcInput: Readable | null = transport.kind === 'stdio' ? (child?.stdout ?? null) : null;
        let closedExit: ServerExit | null = null;

        if (child) {
            // capture stderr, and retain the tail so we can report it if the server dies
            child.stderr?.on('data', (chunk: Buffer) => {
                const text = chunk.toString();
                stderrTail = (stderrTail + text).slice(-4000);
                this.output.stderr(text);
            });
            child.stderr?.on('end', () => this.output.flush());
            if (transport.kind !== 'stdio') {
                child.stdout?.on('data', (chunk: Buffer) => this.output.stdout(chunk.toString()));
                child.stdout?.on('end', () => this.output.flush());
            }

            child.on('error', (err) => {
                if (child.pid === undefined) {
                    this._exit = {
                        code: null,
                        signal: null,
                        abnormal: true,
                        reason: `failed to spawn (${err.message})`,
                    };
                }
                onEarlyExit(new Error(`Server process failed to spawn: ${err.message}`));
            });

            child.on('exit', (code, signal) => {
                this.log(`Server exited: code=${code} signal=${signal}`);
                const described = this.describeExit(code, signal);
                const keep =
                    this._exit?.reason === KILL_TIMEOUT_REASON ||
                    (this._exit !== null && this._exit === closedExit && !described.abnormal);
                if (!keep) {
                    this._exit = described;
                }
                const reason = this._exit?.reason ?? described.reason;
                const rejectStart = () =>
                    onEarlyExit(
                        new Error(
                            `Server exited before initialize (code=${code} signal=${signal}).` +
                                (stderrTail ? `\nServer stderr:\n${stderrTail}` : ''),
                        ),
                    );
                if (this.stopping) {
                    rejectStart();
                } else {
                    this.failPendingRequests([rpcInput, child.stderr], `server ${reason}`, rejectStart);
                }
            });
        }

        const connectionClosed = async () => {
            this.log('Server connection closed');
            if (child) {
                if (this.stopping || hasExited(child)) {
                    return;
                }
                await raceTimeout([gone], CLOSE_EXIT_WAIT_MS);
                if (this.stopping || hasExited(child)) {
                    return;
                }
            }
            if (this._exit) {
                return;
            }
            const exit = this.describeClose();
            closedExit = exit;
            this._exit = exit;
            const rejectStart = () =>
                onEarlyExit(
                    new Error(
                        'Server closed the connection before initialize.' +
                            (stderrTail ? `\nServer stderr:\n${stderrTail}` : ''),
                    ),
                );
            if (this.stopping) {
                rejectStart();
            } else {
                this.failPendingRequests([], `server ${exit.reason}`, rejectStart);
            }
        };

        let onWriteFailure: (err: Error) => void = () => {};
        const writeFailed = new Promise<Error>((resolve) => {
            onWriteFailure = resolve;
        });
        this.writeFailed = writeFailed;
        let writeError: Error | null = null;
        const failWrites = (err: unknown) => {
            if (writeError) {
                return;
            }
            const error = new Error(`cannot write to server: ${errorMessage(err)}`);
            writeError = error;
            this.log(error.message);
            onWriteFailure(error);
            void raceTimeout([this.exited], 200).then(() => {
                if (this.writeFailed !== writeFailed || this.exitError || this._exit) {
                    return;
                }
                this.exitError = error;
                const pending = [...this.pendingRequests];
                this.pendingRequests.clear();
                for (const reject of pending) {
                    reject(error);
                }
            });
        };

        let input: NodeJS.ReadableStream;
        let output: NodeJS.WritableStream;
        if (transport.kind === 'stdio') {
            input = child!.stdout!;
            output = child!.stdin!;
        } else {
            const timeoutMs = transport.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
            const open = (signal: AbortSignal): Promise<net.Socket> => {
                if (listener) {
                    return acceptServer(listener, timeoutMs, signal);
                }
                const host = transport.kind === 'connect' ? transport.host : LISTEN_HOST;
                return connectToServer(host, port ?? 0, timeoutMs, signal);
            };
            let socket: net.Socket;
            try {
                if (child) {
                    await this.timeSpawn(spawned, earlyExit, spawnStart);
                }
                socket = await this.openSocket(open, earlyExit);
            } catch (err: unknown) {
                const failure = await this.preferExitError(err, earlyExit);
                await this.abortStart(child);
                throw failure;
            } finally {
                listener?.close();
            }
            socket.setNoDelay(true);
            socket.on('error', (err) => this.log(`Server connection error: ${err.message}`));
            socket.once('close', () => {
                onSocketClosed();
                void connectionClosed();
            });
            this.socket = socket;
            rpcInput = socket;
            input = socket;
            output = socket;
        }

        const trace = this.trace;
        const wireLog = this.verbose ? new WireLog(this.workspaceRoot, (line) => this.log(line)) : undefined;
        const diagnostics = this.diagnostics;
        this.connection = rpc.createMessageConnection(
            new ObservedMessageReader(input, (msg) => {
                trace?.message('in', msg);
                wireLog?.message('in', msg);
                if (rpc.Message.isNotification(msg) && msg.method === 'textDocument/publishDiagnostics') {
                    diagnostics.noteRead(msg.params as PublishDiagnosticsParams);
                }
            }),
            new SettledMessageWriter(
                trace || wireLog
                    ? new ObservedMessageWriter(output, (msg) => {
                          trace?.message('out', msg);
                          wireLog?.message('out', msg);
                      })
                    : new rpc.StreamMessageWriter(output),
                failWrites,
            ),
        );

        this.connection.listen();

        const connection = this.connection;
        const builtIn = new Set<string>();
        const onNotification = (method: string, handler: rpc.GenericNotificationHandler) => {
            builtIn.add(method);
            connection.onNotification(method, handler);
        };
        const onRequest = (method: string, handler: rpc.GenericRequestHandler<unknown, unknown>) => {
            builtIn.add(method);
            connection.onRequest(method, handler);
        };

        // Subscribe to diagnostics notifications
        onNotification('textDocument/publishDiagnostics', (params: PublishDiagnosticsParams) => {
            this.diagnostics.receive(params);
        });

        // route the server's own log output with its stderr
        onNotification('window/logMessage', (params: { type: number; message: string }) => {
            this.output.message(params.message);
        });
        onNotification('window/showMessage', (params: { type: number; message: string }) => {
            this.output.message(`showMessage: ${params.message}`);
        });
        onNotification('$/logTrace', (params: { message: string; verbose?: string }) => {
            this.output.message(`trace: ${params.message}${params.verbose ? `\n${params.verbose}` : ''}`);
        });

        const workspaceUri = pathToUri(this.workspaceRoot);
        const workspaceFolders = [{ uri: workspaceUri, name: path.basename(this.workspaceRoot) }];
        onRequest('workspace/workspaceFolders', () => workspaceFolders);

        // answer workspace/configuration from the settings, or {} per item when none are given
        onRequest('workspace/configuration', (params: { items: Array<{ section?: string }> }) => {
            const settings = this.settings;
            return params.items.map((item) => {
                if (!settings) {
                    return {};
                }
                return resolveConfigurationSection(settings, item.section);
            });
        });

        // acknowledge pull diagnostic refresh requests, pending auto diagnostics waits pull on them
        onRequest('workspace/diagnostic/refresh', () => {
            this.log('Server requested workspace/diagnostic/refresh');
            for (const listener of this.refreshListeners) {
                listener();
            }
            return null;
        });

        // acknowledge refresh requests, we hold no cached state to invalidate
        const noOpRequests = [
            'workspace/semanticTokens/refresh',
            'workspace/inlayHint/refresh',
            'workspace/codeLens/refresh',
            'workspace/inlineValue/refresh',
        ];
        for (const method of noOpRequests) {
            onRequest(method, () => null);
        }

        // track work done progress and rust-analyzer's server status for idle waits
        onRequest('window/workDoneProgress/create', (params: { token: ProgressToken }) => {
            this.progress.create(params.token);
            return null;
        });
        onNotification('$/progress', (params: ProgressParams) => {
            this.progress.progress(params);
        });
        onNotification('experimental/serverStatus', (params: ServerStatusParams) => {
            this.progress.serverStatusChanged(params);
        });

        // accept and remember all dynamic registrations
        onRequest('client/registerCapability', (params: { registrations?: Registration[] }) => {
            for (const reg of params.registrations ?? []) {
                this._registrations.set(reg.id, reg);
                this.log(`Registered ${reg.method}`);
            }
        });

        // the LSP spec really does spell this field 'unregisterations'
        onRequest('client/unregisterCapability', (params: { unregisterations?: Registration[] }) => {
            for (const reg of params.unregisterations ?? []) {
                this._registrations.delete(reg.id);
            }
        });

        // no user is present to pick an action, so dismiss the prompt
        onRequest('window/showMessageRequest', (params: { type: number; message: string }) => {
            this.log(`Dismissed window/showMessageRequest: ${params.message}`);
            return null;
        });

        // lsbench never mutates the workspace on the server's behalf
        onRequest('workspace/applyEdit', (params: { label?: string }) => {
            this.log(`Declined workspace/applyEdit${params.label ? `: ${params.label}` : ''}`);
            return { applied: false, failureReason: 'lsbench does not apply workspace edits' };
        });

        const scriptNotifications = new Map<string, (params: unknown) => void | Promise<void>>();
        const scriptRequests = new Map<string, (params: unknown) => unknown>();
        this.routeScriptMessages(connection, scriptNotifications, scriptRequests);

        try {
            if (transport.kind === 'stdio') {
                await this.timeSpawn(spawned, earlyExit, spawnStart);
            }

            if (this.setup) {
                const reserve = (kind: string, method: string) => {
                    if (builtIn.has(method)) {
                        throw new Error(`setup cannot handle the ${kind} ${method}, lsbench handles it itself`);
                    }
                };
                const client: ClientHooks = {
                    onNotification: (method, handler) => {
                        reserve('notification', method);
                        scriptNotifications.set(method, handler);
                    },
                    onRequest: (method, handler) => {
                        reserve('request', method);
                        scriptRequests.set(method, handler);
                    },
                    notify: (method, params) => this.sendNotification(method, params),
                };
                await Promise.race([Promise.resolve(this.setup(client)), earlyExit]);
            }

            // Perform LSP initialize
            const initParams = {
                processId: process.pid,
                rootUri: workspaceUri,
                rootPath: this.workspaceRoot,
                workspaceFolders,
                // defaults, then the pull capability when opted in, then the configured capabilities, so those win
                capabilities: mergeCapabilities(
                    this.config.advertisePullDiagnostics
                        ? mergeCapabilities(defaultClientCapabilities(), pullDiagnosticClientCapabilities())
                        : defaultClientCapabilities(),
                    this.config.clientCapabilities ?? {},
                ),
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
                    writeFailed.then((err) => Promise.reject(err)),
                ])) as InitializeResult;
                if (typeof result !== 'object' || result === null) {
                    throw new Error(`invalid initialize result: ${JSON.stringify(result)}`);
                }
                this.recordLifecycle('lifecycle/initialize', initStart);
            } catch (err: unknown) {
                this.recordLifecycle('lifecycle/initialize', initStart, err);
                throw err;
            }
            this._capabilities = result.capabilities;

            // Send initialized notification
            this.connection.sendNotification('initialized', {}).catch((err: unknown) => {
                this.log(`Failed to send initialized: ${errorMessage(err)}`);
            });
            this.log('Server initialized.');

            // push the settings once, for servers that read them from didChangeConfiguration
            if (this.settings) {
                this.log(`Sending workspace/didChangeConfiguration: ${JSON.stringify(this.settings)}`);
                this.connection
                    .sendNotification('workspace/didChangeConfiguration', { settings: this.settings })
                    .catch((err: unknown) => {
                        this.log(`Failed to send workspace/didChangeConfiguration: ${errorMessage(err)}`);
                    });
            }
        } catch (err: unknown) {
            const failure = await this.preferExitError(err, earlyExit);
            await this.abortStart(child);
            throw failure;
        }
    }

    private async timeSpawn(spawned: Promise<void>, earlyExit: Promise<never>, spawnStart: bigint): Promise<void> {
        try {
            await Promise.race([spawned, earlyExit]);
            this.recordLifecycle('lifecycle/spawn', spawnStart);
        } catch (err: unknown) {
            this.recordLifecycle('lifecycle/spawn', spawnStart, err);
            throw err;
        }
    }

    private async openSocket(
        open: (signal: AbortSignal) => Promise<net.Socket>,
        earlyExit: Promise<never>,
    ): Promise<net.Socket> {
        const connectStart = process.hrtime.bigint();
        const abort = new AbortController();
        const opening = open(abort.signal);
        try {
            const socket = await Promise.race([opening, earlyExit]);
            this.recordLifecycle('lifecycle/connect', connectStart);
            return socket;
        } catch (err: unknown) {
            this.recordLifecycle('lifecycle/connect', connectStart, err);
            abort.abort();
            void opening.then(
                (socket) => socket.destroy(),
                () => {},
            );
            throw err;
        }
    }

    private async preferExitError(err: unknown, earlyExit: Promise<never>): Promise<unknown> {
        if (err instanceof rpc.ResponseError && err.code !== rpc.ErrorCodes.MessageWriteError) {
            return err;
        }
        await raceTimeout([this.exited], 100);
        if (!this._exit) {
            return err;
        }
        const exitError = await raceTimeout([earlyExit.catch((e: unknown) => e)], 300);
        return exitError === 'timeout' ? err : exitError;
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
            this.shutdownSent = true;
            const shutdown = connection.sendRequest('shutdown').then(
                () => {
                    this.shutdownReplied = true;
                    return 'replied' as const;
                },
                (err: unknown) => {
                    if (
                        err instanceof rpc.ResponseError &&
                        err.code !== rpc.ErrorCodes.MessageWriteError &&
                        err.code !== rpc.ErrorCodes.PendingResponseRejected
                    ) {
                        this.shutdownErrored = true;
                    }
                    return 'failed' as const;
                },
            );
            const outcome = await raceTimeout(
                [shutdown, this.writeFailed.then(() => 'failed' as const), this.exited.then(() => 'exited' as const)],
                timeoutMs,
            );
            // time shutdown from request to reply, or to however it failed
            const shutdownErrors = {
                replied: undefined,
                failed: new Error('shutdown request failed'),
                exited: new Error('server exited before replying to shutdown'),
                timeout: new Error(`no shutdown reply within ${timeoutMs}ms`),
            };
            const toleratedExit = outcome !== 'timeout' && this.exit?.tolerated === true;
            const shutdownError = toleratedExit ? undefined : shutdownErrors[outcome];
            this.recordLifecycle('lifecycle/shutdown', shutdownStart, shutdownError);
            if (outcome === 'replied' || outcome === 'failed') {
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

        if (child) {
            await this.killChild(child);
        }
        if (this.socket) {
            await this.closeSocket(this.socket);
        }
        this.socket = null;
        this.process = null;
        await this.output.close();
        this.clearServerState();
        return this._exit;
    }

    private async closeSocket(socket: net.Socket): Promise<void> {
        if (socket.destroyed) {
            return;
        }
        this.closingSocket = true;
        const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
        socket.end();
        if ((await raceTimeout([closed], SOCKET_CLOSE_WAIT_MS)) === 'timeout') {
            socket.destroy();
            await closed;
        }
    }

    private async abortStart(child: cp.ChildProcess | null): Promise<void> {
        this.stopping = true;
        try {
            if (child) {
                await this.killChild(child);
            }
            this.connection?.dispose();
            this.connection = null;
            if (this.socket) {
                this.closingSocket = true;
                this.socket.destroy();
                this.socket = null;
            }
            this.process = null;
            await this.output.close();
            this.clearServerState();
        } catch (err: unknown) {
            this.log(`Cleanup after a failed start failed: ${errorMessage(err)}`);
        }
    }

    private async killChild(child: cp.ChildProcess): Promise<void> {
        if (child.pid === undefined || hasExited(child) || this._exit?.reason === KILL_TIMEOUT_REASON) {
            return;
        }
        this.sentSignals.add('SIGTERM');
        child.kill('SIGTERM');
        // force kill a server that ignores SIGTERM, `killed` only reports that a
        // signal was sent, so check the recorded exit instead
        if ((await raceTimeout([this.exited], 3000)) === 'timeout') {
            this.sentSignals.add('SIGKILL');
            child.kill('SIGKILL');
            if ((await raceTimeout([this.exited], KILL_WAIT_MS)) === 'timeout' && !hasExited(child)) {
                this.log(`Server pid ${child.pid} did not exit within ${KILL_WAIT_MS}ms of SIGKILL, leaving it`);
                if (!this._exit?.abnormal) {
                    this._exit = { code: null, signal: null, abnormal: true, reason: KILL_TIMEOUT_REASON };
                }
            }
        }
    }

    private clearServerState(): void {
        this.diagnostics.clear();
        this.progress.clear();
        this._registrations.clear();
    }

    /**
     * After an exit outside stop(), fail new requests and notifications at once, and the
     * requests awaiting a reply once the server's output is drained, since vscode-jsonrpc
     * rejects them only on dispose. A reply written just before the exit still arrives
     */
    private failPendingRequests(streams: Array<Readable | null>, message: string, beforeFail?: () => void): void {
        const error = new Error(message);
        this.exitError = error;
        const connection = this.connection;
        const cleanups: Array<() => void> = [];
        const drain = (stream: Readable | null) =>
            new Promise<void>((resolve) => {
                if (!stream || stream.readableEnded || stream.destroyed) {
                    resolve();
                    return;
                }
                const done = () => resolve();
                stream.once('end', done);
                stream.once('close', done);
                cleanups.push(() => {
                    stream.off('end', done);
                    stream.off('close', done);
                });
            });
        const drained = Promise.all(streams.map(drain)).then(() => undefined);
        // a grandchild may keep stdout open, so do not wait on it for long
        void raceTimeout([drained], 200).then(() => {
            for (const cleanup of cleanups) {
                cleanup();
            }
            beforeFail?.();
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
            duration_ms: round(ms),
            success: error === undefined,
            // lifecycle steps have no meaningful payload (shutdown even replies null by spec)
            result: error === undefined ? 'ok' : 'error',
        };
        if (error !== undefined) {
            timing.error = errorMessage(error).split('\n')[0];
        }
        this.lifecycleTimings.push(timing);
    }

    private describeClose(): ServerExit {
        const closed = { code: null, signal: null };
        if (this.closingSocket) {
            return { ...closed, abnormal: false, reason: 'disconnected by lsbench' };
        }
        if (this.shutdownReplied) {
            return { ...closed, abnormal: false, reason: 'closed the connection after shutdown' };
        }
        if (this.shutdownErrored) {
            return { ...closed, abnormal: false, reason: 'closed the connection after failed shutdown' };
        }
        if (this.shutdownSent && this.config.allowUnrepliedShutdown) {
            return {
                ...closed,
                abnormal: false,
                tolerated: true,
                reason: 'closed the connection after unreplied shutdown (allowed)',
            };
        }
        return { ...closed, abnormal: true, reason: 'closed the connection unexpectedly' };
    }

    /** Classify a process exit, signals we sent and a clean (or allowed) exit after shutdown are normal */
    private describeExit(code: number | null, signal: NodeJS.Signals | null): ServerExit {
        const status = signal ? `signal ${signal}` : `code ${code}`;
        const killed = signal === null ? this.sentSignals.size > 0 : this.sentSignals.has(signal);
        if (killed) {
            return { code, signal, abnormal: false, reason: `killed by lsbench (${status})` };
        }
        if (this.shutdownErrored) {
            if (signal === null && (code === 0 || code === 1)) {
                return { code, signal, abnormal: false, reason: `exited after failed shutdown with ${status}` };
            }
            if (this.isAllowedExit(code, signal)) {
                return {
                    code,
                    signal,
                    abnormal: false,
                    tolerated: true,
                    reason: `exited after failed shutdown with ${status} (allowed)`,
                };
            }
            return { code, signal, abnormal: true, reason: `exited after failed shutdown with ${status}` };
        }
        if (!this.shutdownReplied) {
            const unrepliedAllowed =
                this.shutdownSent &&
                this.config.allowUnrepliedShutdown &&
                ((signal === null && code === 0) || this.isAllowedExit(code, signal));
            if (unrepliedAllowed) {
                return {
                    code,
                    signal,
                    abnormal: false,
                    tolerated: true,
                    reason: `exited after unreplied shutdown with ${status} (allowed)`,
                };
            }
            return { code, signal, abnormal: true, reason: `exited unexpectedly (${status})` };
        }
        if (this.isAllowedExit(code, signal)) {
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

    private isAllowedExit(code: number | null, signal: NodeJS.Signals | null): boolean {
        if (signal !== null) {
            return this.config.allowExitSignals?.includes(signal) ?? false;
        }
        return code !== null && code !== 0 && (this.config.allowExitCodes?.includes(code) ?? false);
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

    closeWindowEndsAt(uri: string): bigint | undefined {
        return this.diagnostics.closeWindowEndsAt(uri);
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

    /** Learn pull from a pull on refresh that returned diagnostics, see DiagnosticsTracker.markPullFromRefresh */
    markPullFromRefresh(reason: string): void {
        this.diagnostics.markPullFromRefresh(reason);
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

    /** Whether the latest experimental/serverStatus reports quiescent:false, false when none arrived */
    isServerNotQuiescent(): boolean {
        return this.progress.serverStatus?.quiescent === false;
    }

    /** Call `listener` whenever the server stops being busy, see ProgressTracker.onNotBusy */
    onServerNotBusy(listener: () => void): () => void {
        return this.progress.onNotBusy(listener);
    }

    /** Call `listener` on each workspace/diagnostic/refresh from the server, returns a function removing it */
    onDiagnosticRefresh(listener: () => void): () => void {
        this.refreshListeners.add(listener);
        return () => this.refreshListeners.delete(listener);
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
            duration_ms: round(result.ms),
            success: !result.timedOut,
            result: result.timedOut ? 'timeout' : 'ok',
        });
        this.log(`Server ${result.timedOut ? 'not idle' : 'idle'} after ${result.ms.toFixed(1)}ms`);
        return result;
    }

    /** Send a typed LSP request */
    sendRequest<R>(method: string, params: unknown, token?: rpc.CancellationToken): Promise<R> {
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
                request = token ? this.conn.sendRequest(method, params, token) : this.conn.sendRequest(method, params);
            } catch (err: unknown) {
                fail(err);
                return;
            }
            if (token) {
                const cancelled = () => fail(new Error(`${method} cancelled`));
                if (token.isCancellationRequested) {
                    cancelled();
                } else {
                    token.onCancellationRequested(cancelled);
                }
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

    private routeScriptMessages(
        connection: rpc.MessageConnection,
        notifications: Map<string, (params: unknown) => void | Promise<void>>,
        requests: Map<string, (params: unknown) => unknown>,
    ): void {
        const unhandled = new Set<string>();
        const logUnhandled = (kind: string, method: string) => {
            if (!unhandled.has(method)) {
                unhandled.add(method);
                this.log(`Unhandled ${kind} ${method} from the server, a script's setup can handle it`);
            }
        };
        connection.onNotification((method, params) => {
            const handler = notifications.get(method);
            if (!handler) {
                logUnhandled('notification', method);
                return;
            }
            const failed = (err: unknown) => this.log(`setup handler for ${method} failed: ${errorMessage(err)}`);
            try {
                Promise.resolve(handler(params)).catch(failed);
            } catch (err: unknown) {
                failed(err);
            }
        });
        connection.onRequest((method, params) => {
            const handler = requests.get(method);
            if (!handler) {
                logUnhandled('request', method);
                return new rpc.ResponseError(rpc.ErrorCodes.MethodNotFound, `Unhandled method ${method}`);
            }
            return handler(params);
        });
    }

    /** Send an LSP notification, throwing once the server has exited outside stop() */
    sendNotification(method: string, params: unknown): void {
        if (this.exitError) {
            throw new Error(`cannot send ${method}: ${this.exitError.message}`);
        }
        // a write to a server that just closed its input rejects, which is not ours to surface
        this.conn.sendNotification(method, params).catch((err: unknown) => {
            this.log(`Failed to send ${method}: ${errorMessage(err)}`);
        });
        this.diagnostics.noteNotification(method, params);
    }

    private log(msg: string): void {
        if (this.verbose) {
            console.error(`${prefix('lsbench')} ${msg}`);
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
            // lsbench acknowledges workspace/diagnostic/refresh and makes pending auto waits pull on it
            diagnostics: { refreshSupport: true },
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
            // textDocument.diagnostic is not advertised by default: servers built on
            // vscode-languageserver (the VS Code CSS, HTML and JSON servers, ESLint) stop pushing
            // when it is present, which would turn push timings into pull timings. Servers that
            // advertise diagnosticProvider anyway are pulled by waitForDiagnostics in auto mode.
            // ServerConfig.advertisePullDiagnostics adds it, see pullDiagnosticClientCapabilities
            publishDiagnostics: {
                relatedInformation: true,
                tagSupport: { valueSet: [1, 2] },
            },
        },
    };
}

/**
 * The pull diagnostics client capability, merged over the defaults when
 * ServerConfig.advertisePullDiagnostics is set (--advertise-pull).
 */
export function pullDiagnosticClientCapabilities(): Record<string, unknown> {
    return {
        textDocument: { diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false } },
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

const LANGUAGE_OVERRIDE_KEY = /^(?:\[[^\]]+\])+$/;
const DOTTED_LANGUAGE_OVERRIDE_KEY = /^((?:\[[^\]]+\])+)\.(.+)$/;

/**
 * Expands dotted keys into nested objects at every level, as VS Code does for
 * settings.json: { "html.format": { "enable": true } } becomes { html: { format: { enable: true } } }.
 * Keys meeting at the same path deep merge; on a conflict a key without dots wins
 * over a dotted one. The input is not mutated.
 */
export function expandSettings(settings: Record<string, unknown>): Record<string, unknown> {
    return expandSettingsLevel(settings, true);
}

function expandSettingsLevel(settings: Record<string, unknown>, topLevel: boolean): Record<string, unknown> {
    const dotted: Array<[string, unknown]> = [];
    const plain: Array<[string, unknown]> = [];
    for (const entry of Object.entries(settings)) {
        const isOverride = topLevel && LANGUAGE_OVERRIDE_KEY.test(entry[0]);
        (entry[0].includes('.') && !isOverride ? dotted : plain).push(entry);
    }
    // dotted keys go in first so plain keys merge over them
    const result: Record<string, unknown> = {};
    for (const [key, value] of [...dotted, ...plain]) {
        const override = topLevel ? languageOverrideEntry(key, value) : undefined;
        if (override) {
            mergeLanguageOverride(result, override[0], override[1]);
            continue;
        }
        const segments = key.split('.');
        const last = segments.pop() as string;
        let target = result;
        for (const segment of segments) {
            if (!isPlainObject(target[segment])) {
                target[segment] = {};
            }
            target = target[segment] as Record<string, unknown>;
        }
        const expanded = isPlainObject(value) ? expandSettingsLevel(value, false) : value;
        const current = target[last];
        if (isPlainObject(current) && isPlainObject(expanded)) {
            target[last] = mergeCapabilities(current, expanded);
        } else {
            target[last] = expanded;
        }
    }
    return result;
}

function languageOverrideEntry(key: string, value: unknown): [string, unknown] | undefined {
    if (LANGUAGE_OVERRIDE_KEY.test(key)) {
        return [key, value];
    }
    const match = DOTTED_LANGUAGE_OVERRIDE_KEY.exec(key);
    if (match) {
        return [match[1], { [match[2]]: value }];
    }
    return undefined;
}

function mergeLanguageOverride(result: Record<string, unknown>, section: string, value: unknown): void {
    const current = result[section];
    if (isPlainObject(current) && isPlainObject(value)) {
        result[section] = { ...current, ...value };
    } else {
        result[section] = isPlainObject(value) ? { ...value } : value;
    }
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

export type ChangeSyncKind = 0 | 1 | 2;

const CHANGE_SYNC_RANK: Record<ChangeSyncKind, number> = { 0: 0, 2: 1, 1: 2 };

function toChangeSyncKind(value: unknown): ChangeSyncKind | null {
    return value === 0 || value === 1 || value === 2 ? value : null;
}

const UNDECLARED_CHANGE_SYNC_KIND: ChangeSyncKind = 2;

function staticChangeSyncKind(sync: unknown): ChangeSyncKind {
    if (typeof sync === 'number') {
        return toChangeSyncKind(sync) ?? UNDECLARED_CHANGE_SYNC_KIND;
    }
    if (typeof sync === 'object' && sync !== null) {
        return toChangeSyncKind((sync as { change?: unknown }).change) ?? UNDECLARED_CHANGE_SYNC_KIND;
    }
    return UNDECLARED_CHANGE_SYNC_KIND;
}

function hasIncludeText(options: unknown): boolean {
    return (
        typeof options === 'object' && options !== null && (options as { includeText?: unknown }).includeText === true
    );
}

/** Convert an absolute file path to a file:// URI */
export function pathToUri(filePath: string): string {
    return pathToFileURL(path.resolve(filePath)).href;
}

/** Convert a file:// URI back to an absolute path */
export function uriToPath(uri: string): string {
    if (uri.startsWith('file:')) {
        try {
            return fileURLToPath(uri);
        } catch {
            return uri;
        }
    }
    return uri;
}

function displayUri(uri: string, workspaceRoot: string): string {
    const filePath = uriToPath(uri);
    if (uri.startsWith('file://') && filePath !== uri) {
        const rel = path.relative(path.resolve(workspaceRoot), filePath);
        if (rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)) {
            return rel;
        }
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
    const where = displayUri(publish.uri, workspaceRoot);
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
    private stdoutPartial = '';

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
            if (this.stream === stream) {
                this.stream = null;
            }
        });
        this.stream = stream;
        stream.write(`${formatServerLogHeader(command, args)}\n`);
    }

    /** A raw stderr chunk, possibly ending mid line */
    stderr(chunk: string): void {
        this.partial = this.writeComplete(this.partial + chunk);
    }

    stdout(chunk: string): void {
        this.stdoutPartial = this.writeComplete(this.stdoutPartial + chunk);
    }

    /** A complete message, which may span lines */
    message(text: string): void {
        this.write(text);
    }

    /** Write out a held partial stderr line */
    flush(): void {
        const text = [this.partial, this.stdoutPartial].filter(Boolean).join('\n');
        this.partial = '';
        this.stdoutPartial = '';
        if (text) {
            this.write(text);
        }
    }

    /** Flush and end the file stream, resolving once it is written */
    close(): Promise<void> {
        this.flush();
        const stream = this.stream;
        this.stream = null;
        return endStream(stream);
    }

    private writeComplete(text: string): string {
        const end = text.lastIndexOf('\n');
        if (end >= 0) {
            this.write(text.slice(0, end));
        }
        return text.slice(end + 1);
    }

    private write(text: string): void {
        const lines = text.replace(/\r/g, '').split('\n');
        if (this.file !== undefined) {
            // never fall back to the console, output after close or a write error is dropped
            this.stream?.write(`${lines.join('\n')}\n`);
        } else if (this.verbose) {
            let out = '';
            for (const line of lines) {
                out += `${prefix('server')} ${line}\n`;
            }
            this.toConsole(out);
        }
    }
}

function endStream(stream: fs.WriteStream | null): Promise<void> {
    if (!stream) {
        return Promise.resolve();
    }
    return new Promise((resolve) => stream.end(() => resolve()));
}

/** Direction of a traced message: `out` from lsbench to the server, `in` from the server */
export type WireDirection = 'out' | 'in';

class SettledMessageWriter implements rpc.MessageWriter {
    constructor(
        private readonly inner: rpc.MessageWriter,
        private readonly onFailure: (err: unknown) => void,
    ) {}

    get onError(): rpc.Event<[Error, rpc.Message | undefined, number | undefined]> {
        return this.inner.onError;
    }

    get onClose(): rpc.Event<void> {
        return this.inner.onClose;
    }

    async write(msg: rpc.Message): Promise<void> {
        try {
            await this.inner.write(msg);
        } catch (err: unknown) {
            this.onFailure(err);
        }
    }

    end(): void {
        this.inner.end();
    }

    dispose(): void {
        this.inner.dispose();
    }
}

class ObservedMessageReader extends rpc.StreamMessageReader {
    private readonly onRead: (msg: rpc.Message) => void;

    constructor(input: NodeJS.ReadableStream, onRead: (msg: rpc.Message) => void) {
        super(input);
        this.onRead = onRead;
    }

    override listen(callback: rpc.DataCallback): rpc.Disposable {
        return super.listen((msg) => {
            this.onRead(msg);
            callback(msg);
        });
    }
}

class ObservedMessageWriter extends rpc.StreamMessageWriter {
    private readonly onWrite: (msg: rpc.Message) => void;

    constructor(output: NodeJS.WritableStream, onWrite: (msg: rpc.Message) => void) {
        super(output);
        this.onWrite = onWrite;
    }

    override write(msg: rpc.Message): Promise<void> {
        this.onWrite(msg);
        return super.write(msg);
    }
}

/**
 * Records every JSON-RPC message exchanged with the server as JSON lines in a file, one trace
 * per run spanning server restarts. Each line carries `t`, the milliseconds since `origin` on
 * the `process.hrtime` clock the timings use, and one of: a message with its direction
 * (`{"t","dir","msg"}`), a server start (`{"t","spawn":true,"iso","command","args"}`) or an
 * iteration start (`{"t","iteration","warmup"}`). The file is truncated when opened, and lines
 * written after close or a write error are dropped
 */
export class WireTrace {
    private stream: fs.WriteStream | null;

    constructor(
        private file: string,
        private origin: bigint = process.hrtime.bigint(),
    ) {
        const stream = fs.createWriteStream(file, { flags: 'w' });
        stream.on('error', (err) => {
            console.error(`[lsbench] Cannot write trace ${this.file}: ${err.message}`);
            this.stream = null;
        });
        this.stream = stream;
    }

    /** A message sent to or received from the server */
    message(dir: WireDirection, msg: rpc.Message): void {
        this.write({ t: this.now(), dir, msg });
    }

    /** A server process about to be spawned */
    spawn(command: string | undefined, args: string[], transport?: string): void {
        this.write({
            t: this.now(),
            spawn: true,
            iso: new Date().toISOString(),
            command,
            args: command === undefined ? undefined : args,
            transport,
        });
    }

    /** The start of an iteration, numbered from 1 among the warmups or the timed iterations */
    iteration(iteration: number, warmup: boolean): void {
        this.write({ t: this.now(), iteration, warmup });
    }

    /** End the file stream, resolving once it is written */
    close(): Promise<void> {
        const stream = this.stream;
        this.stream = null;
        return endStream(stream);
    }

    /** Milliseconds since the origin, rounded to microseconds like the report */
    private now(): number {
        return Math.round(Number(process.hrtime.bigint() - this.origin) / 1000) / 1000;
    }

    private write(line: object): void {
        this.stream?.write(`${JSON.stringify(line)}\n`);
    }
}

const WIRE_LOG_QUIET_METHODS = new Set(['$/progress', 'window/logMessage', '$/logTrace']);

const WIRE_LOG_SLOW_MS = 1000;

const WIRE_LOG_MESSAGE_MAX = 100;

const REQUEST_CANCELLED = -32800;

const SEVERITY_NAMES = ['error', 'warning', 'info', 'hint'];

interface PendingWireRequest {
    method: string;
    start: number;
}

export class WireLog {
    private sent = new Map<string | number, PendingWireRequest>();
    private received = new Map<string | number, PendingWireRequest>();

    constructor(
        private workspaceRoot: string,
        private sink: (line: string) => void,
        private now: () => number = () => performance.now(),
    ) {}

    message(dir: WireDirection, msg: rpc.Message): void {
        const arrow = dir === 'out' ? style('cyan', '→') : style('green', '←');
        const line = this.describe(dir, msg);
        if (line !== undefined) {
            this.sink(`${arrow} ${line}`);
        }
    }

    private describe(dir: WireDirection, msg: rpc.Message): string | undefined {
        if (rpc.Message.isRequest(msg)) {
            const pending = dir === 'out' ? this.sent : this.received;
            pending.set(msg.id ?? '', { method: msg.method, start: this.now() });
            const head = `${style('bold', msg.method)} ${style('dim', `#${msg.id}`)}`;
            return dir === 'out' ? this.withTarget(head, msg.params) : `${head} ${style('dim', '(server request)')}`;
        }
        if (rpc.Message.isNotification(msg)) {
            return this.describeNotification(dir, msg);
        }
        if (rpc.Message.isResponse(msg)) {
            return this.describeResponse(dir, msg);
        }
        return undefined;
    }

    private describeNotification(dir: WireDirection, msg: rpc.NotificationMessage): string | undefined {
        if (WIRE_LOG_QUIET_METHODS.has(msg.method)) {
            return undefined;
        }
        const params = msg.params as Record<string, unknown> | undefined;
        if (msg.method === '$/cancelRequest') {
            const id = params?.id as string | number;
            const cancelled = (dir === 'out' ? this.sent : this.received).get(id);
            const what = cancelled ? ` (${cancelled.method})` : '';
            return `${style(['bold', 'yellow'], msg.method)} ${style('dim', `#${id}`)}${style('yellow', what)}`;
        }
        const head = style('bold', msg.method);
        if (msg.method === 'textDocument/publishDiagnostics' && params) {
            const where = displayUri(String(params.uri), this.workspaceRoot);
            return `${head} ${where}: ${countDiagnostics(params.diagnostics)}`;
        }
        return this.withTarget(head, params);
    }

    private describeResponse(dir: WireDirection, msg: rpc.ResponseMessage): string {
        const pending = dir === 'in' ? this.sent : this.received;
        const id = msg.id ?? '';
        const request = pending.get(id);
        pending.delete(id);
        let head = `${style('bold', request?.method ?? 'response')} ${style('dim', `#${msg.id}`)}`;
        if (request && dir === 'in') {
            const ms = Math.round(this.now() - request.start);
            head += ` ${style(ms >= WIRE_LOG_SLOW_MS ? ['bold', 'yellow'] : 'dim', `(${ms}ms)`)}`;
        }
        if (msg.error) {
            const cancelled = msg.error.code === REQUEST_CANCELLED;
            const text = `${cancelled ? 'cancelled' : 'error'} ${msg.error.code} ${oneLine(msg.error.message)}`;
            return `${head} ${style(cancelled ? 'yellow' : 'red', text)}`;
        }
        return `${head} ${dir === 'in' ? summarizeResult(msg.result) : 'reply'}`;
    }

    private withTarget(head: string, params: unknown): string {
        const target = describeTarget(params, this.workspaceRoot);
        return target ? `${head} ${target}` : head;
    }
}

function describeTarget(params: unknown, workspaceRoot: string): string | undefined {
    if (!isPlainObject(params) || !isPlainObject(params.textDocument)) {
        return undefined;
    }
    const uri = params.textDocument.uri;
    if (typeof uri !== 'string') {
        return undefined;
    }
    let target = displayUri(uri, workspaceRoot);
    const position = params.position;
    if (isPlainObject(position)) {
        target += `:${position.line}:${position.character}`;
    }
    return target;
}

function summarizeResult(result: unknown): string {
    if (result === null || result === undefined) {
        return 'null';
    }
    if (Array.isArray(result)) {
        const first: unknown = result[0];
        const locations = isPlainObject(first) && ('targetUri' in first || ('uri' in first && 'range' in first));
        return plural(result.length, locations ? 'location' : 'item');
    }
    if (isPlainObject(result)) {
        if (result.kind === 'unchanged') {
            return 'unchanged';
        }
        if (Array.isArray(result.items)) {
            return plural(result.items.length, result.kind === 'full' ? 'diagnostic' : 'item');
        }
    }
    return 'ok';
}

function countDiagnostics(diagnostics: unknown): string {
    if (!Array.isArray(diagnostics) || diagnostics.length === 0) {
        return 'no diagnostics';
    }
    const counts = new Map<string, number>();
    for (const diagnostic of diagnostics) {
        const severity = isPlainObject(diagnostic) ? diagnostic.severity : undefined;
        const name = (typeof severity === 'number' && SEVERITY_NAMES[severity - 1]) || 'diagnostic';
        counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const parts: string[] = [];
    for (const [name, count] of counts) {
        parts.push(plural(count, name));
    }
    return parts.join(', ');
}

function plural(count: number, noun: string): string {
    return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function oneLine(message: string): string {
    const text = String(message).replace(/\s+/g, ' ').trim();
    return text.length > WIRE_LOG_MESSAGE_MAX ? `${text.slice(0, WIRE_LOG_MESSAGE_MAX - 3)}...` : text;
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

function hasExited(child: cp.ChildProcess): boolean {
    return child.exitCode !== null || child.signalCode !== null;
}

interface SocketListener {
    port: number;
    accepted: Promise<net.Socket>;
    close(): void;
}

async function listenForServer(port: number): Promise<SocketListener> {
    const server = net.createServer();
    let open = true;
    let onAccept: (socket: net.Socket) => void = () => {};
    const accepted = new Promise<net.Socket>((resolve) => {
        onAccept = resolve;
    });
    server.on('connection', (socket) => {
        if (open) {
            open = false;
            onAccept(socket);
        } else {
            socket.destroy();
        }
    });
    try {
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(port, LISTEN_HOST, () => {
                server.off('error', reject);
                resolve();
            });
        });
    } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code ?? errorMessage(err);
        throw new Error(`cannot listen on ${LISTEN_HOST}:${port} (${code})`);
    }
    return {
        port: (server.address() as net.AddressInfo).port,
        accepted,
        close: () => {
            open = false;
            server.close();
        },
    };
}

function acceptServer(listener: SocketListener, timeoutMs: number, signal: AbortSignal): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
        const done = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
        };
        const onAbort = () => {
            done();
            reject(new Error('aborted'));
        };
        const timer = setTimeout(() => {
            done();
            reject(new Error(`the server did not connect to ${LISTEN_HOST}:${listener.port} within ${timeoutMs}ms`));
        }, timeoutMs);
        signal.addEventListener('abort', onAbort, { once: true });
        void listener.accepted.then((socket) => {
            done();
            resolve(socket);
        });
    });
}

async function connectToServer(
    host: string,
    port: number,
    timeoutMs: number,
    signal: AbortSignal,
): Promise<net.Socket> {
    const deadline = Date.now() + timeoutMs;
    let lastError = 'ETIMEDOUT';
    while (!signal.aborted) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
            break;
        }
        try {
            return await connectOnce(host, port, remaining, signal);
        } catch (err: unknown) {
            lastError = (err as NodeJS.ErrnoException).code ?? errorMessage(err);
        }
        const wait = Math.min(CONNECT_RETRY_MS, deadline - Date.now());
        if (wait > 0) {
            await delay(wait, undefined, { signal });
        }
    }
    throw new Error(`cannot connect to ${host}:${port} within ${timeoutMs}ms (${lastError})`);
}

function connectOnce(host: string, port: number, timeoutMs: number, signal: AbortSignal): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
        const socket = net.connect({ host, port });
        const done = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            socket.off('connect', onConnect);
            socket.off('error', fail);
        };
        const fail = (err: Error) => {
            done();
            socket.destroy();
            reject(err);
        };
        const onAbort = () => fail(new Error('aborted'));
        const onConnect = () => {
            done();
            resolve(socket);
        };
        const timer = setTimeout(() => fail(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })), timeoutMs);
        signal.addEventListener('abort', onAbort, { once: true });
        socket.once('connect', onConnect);
        socket.once('error', fail);
    });
}
