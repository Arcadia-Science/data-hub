import { describe, expect, it } from "vitest";
import { settleWithConcurrency } from "@/lib/runs/settle-with-concurrency";

// A task the test finishes by hand, so it decides when each one ends.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Lets promise callbacks that are already queued run.
async function flush() {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

describe("settleWithConcurrency", () => {
  it("starts no more than the limit at once, and starts the next as one ends", async () => {
    const tasks = Array.from({ length: 8 }, () => deferred<number>());
    const started: number[] = [];
    let inFlight = 0;
    let mostInFlight = 0;

    const done = settleWithConcurrency(
      [0, 1, 2, 3, 4, 5, 6, 7],
      3,
      async (i) => {
        started.push(i);
        inFlight += 1;
        mostInFlight = Math.max(mostInFlight, inFlight);
        try {
          return await tasks[i].promise;
        } finally {
          inFlight -= 1;
        }
      }
    );

    await flush();
    expect(started).toEqual([0, 1, 2]);

    // One ending starts exactly one more, without waiting for the other two.
    tasks[1].resolve(10);
    await flush();
    expect(started).toEqual([0, 1, 2, 3]);

    tasks[0].resolve(20);
    tasks[3].resolve(30);
    await flush();
    expect(started).toEqual([0, 1, 2, 3, 4, 5]);

    for (const i of [2, 4, 5, 6, 7]) {
      tasks[i].resolve(i);
      await flush();
    }
    await done;

    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(mostInFlight).toBe(3);
  });

  it("returns one result per item in the order of the items", async () => {
    const results = await settleWithConcurrency(
      [30, 10, 20],
      2,
      (ms) =>
        new Promise<number>((resolve) => {
          setTimeout(() => resolve(ms), ms);
        })
    );

    expect(results).toEqual([
      { status: "fulfilled", value: 30 },
      { status: "fulfilled", value: 10 },
      { status: "fulfilled", value: 20 },
    ]);
  });

  it("records a rejection without stopping the other items", async () => {
    const boom = new Error("boom");

    const results = await settleWithConcurrency([1, 2, 3, 4], 2, (n) =>
      n === 2 ? Promise.reject(boom) : Promise.resolve(n * 10)
    );

    expect(results).toEqual([
      { status: "fulfilled", value: 10 },
      { status: "rejected", reason: boom },
      { status: "fulfilled", value: 30 },
      { status: "fulfilled", value: 40 },
    ]);
  });

  it("records a task that throws before it returns a promise", async () => {
    const results = await settleWithConcurrency([1, 2], 5, (n) => {
      if (n === 1) {
        throw new Error("sync failure");
      }
      return Promise.resolve(n);
    });

    expect(results[0]).toMatchObject({ status: "rejected" });
    expect(results[1]).toEqual({ status: "fulfilled", value: 2 });
  });

  it("passes the index to the task", async () => {
    const indexes: number[] = [];

    await settleWithConcurrency(["a", "b", "c"], 1, (_, index) => {
      indexes.push(index);
      return Promise.resolve();
    });

    expect(indexes).toEqual([0, 1, 2]);
  });

  it("handles an empty list and a limit larger than the list", async () => {
    expect(
      await settleWithConcurrency([], 5, () => Promise.resolve(1))
    ).toEqual([]);
    expect(
      await settleWithConcurrency([1, 2], 50, (n) => Promise.resolve(n))
    ).toEqual([
      { status: "fulfilled", value: 1 },
      { status: "fulfilled", value: 2 },
    ]);
  });

  it("treats a limit below one as one", async () => {
    let inFlight = 0;
    let mostInFlight = 0;

    await settleWithConcurrency([1, 2, 3], 0, async () => {
      inFlight += 1;
      mostInFlight = Math.max(mostInFlight, inFlight);
      await flush();
      inFlight -= 1;
    });

    expect(mostInFlight).toBe(1);
  });
});
