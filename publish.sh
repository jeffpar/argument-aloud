#!/bin/bash
set -e
if [ -n "$1" ]; then
  MSG="$1"
  sync_to_website() {
    local repo_name="$1"
    echo "Committing ${repo_name} main branch..."
    pushd ../$repo_name > /dev/null
    git add -A || exit 1
    git commit -m "$MSG" || exit 1
    git push || exit 1
    echo "Updating ${repo_name} website branch..."
    git checkout website || exit 1
    git merge main --no-edit || exit 1
    git push || exit 1
    git checkout main || exit 1
    popd
  }
  sync_to_website "argument-aloud"
  sync_to_website "argument-aloft"
  sync_to_website "argument-apart"
else
  node scripts/update_cases.js
  node scripts/update_opinions.js
  rsync -vcrt --delete --exclude=".*" courts/ussc/indexes/ ../argument-apart/courts/ussc/indexes/
  rsync -vcrt --delete --exclude=".*" courts/ussc/opinions/xml/ ../argument-aloft/courts/ussc/opinions/xml/
  rsync -vcrt --delete --exclude=".*" assets/xsl/ ../argument-aloft/assets/xsl/
fi
