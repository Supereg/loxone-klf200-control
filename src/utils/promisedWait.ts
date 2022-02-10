export function promisedWait(timeout: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(() => resolve(), timeout);
  });
}
