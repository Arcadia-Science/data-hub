import { buttonVariants } from "fumadocs-ui/components/ui/button";
import {
  ArrowRight,
  FlaskConical,
  LayoutDashboard,
  Rocket,
  Server,
} from "lucide-react";
import Link from "next/link";
import { DataHubLogo } from "@/components/data-hub-logo";
import { DocsImage } from "@/components/docs-image";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockFilename,
  CodeBlockHeader,
  CodeBlockTitle,
} from "@/components/ui/code";
import { cn } from "@/lib/cn";
import homeImage from "../../../../public/images/home.png";
import mcpImage from "../../../../public/images/mcp.png";
import runDetailImage from "../../../../public/images/plate-reader-run-details-1.png";

const features = [
  {
    title: "Deploy Data Hub",
    description:
      "Run the backend yourself: database, web app, and AWS infrastructure.",
    audience: "Engineers",
    href: "/docs/self-hosting",
    icon: Server,
  },
  {
    title: "Set up an instrument",
    description:
      "Take a new instrument PC from a fresh install to uploading runs.",
    audience: "Operators and admins",
    href: "/docs/set-up-an-instrument",
    icon: Rocket,
  },
  {
    title: "Browse and analyze runs",
    description:
      "Find runs, inspect processed results, claim work, download files, and leave lab notes.",
    audience: "Everyone",
    href: "/docs/browse-runs",
    icon: LayoutDashboard,
  },
  {
    title: "Instrument data preprocessing",
    description:
      "What each supported instrument's processor extracts and shows on run detail.",
    audience: "Everyone",
    href: "/docs/instrument-preprocessing",
    icon: FlaskConical,
  },
];

const homeShot = {
  src: homeImage,
  alt: "Data Hub home dashboard with instrument status and recent runs",
} as const;

const runDetailShot = {
  src: runDetailImage,
  alt: "Data Hub run detail with plate map visualization and comments",
} as const;

const mcpShot = {
  src: mcpImage,
  alt: "Claude Desktop asking Data Hub about microscope runs over MCP",
} as const;

const webAppHighlights = [
  "Filter by instrument, measurement type, date, or who ran it",
  "Read plate maps, kinetic traces, and images without downloading anything",
  "Claim a run to put your name on it, and leave notes in its comment thread",
  "Download one file, or the whole run as a ZIP",
] as const;

const apiHighlights = [
  "Authenticate with a token you create in the app, scoped and revocable",
  "List instruments, runs, and files, and filter runs the way the app does",
  "Pull instrument runs as ZIP archives",
] as const;

const mcpHighlights = [
  "Connect Claude Code, Claude Desktop, or Cursor by pasting one URL",
  "Ask which runs failed last week, then pull the files you need",
  "Sign in from the client, so the agent acts with your own permissions",
] as const;

const downloadLatestRunCode = `import time, requests

BASE = "https://datahub.example.com/api/v1"

session = requests.Session()
session.headers["Authorization"] = "Bearer dhub_your_token_here"

# Pick an active instrument and its latest run.
instruments = session.get(f"{BASE}/instruments").json()
iid = next(i["id"] for i in instruments if i["status"] == "active")

runs = session.get(f"{BASE}/instruments/{iid}/runs", params={"per_page": 1}).json()
run_id = runs["data"][0]["run_id"]

# Download the run as a ZIP. On a cache miss the archive builds async, so poll until ready.
url = f"{BASE}/instruments/{iid}/runs/{run_id}/download-archive"
archive = session.get(url, headers={"Accept": "application/json"}).json()

while archive["status"] != "ready":
    time.sleep(2)
    archive = session.get(url, headers={"Accept": "application/json"}).json()

# download_url is a short-lived presigned S3 link and needs no auth.
data = requests.get(archive["download_url"])

with open(f"{run_id}.zip", "wb") as f:
    f.write(data.content)

print(f"Saved {run_id}.zip")
`;

