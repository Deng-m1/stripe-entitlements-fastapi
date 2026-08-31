#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: scripts/verify_npm_migration_smoke.sh PACKAGE.tgz EXPECTED_VERSION" >&2
}

if [ "$#" -ne 2 ]; then
  usage
  exit 2
fi

archive="$1"
expected_version="$2"
if [ ! -s "$archive" ]; then
  echo "npm package archive is missing or empty" >&2
  exit 2
fi
case "$expected_version" in
  ''|*[!0-9A-Za-z.+-]*)
    echo "expected npm package version is invalid" >&2
    exit 2
    ;;
esac

archive="$(realpath "$archive")"
scratch_root="$(mktemp -d -t stripe-entitlements-npm-migration.XXXXXXXX)"
package_root="$scratch_root/package"
postgres_suffix="${scratch_root##*.}"
postgres_container="stripe-entitlements-npm-pg-${postgres_suffix}-$$"
postgres_started=0

cleanup() {
  if [ "$postgres_started" -eq 1 ]; then
    docker rm --force "$postgres_container" >/dev/null 2>&1 || true
  fi
  rm -rf -- "$scratch_root"
}
trap cleanup EXIT

npm install \
  --no-audit \
  --no-fund \
  --prefix "$package_root" \
  "$archive" >/dev/null

installed="$package_root/node_modules/@tosea/stripe-entitlements"
cli="$package_root/node_modules/.bin/stripe-entitlements"
if [ ! -x "$cli" ] || [ ! -f "$installed/package.json" ]; then
  echo "clean npm install did not expose the packaged CLI" >&2
  exit 1
fi
installed_version="$(node -p "require('$installed/package.json').version")"
if [ "$installed_version" != "$expected_version" ]; then
  echo "installed npm package version does not match the release version" >&2
  exit 1
fi
if [ "$("$cli" --version)" != "stripe-entitlements $expected_version" ]; then
  echo "installed npm package CLI version does not match the release version" >&2
  exit 1
fi

postgres_image="${TEST_POSTGRES_IMAGE:-postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73}"
postgres_database="npm_artifact_ci"
postgres_password="npm-artifact-ci-only"
docker run \
  --detach \
  --name "$postgres_container" \
  --env "POSTGRES_DB=$postgres_database" \
  --env "POSTGRES_PASSWORD=$postgres_password" \
  --env "PGDATA=/var/lib/postgresql/data" \
  --publish 127.0.0.1::5432 \
  --tmpfs /var/lib/postgresql/data:rw,nosuid,nodev,size=256m \
  "$postgres_image" >/dev/null
postgres_started=1

postgres_ready=0
for ((attempt = 0; attempt < 240; attempt += 1)); do
  if docker exec "$postgres_container" \
    pg_isready -h 127.0.0.1 -U postgres -d "$postgres_database" \
    >/dev/null 2>&1; then
    postgres_ready=1
    break
  fi
  sleep 0.25
done
if [ "$postgres_ready" -ne 1 ]; then
  echo "disposable PostgreSQL did not become ready" >&2
  exit 1
fi

postgres_binding="$(docker port "$postgres_container" 5432/tcp)"
case "$postgres_binding" in
  127.0.0.1:*) postgres_port="${postgres_binding##*:}" ;;
  *)
    echo "cannot resolve the loopback PostgreSQL port" >&2
    exit 1
    ;;
esac
case "$postgres_port" in
  ''|*[!0-9]*)
    echo "resolved PostgreSQL port is invalid" >&2
    exit 1
    ;;
esac
database_url="postgresql://postgres:${postgres_password}@127.0.0.1:${postgres_port}/${postgres_database}"

run_packaged_migrate() {
  local output
  output="$({
    cd "$scratch_root"
    DATABASE_URL="$database_url" \
      DATABASE_POOL_MIN=0 \
      DATABASE_POOL_MAX=2 \
      "$cli" migrate
  })"
  if [ "$output" != '{"ok":true,"command":"migrate"}' ]; then
    echo "installed npm package CLI returned an unexpected migration result" >&2
    exit 1
  fi
}

