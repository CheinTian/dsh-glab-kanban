/**
 * Host half of the GitLab issues kanban plugin.
 *
 * Everything is driven through the `glab` CLI so the plugin inherits the user's
 * existing authentication, host selection and repository access instead of
 * re-implementing a GitLab client:
 *
 *   - reading boards / lists / issues      → `glab api …` (the `glab issue board`
 *     subcommand is interactive and cannot run non-interactively, so the REST
 *     endpoints are used directly through `glab api`);
 *   - moving a card between columns        → `glab issue update <iid> --label X --unlabel Y`;
 *   - creating / commenting / closing      → `glab issue create|note|close|reopen`.
 *
 * A GitLab issue board is the natural kanban model: every board list that is
 * backed by a label becomes one column, and dragging a card to another column
 * replaces the status label. When a project has no board, columns can be built
 * from a scoped label prefix (e.g. `任务状态::`), and as a last resort the board
 * falls back to Open / Closed state columns.
 *
 * The same operations are exposed to the agent through one `glab_kanban` tool,
 * so the panel and the model share a single implementation.
 */

import Schema from '@deepseek-ai/schemastery'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const runFile = promisify(execFile)

/** Bumped whenever the Host half changes, so a stale module is obvious from the panel. */
const HOST_VERSION = '1.0.0'

/** Prefix of every route this bundle owns. */
const ROUTE_PREFIX = '/api/dsh-glab-kanban'

/** How long one glab call may take before it is abandoned. */
const GLAB_TIMEOUT_MS = 30_000

/** glab JSON payloads can be large because issue rows carry their description. */
const MAX_BUFFER = 48 * 1024 * 1024

/** A project path (`group/sub/project`) or a numeric project id. */
const REPO_RE = /^(?:\d+|[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)+)$/

/** Where glab may live when the Host was launched without an interactive PATH. */
const EXTRA_PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']

/**
 * Row configuration. Defaults keep the plugin usable without editing the patch,
 * but every value can be overridden in `cordis.patch.yml`.
 */
export const Config = Schema.object({
  repo: Schema.string()
    .default('')
    .description('Default project to open: a path like group/sub/project (or a numeric project id). Empty makes the panel ask you to pick one.'),
  host: Schema.string()
    .default('')
    .description('GitLab hostname passed to glab as --hostname (e.g. gitlab.example.org). Empty uses the glab default host.'),
  glabPath: Schema.string()
    .default('glab')
    .description('Path to the glab executable. Empty or "glab" resolves glab from PATH plus the usual install locations.'),
  boardId: Schema.string()
    .default('')
    .description('Default board id to open. Empty selects the first board of the project.'),
  statusScope: Schema.string()
    .default('')
    .description('Fallback column source when a project has no board: build columns from labels sharing this prefix, e.g. "任务状态::".'),
  pageSize: Schema.number()
    .default(60)
    .description('Maximum cards loaded per column (the header still shows the full match count).'),
  includeBacklog: Schema.boolean()
    .default(false)
    .description('Add a read-only backlog column holding open issues that carry none of the board status labels.'),
})

/** An error carrying a stable code the page can branch on. */
class GlabError extends Error {
  constructor(message, code = 'glab') {
    super(message)
    this.name = 'GlabError'
    this.code = code
  }
}

/** Trim a multi-line CLI error into one readable line. */
function oneLine(text) {
  return String(text ?? '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400)
}

/** Encode a project path for use in an API URL segment. */
function encRepo(repo) {
  return /^\d+$/.test(repo) ? repo : encodeURIComponent(repo)
}

/** Normalize a value into a safe repository reference. */
function normalizeRepo(value) {
  const repo = typeof value === 'string' ? value.trim() : ''
  if (repo === '') return ''
  // Accept a full web URL by reducing it to its path.
  const fromUrl = /^https?:\/\/[^/]+\/(.+)$/.exec(repo)
  const candidate = fromUrl !== null ? fromUrl[1].replace(/\.git$/, '').replace(/\/+$/, '') : repo
  return REPO_RE.test(candidate) ? candidate : ''
}

/** Answer with JSON and forbid caching. */
function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
}

/** Fail with a stable, page-readable error shape. */
function fail(code, message, status = 400) {
  return json({ ok: false, error: { code, message } }, status)
}

