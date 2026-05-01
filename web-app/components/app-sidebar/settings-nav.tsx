"use client";

import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

type SettingsSection = {
  href: string;
  label: string;
};

const SETTINGS_SECTIONS: SettingsSection[] = [
  { href: "/settings/tokens", label: "Access Tokens" },
];

// Single, predictable destination for the "leave settings" affordance. A
// real `router.back()` is unreliable because `window.history.length` doesn't
// distinguish a fresh tab from one with prior in-app history, and back can
// land the user on an off-domain referrer. Always send them to the
// dashboard so middle-click / cmd-click / "Copy link" all behave too.
const EXIT_SETTINGS_HREF = "/";

export function SettingsNav() {
  const pathname = usePathname();

  return (
    <>
      {/* Full-width menu item: chevron pinned to the left edge while the
          "Settings" label stays optically centered, mirroring Vercel's
          settings sidebar header. */}
      <SidebarGroup className="pb-0">
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                asChild
                tooltip="Exit settings"
                className="relative justify-center font-medium"
              >
                <Link href={EXIT_SETTINGS_HREF}>
                  <ChevronLeft className="absolute left-2" />
                  <span>Settings</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>

      <SidebarGroup className="pt-1">
        <SidebarGroupContent>
          <SidebarMenu>
            {SETTINGS_SECTIONS.map((section) => (
              <SidebarMenuItem key={section.href}>
                <SidebarMenuButton
                  asChild
                  isActive={pathname.startsWith(section.href)}
                  tooltip={section.label}
                >
                  <Link href={section.href}>
                    <span>{section.label}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    </>
  );
}
