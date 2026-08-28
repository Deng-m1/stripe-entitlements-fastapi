import type { MetadataRoute } from "next";
import { SITE_DESCRIPTION, SITE_NAME } from "@/lib/site";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: SITE_NAME,
    short_name: "Stripe Entitlements",
    description: SITE_DESCRIPTION,
    start_url: "/",
    display: "standalone",
    // DESIGN_SYSTEM.md §3: white canvas, iris as the single brand accent.
    background_color: "#ffffff",
    theme_color: "#5b4cf5",
  };
}
