---
name: Escape user text in Slack run, comment and dispatched notifications
overview: Escape every user-supplied string before it goes into a Slack message from Data Hub, in both the message blocks and the plain-text fallback, so comment text, names, run IDs and dispatched messages can no longer create links or mentions. Also encode the instrument ID in the Data Hub link, and turn off Slack's automatic mention parsing in blocks that carry user text.
ticket: ENG-1556
repo: data-hub
size: small
decisions:
  agent: 9
  engineers: 0
todos:
  - id: share-helper
    content: Move escapeMrkdwn to web/lib/slack/mrkdwn.ts so dm.ts, notifications.ts and the runs route can use it
    status: completed
  - id: builders
    content: Escape names, instrument names, run IDs, comment previews and generic message bodies in buildRunCreatedBlocks, buildCommentBlocks and buildGenericBlocks, and set verbatim true on their mrkdwn text objects
    status: completed
  - id: fallback-text
    content: Escape the user strings in the top-level text fallback of every direct message in web/lib/api/notifications.ts, including the feedback-submitted one
    status: completed
  - id: webhook
    content: Escape the instrument name and run ID in the channel webhook text in web/app/api/v1/instruments/[instrumentId]/runs/route.ts
    status: completed
  - id: encode-links
    content: Encode the instrument ID with encodeURIComponent in the Data Hub links built in notifyRunCreated, notifyGeneric and the runs route
    status: completed
  - id: unit-tests
    content: Add web/tests/unit/slack-dm-blocks.test.ts covering escaping, the verbatim flag, an intact Data Hub link and an encoded instrument ID
    status: completed
  - id: integration-tests
    content: Extend the Slack-capturing integration tests with hostile inputs and assert the escaped form arrives in both blocks and text
    status: completed
  - id: changelog
    content: Add a short, neutral changelog entry in web/content/changelog/
    status: completed
  - id: checks
    content: Run make check, make fe-test-unit and make fe-test-integration, and confirm a new test fails without the fix
    status: completed
---

## Problem

The ticket says: "Slack message builders escape feedback titles, but run announcements, comment previews, and generic notification text are inserted into mrkdwn as raw text. A workspace member who can comment, or a token that can create runs or dispatch notifications, can close the formatting and inject links, user mentions, or channel pings into messages sent by the Data Hub Slack app." Recipients then get a message from the trusted Data Hub bot that can contain a disguised link or a channel-wide mention.

In the code, `escapeMrkdwn` in `web/lib/slack/dm.ts` replaces `&`, `<` and `>` with HTML entities. Slack's formatting docs name these three as the only characters that start links and mentions. The helper is private to `dm.ts`, and only the two feedback builders call it. Raw text goes into Slack in these places today:

- `buildCommentBlocks` (`dm.ts`) inserts the author name, instrument name, run ID and comment preview. `notifyComment` in `web/lib/api/notifications.ts` calls it. Comments reach `notifyComment` through `createCommentAndNotify` in `web/lib/api/run-comments.ts`, which the REST comment route and the MCP `add_run_comment` tool share. For a token author, the name shown is the token's name, which its creator chose.
- `buildRunCreatedBlocks` (`dm.ts`) inserts the instrument name and run ID. `notifyRunCreated` calls it.
- `buildGenericBlocks` (`dm.ts`) inserts the sender (token) name and the free-text message. `notifyGeneric` calls it, and `POST /api/v1/notifications/dispatch` calls `notifyGeneric`.
- The channel webhook text in `web/app/api/v1/instruments/[instrumentId]/runs/route.ts`, sent by `sendSlackMessage` in `web/lib/slack.ts`, inserts the instrument name and run ID.

The code shows three more gaps that the ticket doesn't list:

- Every direct message also has a top-level `text` fallback. It appears in phone and desktop notifications, and Slack parses links in it. It is built from raw strings in `notifyRunCreated`, `notifyComment`, `notifyGeneric` and `notifyFeedbackSubmitted`, so even the feedback message, whose blocks are escaped, leaks through it.
- `notifyRunCreated`, `notifyGeneric` and the runs route put the instrument ID into the `<url|label>` Data Hub link without encoding it. Instrument IDs are free-form, so an ID containing `|` or `>` breaks that link. `runCommentHref` in `web/lib/comment-hash.ts` already encodes both IDs.
- Slack turns plain `@here`, `@channel` and `#channel` in block text into live mentions unless the text object has `verbatim: true`. Escaping `<` and `>` doesn't stop that.

