#!/usr/bin/env node

import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import process from "node:process";
import { TextDecoder } from "node:util";

const EXPECTED_NPM_VERSION = "11.19.1";
const EXPECTED_PROVENANCE_SOURCE_SHA256 =
  "ee9b1bc8e3f636fbaf5138a3e183ce3c6d42bb5dd57ab004578e534dd08da46b";
const EXPECTED_PUBLISH_SOURCE_SHA256 =
  "9dda86510ab37e983839fcff81e72f4c1d789b67bafb086f41d18dbda81b95ec";
const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const OIDS = Object.freeze({
  invocation: "1.3.6.1.4.1.57264.1.21",
  environment: "1.3.6.1.4.1.57264.1.23",
  tokenSubject: "1.3.6.1.4.1.57264.1.24",
});

function fail(message) {
  throw new Error(`npm provenance generation ${message}`);
}

function parseArguments(arguments_) {
  const required = new Set([
    "commit",
    "environment",
    "integrity",
    "npm-root",
    "output",
    "package-name",
    "repository",
    "repository-id",
    "repository-owner-id",
    "run-attempt",
    "run-id",
    "tag",
    "version",
    "workflow-path",
  ]);
  const values = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const option = arguments_[index];
    const value = arguments_[index + 1];
    if (
      !option?.startsWith("--") ||
      value === undefined ||
      value.length === 0
    ) {
      fail("CLI arguments must be non-empty --name value pairs");
    }
    const name = option.slice(2);
    if (!required.has(name) || values.has(name)) {
      fail(`CLI option --${name} is unknown or repeated`);
    }
    values.set(name, value);
  }
  for (const name of required) {
    if (!values.has(name)) fail(`CLI option --${name} is required`);
  }
  return values;
}

function decodeIntegrity(integrity) {
  const match = /^sha512-([A-Za-z\d+/]+={0,2})$/.exec(integrity);
  if (!match || match[1].length % 4 !== 0) fail("integrity is not sha512 SRI");
  const bytes = Buffer.from(match[1], "base64");
  if (bytes.length !== 64 || bytes.toString("base64") !== match[1]) {
    fail("integrity is not canonical sha512 SRI");
  }
  return bytes.toString("hex");
}

function packagePurl(name, version) {
  const match = /^(@[a-z\d][a-z\d._-]*)\/([a-z\d][a-z\d._-]*)$/.exec(name);
  if (!match) fail("package name is not a canonical scoped npm name");
  // The command-line value is short and the expression has no ambiguous nesting.
  // eslint-disable-next-line security/detect-unsafe-regex
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version)) {
    fail("version is not canonical semantic version");
  }
  return `pkg:npm/${encodeURIComponent(match[1])}/${encodeURIComponent(match[2])}@${encodeURIComponent(version)}`;
}

function decodeDerUtf8(value, description) {
  const bytes = Buffer.from(value ?? []);
  if (bytes.length < 2 || bytes[0] !== 0x0c)
    fail(`${description} is not DER UTF8String`);
  let offset = 2;
  let length = bytes[1];
  if (length >= 0x80) {
    const count = length & 0x7f;
    if (
      count === 0 ||
      count > 4 ||
      bytes.length < 2 + count ||
      bytes[2] === 0
    ) {
      fail(`${description} has invalid DER length`);
    }
    length = 0;
    offset += count;
    for (let index = 0; index < count; index += 1) {
      length = length * 256 + bytes[2 + index];
    }
  }
  if (offset + length !== bytes.length)
    fail(`${description} has invalid DER length`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(offset),
    );
  } catch {
    fail(`${description} is not UTF-8`);
  }
}

function assertGitHubIdentity(options) {
  const expected = new Map([
    ["GITHUB_ACTIONS", "true"],
    ["GITHUB_EVENT_NAME", "push"],
    ["GITHUB_REF", `refs/tags/${options.get("tag")}`],
    ["GITHUB_REPOSITORY", options.get("repository")],
    ["GITHUB_REPOSITORY_ID", options.get("repository-id")],
    ["GITHUB_REPOSITORY_OWNER_ID", options.get("repository-owner-id")],
    ["GITHUB_RUN_ATTEMPT", options.get("run-attempt")],
    ["GITHUB_RUN_ID", options.get("run-id")],
    ["GITHUB_SHA", options.get("commit")],
    ["RUNNER_ENVIRONMENT", "github-hosted"],
    [
      "GITHUB_WORKFLOW_REF",
      `${options.get("repository")}/${options.get("workflow-path")}@refs/tags/${options.get("tag")}`,
    ],
  ]);
  for (const [name, value] of expected) {
    if (process.env[name] !== value) fail(`${name} drifted`);
  }
  if (
    !process.env.ACTIONS_ID_TOKEN_REQUEST_URL ||
    !process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  ) {
    fail("GitHub OIDC request capability is unavailable");
  }
  for (const secretName of ["NODE_AUTH_TOKEN", "NPM_TOKEN"]) {
    if (process.env[secretName])
      fail(`${secretName} must not enter the identity job`);
  }
}

