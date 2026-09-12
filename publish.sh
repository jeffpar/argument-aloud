#!/bin/bash
set -e

# The generated data trees are no longer copied into sibling repos — they are
# symlinks straight into them:
#   courts/ussc/indexes       -> ../argument-aloud-index/courts/ussc/indexes
#   courts/ussc/journals/xml  -> ../argument-aloud-xml/courts/ussc/journals/xml
#   courts/ussc/opinions/xml  -> ../argument-aloud-xml/courts/ussc/opinions/xml
#   courts/wasc/{indexes,people,terms} -> ../argument-aloud-wasc/courts/wasc/*
# so the scripts write directly into those repos. Only assets/xsl/ is still a
# plain copy (it rarely changes).
sync_xsl() {
  rsync -vcrt -O --delete --exclude=".*" assets/xsl/ ../argument-aloud-xml/assets/xsl/
}

# `git checkout website` (in sync_to_website below) runs in this same working
# tree; if the website branch ever tracks a path under one of these git-ignored
# symlinks, git silently replaces the symlink with a real file/dir. Recreate any
# that went missing. Idempotent — only acts when the path is not already a link.
restore_symlinks() {
  local link target
  while read -r link target; do
    [ -z "$link" ] && continue
    if [ ! -L "$link" ]; then
      rm -rf "$link"
      ln -s "$target" "$link"
      echo "  restored symlink $link -> $target"
    fi
  done <<'EOF'
courts/ussc/indexes		../../../argument-aloud-index/courts/ussc/indexes
courts/ussc/journals/xml	../../../../argument-aloud-xml/courts/ussc/journals/xml
courts/ussc/opinions/xml	../../../../argument-aloud-xml/courts/ussc/opinions/xml
courts/wasc/indexes		../../../argument-aloud-wasc/courts/wasc/indexes
courts/wasc/people		../../../argument-aloud-wasc/courts/wasc/people
courts/wasc/terms		../../../argument-aloud-wasc/courts/wasc/terms
EOF
}

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
  restore_symlinks   # the checkout dance above can clobber the git-ignored data symlinks
  sync_to_website "argument-aloud-index"
  sync_to_website "argument-aloud-xml"
  sync_to_website "argument-aloud-wasc"
else
  node scripts/update_cases.js
  node scripts/update_opinions.js
  sync_xsl
fi
