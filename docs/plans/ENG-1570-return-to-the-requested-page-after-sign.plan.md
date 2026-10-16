---
name: Return to the requested page after sign-in
overview: Remember the address a signed-out visitor asked for, including its query, and send them back to it after they sign in, whether they reached the sign-in screen through the proxy redirect to /login or through the in-page sign-in box. The address is checked to be a path on this site everywhere it is read.
ticket: ENG-1570
repo: data-hub
todos:
  - id: path-helper
    content: Add one shared helper that checks a return address is a path on this site and builds the /login link, with unit tests for the unsafe inputs
    status: pending
  - id: proxy
    content: In web/proxy.ts, add callbackURL to the /login redirect, and on every request that passes through, replace the request-address header with the real path and query
    status: pending
  - id: login-page
    content: Have the /login page read and check callbackURL, ignore it when client_id is present, and pass it to AuthScreen
    status: pending
  - id: sign-in-required
    content: Make SignInRequired async and read the return address from the request header, falling back to the callbackUrl prop
    status: pending
  - id: auth-screen-errors
    content: Check the address in AuthScreen, keep it on failed sign-ins in redirectWithAuthError, and pass errorCallbackURL to signInSocial
    status: pending
  - id: watcher-redirect
    content: Pass the address in the plain redirect to /login in watchers/[watcherId]/page.tsx
    status: pending
  - id: tests
    content: Add unit tests for the proxy redirect and header, and an integration test for the /login redirect against the production build
    status: pending
  - id: changelog
    content: Add a dated changelog entry in web/content/changelog/
    status: pending
  - id: checks
    content: Run unit and integration tests and make check, and sign in by hand from a proxy-gated page, the home page with a query, and a run page with a query
    status: pending
---

## Problem

The ticket says: "`web/proxy.ts` redirects a signed-out visitor to `/login` without remembering the address they asked for, so after signing in they land on the home page. This affects every link, including run pages and changelog entry links (`/?changelog=<id>`). Remember the original path and query (for example in a `callbackURL` that is checked to be a path on this site) and return to it after sign-in."

The code shows two separate causes.

