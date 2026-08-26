import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import BillingErrorPage from "@/app/billing/error/page";
import BillingSuccessPage from "@/app/billing/success/page";
import { AccountScreen } from "@/components/AccountScreen";
import { ErrorState, LoadingState } from "@/components/AsyncState";
import { DemoNotice } from "@/components/DemoNotice";
import { demoAccount, demoCatalog } from "@/lib/mock-api";
import type { AccountResponse, BillingApi } from "@/lib/types";

function accountApi(account: AccountResponse = demoAccount()): BillingApi {
  return {
    getCatalog: vi.fn(async () => demoCatalog()),
    getAccount: vi.fn(async () => account),
    createCheckout: vi.fn(async () => ({
      url: "https://checkout.stripe.com/c/pay/unused",
    })),
    createPortal: vi.fn(async () => ({
      url: "https://billing.stripe.com/p/session/test-portal",
    })),
    previewPlanChange: vi.fn(async () => {
      throw new Error("previewPlanChange is not used by AccountScreen");
    }),
    confirmPlanChange: vi.fn(async () => {
      throw new Error("confirmPlanChange is not used by AccountScreen");
    }),
  };
}

describe("account screen states", () => {
  it("shows an explicit loading state until the projections resolve", () => {
    const api = accountApi();
    api.getAccount = vi.fn(() => new Promise<never>(() => undefined));
    api.getCatalog = vi.fn(() => new Promise<never>(() => undefined));

    render(<AccountScreen api={api} redirect={vi.fn()} />);

    expect(screen.getByRole("status")).toHaveTextContent(
      "Loading account state…",
    );
  });

  it("recovers from a failed initial load through the retry action", async () => {
    const user = userEvent.setup();
    const api = accountApi();
    api.getAccount = vi
      .fn()
      .mockRejectedValueOnce(new Error("projection unavailable"))
      .mockResolvedValue(demoAccount());

    render(<AccountScreen api={api} redirect={vi.fn()} />);

    expect(
      await screen.findByText("projection unavailable"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        name: "We could not load your account projection.",
      }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(
      await screen.findByRole("heading", { name: "Your billing account" }),
    ).toBeInTheDocument();
  });

  it("renders explicit empty states for an account without a subscription", async () => {
    const account: AccountResponse = {
      ...demoAccount(),
      plan_key: "free",
      plan_interval: null,
      subscription_status: "none",
      current_period_end: null,
      credits: { balance: 0, grant_amount: 0, next_grant_at: null },
      entitlements: [],
    };

    render(<AccountScreen api={accountApi(account)} redirect={vi.fn()} />);

    expect(
      await screen.findByText(/No Stripe subscription is active/),
    ).toBeInTheDocument();
    expect(screen.getByText(/No grant is scheduled/)).toBeInTheDocument();
    expect(screen.getByText("Nothing enforceable yet")).toBeInTheDocument();
    expect(
      screen.getAllByText("Not scheduled").length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("refreshes the projection in place without discarding the current view", async () => {
    const user = userEvent.setup();
    const api = accountApi();
    api.getAccount = vi
      .fn()
      .mockResolvedValueOnce(demoAccount("starter", "month"))
      .mockResolvedValue(demoAccount("pro", "month"));

    render(<AccountScreen api={api} redirect={vi.fn()} />);

    expect(
      await screen.findByRole("heading", { name: "Starter" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Projection loaded/)).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Refresh projection" }),
    );

    expect(
      await screen.findByRole("heading", { name: "Pro" }),
    ).toBeInTheDocument();
    expect(api.getAccount).toHaveBeenCalledTimes(2);
  });

  it("keeps the last good projection and a dismissible error when refresh fails", async () => {
    const user = userEvent.setup();
    const api = accountApi();
    api.getAccount = vi
      .fn()
      .mockResolvedValueOnce(demoAccount())
      .mockRejectedValue(new Error("temporary projection failure"));

    render(<AccountScreen api={api} redirect={vi.fn()} />);

    await screen.findByRole("heading", { name: "Your billing account" });
    await user.click(
      screen.getByRole("button", { name: "Refresh projection" }),
    );

    expect(
      await screen.findByText("temporary projection failure"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Your billing account" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(
      screen.queryByText("temporary projection failure"),
    ).not.toBeInTheDocument();
  });

  it("flags a past-due subscription with paused product access", async () => {
    const account: AccountResponse = {
      ...demoAccount(),
      subscription_status: "past_due",
      entitlements_enforceable: false,
    };

    render(<AccountScreen api={accountApi(account)} redirect={vi.fn()} />);

    expect(
      await screen.findByRole("heading", {
        name: "Your latest payment has not settled",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Product access is paused until Stripe reports the invoice as paid/),
    ).toBeInTheDocument();
    expect(screen.getByText("Paused")).toBeInTheDocument();
    expect(screen.getByText("past_due")).toBeInTheDocument();
  });

  it("continues a requires-action pending change from the pending banner", async () => {
    const user = userEvent.setup();
    const redirect = vi.fn();
    const account: AccountResponse = {
      ...demoAccount(),
      pending_change: {
        target_plan_key: "pro",
        target_interval: "year",
        timing: "immediate",
        effective_at: "2026-09-01T00:00:00.000Z",
        status: "requires_action",
        payment_url: "https://invoice.stripe.com/i/test-pending",
        transition_policy: "full_period_reset",
      },
    };

    render(<AccountScreen api={accountApi(account)} redirect={redirect} />);

    expect(
      await screen.findByRole("heading", { name: "Pro · year" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/one more payment step/),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Continue payment on Stripe" }),
    );
    expect(redirect).toHaveBeenCalledWith(
      "https://invoice.stripe.com/i/test-pending",
    );
  });
});

describe("async state primitives", () => {
  it("announces loading as a polite status", () => {
    render(<LoadingState label="Loading account state…" />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Loading account state…",
    );
  });

  it("disables the retry action while a retry is in flight", () => {
    render(<ErrorState error="boom" retry={vi.fn()} retrying />);
    expect(screen.getByRole("button", { name: "Retrying…" })).toBeDisabled();
  });
});

describe("demo notice", () => {
  it("renders the demo banner as a note instead of an interrupting alert", () => {
    render(<DemoNotice />);
    expect(screen.getByRole("note")).toHaveTextContent(/DEMO ONLY/);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("billing return pages", () => {
  it("explains a known billing error code with recovery guidance", async () => {
    render(
      await BillingErrorPage({
        searchParams: Promise.resolve({ code: "payment_failed" }),
      }),
    );

    expect(
      screen.getByRole("heading", { name: "The payment did not complete" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Error code: payment_failed")).toBeInTheDocument();
    expect(
      screen.getByText(/Nothing was assumed about your entitlement state/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Review account" }),
    ).toHaveAttribute("href", "/account");
  });

  it("does not echo unknown billing error codes", async () => {
    render(
      await BillingErrorPage({
        searchParams: Promise.resolve({ code: "totally_unknown" }),
      }),
    );

    expect(
      screen.getByRole("heading", {
        name: "The billing operation could not be completed",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Error code/)).not.toBeInTheDocument();
  });

  it("drops an invalid expected interval instead of passing it through", async () => {
    render(
      await BillingSuccessPage({
        searchParams: Promise.resolve({
          expected_plan: "pro",
          expected_interval: "weekly",
        }),
      }),
    );

    expect(
      await screen.findByRole("heading", {
        name: "This billing return cannot be verified",
      }),
    ).toBeInTheDocument();
  });
});
