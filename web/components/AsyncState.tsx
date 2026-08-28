export function LoadingState({ label = "Loading billing data…" }: { label?: string }) {
  return (
    <div className="state-card" role="status">
      <span className="spinner" aria-hidden="true" />
      <p>{label}</p>
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
  return (
    <div className="state-card error-card" role="alert">
      <div>
        <p className="eyebrow">
          <span className="eyebrow-label">Billing request failed</span>
        </p>
        <h2>{title}</h2>
        <p>{error}</p>
        <p>
          This failure changed nothing: billing state is rendered only from the
          server’s webhook-backed projection, never inferred client-side.
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
          {retrying ? "Retrying…" : "Try again"}
        </button>
      ) : null}
    </div>
  );
}
