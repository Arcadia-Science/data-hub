"use client";

import {
  BookOpen,
  ChevronsUpDown,
  ExternalLink,
  LogOut,
  MessageSquarePlus,
  ScrollText,
  Settings,
} from "lucide-react";
import Link from "next/link";
import { useState, useTransition } from "react";
import { DocsLink } from "@/components/docs-link";
import { SendFeedbackDialog } from "@/components/feedback/send-feedback-dialog";
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
import { useChangelogSeen } from "@/hooks/use-changelog-seen";
import { toUserAvatarUser } from "@/lib/avatar-color";
import { DOCS_URL } from "@/lib/docs";

interface UserMenuFooterProps {
  changelogIds: readonly string[];
  signOutAction: () => Promise<void>;
  user: {
    id: string;
    name?: string | null;
    email?: string | null;
    image?: string | null;
  };
}

export function UserMenuFooter({
  changelogIds,
  user,
  signOutAction,
}: UserMenuFooterProps) {
  const { isMobile } = useSidebar();
  const { hasUnseen } = useChangelogSeen();
  const unseen = hasUnseen(changelogIds);
  const [menuOpen, setMenuOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
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
        <DropdownMenu onOpenChange={setMenuOpen} open={menuOpen}>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
              size="lg"
            >
              <span className="relative">
                <UserAvatar size="default" user={avatarUser} />
                {unseen ? (
                  <span
                    aria-hidden
                    className="absolute top-0 right-0 size-2 rounded-full bg-primary ring-2 ring-sidebar"
                  />
                ) : null}
              </span>
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
              {unseen ? (
                <span className="sr-only">New changelog entries</span>
              ) : null}
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
              <Link href="/changelog">
                <ScrollText data-icon="inline-start" />
                {unseen ? (
                  <>
                    <span className="sr-only">Changelog, new entries</span>
                    <span aria-hidden>Changelog</span>
                  </>
                ) : (
                  "Changelog"
                )}
                {unseen ? (
                  <span
                    aria-hidden
                    className="ml-auto size-2 shrink-0 rounded-full bg-primary"
                  />
                ) : null}
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={(event) => {
                event.preventDefault();
                setMenuOpen(false);
                setFeedbackOpen(true);
              }}
            >
              <MessageSquarePlus data-icon="inline-start" />
              Feedback
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <DocsLink href={DOCS_URL}>
                <BookOpen data-icon="inline-start" />
                Docs
                <ExternalLink className="ml-auto size-3.5 text-muted-foreground" />
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
        <SendFeedbackDialog
          onOpenChange={setFeedbackOpen}
          open={feedbackOpen}
        />
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
