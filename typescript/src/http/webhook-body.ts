export const MAX_STRIPE_WEBHOOK_BYTES = 1_048_576;
export const MAX_STRIPE_SIGNATURE_BYTES = 8_192;

export interface WebhookReadSuccess {
  readonly ok: true;
  readonly rawBody: Uint8Array;
  readonly stripeSignature: string;
}

export interface WebhookReadFailure {
  readonly ok: false;
  readonly status: 400 | 413;
  readonly message: string;
}

export type WebhookReadResult = WebhookReadSuccess | WebhookReadFailure;

async function cancelBody(
  body: ReadableStream<Uint8Array> | null,
): Promise<void> {
  if (body === null || body.locked) {
    return;
  }
  try {
    await body.cancel();
  } catch {
    // The response still fails closed. A transport cancellation error is not safe
    // provider detail to reflect to the caller.
  }
}

function declaredContentLength(request: Request): bigint | undefined | null {
  const raw = request.headers.get("content-length");
  if (raw === null) {
    return undefined;
  }
  if (!/^\d+$/u.test(raw)) {
    return null;
  }
  return BigInt(raw);
}

function validStripeSignature(value: string | null): value is string {
  return (
    value !== null &&
    value.length > 0 &&
    value === value.trim() &&
    Buffer.byteLength(value, "utf8") <= MAX_STRIPE_SIGNATURE_BYTES &&
    /^[\x20-\x7e]+$/u.test(value)
  );
}

export async function readStripeWebhook(
  request: Request,
): Promise<WebhookReadResult> {
  const signature = request.headers.get("stripe-signature");
  if (!validStripeSignature(signature)) {
    await cancelBody(request.body);
    return { ok: false, status: 400, message: "invalid Stripe signature" };
  }

  const declared = declaredContentLength(request);
  if (declared === null) {
    await cancelBody(request.body);
    return { ok: false, status: 400, message: "invalid Content-Length" };
  }
  if (declared !== undefined && declared > BigInt(MAX_STRIPE_WEBHOOK_BYTES)) {
    await cancelBody(request.body);
    return {
      ok: false,
      status: 413,
      message: "Stripe webhook payload is too large",
    };
  }
  if (request.bodyUsed) {
    return {
      ok: false,
      status: 400,
      message: "Stripe webhook payload was already consumed",
    };
  }
  if (request.body === null) {
    if (declared !== undefined && declared !== 0n) {
      return {
        ok: false,
        status: 400,
        message: "Stripe webhook payload length is invalid",
      };
    }
    return { ok: true, rawBody: new Uint8Array(), stripeSignature: signature };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      const chunk = result.value;
      if (length + chunk.byteLength > MAX_STRIPE_WEBHOOK_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // Preserve the bounded 413 contract even if cancellation itself fails.
        }
        return {
          ok: false,
          status: 413,
          message: "Stripe webhook payload is too large",
        };
      }
      chunks.push(chunk);
      length += chunk.byteLength;
    }
  } catch {
    return {
      ok: false,
      status: 400,
      message: "unable to read Stripe webhook payload",
    };
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A canceled stream may already have released its lock.
    }
  }

  if (declared !== undefined && declared !== BigInt(length)) {
    return {
      ok: false,
      status: 400,
      message: "Stripe webhook payload length is invalid",
    };
  }
  const rawBody = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    rawBody.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, rawBody, stripeSignature: signature };
}