/** Read a request body as an object, tolerating an empty body. */
async function readBody(request) {
  try {
    const text = await request.text()
    if (text.trim() === '') return {}
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** Normalize one issue row into the card shape the page renders. */
function mapCard(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const labels = Array.isArray(raw.labels)
    ? raw.labels
        .map((label) => {
          if (typeof label === 'string') return { name: label, color: null, textColor: null }
          if (label !== null && typeof label === 'object' && typeof label.name === 'string') {
            return { name: label.name, color: typeof label.color === 'string' ? label.color : null, textColor: typeof label.text_color === 'string' ? label.text_color : null }
          }
          return undefined
        })
        .filter((label) => label !== undefined)
    : []
  const assignees = Array.isArray(raw.assignees)
    ? raw.assignees
        .map((user) =>
          user !== null && typeof user === 'object' && typeof user.username === 'string'
            ? { username: user.username, name: typeof user.name === 'string' ? user.name : user.username, avatar: typeof user.avatar_url === 'string' ? user.avatar_url : undefined }
            : undefined,
        )
        .filter((user) => user !== undefined)
    : []
  return {
    iid: raw.iid,
    title: typeof raw.title === 'string' ? raw.title : '',
    state: typeof raw.state === 'string' ? raw.state : 'opened',
    labels,
    assignees,
    milestone: raw.milestone !== null && typeof raw.milestone === 'object' && typeof raw.milestone.title === 'string' ? raw.milestone.title : null,
    dueDate: typeof raw.due_date === 'string' ? raw.due_date : null,
    createdAt: typeof raw.created_at === 'string' ? raw.created_at : null,
    updatedAt: typeof raw.updated_at === 'string' ? raw.updated_at : null,
    webUrl: typeof raw.web_url === 'string' ? raw.web_url : null,
    author: raw.author !== null && typeof raw.author === 'object' && typeof raw.author.username === 'string' ? { username: raw.author.username, name: typeof raw.author.name === 'string' ? raw.author.name : raw.author.username, avatar: typeof raw.author.avatar_url === 'string' ? raw.author.avatar_url : undefined } : null,
    notes: typeof raw.user_notes_count === 'number' ? raw.user_notes_count : 0,
  }
}

/**
 * GitLab-kanban bundle: a board over glab, plus a matching agent tool.
 * @param ctx - the plugin context.
 * @param config - the row configuration.
 */
export function apply(ctx, config) {
  const row = config !== null && typeof config === 'object' ? config : {}
  const glabPath = typeof row.glabPath === 'string' && row.glabPath.trim() !== '' ? row.glabPath.trim() : 'glab'
  const host = typeof row.host === 'string' ? row.host.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '') : ''
  const defaultRepo = normalizeRepo(row.repo)
  const defaultBoardId = typeof row.boardId === 'string' || typeof row.boardId === 'number' ? String(row.boardId).trim() : ''
  const statusScope = typeof row.statusScope === 'string' ? row.statusScope.trim() : ''
  const pageSize = Number.isInteger(row.pageSize) && row.pageSize > 0 ? Math.min(row.pageSize, 200) : 60
  const includeBacklog = row.includeBacklog === true

  /** Run glab with a bounded deadline and a PATH that reaches a normal install. */
  async function glab(args, options = {}) {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    const pathParts = String(env.PATH ?? '')
      .split(':')
      .filter((part) => part !== '')
    for (const extra of EXTRA_PATH) if (!pathParts.includes(extra)) pathParts.push(extra)
    env.PATH = pathParts.join(':')
    try {
      const { stdout } = await runFile(glabPath, args, {
        timeout: options.timeout ?? GLAB_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        signal: options.signal,
        env,
      })
      return stdout
    } catch (error) {
      const stderr = typeof error?.stderr === 'string' ? error.stderr : ''
      const stdout = typeof error?.stdout === 'string' ? error.stdout : ''
      const message = oneLine(stderr || stdout || (error instanceof Error ? error.message : String(error)))
      if (/ENOENT|not found/i.test(message)) {
        throw new GlabError(`glab was not found (looked for "${glabPath}"). Install glab or set glabPath in the plugin config.`, 'no-glab')
      }
      throw new GlabError(message || 'glab exited with an error.', 'glab')
    }
  }

  /** Run git with the same environment hygiene as glab. */
  async function git(args, options = {}) {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    const pathParts = String(env.PATH ?? '')
      .split(':')
      .filter((part) => part !== '')
    for (const extra of EXTRA_PATH) if (!pathParts.includes(extra)) pathParts.push(extra)
    env.PATH = pathParts.join(':')
    try {
      const { stdout } = await runFile('git', args, {
        timeout: options.timeout ?? 10_000,
        maxBuffer: 4 * 1024 * 1024,
        signal: options.signal,
        env,
      })
      return stdout
    } catch (error) {
      const stderr = typeof error?.stderr === 'string' ? error.stderr : ''
      const message = oneLine(stderr || (error instanceof Error ? error.message : String(error)))
      throw new GlabError(message || 'git exited with an error.', 'git')
    }
  }

  /** Extract a `group/sub/project` path from a Git remote URL. */
  function repoFromRemote(remote) {
    if (typeof remote !== 'string') return ''
    const value = remote.trim()
    if (value === '') return ''
    let path = ''
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
      try {
        path = new URL(value).pathname
      } catch {
        return ''
      }
    } else {
      const scp = /^[^@\s]+@[^:\s]+:(.+)$/.exec(value)
      if (scp === null) return ''
      path = scp[1]
    }
    path = path.replace(/^\/+/, '').replace(/\.git$/, '').replace(/\/+$/, '')
    return REPO_RE.test(path) ? path : ''
  }

  /** Cache the project bound to one workspace directory. */
  const sessionRepoCache = new Map()

  /** Resolve the GitLab project from a directory's `origin` remote. */
  async function repoForDir(dir, options = {}) {
    const key = String(dir ?? '').trim()
    if (key === '') return null
    const cached = sessionRepoCache.get(key)
    if (cached !== undefined && Date.now() - cached.at < 60_000) return cached.value
    let value = null
    try {
      const remote = (await git(['-C', key, 'remote', 'get-url', 'origin'], { signal: options.signal })).trim()
      const repo = repoFromRemote(remote)
      if (repo !== '') value = { repo, remote }
    } catch {
      value = null
    }
    sessionRepoCache.set(key, { value, at: Date.now() })
    return value
  }

  /** Run one API GET and parse its JSON body. */
  async function apiJson(endpoint, options = {}) {
    const args = ['api']
    if (host !== '') args.push('--hostname', host)
    args.push(endpoint)
    const stdout = await glab(args, options)
    try {
      return JSON.parse(stdout)
    } catch {
      throw new GlabError(`glab api returned non-JSON output for ${oneLine(endpoint)}.`, 'parse')
    }
  }

  /** Run one API GET with response headers so the full match count is available. */
  async function apiWithTotal(endpoint, options = {}) {
    const args = ['api', '--include']
    if (host !== '') args.push('--hostname', host)
    args.push(endpoint)
    const stdout = await glab(args, options)
    const split = stdout.search(/\r?\n\r?\n/)
    const headerText = split === -1 ? '' : stdout.slice(0, split)
    const bodyText = split === -1 ? stdout : stdout.slice(split).replace(/^\r?\n\r?\n/, '')
    const totalMatch = /^x-total:\s*(\d+)/im.exec(headerText)
    let data
    try {
      data = JSON.parse(bodyText)
    } catch {
      throw new GlabError(`glab api returned non-JSON output for ${oneLine(endpoint)}.`, 'parse')
    }
    const rows = Array.isArray(data) ? data : []
    return { total: totalMatch !== null ? Number(totalMatch[1]) : rows.length, data: rows }
  }

  /** Cache resolved project metadata so a board load does not re-resolve it repeatedly. */
  const projectCache = new Map()

  /** Resolve a project path or id into its canonical metadata. */
  async function getProject(repo, options = {}) {
    const cached = projectCache.get(repo)
    if (cached !== undefined && Date.now() - cached.at < 120_000) return cached.value
    const data = await apiJson(`projects/${encRepo(repo)}`, options)
    if (data === null || typeof data !== 'object' || typeof data.id !== 'number') {
      throw new GlabError(`Project "${repo}" was not found or is not accessible.`, 'not-found')
    }
    const value = {
      id: data.id,
      path: typeof data.path_with_namespace === 'string' ? data.path_with_namespace : repo,
      name: typeof data.name === 'string' ? data.name : repo,
      webUrl: typeof data.web_url === 'string' ? data.web_url : null,
      avatar: typeof data.avatar_url === 'string' ? data.avatar_url : null,
    }
    projectCache.set(repo, { value, at: Date.now() })
    return value
  }

  /** List the boards configured on a project. */
  async function listBoards(projectId, options = {}) {
    const data = await apiJson(`projects/${projectId}/boards?per_page=100`, options)
    return Array.isArray(data) ? data.map((board) => ({ id: String(board.id), name: typeof board.name === 'string' ? board.name : `Board ${board.id}` })) : []
  }

  /** List the labels of a project (for the create form and column colors). */
  async function listLabels(projectId, options = {}) {
    const data = await apiJson(`projects/${projectId}/labels?per_page=100&order_by=name`, options)
    return Array.isArray(data)
      ? data
          .filter((label) => label !== null && typeof label === 'object' && typeof label.name === 'string')
          .map((label) => ({ name: label.name, color: typeof label.color === 'string' ? label.color : null, textColor: typeof label.text_color === 'string' ? label.text_color : null }))
      : []
  }

  /** Turn a board's label-backed lists into ordered columns. */
  function columnsFromBoard(board) {
    const lists = Array.isArray(board?.lists) ? board.lists.slice() : []
    lists.sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0))
    return lists
      .filter((list) => list !== null && typeof list === 'object' && list.label !== null && typeof list.label === 'object' && typeof list.label.name === 'string')
      .map((list) => ({
        id: `list:${list.id}`,
        label: list.label.name,
        color: typeof list.label.color === 'string' ? list.label.color : '#9aa0a6',
        textColor: typeof list.label.text_color === 'string' ? list.label.text_color : null,
        position: Number(list.position) || 0,
      }))
  }

  /** Build columns from labels that share a scoped prefix (fallback when no board). */
  async function columnsFromScope(projectId, scope, options = {}) {
    const prefix = scope.endsWith('::') ? scope : `${scope}::`
    const labels = await listLabels(projectId, options)
    const matched = labels.filter((label) => label.name.startsWith(prefix))
    return matched.map((label, index) => ({ id: `label:${label.name}`, label: label.name, color: label.color ?? '#9aa0a6', textColor: label.textColor ?? null, position: index }))
  }

  /** Load one column's first page of cards plus its full match count. */
  async function loadColumn(projectId, column, options = {}) {
    const query = [`state=opened`, `labels=${encodeURIComponent(column.label)}`, `per_page=${pageSize}`, 'order_by=updated_at', 'with_labels_details=true'].join('&')
    const { total, data } = await apiWithTotal(`projects/${projectId}/issues?${query}`, options)
    return {
      ...column,
      count: total,
      truncated: total > data.length,
      movable: true,
      issues: data.map(mapCard).filter((card) => card !== undefined),
    }
  }

  /** Load a state-based read-only column (Open / Closed fallback). */
  async function loadStateColumn(projectId, state, title, options = {}) {
    const query = [`state=${state}`, `per_page=${pageSize}`, 'order_by=updated_at', 'with_labels_details=true'].join('&')
    const { total, data } = await apiWithTotal(`projects/${projectId}/issues?${query}`, options)
    return {
      id: `state:${state}`,
      label: null,
      state,
      title,
      color: state === 'opened' ? '#2f9e6f' : '#8f8f8f',
      textColor: null,
      count: total,
      truncated: total > data.length,
      movable: false,
      issues: data.map(mapCard).filter((card) => card !== undefined),
    }
  }

  /**
   * Load a full board: project, boards, the selected board's columns and cards.
   * @returns the board payload the page renders.
   */
  async function loadBoard({ repo, boardId, signal }) {
    const project = await getProject(repo, { signal })
    const boards = await listBoards(project.id, { signal })
    const preferred = boardId !== '' ? String(boardId) : defaultBoardId
    let chosen = preferred !== '' && boards.some((board) => board.id === preferred) ? preferred : boards.length > 0 ? boards[0].id : null
    let boardName = boards.find((board) => board.id === chosen)?.name ?? null
    let source = 'board'
    let columns = []
    if (chosen !== null) {
      const board = await apiJson(`projects/${project.id}/boards/${chosen}`, { signal })
      columns = columnsFromBoard(board)
    }
    if (columns.length === 0 && statusScope !== '') {
      columns = await columnsFromScope(project.id, statusScope, { signal })
      source = 'scope'
      chosen = null
      boardName = null
    }
    const [loaded, labels] = await Promise.all([
      Promise.all(columns.map((column) => loadColumn(project.id, column, { signal }))),
      listLabels(project.id, { signal }),
    ])
    if (loaded.length === 0) {
      source = 'state'
      loaded.push(await loadStateColumn(project.id, 'opened', 'Open', { signal }))
      loaded.push(await loadStateColumn(project.id, 'closed', 'Closed', { signal }))
    }
    if (includeBacklog && source === 'board' && loaded.length > 0) {
      const notLabels = loaded
        .filter((column) => column.label !== null)
        .map((column) => encodeURIComponent(column.label))
        .join(',')
      if (notLabels !== '') {
        const query = [`state=opened`, `not%5Blabels%5D=${notLabels}`, `per_page=${pageSize}`, 'order_by=updated_at', 'with_labels_details=true'].join('&')
        const { total, data } = await apiWithTotal(`projects/${project.id}/issues?${query}`, { signal })
        loaded.push({
          id: 'backlog',
          label: null,
          color: '#9aa0a6',
          textColor: null,
          count: total,
          truncated: total > data.length,
          movable: false,
          issues: data.map(mapCard).filter((card) => card !== undefined),
        })
      }
    }
    return {
      project,
      boards,
      boardId: chosen,
      boardName,
      source,
      columns: loaded,
      labels,
      statusScope: statusScope !== '' ? statusScope : null,
      pageSize,
      includeBacklog,
    }
  }

  /** Resolve the canonical repo path used for mutating `glab issue` commands. */
  async function repoPathOf(repo, options = {}) {
    const project = await getProject(repo, options)
    return project.path
  }

  /** Move a card by replacing the status label. */
  async function moveIssue({ repo, iid, toLabel, fromLabels, signal }) {
    const path = await repoPathOf(repo, { signal })
    const args = ['issue', 'update', String(iid), '-R', path]
    if (toLabel !== '') args.push('--label', toLabel)
    for (const label of fromLabels) if (label !== '' && label !== toLabel) args.push('--unlabel', label)
    await glab(args, { signal })
    return { moved: iid, toLabel }
  }

  /** Create a new issue. */
  async function createIssue({ repo, title, description, labels, assignee, dueDate, milestone, signal }) {
    const path = await repoPathOf(repo, { signal })
    const args = ['issue', 'create', '-R', path, '--title', title, '--yes', '--no-editor']
    if (description !== '') args.push('--description', description)
    for (const label of labels) if (label !== '') args.push('--label', label)
    if (assignee !== '') args.push('--assignee', assignee)
    if (dueDate !== '') args.push('--due-date', dueDate)
    if (milestone !== '') args.push('--milestone', milestone)
    const stdout = await glab(args, { signal })
    const url = /(https?:\/\/\S+\/issues\/\d+)/.exec(stdout)?.[1] ?? /(https?:\/\/\S+\/work_items\/\d+)/.exec(stdout)?.[1] ?? null
    return { created: true, url }
  }

  /** Comment on an issue. */
  async function commentIssue({ repo, iid, message, signal }) {
    const path = await repoPathOf(repo, { signal })
    await glab(['issue', 'note', String(iid), '-m', message, '-R', path], { signal })
    return { commented: iid }
  }

  /** Close or reopen an issue. */
  async function setIssueState({ repo, iid, action, signal }) {
    const path = await repoPathOf(repo, { signal })
    await glab(['issue', action, String(iid), '-R', path], { signal })
    return { iid, state: action === 'close' ? 'closed' : 'opened' }
  }

  /** Read one issue's detail (description, author, notes count, labels…). */
  async function issueDetail({ repo, iid, signal }) {
    const project = await getProject(repo, { signal })
    const raw = await apiJson(`projects/${project.id}/issues/${iid}`, { signal })
    const card = mapCard(raw)
    if (card === undefined) throw new GlabError('The issue could not be read.', 'empty')
    return {
      ...card,
      project: { path: project.path, webUrl: project.webUrl },
      description: typeof raw.description === 'string' ? raw.description : '',
      references: raw.references !== null && typeof raw.references === 'object' ? raw.references : null,
    }
  }

  /** Normalize one issue note (a comment or a system activity row). */
  function mapNote(raw) {
    if (raw === null || typeof raw !== 'object') return undefined
    const author = raw.author !== null && typeof raw.author === 'object' && typeof raw.author.username === 'string' ? raw.author : null
    return {
      id: raw.id,
      body: typeof raw.body === 'string' ? raw.body : '',
      system: raw.system === true,
      internal: raw.internal === true,
      createdAt: typeof raw.created_at === 'string' ? raw.created_at : null,
      author: author === null ? null : { username: author.username, name: typeof author.name === 'string' ? author.name : author.username, avatar: typeof author.avatar_url === 'string' ? author.avatar_url : undefined },
    }
  }

  /** List an issue's comments and activity notes, oldest first. */
  async function listNotes({ repo, iid, signal }) {
    const project = await getProject(repo, { signal })
    const data = await apiJson(`projects/${project.id}/issues/${iid}/notes?per_page=100&sort=asc&order_by=created_at`, { signal })
    return Array.isArray(data) ? data.map(mapNote).filter((note) => note !== undefined) : []
  }

  /** Search the projects the current token can reach. */
  async function searchProjects(search, options = {}) {
    const params = ['membership=true', 'per_page=20', 'order_by=last_activity_at', 'sort=desc']
    if (search !== '') params.push(`search=${encodeURIComponent(search)}`)
    const data = await apiJson(`projects?${params.join('&')}`, options)
    return Array.isArray(data)
      ? data.map((project) => ({
          id: project.id,
          path: typeof project.path_with_namespace === 'string' ? project.path_with_namespace : String(project.id),
          name: typeof project.name === 'string' ? project.name : '',
          avatar: typeof project.avatar_url === 'string' ? project.avatar_url : null,
        }))
      : []
  }

  /** The current authenticated glab user, if any. */
  async function currentUser(options = {}) {
    const raw = await apiJson('user', options)
    if (raw === null || typeof raw !== 'object' || typeof raw.username !== 'string') return null
    return { username: raw.username, name: typeof raw.name === 'string' ? raw.name : raw.username, avatar: typeof raw.avatar_url === 'string' ? raw.avatar_url : null }
  }

  /** Register one exact POST route on the authenticated `/api` bridge. */
  function registerRoute(scope, connection, path, handler) {
    if (typeof connection?.fetch?.register !== 'function') {
      throw new Error(`dsh-glab-kanban: the connection service cannot register fetch routes`)
    }
    scope.effect(() => connection.fetch.register({ path, methods: ['POST'], requestBody: 'buffered', fetch: handler }), `dsh-glab-kanban: route ${path}`)
  }

  ctx.inject(['connection'], (scope) => {
    const connection = scope.get('connection')
    const route = (name, handler) => registerRoute(scope, connection, `${ROUTE_PREFIX}/${name}`, handler)

    route('status', async () => {
      let glabVersion = ''
      let glabAvailable = false
      let glabError = null
      try {
        const stdout = await glab(['--version'], { timeout: 8000 })
        glabVersion = stdout.trim().split('\n')[0] ?? ''
        glabAvailable = true
      } catch (error) {
        glabError = error instanceof Error ? error.message : String(error)
      }
      let user = null
      if (glabAvailable) {
        try {
          user = await currentUser()
        } catch {
          // Anonymous / degraded auth is reported by the board load instead.
        }
      }
      return json({
        ok: true,
        hostVersion: HOST_VERSION,
        glabPath,
        glabVersion,
        glabAvailable,
        ...(glabError !== null ? { glabError } : {}),
        host: host !== '' ? host : null,
        user,
        defaults: { repo: defaultRepo, boardId: defaultBoardId, statusScope: statusScope !== '' ? statusScope : null, pageSize, includeBacklog },
      })
    })

    route('projects', async (request) => {
      const body = await readBody(request)
      const search = typeof body.search === 'string' ? body.search.trim() : ''
      try {
        return json({ ok: true, projects: await searchProjects(search, { signal: request.signal }) })
      } catch (error) {
        return fail(error.code ?? 'projects', error.message ?? 'Could not list projects.', 502)
      }
    })

    route('board', async (request) => {
      const body = await readBody(request)
      const rawRepo = typeof body.repo === 'string' ? body.repo.trim() : ''
      const repo = normalizeRepo(rawRepo)
      if (repo === '') {
        return fail('no-repo', rawRepo === '' ? 'Choose a GitLab project first.' : 'That is not a valid project path; use group/sub/project.', 400)
      }
      const boardId = typeof body.boardId === 'string' || typeof body.boardId === 'number' ? String(body.boardId) : ''
      try {
        const payload = await loadBoard({ repo, boardId, signal: request.signal })
        return json({ ok: true, ...payload })
      } catch (error) {
        const code = error.code ?? 'board'
        return fail(code, error.message ?? 'Could not load the board.', code === 'no-glab' ? 503 : 502)
      }
    })

    route('session', async (request) => {
      const body = await readBody(request)
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
      let dir = typeof body.dir === 'string' ? body.dir.trim() : ''
      if (dir === '' && sessionId !== '') {
        const agents = scope.get('agents')
        const workingDirectory = scope.get('workingDirectory')
        const agent = agents !== undefined && typeof agents.get === 'function' ? agents.get(sessionId) : undefined
        if (agent !== undefined && workingDirectory !== undefined && typeof workingDirectory.get === 'function') {
          try {
            dir = workingDirectory.get(agent.session)
          } catch {
            dir = ''
          }
        }
      }
      if (dir === '') return fail('no-dir', 'Could not determine the working directory of this session.', 400)
      try {
        const resolved = await repoForDir(dir, { signal: request.signal })
        if (resolved === null) return fail('no-gitlab', 'This workspace has no GitLab origin remote.', 400)
        const boardId = typeof body.boardId === 'string' || typeof body.boardId === 'number' ? String(body.boardId) : ''
        const payload = await loadBoard({ repo: resolved.repo, boardId, signal: request.signal })
        return json({ ok: true, dir, repo: resolved.repo, remote: resolved.remote, ...payload })
      } catch (error) {
        const code = error.code ?? 'session-board'
        return fail(code, error.message ?? 'Could not load the project board.', code === 'no-glab' ? 503 : 502)
      }
    })

    route('issue', async (request) => {
      const body = await readBody(request)
      const repo = normalizeRepo(body.repo)
      const iid = Number(body.iid)
      if (repo === '' || !Number.isInteger(iid) || iid <= 0) return fail('bad-request', 'A project and issue number are required.')
      try {
        return json({ ok: true, issue: await issueDetail({ repo, iid, signal: request.signal }) })
      } catch (error) {
        return fail(error.code ?? 'issue', error.message ?? 'Could not read the issue.', 502)
      }
    })

    route('notes', async (request) => {
      const body = await readBody(request)
      const repo = normalizeRepo(body.repo)
      const iid = Number(body.iid)
      if (repo === '' || !Number.isInteger(iid) || iid <= 0) return fail('bad-request', 'A project and issue number are required.')
      try {
        return json({ ok: true, notes: await listNotes({ repo, iid, signal: request.signal }) })
      } catch (error) {
        return fail(error.code ?? 'notes', error.message ?? 'Could not read the issue comments.', 502)
      }
    })

    route('labels', async (request) => {
      const body = await readBody(request)
      const repo = normalizeRepo(body.repo)
      if (repo === '') return fail('no-repo', 'Choose a GitLab project first.')
      try {
        const project = await getProject(repo, { signal: request.signal })
        return json({ ok: true, labels: await listLabels(project.id, { signal: request.signal }) })
      } catch (error) {
        return fail(error.code ?? 'labels', error.message ?? 'Could not list labels.', 502)
      }
    })

    route('move', async (request) => {
      const body = await readBody(request)
      const repo = normalizeRepo(body.repo)
      const iid = Number(body.iid)
      const toLabel = typeof body.toLabel === 'string' ? body.toLabel.trim().slice(0, 255) : ''
      const fromLabels = Array.isArray(body.fromLabels) ? body.fromLabels.filter((label) => typeof label === 'string' && label.trim() !== '').map((label) => label.trim().slice(0, 255)) : []
      if (repo === '' || !Number.isInteger(iid) || iid <= 0) return fail('bad-request', 'A project and issue number are required.')
      try {
        return json({ ok: true, ...(await moveIssue({ repo, iid, toLabel, fromLabels, signal: request.signal })) })
      } catch (error) {
        return fail(error.code ?? 'move', error.message ?? 'Could not move the issue.', 502)
      }
    })

    route('create', async (request) => {
      const body = await readBody(request)
      const repo = normalizeRepo(body.repo)
      const title = typeof body.title === 'string' ? body.title.trim() : ''
      if (repo === '') return fail('no-repo', 'Choose a GitLab project first.')
      if (title === '') return fail('bad-request', 'An issue title is required.')
      const description = typeof body.description === 'string' ? body.description : ''
      const labels = Array.isArray(body.labels) ? body.labels.filter((label) => typeof label === 'string' && label.trim() !== '').map((label) => label.trim()) : []
      const assignee = typeof body.assignee === 'string' ? body.assignee.trim() : ''
      const dueDate = typeof body.dueDate === 'string' ? body.dueDate.trim() : ''
      const milestone = typeof body.milestone === 'string' ? body.milestone.trim() : ''
      try {
        return json({ ok: true, ...(await createIssue({ repo, title, description, labels, assignee, dueDate, milestone, signal: request.signal })) })
      } catch (error) {
        return fail(error.code ?? 'create', error.message ?? 'Could not create the issue.', 502)
      }
    })

    route('comment', async (request) => {
      const body = await readBody(request)
      const repo = normalizeRepo(body.repo)
      const iid = Number(body.iid)
      const message = typeof body.message === 'string' ? body.message.trim() : ''
      if (repo === '' || !Number.isInteger(iid) || iid <= 0) return fail('bad-request', 'A project and issue number are required.')
      if (message === '') return fail('bad-request', 'A comment body is required.')
      try {
        return json({ ok: true, ...(await commentIssue({ repo, iid, message, signal: request.signal })) })
      } catch (error) {
        return fail(error.code ?? 'comment', error.message ?? 'Could not add the comment.', 502)
      }
    })

    route('state', async (request) => {
      const body = await readBody(request)
      const repo = normalizeRepo(body.repo)
      const iid = Number(body.iid)
      const action = body.action === 'reopen' ? 'reopen' : body.action === 'close' ? 'close' : ''
      if (repo === '' || !Number.isInteger(iid) || iid <= 0) return fail('bad-request', 'A project and issue number are required.')
      if (action === '') return fail('bad-request', 'Action must be "close" or "reopen".')
      try {
        return json({ ok: true, ...(await setIssueState({ repo, iid, action, signal: request.signal })) })
      } catch (error) {
        return fail(error.code ?? 'state', error.message ?? 'Could not update the issue.', 502)
      }
    })
  })

  // One agent-facing tool over the same operations.
  ctx.inject(['tools'], (toolScope) => {
    const tool = {
      name: 'glab_kanban',
      description:
        'Work with GitLab issues through the local glab CLI: browse projects, list a project\u2019s issue boards and columns, read issues and their comments on a board, move an issue between label columns, create an issue, comment, or close/reopen one. Use it when the user wants to see or manage GitLab issues or the issue kanban board.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['projects', 'boards', 'board', 'session', 'issue', 'notes', 'labels', 'move', 'create', 'comment', 'state'],
            description: 'projects searches accessible projects; boards lists a project\u2019s boards; board returns columns with issues; session resolves a workspace directory\u2019s origin remote and returns its board; issue reads one issue; notes lists an issue\u2019s comments and activity; labels lists project labels; move changes a status label; create opens an issue; comment adds a note; state closes or reopens.',
          },
          repo: { type: 'string', description: 'Project path like group/sub/project (or numeric id). Required for every action except projects when a default repo exists.' },
          boardId: { type: 'string', description: 'Board id for action=board or action=session. Empty selects the project\u2019s first board.' },
          dir: { type: 'string', description: 'Workspace directory for action=session; the project is read from its origin remote.' },
          iid: { type: 'number', description: 'Issue number (IID) for issue, move, comment and state.' },
          search: { type: 'string', description: 'Search term for action=projects.' },
          toLabel: { type: 'string', description: 'Target status label for action=move.' },
          fromLabels: { type: 'array', items: { type: 'string' }, description: 'Status labels to remove for action=move.' },
          title: { type: 'string', description: 'Issue title for action=create.' },
          description: { type: 'string', description: 'Issue body for action=create.' },
          labels: { type: 'array', items: { type: 'string' }, description: 'Labels to add for action=create.' },
          assignee: { type: 'string', description: 'Assignee username for action=create.' },
          message: { type: 'string', description: 'Comment text for action=comment.' },
          state: { type: 'string', enum: ['close', 'reopen'], description: 'Target state for action=state.' },
          limit: { type: 'number', description: 'Max cards per column to return for action=board (default 20).' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      isConcurrencySafe: () => false,
      async execute(args) {
        const action = typeof args?.action === 'string' ? args.action : ''
        const repo = normalizeRepo(args?.repo) || defaultRepo
        const neededRepo = () => {
          if (repo === '') throw new GlabError('A repo (group/project) is required.', 'no-repo')
        }
        try {
          if (action === 'projects') {
            const search = typeof args?.search === 'string' ? args.search.trim() : ''
            return { ok: true, projects: await searchProjects(search) }
          }
          // `session` resolves its project from the workspace directory, so it needs no repo.
          if (action !== 'session') neededRepo()
          if (action === 'boards') {
            const project = await getProject(repo)
            const boards = await listBoards(project.id)
            return { ok: true, project, boards }
          }
          if (action === 'board') {
            const boardId = args?.boardId !== undefined && args.boardId !== null ? String(args.boardId) : ''
            const limit = Number.isInteger(args?.limit) && args.limit > 0 ? Math.min(args.limit, 100) : 20
            const payload = await loadBoard({ repo, boardId })
            return {
              ok: true,
              project: payload.project,
              boardId: payload.boardId,
              boardName: payload.boardName,
              source: payload.source,
              columns: payload.columns.map((column) => ({
                id: column.id,
                label: column.label,
                title: column.title ?? null,
                movable: column.movable === true,
                count: column.count,
                truncated: column.truncated,
                issues: column.issues.slice(0, limit).map((card) => ({
                  iid: card.iid,
                  title: card.title,
                  labels: card.labels.map((label) => label.name),
                  assignees: card.assignees.map((user) => user.username),
                  milestone: card.milestone,
                  dueDate: card.dueDate,
                  webUrl: card.webUrl,
                })),
              })),
            }
          }
          if (action === 'session') {
            const dir = typeof args?.dir === 'string' ? args.dir.trim() : ''
            if (dir === '') return { ok: false, error: 'A workspace directory (dir) is required for action=session.' }
            const resolved = await repoForDir(dir)
            if (resolved === null) return { ok: false, error: 'That workspace has no GitLab origin remote.' }
            const payload = await loadBoard({ repo: resolved.repo })
            return {
              ok: true,
              repo: resolved.repo,
              remote: resolved.remote,
              boardId: payload.boardId,
              boardName: payload.boardName,
              columns: payload.columns.map((column) => ({ id: column.id, label: column.label, title: column.title ?? null, count: column.count, movable: column.movable === true })),
            }
          }
          if (action === 'issue') {
            const iid = Number(args?.iid)
            if (!Number.isInteger(iid) || iid <= 0) return { ok: false, error: 'A positive issue number (iid) is required.' }
            const issue = await issueDetail({ repo, iid })
            return { ok: true, issue: { ...issue, description: issue.description.slice(0, 4000) } }
          }
          if (action === 'notes') {
            const iid = Number(args?.iid)
            if (!Number.isInteger(iid) || iid <= 0) return { ok: false, error: 'A positive issue number (iid) is required.' }
            const notes = await listNotes({ repo, iid })
            return { ok: true, count: notes.length, notes: notes.map((note) => ({ id: note.id, system: note.system, author: note.author?.username ?? null, createdAt: note.createdAt, body: note.body.slice(0, 2000) })) }
          }
          if (action === 'labels') {
            const project = await getProject(repo)
            return { ok: true, labels: await listLabels(project.id) }
          }
          if (action === 'move') {
            const iid = Number(args?.iid)
            const toLabel = typeof args?.toLabel === 'string' ? args.toLabel.trim() : ''
            const fromLabels = Array.isArray(args?.fromLabels) ? args.fromLabels.filter((label) => typeof label === 'string' && label.trim() !== '').map((label) => label.trim()) : []
            if (!Number.isInteger(iid) || iid <= 0) return { ok: false, error: 'A positive issue number (iid) is required.' }
            if (toLabel === '' && fromLabels.length === 0) return { ok: false, error: 'Provide toLabel and/or fromLabels to move the issue.' }
            return { ok: true, ...(await moveIssue({ repo, iid, toLabel, fromLabels })) }
          }
          if (action === 'create') {
            const title = typeof args?.title === 'string' ? args.title.trim() : ''
            if (title === '') return { ok: false, error: 'A title is required.' }
            const labels = Array.isArray(args?.labels) ? args.labels.filter((label) => typeof label === 'string' && label.trim() !== '').map((label) => label.trim()) : []
            return { ok: true, ...(await createIssue({ repo, title, description: typeof args?.description === 'string' ? args.description : '', labels, assignee: typeof args?.assignee === 'string' ? args.assignee.trim() : '', dueDate: '', milestone: '' })) }
          }
          if (action === 'comment') {
            const iid = Number(args?.iid)
            const message = typeof args?.message === 'string' ? args.message.trim() : ''
            if (!Number.isInteger(iid) || iid <= 0) return { ok: false, error: 'A positive issue number (iid) is required.' }
            if (message === '') return { ok: false, error: 'A comment body is required.' }
            return { ok: true, ...(await commentIssue({ repo, iid, message })) }
          }
          if (action === 'state') {
            const iid = Number(args?.iid)
            const state = args?.state === 'reopen' ? 'reopen' : args?.state === 'close' ? 'close' : ''
            if (!Number.isInteger(iid) || iid <= 0) return { ok: false, error: 'A positive issue number (iid) is required.' }
            if (state === '') return { ok: false, error: 'state must be "close" or "reopen".' }
            return { ok: true, ...(await setIssueState({ repo, iid, action: state })) }
          }
          return { ok: false, error: `Unknown action "${action}".` }
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
      },
    }
    const toolsService = toolScope.get('tools')
    if (toolsService === undefined || typeof toolsService.register !== 'function') return
    toolScope.effect(() => toolsService.register(tool), 'dsh-glab-kanban: glab_kanban tool')
  })
}
