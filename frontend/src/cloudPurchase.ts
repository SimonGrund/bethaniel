// ── Buying one cloud run ──
//
// Two places sell a cloud run: the run button (an edit) and the language
// report (the enhanced analysis). The purchase is the same in both — get a
// price, open Stripe in the browser, wait for the paid credential to come
// back through the bethaniel:// deep link — so it lives here once.
//
// The credential arrives as ONE event from the desktop shell, and both
// buyers are mounted at the same time on the dashboard. Whoever opened the
// checkout most recently owns the next credential; the other buyer ignores
// it. Without that, paying for the analysis would also start an edit.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createCloudCheckout,
  getCloudEstimate,
  saveCloudCredential,
  type CloudEstimateRequest,
  type CloudEstimateResponse,
} from "./api";

type Bridge = {
  openCloudCheckout: (url: string) => Promise<void>;
  onCloudCredentialClaimed: (
    listener: (result: { ok: boolean; error?: string }) => void,
  ) => () => void;
};

/** The Electron bridge — undefined outside the desktop app (a browser
 *  preview), in which case checkout opens in a new tab and no credential
 *  can come back. */
export function getElectronBridge(): Bridge | null {
  const win = window as unknown as { bethaniel?: Partial<Bridge> };
  if (win.bethaniel?.openCloudCheckout && win.bethaniel?.onCloudCredentialClaimed) {
    return {
      openCloudCheckout: win.bethaniel.openCloudCheckout,
      onCloudCredentialClaimed: win.bethaniel.onCloudCredentialClaimed,
    };
  }
  return null;
}

/** The buyer whose checkout was opened last. Set on checkout, never cleared:
 *  a credential that arrives after the buyer gave up waiting still belongs
 *  to that purchase. Nothing opened yet means the run button, which is what
 *  every credential meant before there was a second buyer. */
let lastBuyer = "run";

/** How long "Waiting for payment…" stays up. Long enough that a real payment
 *  — card, 3-D Secure, a hunt for the wallet — is never interrupted; short
 *  enough that an abandoned one does not outlive the session. */
const WAIT_MS = 15 * 60 * 1000;

export function useCloudPurchase(
  buyer: string,
  onClaimed: () => void | Promise<void>,
) {
  const [estimate, setEstimate] = useState<CloudEstimateResponse | null>(null);
  const [estimateError, setEstimateError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  // Looked up once — the bridge never changes across a session, and a stable
  // reference lets the subscription below mount exactly once.
  const [bridge] = useState(() => getElectronBridge());
  // Always the current render's handler, so a claim that lands minutes after
  // payment acts on up-to-date state rather than what it was on mount.
  const onClaimedRef = useRef(onClaimed);
  onClaimedRef.current = onClaimed;

  const requestEstimate = useCallback(async (req: CloudEstimateRequest) => {
    try {
      const est = await getCloudEstimate(req);
      setEstimate(est);
      setEstimateError(null);
      return est;
    } catch (err) {
      setEstimate(null);
      setEstimateError(err instanceof Error ? err.message : "Could not price this job");
      return null;
    }
  }, []);

  useEffect(() => {
    if (!bridge) return;
    return bridge.onCloudCredentialClaimed((result) => {
      if (lastBuyer !== buyer) return;
      setPending(false);
      if (!result.ok) {
        setClaimError(result.error ?? "Could not activate your cloud credit");
        return;
      }
      setClaimError(null);
      void onClaimedRef.current();
    });
  }, [bridge, buyer]);

  const startCheckout = useCallback(
    async (quoteId: string) => {
      setClaimError(null);
      try {
        const { checkoutUrl } = await createCloudCheckout(quoteId);
        lastBuyer = buyer;
        setPending(true);
        if (bridge) await bridge.openCloudCheckout(checkoutUrl);
        else window.open(checkoutUrl, "_blank");
      } catch (err) {
        setClaimError(err instanceof Error ? err.message : "Could not start checkout");
      }
    },
    [bridge, buyer],
  );

  // The same credential, typed in by hand from the payment page when the
  // bethaniel:// link back did not reach the app. Saved exactly as the
  // desktop shell saves it (electron/main.ts claimCloudCredential); the
  // Worker chooses the model itself on every call, so the name kept here
  // is a label, not an instruction.
  const claimCode = useCallback(
    async (code: string) => {
      setClaimError(null);
      try {
        await saveCloudCredential(code, "bethaniel-cloud");
      } catch (err) {
        setClaimError(
          err instanceof Error ? err.message : "Could not activate your cloud credit",
        );
        throw err;
      }
      lastBuyer = buyer;
      setPending(false);
      await onClaimedRef.current();
    },
    [buyer],
  );

  // Closing Stripe without paying sends nothing back, so the pending flag
  // needs its own ways out: an explicit cancel, and an expiry for the user
  // who simply walked away.
  const cancelWait = useCallback(() => {
    setPending(false);
    setClaimError(null);
  }, []);

  useEffect(() => {
    if (!pending) return;
    const id = setTimeout(() => setPending(false), WAIT_MS);
    return () => clearTimeout(id);
  }, [pending]);

  return {
    estimate,
    estimateError,
    setEstimate,
    requestEstimate,
    pending,
    claimError,
    startCheckout,
    claimCode,
    cancelWait,
    /** False in a browser preview, where no credential can come back. */
    canClaim: bridge !== null,
  };
}
