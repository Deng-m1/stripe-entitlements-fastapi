#!/usr/bin/env node

import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";

import { verify as verifySigstoreBundle } from "sigstore";

const SLSA_PROVENANCE_V1 = "https://slsa.dev/provenance/v1";
const GITHUB_ACTIONS_BUILD_TYPE =
  "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1";
const IN_TOTO_STATEMENT_V1 = "https://in-toto.io/Statement/v1";
const IN_TOTO_PAYLOAD_TYPE = "application/vnd.in-toto+json";
const SIGSTORE_BUNDLE_V03 = "application/vnd.dev.sigstore.bundle.v0.3+json";
const GITHUB_HOSTED_BUILDER = "https://github.com/actions/runner/github-hosted";
const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const MAX_ATTESTATION_BYTES = 1024 * 1024;

const GITHUB_CERTIFICATE_OIDS = Object.freeze({
  issuerV2: "1.3.6.1.4.1.57264.1.8",
  buildSignerUri: "1.3.6.1.4.1.57264.1.9",
  buildSignerDigest: "1.3.6.1.4.1.57264.1.10",
  runnerEnvironment: "1.3.6.1.4.1.57264.1.11",
  sourceRepositoryUri: "1.3.6.1.4.1.57264.1.12",
  sourceRepositoryDigest: "1.3.6.1.4.1.57264.1.13",
  sourceRepositoryRef: "1.3.6.1.4.1.57264.1.14",
  sourceRepositoryIdentifier: "1.3.6.1.4.1.57264.1.15",
  sourceRepositoryOwnerUri: "1.3.6.1.4.1.57264.1.16",
  sourceRepositoryOwnerIdentifier: "1.3.6.1.4.1.57264.1.17",
  buildConfigUri: "1.3.6.1.4.1.57264.1.18",
  buildConfigDigest: "1.3.6.1.4.1.57264.1.19",
  buildTrigger: "1.3.6.1.4.1.57264.1.20",
  runInvocationUri: "1.3.6.1.4.1.57264.1.21",
  sourceRepositoryVisibility: "1.3.6.1.4.1.57264.1.22",
  workflowEnvironment: "1.3.6.1.4.1.57264.1.23",
  tokenSubject: "1.3.6.1.4.1.57264.1.24",
});

function provenanceError(message, options) {
  return new Error(`npm provenance ${message}`, options);
}

function objectValue(value, description) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw provenanceError(`${description} must be an object`);
  }
  return value;
}

function stringValue(value, description) {
  if (typeof value !== "string" || value.length === 0) {
    throw provenanceError(`${description} must be a non-empty string`);
  }
  return value;
}

function exactObject(value, expected, description) {
  const candidate = objectValue(value, description);
  const candidateKeys = Object.keys(candidate).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (
    candidateKeys.length !== expectedKeys.length ||
    candidateKeys.some((key, index) => key !== expectedKeys[index]) ||
    expectedKeys.some((key) => candidate[key] !== expected[key])
  ) {
    throw provenanceError(`${description} drifted`);
  }
  return candidate;
}

function exactKeys(value, expectedKeys, description) {
  const candidate = objectValue(value, description);
  const candidateKeys = Object.keys(candidate).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  if (
    candidateKeys.length !== sortedExpectedKeys.length ||
    candidateKeys.some((key, index) => key !== sortedExpectedKeys[index])
  ) {
    throw provenanceError(`${description} fields drifted`);
  }
  return candidate;
}

function decodeBase64(value, description) {
  const encoded = stringValue(value, description);
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const dataLength = encoded.length - padding;
  const isBase64CodePoint = (codePoint) =>
    (codePoint >= 0x41 && codePoint <= 0x5a) ||
    (codePoint >= 0x61 && codePoint <= 0x7a) ||
    (codePoint >= 0x30 && codePoint <= 0x39) ||
    codePoint === 0x2b ||
    codePoint === 0x2f;
  if (
    encoded.length % 4 !== 0 ||
    dataLength === 0 ||
    (padding === 1 && dataLength % 4 !== 3) ||
    (padding === 2 && dataLength % 4 !== 2) ||
    [...encoded.slice(0, dataLength)].some(
      (character) => !isBase64CodePoint(character.codePointAt(0)),
    ) ||
    [...encoded.slice(dataLength)].some((character) => character !== "=")
  ) {
    throw provenanceError(`${description} is not canonical base64`);
  }
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.toString("base64") !== encoded) {
    throw provenanceError(`${description} is not canonical base64`);
  }
  return decoded;
}

