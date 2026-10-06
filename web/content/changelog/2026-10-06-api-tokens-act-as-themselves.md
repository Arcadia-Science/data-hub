---
title: API tokens now act as themselves
docs: https://datahub.arcadiascience.com/docs/manage-tokens
---

Anything an API token does is now recorded under the token's name, not under a person. That covers comments, deleting a run, retiring an instrument, removing a watcher, and notifications sent through the API. Run pages, instrument pages, watcher pages, comments, and the notification bell show the token's name with a key icon. A revoked token keeps its name and is marked **(revoked)**.

Tokens can still post comments. A token can edit and delete only the comments it posted.

Tokens can no longer claim runs, send feedback, or review feedback. These need a signed-in person, so the `runs:attribute` and `feedback:admin` scopes are gone and have been removed from existing tokens. Signed-in AI assistants are not affected.

Creating a token no longer asks which person it belongs to, and `POST /api/v1/tokens` rejects `user_id`. The **Created by** column on the Tokens page shows who made each token. Tokens created before this change show the person they belonged to.

For API users: a comment's `user` can now be `null`, and comments gain a `token` field that names the token that wrote it. Run responses gain `deleted_by_token`.

Deleting a person no longer disables the tokens they created, because tokens now act as themselves. When someone leaves, an admin should revoke their tokens on the Tokens page. Tokens that already belonged to a deleted person are revoked as part of this change.

Revoking a token now keeps its record, so the name stays visible wherever the token acted. A watcher registered with a revoked token can be taken over by a new token.