1. **The proxy redirect.** `proxy()` in `web/proxy.ts` builds `new URL("/login", request.url)` and redirects to it without the requested path or query. Only routes that are not on its public lists reach this branch: `/comments`, `/users/[userId]`, `/watchers/[watcherId]`, and any unknown path. The `/login` page (`web/app/(auth)/login/page.tsx`) hardcodes `callbackUrl="/"` and reads no query, so even a passed-in address would be lost.
2. **The in-page sign-in box.** Most pages are public on purpose, so link unfurlers can read their titles: `/`, `/watchers`, `/instruments/...`, `/settings/...`. A signed-out visitor sees `SignInRequired` (`web/components/auth/sign-in-required.tsx`), which renders `AuthScreen` with a `callbackUrl` written into each page:
   - The home page passes `"/"`, so `/?changelog=<id>` (added by the open pull request #320) loses its query.
   - The run page keeps its path but drops its query, such as filters and tabs.
   - The settings layout (`web/app/(app)/settings/layout.tsx`) renders its own box with `"/settings"`, so every `/settings/*` page sends people back to `/settings`.
   - Seven of the pages, and the layout, have no `searchParams` to build the address from.

`AuthScreen` (`web/components/auth/auth-screen.tsx`) uses the address in three places:

- Google sign-in passes it as `callbackURL` to `authInstance.api.signInSocial`.
- Dev sign-in passes it to `signInEmail` and then calls `redirect(callbackUrl)`.
- Both error paths pass it to `redirectWithAuthError` (`web/components/auth/auth-sign-in-error.ts`).

There is also a plain `redirect("/login")` in `web/app/(app)/watchers/[watcherId]/page.tsx`.

Better Auth has its own check on `callbackURL`, in `originCheckMiddleware`. That check returns early when there is no `ctx.request`, which is likely the case for the server-side `authInstance.api.*` calls made here, and the dev path's `redirect()` never goes through Better Auth at all. So the app needs its own check.

## Decisions

No engineer was interviewed. The agent made every decision below. No person has checked them yet.

1. **How pages learn the full address.** Decided by the agent. The proxy adds a request header carrying the path and query. `SignInRequired` becomes `async` and reads it with `headers()`. The proxy removes any copy of the header sent by the client, so a visitor can't supply their own. Set aside: passing `searchParams` through about 15 call sites (this can't reach the settings layout or the seven pages without `searchParams`), and sending the address from the browser as a form field.
2. **Parameter name.** Decided by the agent. `callbackURL` on `/login`, as the ticket suggests. When `client_id` is present, `/login` ignores `callbackURL` so the MCP OAuth resume path still wins. Set aside: `next`.
3. **Path check.** Decided by the agent. One shared helper, used everywhere the value is read: the `/login` page, `AuthScreen`, the proxy and the error helper.
   - It accepts only paths that start with a single `/`.
   - It rejects `//`, `/\`, schemes, backslashes, control characters, and `/login` itself, falling back to `/`.
   - It removes Next's internal `_rsc` parameter.

   Set aside: separate checks at each call site, and relying on Better Auth's origin check.

4. **Places that redirect to `/login`.** Decided by the agent.
   - The proxy redirect adds `callbackURL` with the path and query.
   - The `/login` page reads and checks it in place of the hardcoded `"/"`.
   - The plain `redirect("/login")` in `watchers/[watcherId]/page.tsx` also passes the address.
   - Sign-out stays as it is.

   Set aside: none recorded.

5. **Failed sign-ins.** Decided by the agent. `redirectWithAuthError` keeps `callbackURL` next to `error`. For a failed Google callback, the plan passes a per-request error address to `signInSocial` if Better Auth 1.6.27 supports one; otherwise losing the address there is accepted. The planning agent checked: it is supported (see Approach). Set aside: always sending a bare `/login?error=`.
6. **Signed-in visitors on `/login`.** Decided by the agent. No change: the form still shows, as it does today. Set aside: redirecting them to `callbackURL`, which is outside the ticket.
7. **Ordering with pull request #320.** Decided by the agent. Ship independently. Test with a run-page query and an arbitrary query on `/`. Set aside: waiting for #320 so the changelog link can be tested directly.
8. **Tests.**
   - Decided by the agent.
   - Unit tests (`vitest.unit.config.ts`) cover the path helper and the proxy redirect's `Location`. The helper cases include `//evil.example`, `/\evil.example`, schemes and control characters.
   - An integration test runs against the production build using `api(path, { redirect: "manual" })`, following `web/tests/integration/settings-pages.test.ts`.
   - Set aside: integration tests only.
9. **Release.** Decided by the agent. A dated changelog entry in `web/content/changelog/`. No migration and no watcher version bump. Set aside: none recorded.

## Approach

**1. Shared path helper (new file, for example `web/lib/callback-url.ts`).** `web/lib/auth.ts` is already a file, so the helper can't live under `web/lib/auth/`. It must have no Node-only imports so `web/proxy.ts` can use it. It exports:

- `safeCallbackPath(value)`. It returns the value only when it is a path on this site, and `"/"` otherwise.
  - It rejects an empty or non-string value.
  - It rejects anything that doesn't start with `/`, or that starts with `//` or `/\`.
  - It rejects any backslash, any control character (code points 0–31 and 127), and any scheme. The scheme check parses the value against a fixed placeholder origin and requires the result to keep that origin.
  - It rejects a path of `/login` or anything under it, so sign-in can't loop back to itself.
  - On the accepted value, it removes `_rsc` from the query. It also removes `error`, so a retried sign-in doesn't land on a page that still carries the old error code. Dropping `error` is a detail the agent added; it is not in the decision record.
  - It returns the path plus the remaining query.
- `loginHref(path)`. It returns `/login` when the checked path is `/`, and `/login?callbackURL=<encoded path>` otherwise.
- The name of the request header the proxy sets, as a constant, for example `x-data-hub-request-path`. The exact name is a build-time choice.

**2. Proxy (`web/proxy.ts`).** `config.matcher` stays as it is, so asset paths still skip the proxy.

