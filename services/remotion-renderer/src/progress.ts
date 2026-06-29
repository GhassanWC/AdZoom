/** Leading-edge throttle: invoke at most once per `ms`. Intermediate calls are
 *  dropped (the 30s heartbeat keeps the job live; the final progress is written
 *  explicitly at settle), so there is no trailing timer to fire after the render. */
export function makeThrottle(ms: number): (fn: () => void) => void {
  let last = 0;
  return (fn: () => void) => {
    const now = Date.now();
    if (now - last >= ms) {
      last = now;
      fn();
    }
  };
}
