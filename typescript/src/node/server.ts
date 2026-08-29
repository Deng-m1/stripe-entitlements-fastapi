import { createServer } from "node:http";
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  Server,
  ServerResponse,
} from "node:http";
import { Readable } from "node:stream";

import type { BillingFetchHandler } from "../http/contracts.js";

export interface NodeBillingServerOptions {
  /** Trusted public or loopback origin used only to construct Fetch Request URLs. */
  readonly origin: string;
}

function normalizedOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError(
      "Node billing server origin must be a bare HTTP(S) origin",
    );
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError(
      "Node billing server origin must be a bare HTTP(S) origin",
    );
  }
  return url.origin;
}

function requestHeaders(source: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, raw] of Object.entries(source)) {
    if (raw === undefined) {
      continue;
    }
    if (Array.isArray(raw)) {
      for (const value of raw) {
        headers.append(name, value);
      }
    } else {
      headers.set(name, raw);
    }
  }
  return headers;
}

type StreamingRequestInit = RequestInit & { duplex?: "half" };

function fetchRequest(request: IncomingMessage, origin: string): Request {
  const target = request.url ?? "/";
  if (!target.startsWith("/") || target.startsWith("//")) {
    throw new TypeError("invalid HTTP request target");
  }
  const method = (request.method ?? "GET").toUpperCase();
  const controller = new AbortController();
  request.once("aborted", () => {
    controller.abort();
  });
  const init: StreamingRequestInit = {
    method,
    headers: requestHeaders(request.headers),
    signal: controller.signal,
  };
  if (method !== "GET" && method !== "HEAD") {
    init.body = Readable.toWeb(request) as ReadableStream<Uint8Array>;
    init.duplex = "half";
  }
  return new Request(new URL(target, `${origin}/`), init);
}

function applyResponseHeaders(
  response: Response,
  destination: ServerResponse,
): void {
  const headers = response.headers;
  for (const [name, value] of headers.entries()) {
    if (name.toLowerCase() !== "set-cookie") {
      destination.setHeader(name, value);
    }
  }
  const cookies = headers.getSetCookie();
  if (cookies.length > 0) {
    destination.setHeader("set-cookie", cookies);
  }
}

async function writeResponse(
  response: Response,
  destination: ServerResponse,
): Promise<void> {
  destination.statusCode = response.status;
  applyResponseHeaders(response, destination);
  const body = Buffer.from(await response.arrayBuffer());
  destination.end(body);
}

function sanitizedFailure(status: number, message: string): Response {
  return new Response(JSON.stringify({ detail: message }), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      Pragma: "no-cache",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export function createNodeBillingServer(
  handler: BillingFetchHandler,
  options: NodeBillingServerOptions,
): Server {
  const origin = normalizedOrigin(options.origin);
  return createServer((incoming, outgoing) => {
    const dispatch = async (): Promise<void> => {
      let request: Request;
      try {
        request = fetchRequest(incoming, origin);
      } catch {
        await writeResponse(
          sanitizedFailure(400, "invalid HTTP request"),
          outgoing,
        );
        return;
      }
      try {
        await writeResponse(await handler(request), outgoing);
      } catch {
        await writeResponse(
          sanitizedFailure(500, "billing request failed"),
          outgoing,
        );
      }
    };
    void dispatch().catch(() => {
      // A response-stream or socket failure must not become an unhandled rejection.
      // Once headers are visible, terminating is safer than appending another reply.
      outgoing.destroy();
    });
  });
}
