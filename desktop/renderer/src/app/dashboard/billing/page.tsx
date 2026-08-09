import BillingPage from "@/app/dashboard/billing/page";

/**
 * `/dashboard/billing` — the website's billing screen, on the user's real
 * subscription.
 *
 * Checkout and the customer portal are hosted by Lemon Squeezy, so they open in
 * the system browser: both buttons go through `platform.openExternal`, and the
 * Electron window refuses to navigate anywhere outside the app origin anyway.
 */
export default function DesktopBillingPage() {
  return <BillingPage />;
}