function HighlightList({ items }: { items: readonly string[] }) {
  return (
    <ul className="divide-y border-fd-border border-y">
      {items.map((item) => (
        <li
          className="flex gap-3 py-3.5 text-fd-muted-foreground text-sm leading-relaxed"
          key={item}
        >
          <span
            aria-hidden="true"
            className="mt-2 size-1.5 shrink-0 rounded-full bg-fd-muted-foreground/70"
          />
          {item}
        </li>
      ))}
    </ul>
  );
}

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col">
      <section className="mx-auto flex w-full max-w-348 flex-col items-center gap-8 px-4 py-16 lg:flex-row lg:items-center lg:gap-12 lg:py-12">
        <div className="flex w-full flex-col items-center gap-6 text-center lg:w-2/5 lg:shrink-0 lg:items-start lg:text-left">
          <DataHubLogo className="size-16" />
          <h1 className="font-bold text-4xl tracking-tight sm:text-5xl">
            Lab instrument data, instantly accessible
          </h1>
          <p className="text-fd-muted-foreground text-lg">
            Data Hub automatically captures and uploads lab instrument data,
            enabling scientists to focus on analyzing data rather than managing
            it.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3 lg:justify-start">
            <Link
              className={cn(
                buttonVariants({ variant: "primary" }),
                "gap-2 px-5 py-2.5 text-base"
              )}
              href="/docs/set-up-an-instrument"
            >
              Get started
              <ArrowRight className="size-4" />
            </Link>
            <Link
              className={cn(
                buttonVariants({ variant: "secondary" }),
                "px-5 py-2.5 text-base"
              )}
              href="/docs/overview"
            >
              Browse the docs
            </Link>
          </div>
        </div>

        <div className="w-full min-w-0 overflow-hidden rounded-xl border bg-fd-card shadow-sm lg:w-3/5">
          <DocsImage
            alt={runDetailShot.alt}
            preload
            sizes="(max-width: 1024px) 100vw, 64rem"
            src={runDetailShot.src}
          />
        </div>
      </section>

      <section className="border-fd-border border-y">
        <div className="mx-auto flex w-full max-w-348 flex-col items-center gap-10 px-4 py-16 lg:flex-row lg:items-center lg:gap-16 lg:py-20">
          <div className="w-full min-w-0 overflow-hidden rounded-xl border bg-fd-card shadow-sm lg:w-1/2">
            <DocsImage
              alt={homeShot.alt}
              sizes="(max-width: 1024px) 100vw, 40rem"
              src={homeShot.src}
            />
          </div>

          <div className="flex w-full flex-col gap-5 lg:w-1/2">
            <div className="flex flex-col gap-3">
              <h2 className="font-bold text-3xl tracking-tight sm:text-4xl">
                Download instrument runs from your browser
              </h2>
              <p className="text-base text-fd-muted-foreground leading-relaxed">
                Find a run by instrument, date, or who ran it. Open it to check
                the settings it ran with, read its plate maps and images right
                in the page, and download the files you need. Put your name on
                it so people know it was yours, and leave a note for whoever
                picks it up next.
              </p>
            </div>

            <HighlightList items={webAppHighlights} />

            <Link
              className="inline-flex items-center gap-1.5 font-semibold text-fd-foreground transition-colors hover:text-fd-primary"
              href="/docs/browse-runs"
            >
              Web app guide
              <ArrowRight className="size-4" />
            </Link>
          </div>
        </div>
      </section>

      <section className="mx-auto flex w-full max-w-348 flex-col items-center gap-10 px-4 py-16 lg:flex-row lg:items-center lg:gap-16 lg:py-20">
        <div className="flex w-full flex-col gap-5 lg:w-1/2">
          <div className="flex flex-col gap-3">
            <h2 className="font-bold text-3xl tracking-tight sm:text-4xl">
              Automate your data processing workflows
            </h2>
            <p className="text-base text-fd-muted-foreground leading-relaxed">
              Let your pipelines do the heavy lifting. They can check an
              instrument for its newest run, download the files, and pass them
              straight into the analysis you already run. Put it on a schedule
              and last night's plates are counted before you get in.
            </p>
          </div>

          <HighlightList items={apiHighlights} />

          <Link
            className="inline-flex items-center gap-1.5 font-semibold text-fd-foreground transition-colors hover:text-fd-primary"
            href="/docs/api"
          >
            API reference
            <ArrowRight className="size-4" />
          </Link>
        </div>

        <div className="dark w-full min-w-0 overflow-hidden rounded-xl border shadow-sm lg:w-1/2">
          <CodeBlock
            className="rounded-none border-0 bg-fd-background [&>div:last-child]:max-h-80"
            code={downloadLatestRunCode}
            language="python"
          >
            <CodeBlockHeader className="relative">
              <CodeBlockTitle>
                <span aria-hidden="true" className="flex items-center gap-1.5">
                  <span className="size-2.5 rounded-full bg-[#ff5f57]" />
                  <span className="size-2.5 rounded-full bg-[#febc2e]" />
                  <span className="size-2.5 rounded-full bg-[#28c840]" />
                </span>
              </CodeBlockTitle>
              <CodeBlockFilename className="pointer-events-none absolute inset-x-0 text-center">
                download_latest_run.py
              </CodeBlockFilename>
              <CodeBlockActions>
                <CodeBlockCopyButton />
              </CodeBlockActions>
            </CodeBlockHeader>
          </CodeBlock>
          <div className="space-y-1 border-fd-border border-t bg-fd-background px-4 py-3 font-mono text-fd-muted-foreground text-sm">
            <p>
              <span className="text-emerald-500">$</span> python
              download_latest_run.py
            </p>
            <p className="text-fd-foreground">
              Saved 260710_OD595_kinetic_EEE.zip
            </p>
            <p>
              <span className="text-emerald-500">$</span>
              <span
                aria-hidden="true"
                className="ml-1 inline-block h-3.5 w-1.5 translate-y-0.5 bg-fd-foreground"
              />
            </p>
          </div>
        </div>
      </section>

      <section className="border-fd-border border-y">
        <div className="mx-auto flex w-full max-w-348 flex-col items-center gap-10 px-4 py-16 lg:flex-row lg:items-center lg:gap-16 lg:py-20">
          <div className="w-full min-w-0 overflow-hidden rounded-xl border bg-fd-card shadow-sm lg:w-1/2">
            <DocsImage
              alt={mcpShot.alt}
              sizes="(max-width: 1024px) 100vw, 40rem"
              src={mcpShot.src}
            />
          </div>

          <div className="flex w-full flex-col gap-5 lg:w-1/2">
            <div className="flex flex-col gap-3">
              <h2 className="font-bold text-3xl tracking-tight sm:text-4xl">
                Let AI agents work with your data
              </h2>
              <p className="text-base text-fd-muted-foreground leading-relaxed">
                Ask an agent about a run and it can find the one you mean,
                download its files, and start working on the data, without you
                leaving the conversation to go and fetch anything.
              </p>
            </div>

            <HighlightList items={mcpHighlights} />

            <Link
              className="inline-flex items-center gap-1.5 font-semibold text-fd-foreground transition-colors hover:text-fd-primary"
              href="/docs/mcp"
            >
              MCP setup
              <ArrowRight className="size-4" />
            </Link>
          </div>
        </div>
      </section>

      <section className="mx-auto grid w-full max-w-348 grid-cols-1 gap-4 px-4 py-16 pb-24 sm:grid-cols-2">
        {features.map((feature) => (
          <Link
            className="flex flex-col gap-2 rounded-xl border p-6 transition-colors hover:bg-fd-accent"
            href={feature.href}
            key={feature.href}
          >
            <feature.icon className="size-6 text-fd-muted-foreground" />
            <p className="font-medium text-fd-muted-foreground text-xs">
              {feature.audience}
            </p>
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
