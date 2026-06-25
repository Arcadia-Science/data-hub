import { buttonVariants } from "fumadocs-ui/components/ui/button";
import {
  ArrowRight,
  KeyRound,
  MonitorUp,
  RefreshCw,
  Workflow,
} from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/cn";

const features = [
  {
    title: "Install a watcher",
    description:
      "Run the watcher agent on a lab instrument PC to automatically upload new files as they appear.",
    href: "/docs/installing-a-watcher",
    icon: MonitorUp,
  },
  {
    title: "Manage API tokens",
    description:
      "Create, use, and revoke personal access tokens for authenticating with the Data Hub REST API.",
    href: "/docs/managing-tokens",
    icon: KeyRound,
  },
  {
    title: "Add an instrument",
    description:
      "Onboard a new instrument end to end: watcher setup, activation, and optional processing.",
    href: "/docs/adding-an-instrument",
    icon: Workflow,
  },
  {
    title: "Upgrade the watcher",
    description:
      "Keep instrument PCs current with self-update and the managed release channel.",
    href: "/docs/upgrading-the-watcher",
    icon: RefreshCw,
  },
];

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col">
      <section className="flex flex-col items-center gap-6 px-4 py-24 text-center">
        <span className="rounded-full border px-3 py-1 text-fd-muted-foreground text-sm">
          Lab instrument data, automatically ingested
        </span>
        <h1 className="max-w-3xl font-bold text-4xl tracking-tight sm:text-5xl">
          Install and configure Data Hub
        </h1>
        <p className="max-w-2xl text-fd-muted-foreground text-lg">
          Data Hub ingests, processes, and visualizes data from laboratory
          instruments. Set up the watcher agent, manage access, and onboard new
          instruments with these guides.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Link
            className={cn(
              buttonVariants({ variant: "primary" }),
              "gap-2 px-5 py-2.5 text-base",
            )}
            href="/docs/installing-a-watcher"
          >
            Install the watcher
            <ArrowRight className="size-4" />
          </Link>
          <Link
            className={cn(
              buttonVariants({ variant: "secondary" }),
              "px-5 py-2.5 text-base",
            )}
            href="/docs"
          >
            Browse the docs
          </Link>
        </div>
      </section>

      <section className="mx-auto grid w-full max-w-5xl grid-cols-1 gap-4 px-4 pb-24 sm:grid-cols-2">
        {features.map((feature) => (
          <Link
            className="flex flex-col gap-3 rounded-xl border bg-fd-card p-6 transition-colors hover:bg-fd-accent"
            href={feature.href}
            key={feature.href}
          >
            <feature.icon className="size-6 text-fd-muted-foreground" />
            <h2 className="font-semibold text-lg">{feature.title}</h2>
            <p className="text-fd-muted-foreground text-sm">
              {feature.description}
            </p>
          </Link>
        ))}
      </section>
    </main>
  );
}
