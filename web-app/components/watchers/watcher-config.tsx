import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FileText } from "lucide-react";

export function WatcherConfig({ configYaml }: { configYaml: string | null }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Configuration</CardTitle>
      </CardHeader>
      <CardContent>
        {configYaml ? (
          <pre className="overflow-x-auto rounded-md bg-muted p-4 font-mono text-xs leading-relaxed">
            {configYaml}
          </pre>
        ) : (
          <div className="flex flex-col items-center justify-center gap-2 py-8">
            <FileText className="size-6 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              No config pushed yet.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
