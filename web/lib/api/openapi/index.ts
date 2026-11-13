// Routes use this single public boundary for schemas and document generation.
// Response schemas are exported here too so tests can assert real responses
// against them (drift detection) while going through this module, which loads
// the registry — and thus the Zod OpenAPI extension — before any schema.
// biome-ignore lint/performance/noBarrelFile: This is the package entry point.
export { buildOpenApiDocument } from "./document";
export { readJsonBody } from "./parse";
export { archiveJobDetail, patchArchiveJobBody } from "./schemas/archive";
export { watcherStatusSchema } from "./schemas/common";
export {
  createFileBody,
  fileDetail,
  fileDismissed,
  fileReprocessed,
  multipartAbortBody,
  multipartAbortResponse,
  multipartCompleteBody,
  multipartCompleteResponse,
  multipartPartUrlsBody,
  multipartPartUrlsResponse,
  patchFileBody,
} from "./schemas/files";
export {
  createInstrumentBody,
  instrumentDetail,
  instrumentListItem,
  patchInstrumentBody,
} from "./schemas/instruments";
export {
  dispatchNotificationsBody,
  dispatchNotificationsResult,
} from "./schemas/notifications";
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
  runQueuedCancelled,
  runReprocessed,
  runRestored,
  runUpdated,
  uploadAllQueued,
  uploadQueued,
  uploadUrlResponse,
} from "./schemas/runs";
export {
  createWatcherConfigRevisionBody,
  heartbeatBody,
  registerWatcherBody,
  watcherChecksumResponse,
  watcherConfigBody,
  watcherConfigPreviewBody,
  watcherConfigPreviewResponse,
  watcherConfigPushResponse,
  watcherConfigRevision,
  watcherConfigRevisionResultBody,
  watcherConfigRevisionsListResponse,
  watcherConfigSettings,
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
