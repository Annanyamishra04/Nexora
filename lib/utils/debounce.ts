export interface Debounced<Args extends unknown[]> {
  (...args: Args): void;
  /** Drops any pending call (e.g. on unmount or when input is cleared). */
  cancel(): void;
}

/**
 * Trailing-edge debounce: `fn` runs once, `waitMs` after the *last* call.
 * Kept as a plain function (not only a hook) so the timing behaviour is
 * unit-testable with fake timers, and reusable outside React.
 */
export function debounce<Args extends unknown[]>(
  fn: (...args: Args) => void,
  waitMs: number
): Debounced<Args> {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const debounced = ((...args: Args) => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, waitMs);
  }) as Debounced<Args>;

  debounced.cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return debounced;
}
