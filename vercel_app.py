"""Vercel Services entrypoint for the FastAPI billing service."""

from stripe_entitlements.vercel import create_vercel_app

app = create_vercel_app()
