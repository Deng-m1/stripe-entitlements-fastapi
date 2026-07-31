import type { Metadata } from "next";
import { AccountScreen } from "@/components/AccountScreen";

export const metadata: Metadata = {
  title: "Account",
  description: "Review the webhook-projected subscription and entitlement state.",
};

export default function AccountPage() {
  return <AccountScreen />;
}
