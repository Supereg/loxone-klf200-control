import * as winston from "winston";
import { PromiseQueue } from "./PromiseQueue";

const logger = winston.createLogger({
  transports: [],
});

describe("PromiseQueue", () => {
  describe("push", () => {
    test("push different types of return values including void.", async () => {
      let callCount = 0;

      const testFunc1 = async () => {
        callCount += 1;
        return Promise.resolve(42);
      };
      const testFunc2 = async () => {
        callCount += 1;
        return Promise.resolve("42");
      };
      const testFunc3 = async () => {
        callCount += 1;
        return Promise.resolve();
      };

      const queue = new PromiseQueue(logger);
      queue.push(testFunc1);
      queue.push(testFunc2);
      queue.push(testFunc3);

      const result = queue.waitAsync();

      await result;

      expect(callCount).toEqual(3);
    });
  });
});
