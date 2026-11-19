"use client";

import { usePathname } from "next/navigation";
import { MainNav } from "@/components/app-sidebar/main-nav";
import { SettingsNav } from "@/components/app-sidebar/settings-nav";
import { SidebarContent } from "@/components/ui/sidebar";
import type { SidebarInstrument, SidebarNotebook } from "@/lib/api/sidebar";

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

  return (
    <SidebarContent>
      {isSettings ? (
        <SettingsNav isAdmin={isAdmin} />
      ) : (
        <MainNav
          currentUserId={currentUserId}
          instruments={instruments}
          notebooks={notebooks}
        />
      )}
    </SidebarContent>
  );
}