function decodeDerLength(bytes, description) {
  if (bytes.length < 2) {
    throw provenanceError(`${description} is truncated DER`);
  }
  const firstLengthByte = bytes[1];
  if (firstLengthByte < 0x80) {
    return { length: firstLengthByte, offset: 2 };
  }
  const byteCount = firstLengthByte & 0x7f;
  if (byteCount === 0 || byteCount > 4 || bytes.length < 2 + byteCount) {
    throw provenanceError(`${description} has invalid DER length`);
  }
  if (bytes[2] === 0) {
    throw provenanceError(`${description} has non-minimal DER length`);
  }
  let length = 0;
  for (let index = 0; index < byteCount; index += 1) {
    length = length * 256 + bytes[2 + index];
  }
  if (length < 0x80) {
    throw provenanceError(`${description} has non-minimal DER length`);
  }
  return { length, offset: 2 + byteCount };
}

function decodeDerUtf8String(value, description) {
  if (!(value instanceof Uint8Array)) {
    throw provenanceError(`${description} has no certificate value`);
  }
  const bytes = Buffer.from(value);
  if (bytes[0] !== 0x0c) {
    throw provenanceError(`${description} is not a DER UTF8String`);
  }
  const { length, offset } = decodeDerLength(bytes, description);
  if (offset + length !== bytes.length) {
    throw provenanceError(`${description} has a mismatched DER length`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(offset),
    );
  } catch (error) {
    throw provenanceError(`${description} is not valid UTF-8`, {
      cause: error,
    });
  }
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function packagePurl(packageName, version) {
  const parts = packageName.split("/");
  if (
    parts.length !== 2 ||
    !/^@[a-z\d][a-z\d._-]*$/.test(parts[0]) ||
    !/^[a-z\d][a-z\d._-]*$/.test(parts[1])
  ) {
    throw provenanceError("expected npm package must be a scoped package");
  }
  return `pkg:npm/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}@${encodeURIComponent(version)}`;
}

function parseSemanticVersion(version) {
  if (version.includes("+")) {
    return undefined;
  }
  const prereleaseSeparator = version.indexOf("-");
  const core =
    prereleaseSeparator === -1
      ? version
      : version.slice(0, prereleaseSeparator);
  const prerelease =
    prereleaseSeparator === -1
      ? undefined
      : version.slice(prereleaseSeparator + 1);
  const numericIdentifier = (identifier) =>
    identifier === "0" || /^[1-9]\d*$/.test(identifier);
  const coreIdentifiers = core.split(".");
  if (
    coreIdentifiers.length !== 3 ||
    !coreIdentifiers.every(numericIdentifier)
  ) {
    return undefined;
  }
  if (prerelease !== undefined) {
    const prereleaseIdentifiers = prerelease.split(".");
    if (
      prereleaseIdentifiers.some(
        (identifier) =>
          identifier.length === 0 ||
          !/^[0-9A-Za-z-]+$/.test(identifier) ||
          (/^\d+$/.test(identifier) &&
            identifier.length > 1 &&
            identifier.startsWith("0")),
      )
    ) {
      return undefined;
    }
  }
  return { prerelease };
}

function validateExpectations(expectations) {
  objectValue(expectations, "expected release identity");
  const packageName = stringValue(expectations.packageName, "package name");
  const version = stringValue(expectations.version, "version");
  const tagName = stringValue(expectations.tagName, "tag name");
  const repository = stringValue(
    expectations.githubRepository,
    "GitHub repository",
  );
  const workflowPath = stringValue(expectations.workflowPath, "workflow path");
  const expectedCommit = stringValue(
    expectations.expectedCommit,
    "expected commit",
  );
  const runId = stringValue(expectations.runId, "GitHub run ID");
  const runAttempt = stringValue(expectations.runAttempt, "GitHub run attempt");
  const repositoryId = stringValue(
    expectations.githubRepositoryId,
    "GitHub repository ID",
  );
  const repositoryOwnerId = stringValue(
    expectations.githubRepositoryOwnerId,
    "GitHub repository owner ID",
  );
  const githubEnvironment = expectations.githubEnvironment;
  const allowEarlierRunAttempt =
    expectations.allowEarlierRunAttempt === undefined
      ? false
      : expectations.allowEarlierRunAttempt;

  if (!/^[1-9]\d*$/.test(runId) || !/^[1-9]\d*$/.test(runAttempt)) {
    throw provenanceError("GitHub run identity is invalid");
  }
  if (
    !/^[1-9]\d*$/.test(repositoryId) ||
    !/^[1-9]\d*$/.test(repositoryOwnerId)
  ) {
    throw provenanceError("GitHub immutable repository identity is invalid");
  }
  if (!/^[0-9a-f]{40}$/.test(expectedCommit)) {
    throw provenanceError(
      "expected Git commit must be 40 lowercase hexadecimal digits",
    );
  }
  if (typeof allowEarlierRunAttempt !== "boolean") {
    throw provenanceError("GitHub run attempt policy is invalid");
  }
  if (
    githubEnvironment !== undefined &&
    (typeof githubEnvironment !== "string" ||
      !/^[A-Za-z\d_.-]+$/.test(githubEnvironment))
  ) {
    throw provenanceError("GitHub environment identity is invalid");
  }
  if (!/^[A-Za-z\d_.-]+\/[A-Za-z\d_.-]+$/.test(repository)) {
    throw provenanceError("GitHub repository identity is invalid");
  }
  if (!/^\.github\/workflows\/[A-Za-z\d_.-]+\.ya?ml$/.test(workflowPath)) {
    throw provenanceError("GitHub workflow path is invalid");
  }
  if (parseSemanticVersion(version) === undefined) {
    throw provenanceError("package version is not canonical semantic version");
  }
  if (tagName !== `v${version}`) {
    throw provenanceError("release tag and package version drifted");
  }
  packagePurl(packageName, version);

  const integrity = stringValue(expectations.integrity, "artifact integrity");
  if (!integrity.startsWith("sha512-")) {
    throw provenanceError("artifact integrity is not sha512");
  }
  const digestBytes = decodeBase64(
    integrity.slice("sha512-".length),
    "artifact integrity",
  );
  if (digestBytes.length !== 64) {
    throw provenanceError("artifact sha512 integrity has the wrong length");
  }

  const expectedRef = `refs/tags/${tagName}`;
  const repositoryUrl = `https://github.com/${repository}`;
  const repositoryOwner = repository.split("/")[0];
  const repositoryOwnerUrl = `https://github.com/${repositoryOwner}`;
  const buildConfigUri = `${repositoryUrl}/${workflowPath}@${expectedRef}`;
  const invocationPrefix = `${repositoryUrl}/actions/runs/${runId}/attempts/`;
  const tokenSubject =
    githubEnvironment === undefined
      ? `repo:${repository}:ref:${expectedRef}`
      : `repo:${repository}:environment:${githubEnvironment}`;
  return {
    allowEarlierRunAttempt,
    buildConfigUri,
    digestHex: digestBytes.toString("hex"),
    expectedCommit,
    expectedRef,
    githubEnvironment,
    integrity,
    invocationPrefix,
    packageName,
    repository,
    repositoryId,
    repositoryOwner,
    repositoryOwnerId,
    repositoryOwnerUrl,
    repositoryUrl,
    runAttempt,
    runId,
    tagName,
    tokenSubject,
    version,
    workflowPath,
  };
}

function selectProvenanceBundle(document) {
  const root = objectValue(document, "document");
  if (!Array.isArray(root.attestations)) {
    throw provenanceError("registry returned no attestation list");
  }
  const attestations = root.attestations.filter(
    (item) =>
      item !== null &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      item.predicateType === SLSA_PROVENANCE_V1,
  );
  if (attestations.length !== 1) {
    throw provenanceError("registry must return exactly one SLSA provenance");
  }
  const bundle = objectValue(attestations[0].bundle, "bundle");
  exactKeys(
    bundle,
    ["dsseEnvelope", "mediaType", "verificationMaterial"],
    "Sigstore bundle",
  );
  if (bundle.mediaType !== SIGSTORE_BUNDLE_V03) {
    throw provenanceError("Sigstore bundle media type drifted");
  }
  const envelope = objectValue(bundle.dsseEnvelope, "DSSE envelope");
  exactKeys(
    envelope,
    ["payload", "payloadType", "signatures"],
    "DSSE envelope",
  );
  if (envelope.payloadType !== IN_TOTO_PAYLOAD_TYPE) {
    throw provenanceError("DSSE payload type drifted");
  }
  if (!Array.isArray(envelope.signatures) || envelope.signatures.length !== 1) {
    throw provenanceError("DSSE envelope must contain exactly one signature");
  }
  const signature = objectValue(envelope.signatures[0], "DSSE signature");
  exactKeys(signature, ["keyid", "sig"], "DSSE signature");
  if (signature.keyid !== "") {
    throw provenanceError("DSSE signature key ID drifted");
  }
  decodeBase64(signature.sig, "DSSE signature");

  const verificationMaterial = objectValue(
    bundle.verificationMaterial,
    "verification material",
  );
  const certificate = objectValue(
    verificationMaterial.certificate,
    "signing certificate",
  );
  decodeBase64(certificate.rawBytes, "signing certificate");
  if (
    !Array.isArray(verificationMaterial.tlogEntries) ||
    verificationMaterial.tlogEntries.length === 0
  ) {
    throw provenanceError("bundle has no transparency log entry");
  }
  return { bundle, envelope };
}

function certificateOidMap(signer) {
  const identity = objectValue(signer?.identity, "verified signer identity");
  if (identity.extensions?.issuer !== GITHUB_OIDC_ISSUER) {
    throw provenanceError("verified certificate issuer drifted");
  }
  if (!Array.isArray(identity.oids)) {
    throw provenanceError("verified certificate has no extension list");
  }
  const values = new Map();
  for (const entry of identity.oids) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      !Array.isArray(entry.oid?.id)
    ) {
      throw provenanceError("verified certificate extension is malformed");
    }
    const oid = entry.oid.id.join(".");
    if (values.has(oid)) {
      throw provenanceError(`verified certificate repeats OID ${oid}`);
    }
    values.set(oid, entry.value);
  }
  return { identity, values };
}

