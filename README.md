# GitLab issues kanban (`dsh-glab-kanban`)

A DeepSeek Harness plugin that adds a **GitLab issues kanban** to the sidebar, backed entirely by the
[`glab`](https://gitlab.com/gitlab-org/cli) command-line tool. It reuses your existing `glab` login — the
plugin stores no token.

## What it does

- **Board as columns.** A project's GitLab issue board becomes a kanban: every board list backed by a label is
  a column, in the board's own order.
- **Drag to change status.** Drag a card to another column and the plugin replaces the status label
  (`glab issue update <iid> --label <new> --unlabel <old…>`). Scoped GitLab labels behave exactly as expected.
- **Cards at a glance.** Each card shows its number, title, labels, assignees, milestone, due date, comment
  count and last update.
- **Detail drawer.** Click a card to read its Markdown description, attachment links, comments and
  activity history; move it, add a comment, close/reopen it, or open it in GitLab.
- **Comments and activity.** Human comments render as a timeline with author and relative time; label,
  assignment and date changes are grouped under a collapsible activity log.
- **Filter and search.** Filter by assignee, "only mine", or free-text over title / number / label.
- **Create issues.** Open the composer from the header or a column's `+`; the target column's label is
  preselected. Labels are grouped by their `scope::` prefix, the assignee field suggests people already on
  the board, and `Cmd/Ctrl + Enter` submits.
- **Project picker.** The sidebar panel's project picker remembers recently opened projects, supports a
  direct `group/sub/project` path, and selects the first result with Enter.
- **Fallbacks.** If a project has no board, columns can be built from a scoped label prefix (`statusScope`),
  and as a last resort the board shows read-only Open / Closed columns.
- **Agent tool.** The same operations are exposed to the model through the `glab_kanban` tool.

## Requirements

- `glab` installed and authenticated (`glab auth status`). The plugin calls `glab` from `PATH` or the usual
  install locations; set `glabPath` if it lives elsewhere.
- A GitLab token that can read the target project's boards and issues, and update issues if you want to move,
  create, comment or close.

## Where to find it

There are two surfaces:

- **Session view — bound to the current project.** Open a conversation and choose the **Board** tab in the
  session's View row. The plugin reads that session workspace's Git `origin` remote, resolves the GitLab
  project, and shows only that project's board — no project picker. If the workspace has no GitLab origin,
  the view says so and offers Retry. Board switching inside the project is still available.
- **Sidebar panel — choose any project.** The **GitLab issues kanban** icon opens the global board with a
  project picker and remembers your last project.

## Configuration

Set these under the `glab-kanban` row in `cordis.patch.yml` (or via the plugin's configuration page):

| Key              | Default | Meaning                                                                                   |
| ---------------- | ------- | ----------------------------------------------------------------------------------------- |
| `repo`           | `''`    | Default project (`group/sub/project` or numeric id). Empty asks you to pick one.         |
| `host`           | `''`    | GitLab hostname passed to `glab --hostname`. Empty uses the glab default.                 |
| `glabPath`       | `glab`  | Path to the `glab` executable.                                                            |
| `boardId`        | `''`    | Default board id. Empty selects the project's first board.                                |
| `statusScope`    | `''`    | Fallback column source: build columns from labels with this prefix, e.g. `任务状态::`.     |
| `pageSize`       | `60`    | Maximum cards loaded per column (the header still shows the full match count).           |
| `includeBacklog` | `false` | Add a read-only backlog column of open issues carrying none of the board status labels.  |

## How it talks to GitLab

All calls go through `glab`:

- reading boards, lists and issues → `glab api projects/<id>/boards…` / `…/issues…`
  (the interactive `glab issue board` subcommand cannot run without a TTY, so the REST API is used through `glab api`);
- moving cards → `glab issue update <iid> --label … --unlabel …`;
- creating / commenting / closing → `glab issue create|note|close|reopen`.

## Why avatars and issue images are not embedded

A private GitLab instance serves `/uploads/...` (user avatars and images pasted into issue
descriptions) only to a **GitLab web session**. The DSH page is a different origin and has no GitLab
session, and the GitLab API token that glab holds is not accepted by those static routes — so the
browser cannot fetch them directly.

The plugin therefore:

- draws a stable, colored **initials avatar** for every person (public Gravatar images are still loaded
  when available);
- turns every Markdown image in a description or comment into an **attachment link** that opens the
  original image in GitLab, where your browser session applies.

If your instance makes uploads public, or you want live thumbnails, the next step would be an explicit
Host-side asset proxy bound to a GitLab session; that is not enabled because it would require storing or
replaying a GitLab web session.

## Limitations

- Only **label-backed** board lists are movable columns. Assignee- or milestone-backed lists are not turned into
  columns, and Open/Closed fallback columns are read-only.
- Each column loads at most `pageSize` cards; the header count is the true total and shows a "showing N of M"
  note when truncated.
- Search and the assignee filter run over each column's **loaded** page, not the full server-side result;
  the column footer says so while a filter is active.
- Board-level filters (assignee, milestone, label `scope` on the board itself) are not applied; the board is
  read as configured for its project.

## Turning it off

Disable the `glab-kanban` row (or the bundle) in **Plugins**. The sidebar entry disappears and no `glab` calls
are made; nothing is written to GitLab and no plugin state is kept beyond the last project/board choice stored
in the browser's local storage.
