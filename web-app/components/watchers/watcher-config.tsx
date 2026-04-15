import { CodeBlock } from "@/components/code-block";
import { CopyButton } from "@/components/copy-button";
import { FileText } from "lucide-react";

export async function WatcherConfig({
  configYaml,
}: {
  configYaml: string | null;
}) {
  if (!configYaml) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-8">
        <FileText className="size-6 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">No config pushed yet.</p>
      </div>
    );
  }

  return (
    <div className="relative">
      <CopyButton
        value={configYaml}
        size="icon-sm"
        variant="ghost"
        className="absolute top-1.5 right-1.5 z-10 text-muted-foreground"
      />
      <CodeBlock
        code={configYaml}
        lang="yaml"
        className="overflow-x-auto rounded-md bg-muted text-sm [&_pre]:p-4"
      />
    </div>
  );
}
