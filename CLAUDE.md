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

## Scope discipline

Do not modify files outside the explicit task scope. If you discover a bug or improvement opportunity in an adjacent file, surface it as a note at the end of the response — do not edit it without being asked.

## Acceptance reporting

End every task with:
- The list of files changed.
- The final commit hash on main.
- Confirmation that `git status` is clean and `git push` succeeded.
