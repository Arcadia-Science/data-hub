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

// Every link sets `prefetch={false}`. `router.refresh()` prefetches each
// visible link again, and a run page refreshes while files are in progress.
const SIDEBAR_INSTRUMENTS_LIMIT = 5;
const SIDEBAR_NOTEBOOKS_LIMIT = 5;

interface MainNavProps {
  currentUserId: string;
  instruments: SidebarInstrument[];
  // The live notebooks that most recently got a run, newest first.
  notebooks: SidebarNotebook[];
}

export function MainNav({
  currentUserId,
  instruments,
  notebooks,
}: MainNavProps) {
  const pathname = usePathname();
  const myRunsHref = `/users/${currentUserId}`;
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
              isActive={pathname === myRunsHref}
              tooltip="My runs"
            >
              <Link href={myRunsHref} prefetch={false}>
                <ListChecks />
                <span>My runs</span>
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

          <CollapsibleNavSection
            currentPath={pathname}
            icon={NotebookText}
            items={sidebarNotebooks}
            label="Notebooks"
            recentlyViewedItems={recentlyViewedNotebooks}
            viewAllHref="/notebooks"
          />
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
