# User guide

Persistent file and line-range review notes inside **Herdr App**. A Rust engine
owns Git reads, anchoring and storage; a thin JavaScript mod draws the native
panel. Uses **herdr-core (`hc`)**, never the older Herdr TUI plugin system.

Supports branch-wide review, syntax coloring and
GitHub review threads and GitLab merge request discussions with explicit replies. No commit controls or full-file editor.

![Inline review note in Herdr App](../preview.png)

## Requirements

- macOS or Linux, Git, Rust stable (edition 2024).
- Herdr App with the current mod interface (`TextareaState` support).
- GitHub CLI (`gh`) authenticated on the app machine for GitHub threads.
- GitLab CLI (`glab`) authenticated on the app machine for GitLab merge
  request discussions.
- `hc` on the Mac/app machine's PATH for remote repos and feedback delivery.
- Existing connected core machines for remote work. Remote hosts need only Git
  and their existing core, not this binary or mod.
- Node.js 22+ for JavaScript tests; Python 3 for the development installer/tests.
- Optional: OpenCode V2 or Pi on the app machine, with a configured model/auth,
  for **Order logically**. Click **AI: OpenCode / Pi** to switch runners.
  OpenCode inherits the local source chat's model and reasoning variant when
  its title and checkout identify one root session. Click **Source chat ▾** to
  override the ordering model without changing the chat or global default.
  Remote, missing, or ambiguous source sessions require an explicit choice.
  Pi uses its own configured model and runs
  locally through `hc exec`, without tools, saved sessions, extensions, MCP,
  skills, prompt templates, context files, or project-local approval.
  Each ordering click makes one tool-free request with changed paths and bounded
  diff samples, including SSH checkout content. No working-chat messages or
  retained conversation; normal model costs apply. No automatic runner fallback.
  Supports 2–200 changed files; malformed/stale results leave the order unchanged.
  **Reset order** restores Git order. The open file and drafts stay in place.

## Build and install locally

```sh
cargo test --locked
npm test
python3 scripts/install.py
```

The installer builds the release binary, runs `herdr-app check`, installs
`~/.local/bin/herdr-annotator` and copies the mod to
`~/.config/herdr-app/mods/annotator`. Installed copies are used because Herdr
may not watch changes through an external development symlink. Rerun the
installer after source edits. It refuses unrelated installs or locally modified
installed source files; reconcile those changes first. Reinstalls preserve
timestamped backups. No layout, key,
agent, branch or terminal changes by default.

To use the existing Changes panel in a **personal** layout:

```sh
python3 scripts/install.py --layout task-groups
```

The usual **Changes** button then opens Annotator, beside the current chat.
The adjacent **↗** opens full review directly, without opening the sidebar.
Setup installs a private `annotator-tabs` copy based on the shipped tabs mod;
shipped files stay untouched. Rerun with the same `--layout` to update it.
Unsupported tabs versions and locally edited private copies are refused.
This opt-in backs up the layout. Shipped layouts are refused. Herdr hot reloads
mod/layout changes; no service restart. `HERDR_APP_HOME` selects another app home.

Use **↗** in Changes to open a full review tab. This pins the source checkout/chat
and handles sidebar visibility. A bare `tab.new --mod annotator` does not supply
that source binding or enable the full presentation.

## Review

1. Open the review beside a Git checkout. The panel follows its space and live
   terminal folder. A separate review tab uses a terminal folder from its space.
2. Select a changed file. Click a source line; **Shift-click** extends a range
   on the same old/new side. Deletions use old lines; additions/context use new
   lines. The range label shows which side was selected.
3. Write a multiline note and click **Save comment**. **Whole file** clears the range.
    A line comment spans at most 200 consecutive visible source lines.
    **⌘Enter / Ctrl+Enter** in the composer saves a nonempty draft without sending it;
    plain Enter still inserts a newline.
4. Saved comments appear beneath their anchor. **Code** shows the diff; **Comments**
   lists every saved note across files. Cards show their range and status:
   **Ready to send**, **Outdated**, **Sent**, **Check delivery**, or **Resolved**.
   File badges show comment counts; outdated comments stay visible but are excluded
   from sending. The footer explains why Send is disabled instead of hiding them.
