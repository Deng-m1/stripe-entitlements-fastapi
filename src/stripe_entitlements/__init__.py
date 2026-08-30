"""Race-safe Stripe billing, entitlements, and credit packs backed by PostgreSQL."""

from .app import create_app, create_billing_router
from .integration import install_billing
from .kernel import BillingKernel, BillingServices

__all__ = [
    "BillingKernel",
    "BillingServices",
    "create_app",
    "create_billing_router",
    "install_billing",
]

__version__ = "0.4.0"
