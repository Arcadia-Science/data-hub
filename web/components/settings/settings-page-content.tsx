import { cn } from "@/lib/utils";

/**
 * Constrains settings page body copy and cards to two-thirds of the layout
 * container width. Access Tokens keeps full width because its table needs the space.
 * Members uses a slightly wider `className` so the four-column table breathes.
 */
export function SettingsPageContent({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={cn("mx-auto w-2/3", className)}>{children}</div>;
}