5. **Resolve** hides a note from exports/delivery; **Reopen** makes it pending
   again. Unfinished comments stay in memory per checkout, file and comparison.
   Switching files or scopes does not require saving/cancelling first; return
   to restore the text and anchor. Changed code requires reselection before
   saving. Closing/reloading loses unsaved drafts, not saved comments.
6. **Export** shows selectable feedback text without sending anything.
   With no unfinished comments in the current comparison, **⌘Enter / Ctrl+Enter**
   sends the saved review and general note. This works in either review view,
   including from the empty comment composer or general-note field. A press that
   saves a comment never also sends the batch. Unfinished replies/ref pickers
   keep their own keyboard behavior. Normal delivery guards still apply.
7. The panel binds automatically to the **open agent session in the current tab**.
    Click **Send review** once. It immediately submits the saved batch using
   `hc send --if idle` or `hc send --if working`, including Enter; there is no
   second confirmation. A working agent may queue or act on the message;
   Annotator does not promise which behavior the agent implements.
   Never submits automatically or uses `--force`. No real agent receives test
   text during development checks.

The footer identifies the bound session and its status. Focusing the composer
keeps the last focused chat from that tab. With multiple chats, focus the intended
one first; another tab is never chosen automatically. Each click resolves the
current chat again. Idle and working sessions can receive reviews. Blocked,
unknown, and unreported sessions cannot receive them.

An ordinary folder outside Git shows a neutral **Not a Git checkout** state,
not an error. With no folder selected, the panel asks you to select a checkout.
**Refresh** checks again, including after initializing Git in the same folder.
Drafts stay in memory; stale review actions stay unavailable until a checkout
loads successfully. Permission, repository corruption, and connection failures
still appear as errors.

An unreachable machine shows a connection error with **Retry**, **Machines…**
and optional technical **Details**, not an empty checkout. The last loaded diff
stays visible in that panel, marked cached; review actions pause until a fresh
snapshot succeeds. Retry preserves drafts and requires line reselection if the
code changed while disconnected. Known-offline machines skip automatic Git
requests; an explicit Retry still probes the connection.

The helper rechecks the target's machine, live/reported status and actual Git
checkout before sending. The core enforces the observed idle/working status
again at submission. A race to a different status fails without a forced retry.
There is no atomic core operation combining checkout verification with send;
avoid changing the target's folder/process during delivery.

Confirmed notes remain visible as **Sent** and cannot be sent twice by accident.
After a confirmed Send, the app focuses the exact recipient session's pane/tab.
Failed or uncertain delivery never changes focus; a closed recipient is not
replaced with another chat.
A failed/lost send is **Delivery uncertain**: check the target before explicitly
requeuing the note. Delivery does not imply the agent completed or accepted the
requested code changes. Notes are never auto-resolved.

For a pinned panel, pass mod props:

```json
{
  "scope": { "repo": "/home/me/project", "machine": "server" },
  "space": "server/<space-id>",
  "tab": "server/<source-agent-tab-id>"
}
```

Use `machine: null` locally. IDs come from `herdr-app ls`; never guess them.
Optional `helper` overrides the local binary path for development.
Optional `file` chooses the initially selected changed file.
Optional `view: "comments"` starts on the comments list instead of Code.

The file list can collapse to give more room to the diff. Filenames and folders
are separate, with added/deleted-line counts. Clicking source lines highlights
the selected range and labels the bordered comment composer. Saving adds a note
to the review; the separate full-width Send action submits the saved batch.

### Comparison, context and section sizes

- **Uncommitted** compares HEAD with staged, unstaged and untracked work.
- **Branch** compares the base branch's merge-base with the current worktree,
  including committed, staged, unstaged and untracked changes. **Base…** lists
   local and remote-tracking refs. You can also type `develop`,
   `origin/develop`, or another available ref and press Enter / **Compare**.
   Nothing fetches automatically. A failed base lookup does not disable switching
   to Last commit or Uncommitted.
  **Auto** compares the merge-bases of local `develop` and `origin/develop`,
  choosing the closer branch point to HEAD (local wins ties). A stale local ref
  no longer adds upstream changes to the review. Without local `develop`, the remote-default
  fallback applies. Picking a named ref pins it; choosing Auto clears that pin.
  Legacy saved `origin/develop` defaults are reset to Auto. Other saved custom
  refs stay pinned. Notes remain stored under their original comparison/base.
