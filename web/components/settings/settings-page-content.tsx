/**
 * Constrains settings page body copy and cards to two-thirds of the layout
 * container width. Access Tokens keeps full width because its table needs the space.
 */
export function SettingsPageContent({
  children,
}: {
  children: React.ReactNode;
}) {
  return <div className="mx-auto w-2/3">{children}</div>;
}
