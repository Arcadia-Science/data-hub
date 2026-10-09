import {
  CatalogEntry,
  CatalogEntryBody,
  CatalogEntryDescription,
  CatalogEntryFieldGroup,
  CatalogEntryHeader,
  CatalogEntryName,
  CatalogSection,
} from "@/components/mcp/catalog-shared";
import { Badge } from "@/components/ui/badge";
import {
  type CliCatalogCommand,
  type CliCatalogParam,
  formatInvocation,
  formatParamLabel,
  getCliCatalog,
} from "@/lib/cli-catalog";

function RequiredBadge() {
  return <span className="font-medium text-fd-error text-xs">required</span>;
}

function EnvVarBadge({ children }: { children: string }) {
  return (
    <Badge
      className="border-fd-border bg-fd-foreground/10 font-mono text-fd-foreground"
      variant="outline"
    >
      {children}
    </Badge>
  );
}

function normalizeEnvvars(envvar: CliCatalogParam["envvar"]): string[] {
  if (!envvar) {
    return [];
  }
  if (Array.isArray(envvar)) {
    return envvar;
  }
  return [envvar];
}

function paramTypeLine(param: CliCatalogParam): string {
  let line = param.type;
  if (param.choices) {
    line += ` (${param.choices.join(" | ")})`;
  }
  if (param.default === undefined) {
    return line;
  }
  return `${line} · default ${String(param.default)}`;
}

function CliParamItem({ param }: { param: CliCatalogParam }) {
  const envvars = normalizeEnvvars(param.envvar);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-baseline gap-2">
        <code className="font-medium font-mono text-fd-foreground text-sm">
          {formatParamLabel(param)}
        </code>
        {param.required ? <RequiredBadge /> : null}
        {envvars.map((env) => (
          <EnvVarBadge key={env}>{env}</EnvVarBadge>
        ))}
      </div>
      <code className="font-mono text-fd-info text-xs opacity-80">
        {paramTypeLine(param)}
      </code>
      {param.help ? (
        <p className="text-fd-muted-foreground text-sm leading-relaxed">
          {param.help}
        </p>
      ) : null}
    </div>
  );
}

function CliParamGroup({
  label,
  params,
}: {
  label: string;
  params: CliCatalogParam[];
}) {
  if (params.length === 0) {
    return null;
  }

  return (
    <CatalogEntryFieldGroup label={label}>
      <div className="flex flex-col gap-4">
        {params.map((param) => (
          <CliParamItem
            key={`${param.paramType}:${param.name}`}
            param={param}
          />
        ))}
      </div>
    </CatalogEntryFieldGroup>
  );
}

function CliParamList({ params }: { params: CliCatalogParam[] }) {
  if (params.length === 0) {
    return null;
  }

  const args = params.filter((param) => param.paramType === "argument");
  const flags = params.filter((param) => param.paramType === "option");

  return (
    <>
      <CliParamGroup label="Arguments" params={args} />
      <CliParamGroup label="Flags" params={flags} />
    </>
  );
}

function CliNamedCommandCard({ command }: { command: CliCatalogCommand }) {
  const id = command.path.join("-");
  const hasParams = command.params.length > 0;

  return (
    <CatalogEntry>
      <CatalogEntryHeader>
        <CatalogEntryName id={`${id}-cmd`}>
          {formatInvocation(command.path)}
        </CatalogEntryName>
      </CatalogEntryHeader>
      <CatalogEntryBody>
        {command.help ? (
          <CatalogEntryDescription>{command.help}</CatalogEntryDescription>
        ) : null}
        {hasParams ? <CliParamList params={command.params} /> : null}
      </CatalogEntryBody>
    </CatalogEntry>
  );
}

function CliParamsCard({ command }: { command: CliCatalogCommand }) {
  if (command.params.length === 0) {
    return null;
  }

  return (
    <CatalogEntry>
      <CatalogEntryBody>
        <CliParamList params={command.params} />
      </CatalogEntryBody>
    </CatalogEntry>
  );
}

function CliCommandGroup({ command }: { command: CliCatalogCommand }) {
  const children = command.commands ?? [];
  const id = command.path.join("-");

  return (
    <CatalogSection id={id} title={formatInvocation(command.path)}>
      {command.help ? (
        <p className="text-fd-muted-foreground text-sm leading-relaxed">
          {command.help}
        </p>
      ) : null}
      {command.params.length > 0 ? (
        <CatalogEntry>
          <CatalogEntryBody>
            <CliParamList params={command.params} />
          </CatalogEntryBody>
        </CatalogEntry>
      ) : null}
      <div className="flex flex-col gap-4">
        {children.map((child) =>
          child.commands && child.commands.length > 0 ? (
            <CliCommandGroup command={child} key={child.name} />
          ) : (
            <CliNamedCommandCard command={child} key={child.name} />
          )
        )}
      </div>
    </CatalogSection>
  );
}

/**
 * Renders the watcher Click CLI surface from the committed catalog snapshot.
 * Keep this a server component: the snapshot is static and needs no client JS.
 */
export function WatcherCliCatalog() {
  const catalog = getCliCatalog();
  const root = catalog.command;
  const topLevel = root.commands ?? [];

  return (
    <div className="not-prose flex flex-col gap-10">
      <CatalogSection id="global-flags" title="Global flags">
        <p className="text-fd-muted-foreground text-sm leading-relaxed">
          These options apply to every{" "}
          <code className="font-mono text-fd-info">{catalog.prog}</code> command
          (watcher {catalog.version}).
        </p>
        <CatalogEntry>
          <CatalogEntryBody>
            <CliParamList params={root.params} />
          </CatalogEntryBody>
        </CatalogEntry>
      </CatalogSection>

      {topLevel.map((command) =>
        command.commands && command.commands.length > 0 ? (
          <CliCommandGroup command={command} key={command.name} />
        ) : (
          <CatalogSection
            id={command.path.join("-")}
            key={command.name}
            title={formatInvocation(command.path)}
          >
            {command.help ? (
              <p className="text-fd-muted-foreground text-sm leading-relaxed">
                {command.help}
              </p>
            ) : null}
            <CliParamsCard command={command} />
          </CatalogSection>
        )
      )}
    </div>
  );
}
