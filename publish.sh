#!/bin/bash
set -e

rsync -r --exclude=".*" courts/ussc/indexes/ ../argument-apart/courts/ussc/indexes/

if [ -n "$1" ]; then
  MSG="$1"

  sync_to_website() {
    git add -A
    git diff --cached --quiet || git commit -m "$MSG"
    git push
    git checkout website
    git merge main --no-edit
    git push
    git checkout main
  }

  sync_to_website

  pushd ../argument-apart > /dev/null
  sync_to_website
  popd > /dev/null
fi
