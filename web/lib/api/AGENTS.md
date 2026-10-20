# REST API

- Routes that watchers or Lambda call use `authorizeToken`, never `authorize`, because a browser session carries every scope. Add each one to `MACHINE_ROUTES` in `web/tests/integration/machine-routes-reject-session.test.ts`.
- For a public endpoint, register its schemas and path under `web/lib/api/openapi/` and import the path module in `web/lib/api/openapi/document.ts`. Without that import, the endpoint is missing from the spec and the docs. Routes that only the web UI uses stay out of OpenAPI.
- A server change that older watchers can't handle goes behind a feature in `WATCHER_FEATURES` in `web/lib/api/watcher-compat.ts`, and keeps the old behavior when the version header is missing. Lab PCs keep running old watcher versions for weeks. Remove the gate once `min_supported_version` reaches it.
- When you change the `lambda` preset in `web/lib/api/scope-catalog.ts`, update `_LAMBDA_PRESET_SCOPES` in `lambda/tests/integration/test_lambda_api.py` to match, and mint a new Lambda token before you deploy.
