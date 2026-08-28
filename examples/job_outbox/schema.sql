create table job_example_jobs (
    id uuid primary key,
    request_key text not null unique
        check (length(request_key) between 1 and 200 and request_key = btrim(request_key)),
    owner_external_ref text not null
        check (length(owner_external_ref) between 1 and 512
               and owner_external_ref = btrim(owner_external_ref)),
    payload jsonb not null check (jsonb_typeof(payload) = 'object'),
    state text not null check (
        state in (
            'pending_credit', 'ready', 'running', 'succeeded',
            'billing_rejected', 'refund_pending', 'failed'
        )
    ),
    created_at timestamptz not null default clock_timestamp(),
    updated_at timestamptz not null default clock_timestamp(),
    unique (id, owner_external_ref)
);

create table job_example_attempts (
    id uuid primary key,
    job_id uuid not null unique references job_example_jobs(id) on delete restrict,
    state text not null check (
        state in (
            'pending_credit', 'charging', 'ready', 'running', 'succeeded',
            'billing_rejected', 'failed_pending_refund', 'failed_refunded'
        )
    ),
    credit_key text not null unique
        check (length(credit_key) between 1 and 200 and credit_key = btrim(credit_key)),
    execution_token uuid,
    execution_lease_expires_at timestamptz,
    execution_generation integer not null default 0 check (execution_generation >= 0),
    terminal_reason text,
    created_at timestamptz not null default clock_timestamp(),
    updated_at timestamptz not null default clock_timestamp(),
    unique (id, job_id),
    unique (id, job_id, credit_key),
    check (
        (state = 'running' and execution_token is not null
                           and execution_lease_expires_at is not null)
        or
        (state <> 'running' and execution_token is null
                            and execution_lease_expires_at is null)
    )
);

create table job_example_billing_outbox (
    id uuid primary key,
    job_id uuid not null references job_example_jobs(id) on delete restrict,
    attempt_id uuid not null references job_example_attempts(id) on delete restrict,
    operation text not null check (operation in ('charge', 'refund')),
    owner_external_ref text not null
        check (length(owner_external_ref) between 1 and 512
               and owner_external_ref = btrim(owner_external_ref)),
    amount_decimal text not null check (
        length(amount_decimal) between 1 and 32
        and amount_decimal ~ '^(0[.][0-9]{0,5}[1-9]|[1-9][0-9]*([.][0-9]{0,5}[1-9])?)$'
    ),
    amount_atoms bigint not null check (amount_atoms > 0),
    credit_key text not null
        check (length(credit_key) between 1 and 200 and credit_key = btrim(credit_key)),
    state text not null default 'pending'
        check (state in ('pending', 'processing', 'done', 'failed')),
    attempts integer not null default 0 check (attempts >= 0),
    available_at timestamptz not null default clock_timestamp(),
    lease_token uuid,
    lease_expires_at timestamptz,
    result_outcome text,
    last_error text,
    completed_at timestamptz,
    created_at timestamptz not null default clock_timestamp(),
    updated_at timestamptz not null default clock_timestamp(),
    unique (operation, credit_key),
    unique (attempt_id, operation),
    constraint job_example_billing_outbox_job_owner_fk
        foreign key (job_id, owner_external_ref)
        references job_example_jobs(id, owner_external_ref) on delete restrict,
    constraint job_example_billing_outbox_attempt_job_credit_fk
        foreign key (attempt_id, job_id, credit_key)
        references job_example_attempts(id, job_id, credit_key) on delete restrict,
    check (amount_decimal::numeric * 1000000 = amount_atoms),
    check (
        (state = 'processing' and lease_token is not null and lease_expires_at is not null)
        or
        (state <> 'processing' and lease_token is null and lease_expires_at is null)
    ),
    check ((state in ('done', 'failed')) = (completed_at is not null))
);

create index job_example_billing_outbox_claim_idx
    on job_example_billing_outbox (available_at, created_at)
    where state in ('pending', 'processing');

create table job_example_dispatch_outbox (
    id uuid primary key,
    job_id uuid not null references job_example_jobs(id) on delete restrict,
    attempt_id uuid not null unique references job_example_attempts(id) on delete restrict,
    state text not null default 'pending' check (state in ('pending', 'processing', 'done')),
    delivery_attempts integer not null default 0 check (delivery_attempts >= 0),
    available_at timestamptz not null default clock_timestamp(),
    lease_token uuid,
    lease_expires_at timestamptz,
    last_error text,
    completed_at timestamptz,
    created_at timestamptz not null default clock_timestamp(),
    updated_at timestamptz not null default clock_timestamp(),
    unique (id, attempt_id),
    constraint job_example_dispatch_outbox_attempt_job_fk
        foreign key (attempt_id, job_id)
        references job_example_attempts(id, job_id) on delete restrict,
    check (
        (state = 'processing' and lease_token is not null and lease_expires_at is not null)
        or
        (state <> 'processing' and lease_token is null and lease_expires_at is null)
    ),
    check (state = 'pending' or delivery_attempts > 0),
    check ((state = 'done') = (completed_at is not null))
);

create index job_example_dispatch_outbox_claim_idx
    on job_example_dispatch_outbox (available_at, created_at)
    where state in ('pending', 'processing');

create table job_example_queue_inbox (
    dispatch_id uuid primary key references job_example_dispatch_outbox(id) on delete restrict,
    attempt_id uuid not null references job_example_attempts(id) on delete restrict,
    outcome text not null check (outcome in ('consumed', 'stale')),
    consumed_at timestamptz not null default clock_timestamp(),
    constraint job_example_queue_inbox_dispatch_attempt_fk
        foreign key (dispatch_id, attempt_id)
        references job_example_dispatch_outbox(id, attempt_id) on delete restrict
);

create or replace function job_example_guard_job_state() returns trigger
language plpgsql as $$
begin
    if old.state = new.state then
        return new;
    end if;
    if not (
        (old.state = 'pending_credit' and new.state in ('ready', 'billing_rejected')) or
        (old.state = 'ready' and new.state = 'running') or
        (old.state = 'running' and new.state in ('succeeded', 'refund_pending')) or
        (old.state = 'refund_pending' and new.state = 'failed')
    ) then
        raise exception 'invalid job state transition: % -> %', old.state, new.state;
    end if;
    return new;
end;
$$;

create trigger job_example_jobs_state_guard
before update of state on job_example_jobs
for each row execute function job_example_guard_job_state();

create or replace function job_example_guard_attempt_state() returns trigger
language plpgsql as $$
begin
    if old.state = new.state then
        return new;
    end if;
    if not (
        (old.state = 'pending_credit' and new.state = 'charging') or
        (old.state = 'charging' and new.state in ('ready', 'billing_rejected')) or
        (old.state = 'ready' and new.state = 'running') or
        (old.state = 'running' and new.state in ('succeeded', 'failed_pending_refund')) or
        (old.state = 'failed_pending_refund' and new.state = 'failed_refunded')
    ) then
        raise exception 'invalid job-attempt state transition: % -> %', old.state, new.state;
    end if;
    return new;
end;
$$;

create trigger job_example_attempts_state_guard
before update of state on job_example_attempts
for each row execute function job_example_guard_attempt_state();
