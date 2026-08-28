from collections.abc import Callable
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field

from .bounds import JSON_SAFE_INTEGER_MAX
from .credit_amount import CREDIT_SCALE
from .credits import CreditResult, CreditsUnavailableError, InsufficientCreditsError
from .entitlements import (
    BillingOwnerNotFoundError,
    CreditIdempotencyConflictError,
    CreditOperationNotFoundError,
    EntitlementService,
    InvalidCreditRequestError,
    InvalidOwnerReferenceError,
    validate_owner_external_ref,
)
from .internal_auth import (
    RejectAllWorkloadIdentityAdapter,
    RejectAllWorkloadOwnerAuthorizer,
    WorkloadAuthenticationError,
    WorkloadAuthorizationError,
    WorkloadIdentityAdapter,
    WorkloadOwnerAuthorizer,
    WorkloadPrincipal,
)

ENTITLEMENTS_CHECK_SCOPE = "entitlements:check"
CREDITS_CHARGE_SCOPE = "credits:charge"
CREDITS_REFUND_SCOPE = "credits:refund"

StrictText = Annotated[str, Field(strict=True, min_length=1, max_length=512)]
EntitlementKey = Annotated[str, Field(strict=True, min_length=1, max_length=64)]
LimitValue = Annotated[int, Field(strict=True, ge=0, le=JSON_SAFE_INTEGER_MAX)]


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class EntitlementCheckRequest(_StrictModel):
    owner_external_ref: StrictText
    required_features: Annotated[list[EntitlementKey], Field(max_length=64)] = Field(
        default_factory=list
    )
    required_limits: dict[EntitlementKey, LimitValue] = Field(default_factory=dict)


class CreditChargeRequest(_StrictModel):
    owner_external_ref: StrictText
    amount: Annotated[str, Field(strict=True, min_length=1, max_length=32)]


class CreditRefundRequest(_StrictModel):
    owner_external_ref: StrictText


class LimitDecisionResponse(_StrictModel):
    requested: int
    maximum: int | None
    allowed: bool


class CreditBalanceResponse(_StrictModel):
    balance: str
    balance_atoms: str
    scale: Literal[1_000_000]
    spendable: bool
    expires_at: str | None


class EntitlementCheckResponse(_StrictModel):
    allowed: bool
    reason: Literal[
        "allowed",
        "owner_not_found",
        "entitlement_not_enforceable",
        "feature_not_available",
        "limit_not_available",
        "limit_exceeded",
    ]
    entitlements_enforceable: bool
    plan_key: str
    plan_interval: Literal["month", "year"] | None
    subscription_status: Literal["none", "active", "past_due", "canceled"]
    credits: CreditBalanceResponse
    features: dict[str, bool]
    limits: dict[str, LimitDecisionResponse]


class CreditOperationResponse(_StrictModel):
    outcome: Literal["charged", "refunded", "replayed", "epoch_expired"]
    balance: str
    balance_atoms: str
    requested: str
    requested_atoms: str
    restored: str
    restored_atoms: str
    scale: int


ServiceProvider = Callable[[], EntitlementService]
_NO_STORE_HEADERS = {
    "Cache-Control": "no-store",
    "Pragma": "no-cache",
    "X-Content-Type-Options": "nosniff",
}


def _no_store(response: Response) -> None:
    response.headers.update(_NO_STORE_HEADERS)


def _http_error(status_code: int, detail: str) -> HTTPException:
    return HTTPException(status_code, detail, headers=_NO_STORE_HEADERS)


