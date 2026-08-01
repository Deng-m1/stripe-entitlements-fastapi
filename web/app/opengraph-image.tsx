import { createSocialImage } from "@/lib/social-image";

export const alt =
  "Stripe Entitlements for FastAPI: race-safe subscription billing reference";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  return createSocialImage();
}
