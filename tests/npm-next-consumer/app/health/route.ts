import { environmentNextBillingRouteHandler as handle } from "@tosea/stripe-entitlements/next";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const GET = handle;
export const POST = handle;
export const OPTIONS = handle;
