# Enclave — Standing Instructions for Claude Code

## Deploy workflow (mandatory after every code change)

Claude Code runs in a worktree by default. The user's main branch and GitHub Pages serve from `origin/main`, so worktree edits do nothing visible until merged.

After completing ANY task that modifies files, you MUST:

1. Commit the changes in the worktree with a clear, descriptive message.
2. Switch to the main worktree at `C:\Users\BobbyNacario\Claude\enclave`.
3. Fast-forward merge the worktree branch into main: `git merge <branch> --ff-only`
4. Push: `git push origin main`
5. Report the final commit hash from `git log --oneline -1` on main.

If a fast-forward is not possible (main has diverged), STOP and report — do not force-merge.

## Asset versioning

When changing any file under `src/`, `pages/`, `components/`, `style.css`, or `index.html`:

1. Read current `ASSET_VERSION` from `src/util/constants.js`.
2. Increment by 1 (e.g. v113 → v114).
3. Update `ASSET_VERSION` in `src/util/constants.js`.
4. Update both `?v=NNN` query strings in `index.html` (stylesheet link and app.js script tag) to match.
5. The two locations must always agree. Never roll a version number backward.

## Scope discipline (strict)

The deploy must contain ONLY the files explicitly required by the user's task. Nothing else ships. This applies whether changes are new or pre-existing.

### Rules

1. **One task, one commit, one deploy.** The commit pushed to main contains only files the task required. Do not bundle unrelated work under any "tidying history" rationale.

2. **Pre-existing uncommitted changes do NOT ship.** If `git status` shows modified or untracked files unrelated to the current task, leave them as-is. Do not commit them. Do not stage them. Do not include them in the merge.

3. **Use selective staging, never `git add .` or `git commit -a`.** Stage only the files the current task touched, by explicit path. After staging, run `git diff --cached --stat` and confirm the file list matches the task before committing.

4. **If pre-existing changes block the workflow** (e.g. a rebase or merge needs a clean tree), use `git stash --include-untracked` to set them aside, complete the deploy, then `git stash pop` to restore them as uncommitted. Do NOT commit unrelated work to make the workflow proceed.

5. **Adjacent improvements are notes, not edits.** If you spot a bug or improvement in a file outside scope, mention it at the end of the response. Do not touch the file. Wait to be asked.

6. **No "while I'm here" edits.** No formatting fixes, lint cleanups, comment additions, or import reordering in files outside the explicit task scope.

### Pre-push verification

Immediately before pushing, run `git diff --cached --stat` and `git log -1 --stat`. Confirm:
- Every file listed was explicitly part of the task.
- No unrelated files were swept in.
- If anything looks out of scope, STOP and report rather than push.

If pre-existing uncommitted changes remain in the working tree after deploy, list them in the acceptance report so the user knows they're still there.

## Acceptance reporting

End every task with:
- The list of files changed.
- The final commit hash on main.
- Confirmation that `git status` is clean and `git push` succeeded.
