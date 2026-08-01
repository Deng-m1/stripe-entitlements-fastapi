import type { MetadataRoute } from "next";
import {
  absoluteSiteUrl,
  allowIndexing,
  publicSiteUrl,
} from "@/lib/site";

export default function robots(): MetadataRoute.Robots {
  if (!allowIndexing) {
    return { rules: { userAgent: "*", disallow: "/" } };
  }

  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/account", "/billing/"],
    },
    sitemap: absoluteSiteUrl(publicSiteUrl, "/sitemap.xml"),
  };
}
