---
title: Share changelog entries by link, and ask an AI assistant what changed by date
docs: https://datahub.arcadiascience.com/docs/send-feedback#changelog
---

The Changelog now shows each entry as a title that you select to read. Entries you haven't seen before are marked New and start open, so you can see what changed since your last visit. If none are new, only the newest entry starts open. Select **Copy link** inside an entry to share it. The link opens the Changelog on that entry, on any page.

An AI assistant connected to Data Hub can now list changes by date, so it can answer "what changed this week?" or "what's new since October 1?". It links each entry it mentions. Before, it could only search the changelog by topic, and a question about recent changes often returned entries that merely contained the word "changed".

For AI assistants:

- A new tool, `search_changelog`, lists changelog entries between two dates, or finds them by topic. Each result includes the whole entry and a link to it.
- `search_docs` and `read_doc` now cover the docs pages only. Their results no longer include changelog entries, and `read_doc` no longer accepts `changelog/...` page IDs.
