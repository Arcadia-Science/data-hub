---
title: Feedback reports are stored in Linear
---

Sending feedback now creates an issue in your Linear workspace. Data Hub no longer keeps its own copy. Admins still review reports under **Settings → Feedback**, which reads them back from Linear, and members still see only the reports they sent.

**Feedback stays hidden until Linear is set up.** The **Feedback** item in the account menu appears only after an admin saves a Linear team under **Settings → Integrations**. Until then, sending feedback through the API or an AI assistant returns an error that says feedback isn't set up.

**Open in Linear.** The report panel has an **Open in Linear** link to the issue. A report's status follows its Linear issue: a completed issue is **Resolved**, a canceled issue or one closed as a duplicate is **Declined**, and anything else is **Open**.

For API users and AI assistants:

- Each report has a new `linear_issue` field with the issue's `identifier`, `url`, and `state_name`.
- The `admin_note` and `status_updated_by` fields are gone from the REST API, the OpenAPI schema, and the AI assistant tools, because a status is no longer edited in Data Hub. `status_updated_at` stays.
- If Linear can't be reached, sending or listing feedback returns 502 with the code `LINEAR_UNAVAILABLE`. If no team is saved, it returns 503 with `FEEDBACK_NOT_CONFIGURED`.
- Sending the same title again within 24 hours returns the existing report, as before. A report that is already completed, canceled, or closed as a duplicate doesn't count, so the new one is created.
