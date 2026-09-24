import type { FeedbackItem } from "@/lib/api/feedback";

function person(value: FeedbackItem["reporter"]) {
  if (!value) {
    return null;
  }
  return { id: value.id, name: value.name, email: value.email };
}

export function serializeFeedback(item: FeedbackItem) {
  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    description: item.description,
    attempted_action: item.attemptedAction,
    tool_name: item.toolName,
    error_message: item.errorMessage,
    source: item.source,
    oauth_client_id: item.oauthClientId,
    oauth_client_name: item.oauthClientName,
    page_url: item.pageUrl,
    status: item.status,
    admin_note: item.adminNote,
    reporter: person(item.reporter),
    status_updated_by: person(item.statusUpdatedBy),
    status_updated_at: item.statusUpdatedAt?.toISOString() ?? null,
    created_at: item.createdAt.toISOString(),
    updated_at: item.updatedAt.toISOString(),
  };
}
