import { FileText } from "lucide-react";
import { CodeBlock } from "@/components/code-block";
import { CopyButton } from "@/components/copy-button";

export async function WatcherConfig({
  configYaml,
}: {
  configYaml: string | null;
}) {
  if (!configYaml) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed bg-background py-8 dark:bg-muted">
        <FileText className="size-6 text-muted-foreground" />
        <p className="text-muted-foreground text-sm">No config pushed yet.</p>
      </div>
    );
  }

  return (
    <div className="relative">
      <CopyButton
        className="absolute top-1.5 right-1.5 z-10 text-muted-foreground"
        size="icon-sm"
        value={configYaml}
        variant="ghost"
      />
      <CodeBlock
        className="overflow-x-auto rounded-md border bg-background text-sm dark:bg-muted [&_pre]:p-4"
        code={configYaml}
        lang="yaml"
      />
    </div>
  );
}
