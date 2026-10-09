import { cn } from "@/lib/cn";

interface DataHubLogoProps {
  className?: string;
}

// Duotone hub mark (blue + dark nodes), not the rounded app-icon tile. Dark
// nodes flip to white in dark mode so the mark stays legible on sidebar/nav.
export function DataHubLogo({ className }: DataHubLogoProps) {
  return (
    <svg
      aria-hidden
      className={cn("shrink-0", className)}
      viewBox="6 6 88 88"
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>Data Hub</title>
      <g fill="none" stroke="#5088C5" strokeLinecap="round" strokeWidth="4">
        <line x1="50" x2="82" y1="50" y2="50" />
        <line x1="50" x2="34" y1="50" y2="22.3" />
        <line x1="50" x2="34" y1="50" y2="77.7" />
      </g>
      <circle
        className="fill-[#09090A] dark:fill-white"
        cx="66"
        cy="22.3"
        r="7"
      />
      <circle
        className="fill-[#09090A] dark:fill-white"
        cx="18"
        cy="50"
        r="7"
      />
      <circle
        className="fill-[#09090A] dark:fill-white"
        cx="66"
        cy="77.7"
        r="7"
      />
      <circle cx="82" cy="50" fill="#5088C5" r="7" />
      <circle cx="34" cy="22.3" fill="#5088C5" r="7" />
      <circle cx="34" cy="77.7" fill="#5088C5" r="7" />
      <circle cx="50" cy="50" fill="#5088C5" r="11" />
    </svg>
  );
}
