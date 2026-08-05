"use client";

import {
  BookOpen,
  ChevronsUpDown,
  ExternalLink,
  LogOut,
  Settings,
} from "lucide-react";
import Link from "next/link";
import { useTransition } from "react";
import { DocsLink } from "@/components/docs-link";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { UserAvatar } from "@/components/user-avatar";
import { toUserAvatarUser } from "@/lib/avatar-color";
import { DOCS_URL } from "@/lib/docs";

interface UserMenuFooterProps {
  signOutAction: () => Promise<void>;
  user: {
    id: string;
    name?: string | null;
    email?: string | null;
    image?: string | null;
  };
}

export function UserMenuFooter({ user, signOutAction }: UserMenuFooterProps) {
  const { isMobile } = useSidebar();
  const [isPending, startTransition] = useTransition();
  const avatarUser = toUserAvatarUser({
    userId: user.id,
    name: user.name,
    email: user.email,
    image: user.image,
  });

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
              size="lg"
            >
              <UserAvatar size="default" user={avatarUser} />
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">
                  {avatarUser.displayName}
                </span>
                {user.email && (
                  <span className="truncate text-muted-foreground text-xs">
                    {user.email}
                  </span>
                )}
              </div>
              <ChevronsUpDown className="ml-auto size-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
            side={isMobile ? "bottom" : "top"}
            sideOffset={4}
          >
            <DropdownMenuItem asChild>
              <DocsLink href={DOCS_URL}>
                <BookOpen data-icon="inline-start" />
                Docs
                <ExternalLink className="ml-auto text-muted-foreground" />
              </DocsLink>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href="/settings/notifications">
                <Settings data-icon="inline-start" />
                Settings
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={isPending}
              onClick={() => startTransition(() => signOutAction())}
            >
              <LogOut data-icon="inline-start" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
