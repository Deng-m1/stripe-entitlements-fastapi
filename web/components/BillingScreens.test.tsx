import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AccountScreen } from "@/components/AccountScreen";
import { PricingScreen } from "@/components/PricingScreen";
import { SuccessScreen } from "@/components/SuccessScreen";
import {
  CREDIT_SCALE,
  creditAmountFromDecimal,
} from "@/lib/credit-amount";
import { BillingApiError } from "@/lib/http-api";
import {
  completeIdempotentIntent,
  idempotencyKeyForIntent,
} from "@/lib/idempotency";
import {
  createMockBillingApi,
  demoAccount,
  demoCatalog,
} from "@/lib/mock-api";
import type {
  AccountResponse,
  BillingApi,
  CatalogResponse,
  ChangeConfirmResponse,
  ChangePreview,
} from "@/lib/types";

function preview(
  values: Partial<ChangePreview> = {},
): ChangePreview {
  const result: ChangePreview = {
    preview_id: "preview-test",
    current_plan_key: "starter",
    current_interval: "month",
    target_plan_key: "pro",
    target_interval: "year",
    timing: "immediate",
    transition_policy: "full_period_reset",
    settlement_mode: "new_period_full_price",
    effective_at: "2026-08-01T00:00:00.000Z",
    currency: "USD",
    amount_due_now: 35300,
    credit_applied: 0,
    entitlement_credit_delta: null,
    entitlement_credit_delta_atoms: null,
    credit_scale: CREDIT_SCALE,
    next_invoice_amount: 35300,
    ...values,
  };
  if (
    result.entitlement_credit_delta !== null &&
    values.entitlement_credit_delta_atoms === undefined
  ) {
    result.entitlement_credit_delta_atoms = creditAmountFromDecimal(
      result.entitlement_credit_delta,
    ).atoms;
  }
  return result;
}

function testApi(options: {
  account?: AccountResponse;
  catalog?: CatalogResponse;
  changePreview?: ChangePreview;
  confirm?: ChangeConfirmResponse;
}) {
  let account = options.account ?? demoAccount();
  const changePreview = options.changePreview ?? preview();
  const confirm =
    options.confirm ??
    ({
      status: "confirmed",
      timing: changePreview.timing,
      transition_policy: changePreview.transition_policy,
      target_plan_key: changePreview.target_plan_key,
      target_interval: changePreview.target_interval,
      account,
    } satisfies ChangeConfirmResponse);

  const api: BillingApi = {
    getCatalog: vi.fn(async () => options.catalog ?? demoCatalog()),
    getAccount: vi.fn(async () => account),
    createCheckout: vi.fn(async () => ({
      url: "https://checkout.stripe.com/c/pay/test-session",
    })),
    createCreditPackCheckout: vi.fn(async () => ({
      session_id: "cs_test_credit_pack",
      url: "https://checkout.stripe.com/c/pay/test-credit-pack",
    })),
    createPortal: vi.fn(async () => ({
      session_id: "bps_test_portal",
      url: "https://billing.stripe.com/p/session/test-portal",
    })),
    previewPlanChange: vi.fn(async () => changePreview),
    confirmPlanChange: vi.fn(async () => {
      if (confirm.account) account = confirm.account;
      return confirm;
    }),
  };
  return api;
}

