// ── Keeping "what the code has left" honest ──
//
// The code persists between sessions; the count never does (see the store).
// So something has to fetch it, and this is that something: once on mount —
// which covers an app opened with a code already saved — and again, debounced,
// whenever the code changes under the author's typing.
//
// Mounted once, high up, rather than in each component that shows the note.
// The cards and the Run button sit on the same dashboard, so a hook in both
// would mean two requests for one answer.
//
// It cannot fail loudly: getCodeBalance swallows an offline machine, a
// suspended offer and a Worker too old to know the endpoint, and all three
// land here as null — which renders nothing at all, exactly as today.

import { useEffect } from "react";
import { useStore } from "./store";
import { getCodeBalance } from "./api";

/** How long to wait after the last keystroke before asking the Worker. */
const DEBOUNCE_MS = 500;

export function useCodeBalanceSync(): void {
  const promoCode = useStore((s) => s.promoCode);
  const setCodeBalance = useStore((s) => s.setCodeBalance);

  useEffect(() => {
    const code = promoCode.trim();
    if (!code) {
      setCodeBalance(null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      void getCodeBalance(code).then((balance) => {
        if (live) setCodeBalance(balance);
      });
    }, DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [promoCode, setCodeBalance]);
}
