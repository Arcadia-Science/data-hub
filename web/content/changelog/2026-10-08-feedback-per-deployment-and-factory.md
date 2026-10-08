---
title: Each Data Hub shows only its own feedback, and feedback can start the software factory
---

**Each Data Hub shows only the reports it filed.** Production and staging share a Linear team, so each one used to list the other's reports under **Settings → Feedback**, and closing a report in Linear could notify its reporter from both. A deployment now lists, opens, and sends notifications for only its own reports.

**New setting: Start the software factory for new reports.** Admins find it under **Settings → Integrations → Linear**, in step 2 and in the summary. When it is on, each new report gets the **User feedback** label in Linear and a **Reporter email** line in its description, which is what starts the software factory on the issue. It is off by default, so staging and preview deployments never start it. Turning it on needs a label named **User feedback** in the Linear team, and the page tells you if it is missing. The test report from the setup never starts the factory.
