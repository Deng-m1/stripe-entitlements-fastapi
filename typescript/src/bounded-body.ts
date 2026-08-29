/** An actual streamed body exceeded its configured in-memory bound. */
export class BodyTooLargeError extends Error {}

/** A body was already consumed or its stream failed while reading. */
export class BodyReadError extends Error {}

async function readBoundedBody(
  bodyStream: ReadableStream<Uint8Array> | null,
  bodyUsed: boolean,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new RangeError("request body limit must be a non-negative integer");
  }
  if (bodyUsed) {
    throw new BodyReadError("body was already consumed");
  }
  if (bodyStream === null) {
    return new Uint8Array();
  }

  const reader = bodyStream.getReader();
  let rejectAbort: ((error: BodyReadError) => void) | undefined;
  const aborted =
    signal === undefined
      ? undefined
      : new Promise<never>((_resolve, reject) => {
          rejectAbort = reject;
        });
  const cancelForAbort = (): void => {
    try {
      void reader.cancel().catch(() => undefined);
    } catch {
      // The stable read error below remains authoritative.
    }
    rejectAbort?.(new BodyReadError("body read was aborted"));
  };
  if (signal?.aborted === true) {
    cancelForAbort();
  } else {
    signal?.addEventListener("abort", cancelForAbort, { once: true });
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        const pending = reader.read();
        next =
          aborted === undefined
            ? await pending
            : await Promise.race([pending, aborted]);
      } catch (error) {
        if (error instanceof BodyReadError) {
          throw error;
        }
        throw new BodyReadError("body stream failed", {
          cause: error,
        });
      }
      if (next.done) {
        break;
      }
      if (next.value.byteLength > maximumBytes - length) {
        try {
          // Do not await cancellation: a tee'd Fetch body can keep the cancel
          // promise pending until every sibling branch is consumed.
          void reader.cancel().catch(() => undefined);
        } catch {
          // Preserve the bounded failure even when transport cancellation fails.
        }
        throw new BodyTooLargeError("body is too large");
      }
      chunks.push(next.value);
      length += next.value.byteLength;
    }
  } finally {
    signal?.removeEventListener("abort", cancelForAbort);
    try {
      reader.releaseLock();
    } catch {
      // A canceled stream may already have released its reader lock.
    }
  }

  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/**
 * Read exact request bytes without allowing an absent Content-Length to turn
 * into an unbounded arrayBuffer allocation.
 */
export function readBoundedRequestBody(
  request: Request,
  maximumBytes: number,
  options: { readonly signal?: AbortSignal } = {},
): Promise<Uint8Array> {
  return readBoundedBody(
    request.body,
    request.bodyUsed,
    maximumBytes,
    options.signal,
  );
}

/** Read an HTTP response through the same cumulative streamed-byte bound. */
export function readBoundedResponseBody(
  response: Response,
  maximumBytes: number,
  options: { readonly signal?: AbortSignal } = {},
): Promise<Uint8Array> {
  return readBoundedBody(
    response.body,
    response.bodyUsed,
    maximumBytes,
    options.signal,
  );
}
