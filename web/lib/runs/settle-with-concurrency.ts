// The reprocess buttons send this many requests at a time. Each request puts
// files in the queue and may start Lambda processing, so sending them all at
// once only moves the burst from the Lambda to the web app and the database.
export const REPROCESS_REQUEST_CONCURRENCY = 5;

// Runs `task` for every item with at most `limit` calls in flight, and starts
// the next item as soon as one finishes. Resolves once all have settled, with
// one result per item in the order of `items`, like `Promise.allSettled`. A
// task that throws or rejects becomes a `rejected` result and does not stop
// the others.
export async function settleWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = {
          status: "fulfilled",
          value: await task(items[index], index),
        };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }

  const workerCount = Math.min(Math.max(1, Math.floor(limit)), items.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}