- Build `requestPath` from `request.nextUrl.pathname` plus `request.nextUrl.search`, passed through `safeCallbackPath`.
- On every request that continues, both the public early return and the signed-in case, return `NextResponse.next({ request: { headers } })`. The headers are a copy of the request headers with the request-address header deleted and then set to `requestPath`. Setting the value after deleting it is what stops a client from sending its own.
- The public early return still doesn't read the session cookie.
- When there is no session cookie, redirect to `new URL(loginHref(requestPath), request.url)` in place of the bare `/login`.
- `/login` is a public route, so a request to it never reaches the redirect branch, and the helper refuses `/login` as a target. Together these rule out a redirect loop.

**3. `/login` page (`web/app/(auth)/login/page.tsx`).**

- Take `searchParams`.
- If `client_id` is present, use `"/"`, which is today's behavior, and leave the OAuth query untouched. Better Auth's `buildSignedOAuthQuery` only forwards signed parameters, so an extra `callbackURL` in that URL can't break the signature either way.
- Otherwise pass `safeCallbackPath(searchParams.callbackURL)` as `callbackUrl` to `AuthScreen`, along with a new prop saying the screen is the `/login` page. The prop lets the error helper know where to send failures.

**4. `SignInRequired` (`web/components/auth/sign-in-required.tsx`).**

- Make it `async`.
- Read the request-address header with `await headers()` and pass `safeCallbackPath(header)` to `AuthScreen`.
- When the header is missing, fall back to the existing `callbackUrl` prop. This covers any render path the proxy didn't touch. The 15 call sites keep their prop as that fallback, so no call site has to change.
- The doc comment on the prop changes to say it is the fallback.

**5. `AuthScreen` and the error helper.**

- In `AuthScreen`, run `callbackUrl` through `safeCallbackPath` once at the top, and use the checked value in both server actions.
- Google sign-in also passes `errorCallbackURL` to `signInSocial`. On the `/login` page that is `loginHref(path)`; for the in-page box it is the page's own address. Better Auth 1.6.27 supports this: `signInSocial` accepts `errorCallbackURL`, stores it in the OAuth state, and the Google callback sends errors there. Better Auth appends `?error=` or `&error=` itself.
- Callback errors that happen before the state can be read still go to `onAPIError.errorURL`, which stays `"/login"`. In that case the address is lost, as accepted in decision 5.
- `redirectWithAuthError(callbackUrl, code, ...)` gains a way to know whether the failure came from the `/login` page.
  - **From `/login`:** go to `/login`, with `callbackURL` when it isn't `"/"`, plus `error`.
  - **From the in-page box:** go back to the page's own address, keeping its query, with `error` added. When that address is `"/"`, go to `/login?error=` as today, so the banner shows on the sign-in screen and not on the signed-out home page.
- `AuthErrorBanner` already reads `error` from the address and needs no change.
- The MCP OAuth client paths in `google-sign-in-button.tsx` and `dev-sign-in-form.tsx` keep omitting `callbackURL`. They don't change.

**6. Watcher detail page (`web/app/(app)/watchers/[watcherId]/page.tsx`).** Replace `redirect("/login")` with `redirect(loginHref(address))`. The address comes from the same request-address header. If the header is missing, build it from the page's `watcherId`.

**7. Changelog.** Add a new file `web/content/changelog/YYYY-MM-DD-return-after-sign-in.md`. The date is the day the pull request merges into `staging`. It has a `title` and a short body saying that signing in now returns you to the page and filters you opened. The format follows the existing entries. No docs-site page describes this flow, so no docs change is expected. `make docs-links` confirms that.

## Risky parts

- **Login flow.** This changes `web/proxy.ts`, the `/login` page, `AuthScreen`, `SignInRequired` and `auth-sign-in-error.ts`, which is the core of the ticket.
  - A weak path check would turn `/login?callbackURL=` into an open redirect, through values like `//evil.example`, `/\evil.example`, `https://…` or tab and newline tricks.
  - That's why all reads go through one helper, and the helper's unit tests are the main safeguard.
  - The dev sign-in path calls Next's `redirect()` directly, so it relies entirely on this helper.
