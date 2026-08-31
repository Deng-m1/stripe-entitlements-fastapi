"use client";

import { useLocale } from "@/components/LocaleProvider";

export function LoadingState({ label = "Loading billing data…" }: { label?: string }) {
  const { t } = useLocale();
  return (
    <div className="app-page state-page state-card" role="status">
      <span className="spinner" aria-hidden="true" />
      <p>{t(label)}</p>
    </div>
  );
}

export function ErrorState({
  error,
  retry,
  retrying = false,
  title = "We could not load this billing state.",
}: {
  error: string;
  retry?: () => void;
  retrying?: boolean;
  title?: string;
}) {
  const { t } = useLocale();
  return (
    <div className="app-page state-page state-card error-card" role="alert">
      <div>
        <p className="eyebrow">{t("Billing request failed")}</p>
        <h2>{t(title)}</h2>
        <p>{error}</p>
        <p>
          {t(
            "This failure changed nothing: billing state is rendered only from the server’s webhook-backed projection, never inferred client-side.",
          )}
        </p>
      </div>
      {retry ? (
        <button
          aria-busy={retrying}
          className="button secondary"
          disabled={retrying}
          onClick={retry}
          type="button"
        >
          {retrying ? t("Retrying…") : t("Try again")}
        </button>
      ) : null}
    </div>
  );
}
