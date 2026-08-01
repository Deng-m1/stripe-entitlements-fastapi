import type { MetadataRoute } from "next";
import {
  absoluteSiteUrl,
  allowIndexing,
  publicSiteUrl,
} from "@/lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  if (!allowIndexing || !publicSiteUrl) return [];

  return [
    {
      url: absoluteSiteUrl(publicSiteUrl, "/")!,
      changeFrequency: "monthly",
      priority: 1,
    },
    {
      url: absoluteSiteUrl(publicSiteUrl, "/pricing")!,
      changeFrequency: "weekly",
      priority: 0.9,
    },
  ];
}
