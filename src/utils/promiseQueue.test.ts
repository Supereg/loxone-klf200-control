import { PromiseQueue } from "./PromiseQueue";

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

      const queue = new PromiseQueue();
      queue.push(testFunc1).push(testFunc2).push(testFunc3);

      const result = queue.waitAsync();

      await result;

      expect(callCount).toEqual(3);
    });
  });
});