- All changed filenames are listed, with no 100-file cutoff. The selected file
  and files with saved comments load their diffs on demand. Line counts shown
  beside loaded files describe the visible preview, not unloaded files.
  The native file list builds only visible rows, so large lists do not exhaust
  Herdr's JavaScript render budget.
- Drag the dividers between the file list, code/comments and composer. Sizes
  persist across reloads. The file list can still collapse.
- **+20 context** expands unchanged lines around every hunk in the selected
  file. **Full context** requests the whole file, subject to preview limits;
  **Collapse** returns to three context lines. Unchanged lines accept comments.
  Saved anchors are validated with their original context even when collapsed.

The sidebar header has three rows: title/branch with **↗** and Refresh, view tabs,
then **Files** with a comparison dropdown and branch base. No duplicate scope caption.

### Full review tab

Click **↗** beside Changes to open a standalone review tab. It pins the checkout,
comparison, selected file and source chat instead of following the new tab's focus.
The default layout has a collapsible file navigator and wide diff with inline
comments. **Comments pane** toggles an optional third column; that choice persists.
Selecting lines or choosing **File comment** opens a compact composer. Clicking an
inline note opens its Read/Resolve actions. **Unified / Split** switches between a single patch and aligned Before/After
columns. Split-mode clicks anchor the actual old/new side; blank padding cannot
receive annotations. Shift-click extends a range. Diff rows wrap and render on
demand; existing preview limits still apply. Previous/next file buttons navigate
without loading every file's diff. Comments and GitHub remain available as views.

Sending stays bound to the source agent, even when another chat gains focus.
If that agent disappears, Send disables rather than choosing a replacement.
Opening full review hides the existing Changes sidebar. Returning to its source
tab restores it if it was previously open. Manual sidebar toggles in full review
are respected; a Files panel opened there is not replaced on return.

Full reviews default to **Branch**. The last Branch/Uncommitted choice, split/unified
mode, file drawer, optional comments pane, unread filter, context size and column
widths persist across new review tabs and app restarts. Base refs are remembered
per machine/checkout, never copied to an unrelated repository. The compact sidebar
keeps its own comparison state.

**Syntax / Plain** toggles lexical coloring, enabled by default and remembered
globally. It recognizes JS/TS, Rust, Python, C-like languages, JSON, YAML/TOML,
shell, SQL, CSS and HTML/XML. Keywords, strings, comments, types, functions and
numbers use theme colors; diff backgrounds and selection remain unchanged.
Old/new multiline state is separate and resets at hidden gaps. This is a small
lexer, not a full language grammar. Unsupported languages and extreme lines
stay plain. Large compact-sidebar previews also stay plain to keep rendering
bounded; full review colors only the visible rows.

### Edit, delete, and quick questions

Click a saved inline comment to open its **Copy**, **Edit**, and **Delete…**
actions. Clicking does not enter editing automatically, so its text stays
available for selection.
When several notes share a line, clicking their group opens individual action
cards; choose **Edit** on the note you want. Saving and filtering notes keep
the native source-list slots stable so the diff retains its reading position.
Save with **Save changes** or **⌘Enter / Ctrl+Enter**. Editing changes the body,
not its source anchor. Annotator checks the previous body before saving, so
another panel's edit cannot be overwritten without a refresh.
**Delete… → Delete permanently** removes an open, unsent local comment. Sent,
uncertain, and resolved notes keep their history; reopen a resolved note first.
Comment edits and question drafts stay in memory per checkout while the mod is
loaded. Save edits before reloading the mod.

**Last commit** compares the working tree against `HEAD^`: the latest commit
plus staged, unstaged, and untracked work. A root commit compares against the
empty tree; an unborn checkout has no Last commit scope. Notes stay separate
from Branch and Uncommitted reviews. The full view remembers this choice.

