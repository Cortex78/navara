/*
 * Requests in flight to Live IGN, for the link light in the top bar: it
 * pulses while answers are on their way, so a slow connector reads as busy
 * rather than broken.
 */

let inFlight = 0;
const listeners = new Set<(n: number) => void>();

const emit = () => {
  for (const fn of listeners) fn(inFlight);
};

/** Counts `p` as in flight until it settles; returns it unchanged. */
export const track = <T>(p: Promise<T>): Promise<T> => {
  inFlight++;
  emit();
  const done = () => {
    inFlight = Math.max(0, inFlight - 1);
    emit();
  };
  p.then(done, done);
  return p;
};

export const onActivity = (fn: (n: number) => void) => {
  listeners.add(fn);
  fn(inFlight);
  return () => listeners.delete(fn);
};
