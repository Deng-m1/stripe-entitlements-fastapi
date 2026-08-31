"use client";

import type { CSSProperties } from "react";
import { useEffect, useState } from "react";
import { useLocale } from "@/components/LocaleProvider";
import styles from "./SettlementComparison.module.css";

const MIN_POSITION = 8;
const MAX_POSITION = 92;
const REST_POSITION = 54;

const incomingEvents = [
  {
    type: "invoice.paid",
    id: "evt_9f2k",
    meta: "delivery #2 · late",
    tone: "paid",
  },
  {
    type: "invoice.paid",
    id: "evt_9f2k",
    meta: "duplicate delivery",
    tone: "duplicate",
  },
  {
    type: "charge.refunded",
    id: "evt_2m7a",
    meta: "arrived before paid",
    tone: "refund",
  },
  {
    type: "customer.subscription.updated",
    id: "evt_4c1p",
    meta: "same-second tie",
    tone: "update",
  },
] as const;

const ledgerRows = [
  ["001", "invoice.paid", "+1,000.000000", "committed"],
  ["001", "redelivery", "+0.000000", "absorbed"],
  ["002", "charge.refunded", "−250.000000", "committed"],
] as const;

/**
 * A native range-controlled before/after canvas. The left face is the
 * at-least-once Stripe delivery stream; the right face is the deterministic
 * PostgreSQL projection. The comparison is intentionally real DOM rather
 * than a decorative bitmap so the product's data model is the visual.
 */
export function SettlementComparison() {
  const { t } = useLocale();
  const [position, setPosition] = useState(22);
  const [settling, setSettling] = useState(true);

  useEffect(() => {
    const reduceMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const sweep = window.setTimeout(
      () => setPosition(REST_POSITION),
      reduceMotion ? 0 : 260,
    );
    const finish = window.setTimeout(
      () => setSettling(false),
      reduceMotion ? 0 : 1450,
    );
    return () => {
      window.clearTimeout(sweep);
      window.clearTimeout(finish);
    };
  }, []);

  const surfaceStyle = {
    "--comparison-position": `${position}%`,
  } as CSSProperties;

  return (
    <figure className={styles.figure}>
      <div className={styles.frame} style={surfaceStyle}>
        <div aria-hidden="true" className={styles.chaosFace}>
          <div className={styles.windowBar}>
            <span className={styles.windowDots}>
              <i />
              <i />
              <i />
            </span>
            <span>inbound / stripe-events</span>
            <span className={styles.windowState}>{t("unordered")}</span>
          </div>
          <div className={styles.chaosGrid}>
            <div className={styles.chaosIntro}>
              <span className={styles.faceLabel}>{t("INPUT · AT-LEAST-ONCE")}</span>
              <strong>{t("One payment. Many deliveries.").split(" ").map((word, index, words) => (
                <span key={`${word}-${index}`}>{word}{index === Math.ceil(words.length / 2) - 1 ? <br /> : " "}</span>
              ))}</strong>
              <p>{t("Retries, duplicates, and out-of-order facts share the same wire.")}</p>
            </div>
            <div className={styles.eventStack}>
              {incomingEvents.map((event, index) => (
                <div
                  className={`${styles.eventCard} ${styles[event.tone]}`}
                  key={`${event.id}-${index}`}
                >
                  <span className={styles.eventPulse} />
                  <span className={styles.eventCopy}>
                    <strong>{event.type}</strong>
                    <small>{event.id} · {t(event.meta)}</small>
                  </span>
                  <code>{index === 1 ? "DUP" : `0${index + 1}`}</code>
                </div>
              ))}
            </div>
          </div>
          <div className={styles.chaosFooter}>
            <span>{t("retrying")}</span>
            <span>{t("ordering unknown")}</span>
            <span>{t("browser return ≠ grant")}</span>
          </div>
        </div>

        <div
          aria-hidden="true"
          className={`${styles.settledFace} ${settling ? styles.isSettling : ""}`}
        >
          <div className={styles.windowBar}>
            <span className={styles.windowDots}>
              <i />
              <i />
              <i />
            </span>
            <span>projected / billing-account</span>
            <span className={styles.windowState}>{t("consistent")}</span>
          </div>
          <div className={styles.settledGrid}>
            <div className={styles.accountProjection}>
              <div className={styles.projectionTopline}>
                <span className={styles.faceLabel}>{t("OUTPUT · POSTGRESQL")}</span>
                <span className={styles.liveChip}>{t("enforceable")}</span>
              </div>
              <p className={styles.accountLabel}>billing_accounts / acct_demo</p>
              <div className={styles.accountFacts}>
                <div>
                  <span>{t("Plan")}</span>
                  <strong>Pro</strong>
                </div>
                <div>
                  <span>{t("interval")}</span>
                  <strong>{t("Monthly")}</strong>
                </div>
                <div className={styles.creditFact}>
                  <span>{t("credits balance")}</span>
                  <strong>750.000000</strong>
                </div>
              </div>
              <div className={styles.entitlementBar}>
                <span>features.export</span>
                <strong>{t("allowed")}</strong>
              </div>
            </div>

            <div className={styles.ledgerProjection}>
              <div className={styles.ledgerHead}>
                <span>event_inbox + credit_ledger</span>
                <span>TX COMMITTED</span>
              </div>
              {ledgerRows.map(([seq, event, effect, outcome]) => (
                <div className={styles.ledgerRow} key={`${seq}-${event}`}>
                  <code>{seq}</code>
                  <span>{event}</span>
                  <strong>{effect}</strong>
                  <i>{t(outcome)}</i>
                </div>
              ))}
            </div>
          </div>
          <div className={styles.settledFooter}>
            <span className={styles.checkMark}>✓</span>
            {t("effectively-once PostgreSQL effects")}
            <span className={styles.footerDetail}>{t("raw signature · row lock · business key")}</span>
          </div>
        </div>

        <div aria-hidden="true" className={styles.divider} />
        <span aria-hidden="true" className={styles.handle}>
          <svg fill="none" viewBox="0 0 22 14">
            <path d="M8 2 3 7l5 5M14 2l5 5-5 5M3 7h16" />
          </svg>
        </span>
        <input
          aria-label={t("Compare raw Stripe events with projected PostgreSQL entitlements")}
          className={styles.range}
          max={MAX_POSITION}
          min={MIN_POSITION}
          onChange={(event) => {
            setSettling(false);
            setPosition(Number(event.currentTarget.value));
          }}
          onKeyDown={(event) => {
            let next: number | undefined;
            if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
              next = Math.max(MIN_POSITION, position - 4);
            }
            if (event.key === "ArrowRight" || event.key === "ArrowUp") {
              next = Math.min(MAX_POSITION, position + 4);
            }
            if (event.key === "Home") next = MIN_POSITION;
            if (event.key === "End") next = MAX_POSITION;
            if (next !== undefined) {
              event.preventDefault();
              setSettling(false);
              setPosition(next);
            }
          }}
          step="0.1"
          type="range"
          value={position}
        />
      </div>
      <figcaption className={styles.caption}>
        <span>
          <strong>{t("Raw Stripe stream")}</strong>
          {t("duplicate · late · retryable")}
        </span>
        <span className={styles.dragHint}>{t("Drag to compare")}</span>
        <span>
          <strong>{t("Enforceable state")}</strong>
          {t("ordered · exact · auditable")}
        </span>
      </figcaption>
    </figure>
  );
}
