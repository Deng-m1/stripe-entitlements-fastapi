"use client";

import { useEffect, useRef, useState } from "react";
import { formatDate, formatMoney } from "@/lib/money";
import type { ChangePreview } from "@/lib/types";

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
  const [acknowledged, setAcknowledged] = useState(false);
  const immediate = preview.timing === "immediate";
  const proratedDelta =
    preview.settlement_mode === "current_period_prorated_delta";
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
        <p className="eyebrow">Server-calculated change preview</p>
        <h2 id="change-preview-title">
          {paymentUrl
            ? "Payment required — your current plan remains active"
            : proratedDelta
              ? "Pay the prorated difference for this period"
              : immediate
                ? "This change requires immediate settlement"
                : "This change starts at period end"}
        </h2>
        <p className="dialog-summary" id="change-preview-description">
          {preview.current_plan_key}/{preview.current_interval} → {targetName}/
          {preview.target_interval}
        </p>

        {paymentUrl ? (
          <div className="timing-panel timing-immediate">
            <strong>The Stripe invoice is still open</strong>
            <p>
              The requested target is not active. Continue to Stripe to pay or
              authenticate the invoice. After payment, this app still waits for the
              webhook-projected account before showing the new entitlements.
            </p>
          </div>
        ) : proratedDelta ? (
          <div className="timing-panel timing-immediate">
            <strong>
              Prorated amount due: {" "}
              {formatMoney(preview.amount_due_now, preview.currency)}
            </strong>
            <p>
              Your current billing-period end stays unchanged. Stripe credits the
              unused source tier and charges the target tier for the same remaining
              time. After the paid Invoice is verified, the server adds exactly {" "}
              {(preview.entitlement_credit_delta ?? 0).toLocaleString()} credits—the
              catalog entitlement difference, not a credit amount inferred from cash.
            </p>
          </div>
        ) : immediate ? (
          <div className="timing-panel timing-immediate">
            <strong>
              Immediate amount due:{" "}
              {formatMoney(preview.amount_due_now, preview.currency)}
            </strong>
            <p>
              The server accepted this as an independently funded target invoice:
              cross-invoice proration and customer-balance credit are both zero.
              Stripe may charge the payment method or require authentication.
              Entitlements change only after the bill is paid and webhook state is
              applied.
            </p>
          </div>
        ) : (
          <div className="timing-panel">
            <strong>No charge today</strong>
            <p>
              Your current plan remains active until {formatDate(preview.effective_at)}.
              The new plan and interval begin at that period boundary.
            </p>
          </div>
        )}

        <dl className="preview-facts">
          {proratedDelta ? (
            <div>
              <dt>Unused-plan credit</dt>
              <dd>{formatMoney(preview.credit_applied, preview.currency)}</dd>
            </div>
          ) : null}
          <div>
            <dt>Next invoice</dt>
            <dd>{formatMoney(preview.next_invoice_amount, preview.currency)}</dd>
          </div>
          <div>
            <dt>Effective</dt>
            <dd>{formatDate(preview.effective_at)}</dd>
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
              {immediate
                ? proratedDelta
                  ? "I understand that Stripe will charge the prorated difference and the upgrade still requires webhook confirmation."
                  : "I understand that immediate settlement may charge me and still requires webhook confirmation."
                : "I understand that the current plan remains active until period end."}
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
            Cancel
          </button>
          {paymentUrl ? (
            <button
              aria-busy={busy}
              className="button primary"
              disabled={busy}
              onClick={onOpenPayment}
              type="button"
            >
              Open Stripe invoice
            </button>
          ) : (
            <button
              aria-busy={busy}
              className="button primary"
              disabled={!acknowledged || busy}
              onClick={onConfirm}
              type="button"
            >
              {busy ? "Confirming…" : "Confirm billing change"}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
