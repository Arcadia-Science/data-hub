---
title: Data Hub now asks before changing admin roles, disconnecting Slack, or removing the Slack webhook
---

Granting or removing admin access, disconnecting Slack, and removing the Slack channel webhook now open a confirmation window first. These used to happen on a single click.

Deleting an access token already asked first. The confirmation window now stays open with a spinner while the request runs, so a failed request leaves you where you were instead of closing as if it worked.

If you have unsaved changes in your notification settings, the Slack credentials, the watcher release form, or a comment, your browser now asks before you reload the page or close the tab.
