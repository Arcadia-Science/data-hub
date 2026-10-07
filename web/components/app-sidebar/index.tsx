import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { AppSidebarContent } from "@/components/app-sidebar/app-sidebar-content";
import { UserMenuFooter } from "@/components/app-sidebar/user-menu-footer";
import {
  Sidebar,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import type { SidebarInstrument } from "@/lib/api/sidebar";
import type { Session } from "@/lib/auth";
import type { ChangelogDaySection } from "@/lib/changelog/group";

interface AppSidebarProps {
  changelogSections: readonly ChangelogDaySection[];
  // Extra items for the account menu, such as the Feedback entry.
  children?: ReactNode;
  instruments: SidebarInstrument[];
  session: Session;
  signOutAction: () => Promise<void>;
}

export function AppSidebar({
  changelogSections,
  children,
  session,
  instruments,
  signOutAction,
}: AppSidebarProps) {
  return (
    <Sidebar collapsible="offcanvas">
      <SidebarHeader className="h-14 justify-center px-2 py-0">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              className="py-1 group-data-[collapsible=icon]:justify-center"
              tooltip="Data Hub"
            >
              <Link
                href="/"
                // `router.refresh()` prefetches every visible link again, and
                // this logo stays visible on a run page that refreshes.
                prefetch={false}
              >
                <Image
                  alt="Data Hub"
                  className="size-5.5 shrink-0"
                  height={26}
                  priority
                  src="/images/data-hub-logo.svg"
                  width={26}
                />
                <span className="font-medium text-base">Data Hub</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <AppSidebarContent
        currentUserId={session.user.id}
        instruments={instruments}
        isAdmin={session.user.isAdmin === true}
      />
      <SidebarFooter>
        <UserMenuFooter
          changelogSections={changelogSections}
          signOutAction={signOutAction}
          user={session.user}
        >
          {children}
        </UserMenuFooter>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
