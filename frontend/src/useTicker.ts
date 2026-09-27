import { useEffect, useState } from "react";

/** The current time, re-read every `ms` while `active` — for text that
 *  changes with elapsed time. Idle (no timer at all) when not active. */
export function useTicker(active: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [active, ms]);
  return now;
}
