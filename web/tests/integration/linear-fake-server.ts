import { randomUUID } from "node:crypto";
import http from "node:http";

export const LINEAR_TEAM_ID = "11111111-1111-4111-8111-111111111111";
export const LINEAR_PROJECT_ID = "22222222-2222-4222-8222-222222222222";
export const LINEAR_BUG_LABEL_ID = "33333333-3333-4333-8333-333333333333";
export const LINEAR_FEATURE_LABEL_ID = "44444444-4444-4444-8444-444444444444";
export const LINEAR_OTHER_LABEL_ID = "55555555-5555-4555-8555-555555555555";
// Not tied to any team, so every team's label list includes it.
export const LINEAR_WORKSPACE_LABEL_ID = "66666666-6666-4666-8666-666666666666";
// Belongs to another team, so the fake never returns it for LINEAR_TEAM_ID.
export const LINEAR_OTHER_TEAM_LABEL_ID =
  "77777777-7777-4777-8777-777777777777";

// Client ID and secret that Linear rejects, and a client ID whose app has
// client credentials turned off. Tests send these to cover each failure.
export const LINEAR_BAD_CLIENT_ID = "fail-linear";
export const LINEAR_BAD_CLIENT_SECRET = "wrong-linear-secret";
export const LINEAR_NO_CLIENT_CREDENTIALS_CLIENT_ID = "no-client-credentials";

const LABELS = [
  { id: LINEAR_BUG_LABEL_ID, name: "Bug", teamId: LINEAR_TEAM_ID },
  { id: LINEAR_FEATURE_LABEL_ID, name: "Feature", teamId: LINEAR_TEAM_ID },
  { id: LINEAR_OTHER_LABEL_ID, name: "Other", teamId: LINEAR_TEAM_ID },
  { id: LINEAR_WORKSPACE_LABEL_ID, name: "Triage", teamId: null },
  {
    id: LINEAR_OTHER_TEAM_LABEL_ID,
    name: "Elsewhere",
    teamId: "88888888-8888-4888-8888-888888888888",
  },
];

// Linear's documented default page size and per-query complexity ceiling.
const DEFAULT_PAGE_SIZE = 50;
const MAX_COMPLEXITY = 10_000;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

interface FakeAttachment {
  id: string;
  metadata: Record<string, unknown>;
  title: string;
  url: string;
}

interface FakeIssue {
  archivedAt: string | null;
  attachments: FakeAttachment[];
  canceledAt: string | null;
  completedAt: string | null;
  createAsUser: string | null;
  createdAt: string;
  description: string;
  id: string;
  identifier: string;
  labelIds: string[];
  projectId: string | null;
  state: { name: string; type: string };
  teamId: string | null;
  title: string;
  trashed: boolean;
  updatedAt: string;
  url: string;
}

const issues: FakeIssue[] = [];
const requests: { complexity: number; operation: string }[] = [];
let issueSeq = 1;
let rateLimited = false;
let failAttachments = 0;

// --- A small GraphQL reader -------------------------------------------------
// Real Linear rejects a query that names an unknown field, argument, or
// filter key, and returns only the fields a query selects. Reading the query
// the same way means a typo or a missing field fails here and not in
// production. It supports the subset of GraphQL that Data Hub sends.

interface Field {
  args: Record<string, unknown>;
  name: string;
  selection: Field[] | null;
}

class GraphqlError extends Error {
  readonly extensions: Record<string, unknown>;
  readonly status: number | null;

  constructor(
    message: string,
    options: { extensions?: Record<string, unknown>; status?: number } = {}
  ) {
    super(message);
    this.extensions = options.extensions ?? {
      code: "GRAPHQL_VALIDATION_FAILED",
    };
    this.status = options.status ?? null;
  }
}

class Reader {
  private position = 0;
  private readonly tokens: string[];
  private readonly variables: Record<string, unknown>;

