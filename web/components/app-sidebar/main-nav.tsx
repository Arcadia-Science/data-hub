"use client";

import { ChevronRight, Cpu, Home, type LucideIcon, Radio } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo } from "react";
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
import { useRecentInstruments } from "@/hooks/use-recent-instruments";
import type { SidebarInstrument, SidebarWatcher } from "@/lib/api/sidebar";

const SIDEBAR_RECENT_INSTRUMENTS_LIMIT = 10;

interface MainNavProps {
  instruments: SidebarInstrument[];
  watchers: SidebarWatcher[];
}

export function MainNav({ instruments, watchers }: MainNavProps) {
  const pathname = usePathname();
  const { recent: recentInstruments } = useRecentInstruments();

  const recentlyViewedInstruments = useMemo(
    () => recentInstruments.slice(0, SIDEBAR_RECENT_INSTRUMENTS_LIMIT),
    [recentInstruments]
  );

  const recentlyViewedIds = useMemo(
    () => new Set(recentlyViewedInstruments.map((entry) => entry.instrumentId)),
    [recentlyViewedInstruments]
  );

  const sidebarInstruments = useMemo(
    () =>
      instruments
        .filter((instrument) => !recentlyViewedIds.has(instrument.id))
        .map((instrument) => ({
          key: instrument.id,
          href: `/instruments/${instrument.id}`,
          label: instrument.displayName,
        })),
    [instruments, recentlyViewedIds]
  );

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
            items={sidebarInstruments}
            label="Instruments"
            recentlyViewedItems={recentlyViewedInstruments.map(
              (instrument) => ({
                key: instrument.instrumentId,
                href: `/instruments/${instrument.instrumentId}`,
                label: instrument.displayName,
              })
            )}
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
  recentlyViewedItems?: Array<{ key: string; href: string; label: string }>;
  /** Href for the trailing "View all" sub-item that opens the full list. */
  viewAllHref: string;
}

function isNavItemActive(currentPath: string, href: string): boolean {
  return currentPath === href || currentPath.startsWith(`${href}/`);
}

function CollapsibleNavSection({
  icon: Icon,
  label,
  basePath,
  viewAllHref,
  items,
  recentlyViewedItems = [],
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
            {recentlyViewedItems.length > 0 ? (
              <>
                <SidebarMenuSubItem>
                  <span className="px-2 py-1 font-medium text-muted-foreground text-xs">
                    Recently viewed
                  </span>
                </SidebarMenuSubItem>
                {recentlyViewedItems.map((item) => (
                  <SidebarMenuSubItem key={`recent-${item.key}`}>
                    <SidebarMenuSubButton
                      asChild
                      isActive={isNavItemActive(currentPath, item.href)}
                    >
                      <Link href={item.href}>
                        <span className="truncate">{item.label}</span>
                      </Link>
                    </SidebarMenuSubButton>
                  </SidebarMenuSubItem>
                ))}
              </>
            ) : null}
            {items.map((item) => (
              <SidebarMenuSubItem key={item.key}>
                <SidebarMenuSubButton
                  asChild
                  isActive={isNavItemActive(currentPath, item.href)}
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
