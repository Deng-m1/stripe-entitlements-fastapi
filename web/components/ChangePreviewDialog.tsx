"use client";

import { useEffect, useRef, useState } from "react";
import { useLocale } from "@/components/LocaleProvider";
import {
  formatCreditDecimal,
  parseExactCreditAmount,
} from "@/lib/credit-amount";
import { formatDate, formatMoney } from "@/lib/money";
import { publicSimulationMode } from "@/lib/runtime";
import type { ChangePreview } from "@/lib/types";

const previewRouteStyles = `
.dialog-summary {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.preview-route-from,
.preview-route-to {
  background: var(--surface-soft);
  border: 1px solid var(--line);
  border-radius: 999px;
  font-size: 0.9rem;
  font-weight: 650;
  padding: 4px 12px;
}

.preview-route-to {
  background: #eef3ff;
  border-color: #c5d3f4;
  color: var(--text);
  font-weight: 740;
}

.preview-route-arrow {
  color: var(--muted);
}
`;

interface ChangePreviewDialogProps {
  preview: ChangePreview;
  paymentUrl: string | null;
  targetName: string;
  busy: boolean;
  error: string | null;
  onCancel(): void;
  onConfirm(): void;
  onOpenPayment(): void;
}

export function ChangePreviewDialog({
  preview,
  paymentUrl,
  targetName,
  busy,
  error,
  onCancel,
  onConfirm,
  onOpenPayment,
}: ChangePreviewDialogProps) {
  const { numberLocale, t } = useLocale();
  const [acknowledged, setAcknowledged] = useState(false);
  const immediate = preview.timing === "immediate";
  const proratedDelta =
    preview.settlement_mode === "current_period_prorated_delta";
  const exactCreditDelta =
    preview.entitlement_credit_delta === null
      ? null
      : parseExactCreditAmount(
          preview.entitlement_credit_delta,
          preview.entitlement_credit_delta_atoms,
          preview.credit_scale,
        );
  const dialogRef = useRef<HTMLElement>(null);
  const busyRef = useRef(busy);
  const onCancelRef = useRef(onCancel);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    onCancelRef.current = onCancel;
  }, [onCancel]);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    dialog?.focus({ preventScroll: true });

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !busyRef.current) {
        event.preventDefault();
        onCancelRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === dialog)
      ) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previouslyFocused?.focus({ preventScroll: true });
    };
  }, []);

  return (
    <div className="dialog-backdrop" role="presentation">
      <section
        aria-busy={busy}
        aria-describedby="change-preview-description"
        aria-labelledby="change-preview-title"
        aria-modal="true"
        className="dialog"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <p className="eyebrow">
          {publicSimulationMode
            ? t("Browser-local change preview")
            : t("Server-calculated change preview")}
        </p>
        <h2 id="change-preview-title">
          {publicSimulationMode
            ? immediate
              ? t("This simulated change applies immediately")
              : t("This simulated change starts at period end")
            : paymentUrl
            ? t("Payment required — your current plan remains active")
            : proratedDelta
              ? t("Pay the prorated difference for this period")
              : immediate
                ? t("This change requires immediate settlement")
                : t("This change starts at period end")}
        </h2>
        <p className="dialog-summary" id="change-preview-description">
          <style>{previewRouteStyles}</style>
          <span className="preview-route-from">
            {preview.current_plan_key} / {preview.current_interval}
          </span>
          <span aria-hidden="true" className="preview-route-arrow">
            →
          </span>
          <span className="preview-route-to">
            {targetName} / {preview.target_interval}
          </span>
        </p>

        {publicSimulationMode ? (
          <div className={immediate ? "timing-panel timing-immediate" : "timing-panel"}>
            <strong>{immediate ? t("Immediate sample projection") : t("No sample change today")}</strong>
            <p>
              {t("This changes only versioned browser-local simulation state. It creates no Stripe invoice, payment, webhook, database row, or real entitlement.")}
            </p>
          </div>
        ) : paymentUrl ? (
          <div className="timing-panel timing-immediate">
            <strong>{t("The Stripe invoice is still open")}</strong>
            <p>
              {t("The requested target is not active. Continue to Stripe to pay or authenticate the invoice. After payment, this app still waits for the webhook-projected account before showing the new entitlements.")}
            </p>
          </div>
        ) : proratedDelta ? (
          <div className="timing-panel timing-immediate">
            <strong>{t("Prorated amount due: {{amount}}", {
              amount: formatMoney(
                preview.amount_due_now,
                preview.currency,
                numberLocale,
              ),
            })}</strong>
            <p>
              {t("Your current billing-period end stays unchanged. Stripe credits the unused source tier and charges the target tier for the same remaining time. After the paid Invoice is verified, the server adds exactly {{credits}} credits—the catalog entitlement difference, not a credit amount inferred from cash.", {
                credits: exactCreditDelta
                  ? formatCreditDecimal(exactCreditDelta.decimal)
                  : "—",
              })}
            </p>
          </div>
        ) : immediate ? (
          <div className="timing-panel timing-immediate">
            <strong>{t("Immediate amount due: {{amount}}", {
              amount: formatMoney(
                preview.amount_due_now,
                preview.currency,
                numberLocale,
              ),
            })}</strong>
            <p>
              {t("The server accepted this as an independently funded target invoice: cross-invoice proration and customer-balance credit are both zero. Stripe may charge the payment method or require authentication. Entitlements change only after the bill is paid and webhook state is applied.")}
            </p>
          </div>
        ) : (
          <div className="timing-panel">
            <strong>{t("No charge today")}</strong>
            <p>
              {t("Your current plan remains active until {{date}}. The new plan and interval begin at that period boundary.", {
                date: formatDate(preview.effective_at, numberLocale),
              })}
            </p>
          </div>
        )}

        <dl className="preview-facts">
          {proratedDelta ? (
            <div>
              <dt>{t("Unused-plan credit")}</dt>
              <dd>{formatMoney(preview.credit_applied, preview.currency, numberLocale)}</dd>
            </div>
          ) : null}
          <div>
            <dt>{t("Next invoice")}</dt>
            <dd>{formatMoney(preview.next_invoice_amount, preview.currency, numberLocale)}</dd>
          </div>
          <div>
            <dt>{t("Effective")}</dt>
            <dd>{formatDate(preview.effective_at, numberLocale)}</dd>
          </div>
        </dl>

        {!paymentUrl ? (
          <label className="confirmation">
            <input
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
              type="checkbox"
            />
            <span>
              {publicSimulationMode
                ? t("I understand this changes only browser-local sample state and does not charge or contact Stripe.")
                : immediate
                ? proratedDelta
                  ? t("I understand that Stripe will charge the prorated difference and the upgrade still requires webhook confirmation.")
                  : t("I understand that immediate settlement may charge me and still requires webhook confirmation.")
                : t("I understand that the current plan remains active until period end.")}
            </span>
          </label>
        ) : null}

        {error ? <p className="inline-error" role="alert">{error}</p> : null}

        <div className="dialog-actions">
          <button
            aria-busy={busy}
            className="button ghost"
            disabled={busy}
            onClick={onCancel}
            type="button"
          >
            {t("Cancel")}
          </button>
          {paymentUrl ? (
            <button
              aria-busy={busy}
              className="button primary"
              disabled={busy}
              onClick={onOpenPayment}
              type="button"
            >
              {t("Open Stripe invoice")}
            </button>
          ) : (
            <button
              aria-busy={busy}
              className="button primary"
              disabled={!acknowledged || busy}
              onClick={onConfirm}
              type="button"
            >
              {busy
                ? t("Confirming…")
                : publicSimulationMode
                  ? t("Confirm simulated change")
                  : t("Confirm billing change")}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
