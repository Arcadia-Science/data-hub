---
title: Feedback status can no longer be changed in Data Hub
---

Admins can no longer change the status of a feedback report from Data Hub. The status form is gone from **Settings → Feedback**, and reports can still be read there.

For API users and AI assistants:

- `PATCH /api/v1/feedback/{id}` no longer exists. Requests to it now return 404.
- The `update_feedback` tool is no longer available to AI assistants.
- Sending, listing, and reading feedback work as before.

Reporters no longer get a "feedback updated" notification when an admin changes a status, because admins can no longer change one. Report status will come from Linear instead.