  constructor(source: string, variables: Record<string, unknown>) {
    const text = source.replace(/#.*$/gm, "").replace(/,/g, " ");
    this.tokens =
      text.match(
        /[A-Za-z_]\w*|\$\w+|-?\d+(?:\.\d+)?|"(?:[^"\\]|\\.)*"|[{}()[\]:!=]/g
      ) ?? [];
    this.variables = variables;
  }

  operation(): { fields: Field[]; kind: string; name: string } {
    const kind = this.next();
    let name = "";
    if (/^[A-Za-z_]/.test(this.peek())) {
      name = this.next();
    }
    if (this.peek() === "(") {
      this.skipVariableDefinitions();
    }
    return { kind, name, fields: this.selectionSet() };
  }

  private peek(): string {
    return this.tokens[this.position] ?? "";
  }

  private next(): string {
    const token = this.tokens[this.position];
    if (token === undefined) {
      throw new GraphqlError("Syntax Error: unexpected end of query");
    }
    this.position += 1;
    return token;
  }

  private expect(token: string) {
    const actual = this.next();
    if (actual !== token) {
      throw new GraphqlError(`Syntax Error: expected ${token}, got ${actual}`);
    }
  }

  private skipVariableDefinitions() {
    let depth = 0;
    do {
      const token = this.next();
      if (token === "(") {
        depth += 1;
      } else if (token === ")") {
        depth -= 1;
      }
    } while (depth > 0);
  }

  private selectionSet(): Field[] {
    this.expect("{");
    const fields: Field[] = [];
    while (this.peek() !== "}") {
      fields.push(this.field());
    }
    this.expect("}");
    return fields;
  }

  private field(): Field {
    const name = this.next();
    const args: Record<string, unknown> = {};
    if (this.peek() === "(") {
      this.next();
      while (this.peek() !== ")") {
        const key = this.next();
        this.expect(":");
        args[key] = this.value();
      }
      this.expect(")");
    }
    const selection = this.peek() === "{" ? this.selectionSet() : null;
    return { name, args, selection };
  }

  private value(): unknown {
    const token = this.next();
    if (token.startsWith("$")) {
      return this.variables[token.slice(1)];
    }
    if (token === "{") {
      const object: Record<string, unknown> = {};
      while (this.peek() !== "}") {
        const key = this.next();
        this.expect(":");
        object[key] = this.value();
      }
      this.next();
      return object;
    }
    if (token === "[") {
      const list: unknown[] = [];
      while (this.peek() !== "]") {
        list.push(this.value());
      }
      this.next();
      return list;
    }
    if (token === "true" || token === "false") {
      return token === "true";
    }
    if (token === "null") {
      return null;
    }
    if (token.startsWith('"')) {
      return JSON.parse(token);
    }
    return /^-?\d/.test(token) ? Number(token) : token;
  }
}

// --- Resolvers --------------------------------------------------------------

type Resolvers<T> = Record<string, (source: T, field: Field) => unknown>;

function project<T>(
  source: T,
  field: Field,
  resolvers: Resolvers<T>,
  typeName: string
): Record<string, unknown> {
  if (!field.selection) {
    throw new GraphqlError(
      `Field "${field.name}" of type "${typeName}" must have a selection of subfields.`
    );
  }
  const result: Record<string, unknown> = {};
  for (const child of field.selection) {
    const resolve = resolvers[child.name];
    if (!resolve) {
      throw new GraphqlError(
        `Cannot query field "${child.name}" on type "${typeName}".`
      );
    }
    result[child.name] = resolve(source, child);
  }
  return result;
}

function checkArgs(field: Field, allowed: string[], typeName: string) {
  for (const name of Object.keys(field.args)) {
    if (!allowed.includes(name)) {
      throw new GraphqlError(
        `Unknown argument "${name}" on field "${typeName}.${field.name}".`
      );
    }
  }
}

const CONNECTION_ARGS = [
  "after",
  "before",
  "first",
  "last",
  "includeArchived",
  "orderBy",
];

// Cursors are offsets. Without `first`, Linear returns 50 items.
function connection<T>(
  items: T[],
  field: Field,
  allowedArgs: string[],
  build: (item: T, node: Field) => unknown
): Record<string, unknown> {
  checkArgs(field, [...CONNECTION_ARGS, ...allowedArgs], field.name);
  const first =
    typeof field.args.first === "number" ? field.args.first : DEFAULT_PAGE_SIZE;
  const start =
    typeof field.args.after === "string" ? Number(field.args.after) : 0;
  const page = items.slice(start, start + first);
  const result: Record<string, unknown> = {};
  for (const child of field.selection ?? []) {
    if (child.name === "nodes") {
      result.nodes = page.map((item) => build(item, child));
    } else if (child.name === "pageInfo") {
      result.pageInfo = project(
        { start, first, total: items.length },
        child,
        {
          hasNextPage: (cursor) => cursor.start + cursor.first < cursor.total,
          endCursor: (cursor) => String(cursor.start + cursor.first),
        },
        "PageInfo"
      );
    } else {
      throw new GraphqlError(
        `Cannot query field "${child.name}" on type "${field.name}Connection".`
      );
    }
  }
  return result;
}

