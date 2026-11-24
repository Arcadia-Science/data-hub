import { Client } from "@modelcontextprotocol/client";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import {
  InMemoryTransport,
  McpServer,
  Server,
} from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildMcpCatalogDocument } from "@/lib/mcp/catalog";
import {
  toolRegistrationConfig,
  withOpenOutputSchemas,
} from "@/lib/mcp/catalog/register";

// A client keeps the tool list it fetched when it connected and checks every
// later result against it. These tests play a client that connected before a
// release: it holds the old list, and the server answers in the new shape.

type JsonSchema = Record<string, unknown>;
type ListedTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];

const WRONG_SHAPE =
  /Structured content does not match the tool's output schema/;

// The output as it was when the client connected.
const outputV1 = z.object({
  id: z.string(),
  status: z.enum(["queued", "done"]),
  owner: z.object({ name: z.string() }),
  items: z.array(z.object({ kind: z.enum(["tube", "plate"]) })),
});

// What a later release sends: a new field at the top and in a nested object,
// and a new value in two enums.
const payloadV2 = {
  id: "thing-1",
  status: "archived",
  label: "extra",
  owner: { name: "Test User", team: "extra" },
  items: [{ kind: "rack", capacity: 4 }],
};

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

async function connect(server: McpServer | Server): Promise<Client> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

/** The tool list a real server sends for `outputV1`, as a client receives it. */
async function listFromRealServer(): Promise<ListedTool[]> {
  const server = new McpServer(
    { name: "data-hub-test", version: "0.0.0" },
    { capabilities: { tools: {} } }
  );
  server.registerTool(
    "get_thing",
    toolRegistrationConfig({
      title: "Get Thing",
      description: "Return a thing.",
      outputSchema: outputV1,
    }),
    () => ({
      content: [{ type: "text" as const, text: "{}" }],
      structuredContent: {},
    })
  );
  const client = await connect(server);
  return (await client.listTools()).tools;
}

/**
 * A client that fetched `tools` earlier and now calls `get_thing`, which
 * answers with `payload`.
 */
