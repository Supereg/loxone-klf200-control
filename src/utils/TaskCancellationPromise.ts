import assert from "assert";

export class TaskCancellationError extends Error {
  public reason: string;

  constructor(reason: string) {
    super(`PromiseCancellationError: Task was cancelled: ${reason}`);
    this.reason = reason;
  }
}

export class TaskCancellationPromise {
  private readonly promise: Promise<void>;
  private resolve!: () => void;

  private cancelReason?: string;
  private destroyed = false;

  get canceled(): boolean {
    return !!this.cancelReason;
  }

  constructor() {
    this.promise = new Promise<void>(resolve => this.resolve = resolve);
  }

  awaitCompletion(): Promise<void> {
    assert(!this.destroyed, "Illegal access after future was already destroyed!");
    return this.promise;
  }

  cancel(reason: string): Promise<void> {
    assert(!this.destroyed, "Illegal access after future was already destroyed!");

    this.cancelReason = reason;
    return this.promise;
  }

  probeCancellation(): void {
    if (this.cancelReason) {
      throw new TaskCancellationError(this.cancelReason);
    }
  }

  confirmCancellation(): void {
    assert(!this.destroyed, "Illegal access after future was already destroyed!");
    this.destroyed = true;

    this.resolve();
  }

  confirmCompletion(): void {
    assert(!this.destroyed, "Illegal access after future was already destroyed!");
    this.destroyed = true;

    this.resolve();
  }
}
