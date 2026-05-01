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
import { usePathname, useRouter } from "next/navigation";

type SettingsSection = {
  href: string;
  label: string;
};

const SETTINGS_SECTIONS: SettingsSection[] = [
  { href: "/settings/tokens", label: "Access Tokens" },
];

export function SettingsNav() {
  const router = useRouter();
  const pathname = usePathname();

  const handleBack = () => {
    // history.length is 1 on a fresh tab landing directly on /settings/*. In
    // that case there's nothing to go back to, so we send the user to the
    // dashboard instead of leaving them stuck.
    if (typeof window !== "undefined" && window.history.length > 1) {
      router.back();
    } else {
      router.push("/");
    }
  };

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
                onClick={handleBack}
                tooltip="Back"
                className="relative justify-center font-medium"
              >
                <ChevronLeft className="absolute left-2" />
                <span>Settings</span>
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
