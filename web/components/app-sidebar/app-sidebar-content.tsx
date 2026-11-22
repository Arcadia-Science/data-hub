"use client";

import { usePathname } from "next/navigation";
import { createContext, type ReactNode, use, useState } from "react";
import { MainNav } from "@/components/app-sidebar/main-nav";
import { SettingsNav } from "@/components/app-sidebar/settings-nav";
import { SidebarContent } from "@/components/ui/sidebar";
import type { SidebarInstrument, SidebarNotebook } from "@/lib/api/sidebar";
import {
  SIDEBAR_COOKIE_MAX_AGE,
  SIDEBAR_INSTRUMENTS_COOKIE_NAME,
  SIDEBAR_NOTEBOOKS_COOKIE_NAME,
  type SidebarNavGroupsOpen,
} from "@/lib/sidebar-persistence";

type NavGroup = keyof SidebarNavGroupsOpen;

const GROUP_COOKIE_NAMES = {
  instruments: SIDEBAR_INSTRUMENTS_COOKIE_NAME,
  notebooks: SIDEBAR_NOTEBOOKS_COOKIE_NAME,
} as const;

// A cookie rather than `localStorage`, like the sidebar's own state, so the app
// layout can render a closed group closed on first paint.
function persistGroupOpen(group: NavGroup, open: boolean) {
  // biome-ignore lint/suspicious/noDocumentCookie: intentional client cookie write for SSR sidebar hydration
  document.cookie = `${GROUP_COOKIE_NAMES[group]}=${open}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}; samesite=lax`;
}

const NavGroupsContext = createContext<{
  groupsOpen: SidebarNavGroupsOpen;
  setGroupOpen: (group: NavGroup, open: boolean) => void;
} | null>(null);

/**
 * Whether the Instruments and Lab Notebooks groups are open, starting from the
 * cookies the layout read. The layout renders it outside the sidebar, like
 * `SidebarProvider`, because the navigation unmounts on the settings pages and
 * whenever the mobile sidebar closes, and the layout doesn't read the cookies
 * again on a client navigation. Kept here, a group comes back as it was left.
 */
export function SidebarNavGroupsProvider({
  children,
  defaultOpen,
}: {
  children: ReactNode;
  defaultOpen: SidebarNavGroupsOpen;
}) {
  const [groupsOpen, setGroupsOpen] = useState(defaultOpen);

  function setGroupOpen(group: NavGroup, open: boolean) {
    setGroupsOpen((current) => ({ ...current, [group]: open }));
    persistGroupOpen(group, open);
  }

  return (
    <NavGroupsContext value={{ groupsOpen, setGroupOpen }}>
      {children}
    </NavGroupsContext>
  );
}

interface AppSidebarContentProps {
  currentUserId: string;
  instruments: SidebarInstrument[];
  isAdmin: boolean;
  notebooks: SidebarNotebook[];
}

// Centralizes the "main vs. settings" mode toggle so the rest of the sidebar
// doesn't need to know about pathname-based switching. When the user
// navigates to /settings/* the sidebar swaps in place; navigating away
// restores the main view automatically.
export function AppSidebarContent({
  currentUserId,
  instruments,
  isAdmin,
  notebooks,
}: AppSidebarContentProps) {
  const pathname = usePathname();
  const isSettings = pathname.startsWith("/settings");
  const navGroups = use(NavGroupsContext);
  if (!navGroups) {
    throw new Error(
      "AppSidebarContent must be used within a SidebarNavGroupsProvider."
    );
  }

  return (
    <SidebarContent>
      {isSettings ? (
        <SettingsNav isAdmin={isAdmin} />
      ) : (
        <MainNav
          currentUserId={currentUserId}
          groupsOpen={navGroups.groupsOpen}
          instruments={instruments}
          notebooks={notebooks}
          onGroupOpenChange={navGroups.setGroupOpen}
        />
      )}
    </SidebarContent>
  );
}
