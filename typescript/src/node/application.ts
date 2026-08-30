import { once } from "node:events";
import type { Server } from "node:http";

import {
  createBillingRuntimeFromEnvironment,
  type BillingRuntime,
} from "../deployment.js";
import { createNodeBillingServer } from "./server.js";

export interface NodeBillingApplicationOptions {
  readonly runtime: BillingRuntime;
  readonly host?: string;
  readonly port?: number;
  readonly origin?: string;
}

export interface RunningNodeBillingApplication {
  readonly runtime: BillingRuntime;
  readonly server: Server;
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
}

function listeningPort(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 65_535) {
    throw new RangeError(
      "billing server port must be an integer from 0 to 65535",
    );
  }
  return value;
}

function environmentPort(value: string | undefined): number {
  if (value === undefined) {
    return 8000;
  }
  if (!/^(?:0|[1-9][0-9]{0,4})$/u.test(value)) {
    throw new TypeError("BILLING_PORT must be an integer from 0 to 65535");
  }
  return listeningPort(Number(value));
}

function publicOrigin(
  host: string,
  port: number,
  configured: string | undefined,
): string {
  if (configured !== undefined) {
    return configured;
  }
  const originHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const bracketed = originHost.includes(":") ? `[${originHost}]` : originHost;
  return `http://${bracketed}:${String(port)}`;
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

export async function startNodeBillingApplication(
  options: NodeBillingApplicationOptions,
): Promise<RunningNodeBillingApplication> {
  const host = options.host ?? "127.0.0.1";
  const port = listeningPort(options.port ?? 8000);
  const server = createNodeBillingServer(options.runtime.handler, {
    origin: options.origin ?? publicOrigin(host, port, undefined),
  });
  try {
    server.listen(port, host);
    await Promise.race([
      once(server, "listening"),
      once(server, "error").then(([error]) => {
        throw error instanceof Error
          ? error
          : new Error("billing HTTP listener failed", { cause: error });
      }),
    ]);
  } catch (error) {
    await closeServer(server).catch(() => undefined);
    await options.runtime.close().catch(() => undefined);
    throw error;
  }
  const address = server.address();
  const actualPort =
    typeof address === "object" && address !== null ? address.port : port;
  let closed = false;
  return {
    runtime: options.runtime,
    server,
    host,
    port: actualPort,
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      let serverError: unknown;
      try {
        await closeServer(server);
      } catch (error) {
        serverError = error;
      }
      await options.runtime.close();
      if (serverError !== undefined) {
        throw serverError instanceof Error
          ? serverError
          : new Error("billing HTTP server failed to close", {
              cause: serverError,
            });
      }
    },
  };
}

export async function startNodeBillingApplicationFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<RunningNodeBillingApplication> {
  const host = environment["BILLING_HOST"] ?? "0.0.0.0";
  const port = environmentPort(environment["BILLING_PORT"]);
  const origin = publicOrigin(host, port, environment["BILLING_PUBLIC_ORIGIN"]);
  const runtime = await createBillingRuntimeFromEnvironment(environment);
  return startNodeBillingApplication({ runtime, host, port, origin });
}
