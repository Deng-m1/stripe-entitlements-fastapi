import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { URL } from "node:url";

import { verifyNpmAttestation } from "./verify-npm-attestation.mjs";

// Public, immutable npm provenance fetched from:
// https://registry.npmjs.org/-/npm/v1/attestations/@hono%2fnode-server@2.1.1
const FIXTURE_URL = new URL(
  "../tests/fixtures/hono-node-server-2.1.1-attestation.json",
  import.meta.url,
);
// The URL above is a source-controlled, module-relative test fixture.
// eslint-disable-next-line security/detect-non-literal-fs-filename
const FIXTURE = JSON.parse(await readFile(FIXTURE_URL, "utf8"));

const EXPECTED = Object.freeze({
  expectedCommit: "73c03adfb01928fcd5f5b20faebd5d692f83fc93",
  githubRepository: "honojs/node-server",
  githubRepositoryId: "535328171",
  githubRepositoryOwnerId: "98495527",
  integrity:
    "sha512-ELuehkj5VCBdgEw9zs+ivkKwyzzUCSQuE96YmiPvn1ECBoZCczbFXJLeEGMTYjphP6gydh4pHMqEYPVMYUVgQg==",
  packageName: "@hono/node-server",
  runAttempt: "1",
  runId: "31759768202",
  tagName: "v2.1.1",
  version: "2.1.1",
  workflowPath: ".github/workflows/release.yml",
});