Right-click a line or hunk header to open a question composer. Select a range
and choose **Ask selection**, or use **Ask about diff** for the open file.
Questions require a complete loaded preview and carry its revision, path,
diff side, and source rows. Only **Send question** or the question editor's
**⌘Enter / Ctrl+Enter** sends; plain Enter stays multiline. Sending does not
include or mark your saved review comments delivered.

The recipient must be the source chat and idle. A durable receipt records
uncertainty before sending. Reopening the same question does not automatically
retry it. If confirmation is lost, check the chat, then use **I checked chat ·
Send again** with the original text and recipient. Confirmed identical questions
against the same snapshot return their receipt instead of sending twice.

### Copying text

Comments and GitHub reply bodies support native text selection and
**⌘C / Ctrl+C**. **Copy** on a comment copies its exact saved body; **Copy
thread** includes the thread's authors and replies. Dragging inline text does
not open its action panel or start editing.

Source rows are virtualized review targets, not one continuous selectable
document. Open **Copy…** for the diff preview, selected old/new source lines,
the file path, checkout path, or all saved local comments. **Copy branch** copies
the exact branch name; branch headers and full-review checkout/file paths also
support native selection.
Selected-line copying omits gutters and diff signs; diff copying keeps signs and hunk headers. These
copy actions stay usable during refresh and do not save or send anything.
For a truncated diff, copying includes only the available preview.

### Read and unread

Resolved comments and confirmed-sent local comments/GitHub threads are hidden
by default, including inline notes and file badges. Sending hides delivered
items immediately; failed or uncertain delivery stays visible. This does not
resolve threads on GitHub or claim the code is fixed.
**Show sent/resolved** reveals history; **Hide sent/resolved**
hides them again. This choice is shared by the sidebar and full review and
survives restarts. Notes remain saved, and local notes can still be reopened.
The visibility filter never changes Send eligibility.

Local comments and GitHub threads have **Mark read / Mark unread** controls.
**All comments / Unread only** filters the comment lists. These markers persist
on the app machine and are shared by the sidebar and full tab after refresh.
Reading never resolves a comment, marks it delivered, or excludes it from Send.
GitHub read markers apply to an exact thread version; new replies become unread.
No read action writes to GitHub. New comments and older stores start unread.

## Updates

The updater checks `jakub-tucek/herdr-annotator`'s latest stable GitHub release
once per day while Annotator is loaded. Checks use the public GitHub API and
do not send repository paths, code, comments, or credentials. A failed check
keeps the last offer and backs off for a day; **Check now** retries on demand.

Open **Updates** in full review, **↑** in the sidebar, or run
`annotator.updates`. The prompt shows installed/available versions, a link to
release notes, **Update**, and **Later**. Later hides the prompt for 24 hours.
Only **Update** fetches code or starts a build. There is no silent install.

Save/cancel drafts in all review views, including hidden tabs and checkout
drafts, and wait for sends/posts to finish. The in-memory view registry does
not expire hidden drafts. During an update, review views replace their editors
with a progress screen. A detached Python worker survives Herdr's command
timeout and an app restart; the first reopened view checks its durable status
before accepting new drafts.

The worker verifies installed-file hashes, refuses linked/tampered mods and
dirty source trees, fetches the official release tag over HTTPS, checks its
commit against the SHA from the update check, and fast-forwards only. It does
not reset, stash, discard, or merge local commits. The release's mod version
must match its `vMAJOR.MINOR.PATCH` tag. The installer checks that the source
stays clean at the pinned commit through the build and native checks.

The installer updates an existing private tabs mod without rewriting your
layouts. It records version/commit and file hashes in
`~/.local/share/herdr-annotator/install.json`; backups live under `backups/` in
that directory. Update status/logs are `update-job.json` and `update.log`.
Builds still require Git, Rust, Python 3, and `herdr-app` on PATH. No automatic
rollback runs after an error. If installation fails after a fast-forward, the
source clone may already be at the release; fix the reported issue and rerun
the installer. Review state lives outside that clone and stays intact.

Installs from before version 0.2.0 need one manual installer run to bootstrap
the updater. Save drafts before that run. Daily prompts require a published
stable GitHub release; tags alone and commits on `main` do not trigger them.
See [publishing a release](releases.md) for the maintainer checklist.

