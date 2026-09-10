// ── Cloud checkout confirmation — the last screen before Stripe ──
//
// Paying is the one irreversible thing this app does, and it used to happen
// on a single click: the button opened Stripe with the price shown only as
// small print inside it. This says what is being bought, what leaves the
// machine, and what does not — and takes an explicit acceptance of the cloud
// terms before it will hand over to payment.
//
// Acceptance is a checkbox, not an implication of pressing Continue. The
// terms are the one place Bethaniel's privacy promise is set aside, so
// "you agreed by proceeding" is the wrong shape for it.

import { useEffect, useState } from "react";
import Modal from "./Modal";
import { useTranslation } from "../i18n";
import type { Lang } from "../types";
import type { CloudEstimateResponse } from "../api";

export const CLOUD_TERMS_URL = "https://bethaniel.eu/cloud-terms";

export default function CloudCheckoutModal({
  open,
  estimate,
  chapters,
  modes,
  etaLabel,
  lang,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  estimate: CloudEstimateResponse | null;
  chapters: number;
  modes: string[];
  /** Roughly how long the run will take, already formatted. */
  etaLabel?: string | null;
  lang: Lang;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useTranslation(lang);
  const [accepted, setAccepted] = useState(false);

  // A fresh decision every time. Carrying the tick over from a previous
  // purchase would turn the second one back into a single click.
  useEffect(() => {
    if (open) setAccepted(false);
  }, [open]);

  if (!estimate) return null;

  const free = estimate.priceCents === 0;
  const price = free
    ? t("cloud_free", "Free")
    : `€${(estimate.priceCents / 100).toFixed(2)}`;
  const discounted =
    estimate.fullPriceCents && estimate.fullPriceCents > estimate.priceCents;

  return (
    <Modal open={open} onClose={onCancel} labelledBy="cloudBuyTitle" className="cloud-buy">
      <h2 id="cloudBuyTitle" className="cloud-buy__title">
        {t("cloud_buy_title", "Run this job in the cloud")}
      </h2>

      <dl className="cloud-buy__lines">
        <div>
          <dt>{t("cloud_buy_manuscript", "Manuscript")}</dt>
          <dd>
            {(estimate.totalWords ?? 0).toLocaleString()}{" "}
            {t("cloud_words", "words")}
            {chapters > 0 && (
              <>
                {" · "}
                {chapters}{" "}
                {chapters === 1
                  ? t("chapter_one", "chapter")
                  : t("chapter_many", "chapters")}
              </>
            )}
          </dd>
        </div>
        <div>
          <dt>{t("cloud_buy_work", "Work")}</dt>
          <dd>{modes.map((m) => t(m, m)).join(" · ")}</dd>
        </div>
        {etaLabel && (
          <div>
            <dt>{t("cloud_buy_time", "Expected time")}</dt>
            <dd>{etaLabel}</dd>
          </div>
        )}
        <div className="cloud-buy__total">
          <dt>{t("cloud_buy_price", "One-off price")}</dt>
          <dd>
            {discounted && (
              <s className="cloud-buy__was">
                €{((estimate.fullPriceCents ?? 0) / 100).toFixed(2)}
              </s>
            )}
            <strong>{price}</strong>
          </dd>
        </div>
      </dl>

      <p className="cloud-buy__note">
        {t(
          "cloud_buy_privacy",
          "This job — and only this job — is processed on Bethaniel's servers in France. Your text is not stored, not kept after the run, and never used to train anything. Everything else about Betty stays on your own machine.",
        )}
      </p>
      <p className="cloud-buy__note cloud-buy__note--quiet">
        {t(
          "cloud_buy_once",
          "You are buying this run, not a subscription. There is nothing to cancel afterwards.",
        )}
      </p>

      <p className="cloud-buy__warn">
        {t(
          "cloud_buy_keep_open",
          "Keep Betty open until the run finishes. The job is driven from this computer even though the editing happens in the cloud, so if the app is closed or the machine sleeps, the chapter in progress is lost — and the tokens it had already used are spent.",
        )}
      </p>

      <label className="cloud-buy__accept">
        <input
          type="checkbox"
          checked={accepted}
          onChange={(e) => setAccepted(e.target.checked)}
        />
        <span>
          {t("cloud_buy_accept_pre", "I accept the")}{" "}
          <a href={CLOUD_TERMS_URL} target="_blank" rel="noopener noreferrer">
            {t("cloud_buy_terms", "cloud terms")}
          </a>
          {t("cloud_buy_accept_post", ".")}
        </span>
      </label>

      <div className="cloud-buy__actions">
        <button type="button" className="btn-secondary" onClick={onCancel}>
          {t("cancel", "Cancel")}
        </button>
        <button
          type="button"
          className="btn-primary"
          disabled={!accepted}
          onClick={onConfirm}
        >
          {free
            ? t("cloud_buy_start_free", "Start the run")
            : t("cloud_buy_continue", "Continue to payment")}
        </button>
      </div>
      {!free && (
        <p className="cloud-buy__stripe">
          {t(
            "cloud_buy_stripe",
            "Payment opens in your browser and is handled by Stripe. Bethaniel never sees your card details.",
          )}
        </p>
      )}
    </Modal>
  );
}