async function main(arguments_) {
  const options = parseArguments(arguments_);
  if (options.get("tag") !== `v${options.get("version")}`) {
    fail("tag and version drifted");
  }
  assertGitHubIdentity(options);
  const digest = decodeIntegrity(options.get("integrity"));
  const subject = {
    name: packagePurl(options.get("package-name"), options.get("version")),
    digest: { sha512: digest },
  };

  const npmRoot = resolve(options.get("npm-root"));
  const npmPackagePath = join(npmRoot, "npm", "package.json");
  const provenancePath = join(
    npmRoot,
    "npm",
    "node_modules",
    "libnpmpublish",
    "lib",
    "provenance.js",
  );
  const publishPath = join(
    npmRoot,
    "npm",
    "node_modules",
    "libnpmpublish",
    "lib",
    "publish.js",
  );
  // These paths are selected from the exact, manifest-verified npm CLI archive.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const npmPackage = JSON.parse(await readFile(npmPackagePath, "utf8"));
  if (npmPackage.version !== EXPECTED_NPM_VERSION)
    fail("npm CLI version drifted");
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const provenanceSource = await readFile(provenancePath);
  if (
    createHash("sha256").update(provenanceSource).digest("hex") !==
    EXPECTED_PROVENANCE_SOURCE_SHA256
  ) {
    fail("audited npm provenance generator source drifted");
  }
  // The release consumes --provenance-file through this exact audited path.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const publishSource = await readFile(publishPath);
  if (
    createHash("sha256").update(publishSource).digest("hex") !==
    EXPECTED_PUBLISH_SOURCE_SHA256
  ) {
    fail("audited npm provenance publication source drifted");
  }

  const require = createRequire(import.meta.url);
  // eslint-disable-next-line security/detect-non-literal-require
  const { generateProvenance, verifyProvenance } = require(provenancePath);
  const sigstorePath = join(npmRoot, "npm", "node_modules", "sigstore");
  // eslint-disable-next-line security/detect-non-literal-require
  const sigstore = require(sigstorePath);
  const bundle = await generateProvenance([subject], {});

  const repositoryUrl = `https://github.com/${options.get("repository")}`;
  const buildConfigUri = `${repositoryUrl}/${options.get("workflow-path")}@refs/tags/${options.get("tag")}`;
  const signer = await sigstore.verify(bundle, {
    certificateIssuer: GITHUB_OIDC_ISSUER,
    certificateIdentityURI: `^${buildConfigUri.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
    ctLogThreshold: 1,
    tlogThreshold: 1,
  });
  const oidValues = new Map();
  for (const entry of signer.identity?.oids ?? []) {
    const oid = entry.oid?.id?.join(".");
    if (!oid || oidValues.has(oid))
      fail("verified certificate OIDs are malformed");
    oidValues.set(oid, entry.value);
  }
  const expectedOids = new Map([
    [OIDS.environment, options.get("environment")],
    [
      OIDS.tokenSubject,
      `repo:${options.get("repository")}:environment:${options.get("environment")}`,
    ],
    [
      OIDS.invocation,
      `${repositoryUrl}/actions/runs/${options.get("run-id")}/attempts/${options.get("run-attempt")}`,
    ],
  ]);
  for (const [oid, value] of expectedOids) {
    if (decodeDerUtf8(oidValues.get(oid), `certificate OID ${oid}`) !== value) {
      fail(`certificate OID ${oid} drifted`);
    }
  }

  const output = resolve(options.get("output"));
  const serialized = `${JSON.stringify(bundle)}\n`;
  // The output is a new, caller-selected temporary file and is never overwritten.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await writeFile(output, serialized, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await verifyProvenance(subject, output);
  process.stdout.write(`npm-provenance-generated=${subject.name}#${digest}\n`);
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
