# Shared Python library

Read `docs/developer/shared-library.md` and `docs/developer/testing.md` before you change this package.

- Code the watcher needs at runtime can't live here, because the watcher installs this package only for its tests.
- The token helpers in `packages/shared/src/data_hub_shared/testing.py` must produce the same tokens as `web/lib/tokens.ts`.
- The `Instrument` enum holds display names. Lambda picks a processor by `instrument_type` in `lambda/src/data_hub_lambda/processors.py`.