function checkOperators(
  value: unknown,
  allowed: string[],
  typeName: string
): Record<string, unknown> {
  const comparator = (value ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(comparator)) {
    if (!allowed.includes(key)) {
      throw new GraphqlError(`Unknown field "${key}" on type "${typeName}".`);
    }
  }
  return comparator;
}

function matchesString(actual: string, comparator: unknown): boolean {
  const { eq, contains } = checkOperators(
    comparator,
    ["eq", "contains"],
    "StringComparator"
  ) as { contains?: string; eq?: string };
  if (eq !== undefined && actual !== eq) {
    return false;
  }
  return contains === undefined || actual.includes(contains);
}

function matchesAttachmentFilter(
  attachment: FakeAttachment,
  filter: unknown
): boolean {
  const { url } = checkOperators(filter, ["url"], "AttachmentFilter");
  return url === undefined || matchesString(attachment.url, url);
}

function matchesIssueFilter(issue: FakeIssue, filter: unknown): boolean {
  const clauses = checkOperators(
    filter,
    [
      "id",
      "title",
      "createdAt",
      "description",
      "state",
      "attachments",
      "and",
      "or",
    ],
    "IssueFilter"
  );
  return Object.entries(clauses).every(([key, value]) => {
    switch (key) {
      case "id": {
        const { in: ids } = checkOperators(
          value,
          ["in"],
          "IssueIDComparator"
        ) as { in?: string[] };
        return ids === undefined || ids.includes(issue.id);
      }
      case "title":
        return matchesString(issue.title, value);
      case "description":
        return matchesString(issue.description, value);
      case "createdAt": {
        const { gte } = checkOperators(value, ["gte"], "DateComparator") as {
          gte?: string;
        };
        return gte === undefined || issue.createdAt >= gte;
      }
      case "state": {
        const { type } = checkOperators(value, ["type"], "WorkflowStateFilter");
        const { nin } = checkOperators(type, ["nin"], "StringComparator") as {
          nin?: string[];
        };
        return !nin?.includes(issue.state.type);
      }
      case "attachments": {
        const { some } = checkOperators(
          value,
          ["some"],
          "AttachmentCollectionFilter"
        );
        return issue.attachments.some((attachment) =>
          matchesAttachmentFilter(attachment, some)
        );
      }
      case "and":
        return (value as unknown[]).every((part) =>
          matchesIssueFilter(issue, part)
        );
      default:
        return (value as unknown[]).some((part) =>
          matchesIssueFilter(issue, part)
        );
    }
  });
}

const attachmentResolvers: Resolvers<FakeAttachment> = {
  id: (attachment) => attachment.id,
  url: (attachment) => attachment.url,
  title: (attachment) => attachment.title,
  metadata: (attachment) => attachment.metadata,
};

const issueResolvers: Resolvers<FakeIssue> = {
  id: (issue) => issue.id,
  identifier: (issue) => issue.identifier,
  url: (issue) => issue.url,
  title: (issue) => issue.title,
  description: (issue) => issue.description,
  createdAt: (issue) => issue.createdAt,
  updatedAt: (issue) => issue.updatedAt,
  completedAt: (issue) => issue.completedAt,
  canceledAt: (issue) => issue.canceledAt,
  archivedAt: (issue) => issue.archivedAt,
  trashed: (issue) => issue.trashed,
  state: (issue, field) =>
    project(
      issue.state,
      field,
      { name: (state) => state.name, type: (state) => state.type },
      "WorkflowState"
    ),
  attachments: (issue, field) =>
    connection(
      issue.attachments.filter((attachment) =>
        matchesAttachmentFilter(attachment, field.args.filter)
      ),
      field,
      ["filter"],
      (attachment, node) =>
        project(attachment, node, attachmentResolvers, "Attachment")
    ),
};

interface Named {
  id: string;
  name: string;
}

const namedResolvers: Resolvers<Named> = {
  id: (item) => item.id,
  name: (item) => item.name,
};

function namedConnection(
  items: Named[],
  field: Field,
  allowedArgs: string[] = []
) {
  return connection(items, field, allowedArgs, (item, node) =>
    project(item, node, namedResolvers, "Node")
  );
}

