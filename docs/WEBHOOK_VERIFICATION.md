# Webhook payload and endpoint verification

Webhook evidence has three independent parts. Keep all three in a private release
record:

1. **Endpoint contract:** mode, destination URL, enabled Event set, status and Event
   snapshot API version from the Stripe Webhook Endpoint.
2. **Signed delivery:** the application verifies Stripe's signature against the exact
   raw request body before parsing; only then can the Event enter
   `stripe_webhook_events`.
3. **Business projection:** the exact Event ID is handled once and the expected account,
   invoice and credit-ledger state commits in PostgreSQL.

An outbound `STRIPE_API_VERSION` check proves none of these. Request API version and
Event snapshot version are separate contracts.

## Repeatable test-mode proof

The isolated browser runner is the strongest automated transport proof in this
repository:

```bash
case "$STRIPE_SECRET_KEY" in sk_test_*) ;; *) exit 2 ;; esac
case "$STRIPE_PUBLISHABLE_KEY" in pk_test_*) ;; *) exit 2 ;; esac
E2E_STRIPE_EVENT_API_VERSION=2026-06-24.dahlia \
E2E_TRANSITION_POLICY=full_period_reset \
  scripts/run_browser_e2e.sh
E2E_STRIPE_EVENT_API_VERSION=2026-06-24.dahlia \
E2E_TRANSITION_POLICY=prorated_delta \
  scripts/run_browser_e2e.sh
```

It creates a temporary test Webhook Endpoint with only the supported Events, receives
real Checkout/3DS and plan-upgrade Events through a temporary HTTPS tunnel, verifies
their signatures, and checks both PostgreSQL projections. It then retrieves every stored Event ID from
Stripe and compares identity, type and mode with the signed payload saved in the inbox.
The final invariant is exactly three run-bound essential Events: the Checkout Session,
its initial paid Invoice, and the plan-change settlement paid Invoice. Those identities
must match the account, two ledger grants, and policy-specific allocation. Every other
account-matched Event is still checked, but its incidental count is not fixed.
The signed payload's `api_version` is checked against the endpoint contract; the Event
API retrieval view is recorded separately because it is not evidence of the endpoint's
delivery serialization. The endpoint, Customer and Subscription are scoped to the run
and cleaned up; an unfinished Checkout Session is expired. Cleanup failure fails the
gate and retains a secret-free, mode-`0600` recovery manifest rather than losing exact
object IDs.

See [BROWSER_E2E.md](BROWSER_E2E.md) for prerequisites, failure artifacts and the exact
browser assertions. A collected, skipped or partially completed Playwright test is not
evidence.

Current evidence boundary: the two policy runs have not been repeated after the latest
identity-binding, upgrade-SCA, and secret-isolation hardening. Earlier pre-hardening
runs on 2026-08-01 passed their decline barriers, 3DS Checkout, UI upgrades, and strict
cleanup; each happened to cross-check five account-related Events, observed Dahlia
endpoint payloads and a separate Clover Event API view, and reached the expected
projection. That is historical evidence, not a current-tree pass, and no live-
production Event is included.

## Existing staging endpoint

For an existing test-mode stack, first confirm that its endpoint has only the supported
Event set and that its secret is configured on the receiving service. The Stripe CLI
uses the account selected by its current profile:

```bash
stripe webhook_endpoints retrieve we_REPLACE_ME
stripe events retrieve evt_REPLACE_ME
```

These commands print private object data. Run them only in a private terminal; do not
paste the full output into issues or CI logs. Record a redacted endpoint URL, endpoint
mode, endpoint API version, Event ID/type/mode/API version, HTTP delivery status and
application deployment identifier.

The matching PostgreSQL evidence for the exact Event is:

```sql
select id,event_type,livemode,payload->>'api_version' as event_api_version,
       outcome,received_at,processed_at
  from stripe_webhook_events
 where id = 'evt_REPLACE_ME';

select kind,dedupe_key,resolved_at,seen_count
  from billing_incidents
 where stripe_event_id = 'evt_REPLACE_ME';
```

Inspect the account, invoice state and credit ledger in the same private session. Do not
publish customer, Subscription, Invoice, PaymentIntent, Charge, hosted-invoice or
client-secret data.

## Live production gate

Test and live mode do not share keys, Products, Prices, Customers, Events, endpoints or
signing secrets. A test-mode success—even on a production-looking hostname—is not live
production evidence.

Production verification requires all of the following:

- an approved `sk_live_` credential in the production secret manager;
- a distinct live `whsec_` secret bound to the exact receiving service;
- the live Webhook Endpoint ID and expected HTTPS URL;
- read-only access to the production Event inbox and incident tables;
- an approved low-risk real payment or recovery scenario and a rollback/support owner.

Use this release sequence:

1. classify the key as live without printing it;
2. retrieve the live endpoint privately and verify URL, enabled Events, status and API
   version;
3. perform the approved low-risk live Checkout or hosted-invoice recovery action;
4. record the resulting Event ID from Stripe's delivery view;
5. verify a 2xx delivery and retrieve that exact Event privately;
6. query the exact inbox row and confirm `livemode=true`, matching `api_version`, a
   handled outcome and no unresolved contract incident;
7. verify that entitlement changed only after the signed Event committed;
8. retain only redacted evidence and monitor retries/5xx before widening traffic.

Never use `stripe trigger`, test card numbers, Test Clocks or the automated object-
creation suite with a live key. If a live key, endpoint, production database view or
approved low-risk transaction is absent, mark production payload verification as
**not run**. Do not infer it from test mode, DNS, a successful browser redirect or an
outbound Stripe API call.

## Private release evidence template

```text
deployment:
mode: test | live
endpoint_url (redacted):
endpoint_status:
enabled_event_contract:
request_api_version:
endpoint_signed_payload_api_version:
event_api_retrieval_view_version:
observed_event_type:
delivery_http_status:
database_outcome:
business_projection:
unresolved_incidents:
cleanup_or_rollback:
skipped_checks_and_reason:
```
