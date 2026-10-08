---
title: Feedback shows only this Data Hub's reports, and can start the software factory
---

**Settings → Feedback lists only reports sent from this Data Hub.** It used to also list reports sent from other Data Hub sites that share its Linear team, and closing one of those reports in Linear could notify the reporter twice. Data Hub now lists, opens, and sends notifications only for reports sent from its own web address.

**New setting: Start the software factory for new reports.** The software factory is Arcadia's automated system that investigates a bug or request, asks the reporter and an engineer questions, and drafts a code change for engineers to review. Admins find the setting under **Settings → Integrations → Linear**, in step 2 and in the summary. When it is on, each new report gets the **User feedback** label in Linear and a **Reporter email** line in its description, which is what starts the factory on the issue. It is off by default. Turning it on needs a label named **User feedback** in the Linear team, and the page tells you if it is missing. The test report from the setup never starts the factory.
