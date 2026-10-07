---
title: Feedback follows Linear, and Linear setup is a guided flow
---

The feedback list now shows each report's Linear issue ID, status, label, priority, and assignee. Open and Closed are separate tabs, and a report's detail includes Linear's status changes and comments.

Setting up Linear is four steps: connect the app, choose where reports go, turn on status updates, and send a test report. Data Hub checks the credentials with Linear before it saves them. After setup, the page shows whether updates are arriving and what a reporter sees for each Linear status.

The send form, the report panel, and the Linear issue now use the same field names: **Type**, **Trying to do**, **Error message**, **Tool**, and **Page**. Issues already in Linear keep their old wording.

For API users and AI assistants:

- `list_feedback` and `GET /api/v1/feedback` return reports in the same order as the Feedback page: by Linear status, then newest first. They used to return newest first.
- The `status` filter accepts `open`, `closed`, `resolved`, and `declined`. `counts` has a new `closed` number, and `groups` lists each Linear status with its report count.
- `linear_issue` has new fields: `state_type`, `state_color`, `labels`, `project_name`, and `team_name`. Workspace admins also get `priority`, `priority_label`, and `assignee`.
- `get_feedback` accepts a Linear issue ID such as `ENG-1476` as well as the report ID. For workspace admins it also returns an `activity` list of Linear status changes and comments.
- Members see their own reports without assignee, priority, or activity.
