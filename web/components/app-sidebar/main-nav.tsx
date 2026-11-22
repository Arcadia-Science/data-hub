"use client";

import {
  ChevronRight,
  Cpu,
  Home,
  ListChecks,
  type LucideIcon,
  NotebookText,
} from "lucide-react";
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
import { useRecentNotebooks } from "@/hooks/use-recent-notebooks";
import type { SidebarInstrument, SidebarNotebook } from "@/lib/api/sidebar";
import { notebookPageHref } from "@/lib/notebooks/details";
import type { SidebarNavGroupsOpen } from "@/lib/sidebar-persistence";

// Every link sets `prefetch={false}`. `router.refresh()` prefetches each
// visible link again, and a run page refreshes while files are in progress.
const SIDEBAR_INSTRUMENTS_LIMIT = 5;
const SIDEBAR_NOTEBOOKS_LIMIT = 5;

interface MainNavProps {
  currentUserId: string;
  // Whether the Instruments and Lab Notebooks groups are open, as of when this
  // mounts. Each group manages its own state after that.
  groupsOpen: SidebarNavGroupsOpen;
  instruments: SidebarInstrument[];
  // The live notebooks that most recently got a run, newest first.
  notebooks: SidebarNotebook[];
  onGroupOpenChange: (group: keyof SidebarNavGroupsOpen, open: boolean) => void;
}

export function MainNav({
  currentUserId,
  groupsOpen,
  instruments,
  notebooks,
  onGroupOpenChange,
}: MainNavProps) {
  const pathname = usePathname();
  const myActivityHref = `/users/${currentUserId}`;
  const { recent: recentInstruments } = useRecentInstruments();

  const recentlyViewedInstruments = useMemo(
    () => recentInstruments.slice(0, SIDEBAR_INSTRUMENTS_LIMIT),
    [recentInstruments]
  );

  const recentlyViewedIds = useMemo(
    () => new Set(recentlyViewedInstruments.map((entry) => entry.instrumentId)),
    [recentlyViewedInstruments]
  );

  const sidebarInstruments = useMemo(() => {
    const remainingSlots =
      SIDEBAR_INSTRUMENTS_LIMIT - recentlyViewedInstruments.length;
    return instruments
      .filter((instrument) => !recentlyViewedIds.has(instrument.id))
      .slice(0, remainingSlots)
      .map((instrument) => ({
        key: instrument.id,
        href: `/instruments/${instrument.id}`,
        label: instrument.displayName,
      }));
  }, [instruments, recentlyViewedIds, recentlyViewedInstruments.length]);

  // Recently viewed notebooks first, then the ones that most recently got a
  // run, up to SIDEBAR_NOTEBOOKS_LIMIT in all.
  const { recent: recentNotebooks } = useRecentNotebooks();
  const recentlyViewedNotebooks = useMemo(
    () =>
      recentNotebooks.slice(0, SIDEBAR_NOTEBOOKS_LIMIT).map((notebook) => ({
        key: notebook.notebookId,
        href: notebookPageHref(notebook.notebookId),
        label: notebook.name,
      })),
    [recentNotebooks]
  );
  const sidebarNotebooks = useMemo(() => {
    const shown = new Set(recentlyViewedNotebooks.map((item) => item.key));
    return notebooks
      .filter((notebook) => !shown.has(notebook.id))
      .slice(0, SIDEBAR_NOTEBOOKS_LIMIT - recentlyViewedNotebooks.length)
      .map((notebook) => ({
        key: notebook.id,
        href: notebookPageHref(notebook.id),
        label: notebook.name,
      }));
  }, [notebooks, recentlyViewedNotebooks]);

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
              <Link href="/" prefetch={false}>
                <Home />
                <span>Home</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>

          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              isActive={pathname === myActivityHref}
              tooltip="My activity"
            >
              <Link href={myActivityHref} prefetch={false}>
                <ListChecks />
                <span>My activity</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>

          <CollapsibleNavSection
            currentPath={pathname}
            defaultOpen={groupsOpen.instruments}
            icon={Cpu}
            items={sidebarInstruments}
            label="Instruments"
            onOpenChange={(open) => onGroupOpenChange("instruments", open)}
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
            currentPath={pathname}
            defaultOpen={groupsOpen.notebooks}
            icon={NotebookText}
            items={sidebarNotebooks}
            label="Lab Notebooks"
            onOpenChange={(open) => onGroupOpenChange("notebooks", open)}
            recentlyViewedItems={recentlyViewedNotebooks}
            viewAllHref="/lab-notebooks"
          />
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

interface CollapsibleNavSectionProps {
  currentPath: string;
  defaultOpen: boolean;
  icon: LucideIcon;
  items: Array<{ key: string; href: string; label: string }>;
  label: string;
  onOpenChange: (open: boolean) => void;
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
  defaultOpen,
  onOpenChange,
}: CollapsibleNavSectionProps) {
  return (
    <Collapsible
      asChild
      className="group/collapsible"
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange}
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
            {recentlyViewedItems.length > 0
              ? recentlyViewedItems.map((item) => (
                  <SidebarMenuSubItem key={`recent-${item.key}`}>
                    <SidebarMenuSubButton
                      asChild
                      isActive={isNavItemActive(currentPath, item.href)}
                    >
                      <Link href={item.href} prefetch={false}>
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
                  <Link href={item.href} prefetch={false}>
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
                <Link href={viewAllHref} prefetch={false}>
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
