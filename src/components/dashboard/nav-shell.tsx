"use client";

import * as React from "react";

/**
 * The workspace shell, as seen from inside it.
 *
 * The website (`Shell`) and the desktop app (`DesktopShell`) both own the
 * Framevo navigation: the fixed rail at `lg` and up, and the drawer below it.
 * Screens that render their OWN chrome — today only the fullscreen editor —
 * still need two things from whichever shell is around them: where the logo
 * goes home to, and how to open that drawer on a narrow window.
 *
 * Passing those through the context rather than re-deriving them is what keeps
 * the editor from carrying a second, drifting copy of the nav. It carried one
 * until now, which is why the desktop editor's menu was still offering the
 * website's route list and a storage card the app deliberately dropped.
 */
export interface NavShellValue {
  /** Where the wordmark/logo links. The website has a marketing home; the app doesn't. */
  homeHref: string;
  /** Open the shell's nav drawer — the below-`lg` counterpart of the fixed rail. */
  openNav: () => void;
}

const NavShellContext = React.createContext<NavShellValue | null>(null);

export function NavShellProvider({
  value,
  children,
}: {
  value: NavShellValue;
  children: React.ReactNode;
}) {
  return <NavShellContext.Provider value={value}>{children}</NavShellContext.Provider>;
}

/**
 * `null` when there is no shell around the tree. Callers render the affected
 * control conditionally rather than falling back to a no-op — a menu button
 * that opens nothing is worse than no menu button.
 */
export function useNavShell(): NavShellValue | null {
  return React.useContext(NavShellContext);
}