## Commands and open-file API

These commands target a loaded Annotator view. They obey the same draft,
snapshot, recipient, and delivery checks as the buttons:

| Command | Action |
| --- | --- |
| `annotator.submit` | Send saved review comments and queued GitHub threads |
| `annotator.ask` | Open a question for the selection, or the current file |
| `annotator.scope` | Cycle Uncommitted → Last commit → Branch |
| `annotator.refresh` | Refresh the diff and GitHub threads |
| `annotator.full` | Open a pinned full-review tab |
| `annotator.updates` | Open update status and check for a release |

No shortcuts are installed globally. Add your preferred keys under `global` in
Herdr's `keys.json`, for example:

```json
{
  "global": {
    "cmd-alt-a": "annotator.ask",
    "cmd-alt-r": "annotator.refresh"
  }
}
```

Another mod can request a changed file with a one-shot shared value:

```js
setShared("annotator.open", {
  id: `${Date.now()}-${Math.random()}`,
  at: Date.now(),
  path: "/absolute/path/to/checkout/src/file.js",
  on: null, // Herdr machine name for SSH files, null for local files.
});
run("layout.select", { stack: "panel-body", child: "changes" });
run("layout.show", { id: "panel" });
```

Focus the target checkout first. Annotator refreshes before selecting the file
and keeps the current comparison scope. Requests wait during active operations
or while another checkout/machine is shown. Existing drafts stay with their
original file; opening another file does not discard them. A request expires after 30
seconds; a missing timestamp, relative path, or path containing `.` / `..`
segments is invalid. A newer request survives an older refresh. A file without
a diff produces a message and leaves the existing file selected. The API never
sends a message or changes a draft.

## GitHub review threads

The **GitHub** tab discovers the open PR matching this checkout's branch and
origin/upstream repository on github.com. It uses local `gh` credentials,
polls every five minutes, and **Refresh** forces a new fetch. Remote checkouts
still use the app machine's `gh`; no helper installation there is needed.

**Fix thread** sends only that thread to the open idle or working agent session.
**Add to review** queues it alongside local comments for one-click batch
delivery or export. Threads include reviewer replies and stored diff context.
New replies require reselection; resolved, incomplete, sent or uncertain thread
versions cannot be sent. Failed refreshes preserve the last result with an
error and prevent sending threads. Send review never posts replies or resolves threads.

**Reply** opens a separate composer on an existing thread. **Post to GitHub**
posts as the account authenticated through local `gh`, independently of the agent.
The helper rechecks the exact thread version before posting. If new replies arrive,
review them and click Reply again to accept that version. Drafts stay in memory
per checkout/thread. An unconfirmed post preserves its draft and a durable receipt;
no automatic retry occurs. Use **I checked GitHub · Post again** only after verifying
the reply is absent, since retrying can create a duplicate. This does not resolve
threads or create top-level PR comments.

If `gh` is missing, local reviews still work. The GitHub tab links to
https://cli.github.com and explains how to run `gh auth login` on the app machine.
Cached threads stay visible, but GitHub actions wait for a successful Refresh.

### GitLab merge requests

When origin/upstream points at GitLab, the same tab is labelled **GitLab** and
works through the local `glab` CLI: it finds the open merge request whose source
branch and source project match this checkout, polls every five minutes, and
offers the same **Fix thread**, **Add to review**, **Reply → Post to GitLab**,
read/unread and sent/uncertain safeguards. Diff discussions show their file and
lines; resolvable general merge request discussions show as **Merge request
discussion** without a location. Individual comments and system notes are not
listed. GitLab returns no diff hunk, so delivered threads carry path and lines
only. A location is marked outdated when the discussion was made on an older MR
version. For fork workflows, `upstream` is the target project and `origin` the
source project.

Only `gitlab.com` is trusted by default, so `glab` credentials never go to a
host taken from an arbitrary remote. Allow a self-hosted instance with
`python3 scripts/install.py --gitlab-host gitlab.example.com` (remembered in
the install receipt) or `HERDR_ANNOTATOR_GITLAB_HOSTS=gitlab.example.com`
(comma-separated). SSH ports in remotes are ignored; HTTPS remotes with a port
must be listed as `host:port`. If `glab` is missing, the tab links to
https://gitlab.com/gitlab-org/cli and explains `glab auth login --hostname <host>`.

