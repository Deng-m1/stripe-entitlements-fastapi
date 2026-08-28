export type BillingInterval = "month" | "year";
export type ChangeTiming = "immediate" | "period_end";
export type TransitionPolicy = "full_period_reset" | "prorated_delta";
export type SettlementMode =
  | "new_period_full_price"
  | "current_period_prorated_delta"
  | "period_end";

export type CreditDecimalString = string;
export type CreditAtomsString = string;
export type CreditScale = 1_000_000;

export interface Price {
  currency: string;
  unit_amount: number;
  interval: BillingInterval;
}

export interface Entitlement {
  key: string;
  label: string;
  value: number | string | boolean;
  value_atoms?: CreditAtomsString;
  scale?: CreditScale;
  unit?: string;
  description?: string;
}

export interface CatalogPlan {
  key: string;
  name: string;
  description: string;
  display_order: number;
  prices: Record<BillingInterval, Price>;
  entitlements: Entitlement[];
}

export interface CatalogResponse {
  transition_policy: TransitionPolicy;
  plans: CatalogPlan[];
}

export interface Credits {
  balance: CreditDecimalString;
  balance_atoms: CreditAtomsString;
  grant_amount: CreditDecimalString;
  grant_amount_atoms: CreditAtomsString;
  scale: CreditScale;
  next_grant_at: string | null;
}

export interface PendingChange {
  preview_id?: string;
  target_plan_key: string;
  target_interval: BillingInterval;
  timing: ChangeTiming;
  effective_at: string;
  status?:
    | "previewed"
    | "applying"
    | "scheduled"
    | "applied"
    | "requires_action"
    | "completed"
    | "failed";
  payment_url?: string | null;
  transition_policy: TransitionPolicy;
}

export interface PendingCancellation {
  target_plan_key: "free";
  timing: "period_end";
  effective_at: string | null;
}

export interface AccountResponse {
  account_id: string;
  transition_policy: TransitionPolicy;
  plan_key: string;
  plan_interval: BillingInterval | null;
  subscription_status: "none" | "active" | "past_due" | "canceled";
  current_period_end: string | null;
  credits: Credits;
  entitlements: Entitlement[];
  entitlements_enforceable: boolean;
  pending_change: PendingChange | null;
  pending_cancellation: PendingCancellation | null;
}

export interface CheckoutRequest {
  plan_key: string;
  interval: BillingInterval;
  success_url: string;
  cancel_url: string;
}

export interface IdempotentRequestOptions {
  idempotencyKey?: string;
}

export interface RedirectResponse {
  url: string;
}

export interface ChangePreviewRequest {
  plan_key: string;
  interval: BillingInterval;
}

export interface ChangePreview {
  preview_id: string;
  current_plan_key: string;
  current_interval: BillingInterval;
  target_plan_key: string;
  target_interval: BillingInterval;
  timing: ChangeTiming;
  transition_policy: TransitionPolicy;
  settlement_mode: SettlementMode;
  effective_at: string;
  currency: string;
  amount_due_now: number;
  credit_applied: number;
  entitlement_credit_delta: CreditDecimalString | null;
  entitlement_credit_delta_atoms: CreditAtomsString | null;
  credit_scale: CreditScale;
  next_invoice_amount: number;
}

export interface ChangeConfirmRequest {
  preview_id: string;
}

export interface ChangeConfirmResponse {
  status: "confirmed" | "payment_required" | "action_required";
  timing: ChangeTiming;
  transition_policy: TransitionPolicy;
  target_plan_key: string;
  target_interval: BillingInterval;
  payment_url?: string;
  payment_client_secret?: string;
  payment_confirmation_method?: "confirm_payment" | "confirm_card_payment";
  account?: AccountResponse;
}

export interface BillingApi {
  getCatalog(): Promise<CatalogResponse>;
  getAccount(): Promise<AccountResponse>;
  createCheckout(
    input: CheckoutRequest,
    options?: IdempotentRequestOptions,
  ): Promise<RedirectResponse>;
  createPortal(
    returnUrl: string,
    options?: IdempotentRequestOptions,
  ): Promise<RedirectResponse>;
  previewPlanChange(
    input: ChangePreviewRequest,
    options?: IdempotentRequestOptions,
  ): Promise<ChangePreview>;
  confirmPlanChange(input: ChangeConfirmRequest): Promise<ChangeConfirmResponse>;
}

export type Redirect = (url: string) => void;
