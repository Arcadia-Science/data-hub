import Image from "next/image";
import Link from "next/link";
import type { Session } from "next-auth";
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
              className="py-1 group-data-[collapsible=icon]:justify-center"
              tooltip="Data Hub"
            >
              <Link href="/">
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
        instruments={instruments}
        isAdmin={session.user.isAdmin === true}
        watchers={watchers}
      />
      <SidebarFooter>
        <UserMenuFooter signOutAction={signOutAction} user={session.user} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
