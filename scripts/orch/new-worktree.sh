#!/usr/bin/env bash
# 为一条泳道创建独立 worktree 并跑基线门禁。
# 用法：./scripts/orch/new-worktree.sh E            → ../wt-E, 分支 feat/E
#       ./scripts/orch/new-worktree.sh B capture    → ../wt-B, 分支 feat/capture
set -euo pipefail

LANE=${1:?用法: new-worktree.sh <lane> [branch-suffix] [base]}
SUFFIX=${2:-$LANE}
BRANCH="feat/${LANE}-${SUFFIX}"
BASE=${3:-integration/capture}

REPO=$(cd "$(dirname "$0")/../.." && pwd)
WT="$(dirname "$REPO")/wt-${LANE}"

git -C "$REPO" rev-parse --verify --quiet "$BASE" >/dev/null \
  || { echo "基线分支 $BASE 不存在，先执行 git branch integration/capture local-runtime"; exit 1; }
[ -e "$WT" ] && { echo "目录已存在：$WT（先 git worktree remove）"; exit 1; }

git -C "$REPO" worktree add -b "$BRANCH" "$WT" "$BASE"
echo "→ $WT  ($BRANCH @ $BASE)"

cd "$WT"
[ -d node_modules ] || npm ci --silent
./scripts/check.sh
echo "✅ 基线通过，可以开工：cd $WT"