const OIDS = Object.freeze({
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

const ISSUER = "https://token.actions.githubusercontent.com";
const REPOSITORY_URL = "https://github.com/honojs/node-server";
const REF = "refs/tags/v2.1.1";
const BUILD_CONFIG_URI =
  "https://github.com/honojs/node-server/.github/workflows/release.yml@refs/tags/v2.1.1";
const INVOCATION_ID =
  "https://github.com/honojs/node-server/actions/runs/31759768202/attempts/1";

function fixture() {
  return cloneJson(FIXTURE);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function provenance(document) {
  return document.attestations.find(
    (item) => item.predicateType === "https://slsa.dev/provenance/v1",
  );
}

function statement(document) {
  return JSON.parse(
    Buffer.from(provenance(document).bundle.dsseEnvelope.payload, "base64"),
  );
}

function replaceStatement(document, replacement) {
  provenance(document).bundle.dsseEnvelope.payload = Buffer.from(
    JSON.stringify(replacement),
  ).toString("base64");
}

function derUtf8(value) {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length < 0x80) {
    return Buffer.concat([Buffer.from([0x0c, encoded.length]), encoded]);
  }
  return Buffer.concat([Buffer.from([0x0c, 0x81, encoded.length]), encoded]);
}

function oidEntry(oid, value) {
  return {
    oid: { id: oid.split(".").map(Number) },
    value: derUtf8(value),
  };
}

function fakeSigner() {
  const expectedValues = new Map([
    [OIDS.issuerV2, ISSUER],
    [OIDS.buildSignerUri, BUILD_CONFIG_URI],
    [OIDS.buildSignerDigest, EXPECTED.expectedCommit],
    [OIDS.runnerEnvironment, "github-hosted"],
    [OIDS.sourceRepositoryUri, REPOSITORY_URL],
    [OIDS.sourceRepositoryDigest, EXPECTED.expectedCommit],
    [OIDS.sourceRepositoryRef, REF],
    [OIDS.sourceRepositoryIdentifier, EXPECTED.githubRepositoryId],
    [OIDS.sourceRepositoryOwnerUri, "https://github.com/honojs"],
    [OIDS.sourceRepositoryOwnerIdentifier, EXPECTED.githubRepositoryOwnerId],
    [OIDS.buildConfigUri, BUILD_CONFIG_URI],
    [OIDS.buildConfigDigest, EXPECTED.expectedCommit],
    [OIDS.buildTrigger, "push"],
    [OIDS.runInvocationUri, INVOCATION_ID],
    [OIDS.sourceRepositoryVisibility, "public"],
    [OIDS.tokenSubject, `repo:${EXPECTED.githubRepository}:ref:${REF}`],
  ]);
  return {
    identity: {
      extensions: { issuer: ISSUER },
      subjectAlternativeName: BUILD_CONFIG_URI,
      oids: [...expectedValues].map(([oid, value]) => oidEntry(oid, value)),
    },
  };
}

function fakeDependencies(signer = fakeSigner(), callback) {
  return {
    verifyBundle: async (bundle, options) => {
      callback?.(bundle, options);
      return signer;
    },
  };
}

function findOid(signer, oid) {
  return signer.identity.oids.find((entry) => entry.oid.id.join(".") === oid);
}

function errorIncludes(fragment) {
  return (error) => error instanceof Error && error.message.includes(fragment);
}

async function withOfflineTuf(callback) {
  const cache = await mkdtemp(join(tmpdir(), "stripe-entitlements-sigstore-"));
  try {
    return await callback({ tufCachePath: cache, tufForceCache: true });
  } finally {
    await rm(cache, { force: true, recursive: true });
  }
}

test("cryptographically verifies a real Sigstore v0.3 npm provenance offline", async () => {
  const result = await withOfflineTuf((tufOptions) =>
    verifyNpmAttestation(fixture(), EXPECTED, { tufOptions }),
  );
  assert.deepEqual(result, {
    commit: EXPECTED.expectedCommit,
    invocationId: INVOCATION_ID,
    packageName: EXPECTED.packageName,
    ref: REF,
    repository: EXPECTED.githubRepository,
    repositoryId: EXPECTED.githubRepositoryId,
    repositoryOwnerId: EXPECTED.githubRepositoryOwnerId,
    runAttempt: EXPECTED.runAttempt,
    version: EXPECTED.version,
    workflowPath: EXPECTED.workflowPath,
  });
});

test("passes an exact anchored GitHub certificate policy to Sigstore", async () => {
  const document = fixture();
  let observedBundle;
  let observedOptions;
  await verifyNpmAttestation(
    document,
    EXPECTED,
    fakeDependencies(fakeSigner(), (bundle, options) => {
      observedBundle = bundle;
      observedOptions = options;
    }),
  );
  assert.equal(observedBundle, provenance(document).bundle);
  assert.equal(observedOptions.certificateIssuer, ISSUER);
  assert.equal(
    observedOptions.certificateIdentityURI,
    "^https://github\\.com/honojs/node-server/\\.github/workflows/release\\.yml@refs/tags/v2\\.1\\.1$",
  );
  assert.equal(observedOptions.ctLogThreshold, 1);
  assert.equal(observedOptions.tlogThreshold, 1);
});

test("security policy cannot be weakened through TUF options", async () => {
  let observedOptions;
  await verifyNpmAttestation(fixture(), EXPECTED, {
    tufOptions: {
      certificateIdentityURI: ".*",
      certificateIssuer: "https://attacker.example",
      ctLogThreshold: 0,
      tlogThreshold: 0,
    },
    verifyBundle: async (_bundle, options) => {
      observedOptions = options;
      return fakeSigner();
    },
  });
  assert.equal(observedOptions.certificateIssuer, ISSUER);
  assert.notEqual(observedOptions.certificateIdentityURI, ".*");
  assert.equal(observedOptions.ctLogThreshold, 1);
  assert.equal(observedOptions.tlogThreshold, 1);
});

test("rejects a forged DSSE signature with the real cryptographic verifier", async () => {
  const document = fixture();
  const signature = provenance(document).bundle.dsseEnvelope.signatures[0];
  signature.sig = `${signature.sig[0] === "A" ? "B" : "A"}${signature.sig.slice(1)}`;
  await withOfflineTuf((tufOptions) =>
    assert.rejects(
      verifyNpmAttestation(document, EXPECTED, { tufOptions }),
      /signature|verification|transparency|bundle/i,
    ),
  );
});

test("rejects a payload changed after signing with the real verifier", async () => {
  const document = fixture();
  const changed = statement(document);
  changed.subject[0].name = "pkg:npm/%40attacker/package@2.1.1";
  replaceStatement(document, changed);
  await withOfflineTuf((tufOptions) =>
    assert.rejects(
      verifyNpmAttestation(document, EXPECTED, { tufOptions }),
      /signature|verification|transparency|bundle/i,
    ),
  );
});

test("performs cryptographic verification before trusting or parsing payload", async () => {
  const document = fixture();
  provenance(document).bundle.dsseEnvelope.payload = "not-base64";
  const sentinel = new Error("cryptographic rejection happened first");
  await assert.rejects(
    verifyNpmAttestation(document, EXPECTED, {
      verifyBundle: async () => {
        throw sentinel;
      },
    }),
    (error) => error === sentinel,
  );
});

test("fails closed before verification without certificate or Rekor material", async (t) => {
  await t.test("missing verification material", async () => {
    const document = fixture();
    delete provenance(document).bundle.verificationMaterial;
    await assert.rejects(
      verifyNpmAttestation(document, EXPECTED, fakeDependencies()),
      /Sigstore bundle fields|verification material/,
    );
  });
  await t.test("missing certificate", async () => {
    const document = fixture();
    delete provenance(document).bundle.verificationMaterial.certificate;
    await assert.rejects(
      verifyNpmAttestation(document, EXPECTED, fakeDependencies()),
      /signing certificate/,
    );
  });
  await t.test("missing transparency log", async () => {
    const document = fixture();
    provenance(document).bundle.verificationMaterial.tlogEntries = [];
    await assert.rejects(
      verifyNpmAttestation(document, EXPECTED, fakeDependencies()),
      /transparency log/,
    );
  });
});

test("rejects certificate issuer and exact SAN drift", async (t) => {
  await t.test("issuer", async () => {
    const signer = fakeSigner();
    signer.identity.extensions.issuer = "https://attacker.example";
    await assert.rejects(
      verifyNpmAttestation(fixture(), EXPECTED, fakeDependencies(signer)),
      /certificate issuer/,
    );
  });
  await t.test("SAN", async () => {
    const signer = fakeSigner();
    signer.identity.subjectAlternativeName = `${BUILD_CONFIG_URI}/suffix`;
    await assert.rejects(
      verifyNpmAttestation(fixture(), EXPECTED, fakeDependencies(signer)),
      /certificate SAN/,
    );
  });
});

test("rejects every missing or drifted required Fulcio identity OID", async (t) => {
  for (const oid of Object.values(OIDS).filter(
    (value) => value !== OIDS.workflowEnvironment,
  )) {
    await t.test(`missing ${oid}`, async () => {
      const signer = fakeSigner();
      signer.identity.oids = signer.identity.oids.filter(
        (entry) => entry.oid.id.join(".") !== oid,
      );
      await assert.rejects(
        verifyNpmAttestation(fixture(), EXPECTED, fakeDependencies(signer)),
        errorIncludes(oid),
      );
    });
    await t.test(`drifted ${oid}`, async () => {
      const signer = fakeSigner();
      findOid(signer, oid).value = derUtf8("attacker-controlled");
      await assert.rejects(
        verifyNpmAttestation(fixture(), EXPECTED, fakeDependencies(signer)),
        errorIncludes(oid),
      );
    });
  }
});

test("requires an exact token-subject OID", async () => {
  const absent = fakeSigner();
  absent.identity.oids = absent.identity.oids.filter(
    (entry) => entry.oid.id.join(".") !== OIDS.tokenSubject,
  );
  await assert.rejects(
    verifyNpmAttestation(fixture(), EXPECTED, fakeDependencies(absent)),
    /certificate OID 1\.3\.6\.1\.4\.1\.57264\.1\.24/,
  );

  const contradictory = fakeSigner();
  findOid(contradictory, OIDS.tokenSubject).value = derUtf8(
    "repo:attacker/repository:ref:refs/tags/v2.1.1",
  );
  await assert.rejects(
    verifyNpmAttestation(fixture(), EXPECTED, fakeDependencies(contradictory)),
    /certificate OID 1\.3\.6\.1\.4\.1\.57264\.1\.24 drifted/,
  );
});

test("requires the configured GitHub environment in OID and token subject", async () => {
  const signer = fakeSigner();
  signer.identity.oids.push(oidEntry(OIDS.workflowEnvironment, "npm-publish"));
  findOid(signer, OIDS.tokenSubject).value = derUtf8(
    `repo:${EXPECTED.githubRepository}:environment:npm-publish`,
  );
  await verifyNpmAttestation(
    fixture(),
    { ...EXPECTED, githubEnvironment: "npm-publish" },
    fakeDependencies(signer),
  );

  findOid(signer, OIDS.workflowEnvironment).value = derUtf8("production");
  await assert.rejects(
    verifyNpmAttestation(
      fixture(),
      { ...EXPECTED, githubEnvironment: "npm-publish" },
      fakeDependencies(signer),
    ),
    /certificate OID 1\.3\.6\.1\.4\.1\.57264\.1\.23 drifted/,
  );
});

test("resume accepts only an earlier attempt from the same run", async () => {
  const result = await verifyNpmAttestation(
    fixture(),
    { ...EXPECTED, allowEarlierRunAttempt: true, runAttempt: "2" },
    fakeDependencies(),
  );
  assert.equal(result.runAttempt, "1");
  assert.equal(result.invocationId, INVOCATION_ID);

  const signer = fakeSigner();
  findOid(signer, OIDS.runInvocationUri).value = derUtf8(
    "https://github.com/honojs/node-server/actions/runs/31759768203/attempts/1",
  );
  await assert.rejects(
    verifyNpmAttestation(
      fixture(),
      { ...EXPECTED, allowEarlierRunAttempt: true, runAttempt: "2" },
      fakeDependencies(signer),
    ),
    /runInvocationUri|certificate OID|run attempt/,
  );
});

test("rejects duplicate certificate extension OIDs", async () => {
  const signer = fakeSigner();
  const original = signer.identity.oids[0];
  signer.identity.oids.push({
    oid: { id: [...original.oid.id] },
    value: Buffer.from(original.value),
  });
  await assert.rejects(
    verifyNpmAttestation(fixture(), EXPECTED, fakeDependencies(signer)),
    /repeats OID/,
  );
});

test("strictly rejects malformed DER UTF8String OID values", async (t) => {
  const cases = new Map([
    ["wrong tag", Buffer.from([0x04, 0x01, 0x61])],
    ["truncated", Buffer.from([0x0c])],
    ["indefinite length", Buffer.from([0x0c, 0x80])],
    ["non-minimal length", Buffer.from([0x0c, 0x81, 0x01, 0x61])],
    ["mismatched length", Buffer.from([0x0c, 0x03, 0x61])],
    ["invalid UTF-8", Buffer.from([0x0c, 0x02, 0xc3, 0x28])],
  ]);
  for (const [name, value] of cases) {
    await t.test(name, async () => {
      const signer = fakeSigner();
      findOid(signer, OIDS.runnerEnvironment).value = value;
      await assert.rejects(
        verifyNpmAttestation(fixture(), EXPECTED, fakeDependencies(signer)),
        /certificate OID|DER|UTF-8/,
      );
    });
  }
});

test("rejects package, version, tag, SRI, run, and immutable ID drift", async (t) => {
  const cases = [
    ["package", { packageName: "@attacker/package" }],
    ["version", { tagName: "v2.1.2", version: "2.1.2" }],
    ["tag/version split", { tagName: "v2.1.2" }],
    ["SRI", { integrity: `sha512-${Buffer.alloc(64).toString("base64")}` }],
    ["commit", { expectedCommit: "a".repeat(40) }],
    ["run ID", { runId: "31759768203" }],
    ["run attempt", { runAttempt: "2" }],
    ["repository ID", { githubRepositoryId: "535328172" }],
    ["owner ID", { githubRepositoryOwnerId: "98495528" }],
  ];
  for (const [name, changes] of cases) {
    await t.test(name, async () => {
      await assert.rejects(
        verifyNpmAttestation(
          fixture(),
          { ...EXPECTED, ...changes },
          fakeDependencies(),
        ),
        /npm provenance/,
      );
    });
  }
});

test("rejects invalid release expectations before calling Sigstore", async (t) => {
  const cases = [
    ["zero run ID", { runId: "0" }],
    ["leading-zero run attempt", { runAttempt: "01" }],
    ["zero repository ID", { githubRepositoryId: "0" }],
    ["unscoped package", { packageName: "node-server" }],
    ["non-canonical version", { tagName: "v02.1.1", version: "02.1.1" }],
    ["malformed integrity", { integrity: "sha512-not-base64" }],
  ];
  for (const [name, changes] of cases) {
    await t.test(name, async () => {
      let called = false;
      await assert.rejects(
        verifyNpmAttestation(
          fixture(),
          { ...EXPECTED, ...changes },
          {
            verifyBundle: async () => {
              called = true;
              return fakeSigner();
            },
          },
        ),
        /npm provenance/,
      );
      assert.equal(called, false);
    });
  }
});

test("rejects multiple SLSA attestations and malformed bundle envelopes", async (t) => {
  await t.test("multiple SLSA entries", async () => {
    const document = fixture();
    document.attestations.push(cloneJson(document.attestations[0]));
    await assert.rejects(
      verifyNpmAttestation(document, EXPECTED, fakeDependencies()),
      /exactly one SLSA provenance/,
    );
  });
  await t.test("extra bundle field", async () => {
    const document = fixture();
    provenance(document).bundle.untrusted = true;
    await assert.rejects(
      verifyNpmAttestation(document, EXPECTED, fakeDependencies()),
      /Sigstore bundle fields drifted/,
    );
  });
  await t.test("fake signature without verification material", async () => {
    const document = fixture();
    provenance(document).bundle.dsseEnvelope.signatures[0].sig =
      Buffer.from("fake").toString("base64");
    delete provenance(document).bundle.verificationMaterial;
    await assert.rejects(
      verifyNpmAttestation(document, EXPECTED, fakeDependencies()),
      /Sigstore bundle fields|verification material/,
    );
  });
});

test("rejects every release-identity field when payload and certificate diverge", async (t) => {
  const mutations = new Map([
    [
      "subject package",
      (value) => (value.subject[0].name = "pkg:npm/%40attacker/package@2.1.1"),
    ],
    [
      "subject digest",
      (value) => (value.subject[0].digest.sha512 = "00".repeat(64)),
    ],
    [
      "workflow ref",
      (value) =>
        (value.predicate.buildDefinition.externalParameters.workflow.ref =
          "refs/tags/v9.9.9"),
    ],
    [
      "workflow repository",
      (value) =>
        (value.predicate.buildDefinition.externalParameters.workflow.repository =
          "https://github.com/attacker/repository"),
    ],
    [
      "workflow path",
      (value) =>
        (value.predicate.buildDefinition.externalParameters.workflow.path =
          ".github/workflows/other.yml"),
    ],
    [
      "trigger",
      (value) =>
        (value.predicate.buildDefinition.internalParameters.github.event_name =
          "workflow_dispatch"),
    ],
    [
      "repository ID",
      (value) =>
        (value.predicate.buildDefinition.internalParameters.github.repository_id =
          "1"),
    ],
    [
      "owner ID",
      (value) =>
        (value.predicate.buildDefinition.internalParameters.github.repository_owner_id =
          "1"),
    ],
    [
      "resolved repository",
      (value) =>
        (value.predicate.buildDefinition.resolvedDependencies[0].uri =
          "git+https://github.com/attacker/repository@refs/tags/v2.1.1"),
    ],
    [
      "commit",
      (value) =>
        (value.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit =
          "a".repeat(40)),
    ],
    [
      "builder",
      (value) =>
        (value.predicate.runDetails.builder.id =
          "https://attacker.example/runner"),
    ],
    [
      "invocation",
      (value) =>
        (value.predicate.runDetails.metadata.invocationId =
          "https://github.com/honojs/node-server/actions/runs/1/attempts/1"),
    ],
    [
      "extra workflow input",
      (value) =>
        (value.predicate.buildDefinition.externalParameters.inputs = {}),
    ],
    [
      "extra dependency",
      (value) =>
        value.predicate.buildDefinition.resolvedDependencies.push(
          cloneJson(value.predicate.buildDefinition.resolvedDependencies[0]),
        ),
    ],
  ]);
  for (const [name, mutate] of mutations) {
    await t.test(name, async () => {
      const document = fixture();
      const changed = statement(document);
      mutate(changed);
      replaceStatement(document, changed);
      await assert.rejects(
        verifyNpmAttestation(document, EXPECTED, fakeDependencies()),
        /npm provenance/,
      );
    });
  }
});
