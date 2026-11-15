import { z } from "zod";
import {
  bearerSecurity,
  errorResponses,
  instrumentIdParam,
  jsonResponse,
  registry,
} from "../registry";
import {
  createInstrumentBody,
  instrumentDetail,
  instrumentListItem,
  instrumentRecord,
  patchInstrumentBody,
} from "../schemas/instruments";

const instrumentParams = z.object({ instrumentId: instrumentIdParam });

registry.registerPath({
  method: "get",
  path: "/instruments",
  operationId: "listInstruments",
  summary: "List instruments",
  description:
    "Requires scope `instruments:read`. Each instrument's `watcher` leaves out `hostname`, `os_info`, `version`, `watch_directory` and `shared_computer_with` unless the token also has `watchers:read`.",
  tags: ["Instruments"],
  security: bearerSecurity,
  responses: {
    200: jsonResponse("Instruments.", z.array(instrumentListItem)),
    ...errorResponses(),
  },
});
registry.registerPath({
  method: "post",
  path: "/instruments",
  operationId: "createInstrument",
  summary: "Create an instrument",
  description:
    "Requires scope `instruments:write`. PAT only; browser sessions are rejected.",
  tags: ["Instruments"],
  security: bearerSecurity,
  request: {
    body: { content: { "application/json": { schema: createInstrumentBody } } },
  },
  responses: {
    201: jsonResponse("Created instrument.", instrumentRecord),
    ...errorResponses(),
  },
});
registry.registerPath({
  method: "get",
  path: "/instruments/{instrumentId}",
  operationId: "getInstrument",
  summary: "Get an instrument",
  description:
    "Requires scope `instruments:read`. The `watcher` leaves out `hostname`, `os_info`, `version`, `watch_directory` and `shared_computer_with` unless the token also has `watchers:read`.",
  tags: ["Instruments"],
  security: bearerSecurity,
  request: { params: instrumentParams },
  responses: {
    200: jsonResponse("Instrument.", instrumentDetail),
    ...errorResponses(),
  },
});
registry.registerPath({
  method: "patch",
  path: "/instruments/{instrumentId}",
  operationId: "updateInstrument",
  summary: "Update an instrument",
  description: "Requires scope `instruments:write`.",
  tags: ["Instruments"],
  security: bearerSecurity,
  request: {
    params: instrumentParams,
    body: { content: { "application/json": { schema: patchInstrumentBody } } },
  },
  responses: {
    200: jsonResponse("Updated instrument.", instrumentRecord),
    ...errorResponses(),
  },
});
