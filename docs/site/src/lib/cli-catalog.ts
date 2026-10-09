import snapshot from "./cli-catalog.snapshot.json";

export type CliParamType = "option" | "argument";

export interface CliCatalogParam {
  choices?: string[];
  default?: boolean | number | string | string[];
  envvar?: string | string[];
  help: string | null;
  isFlag: boolean;
  metavar?: string;
  name: string;
  names: string[];
  paramType: CliParamType;
  required: boolean;
  type: string;
}

export interface CliCatalogCommand {
  commands?: CliCatalogCommand[];
  help: string | null;
  name: string;
  params: CliCatalogParam[];
  path: string[];
}

export interface CliCatalogDocument {
  cliCatalog: string;
  command: CliCatalogCommand;
  prog: string;
  version: string;
}

/** Snapshot committed from data-hub `watcher/cli-catalog.snapshot.json`. */
export function getCliCatalog(): CliCatalogDocument {
  return snapshot as CliCatalogDocument;
}

export function formatParamLabel(param: CliCatalogParam): string {
  if (param.paramType === "argument") {
    return param.name;
  }
  if (param.isFlag || !param.metavar) {
    return param.name;
  }
  return `${param.name} ${param.metavar}`;
}

export function formatInvocation(path: string[]): string {
  return path.join(" ");
}
