#!/bin/bash
set -e

rsync -vrt --delete --exclude=".*" courts/ussc/indexes/ ../argument-apart/courts/ussc/indexes/
pushd ../argument-apart > /dev/null
git status
popd > /dev/null

if [ -n "$1" ]; then
  MSG="$1"

  sync_to_website() {
    local repo_name="$1"
    echo "Committing ${repo_name}..."
    git add -A || exit 1
    git commit -m "$MSG" || exit 1
    git push || exit 1
    git checkout website || exit 1
    git merge main --no-edit || exit 1
    git push || exit 1
    git checkout main || exit 1
  }

  sync_to_website "argument-aloud"

  pushd ../argument-apart > /dev/null
  sync_to_website "argument-apart"
  popd > /dev/null
fi
