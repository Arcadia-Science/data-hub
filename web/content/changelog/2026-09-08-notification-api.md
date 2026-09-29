---
title: Send notifications to people through the API
docs: https://datahub.arcadiascience.com/docs/api/notifications/dispatchNotifications
---

A new endpoint, `POST /api/v1/notifications/dispatch`, sends a short message to chosen people, with an optional link to a run. It needs a personal access token with the `notifications:create` scope.

Each person’s **Service notifications** setting decides whether the message appears in the bell, as a Slack direct message, or both.
