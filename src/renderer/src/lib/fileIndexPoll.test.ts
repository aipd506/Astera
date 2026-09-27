import { afterEach, describe, expect, it, vi } from "vitest";
import { pollFileIndex, type FileIndexAnswer, type FileIndexState } from "./fileIndexPoll";

afterEach(() => {
  vi.useRealTimers();
});

/** An ask that answers from a script, one answer per call, repeating the last one. */
const scripted = (answers: FileIndexAnswer[]) => {
  let n = 0;
  const ask = vi.fn(async () => answers[Math.min(n++, answers.length - 1)]);
  return ask;
};

describe("pollFileIndex", () => {
  it("asks again while main says it is indexing, and stops once the list is whole", async () => {
    vi.useFakeTimers();
    const ask = scripted([
      { paths: ["a"], indexing: true },
      { paths: ["a", "b"], indexing: true },
      { paths: ["a", "b", "c"], indexing: false },
    ]);
    const states: FileIndexState[] = [];
    pollFileIndex(ask, (s) => states.push(s), () => {}, { pollMs: 400 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ask).toHaveBeenCalledTimes(3);
    expect(states.at(-1)).toEqual({ paths: ["a", "b", "c"], indexing: false, unavailable: false });
  });

  // Stage 2 final review, I3: on a dead folder the menu polled every 400 ms without end.
  it("stops asking when main says the index is unavailable, and says so", async () => {
    vi.useFakeTimers();
    const ask = scripted([
      { paths: [], indexing: true },
      { paths: [], indexing: false, unavailable: true },
    ]);
    const states: FileIndexState[] = [];
    pollFileIndex(ask, (s) => states.push(s), () => {}, { pollMs: 400 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(states.at(-1)).toEqual({ paths: [], indexing: false, unavailable: true });
  });

  it("gives up after its poll cap even when main keeps saying indexing, and reads that as unavailable", async () => {
    vi.useFakeTimers();
    const ask = scripted([{ paths: [], indexing: true }]);
    const states: FileIndexState[] = [];
    pollFileIndex(ask, (s) => states.push(s), () => {}, { pollMs: 400, maxPolls: 5 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ask).toHaveBeenCalledTimes(6);
    expect(states.at(-1)).toEqual({ paths: [], indexing: false, unavailable: true });
  });

  it("a rejected ask ends the polling through onFailed", async () => {
    vi.useFakeTimers();
    const ask = vi.fn(async (): Promise<FileIndexAnswer> => {
      throw new Error("gone");
    });
    const failed = vi.fn();
    pollFileIndex(ask, () => {}, failed, { pollMs: 400 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(failed).toHaveBeenCalledTimes(1);
  });

  it("stop() ends the polling and drops a late answer", async () => {
    vi.useFakeTimers();
    const ask = scripted([{ paths: [], indexing: true }]);
    const states: FileIndexState[] = [];
    const stop = pollFileIndex(ask, (s) => states.push(s), () => {}, { pollMs: 400 });
    await vi.advanceTimersByTimeAsync(0);
    stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(states).toHaveLength(1);
  });
});
