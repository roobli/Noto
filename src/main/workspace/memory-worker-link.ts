/**
 * Main's end of one memory worker: requests numbered and answered by
 * message, each with its own time limit, and a close that lets the worker
 * finish with its index before it is stopped.
 *
 * Main runs one worker that keeps the folder's index and answers Note Info,
 * and may run a second that only reads the same index for Review, whose
 * lists take seconds; both talk this way (`memory-host.ts`).
 */

import { Worker } from 'node:worker_threads';
import type { MemoryAnswer, MemoryRequest } from '../../vault-worker/vault-worker';

/** How long the worker has to close the index before it is stopped anyway. */
const CLOSE_TIMEOUT_MS = 3_000;

export class MemoryError extends Error {
  /**
   * `unknown`: the vault holds no note by that name. `answered`: the worker
   * answered with this error (no such proposal, a note it may not write),
   * rather than the memory being out of reach.
   */
  constructor(message: string, readonly unknown = false, readonly answered = false) {
    super(message);
  }
}

/** The worker, as main talks to it: replaced by a fake in tests. */
export interface MemoryWorker {
  postMessage(request: MemoryRequest): void;
  on(event: 'message', listener: (answer: MemoryAnswer) => void): void;
  on(event: 'error' | 'exit', listener: (value: unknown) => void): void;
  terminate(): Promise<number> | void;
}

export function systemMemoryWorker(file: string): () => MemoryWorker {
  return () => new Worker(file) as unknown as MemoryWorker;
}

/** A request before it is numbered: `Omit` taken over each kind of request on its own. */
export type Unnumbered = MemoryRequest extends infer Each ? Each extends MemoryRequest ? Omit<Each, 'id'> : never : never;

type Pending = { resolve: (value: unknown) => void; reject: (error: MemoryError) => void; timer: ReturnType<typeof setTimeout> };

export class WorkerLink {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private done = false;
  private closed: Promise<void> | null = null;

  /** `onLost` is called once if the worker dies or errs before it is closed. */
  constructor(private readonly worker: MemoryWorker, onLost: (why: string) => void) {
    worker.on('message', (answer: MemoryAnswer) => this.answer(answer));
    const lost = (why: string) => {
      if (this.done) return;
      this.done = true;
      this.failAll(new MemoryError(`The memory stopped: ${why}`));
      onLost(why);
    };
    worker.on('error', (error) => lost(error instanceof Error ? error.message : String(error)));
    worker.on('exit', (code) => lost(`exit ${String(code)}`));
  }

  ask(request: Unnumbered, timeoutMs: number): Promise<unknown> {
    if (this.done) return Promise.reject(new MemoryError('The memory is not open.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new MemoryError('The memory took too long to answer.'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ ...request, id } as MemoryRequest);
    });
  }

  /**
   * Everything waiting is told the memory closed; the worker is let close
   * the index (its last write lands whole), then stopped either way.
   * Resolves once the worker has stopped, so the index files are no longer
   * held by it; closing again resolves with the same.
   */
  close(): Promise<void> {
    if (this.closed) return this.closed;
    // A worker that died or erred has stopped already.
    if (this.done) return (this.closed = Promise.resolve());
    this.done = true;
    this.failAll(new MemoryError('The memory closed.'));
    const id = this.nextId++;
    let timer: ReturnType<typeof setTimeout> | null = null;
    this.closed = new Promise<void>((settle) => {
      const end = () => {
        if (timer !== null) clearTimeout(timer);
        this.pending.delete(id);
        void Promise.resolve(this.worker.terminate()).catch(() => {}).then(() => settle());
      };
      timer = setTimeout(end, CLOSE_TIMEOUT_MS);
      this.pending.set(id, { resolve: end, reject: end, timer });
      try {
        this.worker.postMessage({ id, kind: 'close' });
      } catch {
        end();
      }
    });
    return this.closed;
  }

  private answer(answer: MemoryAnswer): void {
    const waiting = this.pending.get(answer.id);
    if (!waiting) return;
    this.pending.delete(answer.id);
    clearTimeout(waiting.timer);
    if (answer.ok) waiting.resolve(answer.value);
    else waiting.reject(new MemoryError(answer.error, answer.unknown === true, true));
  }

  private failAll(error: MemoryError): void {
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(error);
    }
    this.pending.clear();
  }
}
