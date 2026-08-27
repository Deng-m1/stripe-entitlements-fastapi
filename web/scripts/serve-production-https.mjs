import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import next from "next";

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

const hostname = requiredEnvironment("E2E_HTTPS_HOST");
if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "::1") {
  throw new Error("E2E_HTTPS_HOST must be a loopback hostname.");
}

const rawPort = requiredEnvironment("E2E_HTTPS_PORT");
const port = Number(rawPort);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error("E2E_HTTPS_PORT must be an integer between 1 and 65535.");
}

const app = next({ dev: false, hostname, port });
await app.prepare();
const handle = app.getRequestHandler();
const server = createServer(
  {
    key: readFileSync(requiredEnvironment("E2E_HTTPS_KEY_FILE")),
    cert: readFileSync(requiredEnvironment("E2E_HTTPS_CERT_FILE")),
  },
  (request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end("Internal Server Error");
    });
  },
);

server.listen(port, hostname, () => {
  process.stdout.write(`Ready on https://${hostname}:${port}\n`);
});

let closing = false;
function close() {
  if (closing) return;
  closing = true;
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.once("SIGINT", close);
process.once("SIGTERM", close);
