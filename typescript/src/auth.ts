import { timingSafeEqual } from "node:crypto";

export class AuthenticationError extends Error {}

export interface AuthenticatedIdentity {
  readonly externalRef: string;
  readonly email?: string;
}

export interface AuthAccountAdapter {
  authenticate(request: Request): Promise<AuthenticatedIdentity>;
}

export class RejectAllAuthAdapter implements AuthAccountAdapter {
  public authenticate(_request: Request): Promise<AuthenticatedIdentity> {
    return Promise.reject(
      new AuthenticationError("no authentication adapter is configured"),
    );
  }
}

function boundedVisible(
  value: string,
  field: string,
  maximum: number,
  ascii = false,
): void {
  if (
    value.length === 0 ||
    value !== value.trim() ||
    Buffer.byteLength(value, "utf8") > maximum ||
    [...value].some((character) => /\p{C}/u.test(character)) ||
    (ascii && !/^[\x20-\x7e]+$/u.test(value))
  ) {
    throw new TypeError(`${field} must be a bounded visible string`);
  }
}

export class DemoBearerAuthAdapter implements AuthAccountAdapter {
  readonly #token: Buffer;
  readonly #identity: AuthenticatedIdentity;

  public constructor(token: string, subject: string, email?: string) {
    boundedVisible(token, "demo token", 512, true);
    boundedVisible(subject, "demo subject", 512);
    if (email !== undefined) {
      boundedVisible(email, "demo email", 320);
    }
    this.#token = Buffer.from(token, "utf8");
    this.#identity =
      email === undefined
        ? { externalRef: subject }
        : { externalRef: subject, email };
  }

  public authenticate(request: Request): Promise<AuthenticatedIdentity> {
    const authorization = request.headers.get("authorization") ?? "";
    const separator = authorization.indexOf(" ");
    const scheme =
      separator < 0 ? authorization : authorization.slice(0, separator);
    const credential = separator < 0 ? "" : authorization.slice(separator + 1);
    const candidate = Buffer.from(credential, "utf8");
    const matches =
      scheme.toLowerCase() === "bearer" &&
      candidate.length === this.#token.length &&
      timingSafeEqual(candidate, this.#token);
    return matches
      ? Promise.resolve(this.#identity)
      : Promise.reject(new AuthenticationError("invalid bearer token"));
  }
}
