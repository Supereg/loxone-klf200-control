
export class PromiseQueue<T = unknown> {
  private nextPromise: Promise<T | void> = Promise.resolve();

  public push(asyncFunction: () => Promise<T | void>): this {
    this.nextPromise = this.nextPromise
      // TODO log errors thrown!
      .then(asyncFunction, asyncFunction); // we ignore errors, but ensure the next "entry" in the chain is ALWAYS called
    return this;
  }

  public async waitAsync(): Promise<T | void> { // TODO required for ?
    await this.nextPromise;
  }
}
