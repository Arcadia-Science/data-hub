#!/bin/sh
# Ignored Build Step for the web app's Vercel project (Root Directory: web).
# Exit 0 skips the build. Exit 1 runs it.
#
# The docs site lives in docs/ and has its own Vercel project. A push that
# changes only files under docs/ cannot change the web app, so skip it. Any
# other change builds as usual.
#
# Vercel sets VERCEL_GIT_PREVIOUS_SHA to the commit of the last successful
# deployment on this branch. When it is unset, or that commit is not in the
# clone, there is nothing to compare against, so build.

PREVIOUS="${VERCEL_GIT_PREVIOUS_SHA:-}"

if [ -z "$PREVIOUS" ] || ! git cat-file -e "${PREVIOUS}^{commit}" 2>/dev/null; then
  echo "No previous deployment commit to compare against. Building."
  exit 1
fi

# --name-only prints paths relative to the repository root.
if ! CHANGED=$(git diff --name-only "$PREVIOUS" HEAD); then
  echo "git diff failed. Building."
  exit 1
fi

# An empty diff means the tree is identical to the last deployment (for
# example, a redeploy), which should still build.
if [ -z "$CHANGED" ]; then
  echo "No file changes since $PREVIOUS. Building."
  exit 1
fi

if echo "$CHANGED" | grep -qv '^docs/'; then
  echo "Files outside docs/ changed since $PREVIOUS. Building."
  exit 1
fi

echo "Only files under docs/ changed since $PREVIOUS. Skipping the build."
exit 0