// Supports the filter the settings screen sends: a team's labels plus the
// workspace labels that belong to no team.
function listIssueLabels(field: Field) {
  checkArgs(field, [...CONNECTION_ARGS, "filter"], "Query.issueLabels");
  const { or } = checkOperators(field.args.filter, ["or"], "IssueLabelFilter");
  const clauses = (or ?? []) as { team?: Record<string, unknown> }[];
  const matched = LABELS.filter((label) =>
    clauses.some(({ team }) => {
      const { id, null: isNull } = checkOperators(
        team,
        ["id", "null"],
        "TeamFilter"
      );
      if (isNull === true) {
        return label.teamId === null;
      }
      const { eq } = checkOperators(id, ["eq"], "IDComparator") as {
        eq?: string;
      };
      return label.teamId !== null && label.teamId === eq;
    })
  );
  return namedConnection(matched, field, ["filter"]);
}

function listIssues(field: Field) {
  checkArgs(field, [...CONNECTION_ARGS, "filter", "sort"], "Query.issues");
  const includeArchived = field.args.includeArchived === true;
  const matched = issues
    .filter((issue) => includeArchived || !issue.archivedAt)
    .filter((issue) => matchesIssueFilter(issue, field.args.filter));
  return connection(matched, field, ["filter", "sort"], (issue, node) =>
    project(issue, node, issueResolvers, "Issue")
  );
}

const queryRoots: Record<string, (field: Field) => unknown> = {
  organization: (field) =>
    project(
      { id: "org-1", name: "Test Org" },
      field,
      namedResolvers,
      "Organization"
    ),
  teams: (field) =>
    namedConnection([{ id: LINEAR_TEAM_ID, name: "Data Hub" }], field),
  team: (field) => {
    checkArgs(field, ["id"], "Query.team");
    // Linear answers an unknown team ID with an "invalid input" error and a
    // 4xx status, not a null team.
    if (field.args.id !== LINEAR_TEAM_ID) {
      throw new GraphqlError("Entity not found", {
        status: 400,
        extensions: {
          type: "invalid input",
          userError: true,
          userPresentableMessage: "Could not find referenced Team.",
        },
      });
    }
    return project(
      { projects: [{ id: LINEAR_PROJECT_ID, name: "Feedback" }] },
      field,
      { projects: (team, node) => namedConnection(team.projects, node) },
      "Team"
    );
  },
  issueLabels: listIssueLabels,
  issues: listIssues,
};

interface IssueCreateInput {
  createAsUser?: string;
  description?: string;
  labelIds?: string[];
  projectId?: string | null;
  teamId?: string;
  title?: string;
}

function createIssue(field: Field) {
  checkArgs(field, ["input"], "Mutation.issueCreate");
  const input = (field.args.input ?? {}) as IssueCreateInput;
  if (input.title === "__fail_linear__") {
    throw new GraphqlError("Linear is down");
  }
  const id = randomUUID();
  const identifier = `DH-${issueSeq++}`;
  const now = new Date().toISOString();
  const issue: FakeIssue = {
    id,
    identifier,
    title: input.title ?? "",
    description: input.description ?? "",
    url: `https://linear.app/test/issue/${identifier}`,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    canceledAt: null,
    archivedAt: null,
    trashed: false,
    state: { name: "Triage", type: "triage" },
    attachments: [],
    createAsUser: input.createAsUser ?? null,
    labelIds: input.labelIds ?? [],
    projectId: input.projectId ?? null,
    teamId: input.teamId ?? null,
  };
  issues.push(issue);
  return project(
    { success: true, issue },
    field,
    {
      success: (payload) => payload.success,
      issue: (payload, node) =>
        project(payload.issue, node, issueResolvers, "Issue"),
    },
    "IssuePayload"
  );
}

interface AttachmentCreateInput {
  issueId?: string;
  metadata?: Record<string, unknown>;
  title?: string;
  url?: string;
}

