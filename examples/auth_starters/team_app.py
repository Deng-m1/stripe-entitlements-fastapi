from __future__ import annotations

from uuid import UUID

from fastapi import FastAPI

from stripe_entitlements.app import create_app
from stripe_entitlements.auth_starters import (
    JwtVerifier,
    TeamBillingRole,
    TeamJwtAuthAdapter,
    TeamMembership,
)
from stripe_entitlements.config import get_settings
from stripe_entitlements.database import Database

from ._environment import jwt_config_from_environment


class PostgresTeamMembershipRepository:
    """Example host repository; billing never treats the tenant claim as authority."""

    def __init__(self, database: Database) -> None:
        self._database = database

    async def membership_for(
        self, user_id: UUID | str, tenant_id: UUID | str
    ) -> TeamMembership | None:
        async with self._database.require_pool().acquire() as connection:
            row = await connection.fetchrow(
                """select user_id, tenant_id, billing_role
                     from app_team_memberships
                    where user_id=$1 and tenant_id=$2 and revoked_at is null""",
                str(user_id),
                str(tenant_id),
            )
        if row is None:
            return None
        try:
            role = TeamBillingRole(str(row["billing_role"]))
        except ValueError as exc:
            raise RuntimeError("membership row has an invalid billing role") from exc
        return TeamMembership(
            # Return the exact verified principal type. The row proves that its
            # string representation is an active member; converting either ID
            # would make opaque and canonical provider values behave differently.
            user_id=user_id,
            tenant_id=tenant_id,
            role=role,
        )


def create_host_app() -> FastAPI:
    """Create tenant-owned billing APIs with a live membership lookup per request."""

    settings = get_settings()
    database = Database(settings.database_url)
    verifier = JwtVerifier(jwt_config_from_environment())
    memberships = PostgresTeamMembershipRepository(database)
    return create_app(
        settings,
        database=database,
        auth_adapter=TeamJwtAuthAdapter(verifier, memberships),
    )
