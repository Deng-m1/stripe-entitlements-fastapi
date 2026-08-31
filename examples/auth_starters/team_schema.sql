create table app_users (
    id text collate "C" primary key,
    created_at timestamptz not null default now()
);

create table app_tenants (
    id text collate "C" primary key,
    created_at timestamptz not null default now()
);

create table app_team_memberships (
    user_id text collate "C" not null references app_users(id) on delete restrict,
    tenant_id text collate "C" not null references app_tenants(id) on delete restrict,
    billing_role text not null check (billing_role in ('viewer', 'billing_admin')),
    revoked_at timestamptz,
    created_at timestamptz not null default now(),
    primary key (user_id, tenant_id)
);

create index app_team_memberships_active_tenant_idx
    on app_team_memberships (tenant_id, user_id)
    where revoked_at is null;