- **The new request header.** The header is trusted by `SignInRequired`. The proxy must always overwrite it, including on public routes. Otherwise a client could plant an address. The helper still checks the value when it is read.
- **MCP OAuth sign-in.** `/login` must ignore `callbackURL` when `client_id` is present, and the client-side OAuth paths must keep omitting `callbackURL`. If they don't, the MCP authorize flow could stop resuming after sign-in.
- **Proxy scope.** The proxy now builds headers on public routes that link unfurlers use. It must keep the `config.matcher` asset exclusions and still return early on public routes without reading the session.
- **`SignInRequired` becomes async.** All of its callers are already async server components, so this should be safe. Calling `headers()` in render does make these pages dynamic, but they already read the session on each request.
- **No other risk areas.** There are no database schema, migration, infrastructure, public REST API, MCP tool or dependency changes.

## Size

Medium. The change touches about seven files in the sign-in path plus one new helper and its tests, but each edit is small. The care needed is in the path check and in keeping the MCP OAuth path working, not in the amount of code. It fits in one pull request; nothing needs to be split out.

## Testing

**Unit tests** (`web/tests/unit/`, `vitest.unit.config.ts`):

- **New `callback-url.test.ts`.** The helper accepts:
  - `/`
  - `/comments?from=2026-10-01`
  - `/instruments/abc/runs/x%2Fy?tab=files`
  - `/?changelog=2026-10-08-some-entry`

  It falls back to `"/"` for:
  - `//evil.example`
  - `/\evil.example`
  - `\\evil.example`
  - `https://evil.example`
  - `javascript:alert(1)`
  - `/%0d%0aevil` when decoded, and raw tab, newline and null characters
  - empty strings and non-strings
  - `/login` and `/login?x=1`

  It also checks that `_rsc` and `error` are removed while other parameters stay in order, and that `loginHref` encodes the path and returns bare `/login` for `"/"`.

- **New `proxy.test.ts`.** Call `proxy()` with a `NextRequest` and check:
  - With no cookie on `/comments?from=x`, the redirect's `Location` is `/login?callbackURL=%2Fcomments%3Ffrom%3Dx`.
  - Unknown paths redirect the same way.
  - Public routes such as `/`, `/instruments/a/runs/b?tab=files` and `/settings/tokens` pass through with the request-address header set to their path and query.
  - A request that already carries a planted header value, such as `//evil.example`, comes out with the real path.
  - `/login`, `/api/v1/...` and `/mcp` pass through unchanged.
- **Error helper.** Cover `redirectWithAuthError` for both surfaces: from `/login`, from an in-page box with a query, and the `"/"` case. Mock `next/navigation`'s `redirect` and read the address it receives.

**Integration test** (`web/tests/integration/`, against `next build` and `next start`). Add a test that follows `settings-pages.test.ts` and uses `api(path, { redirect: "manual" })` with no cookie:

- `/comments?from=2026-10-01` returns a redirect whose `Location` points to `/login?callbackURL=…` with that path and query.
- `/login?callbackURL=//evil.example` renders with status 200 and no error.
- `/login?client_id=x&callbackURL=/comments` renders with status 200.

The in-page box's address is held inside an encrypted server action, so it can't be read from the HTML. The manual check below covers it.

**Manual check** on a seeded local app with dev sign-in:

- Sign out, open `/comments?from=<date>`, sign in, and land back on that address.
- Open `/?any=query` signed out, sign in from the in-page box, and land on `/?any=query`.
- Open a run page with a tab or filter query and confirm the same.
- Open `/settings/tokens` signed out and land back on `/settings/tokens`, not `/settings`.
- Open `/login?callbackURL=//evil.example`, sign in, and land on `/`.
- Force a dev sign-in failure, for example with an unknown email, and confirm the banner shows and the address survives on the retry.

**Checks:** `make check`, plus `make docs-links` for the changelog entry.

## Open questions

- **Which links failed for the reporter.** Nobody asked the reporter. The plan assumes both kinds failed: the proxy-gated pages and the public pages that lost their query. The ticket says "every link, including run pages and changelog entry links".
- **Google callbacks whose state can't be read.** These still go to `onAPIError.errorURL` (`"/login"`) and lose the address. This is accepted.
- **Whether `request.nextUrl` carries `_rsc` on client-side navigations.** The code doesn't show it. The helper removes it either way.
- **Header name.** The exact request-header name is left to the build. The plan only requires that the proxy always overwrites it.
- **Dropping `error` from the return address.** The agent added this; it wasn't in the decision record. An engineer may prefer to keep the query exactly as typed.