function verifyCertificateIdentity(signer, expected) {
  const { identity, values } = certificateOidMap(signer);
  if (identity.subjectAlternativeName !== expected.buildConfigUri) {
    throw provenanceError("verified certificate SAN drifted");
  }
  const expectedOids = new Map([
    [GITHUB_CERTIFICATE_OIDS.issuerV2, GITHUB_OIDC_ISSUER],
    [GITHUB_CERTIFICATE_OIDS.buildSignerUri, expected.buildConfigUri],
    [GITHUB_CERTIFICATE_OIDS.buildSignerDigest, expected.expectedCommit],
    [GITHUB_CERTIFICATE_OIDS.runnerEnvironment, "github-hosted"],
    [GITHUB_CERTIFICATE_OIDS.sourceRepositoryUri, expected.repositoryUrl],
    [GITHUB_CERTIFICATE_OIDS.sourceRepositoryDigest, expected.expectedCommit],
    [GITHUB_CERTIFICATE_OIDS.sourceRepositoryRef, expected.expectedRef],
    [GITHUB_CERTIFICATE_OIDS.sourceRepositoryIdentifier, expected.repositoryId],
    [
      GITHUB_CERTIFICATE_OIDS.sourceRepositoryOwnerUri,
      expected.repositoryOwnerUrl,
    ],
    [
      GITHUB_CERTIFICATE_OIDS.sourceRepositoryOwnerIdentifier,
      expected.repositoryOwnerId,
    ],
    [GITHUB_CERTIFICATE_OIDS.buildConfigUri, expected.buildConfigUri],
    [GITHUB_CERTIFICATE_OIDS.buildConfigDigest, expected.expectedCommit],
    [GITHUB_CERTIFICATE_OIDS.buildTrigger, "push"],
    [GITHUB_CERTIFICATE_OIDS.sourceRepositoryVisibility, "public"],
    [GITHUB_CERTIFICATE_OIDS.tokenSubject, expected.tokenSubject],
  ]);
  if (expected.githubEnvironment !== undefined) {
    expectedOids.set(
      GITHUB_CERTIFICATE_OIDS.workflowEnvironment,
      expected.githubEnvironment,
    );
  } else if (values.has(GITHUB_CERTIFICATE_OIDS.workflowEnvironment)) {
    throw provenanceError(
      `certificate OID ${GITHUB_CERTIFICATE_OIDS.workflowEnvironment} drifted`,
    );
  }
  for (const [oid, expectedValue] of expectedOids) {
    const observedValue = decodeDerUtf8String(
      values.get(oid),
      `certificate OID ${oid}`,
    );
    if (observedValue !== expectedValue) {
      throw provenanceError(`certificate OID ${oid} drifted`);
    }
  }
  const invocationId = decodeDerUtf8String(
    values.get(GITHUB_CERTIFICATE_OIDS.runInvocationUri),
    `certificate OID ${GITHUB_CERTIFICATE_OIDS.runInvocationUri}`,
  );
  if (!invocationId.startsWith(expected.invocationPrefix)) {
    throw provenanceError(
      `certificate OID ${GITHUB_CERTIFICATE_OIDS.runInvocationUri} drifted`,
    );
  }
  const observedAttempt = invocationId.slice(expected.invocationPrefix.length);
  if (!/^[1-9]\d*$/.test(observedAttempt)) {
    throw provenanceError("certificate GitHub run attempt is invalid");
  }
  const observedAttemptValue = BigInt(observedAttempt);
  const maximumAttemptValue = BigInt(expected.runAttempt);
  if (
    observedAttemptValue > maximumAttemptValue ||
    (!expected.allowEarlierRunAttempt &&
      observedAttemptValue !== maximumAttemptValue)
  ) {
    throw provenanceError("certificate GitHub run attempt drifted");
  }
  return { invocationId, observedAttempt };
}