async function staleClient(
  tools: ListedTool[],
  payload: Record<string, unknown>
): Promise<Client> {
  const server = new Server(
    { name: "data-hub-test", version: "0.0.0" },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler("tools/list", () => ({ tools }));
  server.setRequestHandler("tools/call", () => ({
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent: payload,
  }));
  const client = await connect(server);
  await client.listTools();
  return client;
}

describe("a client that holds an older tool list", () => {
  it("accepts extra fields and new enum values in the tool's answer", async () => {
    const client = await staleClient(await listFromRealServer(), payloadV2);

    const result = await client.callTool({ name: "get_thing", arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual(payloadV2);
  });

  it("rejects the same answer when the list comes from plain Zod JSON Schema", async () => {
    const closed: ListedTool = {
      name: "get_thing",
      inputSchema: { type: "object", properties: {} },
      outputSchema: z.toJSONSchema(outputV1, {
        target: "draft-2020-12",
        io: "output",
      }) as ListedTool["outputSchema"],
    };
    const client = await staleClient([closed], payloadV2);

    await expect(
      client.callTool({ name: "get_thing", arguments: {} })
    ).rejects.toThrow(WRONG_SHAPE);
  });

  it("still rejects an answer that breaks the schema it holds", async () => {
    const wrongType = { ...payloadV2, id: 7 };
    const missing = { status: "done", owner: { name: "x" }, items: [] };
    for (const payload of [wrongType, missing]) {
      const client = await staleClient(await listFromRealServer(), payload);
      await expect(
        client.callTool({ name: "get_thing", arguments: {} })
      ).rejects.toThrow(WRONG_SHAPE);
    }
  });

  it("is told the known enum values, with any other string allowed", async () => {
    const [tool] = await listFromRealServer();
    const properties = (tool.outputSchema as { properties: JsonSchema })
      .properties as Record<string, JsonSchema>;
    expect(properties.status).toEqual({
      anyOf: [{ type: "string", enum: ["queued", "done"] }, { type: "string" }],
    });
    expect(JSON.stringify(tool.outputSchema)).not.toContain(
      '"additionalProperties":false'
    );
  });
});

describe("the server", () => {
  it("still checks an answer against the closed Zod schema", async () => {
    const server = new McpServer(
      { name: "data-hub-test", version: "0.0.0" },
      { capabilities: { tools: {} } }
    );
    server.registerTool(
      "get_thing",
      toolRegistrationConfig({
        title: "Get Thing",
        description: "Return a thing.",
        outputSchema: outputV1,
      }),
      () => ({
        content: [{ type: "text" as const, text: "{}" }],
        // `status` is not one of the values `outputV1` lists.
        structuredContent: payloadV2,
      })
    );
    const client = await connect(server);
    await client.listTools();

    const result = await client.callTool({ name: "get_thing", arguments: {} });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/Output validation error/);
  });

  it("opens the output schema of a tool registered with withOpenOutputSchemas", async () => {
    const server = new McpServer(
      { name: "data-hub-test", version: "0.0.0" },
      { capabilities: { tools: {} } }
    );
    const wrapped = withOpenOutputSchemas(server);
    wrapped.registerTool(
      "with_output",
      { description: "Has an output schema.", outputSchema: outputV1 },
      () => ({
        content: [{ type: "text" as const, text: "{}" }],
        structuredContent: {},
      })
    );
    wrapped.registerTool(
      "without_output",
      { description: "Has none." },
      () => ({ content: [{ type: "text" as const, text: "ok" }] })
    );
    const client = await connect(server);

    const { tools } = await client.listTools();

    const withOutput = tools.find((t) => t.name === "with_output");
    expect(JSON.stringify(withOutput?.outputSchema)).not.toContain(
      '"additionalProperties":false'
    );
    expect(
      tools.find((t) => t.name === "without_output")?.outputSchema
    ).toBeUndefined();
  });
});

// The client compiles each listed output schema with its Ajv validator, so
// compile every catalog schema the same way and check that sample answers pass.
function sampleFor(schema: JsonSchema): unknown {
  if ("const" in schema) {
    return schema.const;
  }
  const members = (schema.oneOf ?? schema.anyOf) as JsonSchema[] | undefined;
  if (members) {
    return sampleFor(members.find((m) => m.type !== "null") ?? members[0]);
  }
  if (Array.isArray(schema.enum)) {
    return schema.enum[0];
  }
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const type = types.find((t) => t !== "null") ?? "null";
  switch (type) {
    case "object":
      return Object.fromEntries(
        Object.entries(
          (schema.properties ?? {}) as Record<string, JsonSchema>
        ).map(([name, property]) => [name, sampleFor(property)])
      );
    case "array":
      return schema.items ? [sampleFor(schema.items as JsonSchema)] : [];
    case "string":
      if (schema.format === "uuid") {
        return "11111111-1111-4111-a111-111111111111";
      }
      if (schema.format === "date-time") {
        return "2026-01-01T00:00:00.000Z";
      }
      return "text";
    case "integer":
    case "number":
      return Math.max(
        typeof schema.minimum === "number" ? schema.minimum : 0,
        0
      );
    case "boolean":
      return false;
    default:
      return null;
  }
}

function collectUnions(
  node: unknown,
  tool: string,
  found: Array<{ tool: string; members: JsonSchema[] }>
): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      collectUnions(item, tool, found);
    }
    return;
  }
  if (typeof node !== "object" || node === null) {
    return;
  }
  const record = node as JsonSchema;
  if (Array.isArray(record.oneOf)) {
    found.push({ tool, members: record.oneOf as JsonSchema[] });
  }
  for (const value of Object.values(record)) {
    collectUnions(value, tool, found);
  }
}

describe("the published output schemas", () => {
  const validator = new AjvJsonSchemaValidator();
  const { tools } = buildMcpCatalogDocument();

  it("compile with the client's validator and accept a sample answer", () => {
    for (const tool of tools) {
      const validate = validator.getValidator(tool.outputSchema);
      const result = validate(sampleFor(tool.outputSchema));
      expect(result.valid, `${tool.name}: ${result.errorMessage}`).toBe(true);
    }
  });

  it("accept an extra field added to each sample answer", () => {
    for (const tool of tools) {
      const sample = sampleFor(tool.outputSchema) as Record<string, unknown>;
      const validate = validator.getValidator(tool.outputSchema);
      const result = validate({ ...sample, addedLater: true });
      expect(result.valid, `${tool.name}: ${result.errorMessage}`).toBe(true);
    }
  });

  it("still tell the members of each oneOf apart", () => {
    const unions: Array<{ tool: string; members: JsonSchema[] }> = [];
    for (const tool of tools) {
      collectUnions(tool.outputSchema, tool.name, unions);
    }
    expect(new Set(unions.map((u) => u.tool))).toEqual(
      new Set(["get_run_archive", "delete_files", "restore_files"])
    );
    for (const { tool, members } of unions) {
      const validators = members.map((member) =>
        validator.getValidator(member)
      );
      for (const [index, member] of members.entries()) {
        // A member also gets an extra field, as a later release may add one.
        const answer = {
          ...(sampleFor(member) as Record<string, unknown>),
          addedLater: true,
        };
        const matching = validators
          .map((validate, i) => (validate(answer).valid ? i : -1))
          .filter((i) => i >= 0);
        expect(matching, `${tool} member ${index}`).toEqual([index]);
      }
    }
  });
});
