# Herdr Annotator

A native code-review mod for **[Herdr App](https://herdr.dev)**. Review a branch,
the last commit, or uncommitted work. Leave comments beside the code and send
them to the agent working in that checkout. Read and reply to GitHub PR threads
and GitLab merge request discussions in the same workspace. Local and SSH worktrees supported.

![Full review with split diff and inline feedback](preview.png)

## Review → comment → send

### 1. Pick what to review

Click **Changes** for the sidebar, or the adjacent **↗** for a full review tab.
Opening full review again focuses the existing tab for that source checkout.
The full view pins your checkout and source chat, with unified or side-by-side
diffs, syntax colors, resizable panes, and expandable context.

Choose **Uncommitted**, **Last commit** (plus uncommitted work), or **Branch**
(since merge-base, including committed and uncommitted changes). Pick a local
base ref from the picker, or type one such as `develop` / `origin/develop` and
press Enter. Auto chooses the closer branch point from local `develop` and
`origin/develop`, so a stale local ref does not add upstream changes. No automatic fetch.

<img src="docs/images/scope-picker.png" alt="Changes sidebar with Uncommitted, Last commit, and Branch choices" width="440">

### 2. Leave comments beside the code

Click a line; Shift-click extends the range on the same diff side. Choose
**Whole file** for a file note. Save with **⌘Enter / Ctrl+Enter** or the button.
Add comments across files. Click an inline comment for **Copy**, **Edit**, or
**Delete…** actions. Deletion asks for confirmation. Unfinished comments stay
with their file and comparison as you navigate; return to continue typing.

![Selected code and a comment ready to save](docs/images/comment.png)

Saved notes survive restarts. When code moves, Annotator re-anchors notes only
to unique matching context. Outdated notes stay visible but do not enter a send.
Comment and GitHub reply text supports selection and **⌘C / Ctrl+C**. Use
**Copy…** for diff previews, selected source lines, paths, or saved comments;
cards also offer **Copy** and **Copy thread**.
Branch names and full-review checkout/file paths support selection too;
**Copy… → Copy branch** copies the exact branch name.

### 3. Send to the source session

Add an optional **General note** beside **Send review** for overall direction. It
appears after comments and GitHub threads, can be sent alone, and is included in exports.

**Send review** submits saved comments and queued GitHub threads as one message,
with file paths and source excerpts. It uses the chat in your source tab and
accepts an idle or working agent. It never chooses another chat automatically
or bypasses permission prompts. A working agent may queue or act on the message
according to its own behavior.

**⌘Enter / Ctrl+Enter** saves the comment you are typing. With no unfinished
comments in this comparison, it sends the review, including your general note.
It never saves a comment and sends the review in the same press.

After confirmed delivery, sent comments disappear from lists, diffs, and badges.
**Show sent/resolved** reveals the history. Uncertain delivery stays visible;
check the chat before an explicit retry.

![Review after delivery, with sent comments hidden and recoverable](docs/images/sent.png)

## Logical file order

Click **Order logically** in the sidebar or full review to arrange changed files
for reading. **Reset order** restores Git order. Click **AI: OpenCode / Pi** to
switch runners. OpenCode V2 defaults to the source chat's model and reasoning
variant. Click **Source chat ▾** to choose an ordering-only model or return to
automatic selection. This never changes your chat or global default. Ambiguous
session matches and remote source chats require an explicit model choice.
Both runners run on the app machine; Pi uses its configured model/auth through
local Herdr Core (`hc exec`). Each
ordering click sends one AI request with paths and bounded diff samples,
including for SSH checkouts. No tools, saved conversation, or messages to your
working chat. Pi extensions, MCP, skills, prompt templates and context files are
disabled for this call. Normal model usage costs apply. Supports 2–200 files.
The installer records executable paths, including Pi's Node runtime, so ordering
does not depend on the desktop app inheriting your shell's PATH.

## Ask without drafting a review

Right-click a source line or hunk header to ask about it. For a range, select it
and click **Ask selection**; **Ask about diff** includes the open file's diff.
Type your question, check the recipient, then **Send question**. Saved review
comments stay untouched. Questions still require an idle source agent and persist
delivery uncertainty before sending.

<details>
<summary>Question composer</summary>

![Question about selected lines, addressed to the source session](docs/images/ask.png)

</details>

## Work through GitHub feedback

The **GitHub** tab reads PR review threads and polls for updates. **Fix thread**
sends one thread to the source agent; **Add to review** queues it with your local
notes. **Reply** opens a separate composer, and **Post to GitHub** posts as your
signed-in `gh` account. Sending to the agent does not resolve threads on GitHub.

![GitHub review threads and explicit reply composer](docs/images/github-replies.png)

With a GitLab remote the tab becomes **GitLab** and does the same for merge
request discussions through your signed-in `glab` account, including resolvable
general MR discussions. Only `gitlab.com` is trusted by default; allow a
self-hosted instance with `python3 scripts/install.py --gitlab-host gitlab.example.com`
or `HERDR_ANNOTATOR_GITLAB_HOSTS`.

On a GitLab MR the tab also shows a read-only overview above the threads: who approved,
who is still missing (from the approval rules), and the latest pipeline with its stages
and jobs. Sections GitLab refuses (tier or permissions) show a note and never block the
threads.

Read/unread markers and sent/resolved filters help you find remaining feedback.
Export a review as text when you want to copy it elsewhere.

Screenshots use inert demo data. The capture fixture cannot send messages or
post replies.

## Install

Requires macOS or Linux, Herdr App, herdr-core (`hc`), Git, Rust, and Python 3.
GitHub threads also need an authenticated GitHub CLI (`gh`) on the app machine.
GitLab discussions need an authenticated GitLab CLI (`glab`) instead.
Without them, local reviews still work; the tab shows setup instructions.

```sh
git clone https://github.com/jakub-tucek/herdr-annotator.git
cd herdr-annotator
python3 scripts/install.py
```

The installer builds the Rust helper and installs the native JavaScript mod.
Remote machines need no extra installation.

To use it in the existing Changes panel, clone a layout and install into that copy:

```sh
herdr-app do layout.clone '{"name":"main","as":"spider"}'
python3 scripts/install.py --layout spider
```

For an existing personal layout, use its name instead. The installer backs up
changes and refuses to overwrite locally edited mod files.
It also installs a private tabs mod with **[Changes | ↗]**: Changes toggles the
sidebar; ↗ opens full review directly. Shipped mods stay untouched. Rerun with
the same `--layout` to update both integrations.

## Data and delivery

Comments stay on your app machine. Git, GitHub and GitLab review reads do not modify the
repository. Only **Post to GitHub** / **Post to GitLab** posts a reply, as your signed-in
`gh` / `glab` account. An unconfirmed post keeps its draft; check the thread
before explicitly retrying.
**Send review submits with Enter**; check the chat
before retrying uncertain delivery. Diff preview limits still apply.

## Commands and integrations

Bind `annotator.submit`, `annotator.ask`, `annotator.scope`, `annotator.refresh`,
`annotator.full`, or `annotator.updates` in Herdr's `keys.json`. No global keys
change during install. Other mods can request a file's diff through
`setShared("annotator.open", …)`. See the
[command and open-file API reference](docs/guide.md#commands-and-open-file-api).

## Updates

Annotator checks GitHub for a stable tagged release once a day. **Update
available** shows the new version with **Release notes**, **Update**, and
**Later**. Open **Updates** in full review, or **↑** in the sidebar, to check
manually. Downloads/builds begin only after you click **Update**.

Save or cancel drafts in all review tabs first. The updater pauses review
editors during installation, fast-forwards the original clone to the checked
release commit, rebuilds the helper, and hot-reloads the mods. It backs up the
old install and refuses dirty/diverged checkouts or locally edited installed
files. Your personal layouts and saved comments stay in place.

Existing installs need one manual reinstall to gain this mechanism:

```sh
git pull --ff-only
python3 scripts/install.py --layout spider
```

Use your own layout name, or omit `--layout` for a standalone install. Update
prompts follow published GitHub releases, not each commit on `main`.


## Development

```sh
cargo test --locked
npm test # Node.js 22+
python3 -m unittest discover -s tests -p 'test_*.py'
```

See the [user guide](docs/guide.md) and [mod recipe](RECIPE.md) for details.

Capture the native demo screenshots on macOS with
`python3 scripts/catalog_screenshots.py --output <temporary-directory>`.
The fixture blocks network access, agent messages, and settings writes.

[MIT license](LICENSE).
