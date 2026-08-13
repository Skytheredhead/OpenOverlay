type AsyncTask<T = void> = () => Promise<T>;

interface PendingMutation {
  resourceKey: string;
  task: AsyncTask;
}

/**
 * Debounces state snapshots while keeping every network mutation on one FIFO
 * lane. The resource key is captured when work is scheduled, so a delayed save
 * can never be retargeted after React renders a different route.
 */
export class DebouncedSerialMutationQueue {
  private readonly delayMs: number;
  private pending: PendingMutation | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private tail: Promise<void> = Promise.resolve();
  private requiredBeforeRun: Promise<void> = Promise.resolve();

  constructor(delayMs: number) {
    this.delayMs = delayMs;
  }

  schedule(resourceKey: string, task: AsyncTask): void {
    if (this.pending && this.pending.resourceKey !== resourceKey) {
      this.enqueuePending();
    } else if (this.timer) {
      clearTimeout(this.timer);
    }

    this.pending = { resourceKey, task };
    this.timer = setTimeout(() => this.enqueuePending(), this.delayMs);
  }

  flush(): Promise<void> {
    this.enqueuePending();
    return this.requiredBeforeRun;
  }

  run<T>(task: AsyncTask<T>): Promise<T> {
    this.enqueuePending();
    const required = this.requiredBeforeRun;
    this.requiredBeforeRun = Promise.resolve();
    const result = this.tail.then(async () => {
      await required;
      return task();
    });
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  hasPending(resourceKey?: string): boolean {
    return Boolean(this.pending && (!resourceKey || this.pending.resourceKey === resourceKey));
  }

  private enqueuePending(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const mutation = this.pending;
    this.pending = null;
    if (!mutation) return;

    const result = this.tail.then(mutation.task);
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    // A later full-state snapshot supersedes an older failed snapshot. Keep the
    // newest enqueued save as the gate for the next action; `tail` still
    // guarantees that all earlier network work has settled first.
    void result.catch(() => undefined);
    this.requiredBeforeRun = result;
  }
}

interface KeyedTask {
  task: () => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Keeps independent debounce windows for records edited in rapid succession. */
export class KeyedDebouncer {
  private readonly delayMs: number;
  private readonly pending = new Map<string, KeyedTask>();

  constructor(delayMs: number) {
    this.delayMs = delayMs;
  }

  schedule(key: string, task: () => void): void {
    this.cancel(key);
    const timer = setTimeout(() => {
      const pending = this.pending.get(key);
      if (!pending) return;
      this.pending.delete(key);
      pending.task();
    }, this.delayMs);
    this.pending.set(key, { task, timer });
  }

  cancel(key: string): void {
    const pending = this.pending.get(key);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(key);
  }

  flush(key?: string): void {
    const entries = key ? [...this.pending.entries()].filter(([candidate]) => candidate === key) : [...this.pending.entries()];
    for (const [candidate, pending] of entries) {
      clearTimeout(pending.timer);
      this.pending.delete(candidate);
      pending.task();
    }
  }

  clear(): void {
    for (const pending of this.pending.values()) clearTimeout(pending.timer);
    this.pending.clear();
  }
}

/** Serializes mutations independently per resource while allowing unrelated resources to proceed in parallel. */
export class KeyedSerialTaskQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, task: AsyncTask<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(task);
    const normalized = result.then(
      () => undefined,
      () => undefined
    );
    this.tails.set(key, normalized);
    void normalized.then(() => {
      if (this.tails.get(key) === normalized) this.tails.delete(key);
    });
    return result;
  }
}