// Like Linear, a second call with the same issue and URL updates the first
// attachment instead of adding another.
function createAttachment(field: Field) {
  checkArgs(field, ["input"], "Mutation.attachmentCreate");
  const input = (field.args.input ?? {}) as AttachmentCreateInput;
  const issue = issues.find((item) => item.id === input.issueId);
  if (!issue) {
    throw new GraphqlError("Entity not found: Issue");
  }
  if (failAttachments > 0) {
    failAttachments -= 1;
    throw new GraphqlError("Could not attach");
  }
  if (issue.title.startsWith("__fail_attachment__")) {
    throw new GraphqlError("Could not attach");
  }
  const url = input.url ?? "";
  let attachment = issue.attachments.find((item) => item.url === url);
  if (attachment) {
    attachment.title = input.title ?? attachment.title;
    attachment.metadata = input.metadata ?? attachment.metadata;
  } else {
    attachment = {
      id: randomUUID(),
      url,
      title: input.title ?? "",
      metadata: input.metadata ?? {},
    };
    issue.attachments.push(attachment);
  }
  return project(
    { success: true, attachment },
    field,
    {
      success: (payload) => payload.success,
      attachment: (payload, node) =>
        project(payload.attachment, node, attachmentResolvers, "Attachment"),
    },
    "AttachmentPayload"
  );
}

const mutationRoots: Record<string, (field: Field) => unknown> = {
  issueCreate: createIssue,
  attachmentCreate: createAttachment,
};

// Linear charges 0.1 per property and 1 per object, and multiplies a
// connection's children by its page size. This approximates that formula.
function complexityOf(fields: Field[], multiplier: number): number {
  let total = 0;
  for (const field of fields) {
    if (!field.selection) {
      total += 0.1 * multiplier;
    } else if (field.selection.some((child) => child.name === "nodes")) {
      const size =
        typeof field.args.first === "number"
          ? field.args.first
          : DEFAULT_PAGE_SIZE;
      for (const child of field.selection) {
        const children = child.selection ?? [];
        total +=
          child.name === "nodes"
            ? size * multiplier + complexityOf(children, size * multiplier)
            : multiplier + complexityOf(children, multiplier);
      }
    } else {
      total += multiplier + complexityOf(field.selection, multiplier);
    }
  }
  return Math.ceil(total);
}

function runGraphql(
  query: string,
  variables: Record<string, unknown>
): Record<string, unknown> {
  const operation = new Reader(query, variables).operation();
  const complexity = complexityOf(operation.fields, 1);
  // Logged before running, so a failed call still shows up.
  requests.push({ operation: operation.name, complexity });
  if (complexity > MAX_COMPLEXITY) {
    throw new GraphqlError(
      `Query too complex: ${complexity} points, the maximum is ${MAX_COMPLEXITY}.`
    );
  }
  const roots = operation.kind === "mutation" ? mutationRoots : queryRoots;
  const data: Record<string, unknown> = {};
  for (const field of operation.fields) {
    const resolve = roots[field.name];
    if (!resolve) {
      throw new GraphqlError(
        `Cannot query field "${field.name}" on type "${operation.kind === "mutation" ? "Mutation" : "Query"}".`
      );
    }
    data[field.name] = resolve(field);
  }
  return data;
}

function seedIssue(body: Partial<FakeIssue>): FakeIssue {
  const id = body.id ?? randomUUID();
  const now = new Date().toISOString();
  const trashed = body.trashed ?? false;
  return {
    id,
    identifier: body.identifier ?? `DH-${issueSeq++}`,
    title: body.title ?? "Bare issue",
    description: body.description ?? "",
    url: body.url ?? `https://linear.app/test/issue/${id}`,
    createdAt: body.createdAt ?? now,
    updatedAt: body.updatedAt ?? now,
    completedAt: body.completedAt ?? null,
    canceledAt: body.canceledAt ?? null,
    archivedAt: body.archivedAt ?? (trashed ? now : null),
    trashed,
    state: body.state ?? { name: "Triage", type: "triage" },
    attachments: (body.attachments ?? []).map((attachment) => ({
      id: attachment.id ?? randomUUID(),
      title: attachment.title ?? "",
      url: attachment.url,
      metadata: attachment.metadata ?? {},
    })),
    createAsUser: body.createAsUser ?? null,
    labelIds: body.labelIds ?? [],
    projectId: body.projectId ?? null,
    teamId: body.teamId ?? null,
  };
}