function parseStatement(envelope) {
  const payload = decodeBase64(envelope.payload, "DSSE payload");
  let statement;
  try {
    statement = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(payload),
    );
  } catch (error) {
    throw provenanceError("DSSE payload is not valid UTF-8 JSON", {
      cause: error,
    });
  }
  return objectValue(statement, "statement");
}

function verifyStatementContract(statement, expected, invocationId) {
  exactKeys(
    statement,
    ["_type", "predicate", "predicateType", "subject"],
    "statement",
  );
  if (statement._type !== IN_TOTO_STATEMENT_V1) {
    throw provenanceError("statement type drifted");
  }
  if (statement.predicateType !== SLSA_PROVENANCE_V1) {
    throw provenanceError("predicate type drifted");
  }
  if (!Array.isArray(statement.subject) || statement.subject.length !== 1) {
    throw provenanceError("statement must contain exactly one subject");
  }
  const subject = objectValue(statement.subject[0], "subject");
  exactKeys(subject, ["digest", "name"], "subject");
  if (subject.name !== packagePurl(expected.packageName, expected.version)) {
    throw provenanceError("subject package drifted");
  }
  const digest = exactObject(
    subject.digest,
    { sha512: expected.digestHex },
    "subject digest",
  );
  if (digest.sha512 !== expected.digestHex) {
    throw provenanceError("subject digest drifted");
  }

  const predicate = objectValue(statement.predicate, "predicate");
  exactKeys(predicate, ["buildDefinition", "runDetails"], "predicate");
  const buildDefinition = objectValue(
    predicate.buildDefinition,
    "build definition",
  );
  exactKeys(
    buildDefinition,
    [
      "buildType",
      "externalParameters",
      "internalParameters",
      "resolvedDependencies",
    ],
    "build definition",
  );
  if (buildDefinition.buildType !== GITHUB_ACTIONS_BUILD_TYPE) {
    throw provenanceError("build type drifted");
  }
  const externalParameters = objectValue(
    buildDefinition.externalParameters,
    "external parameters",
  );
  exactKeys(externalParameters, ["workflow"], "external parameters");
  exactObject(
    externalParameters.workflow,
    {
      path: expected.workflowPath,
      ref: expected.expectedRef,
      repository: expected.repositoryUrl,
    },
    "workflow identity",
  );
  const internalParameters = objectValue(
    buildDefinition.internalParameters,
    "internal parameters",
  );
  exactKeys(internalParameters, ["github"], "internal parameters");
  const githubParameters = objectValue(
    internalParameters.github,
    "GitHub internal parameters",
  );
  exactObject(
    githubParameters,
    {
      event_name: "push",
      repository_id: expected.repositoryId,
      repository_owner_id: expected.repositoryOwnerId,
    },
    "GitHub internal parameters",
  );

  const dependencies = buildDefinition.resolvedDependencies;
  if (!Array.isArray(dependencies) || dependencies.length !== 1) {
    throw provenanceError("build must contain exactly one resolved dependency");
  }
  const dependency = objectValue(dependencies[0], "resolved dependency");
  exactKeys(dependency, ["digest", "uri"], "resolved dependency");
  if (
    dependency.uri !== `git+${expected.repositoryUrl}@${expected.expectedRef}`
  ) {
    throw provenanceError("resolved repository identity drifted");
  }
  exactObject(
    dependency.digest,
    { gitCommit: expected.expectedCommit },
    "resolved commit identity",
  );

  const runDetails = objectValue(predicate.runDetails, "run details");
  exactObject(
    runDetails.builder,
    { id: GITHUB_HOSTED_BUILDER },
    "builder identity",
  );
  exactObject(runDetails.metadata, { invocationId }, "run invocation identity");
}