## Storage and safety

Saved notes live on the **app machine** under
`$HERDR_ANNOTATOR_STATE_DIR`, else `$XDG_STATE_HOME/herdr-annotator`, else
`~/.local/state/herdr-annotator`. No writes to the reviewed repository, its Git
index, refs or remote host. JSON files are mode `0600`, atomically replaced and
protected by per-worktree locks. Corrupt/incompatible stores fail without being
overwritten. Back up that directory to preserve saved reviews.

Review identity is machine + checkout root + comparison/base. Different worktrees are isolated;
comments additionally record the branch. Line anchors retain selected text and
nearby diff context. They move only to a unique exact match, otherwise show as
**Outdated**. Renames are displayed as delete/add; notes are not guessed across
renames, branch switches or hidden hunks. File notes remain attached while that
file is changed on the same branch. Feedback excludes outdated, resolved,
sent and uncertain notes.

Git runs without a shell, optional locks, external diff drivers or textconv.
Paths use literal pathspecs, including filenames with brackets. Remote reads
run as argv commands through `hc exec`; nothing installs on the remote host.
The only program-input write is an explicit click on Send.

## Limits

- Working tree against HEAD or branch merge-base; unborn repos support Uncommitted.
  No arbitrary commit-range/last-turn scopes yet.
- No file-count cutoff. Git metadata output is capped at 8 MiB and fails clearly
  rather than silently cutting the list. 2 MiB total preview, 512 KiB diff output,
  2,000 rows/file and 8 KiB/line. Limits show a warning; file notes still work.
- Binary/mode-only/submodule entries are metadata-only. UTF-8 paths/text only;
  unsupported command output fails with an error instead of lossy anchors.
- 500 notes/worktree, 16 KiB/note, 64 KiB feedback batch. No delete/archive UI
  yet; resolved notes stay in history.
- Long code lines wrap in the panel, not edit or truncate the source. This is a
  review panel, not an editor. Export includes the exact anchored source text.
- Automatic Git refresh every 15 seconds, paused while a draft is nonempty.
  Save/export/send recompute the diff and reject an obsolete displayed revision.
  Herdr limits mod helper calls to 30 seconds; large/slow remote reviews can
  time out. No background daemon or automatic retries.
- Notes are local to this app machine, not synchronized to other computers.
- GitHub supports github.com only, up to 200 threads, about 500 replies/thread,
  16 KiB/comment and 32 KiB stored snippet. Truncated threads cannot be sent.
  Export/send rechecks selected thread fingerprints against GitHub.

## Interface

The Rust engine exposes one JSON request per invocation:

```sh
herdr-annotator request '{"op":"snapshot","scope":{"repo":"/path/to/checkout","machine":null}}'
```

Or pipe the same JSON to `herdr-annotator request`. Replies are
`{"ok":true,"data":...}` or `{"ok":false,"error":"..."}` with nonzero exit.
Operations: `snapshot`, `add`, `resolve`, `read`, `export`, `send`, `github`, `github_read`, `github_reply`.
The engine's public Rust interface is
`Engine::handle(Request)`, also used by integration tests.

## Development

```sh
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
npm test
herdr-app check "$PWD/mods/annotator"
python3 scripts/native_stress.py --files 5000
python3 scripts/native_stress.py --full --files 5000 --rows 2000
```

Rust tests use disposable repositories and fake core commands. They exercise
persisted notes, anchoring, literal paths, symlinks, parallel writes, worktree
isolation and delivery failure handling without contacting a real agent.

Herdr's check covers initial rendering only. Inspect `herdr-app status` and a
`herdr-app shot` in a review tab after UI edits. Keep test feedback away from
live agents. Tests do not send feedback to real agents.

For a visual test with disposable data and isolated note storage:

```sh
python3 scripts/native_fixture.py --states --open
python3 scripts/native_fixture.py --full --open
```

This opens one preview tab, creates no terminal/agent, and never sends feedback.
Close only that preview tab afterwards. `preview.png` shows this fixture, not
private repository contents.
