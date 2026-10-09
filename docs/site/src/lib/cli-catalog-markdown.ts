import {
  type CliCatalogCommand,
  type CliCatalogDocument,
  type CliCatalogParam,
  formatInvocation,
  formatParamLabel,
  getCliCatalog,
} from "@/lib/cli-catalog";

function formatParam(param: CliCatalogParam): string {
  const parts = [`\`${formatParamLabel(param)}\``];
  if (param.required) {
    parts.push("(required)");
  }
  let typeLine = param.type;
  if (param.choices?.length) {
    typeLine += ` (${param.choices.join(" | ")})`;
  }
  if (param.default !== undefined) {
    typeLine += ` · default ${String(param.default)}`;
  }
  parts.push(`\`${typeLine}\``);
  if (param.envvar) {
    const env = Array.isArray(param.envvar)
      ? param.envvar.join(", ")
      : param.envvar;
    parts.push(`env: \`${env}\``);
  }
  const head = `- ${parts.join(" ")}`;
  return param.help ? `${head} — ${param.help}` : head;
}

function formatParamSections(params: CliCatalogParam[]): string {
  if (params.length === 0) {
    return "";
  }

  const args = params.filter((param) => param.paramType === "argument");
  const flags = params.filter((param) => param.paramType === "option");
  const sections: string[] = [];

  if (args.length > 0) {
    sections.push(`**Arguments**\n\n${args.map(formatParam).join("\n")}`);
  }
  if (flags.length > 0) {
    sections.push(`**Flags**\n\n${flags.map(formatParam).join("\n")}`);
  }

  return sections.length > 0 ? `\n\n${sections.join("\n\n")}` : "";
}

function formatLeafCommand(command: CliCatalogCommand, depth: number): string {
  const hashes = "#".repeat(Math.min(depth, 6));
  const heading = `${hashes} \`${formatInvocation(command.path)}\``;
  const help = command.help ? `\n\n${command.help}` : "";
  return `${heading}${help}${formatParamSections(command.params)}`;
}

function formatCommandGroup(command: CliCatalogCommand, depth: number): string {
  const hashes = "#".repeat(Math.min(depth, 6));
  const heading = `${hashes} \`${formatInvocation(command.path)}\``;
  const help = command.help ? `\n\n${command.help}` : "";
  const groupParams = formatParamSections(command.params);
  const children = (command.commands ?? [])
    .map((child) =>
      child.commands && child.commands.length > 0
        ? formatCommandGroup(child, depth + 1)
        : formatLeafCommand(child, depth + 1)
    )
    .join("\n\n");

  return `${heading}${help}${groupParams}\n\n${children}`;
}

export function cliCatalogMarkdown(
  catalog: CliCatalogDocument = getCliCatalog()
): string {
  const root = catalog.command;
  const global = `## Global flags\n\nThese options apply to every \`${catalog.prog}\` command (watcher ${catalog.version}).${formatParamSections(root.params)}`;

  const commands = (root.commands ?? [])
    .map((command) =>
      command.commands && command.commands.length > 0
        ? formatCommandGroup(command, 2)
        : formatLeafCommand(command, 2)
    )
    .join("\n\n");

  return `${global}\n\n${commands}`;
}