export async function verifyNpmAttestation(
  document,
  expectations,
  dependencies = {},
) {
  const expected = validateExpectations(expectations);
  const { bundle, envelope } = selectProvenanceBundle(document);
  const verifyBundle = dependencies.verifyBundle ?? verifySigstoreBundle;
  const tufOptions = dependencies.tufOptions ?? {};
  const signer = await verifyBundle(bundle, {
    ...tufOptions,
    certificateIssuer: GITHUB_OIDC_ISSUER,
    certificateIdentityURI: `^${escapeRegularExpression(expected.buildConfigUri)}$`,
    ctLogThreshold: 1,
    tlogThreshold: 1,
  });
  const verifiedRun = verifyCertificateIdentity(signer, expected);
  verifyStatementContract(
    parseStatement(envelope),
    expected,
    verifiedRun.invocationId,
  );
  return Object.freeze({
    commit: expected.expectedCommit,
    invocationId: verifiedRun.invocationId,
    packageName: expected.packageName,
    ref: expected.expectedRef,
    repository: expected.repository,
    repositoryId: expected.repositoryId,
    repositoryOwnerId: expected.repositoryOwnerId,
    runAttempt: verifiedRun.observedAttempt,
    version: expected.version,
    workflowPath: expected.workflowPath,
  });
}

