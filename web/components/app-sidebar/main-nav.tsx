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
import type { SidebarInstrument } from "@/lib/api/sidebar";

const SIDEBAR_RECENT_INSTRUMENTS_LIMIT = 10;

interface MainNavProps {
  activeInstrumentIds: string[];
  instruments: SidebarInstrument[];
}

export function MainNav({ activeInstrumentIds, instruments }: MainNavProps) {
  const pathname = usePathname();
  const { recent: recentInstruments } = useRecentInstruments();

  const activeIdSet = useMemo(
    () => new Set(activeInstrumentIds),
    [activeInstrumentIds]
  );

  // Prune the localStorage-backed list to still-active instruments so a
  // retired/pending one the user once visited doesn't linger in the nav.
  const recentlyViewedInstruments = useMemo(
    () =>
      recentInstruments
        .filter((entry) => activeIdSet.has(entry.instrumentId))
        .slice(0, SIDEBAR_RECENT_INSTRUMENTS_LIMIT),
    [recentInstruments, activeIdSet]
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

  const isWatchersActive =
    pathname === "/watchers" || pathname.startsWith("/watchers/");

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

          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              isActive={isWatchersActive}
              tooltip="Watchers"
            >
              <Link href="/watchers">
                <Radio />
                <span>Watchers</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

interface CollapsibleNavSectionProps {
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
  viewAllHref,
  items,
  recentlyViewedItems = [],
  currentPath,
}: CollapsibleNavSectionProps) {
  return (
    <Collapsible asChild className="group/collapsible" defaultOpen>
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
            {recentlyViewedItems.length > 0
              ? recentlyViewedItems.map((item) => (
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
                ))
              : null}
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