def create_internal_router(
    *,
    service_provider: ServiceProvider,
    auth_adapter: WorkloadIdentityAdapter | None = None,
    owner_authorizer: WorkloadOwnerAuthorizer | None = None,
    prefix: str = "/internal/v1",
) -> APIRouter:
    """Build private workload routes without taking ownership of application lifespan."""

    adapter = auth_adapter or RejectAllWorkloadIdentityAdapter()
    authorizer = owner_authorizer or RejectAllWorkloadOwnerAuthorizer()
    router = APIRouter(prefix=prefix, tags=["internal-entitlements"])

    async def current_principal(request: Request) -> WorkloadPrincipal:
        try:
            principal = await adapter.authenticate(request)
        except WorkloadAuthenticationError as exc:
            raise _http_error(401, "workload authentication failed") from exc
        if not isinstance(principal, WorkloadPrincipal):
            raise _http_error(401, "workload authentication failed")
        return principal

    Principal = Annotated[WorkloadPrincipal, Depends(current_principal)]

    async def authorize_owner(
        principal: WorkloadPrincipal, owner_external_ref: str, scope: str
    ) -> None:
        if scope not in principal.scopes:
            raise _http_error(403, "workload is not authorized")
        try:
            validate_owner_external_ref(owner_external_ref)
        except InvalidOwnerReferenceError as exc:
            raise _http_error(400, "invalid owner reference") from exc
        try:
            await authorizer.authorize(principal, owner_external_ref, scope)
        except WorkloadAuthorizationError as exc:
            raise _http_error(403, "workload is not authorized") from exc

    def credit_response(result: CreditResult) -> CreditOperationResponse:
        return CreditOperationResponse(
            outcome=result.outcome,
            balance=str(result.balance),
            balance_atoms=str(result.balance_atoms),
            requested=str(result.requested),
            requested_atoms=str(result.requested_atoms),
            restored=str(result.restored),
            restored_atoms=str(result.restored_atoms),
            scale=CREDIT_SCALE,
        )

    @router.post("/entitlements/check", response_model=EntitlementCheckResponse)
    async def check_entitlements(
        body: EntitlementCheckRequest,
        response: Response,
        principal: Principal,
    ) -> EntitlementCheckResponse:
        _no_store(response)
        try:
            await authorize_owner(principal, body.owner_external_ref, ENTITLEMENTS_CHECK_SCOPE)
            decision = await service_provider().check(
                body.owner_external_ref,
                required_features=body.required_features,
                required_limits=body.required_limits,
            )
        except (InvalidOwnerReferenceError, ValueError) as exc:
            raise _http_error(400, "invalid entitlement check request") from exc
        return EntitlementCheckResponse(
            allowed=decision.allowed,
            reason=decision.reason,
            entitlements_enforceable=decision.entitlements_enforceable,
            plan_key=decision.plan_key,
            plan_interval=decision.plan_interval,
            subscription_status=decision.subscription_status,
            credits=CreditBalanceResponse(
                balance=str(decision.credit_balance),
                balance_atoms=str(decision.credit_balance.atoms),
                scale=1_000_000,
                spendable=decision.credits_spendable,
                expires_at=(
                    decision.credit_expires_at.isoformat()
                    if decision.credit_expires_at is not None
                    else None
                ),
            ),
            features=decision.features,
            limits={
                key: LimitDecisionResponse(
                    requested=value.requested,
                    maximum=value.maximum,
                    allowed=value.allowed,
                )
                for key, value in decision.limits.items()
            },
        )

    @router.post("/credits/charge", response_model=CreditOperationResponse)
    async def charge_credits(
        body: CreditChargeRequest,
        response: Response,
        principal: Principal,
        idempotency_key: Annotated[str, Header(alias="Idempotency-Key")],
    ) -> CreditOperationResponse:
        _no_store(response)
        try:
            await authorize_owner(principal, body.owner_external_ref, CREDITS_CHARGE_SCOPE)
            result = await service_provider().charge(
                body.owner_external_ref,
                body.amount,
                idempotency_key,
            )
        except (InvalidOwnerReferenceError, InvalidCreditRequestError) as exc:
            raise _http_error(400, "invalid credit charge request") from exc
        except BillingOwnerNotFoundError as exc:
            raise _http_error(404, "billing owner not found") from exc
        except CreditIdempotencyConflictError as exc:
            raise _http_error(409, "credit idempotency conflict") from exc
        except CreditsUnavailableError as exc:
            raise _http_error(409, "credits are unavailable") from exc
        except InsufficientCreditsError as exc:
            raise _http_error(409, "insufficient credits") from exc
        return credit_response(result)

    @router.post("/credits/refund", response_model=CreditOperationResponse)
    async def refund_credits(
        body: CreditRefundRequest,
        response: Response,
        principal: Principal,
        idempotency_key: Annotated[str, Header(alias="Idempotency-Key")],
    ) -> CreditOperationResponse:
        _no_store(response)
        try:
            await authorize_owner(principal, body.owner_external_ref, CREDITS_REFUND_SCOPE)
            result = await service_provider().refund(body.owner_external_ref, idempotency_key)
        except (InvalidOwnerReferenceError, InvalidCreditRequestError) as exc:
            raise _http_error(400, "invalid credit refund request") from exc
        except CreditOperationNotFoundError as exc:
            raise _http_error(404, "credit operation not found") from exc
        return credit_response(result)

    return router


__all__ = [
    "CREDITS_CHARGE_SCOPE",
    "CREDITS_REFUND_SCOPE",
    "ENTITLEMENTS_CHECK_SCOPE",
    "CreditBalanceResponse",
    "CreditChargeRequest",
    "CreditOperationResponse",
    "CreditRefundRequest",
    "EntitlementCheckRequest",
    "EntitlementCheckResponse",
    "ServiceProvider",
    "create_internal_router",
]
