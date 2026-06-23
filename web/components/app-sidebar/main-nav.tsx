"use client";

import { ChevronRight, Cpu, Home, type LucideIcon, Radio } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar";
import type { SidebarInstrument, SidebarWatcher } from "@/lib/api/sidebar";

interface MainNavProps {
  instruments: SidebarInstrument[];
  watchers: SidebarWatcher[];
}

export function MainNav({ instruments, watchers }: MainNavProps) {
  const pathname = usePathname();

  return (
    <SidebarGroup>
      <SidebarGroupLabel>Navigation</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              isActive={pathname === "/"}
              tooltip="Home"
            >
              <Link href="/">
                <Home />
                <span>Home</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>

          <CollapsibleNavSection
            basePath="/instruments"
            currentPath={pathname}
            icon={Cpu}
            items={instruments.map((instrument) => ({
              key: instrument.id,
              href: `/instruments/${instrument.id}`,
              label: instrument.displayName,
            }))}
            label="Instruments"
            viewAllHref="/instruments"
          />

          <CollapsibleNavSection
            basePath="/watchers"
            currentPath={pathname}
            icon={Radio}
            items={watchers.map((watcher) => ({
              key: watcher.id,
              href: `/watchers/${watcher.id}`,
              // Hostname is the canonical identifier for a watcher in the
              // table view; fall back to the short id when missing so the
              // row never collapses to an empty label.
              label: watcher.hostname ?? `${watcher.id.slice(0, 8)}…`,
            }))}
            label="Watchers"
            viewAllHref="/watchers"
          />
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

interface CollapsibleNavSectionProps {
  /** Pathname prefix used to determine the active/expanded state. */
  basePath: string;
  currentPath: string;
  icon: LucideIcon;
  items: Array<{ key: string; href: string; label: string }>;
  label: string;
  /** Href for the trailing "View all" sub-item that opens the full list. */
  viewAllHref: string;
}

function CollapsibleNavSection({
  icon: Icon,
  label,
  basePath,
  viewAllHref,
  items,
  currentPath,
}: CollapsibleNavSectionProps) {
  // Open the section by default whenever the user is anywhere within it so
  // their current location stays visible without an extra click.
  const isWithinSection =
    currentPath === basePath || currentPath.startsWith(`${basePath}/`);

  return (
    <Collapsible
      asChild
      className="group/collapsible"
      defaultOpen={isWithinSection}
    >
      <SidebarMenuItem>
        <CollapsibleTrigger asChild>
          <SidebarMenuButton tooltip={label}>
            <Icon />
            <span>{label}</span>
            <ChevronRight className="ml-auto transition-transform group-data-[state=open]/collapsible:rotate-90" />
          </SidebarMenuButton>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub>
            {items.map((item) => (
              <SidebarMenuSubItem key={item.key}>
                <SidebarMenuSubButton
                  asChild
                  isActive={currentPath === item.href}
                >
                  <Link href={item.href}>
                    <span className="truncate">{item.label}</span>
                  </Link>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            ))}
            <SidebarMenuSubItem>
              <SidebarMenuSubButton
                asChild
                className="text-muted-foreground"
                isActive={currentPath === viewAllHref}
              >
                <Link href={viewAllHref}>
                  <span>View all</span>
                </Link>
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  );
}