## Decisions

The agent made all nine decisions below. No engineer has checked them yet.

1. **Where the escaping happens.** Decided by the agent: make `escapeMrkdwn` available outside `dm.ts`, either by exporting it or by moving it to a small shared module under `web/lib/slack/`. Then call it at the point where each user string goes into mrkdwn. That covers names (including token names), instrument names, run IDs, comment previews and generic message bodies in `buildCommentBlocks`, `buildRunCreatedBlocks` and `buildGenericBlocks`, plus the instrument name and run ID in the webhook text in the runs route. Escaping inside the builders covers both the REST comment route and the MCP `add_run_comment` tool, so neither caller changes. Set aside: escaping at each caller, which makes it easy to miss a path, and adding a new library, which isn't needed.
2. **Plain-text fallback.** Decided by the agent: escape the user strings in the top-level `text` fallback of every direct message, including the feedback-submitted one. Set aside: escaping blocks only, which would leave a working injection path in notifications.
3. **Instrument ID in link URLs.** Decided by the agent: wrap the instrument ID (and the run ID wherever it is in a URL) with `encodeURIComponent` in the links built by `notifyRunCreated`, `notifyGeneric` and the runs route, following `runCommentHref`. Set aside: leaving it for a separate ticket. A bad ID breaks or takes over the one link that is meant to stay raw, so it belongs in this fix.
4. **Mentions in direct messages.** Decided by the agent: set `verbatim: true` on the mrkdwn text objects that carry user text, so Slack doesn't turn plain `@here`, `@channel` or `#channel` into live mentions. Explicit `<url|label>` links, such as the Data Hub link, still render. The cost is that a `#channel` name typed on purpose won't be linked. The webhook and fallback text don't need this, because the code never sends `link_names=1`, and the build must not add it. Set aside: escaping only, which leaves channel-wide pings possible in block text.
5. **Bare URLs in comments.** Decided by the agent: no extra work beyond decisions 1 and 4. Escaping stops disguised `<url|label>` links, which is the phishing case in the ticket. A bare URL shows its real address. Slack's docs say `verbatim: true` also stops bare URLs from being turned into links in those blocks. Bare URLs may stay clickable in the plain-text fallback, and that is accepted. Set aside: showing the preview as `plain_text`, which drops the quote styling and changes more than needed.
6. **Formatting characters (`*`, `_`, `~`, backtick).** Decided by the agent: accept that these still change how a message looks. Slack has no way to escape them, and once `&`, `<` and `>` are escaped they can't create links or mentions. The run-ID code span and the quoted preview stay as they are. Set aside: `plain_text` rendering, or stripping characters from run IDs. Both are bigger changes for a cosmetic problem.
7. **Order of cutting and escaping.** Decided by the agent: cut the comment preview to 240 characters first, then escape it, so an entity such as `&amp;` can't be cut in half. Set aside: none.
8. **Tests.** Decided by the agent: add unit tests for the `dm.ts` builders in a new `web/tests/unit/slack-dm-blocks.test.ts`, and extend the integration tests that capture Slack payloads with hostile inputs. Set aside: integration tests only, which wouldn't test the builders directly.
9. **Changelog.** Decided by the agent: add a short, neutral entry in `web/content/changelog/`, for example "Slack notifications now show comment text, names and run IDs exactly as typed, without turning them into links or mentions." Don't describe how to exploit the old behavior. The repo rules count changed Slack messages as user-visible, and earlier security fixes have been logged (for example `2026-08-24-machine-routes-need-token.md`). Set aside: no entry, or a detailed security write-up.

## Approach

All changes are in `web/`.

- **`web/lib/slack/dm.ts`.**
  - Export `escapeMrkdwn`, or move it to a small module such as `web/lib/slack/mrkdwn.ts` and import it from there. Either works. A separate module keeps `notifications.ts` and the route from importing the direct-message sending code just for the helper.
  - Generalize the comment above it, which mentions only feedback.
  - In `buildRunCreatedBlocks`, `buildCommentBlocks` and `buildGenericBlocks`, escape every user string: names, instrument names, run IDs, the comment preview and the generic message.
  - Add `verbatim: true` to the mrkdwn text objects in all five builders that carry user text, including the two feedback builders.
  - Keep the `\n> ` quoting in the comment preview. Escaping doesn't touch newlines, so the replacement can run on the escaped preview.
  - Leave the URL inside each `<url|label>` link unescaped. It is built by our own code, and decision 3 makes sure the IDs inside it are encoded.
