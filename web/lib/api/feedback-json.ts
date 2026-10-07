import type { FeedbackItem } from "@/lib/api/feedback";
import type { FeedbackStateGroup } from "@/lib/linear/feedback-link";

function person(value: FeedbackItem["reporter"]) {
  if (!value) {
    return null;
  }
  return { id: value.id, name: value.name, email: value.email };
}

export function serializeFeedbackGroup(group: FeedbackStateGroup) {
  return {
    state_id: group.stateId,
    name: group.name,
    color: group.color,
    type: group.type,
    count: group.count,
  };
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
    reporter: person(item.reporter),
    status_updated_at: item.statusUpdatedAt?.toISOString() ?? null,
    created_at: item.createdAt.toISOString(),
    updated_at: item.updatedAt.toISOString(),
    linear_issue: {
      identifier: item.linearIssue.identifier,
      url: item.linearIssue.url,
      state_name: item.linearIssue.stateName,
      state_type: item.linearIssue.stateType,
      state_color: item.linearIssue.stateColor,
      priority: item.linearIssue.priority,
      priority_label: item.linearIssue.priorityLabel,
      labels: item.linearIssue.labels.map((label) => ({
        name: label.name,
        color: label.color,
      })),
      assignee: item.linearIssue.assignee
        ? {
            name: item.linearIssue.assignee.name,
            email: item.linearIssue.assignee.email,
            avatar_url: item.linearIssue.assignee.avatarUrl,
            user_id: item.linearIssue.assignee.userId,
          }
        : null,
      project_name: item.linearIssue.projectName,
      team_name: item.linearIssue.teamName,
    },
    activity: item.activity
      ? item.activity.map((event) => ({
          kind: event.kind,
          at: event.at,
          actor_name: event.actorName,
          from_state: event.fromState,
          to_state: event.toState,
          body: event.body,
        }))
      : null,
  };
}
