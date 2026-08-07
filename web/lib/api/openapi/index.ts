// Routes use this single public boundary for schemas and document generation.
// Response schemas are exported here too so tests can assert real responses
// against them (drift detection) while going through this module, which loads
// the registry — and thus the Zod OpenAPI extension — before any schema.
// biome-ignore lint/performance/noBarrelFile: This is the package entry point.
export { buildOpenApiDocument } from "./document";
export { readJsonBody } from "./parse";
export { archiveJobDetail, patchArchiveJobBody } from "./schemas/archive";
export {
  createFileBody,
  fileDetail,
  fileDismissed,
  fileReprocessed,
  patchFileBody,
} from "./schemas/files";
export {
  createInstrumentBody,
  instrumentDetail,
  instrumentListItem,
  patchInstrumentBody,
} from "./schemas/instruments";
export {
  attributionsResponse,
  commentBody,
  commentDeleted,
  commentsListResponse,
  createRunBody,
  patchRunBody,
  reportItemsResponse,
  requestUploadBody,
  requestUploadUrlBody,
  runComment,
  runCreated,
  runDeleted,
  runDetail,
  runListResponse,
  runReprocessed,
  runRestored,
  runUpdated,
  uploadAllQueued,
  uploadQueued,
  uploadUrlResponse,
} from "./schemas/runs";
export {
  heartbeatBody,
  registerWatcherBody,
  watcherChecksumResponse,
  watcherConfigBody,
  watcherDeleted,
  watcherDetail,
  watcherEventBody,
  watcherEventCreated,
  watcherEventsListResponse,
  watcherHeartbeatAck,
  watcherHeartbeatsListResponse,
  watcherListResponse,
  watcherRegistered,
  watcherUpdateCheckResponse,
  watcherUploadQueueResponse,
} from "./schemas/watchers";
