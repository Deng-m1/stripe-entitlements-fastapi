import type { Metadata } from "next";
import { AccountScreen } from "@/components/AccountScreen";

export const metadata: Metadata = {
  title: "Account",
  description: "Review the webhook-projected subscription and entitlement state.",
  robots: { index: false, follow: false },
};

export default function AccountPage() {
  return <AccountScreen />;
}
