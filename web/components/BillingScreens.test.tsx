import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AccountScreen } from "@/components/AccountScreen";
import { PricingScreen } from "@/components/PricingScreen";
import { SuccessScreen } from "@/components/SuccessScreen";
import {
  createMockBillingApi,
  demoAccount,
  demoCatalog,
} from "@/lib/mock-api";
import type {
  AccountResponse,
  BillingApi,
  ChangeConfirmResponse,
  ChangePreview,
} from "@/lib/types";

function preview(
  values: Partial<ChangePreview> = {},
): ChangePreview {
  return {
    preview_id: "preview-test",
    current_plan_key: "starter",
    current_interval: "month",
    target_plan_key: "pro",
    target_interval: "year",
    timing: "immediate",
    effective_at: "2026-08-01T00:00:00.000Z",
    currency: "USD",
    amount_due_now: 35300,
    credit_applied: 0,
    next_invoice_amount: 35300,
    ...values,
  };
}

function testApi(options: {
  account?: AccountResponse;
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
      target_plan_key: changePreview.target_plan_key,
      target_interval: changePreview.target_interval,
      account,
    } satisfies ChangeConfirmResponse);

  const api: BillingApi = {
    getCatalog: vi.fn(async () => demoCatalog()),
    getAccount: vi.fn(async () => account),
    createCheckout: vi.fn(async () => ({
      url: "https://checkout.stripe.com/c/pay/test-session",
    })),
    createPortal: vi.fn(async () => ({
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
    await user.click(screen.getByRole("button", { name: "Yearly" }));

    expect(screen.getByText("$137.00 billed yearly")).toBeInTheDocument();
    expect(screen.getByText("$11.42")).toBeInTheDocument();
    expect(screen.getByText("Save $91.00/year")).toBeInTheDocument();
    expect(screen.getByText("Plan key: starter")).toBeInTheDocument();
  });

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

  it("uses explicit period-end copy and then displays pending state", async () => {
    const user = userEvent.setup();
    const pendingAccount: AccountResponse = {
      ...demoAccount("pro", "year"),
      pending_change: {
        target_plan_key: "starter",
        target_interval: "month",
        timing: "period_end",
        effective_at: "2026-09-01T00:00:00.000Z",
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
        amount_due_now: 0,
        credit_applied: 0,
        next_invoice_amount: 1900,
        effective_at: "2026-09-01T00:00:00.000Z",
      }),
      confirm: {
        status: "confirmed",
        timing: "period_end",
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

  it("polls account state until the target webhook projection appears", async () => {
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