function parseArguments(arguments_) {
  const allowed = new Set([
    "attempt-policy",
    "attestations",
    "commit",
    "environment",
    "integrity",
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
    if (!option?.startsWith("--") || value === undefined) {
      throw provenanceError("CLI arguments must be --name value pairs");
    }
    const name = option.slice(2);
    if (!allowed.has(name) || values.has(name)) {
      throw provenanceError(`CLI option --${name} is unknown or repeated`);
    }
    values.set(name, value);
  }
  for (const name of allowed) {
    if (!values.has(name)) {
      throw provenanceError(`CLI option --${name} is required`);
    }
  }
  if (
    optionsValue(values, "attempt-policy") !== "exact" &&
    optionsValue(values, "attempt-policy") !== "same-run-not-newer"
  ) {
    throw provenanceError(
      "CLI option --attempt-policy must be exact or same-run-not-newer",
    );
  }
  return values;
}

function optionsValue(values, name) {
  return stringValue(values.get(name), `CLI option --${name}`);
}

async function main(arguments_) {
  const options = parseArguments(arguments_);
  const attestationsPath = options.get("attestations");
  let contents;
  let document;
  try {
    // The caller explicitly selects the file; contents are bounded and never echoed.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    contents = await readFile(attestationsPath);
  } catch (error) {
    throw provenanceError("attestation document could not be read", {
      cause: error,
    });
  }
  if (contents.length === 0 || contents.length > MAX_ATTESTATION_BYTES) {
    throw provenanceError("attestation document size is invalid");
  }
  try {
    document = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(contents),
    );
  } catch (error) {
    throw provenanceError("attestation document is not valid UTF-8 JSON", {
      cause: error,
    });
  }
  const result = await verifyNpmAttestation(document, {
    allowEarlierRunAttempt:
      options.get("attempt-policy") === "same-run-not-newer",
    expectedCommit: options.get("commit"),
    githubRepository: options.get("repository"),
    githubRepositoryId: options.get("repository-id"),
    githubRepositoryOwnerId: options.get("repository-owner-id"),
    githubEnvironment: options.get("environment"),
    integrity: options.get("integrity"),
    packageName: options.get("package-name"),
    runAttempt: options.get("run-attempt"),
    runId: options.get("run-id"),
    tagName: options.get("tag"),
    version: options.get("version"),
    workflowPath: options.get("workflow-path"),
  });
  process.stdout.write(
    `npm-provenance-contract=${result.repository}@${result.ref}#${result.commit} run=${result.invocationId}\n`,
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2)).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