describe("billing screens", () => {
  it("server-renders the reference catalog before account loading completes", () => {
    const api = testApi({});
    api.getCatalog = vi.fn(() => new Promise<never>(() => undefined));
    api.getAccount = vi.fn(() => new Promise<never>(() => undefined));

    render(
      <PricingScreen
        api={api}
        initialCatalog={demoCatalog()}
        billingRedirect={vi.fn()}
        internalRedirect={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "Starter" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Pro" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Ultra" })).toBeInTheDocument();
    expect(screen.getByText(/Plans are ready/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Choose Starter month" }),
    ).toBeDisabled();
  });

  it("shows annual total, equivalent monthly price, and savings", async () => {
    const user = userEvent.setup();
    render(
      <PricingScreen
        api={testApi({})}
        billingRedirect={vi.fn()}
        internalRedirect={vi.fn()}
      />,
    );

    await screen.findByRole("heading", { name: "Starter" });
    expect(
      screen.getByText("or $11.42/mo with yearly billing"),
    ).toBeInTheDocument();
    expect(screen.getByText("Save 40%")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Yearly" }));

    expect(screen.getByText("$137.00 billed yearly")).toBeInTheDocument();
    expect(screen.getByText("$11.42")).toBeInTheDocument();
    expect(screen.getByText("Save $91.00/year")).toBeInTheDocument();
    expect(screen.getByText("Plan key: starter")).toBeInTheDocument();
  });

  it("renders a tier ladder and an honest catalog comparison table", async () => {
    render(
      <PricingScreen
        api={testApi({})}
        billingRedirect={vi.fn()}
        internalRedirect={vi.fn()}
      />,
    );

    await screen.findByRole("heading", { name: "Starter" });
    expect(screen.getByText("Includes:")).toBeInTheDocument();
    expect(screen.getByText("Everything in Starter, plus:")).toBeInTheDocument();
    expect(screen.getByText("Everything in Pro, plus:")).toBeInTheDocument();
    expect(screen.getByText("Recommended").closest("article")).toHaveTextContent(
      "Pro",
    );

    const table = screen.getByRole("table", {
      name: "Plan price and entitlement comparison",
    });
    expect(
      within(table).getByRole("columnheader", { name: "Ultra" }),
    ).toBeInTheDocument();
    const savingsRow = within(table).getByRole("row", {
      name: /Yearly savings vs monthly/,
    });
    expect(within(savingsRow).getByText("$91.00 (40%)")).toBeInTheDocument();
    const priorityRow = within(table).getByRole("row", {
      name: /Priority queue/,
    });
    expect(within(priorityRow).getAllByText("Not included")).toHaveLength(2);
    expect(within(priorityRow).getAllByText("Included")).toHaveLength(1);
    expect(
      screen.getByText(
        /no Stripe Coupon or promotion code is created or simulated/,
      ),
    ).toBeInTheDocument();
  });

  it.each(["feature removal", "limit reduction", "credit reduction"] as const)(
    "does not claim inheritance after a %s",
    async (tradeoff) => {
      const catalog = demoCatalog();
      const reducedCredits = creditAmountFromDecimal("100");
      const plans = catalog.plans.map((plan) => {
        if (plan.key !== "pro") return plan;
        const entitlements = plan.entitlements
          .filter(
            (entitlement) =>
              tradeoff !== "feature removal" || entitlement.key !== "pdf_to_ppt",
          )
          .map((entitlement) => {
            if (tradeoff === "limit reduction" && entitlement.key === "max_file_mb") {
              return { ...entitlement, value: 20 };
            }
            if (
              tradeoff === "credit reduction" &&
              entitlement.key === "monthly_credits"
            ) {
              return {
                ...entitlement,
                value: reducedCredits.decimal,
                value_atoms: reducedCredits.atoms,
                scale: reducedCredits.scale,
              };
            }
            return entitlement;
          });
        return { ...plan, entitlements };
      });

      render(
        <PricingScreen
          api={testApi({ catalog: { ...catalog, plans } })}
          billingRedirect={vi.fn()}
          internalRedirect={vi.fn()}
        />,
      );

      const proCard = (await screen.findByRole("heading", { name: "Pro" })).closest(
        "article",
      );
      expect(proCard).not.toBeNull();
      if (!proCard) return;
      expect(within(proCard).getByText("Includes:")).toBeInTheDocument();
      expect(
        within(proCard).queryByText("Everything in Starter, plus:"),
      ).not.toBeInTheDocument();
      if (tradeoff === "feature removal") {
        expect(proCard).not.toHaveTextContent("PDF to PowerPoint");
      } else if (tradeoff === "limit reduction") {
        expect(proCard).toHaveTextContent("Maximum file size: 20 MB");
      } else {
        expect(proCard).toHaveTextContent(
          "Credits per monthly grant: 100 credits",
        );
      }
    },
  );

  it("renders immediate cross-plan/interval copy and polls after confirmation", async () => {
    const user = userEvent.setup();
    const redirect = vi.fn();
    const api = testApi({});
    render(
      <PricingScreen
        api={api}
        billingRedirect={redirect}
        internalRedirect={redirect}
      />,
    );

    await screen.findByRole("heading", { name: "Starter" });
    await user.click(screen.getByRole("button", { name: "Yearly" }));
    await user.click(screen.getByRole("button", { name: "Choose Pro year" }));

    expect(
      await screen.findByRole("heading", {
        name: "This change requires immediate settlement",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/cross-invoice proration and customer-balance credit are both zero/),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("checkbox", {
        name: /may charge me and still requires webhook confirmation/,
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "Confirm billing change" }),
    );

    await waitFor(() => {
      expect(redirect).toHaveBeenCalledWith(
        expect.stringMatching(
          /\/billing\/success\?expected_plan=pro&expected_interval=year/,
        ),
      );
    });
    expect(api.confirmPlanChange).toHaveBeenCalledWith({
      preview_id: "preview-test",
    });
  });

  it("renders server-authoritative prorated-delta settlement and entitlement copy", async () => {
    const user = userEvent.setup();
    const api = testApi({
      changePreview: preview({
        target_plan_key: "pro",
        target_interval: "month",
        transition_policy: "prorated_delta",
        settlement_mode: "current_period_prorated_delta",
        amount_due_now: 1500,
        credit_applied: 950,
        entitlement_credit_delta: "700",
        next_invoice_amount: 4900,
      }),
    });
    render(
      <PricingScreen
        api={api}
        billingRedirect={vi.fn()}
        internalRedirect={vi.fn()}
      />,
    );

    await screen.findByRole("heading", { name: "Starter" });
    await user.click(screen.getByRole("button", { name: "Choose Pro month" }));
    expect(
      await screen.findByRole("heading", {
        name: "Pay the prorated difference for this period",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("Prorated amount due: $15.00")).toBeInTheDocument();
    expect(screen.getByText(/adds exactly 700 credits/)).toBeInTheDocument();
    expect(screen.getByText("$9.50")).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: /charge the prorated difference/ }),
    ).toBeInTheDocument();
  });

  it("uses explicit period-end copy and then displays pending state", async () => {
    const user = userEvent.setup();
    const pendingAccount: AccountResponse = {
      ...demoAccount("pro", "year"),
      pending_change: {
        target_plan_key: "starter",
        target_interval: "month",
        timing: "period_end",
        effective_at: "2026-09-01T00:00:00.000Z",
        transition_policy: "full_period_reset",
      },
    };
    const api = testApi({
      account: demoAccount("pro", "year"),
      changePreview: preview({
        current_plan_key: "pro",
        current_interval: "year",
        target_plan_key: "starter",
        target_interval: "month",
        timing: "period_end",
        settlement_mode: "period_end",
        amount_due_now: 0,
        credit_applied: 0,
        next_invoice_amount: 1900,
        effective_at: "2026-09-01T00:00:00.000Z",
      }),
      confirm: {
        status: "confirmed",
        timing: "period_end",
        transition_policy: "full_period_reset",
        target_plan_key: "starter",
        target_interval: "month",
        account: pendingAccount,
      },
    });
    render(
      <PricingScreen
        api={api}
        billingRedirect={vi.fn()}
        internalRedirect={vi.fn()}
      />,
    );

    await screen.findByRole("heading", { name: "Pro" });
    await user.click(
      screen.getByRole("button", { name: "Choose Starter month" }),
    );
    expect(
      await screen.findByRole("heading", {
        name: "This change starts at period end",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("No charge today")).toBeInTheDocument();
    await user.click(
      screen.getByRole("checkbox", {
        name: /current plan remains active until period end/,
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "Confirm billing change" }),
    );

    expect(
      await screen.findByText(/account API reports the pending period-end change/),
    ).toBeInTheDocument();
  });

  it("creates Checkout for an account without a subscription", async () => {
    const user = userEvent.setup();
    const redirect = vi.fn();
    const api = testApi({
      account: {
        ...demoAccount(),
        plan_key: "free",
        plan_interval: null,
        subscription_status: "none",
        current_period_end: null,
        entitlements: [],
      },
    });
    render(
      <PricingScreen
        api={api}
        billingRedirect={redirect}
        internalRedirect={redirect}
      />,
    );

    await screen.findByRole("heading", { name: "Starter" });
    await user.click(
      screen.getByRole("button", { name: "Choose Starter month" }),
    );

    await waitFor(() => {
      expect(api.createCheckout).toHaveBeenCalledWith(
        expect.objectContaining({
          plan_key: "starter",
          interval: "month",
        }),
        expect.objectContaining({
          idempotencyKey: expect.any(String),
        }),
      );
    });
    expect(redirect).toHaveBeenCalledWith(
      "https://checkout.stripe.com/c/pay/test-session",
    );
  });

  it("opens hosted one-time Checkout for a server-catalog credit pack", async () => {
    const user = userEvent.setup();
    const redirect = vi.fn();
    const api = testApi({});
    render(
      <PricingScreen
        api={api}
        billingRedirect={redirect}
        internalRedirect={vi.fn()}
      />,
    );

    await user.click(
      await screen.findByRole("button", { name: "Buy Boost 100" }),
    );

    expect(api.createCreditPackCheckout).toHaveBeenCalledWith(
      {
        pack_key: "boost-100",
        success_url: expect.stringMatching(
          /\/billing\/success\?expected_credit_pack=boost-100$/,
        ),
        cancel_url: expect.stringMatching(/\/pricing$/),
      },
      { idempotencyKey: expect.any(String) },
    );
    expect(redirect).toHaveBeenCalledWith(
      "https://checkout.stripe.com/c/pay/test-credit-pack",
    );
    expect(
      screen.getByText(/The return page does not grant credits/),
    ).toBeInTheDocument();
  });

  it("hides the entire credit-pack section when the catalog has no packs", async () => {
    const catalog = { ...demoCatalog(), credit_packs: [] };

    render(
      <PricingScreen
        api={testApi({ catalog })}
        billingRedirect={vi.fn()}
        internalRedirect={vi.fn()}
      />,
    );

    await screen.findByRole("heading", { name: "Starter" });
    expect(
      screen.queryByRole("heading", {
        name: "Add burst capacity without changing your plan",
      }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("One-time credit packs")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/The return page does not grant credits/),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("table", { name: "Plan price and entitlement comparison" }),
    ).toBeInTheDocument();
  });

  it("retains the Checkout idempotency key after redirect so cancel-return can reopen the same Session", async () => {
    const user = userEvent.setup();
    const api = testApi({
      account: {
        ...demoAccount(),
        plan_key: "free",
        plan_interval: null,
        subscription_status: "none",
        current_period_end: null,
        entitlements: [],
      },
    });
    const redirect = vi.fn();
    render(
      <PricingScreen
        api={api}
        billingRedirect={redirect}
        internalRedirect={vi.fn()}
      />,
    );

    await screen.findByRole("heading", { name: "Starter" });
    const choose = screen.getByRole("button", { name: "Choose Starter month" });
    await user.click(choose);
    await waitFor(() => expect(api.createCheckout).toHaveBeenCalledTimes(1));
    await user.click(choose);
    await waitFor(() => expect(api.createCheckout).toHaveBeenCalledTimes(2));

    const calls = vi.mocked(api.createCheckout).mock.calls;
    const first = calls[0]?.[1] as { idempotencyKey: string };
    const second = calls[1]?.[1] as { idempotencyKey: string };
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(redirect).toHaveBeenCalledTimes(2);
  });

  it("reuses the Checkout idempotency key when the same user intent is retried", async () => {
    const user = userEvent.setup();
    const api = testApi({
      account: {
        ...demoAccount(),
        plan_key: "free",
        plan_interval: null,
        subscription_status: "none",
        current_period_end: null,
        entitlements: [],
      },
    });
    const createCheckout = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary network failure"))
      .mockResolvedValueOnce({
        url: "https://checkout.stripe.com/c/pay/recovered",
      });
    api.createCheckout = createCheckout;
    render(
      <PricingScreen
        api={api}
        billingRedirect={vi.fn()}
        internalRedirect={vi.fn()}
      />,
    );

    await screen.findByRole("heading", { name: "Starter" });
    await user.click(
      screen.getByRole("button", { name: "Choose Starter month" }),
    );
    expect(
      await screen.findByText("temporary network failure"),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Choose Starter month" }),
    );
    await waitFor(() => expect(createCheckout).toHaveBeenCalledTimes(2));

    const firstOptions = createCheckout.mock.calls[0]?.[1] as {
      idempotencyKey: string;
    };
    const secondOptions = createCheckout.mock.calls[1]?.[1] as {
      idempotencyKey: string;
    };
    expect(secondOptions.idempotencyKey).toBe(firstOptions.idempotencyKey);
  });

  it("reuses the preview idempotency key when the same user intent is retried", async () => {
    const user = userEvent.setup();
    const api = testApi({});
    const previewPlanChange = vi
      .fn()
      .mockRejectedValueOnce(new Error("preview temporarily unavailable"))
      .mockResolvedValueOnce(preview());
    api.previewPlanChange = previewPlanChange;
    render(
      <PricingScreen
        api={api}
        billingRedirect={vi.fn()}
        internalRedirect={vi.fn()}
      />,
    );

    await screen.findByRole("heading", { name: "Starter" });
    await user.click(screen.getByRole("button", { name: "Yearly" }));
    await user.click(screen.getByRole("button", { name: "Choose Pro year" }));
    expect(
      await screen.findByText("preview temporarily unavailable"),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Choose Pro year" }));
    await screen.findByRole("heading", {
      name: "This change requires immediate settlement",
    });

    const firstOptions = previewPlanChange.mock.calls[0]?.[1] as {
      idempotencyKey: string;
    };
    const secondOptions = previewPlanChange.mock.calls[1]?.[1] as {
      idempotencyKey: string;
    };
    expect(secondOptions.idempotencyKey).toBe(firstOptions.idempotencyKey);
  });

  it("rotates a terminally expired preview key but retains retryable preview failures", async () => {
    const user = userEvent.setup();
    const api = testApi({});
    const previewPlanChange = vi
      .fn()
      .mockRejectedValueOnce(
        new BillingApiError(
          "this plan-change intent is no longer reusable; start a new intent",
          409,
        ),
      )
      .mockResolvedValueOnce(preview());
    api.previewPlanChange = previewPlanChange;
    render(
      <PricingScreen
        api={api}
        billingRedirect={vi.fn()}
        internalRedirect={vi.fn()}
      />,
    );

    await screen.findByRole("heading", { name: "Starter" });
    await user.click(screen.getByRole("button", { name: "Yearly" }));
    const choose = screen.getByRole("button", { name: "Choose Pro year" });
    await user.click(choose);
    expect(await screen.findByText(/no longer reusable/)).toBeInTheDocument();
    await user.click(choose);
    await screen.findByRole("dialog");

    const calls = previewPlanChange.mock.calls;
    const first = calls[0]?.[1] as { idempotencyKey: string };
    const second = calls[1]?.[1] as { idempotencyKey: string };
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
  });

  it("retains a successful preview idempotency key when the dialog is closed and reopened", async () => {
    const user = userEvent.setup();
    const api = testApi({});
    render(
      <PricingScreen
        api={api}
        billingRedirect={vi.fn()}
        internalRedirect={vi.fn()}
      />,
    );

    await screen.findByRole("heading", { name: "Starter" });
    await user.click(screen.getByRole("button", { name: "Yearly" }));
    const choose = screen.getByRole("button", { name: "Choose Pro year" });
    await user.click(choose);
    await screen.findByRole("dialog");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(choose);
    await waitFor(() => expect(api.previewPlanChange).toHaveBeenCalledTimes(2));

    const calls = vi.mocked(api.previewPlanChange).mock.calls;
    const first = calls[0]?.[1] as { idempotencyKey: string };
    const second = calls[1]?.[1] as { idempotencyKey: string };
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
  });

  it("opens the Portal and renders a structured pending change", async () => {
    const user = userEvent.setup();
    const redirect = vi.fn();
    const api = testApi({
      account: {
        ...demoAccount(),
        pending_change: {
          target_plan_key: "ultra",
          target_interval: "year",
          timing: "period_end",
          effective_at: "2026-09-01T00:00:00.000Z",
          transition_policy: "full_period_reset",
        },
      },
    });
    render(<AccountScreen api={api} redirect={redirect} />);

    expect(
      await screen.findByRole("heading", { name: "Ultra · year" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/current benefits remain active until/)).toBeInTheDocument();
    expect(screen.getByText("Credits per monthly grant")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Open Stripe Billing Portal" }),
    );
    await waitFor(() => expect(api.createPortal).toHaveBeenCalledOnce());
    expect(redirect).toHaveBeenCalledWith(
      "https://billing.stripe.com/p/session/test-portal",
    );
  });

  it("shows period-end cancellation and blocks price changes until resumed", async () => {
    const api = testApi({
      account: {
        ...demoAccount(),
        pending_cancellation: {
          target_plan_key: "free",
          timing: "period_end",
          effective_at: "2026-09-01T00:00:00.000Z",
        },
      },
    });

    render(<AccountScreen api={api} redirect={vi.fn()} />);

    expect(
      await screen.findByRole("heading", { name: "Current plan → Free" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/plan changes are paused while cancellation is pending/i),
    ).toBeInTheDocument();

    render(
      <PricingScreen
        api={api}
        billingRedirect={vi.fn()}
        internalRedirect={vi.fn()}
      />,
    );
    const blocked = await screen.findAllByRole("button", {
      name: /Choose .* (month|year)/,
    });
    expect(blocked).toHaveLength(3);
    for (const button of blocked) expect(button).toBeDisabled();
  });

  it("reuses the Portal idempotency key and sends a canonical return URL", async () => {
    const user = userEvent.setup();
    const api = testApi({});
    const createPortal = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary Portal failure"))
      .mockResolvedValueOnce({
        session_id: "bps_test_recovered",
        url: "https://billing.stripe.com/p/session/recovered",
      });
    api.createPortal = createPortal;
    render(<AccountScreen api={api} redirect={vi.fn()} />);

    const portalButton = await screen.findByRole("button", {
      name: "Open Stripe Billing Portal",
    });
    await user.click(portalButton);
    expect(await screen.findByText("temporary Portal failure")).toBeInTheDocument();
    await user.click(portalButton);
    await waitFor(() => expect(createPortal).toHaveBeenCalledTimes(2));

    const [firstUrl, firstOptions] = createPortal.mock.calls[0] as [
      string,
      { idempotencyKey: string },
    ];
    const [secondUrl, secondOptions] = createPortal.mock.calls[1] as [
      string,
      { idempotencyKey: string },
    ];
    expect(firstUrl).toBe(new URL("/account", window.location.origin).toString());
    expect(secondUrl).toBe(firstUrl);
    expect(secondOptions.idempotencyKey).toBe(firstOptions.idempotencyKey);
  });

  it("closes the change dialog with Escape and restores focus", async () => {
    const user = userEvent.setup();
    const api = testApi({});
    render(
      <PricingScreen
        api={api}
        billingRedirect={vi.fn()}
        internalRedirect={vi.fn()}
      />,
    );

    await screen.findByRole("heading", { name: "Starter" });
    const trigger = screen.getByRole("button", { name: "Choose Pro month" });
    await user.click(trigger);
    expect(await screen.findByRole("dialog")).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("does not treat payment_required as success without Stripe.js configuration", async () => {
    const user = userEvent.setup();
    const redirect = vi.fn();
    const api = testApi({
      confirm: {
        status: "action_required",
        timing: "immediate",
        transition_policy: "full_period_reset",
        target_plan_key: "pro",
        target_interval: "year",
        payment_client_secret: "pi_demo_secret_not_logged",
        payment_confirmation_method: "confirm_card_payment",
      },
    });
    render(
      <PricingScreen
        api={api}
        billingRedirect={redirect}
        internalRedirect={redirect}
      />,
    );

    await screen.findByRole("heading", { name: "Starter" });
    await user.click(screen.getByRole("button", { name: "Yearly" }));
    await user.click(screen.getByRole("button", { name: "Choose Pro year" }));
    await user.click(
      await screen.findByRole("checkbox", {
        name: /may charge me and still requires webhook confirmation/,
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "Confirm billing change" }),
    );

    expect(
      await screen.findByText(/NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY is not configured/),
    ).toBeInTheDocument();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("offers a hosted invoice CTA without showing the target plan as active", async () => {
    const user = userEvent.setup();
    const redirect = vi.fn();
    const api = testApi({
      confirm: {
        status: "action_required",
        timing: "immediate",
        transition_policy: "full_period_reset",
        target_plan_key: "pro",
        target_interval: "year",
        payment_url: "https://invoice.stripe.com/i/test-hosted-invoice",
      },
    });
    render(
      <PricingScreen
        api={api}
        billingRedirect={redirect}
        internalRedirect={redirect}
      />,
    );

    await screen.findByRole("heading", { name: "Starter" });
    await user.click(screen.getByRole("button", { name: "Yearly" }));
    await user.click(screen.getByRole("button", { name: "Choose Pro year" }));
    await user.click(
      await screen.findByRole("checkbox", {
        name: /may charge me and still requires webhook confirmation/,
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "Confirm billing change" }),
    );

    expect(
      await screen.findByRole("heading", {
        name: "Payment required — your current plan remains active",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/requested target is not active/)).toBeInTheDocument();
    expect(redirect).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", { name: "Open Stripe invoice" }),
    );
    expect(redirect).toHaveBeenCalledWith(
      "https://invoice.stripe.com/i/test-hosted-invoice",
    );
  });

  it("prefers in-memory Stripe.js authentication when both recovery paths exist", async () => {
    const user = userEvent.setup();
    const redirect = vi.fn();
    const api = testApi({
      confirm: {
        status: "action_required",
        timing: "immediate",
        transition_policy: "full_period_reset",
        target_plan_key: "pro",
        target_interval: "year",
        payment_url: "https://invoice.stripe.com/i/fallback-only",
        payment_client_secret: "pi_ephemeral_secret_not_persisted",
        payment_confirmation_method: "confirm_payment",
      },
    });
    render(
      <PricingScreen
        api={api}
        billingRedirect={redirect}
        internalRedirect={redirect}
      />,
    );

    await screen.findByRole("heading", { name: "Starter" });
    await user.click(screen.getByRole("button", { name: "Yearly" }));
    await user.click(screen.getByRole("button", { name: "Choose Pro year" }));
    await user.click(
      await screen.findByRole("checkbox", {
        name: /may charge me and still requires webhook confirmation/,
      }),
    );
    await user.click(screen.getByRole("button", { name: "Confirm billing change" }));

    expect(
      await screen.findByText(/NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY is not configured/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Open Stripe invoice" }),
    ).not.toBeInTheDocument();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("polls account state until the target webhook projection appears", async () => {
    const checkoutIntent = "checkout:pro:year";
    const previewIntent = "preview:pro:year";
    completeIdempotentIntent(checkoutIntent);
    completeIdempotentIntent(previewIntent);
    const checkoutKey = idempotencyKeyForIntent(checkoutIntent);
    const previewKey = idempotencyKeyForIntent(previewIntent);
    let polls = 0;
    const api = testApi({});
    api.getAccount = vi.fn(async () => {
      polls += 1;
      return polls === 1 ? demoAccount("starter", "month") : demoAccount("pro", "year");
    });
    render(
      <SuccessScreen
        api={api}
        expectedInterval="year"
        expectedPlan="pro"
        maxAttempts={3}
        pollIntervalMs={0}
      />,
    );

    expect(
      await screen.findByRole("heading", {
        name: "Webhook-backed account state is ready",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/pro\/year as active/)).toBeInTheDocument();
    expect(idempotencyKeyForIntent(checkoutIntent)).not.toBe(checkoutKey);
    expect(idempotencyKeyForIntent(previewIntent)).not.toBe(previewKey);
    completeIdempotentIntent(checkoutIntent);
    completeIdempotentIntent(previewIntent);
  });

  it("accepts a subscription Checkout return with its optional Session identity", async () => {
    const api = testApi({});
    api.getAccount = vi.fn(async () => demoAccount("starter", "month"));

    render(
      <SuccessScreen
        api={api}
        expectedCheckoutSessionId="cs_test_subscription_checkout"
        expectedInterval="month"
        expectedPlan="starter"
        maxAttempts={1}
        pollIntervalMs={0}
      />,
    );

    expect(
      await screen.findByRole("heading", {
        name: "Webhook-backed account state is ready",
      }),
    ).toBeInTheDocument();
    expect(api.getAccount).toHaveBeenCalledTimes(1);
    completeIdempotentIntent("checkout:starter:month");
    completeIdempotentIntent("preview:starter:month");
  });

  it("rejects malformed or ambiguous Checkout return targets", async () => {
    const malformedApi = testApi({});
    const { unmount } = render(
      <SuccessScreen
        api={malformedApi}
        expectedCheckoutSessionId="not-a-session"
        expectedInterval="month"
        expectedPlan="starter"
        maxAttempts={1}
        pollIntervalMs={0}
      />,
    );

    expect(
      await screen.findByRole("heading", {
        name: "This billing return cannot be verified",
      }),
    ).toBeInTheDocument();
    expect(malformedApi.getAccount).not.toHaveBeenCalled();
    unmount();

    const ambiguousApi = testApi({});
    render(
      <SuccessScreen
        api={ambiguousApi}
        expectedCheckoutSessionId="cs_test_ambiguous"
        expectedCreditPack="boost-100"
        expectedInterval="month"
        expectedPlan="starter"
        maxAttempts={1}
        pollIntervalMs={0}
      />,
    );

    expect(
      await screen.findByRole("heading", {
        name: "This billing return cannot be verified",
      }),
    ).toBeInTheDocument();
    expect(ambiguousApi.getAccount).not.toHaveBeenCalled();
  });

  it("confirms a credit pack only from its exact webhook-projected Checkout lot", async () => {
    const intent = "credit-pack:boost-100";
    completeIdempotentIntent(intent);
    const retainedKey = idempotencyKeyForIntent(intent);
    const base = demoAccount("starter", "month");
    const purchased = creditAmountFromDecimal("100");
    const total = creditAmountFromDecimal("400");
    const projected: AccountResponse = {
      ...base,
      credits: {
        ...base.credits,
        balance: total.decimal,
        balance_atoms: total.atoms,
        purchased_balance: purchased.decimal,
        purchased_balance_atoms: purchased.atoms,
        credit_packs: [
          {
            lot_id: "lot-boost-100",
            pack_key: "boost-100",
            checkout_session_id: "cs_test_exact_pack",
            remaining: purchased.decimal,
            remaining_atoms: purchased.atoms,
            expires_at: "2027-08-28T00:00:00.000Z",
          },
        ],
      },
    };
    let polls = 0;
    const api = testApi({});
    api.getAccount = vi.fn(async () => {
      polls += 1;
      return polls === 1 ? base : projected;
    });

    render(
      <SuccessScreen
        api={api}
        expectedCheckoutSessionId="cs_test_exact_pack"
        expectedCreditPack="boost-100"
        maxAttempts={3}
        pollIntervalMs={0}
      />,
    );

    expect(
      await screen.findByRole("heading", {
        name: "Webhook-backed account state is ready",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/exact Checkout Session/)).toBeInTheDocument();
    expect(screen.getAllByText("100 credits").length).toBeGreaterThanOrEqual(1);
    expect(idempotencyKeyForIntent(intent)).not.toBe(retainedKey);
    completeIdempotentIntent(intent);
  });

  it("restarts webhook polling from the timed-out state", async () => {
    const user = userEvent.setup();
    const api = testApi({});
    let polls = 0;
    api.getAccount = vi.fn(async () => {
      polls += 1;
      return polls <= 1
        ? demoAccount("starter", "month")
        : demoAccount("pro", "year");
    });
    render(
      <SuccessScreen
        api={api}
        expectedInterval="year"
        expectedPlan="pro"
        maxAttempts={1}
        pollIntervalMs={0}
      />,
    );

    expect(
      await screen.findByRole("heading", {
        name: "Payment may still be processing",
      }),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Check account state again" }),
    );
    expect(
      await screen.findByRole("heading", {
        name: "Webhook-backed account state is ready",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("1,000 credits")).toBeInTheDocument();
    completeIdempotentIntent("checkout:pro:year");
    completeIdempotentIntent("preview:pro:year");
  });

  it("does not poll or confirm when the billing return target is missing", async () => {
    const api = testApi({});
    render(<SuccessScreen api={api} maxAttempts={1} pollIntervalMs={0} />);

    expect(
      await screen.findByRole("heading", {
        name: "This billing return cannot be verified",
      }),
    ).toBeInTheDocument();
    expect(api.getAccount).not.toHaveBeenCalled();
  });

  it("does not confirm active state when entitlements are not enforceable", async () => {
    const previewIntent = "preview:pro:year:not-enforceable";
    completeIdempotentIntent(previewIntent);
    const retainedKey = idempotencyKeyForIntent(previewIntent);
    const api = testApi({});
    api.getAccount = vi.fn(async () => ({
      ...demoAccount("pro", "year"),
      entitlements_enforceable: false,
    }));
    render(
      <SuccessScreen
        api={api}
        expectedInterval="year"
        expectedPlan="pro"
        maxAttempts={1}
        pollIntervalMs={0}
      />,
    );

    expect(
      await screen.findByRole("heading", {
        name: "Payment may still be processing",
      }),
    ).toBeInTheDocument();
    expect(idempotencyKeyForIntent(previewIntent)).toBe(retainedKey);
    completeIdempotentIntent(previewIntent);
  });

  it.each(["pro", "ultra"])(
    "keeps Starter Year → %s Month at period end regardless of higher tier order",
    async (targetPlan) => {
      const api = createMockBillingApi(demoAccount("starter", "year"));
      const result = await api.previewPlanChange({
        plan_key: targetPlan,
        interval: "month",
      });

      expect(result.timing).toBe("period_end");
      expect(result.amount_due_now).toBe(0);
      expect(result.effective_at).toBe(
        (await api.getAccount()).current_period_end,
      );
    },
  );
});
