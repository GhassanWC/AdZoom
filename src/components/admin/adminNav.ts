/**
 * Admin sub-navigation. Kept LOCAL to the admin section (not in
 * `src/lib/mockData.ts` `sidebarItems`) so `/admin` never appears in the
 * normal user dashboard nav.
 */

export interface AdminNavItem {
  label: string;
  href: string;
  icon:
    | "LayoutDashboard"
    | "Users"
    | "Folder"
    | "Cpu"
    | "Download"
    | "CreditCard"
    | "AlertTriangle"
    | "Activity";
}

export const ADMIN_NAV: AdminNavItem[] = [
  { label: "Overview", href: "/admin", icon: "LayoutDashboard" },
  { label: "Users", href: "/admin/users", icon: "Users" },
  { label: "Projects", href: "/admin/projects", icon: "Folder" },
  { label: "Analysis", href: "/admin/analysis", icon: "Cpu" },
  { label: "Exports", href: "/admin/exports", icon: "Download" },
  { label: "Billing", href: "/admin/billing", icon: "CreditCard" },
  { label: "Errors", href: "/admin/errors", icon: "AlertTriangle" },
  { label: "Events", href: "/admin/events", icon: "Activity" },
];
