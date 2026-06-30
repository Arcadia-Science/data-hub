export function RunSectionHeading({
  title,
  countLabel,
}: {
  title: string;
  countLabel?: string | number;
}) {
  return (
    <h2 className="font-semibold text-sm">
      {countLabel == null ? title : `${title} (${countLabel})`}
    </h2>
  );
}
