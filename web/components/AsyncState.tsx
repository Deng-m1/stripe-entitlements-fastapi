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
}: {
  error: string;
  retry?: () => void;
}) {
  return (
    <div className="state-card error-card" role="alert">
      <div>
        <p className="eyebrow">Billing request failed</p>
        <h2>We could not load this billing state.</h2>
        <p>{error}</p>
      </div>
      {retry ? (
        <button className="button secondary" onClick={retry} type="button">
          Try again
        </button>
      ) : null}
    </div>
  );
}