- **`web/lib/api/notifications.ts`.**
  - In `notifyRunCreated` and `notifyGeneric`, build the Data Hub link with `encodeURIComponent(instrumentId)`. The run ID is already encoded there.
  - Escape the user strings in each `text` fallback: the run-created, comment, generic and feedback-submitted ones.
  - The feedback-updated fallback (`body`) is also saved as the in-app notification body. Escape it only on the Slack side, so the stored in-app text stays as it is today.
  - Keep `notifyComment` cutting the preview at 240 characters before the builder escapes it (decision 7).
- **`web/app/api/v1/instruments/[instrumentId]/runs/route.ts`.** Escape `instrument.displayName` and `runId` in the webhook text, and encode `instrumentId` in the link. The HTTP response doesn't change.
- **`web/content/changelog/2026-10-20-<slug>.md`.** One short entry (decision 9). Rename it if it merges into `staging` on a later day.

Callers do not change: the REST and MCP comment paths, the dispatch route, and the in-app notification rows.

## Risky parts

- There are no login, permission, database schema, migration, infrastructure or dependency changes.
- The `POST /api/v1/instruments/{instrumentId}/runs` route is a public API, but only the Slack webhook text it sends changes. Its HTTP request and response stay the same. The dispatch route and the MCP `add_run_comment` tool keep their interfaces and only send different Slack text.
- Text that used to render as Slack formatting, such as a `<@U123>` mention pasted on purpose, will now show as literal text. That is the intended result.
- If escaping is applied too broadly, it could mangle the Data Hub link itself. The unit tests check that the link is still intact.

## Size

Small. The change touches three source files plus tests and a changelog entry, follows an escaping helper that already exists, and fits in one pull request with no need to split.

## Testing

- **New unit tests in `web/tests/unit/slack-dm-blocks.test.ts`.** The unit setup already replaces `@/lib/db`, so the builders can be imported directly. For each builder, the tests will check:
  - Names, instrument names, run IDs, comment previews and generic messages containing `<https://evil.example|reset>`, `<!channel>` and `&` come out as `&lt;`, `&gt;` and `&amp;`.
  - The mrkdwn text objects have `verbatim: true`.
  - The `<…|View in Data Hub>` (or `View comment`) link is intact and is the only `<…>` in the text.
  - A multi-line preview still gets `> ` quoting on each line.
- **Integration tests.** Extend the tests that capture Slack payloads through the capture server in `web/tests/integration/global-setup.ts`. Each extension sends a hostile value and asserts that the escaped form, and not the raw `<…>`, arrives in both `blocks` and `text`:
  - `web/tests/integration/notifications.test.ts`: a run ID and a comment body for the new-run and comment messages, plus an instrument ID containing a character that must be encoded.
  - `web/tests/integration/notification-dispatch.test.ts`: the dispatched message and the token name.
  - `web/tests/integration/slack-channel.test.ts` or `web/tests/integration/instrument-runs.test.ts`: the webhook text for a run ID containing `<` and `>`.
  - The existing assertions use harmless strings and should keep passing.
- **Proving the tests work.** Remove the escaping from one builder, confirm a new test fails, then put it back.
- **Commands.** Run `make check` (and review what it rewrites), `make fe-test-unit` and `make fe-test-integration`. Stop `make dev` before the integration run, because it builds into `web/.next`.

## Open questions

- Nobody asked the reporter whether "keep the Data Hub link as the only raw Slack link" means bare URLs in comments must not be clickable at all. The plan assumes that stopping disguised links and mentions is enough, and that bare URLs may stay clickable in the plain-text fallback.
- The plan relies on Slack's docs saying that `verbatim: true` keeps explicit `<url|label>` links working while turning off automatic link and mention parsing. This hasn't been checked in a live workspace. The reviewer should confirm that the Data Hub link still renders in a real direct message.
