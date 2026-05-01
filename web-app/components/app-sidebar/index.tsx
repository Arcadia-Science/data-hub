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
import type { SidebarInstrument, SidebarWatcher } from "@/lib/api/sidebar";
import type { Session } from "next-auth";
import Image from "next/image";
import Link from "next/link";

type AppSidebarProps = {
  session: Session;
  instruments: SidebarInstrument[];
  watchers: SidebarWatcher[];
  signOutAction: () => Promise<void>;
};

export function AppSidebar({
  session,
  instruments,
  watchers,
  signOutAction,
}: AppSidebarProps) {
  return (
    <Sidebar collapsible="offcanvas">
      <SidebarHeader className="px-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              tooltip="Data Hub"
              className="py-1 group-data-[collapsible=icon]:justify-center"
            >
              <Link href="/">
                <Image
                  src="/arcadia-logo-xs.svg"
                  alt="Arcadia"
                  width={26}
                  height={26}
                  priority
                  className="size-6 shrink-0 dark:invert"
                />
                <span className="text-base font-medium">Data Hub</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <AppSidebarContent instruments={instruments} watchers={watchers} />
      <SidebarFooter>
        <UserMenuFooter user={session.user} signOutAction={signOutAction} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
