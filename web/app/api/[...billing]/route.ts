import { simulationSafeBillingRouteHandler as handle } from "@/lib/simulation-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const GET = handle;
export const POST = handle;
export const OPTIONS = handle;
