const WORKLOAD_SCOPE = /^[a-z][a-z0-9:_-]{0,127}$/u;

export class WorkloadAuthenticationError extends Error {}

export class WorkloadAuthorizationError extends Error {}

function workloadVisible(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    Buffer.byteLength(value, "utf8") > 512 ||
    Array.from(value).some((character) => /\p{C}/u.test(character))
  ) {
    throw new TypeError(`workload principal ${field} is invalid`);
  }
  return value;
}

class ImmutableScopes implements ReadonlySet<string> {
  readonly #values: Set<string>;

  public constructor(values: Iterable<string>) {
    this.#values = new Set(values);
  }

  public get size(): number {
    return this.#values.size;
  }

  public has(value: string): boolean {
    return this.#values.has(value);
  }

  public forEach(
    callbackfn: (
      value: string,
      value2: string,
      set: ReadonlySet<string>,
    ) => void,
    thisArg?: unknown,
  ): void {
    for (const value of this.#values) {
      callbackfn.call(thisArg, value, value, this);
    }
  }

  public entries(): SetIterator<[string, string]> {
    return this.#values.entries();
  }

  public keys(): SetIterator<string> {
    return this.#values.keys();
  }

  public values(): SetIterator<string> {
    return this.#values.values();
  }

  public [Symbol.iterator](): SetIterator<string> {
    return this.#values[Symbol.iterator]();
  }

  public readonly [Symbol.toStringTag] = "ImmutableScopes";
}

export interface WorkloadPrincipalOptions {
  readonly issuer: string;
  readonly subject: string;
  readonly scopes: ReadonlySet<string>;
}

/** Verified service identity returned only after complete host credential validation. */
export class WorkloadPrincipal {
  public readonly issuer: string;
  public readonly subject: string;
  public readonly scopes: ReadonlySet<string>;

  public constructor(options: WorkloadPrincipalOptions) {
    this.issuer = workloadVisible(options.issuer, "issuer");
    this.subject = workloadVisible(options.subject, "subject");
    if (!(options.scopes instanceof Set)) {
      throw new TypeError("workload principal scopes must be a Set");
    }
    if (
      options.scopes.size > 64 ||
      [...options.scopes].some(
        (scope) => typeof scope !== "string" || !WORKLOAD_SCOPE.test(scope),
      )
    ) {
      throw new TypeError("workload principal scopes are invalid");
    }
    this.scopes = new ImmutableScopes(options.scopes);
    Object.freeze(this);
  }
}

/** Alias kept explicit so host adapters can wrap framework-specific request objects later. */
export type WorkloadRequest = Request;

export interface WorkloadIdentityAdapter {
  /**
   * Authenticate the complete credential, including algorithm, issuer, audience,
   * expiry, not-before, revocation and replay policy. Decoding alone is insufficient.
   */
  authenticate(request: WorkloadRequest): Promise<WorkloadPrincipal>;
}

export interface WorkloadOwnerAuthorizer {
  /** Bind the verified workload and operation to this exact billable owner. */
  authorize(
    principal: WorkloadPrincipal,
    ownerExternalRef: string,
    requiredScope: string,
  ): Promise<void>;
}

/** Safe default until the host injects workload identity verification. */
export class RejectAllWorkloadIdentityAdapter
  implements WorkloadIdentityAdapter
{
  public authenticate(request: WorkloadRequest): Promise<WorkloadPrincipal> {
    void request;
    return Promise.reject(
      new WorkloadAuthenticationError(
        "no workload identity adapter is configured",
      ),
    );
  }
}

/** Safe default until the host binds workloads to exact billing owners. */
export class RejectAllWorkloadOwnerAuthorizer
  implements WorkloadOwnerAuthorizer
{
  public authorize(
    principal: WorkloadPrincipal,
    ownerExternalRef: string,
    requiredScope: string,
  ): Promise<void> {
    void principal;
    void ownerExternalRef;
    void requiredScope;
    return Promise.reject(
      new WorkloadAuthorizationError(
        "no workload owner authorizer is configured",
      ),
    );
  }
}
