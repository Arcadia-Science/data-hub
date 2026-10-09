#!/bin/sh
# Ignored Build Step for the docs Vercel project (Root Directory: docs/site).
# Exit 0 skips the build. Exit 1 runs it.
#
# The built site depends on files under docs/site and on the shared
# microfrontends config in web/. A push that changes only other files (the web
# app, the Python packages, docs/developer) produces the same site, so skip it.
#
# Vercel sets VERCEL_GIT_PREVIOUS_SHA to the commit of the last successful
# deployment on this branch. When it is unset, or that commit is not in the
# clone (for example, the project's first build after moving repositories),
# there is nothing to compare against, so build.

PREVIOUS="${VERCEL_GIT_PREVIOUS_SHA:-}"

if [ -z "$PREVIOUS" ] || ! git cat-file -e "${PREVIOUS}^{commit}" 2>/dev/null; then
  echo "No previous deployment commit to compare against. Building."
  exit 1
fi

# ':(top)' makes each path relative to the repository root, not to docs/site.
if ! CHANGED=$(git diff --name-only "$PREVIOUS" HEAD -- ':(top)docs/site' ':(top)web/microfrontends.json'); then
  echo "git diff failed. Building."
  exit 1
fi

if [ -n "$CHANGED" ]; then
  echo "Files the docs site depends on changed since $PREVIOUS. Building:"
  echo "$CHANGED"
  exit 1
fi

echo "Nothing the docs site depends on changed since $PREVIOUS. Skipping the build."
exit 0
