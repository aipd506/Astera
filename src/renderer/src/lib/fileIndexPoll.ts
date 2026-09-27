/** What the `@` menu shows of the project's file index. */
export interface FileIndexState {
  paths: string[];
  /** The first walk is still under way: `paths` is what it has found so far. */
  indexing: boolean;
  /** The walk failed or ran out of time (a dead share, a folder that cannot be read): there is no list
   *  to wait for, and the menu says so instead of spinning. */
  unavailable: boolean;
}

/** What main answers for one ask (conversation.files). */
export interface FileIndexAnswer {
  paths: string[];
  indexing: boolean;
  unavailable?: boolean;
}

/** How many times one query asks again while main says it is still indexing, before the menu stops
 *  asking and says the list is unavailable. Main ends a walk that runs too long on its own
 *  (main/fileIndex.ts); this is only the backstop, so the menu can never poll without end. */
export const FILE_INDEX_MAX_POLLS = 150;

/**
 * Asks for the `@` matches, and again every `pollMs` while main says the first walk is still under way,
 * so the menu fills in as the walk goes. It stops asking as soon as an answer is not `indexing`, which
 * includes a walk that failed or timed out (`unavailable`), and after FILE_INDEX_MAX_POLLS asks at the
 * most. A rejected ask ends the polling quietly (`onFailed`). Returns the function that stops it.
 */
export function pollFileIndex(
  ask: () => Promise<FileIndexAnswer>,
  onState: (s: FileIndexState) => void,
  onFailed: () => void,
  opts: {
    pollMs: number;
    maxPolls?: number;
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (t: unknown) => void;
  }
): () => void {
  const maxPolls = opts.maxPolls ?? FILE_INDEX_MAX_POLLS;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let stopped = false;
  let timer: unknown = null;
  let asked = 0;
  const once = (): void => {
    asked++;
    ask().then(
      ({ paths, indexing, unavailable }) => {
        if (stopped) return;
        const overdue = indexing && asked > maxPolls;
        onState({
          paths,
          indexing: indexing && !overdue,
          unavailable: unavailable === true || overdue,
        });
        if (indexing && !overdue) timer = setTimer(once, opts.pollMs);
      },
      () => {
        if (!stopped) onFailed();
      }
    );
  };
  once();
  return () => {
    stopped = true;
    if (timer !== null) clearTimer(timer);
  };
}
