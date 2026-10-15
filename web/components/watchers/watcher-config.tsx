import { FileText } from "lucide-react";
import { CodeBlock } from "@/components/code-block";
import { CopyButton } from "@/components/copy-button";
import { EmptyState } from "@/components/empty-state";

export function WatcherConfig({ configYaml }: { configYaml: string | null }) {
  if (!configYaml) {
    return (
      <EmptyState icon={FileText} size="compact">
        No config pushed yet.
      </EmptyState>
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
