#!/bin/bash
set -e
if [ -n "$1" ]; then
  MSG="$1"
  sync_to_website() {
    local repo_name="$1"
    echo
    echo "Committing ${repo_name} main branch..."
    pushd ../$repo_name > /dev/null
    git add -A || exit 1
    git commit -m "$MSG" || echo "  (nothing to commit)"
    git push || exit 1
    echo
    echo "Updating ${repo_name} website branch..."
    git checkout website || exit 1
    git merge main --no-edit || exit 1
    git push || exit 1
    git checkout main || exit 1
    popd
  }
  sync_to_website "argument-aloud"
  sync_to_website "argument-aloud-xml"
  sync_to_website "argument-aloud-index"
else
  node scripts/update_cases.js
  node scripts/update_opinions.js
  rsync -vcrt -O --delete --exclude=".*" courts/ussc/indexes/ ../argument-aloud-index/courts/ussc/indexes/
  rsync -vcrt -O --delete --exclude=".*" courts/ussc/opinions/xml/ ../argument-aloud-xml/courts/ussc/opinions/xml/
  rsync -vcrt -O --delete --exclude=".*" assets/xsl/ ../argument-aloud-xml/assets/xsl/
fi