# Both calls execute the clean-installed binary from outside the repository. The second
# call proves that the published migration history is idempotent.
run_packaged_migrate
run_packaged_migrate

(
  cd "$package_root"
  DATABASE_URL="$database_url" \
    INSTALLED_PACKAGE_ROOT="$installed" \
    EXPECTED_PACKAGE_VERSION="$expected_version" \
    node --input-type=module <<'JS'
import { createHash } from "node:crypto";
import { readdir, readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";

import {
  CORRECTNESS_TABLES,
  Database,
  defaultMigrationDirectory,
} from "@tosea/stripe-entitlements";

const expectedMigrations = new Map([
  [
    "001_v3_baseline.sql",
    "8db1d8dec549a9a06148d0df3d73d7e3880dd77858cf1a13cff8837a45b07e11",
  ],
  [
    "002_stripe_request_snapshots.sql",
    "052b9ed201c19621a2bf9230b1e5c1eca6ba5dba6be760a5ac40ce40b7289e13",
  ],
]);
const installedPackageRoot = await realpath(
  process.env.INSTALLED_PACKAGE_ROOT ?? "",
);
const migrationDirectory = await realpath(defaultMigrationDirectory());
const expectedDirectory = await realpath(
  resolve(installedPackageRoot, "dist", "migrations"),
);
if (migrationDirectory !== expectedDirectory) {
  throw new Error(
    "migration smoke resolved resources outside the installed npm package",
  );
}

const filenames = (await readdir(migrationDirectory))
  .filter((filename) => filename.endsWith(".sql"))
  .sort();
if (
  JSON.stringify(filenames) !== JSON.stringify([...expectedMigrations.keys()])
) {
  throw new Error("installed npm package migration versions are incomplete");
}
for (const [filename, expectedSha256] of expectedMigrations) {
  const payload = await readFile(resolve(migrationDirectory, filename));
  const observedSha256 = createHash("sha256").update(payload).digest("hex");
  if (observedSha256 !== expectedSha256) {
    throw new Error(
      `installed migration checksum changed for ${JSON.stringify(filename)}`,
    );
  }
}

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("DATABASE_URL is unavailable to the package migration verifier");
}
const database = new Database(databaseUrl, { min: 0, max: 2 });
await database.connect();
try {
  if (!(await database.schemaReady())) {
    throw new Error("installed npm package reports the migrated schema is not ready");
  }
  const history = await database.query(
    `select filename,sha256,applied_at is not null as applied
       from schema_migrations order by filename`,
  );
  if (history.rows.length !== expectedMigrations.size) {
    throw new Error("migration history has an unexpected row count");
  }
  for (const row of history.rows) {
    if (
      expectedMigrations.get(row.filename) !== row.sha256 ||
      row.applied !== true
    ) {
      throw new Error(
        `migration history mismatch for ${JSON.stringify(row.filename)}`,
      );
    }
  }

  const tableContract = await database.query(
    `select count(*)::integer as count
       from unnest($1::text[]) as expected(name)
      where to_regclass('public.' || expected.name) is not null`,
    [[...CORRECTNESS_TABLES]],
  );
  if (tableContract.rows[0]?.count !== CORRECTNESS_TABLES.length) {
    throw new Error("fresh npm migration is missing a correctness table");
  }

  const snapshotContract = await database.query(
    `select count(*)::integer as count
       from information_schema.columns
      where table_schema='public'
        and table_name=any($1::text[])
        and column_name=any($2::text[])`,
    [
      ["checkout_claims", "credit_pack_orders", "billing_plan_changes"],
      ["request_snapshot_version", "stripe_request_snapshot"],
    ],
  );
  if (snapshotContract.rows[0]?.count !== 6) {
    throw new Error("fresh npm migration is missing the 002 snapshot columns");
  }
} finally {
  await database.close();
}

console.log(
  `npm-artifact-migration-contract=${process.env.EXPECTED_PACKAGE_VERSION} migrations=2 schema_ready=true`,
);
JS
)
