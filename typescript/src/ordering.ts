const EVENT_RANK: Readonly<Record<string, number>> = Object.freeze({
  "invoice.payment_failed": 10,
  "customer.subscription.updated": 20,
  "invoice.paid": 30,
  "customer.subscription.deleted": 40,
});

export function eventWins(input: {
  readonly currentCreated: bigint;
  readonly currentRank: number;
  readonly eventCreated: bigint;
  readonly eventRank: number;
}): boolean {
  return (
    input.eventCreated > input.currentCreated ||
    (input.eventCreated === input.currentCreated &&
      input.eventRank > input.currentRank)
  );
}

export function rankFor(eventType: string): number {
  return EVENT_RANK[eventType] ?? 0;
}
