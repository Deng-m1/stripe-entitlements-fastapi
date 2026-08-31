import type {
  Database,
  DatabasePoolOptions,
} from "@tosea/stripe-entitlements";

// Import a public declaration that directly exposes pg types. With
// skipLibCheck=false, this makes the clean consumer reject a tarball that omits
// declaration-only production dependencies such as @types/pg.
export interface InstalledPackageDeclarationContract {
  readonly database: Database;
  readonly poolOptions: DatabasePoolOptions;
}