// Stands in for api.linear.app. Accepts any client credentials except the
// `LINEAR_BAD_*` and `LINEAR_NO_CLIENT_CREDENTIALS_*` values above.
//
// Test controls, all under `/__test/`:
//   POST reset                    clears issues, request log, and switches
//   GET/POST issues               read or seed issues
//   GET requests                  operation name and complexity per call
//   POST reset-requests           clears only the request log
//   POST rate-limit {enabled}     answers every call with RATELIMITED
//   POST fail-attachments {count} fails the next attachment calls
export function startLinearFakeServer(): Promise<{
  close: () => Promise<void>;
  url: string;
}> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "POST" && url.pathname === "/oauth/token") {
      const params = new URLSearchParams(await readBody(req));
      // The body Linear documents for an app without client credentials.
      if (params.get("client_id") === LINEAR_NO_CLIENT_CREDENTIALS_CLIENT_ID) {
        sendJson(res, 400, {
          error: "Error",
          error_description:
            "Client does not support the client_credentials grant type",
        });
        return;
      }
      // Linear does not document this body; it follows RFC 6749.
      if (
        params.get("client_id") === LINEAR_BAD_CLIENT_ID ||
        params.get("client_secret") === LINEAR_BAD_CLIENT_SECRET
      ) {
        sendJson(res, 401, {
          error: "invalid_client",
          error_description: "Client authentication failed",
        });
        return;
      }
      sendJson(res, 200, {
        access_token: "test-linear-token",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "read,issues:create",
      });
      return;
    }

    if (url.pathname === "/__test/reset" && req.method === "POST") {
      issues.length = 0;
      requests.length = 0;
      issueSeq = 1;
      rateLimited = false;
      failAttachments = 0;
      sendJson(res, 200, { ok: true });
      return;
    }
    if (url.pathname === "/__test/reset-requests" && req.method === "POST") {
      requests.length = 0;
      sendJson(res, 200, { ok: true });
      return;
    }
    if (url.pathname === "/__test/requests" && req.method === "GET") {
      sendJson(res, 200, requests);
      return;
    }
    if (url.pathname === "/__test/rate-limit" && req.method === "POST") {
      rateLimited = (JSON.parse(await readBody(req)) as { enabled: boolean })
        .enabled;
      sendJson(res, 200, { ok: true });
      return;
    }
    if (url.pathname === "/__test/fail-attachments" && req.method === "POST") {
      failAttachments = (JSON.parse(await readBody(req)) as { count: number })
        .count;
      sendJson(res, 200, { ok: true });
      return;
    }
    if (url.pathname === "/__test/issues" && req.method === "GET") {
      sendJson(res, 200, issues);
      return;
    }
    if (url.pathname === "/__test/issues" && req.method === "PATCH") {
      const body = JSON.parse(await readBody(req)) as {
        canceledAt?: string | null;
        completedAt?: string | null;
        id?: string;
        state?: { name: string; type: string };
      };
      const issue = issues.find((item) => item.id === body.id);
      if (!issue) {
        sendJson(res, 404, { error: "missing" });
        return;
      }
      if (body.state) {
        issue.state = body.state;
      }
      if (body.completedAt !== undefined) {
        issue.completedAt = body.completedAt;
      }
      if (body.canceledAt !== undefined) {
        issue.canceledAt = body.canceledAt;
      }
      sendJson(res, 200, { ok: true });
      return;
    }
    if (url.pathname === "/__test/issues" && req.method === "POST") {
      const issue = seedIssue(JSON.parse(await readBody(req)));
      issues.push(issue);
      sendJson(res, 201, { id: issue.id });
      return;
    }

    if (req.method === "POST" && url.pathname === "/graphql") {
      if (!req.headers.authorization?.startsWith("Bearer ")) {
        sendJson(res, 401, { errors: [{ message: "Unauthorized" }] });
        return;
      }
      const parsed = JSON.parse(await readBody(req)) as {
        query?: unknown;
        variables?: Record<string, unknown>;
      };
      const query = typeof parsed.query === "string" ? parsed.query : "";
      if (rateLimited) {
        requests.push({ operation: "RATELIMITED", complexity: 0 });
        sendJson(res, 400, {
          errors: [
            {
              message: "Rate limit exceeded",
              extensions: { code: "RATELIMITED", type: "ratelimited" },
            },
          ],
        });
        return;
      }
      try {
        sendJson(res, 200, {
          data: runGraphql(query, parsed.variables ?? {}),
        });
      } catch (err) {
        if (!(err instanceof GraphqlError)) {
          throw err;
        }
        // Linear answers a query it cannot validate with 400, and a failed
        // mutation with 200 and an `errors` list.
        const isMutation = query.trimStart().startsWith("mutation");
        sendJson(res, err.status ?? (isMutation ? 200 : 400), {
          errors: [{ message: err.message, extensions: err.extensions }],
          data: null,
        });
      }
      return;
    }

    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to start the Linear fake server"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise((done, fail) => {
            server.close((err) => (err ? fail(err) : done()));
          }),
      });
    });
    server.on("error", reject);
  });
}
