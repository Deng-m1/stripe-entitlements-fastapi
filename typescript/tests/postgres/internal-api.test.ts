import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, test } from "vitest";

import { PlanCatalog } from "../../src/catalog.js";
import type { Database } from "../../src/database.js";
import { EntitlementService } from "../../src/entitlements.js";
import {
  CREDITS_CHARGE_SCOPE,
  CREDITS_REFUND_SCOPE,
  createInternalBillingFetchHandler,
  ENTITLEMENTS_CHECK_SCOPE,
} from "../../src/internal-api.js";
import {
  WorkloadAuthenticationError,
  WorkloadAuthorizationError,
  WorkloadPrincipal,
  type WorkloadIdentityAdapter,
  type WorkloadOwnerAuthorizer,
} from "../../src/internal-auth.js";
import { postgresDatabase } from "../support/postgres-setup.js";

const CATALOG_PATH = fileURLToPath(
  new URL("../../../plans.toml", import.meta.url),
);

let database: Database;
let catalog: PlanCatalog;

class StaticAuth implements WorkloadIdentityAdapter {
  readonly #principal: WorkloadPrincipal;

  public constructor(...scopes: string[]) {
    this.#principal = new WorkloadPrincipal({
      issuer: "https://workload.example.test",
      subject: "product-api",
      scopes: new Set(scopes),
    });
  }

  public async authenticate(): Promise<WorkloadPrincipal> {
    return this.#principal;
  }
}

class SecretRejectingAuth implements WorkloadIdentityAdapter {
  public async authenticate(): Promise<WorkloadPrincipal> {
    throw new WorkloadAuthenticationError(
      "expired secret-token-body sk_test_must_not_escape",
    );
  }
}

class BoundOwners implements WorkloadOwnerAuthorizer {
  readonly #owners: ReadonlySet<string>;

  public constructor(...owners: string[]) {
    this.#owners = new Set(owners);
  }

  public async authorize(
    _principal: WorkloadPrincipal,
    ownerExternalRef: string,
  ): Promise<void> {
    if (!this.#owners.has(ownerExternalRef)) {
      throw new WorkloadAuthorizationError(
        "host membership denied with private detail",
      );
    }
  }
}

async function fundedOwner(): Promise<{
  readonly accountId: string;
  readonly owner: string;
}> {
  const owner = `v1:user:${randomUUID()}`;
  const accountId = await database.createAccount(owner);
  await database.query(
    `update billing_accounts set
       stripe_customer_id=$2,stripe_subscription_id=$3,
       plan_key='starter',plan_interval='month',subscription_status='active',
       credits_balance=300000000,grant_epoch=1,
       current_period_end=clock_timestamp()+interval '30 days',
       entitlement_period_end=clock_timestamp()+interval '30 days',
       credit_expires_at=clock_timestamp()+interval '30 days'
     where id=$1::uuid`,
    [accountId, `cus_${randomUUID()}`, `sub_${randomUUID()}`],
  );
  return { accountId, owner };
}

function handler(input: {
  readonly auth?: WorkloadIdentityAdapter;
  readonly owners?: readonly string[];
}) {
  return createInternalBillingFetchHandler({
    serviceProvider: () => new EntitlementService(database, catalog),
    ...(input.auth === undefined ? {} : { authAdapter: input.auth }),
    ...(input.owners === undefined
      ? {}
      : { ownerAuthorizer: new BoundOwners(...input.owners) }),
  });
}

