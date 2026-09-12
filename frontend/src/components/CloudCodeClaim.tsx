// ── The way back when the link back fails ──
//
// After payment the Worker's success page opens bethaniel://claim to hand
// the credential to the app. That link can fail: a browser that blocks
// custom schemes, a scheme never registered, an app that was closed. The
// page always shows the code as well, and this is where it goes — one field,
// open while a payment is being waited on, and one click away otherwise,
// because the failure that needs it most is the app having been restarted.

import { useEffect, useId, useState } from "react";
import { useTranslation } from "../i18n";
import type { Lang } from "../types";

/** What the Worker mints: BETH- then twenty Crockford base32 characters in
 *  groups of five. Spacing and hyphens are forgiven; the Worker strips them
 *  too before hashing. */
export function normalizeCloudCode(raw: string): string | null {
  const flat = raw.toUpperCase().replace(/[\s-]+/g, "");
  if (!/^BETH[0-9A-HJKMNP-TV-Z]{20}$/.test(flat)) return null;
  const body = flat.slice(4);
  return `BETH-${body.match(/.{1,5}/g)!.join("-")}`;
}

export default function CloudCodeClaim({
  pending,
  onClaim,
  lang,
}: {
  /** A checkout is open in the browser: show the field without being asked. */
  pending: boolean;
  onClaim: (code: string) => Promise<void>;
  lang: Lang;
}) {
  const t = useTranslation(lang);
  // Two of these can be on the page at once (the run button and the report).
  const id = useId();
  const [open, setOpen] = useState(pending);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    if (pending) setOpen(true);
  }, [pending]);

  const submit = async () => {
    const normalized = normalizeCloudCode(code);
    if (!normalized) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setBusy(true);
    try {
      await onClaim(normalized);
      setCode("");
      setOpen(false);
    } catch {
      // The buyer shows the error beside this field; the code stays put so
      // it can be corrected rather than retyped.
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <p className="cloud-claim-hint">
        <button type="button" className="link-button" onClick={() => setOpen(true)}>
          {t("cloud_claim_open")}
        </button>
      </p>
    );
  }

  return (
    <form
      className="cloud-claim"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label className="cloud-claim-label" htmlFor={id}>
        {t("cloud_claim_label")}
      </label>
      <div className="cloud-claim-row">
        <input
          id={id}
          type="text"
          value={code}
          onChange={(e) => {
            setCode(e.target.value);
            setInvalid(false);
          }}
          placeholder="BETH-XXXXX-XXXXX-XXXXX-XXXXX"
          spellCheck={false}
          autoCapitalize="characters"
          autoComplete="off"
          className="cloud-code-input cloud-claim-input"
          aria-invalid={invalid || undefined}
        />
        <button
          type="submit"
          className="btn-secondary btn-small"
          disabled={busy || !code.trim()}
        >
          {busy ? t("cloud_claim_busy") : t("cloud_claim_submit")}
        </button>
      </div>
      {invalid && (
        <span className="cloud-code-note cloud-code-warn">{t("cloud_claim_invalid")}</span>
      )}
    </form>
  );
}
