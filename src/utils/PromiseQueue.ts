import { Logger } from "winston";

export type PromiseQueueElement<T> = () => Promise<T>

export class PromiseQueue {
  private readonly logger: Logger;
  private nextPromise: Promise<unknown> = Promise.resolve();

  constructor(logger: Logger) {
    this.logger = logger.child({ label: "PromiseQueue" });
  }

  public push<T>(asyncFunction: PromiseQueueElement<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.nextPromise = this.nextPromise
        .then(async () => {
          const result = await asyncFunction();
          resolve(result);
        })
        .catch(reason => {
          // TODO this doc is outdated!
          // we can't really handle errors, ideally there are non thrown.
          // but in any case we want to ensure that the next entry in the chain is ALWAYS called!
          this.logger.error("Element in promise queue returned with an error: %s", reason);
          reject(reason);
        });
    });
  }

  public waitAsync(): Promise<unknown> {
    return this.nextPromise;
  }
}