function jsonRequest(
  path: string,
  body: unknown,
  options: { readonly headers?: HeadersInit; readonly method?: string } = {},
): Request {
  return new Request(`http://internal.test${path}`, {
    method: options.method ?? "POST",
    headers: { "content-type": "application/json", ...options.headers },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  database = postgresDatabase();
  catalog = await PlanCatalog.fromToml(CATALOG_PATH);
});

describe("service-identity protected internal API", () => {
  test("reject-all default and authentication errors are sanitized", async () => {
    const owner = `v1:user:${randomUUID()}`;
    const defaultResponse = await handler({})(
      jsonRequest("/internal/v1/entitlements/check", {
        owner_external_ref: owner,
      }),
    );
    const rejected = await handler({ auth: new SecretRejectingAuth() })(
      jsonRequest("/internal/v1/entitlements/check", {
        owner_external_ref: owner,
      }),
    );

    expect(defaultResponse.status).toBe(401);
    expect(rejected.status).toBe(401);
    expect(defaultResponse.headers.get("cache-control")).toBe("no-store");
    expect(await defaultResponse.json()).toEqual({
      detail: "workload authentication failed",
    });
    const text = await rejected.text();
    expect(text).toBe('{"detail":"workload authentication failed"}');
    expect(text).not.toContain("secret-token-body");
    expect(text).not.toContain("sk_test_");
  });

  test("scopes are capability-specific and owner authorization fails closed", async () => {
    const owner = `v1:user:${randomUUID()}`;
    const scoped = handler({
      auth: new StaticAuth(ENTITLEMENTS_CHECK_SCOPE),
      owners: [owner],
    });
    const check = await scoped(
      jsonRequest("/internal/v1/entitlements/check", {
        owner_external_ref: owner,
      }),
    );
    const charge = await scoped(
      jsonRequest(
        "/internal/v1/credits/charge",
        { owner_external_ref: owner, amount: "1" },
        { headers: { "Idempotency-Key": "scope-denied" } },
      ),
    );
    const noAuthorizer = await handler({
      auth: new StaticAuth(ENTITLEMENTS_CHECK_SCOPE),
    })(
      jsonRequest("/internal/v1/entitlements/check", {
        owner_external_ref: owner,
      }),
    );

    expect(check.status).toBe(200);
    expect(charge.status).toBe(403);
    expect(await charge.json()).toEqual({
      detail: "workload is not authorized",
    });
    expect(noAuthorizer.status).toBe(403);
  });

  test("cross-owner authorization happens before any service lookup", async () => {
    const permitted = `v1:tenant:${randomUUID()}`;
    const other = `v1:tenant:${randomUUID()}`;
    const response = await handler({
      auth: new StaticAuth(ENTITLEMENTS_CHECK_SCOPE),
      owners: [permitted],
    })(
      jsonRequest("/internal/v1/entitlements/check", {
        owner_external_ref: other,
      }),
    );

    expect(response.status).toBe(403);
    const text = await response.text();
    expect(text).toBe('{"detail":"workload is not authorized"}');
    expect(text).not.toContain("membership denied");
  });

  test("check response exposes decisions but no Stripe or recovery identifiers", async () => {
    const { owner } = await fundedOwner();
    const response = await handler({
      auth: new StaticAuth(ENTITLEMENTS_CHECK_SCOPE),
      owners: [owner],
    })(
      jsonRequest("/internal/v1/entitlements/check", {
        owner_external_ref: owner,
        required_features: ["pdf_to_ppt"],
        required_limits: { max_file_mb: 30 },
      }),
    );
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      allowed: true,
      features: { pdf_to_ppt: true },
      limits: {
        max_file_mb: { requested: 30, maximum: 30, allowed: true },
      },
      credits: { balance: "300", balance_atoms: "300000000", spendable: true },
    });
    const text = JSON.stringify(payload);
    for (const forbidden of [
      "account_id",
      "stripe_customer_id",
      "stripe_subscription_id",
      "payment_url",
      "recovery_url",
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });

  test("strict schemas reject infrastructure selectors and numeric credit amounts", async () => {
    const owner = `v1:user:${randomUUID()}`;
    const api = handler({
      auth: new StaticAuth(ENTITLEMENTS_CHECK_SCOPE, CREDITS_CHARGE_SCOPE),
      owners: [owner],
    });
    const smuggled = await api(
      jsonRequest("/internal/v1/entitlements/check", {
        owner_external_ref: owner,
        stripe_customer_id: "cus_attacker",
      }),
    );
    const numeric = await api(
      jsonRequest(
        "/internal/v1/credits/charge",
        { owner_external_ref: owner, amount: 0.1 },
        { headers: { "Idempotency-Key": "numeric" } },
      ),
    );

    expect(smuggled.status).toBe(422);
    expect(numeric.status).toBe(422);
  });

  test("charge maps exact decimal replay, conflict, and insufficient funding", async () => {
    const { owner } = await fundedOwner();
    const api = handler({
      auth: new StaticAuth(CREDITS_CHARGE_SCOPE),
      owners: [owner],
    });
    const request = (amount: string, key = "api-product-job") =>
      api(
        jsonRequest(
          "/internal/v1/credits/charge",
          { owner_external_ref: owner, amount },
          { headers: { "Idempotency-Key": key } },
        ),
      );

    const charged = await request("0.1");
    const replay = await request("0.100000");
    const conflict = await request("0.100001");
    const insufficient = await request("300.000001", "too-many");

    expect(charged.status).toBe(200);
    expect(await charged.json()).toMatchObject({
      outcome: "charged",
      balance: "299.9",
      requested: "0.1",
      requested_atoms: "100000",
      restored: "0",
    });
    expect(await replay.json()).toMatchObject({ outcome: "replayed" });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({
      detail: "credit idempotency conflict",
    });
    expect(insufficient.status).toBe(409);
    expect(await insufficient.json()).toEqual({
      detail: "insufficient credits",
    });
  });

  test("expired and missing owners map to stable non-sensitive errors", async () => {
    const { accountId, owner } = await fundedOwner();
    const missing = `v1:user:${randomUUID()}`;
    const api = handler({
      auth: new StaticAuth(CREDITS_CHARGE_SCOPE),
      owners: [owner, missing],
    });
    const missingResponse = await api(
      jsonRequest(
        "/internal/v1/credits/charge",
        { owner_external_ref: missing, amount: "1" },
        { headers: { "Idempotency-Key": "missing" } },
      ),
    );
    await database.query(
      `update billing_accounts set credit_expires_at=clock_timestamp()-interval '1 second'
        where id=$1::uuid`,
      [accountId],
    );
    const expired = await api(
      jsonRequest(
        "/internal/v1/credits/charge",
        { owner_external_ref: owner, amount: "1" },
        { headers: { "Idempotency-Key": "expired" } },
      ),
    );

    expect(missingResponse.status).toBe(404);
    expect(await missingResponse.json()).toEqual({
      detail: "billing owner not found",
    });
    expect(expired.status).toBe(409);
    expect(await expired.json()).toEqual({ detail: "credits are unavailable" });
  });

  test("refund is owner-bound and unknown/cross-owner keys are indistinguishable", async () => {
    const first = await fundedOwner();
    const second = await fundedOwner();
    const chargeApi = handler({
      auth: new StaticAuth(CREDITS_CHARGE_SCOPE),
      owners: [first.owner],
    });
    await chargeApi(
      jsonRequest(
        "/internal/v1/credits/charge",
        { owner_external_ref: first.owner, amount: "10" },
        { headers: { "Idempotency-Key": "private-owner-job" } },
      ),
    );
    const refundApi = handler({
      auth: new StaticAuth(CREDITS_REFUND_SCOPE),
      owners: [first.owner, second.owner],
    });
    const refund = (owner: string, key: string) =>
      refundApi(
        jsonRequest(
          "/internal/v1/credits/refund",
          { owner_external_ref: owner },
          { headers: { "Idempotency-Key": key } },
        ),
      );

    const crossOwner = await refund(second.owner, "private-owner-job");
    const unknown = await refund(second.owner, "unknown-owner-job");
    const legitimate = await refund(first.owner, "private-owner-job");
    const replay = await refund(first.owner, "private-owner-job");

    expect(crossOwner.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await crossOwner.json()).toEqual(await unknown.json());
    expect(await legitimate.json()).toMatchObject({
      outcome: "refunded",
      requested: "10",
      restored: "10",
    });
    expect(await replay.json()).toMatchObject({ outcome: "replayed" });
  });

  test("body bounds, wrong methods, and absent idempotency headers fail closed", async () => {
    const owner = `v1:user:${randomUUID()}`;
    const api = handler({
      auth: new StaticAuth(CREDITS_CHARGE_SCOPE),
      owners: [owner],
    });
    const oversized = await api(
      new Request("http://internal.test/internal/v1/credits/charge", {
        method: "POST",
        headers: { "content-length": "65537" },
        body: "{}",
      }),
    );
    const mismatched = await api(
      new Request("http://internal.test/internal/v1/credits/charge", {
        method: "POST",
        headers: { "content-length": "1" },
        body: "{}",
      }),
    );
    const malformed = await api(
      new Request("http://internal.test/internal/v1/credits/charge", {
        method: "POST",
        headers: { "content-length": "2e0" },
        body: "{}",
      }),
    );
    let canceled = false;
    const streamedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(32 * 1024));
        controller.enqueue(new Uint8Array(32 * 1024 + 1));
      },
      cancel() {
        canceled = true;
      },
    });
    const streamInit: RequestInit & { duplex: "half" } = {
      method: "POST",
      body: streamedBody,
      duplex: "half",
    };
    const streamedOversized = await api(
      new Request(
        "http://internal.test/internal/v1/credits/charge",
        streamInit,
      ),
    );
    const wrongMethod = await api(
      new Request("http://internal.test/internal/v1/credits/charge", {
        method: "GET",
      }),
    );
    const missingKey = await api(
      jsonRequest("/internal/v1/credits/charge", {
        owner_external_ref: owner,
        amount: "1",
      }),
    );

    expect(oversized.status).toBe(422);
    expect(mismatched.status).toBe(422);
    expect(malformed.status).toBe(422);
    expect(streamedOversized.status).toBe(422);
    expect(canceled).toBe(true);
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("POST");
    expect(missingKey.status).toBe(422);
  });
});
