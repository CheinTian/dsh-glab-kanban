window.__ModuleLoader__.load({
  id: 'dsh-glab-kanban',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    /** Sidebar panel id; the same id addresses the main panel. */
    const PANEL_ID = 'glab-kanban'
    /** Prefix of the Host routes this panel calls. */
    const BASE_PATH = 'api/dsh-glab-kanban'
    /** UI preferences (last project + board) survive a reload. */
    const STORE_KEY = 'dsh-glab-kanban:v1'
    /** A project path (`group/sub`) or numeric id, mirroring the Host validation. */
    const REPO_RE = /^(?:\d+|[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)+)$/
    /** Recently opened projects, newest first, for the picker. */
    const RECENT_KEY = 'dsh-glab-kanban:recent'

    /* ------------------------------------------------------------------ */
    /* Small pure helpers                                                  */
    /* ------------------------------------------------------------------ */

    function readSelection() {
      try {
        const raw = window.localStorage.getItem(STORE_KEY)
        if (raw === null) return {}
        const value = JSON.parse(raw)
        return value !== null && typeof value === 'object' ? value : {}
      } catch {
        return {}
      }
    }

    function writeSelection(patch) {
      try {
        window.localStorage.setItem(STORE_KEY, JSON.stringify({ ...readSelection(), ...patch }))
      } catch {
        /* Storage may be unavailable; selection then lasts for this page only. */
      }
    }

    /** Text after the last `::`, so `任务状态::开发中` reads as "开发中". */
    function shortLabel(name) {
      if (typeof name !== 'string') return ''
      const index = name.lastIndexOf('::')
      return index === -1 ? name : name.slice(index + 2)
    }

    /** Read the recently opened projects, newest first. */
    function readRecent() {
      try {
        const raw = window.localStorage.getItem(RECENT_KEY)
        if (raw === null) return []
        const value = JSON.parse(raw)
        return Array.isArray(value)
          ? value.filter((item) => item !== null && typeof item === 'object' && typeof item.path === 'string' && REPO_RE.test(item.path)).slice(0, 8)
          : []
      } catch {
        return []
      }
    }

    /** Remember a successfully opened project for the picker. */
    function rememberProject(project) {
      if (project === null || typeof project !== 'object' || typeof project.path !== 'string' || !REPO_RE.test(project.path)) return
      try {
        const entry = { path: project.path, name: typeof project.name === 'string' && project.name !== '' ? project.name : project.path }
        const next = [entry, ...readRecent().filter((item) => item.path !== entry.path)].slice(0, 8)
        window.localStorage.setItem(RECENT_KEY, JSON.stringify(next))
      } catch {
        /* Recents are an enhancement; ignore unavailable storage. */
      }
    }

    /** Group labels by their `scope::` prefix so the composer stays scan-able. */
    function groupLabels(labels) {
      const groups = new Map()
      for (const label of labels) {
        const index = label.name.indexOf('::')
        const scope = index === -1 ? '' : label.name.slice(0, index)
        if (!groups.has(scope)) groups.set(scope, [])
        groups.get(scope).push(label)
      }
      return [...groups.entries()].sort((a, b) => (a[0] === '' ? 1 : 0) - (b[0] === '' ? 1 : 0) || a[0].localeCompare(b[0]))
    }

    /** `#rrggbb` → `rgba(...)`; leaves non-hex values untouched. */
    function hexToRgba(hex, alpha) {
      if (typeof hex !== 'string') return `rgba(150,150,150,${alpha})`
      const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
      if (match === null) return `rgba(150,150,150,${alpha})`
      const value = parseInt(match[1], 16)
      const r = (value >> 16) & 255
      const g = (value >> 8) & 255
      const b = value & 255
      return `rgba(${r},${g},${b},${alpha})`
    }

    function initials(name) {
      const text = String(name ?? '').trim()
      if (text === '') return '?'
      return text.slice(0, 1).toUpperCase()
    }

    function fmtDate(iso) {
      if (typeof iso !== 'string' || iso.length < 10) return ''
      return iso.slice(0, 10)
    }

    function timeAgo(iso, t) {
      if (typeof iso !== 'string') return ''
      const then = new Date(iso).getTime()
      if (Number.isNaN(then)) return ''
      const seconds = Math.floor((Date.now() - then) / 1000)
      if (seconds < 60) return t('time.now')
      const minutes = Math.floor(seconds / 60)
      if (minutes < 60) return t('time.minutes', { n: minutes })
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return t('time.hours', { n: hours })
      const days = Math.floor(hours / 24)
      if (days < 30) return t('time.days', { n: days })
      const months = Math.floor(days / 30)
      if (months < 12) return t('time.months', { n: months })
      return t('time.years', { n: Math.floor(months / 12) })
    }

    /** Deterministic hue for a name-based initials avatar. */
    function hueOf(text) {
      let hash = 0
      const value = String(text ?? '')
      for (let index = 0; index < value.length; index++) hash = (hash * 31 + value.charCodeAt(index)) % 360
      return hash
    }

    /** Resolve a GitLab-relative asset URL against the project's web URL. */
    function assetUrl(url, projectWebUrl) {
      if (typeof url !== 'string' || url === '') return ''
      if (/^https?:\/\//i.test(url)) return url
      const base = typeof projectWebUrl === 'string' && projectWebUrl !== '' ? projectWebUrl.replace(/\/+$/, '') : ''
      if (base === '') return url
      if (url.startsWith('/uploads/')) return `${base}${url}`
      if (url.startsWith('/')) {
        try {
          return `${new URL(base).origin}${url}`
        } catch {
          return `${base}${url}`
        }
      }
      return `${base}/${url}`
    }

    /** Split image syntax out of Markdown so private uploads render as links. */
    function extractImages(markdown, projectWebUrl) {
      const images = []
      let text = String(markdown ?? '')
      text = text.replace(/!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g, (_match, alt, url) => {
        images.push({ alt: alt || '', url: assetUrl(url, projectWebUrl) })
        return ''
      })
      text = text.replace(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi, (_match, url) => {
        images.push({ alt: '', url: assetUrl(url, projectWebUrl) })
        return ''
      })
      return { text, images }
    }

    /** Inline Markdown spans: code, bold, italic, links, bare URLs and issue refs. */
    function inlineNodes(text, keyPrefix, projectWebUrl) {
      const source = String(text ?? '')
      const pattern = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\([^)\s]+\))|(https?:\/\/[^\s<]+)|(\B#\d+\b)/g
      const nodes = []
      let last = 0
      let index = 0
      let match
      while ((match = pattern.exec(source)) !== null) {
        if (match.index > last) nodes.push(source.slice(last, match.index))
        const token = match[0]
        if (match[1] !== undefined) {
          nodes.push(h('code', { key: `${keyPrefix}c${index++}`, className: 'dsh-gk-md-code' }, token.slice(1, -1)))
        } else if (match[2] !== undefined) {
          nodes.push(h('strong', { key: `${keyPrefix}b${index++}` }, token.slice(2, -2)))
        } else if (match[3] !== undefined) {
          nodes.push(h('em', { key: `${keyPrefix}i${index++}` }, token.slice(1, -1)))
        } else if (match[4] !== undefined) {
          const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token)
          if (link === null) nodes.push(token)
          else nodes.push(h('a', { key: `${keyPrefix}a${index++}`, href: assetUrl(link[2], projectWebUrl), target: '_blank', rel: 'noreferrer noopener' }, link[1]))
        } else if (match[5] !== undefined) {
          nodes.push(h('a', { key: `${keyPrefix}u${index++}`, href: token, target: '_blank', rel: 'noreferrer noopener' }, token))
        } else {
          nodes.push(h('span', { key: `${keyPrefix}r${index++}`, className: 'dsh-gk-md-ref' }, token))
        }
        last = match.index + token.length
      }
      if (last < source.length) nodes.push(source.slice(last))
      return nodes
    }

    /** A compact Markdown renderer for issue and comment bodies. */
    function renderMarkdown(text, keyPrefix, projectWebUrl) {
      const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n')
      const blocks = []
      let index = 0
      let key = 0
      const isBlank = (line) => /^\s*$/.test(line)
      while (index < lines.length) {
        const line = lines[index]
        if (isBlank(line)) {
          index += 1
          continue
        }
        const fence = /^```(.*)$/.exec(line)
        if (fence !== null) {
          const body = []
          index += 1
          while (index < lines.length && !/^```/.test(lines[index])) {
            body.push(lines[index])
            index += 1
          }
          index += 1
          blocks.push(h('pre', { key: `${keyPrefix}pre${key++}`, className: 'dsh-gk-md-pre' }, h('code', null, body.join('\n'))))
          continue
        }
        const heading = /^(#{1,6})\s+(.*)$/.exec(line)
        if (heading !== null) {
          blocks.push(h(heading[1].length <= 2 ? 'h3' : 'h4', { key: `${keyPrefix}h${key++}`, className: 'dsh-gk-md-h' }, inlineNodes(heading[2], `${keyPrefix}h${key}`, projectWebUrl)))
          index += 1
          continue
        }
        if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
          blocks.push(h('hr', { key: `${keyPrefix}hr${key++}`, className: 'dsh-gk-md-hr' }))
          index += 1
          continue
        }
        if (/^>\s?/.test(line)) {
          const body = []
          while (index < lines.length && /^>\s?/.test(lines[index])) {
            body.push(lines[index].replace(/^>\s?/, ''))
            index += 1
          }
          blocks.push(h('blockquote', { key: `${keyPrefix}q${key++}`, className: 'dsh-gk-md-quote' }, renderMarkdown(body.join('\n'), `${keyPrefix}q${key}`, projectWebUrl)))
          continue
        }
        if (/^[-*]\s+/.test(line)) {
          const items = []
          while (index < lines.length && /^[-*]\s+/.test(lines[index])) {
            items.push(lines[index].replace(/^[-*]\s+/, ''))
            index += 1
          }
          blocks.push(
            h('ul', { key: `${keyPrefix}ul${key++}`, className: 'dsh-gk-md-list' },
              items.map((item, itemIndex) => {
                const task = /^\[([ xX])\]\s+(.*)$/.exec(item)
                if (task === null) return h('li', { key: itemIndex }, inlineNodes(item, `${keyPrefix}li${key}${itemIndex}`, projectWebUrl))
                const done = task[1].toLowerCase() === 'x'
                return h('li', { key: itemIndex, className: 'dsh-gk-md-task' }, h('span', { className: `dsh-gk-md-check${done ? ' is-done' : ''}` }, done ? '✓' : ''), inlineNodes(task[2], `${keyPrefix}lt${key}${itemIndex}`, projectWebUrl))
              })),
          )
          continue
        }
        if (/^\d+[.)]\s+/.test(line)) {
          const items = []
          while (index < lines.length && /^\d+[.)]\s+/.test(lines[index])) {
            items.push(lines[index].replace(/^\d+[.)]\s+/, ''))
            index += 1
          }
          blocks.push(h('ol', { key: `${keyPrefix}ol${key++}`, className: 'dsh-gk-md-list' }, items.map((item, itemIndex) => h('li', { key: itemIndex }, inlineNodes(item, `${keyPrefix}o${key}${itemIndex}`, projectWebUrl)))))
          continue
        }
        const paragraph = []
        while (index < lines.length && !isBlank(lines[index]) && !/^```/.test(lines[index]) && !/^(#{1,6})\s+/.test(lines[index]) && !/^>\s?/.test(lines[index]) && !/^[-*]\s+/.test(lines[index]) && !/^\d+[.)]\s+/.test(lines[index])) {
          paragraph.push(lines[index])
          index += 1
        }
        const children = []
        paragraph.forEach((part, partIndex) => {
          if (partIndex > 0) children.push(h('br', { key: `${keyPrefix}br${key}${partIndex}` }))
          children.push(...inlineNodes(part, `${keyPrefix}p${key}${partIndex}`, projectWebUrl))
        })
        blocks.push(h('p', { key: `${keyPrefix}p${key++}`, className: 'dsh-gk-md-p' }, children))
      }
      return blocks
    }

    /** One attachment row: GitLab uploads need the GitLab web session, so link them. */
    function AttachmentList({ images, t }) {
      if (!Array.isArray(images) || images.length === 0) return null
      return h('div', { className: 'dsh-gk-attachments' },
        images.map((image, index) => {
          let name = image.alt
          if (name === '') {
            try {
              name = decodeURIComponent((image.url.split('/').pop() ?? 'image').split('?')[0])
            } catch {
              name = 'image'
            }
          }
          return h('a', { key: index, className: 'dsh-gk-attachment', href: image.url, target: '_blank', rel: 'noreferrer noopener', title: image.url },
            h('span', { className: 'dsh-gk-attachment-icon' }, h(ICON.image, null)),
            h('span', { className: 'dsh-gk-attachment-name' }, name),
            h(ICON.external, null))
        }))
    }

    /** One human comment in the issue timeline. */
    function CommentItem({ note, projectWebUrl, t }) {
      const body = extractImages(note.body, projectWebUrl)
      return h('div', { className: 'dsh-gk-comment' },
        h(Avatar, { user: note.author, size: 24 }),
        h('div', { className: 'dsh-gk-comment-main' },
          h('div', { className: 'dsh-gk-comment-head' },
            h('span', { className: 'dsh-gk-comment-author' }, note.author?.name ?? note.author?.username ?? ''),
            h('span', { className: 'dsh-gk-comment-time' }, timeAgo(note.createdAt, t))),
          h('div', { className: 'dsh-gk-comment-body' }, body.text.trim() !== '' ? renderMarkdown(body.text, `n${note.id}`, projectWebUrl) : null),
          h(AttachmentList, { images: body.images, t })))
    }

    /** POST one JSON payload to a plugin route and normalize the result. */
    async function post(path, body) {
      let response
      try {
        response = await fetch(`${BASE_PATH}/${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        })
      } catch (error) {
        return { ok: false, error: { code: 'transport', message: String(error?.message ?? error) } }
      }
      let payload
      try {
        payload = await response.json()
      } catch {
        const message =
          response.status === 404
            ? `HTTP 404 for ${BASE_PATH}/${path}: the plugin's Host routes are not registered. Reinstall the bundle (or restart Harness) so the Host half loads.`
            : `HTTP ${response.status} for ${BASE_PATH}/${path} with no JSON body.`
        return { ok: false, error: { code: 'transport', message } }
      }
      if (payload !== null && typeof payload === 'object' && payload.ok === true) return { ok: true, data: payload }
      const error = payload !== null && typeof payload === 'object' && payload.error !== null && typeof payload.error === 'object' ? payload.error : {}
      return { ok: false, error: { code: typeof error.code === 'string' ? error.code : 'unknown', message: typeof error.message === 'string' ? error.message : `HTTP ${response.status}` } }
    }

    /* ------------------------------------------------------------------ */
    /* Inline icons drawn on one grid — no emoji stand-ins                  */
    /* ------------------------------------------------------------------ */

    const ICON = {
      search: (p) =>
        h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, ...p },
          h('circle', { cx: 7, cy: 7, r: 4.4, stroke: 'currentColor', strokeWidth: 1.4 }),
          h('path', { d: 'm10.4 10.4 3.2 3.2', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' })),
      close: (p) =>
        h('svg', { width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, ...p },
          h('path', { d: 'm4 4 8 8M12 4l-8 8', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' })),
      refresh: (p) =>
        h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, ...p },
          h('path', { d: 'M13 7a5 5 0 1 0-.4 3', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
          h('path', { d: 'M13 3.4V7H9.4', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' })),
      plus: (p) =>
        h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, ...p },
          h('path', { d: 'M8 3.2v9.6M3.2 8h9.6', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' })),
      external: (p) =>
        h('svg', { width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, ...p },
          h('path', { d: 'M6.4 3.2H3.2v9.6h9.6V9.6M9.2 3.2h3.6v3.6M12.8 3.2 7.4 8.6', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' })),
      note: (p) =>
        h('svg', { width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, ...p },
          h('path', { d: 'M3 3.6h10v7.2H8l-2.6 2V10.8H3z', stroke: 'currentColor', strokeWidth: 1.3, strokeLinejoin: 'round' })),
      calendar: (p) =>
        h('svg', { width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, ...p },
          h('rect', { x: 2.8, y: 3.4, width: 10.4, height: 9.2, rx: 1.6, stroke: 'currentColor', strokeWidth: 1.3 }),
          h('path', { d: 'M2.8 6.4h10.4M5.6 2.4v2M10.4 2.4v2', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' })),
      flag: (p) =>
        h('svg', { width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, ...p },
          h('path', { d: 'M4 14V2.6h7.4l-1.4 2.6 1.4 2.6H4', stroke: 'currentColor', strokeWidth: 1.3, strokeLinejoin: 'round' })),
      chevronDown: (p) =>
        h('svg', { width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, ...p },
          h('path', { d: 'm4 6 4 4 4-4', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' })),
      folder: (p) =>
        h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, ...p },
          h('path', { d: 'M2.2 4.4h4l1.4 1.6h6.2v6.2a1 1 0 0 1-1 1H3.2a1 1 0 0 1-1-1z', stroke: 'currentColor', strokeWidth: 1.3, strokeLinejoin: 'round' })),
      board: (p) =>
        h('svg', { width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, ...p },
          h('rect', { x: 2.4, y: 3, width: 3.1, height: 10, rx: 1, stroke: 'currentColor', strokeWidth: 1.2 }),
          h('rect', { x: 6.45, y: 3, width: 3.1, height: 7, rx: 1, stroke: 'currentColor', strokeWidth: 1.2 }),
          h('rect', { x: 10.5, y: 3, width: 3.1, height: 8.4, rx: 1, stroke: 'currentColor', strokeWidth: 1.2 })),
      grip: (p) =>
        h('svg', { width: 12, height: 12, viewBox: '0 0 16 16', fill: 'currentColor', 'aria-hidden': true, ...p },
          [[5.5, 4], [10.5, 4], [5.5, 8], [10.5, 8], [5.5, 12], [10.5, 12]].map(([cx, cy], index) => h('circle', { key: index, cx, cy, r: 1.2 }))),
      image: (p) =>
        h('svg', { width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, ...p },
          h('rect', { x: 2.4, y: 3, width: 11.2, height: 10, rx: 1.6, stroke: 'currentColor', strokeWidth: 1.3 }),
          h('circle', { cx: 6, cy: 6.4, r: 1.2, fill: 'currentColor' }),
          h('path', { d: 'M3 12.2 6.6 8.8l2.4 2.2 1.9-1.7L13.6 12', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' })),
      history: (p) =>
        h('svg', { width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, ...p },
          h('circle', { cx: 8, cy: 8, r: 5.6, stroke: 'currentColor', strokeWidth: 1.3 }),
          h('path', { d: 'M8 4.8V8l2.2 1.4', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' })),
      chevronRight: (p) =>
        h('svg', { width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, ...p },
          h('path', { d: 'm6 4 4 4-4 4', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' })),
      check: (p) =>
        h('svg', { width: 11, height: 11, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, ...p },
          h('path', { d: 'm3.4 8.3 3 3 6.2-6.6', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' })),
    }

    /** A three-column board glyph used for the sidebar and headings. */
    function Glyph({ size = 20 }) {
      const card = (x) => h('rect', { x, y: 6.5, width: 3.1, height: 5.4, rx: 1, fill: 'currentColor', opacity: 0.9 })
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true, focusable: false, style: { display: 'block' } },
        h('rect', { x: 3.2, y: 4.2, width: 5, height: 15.6, rx: 1.6, stroke: 'currentColor', strokeWidth: 1.5, opacity: 0.5 }),
        h('rect', { x: 9.5, y: 4.2, width: 5, height: 11.6, rx: 1.6, stroke: 'currentColor', strokeWidth: 1.5, opacity: 0.5 }),
        h('rect', { x: 15.8, y: 4.2, width: 5, height: 13.6, rx: 1.6, stroke: 'currentColor', strokeWidth: 1.5, opacity: 0.5 }),
        card(4.3), card(10.6), card(16.9))
    }

    /* ------------------------------------------------------------------ */
    /* Presentational atoms                                                */
    /* ------------------------------------------------------------------ */

    function Avatar({ user, size = 20 }) {
      const [failed, setFailed] = useState(false)
      const label = user?.name ?? user?.username ?? ''
      const style = { width: size, height: size, borderRadius: 999, flex: 'none' }
      // GitLab-hosted avatars need the instance's browser session, which this page
      // does not have, so only public Gravatar images are loaded and every other
      // person gets a stable initials avatar.
      const gravatar = typeof user?.avatar === 'string' && /gravatar\.com/i.test(user.avatar)
      if (gravatar && !failed) {
        return h('img', { className: 'dsh-gk-avatar', src: user.avatar, alt: '', referrerPolicy: 'no-referrer', title: label, style, onError: () => setFailed(true) })
      }
      const hue = hueOf(user?.username ?? label)
      return h('span', {
        className: 'dsh-gk-avatar dsh-gk-avatar-fallback',
        title: label,
        style: {
          ...style,
          fontSize: Math.round(size * 0.46),
          background: `color-mix(in srgb, hsl(${hue} 65% 52%) 24%, var(--dsw-alias-bg-layer-1))`,
          color: 'var(--dsw-alias-label-primary)',
        },
      }, initials(label))
    }

    function LabelChip({ label }) {
      const color = label.color ?? '#9aa0a6'
      return h('span', {
        className: 'dsh-gk-label',
        title: label.name,
        style: { backgroundColor: hexToRgba(color, 0.15), borderColor: hexToRgba(color, 0.4) },
      }, shortLabel(label.name))
    }

    function Card({ card, column, t, dragging, onOpen, onDragStart, onDragEnd }) {
      const shown = card.labels.slice(0, 3)
      const extra = card.labels.length - shown.length
      const assignees = card.assignees.slice(0, 3)
      const extraPeople = card.assignees.length - assignees.length
      return h('article', {
        className: `dsh-gk-card${dragging ? ' is-dragging' : ''}`,
        draggable: column.movable === true,
        onDragStart: column.movable ? (event) => onDragStart(event, card, column) : undefined,
        onDragEnd: column.movable ? onDragEnd : undefined,
        onClick: () => onOpen(card.iid),
        onKeyDown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onOpen(card.iid)
          }
        },
        role: 'button',
        tabIndex: 0,
        title: card.title,
      },
        h('div', { className: 'dsh-gk-card-top' },
          h('span', { className: 'dsh-gk-card-iid' }, `#${card.iid}`),
          card.notes > 0 ? h('span', { className: 'dsh-gk-card-notes' }, h(ICON.note, null), String(card.notes)) : null,
          column.movable ? h('span', { className: 'dsh-gk-grip', title: t('card.drag'), 'aria-hidden': true }, h(ICON.grip, null)) : null),
        h('div', { className: 'dsh-gk-card-title' }, card.title),
        shown.length > 0
          ? h('div', { className: 'dsh-gk-card-labels' }, shown.map((label) => h(LabelChip, { key: label.name, label })), extra > 0 ? h('span', { className: 'dsh-gk-more' }, `+${extra}`) : null)
          : null,
        h('div', { className: 'dsh-gk-card-foot' },
          h('span', { className: 'dsh-gk-avatars' },
            assignees.map((user) => h(Avatar, { key: user.username, user, size: 18 })),
            extraPeople > 0 ? h('span', { className: 'dsh-gk-avatar-more' }, `+${extraPeople}`) : null),
          h('span', { className: 'dsh-gk-card-spacer' }),
          card.milestone ? h('span', { className: 'dsh-gk-meta', title: `${card.milestone}` }, h(ICON.flag, null), card.milestone) : null,
          card.dueDate ? h('span', { className: 'dsh-gk-meta', title: card.dueDate }, h(ICON.calendar, null), fmtDate(card.dueDate)) : null,
          card.updatedAt ? h('span', { className: 'dsh-gk-meta' }, timeAgo(card.updatedAt, t)) : null))
    }

    /* ------------------------------------------------------------------ */
    /* The panel                                                           */
    /* ------------------------------------------------------------------ */

    function KanbanPanel(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key
      // A `conversation.view` entry passes `sessionId`; the sidebar panel does not.
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      const sessionBound = sessionId !== ''
      const workspacesSnapshot = typeof props.useWorkspaces === 'function' ? props.useWorkspaces((state) => state) : null
      const workspaceList = Array.isArray(workspacesSnapshot?.workspaces)
        ? workspacesSnapshot.workspaces
        : Array.isArray(workspacesSnapshot?.list)
          ? workspacesSnapshot.list
          : []
      const workspaceDir = (() => {
        if (sessionId === '') return ''
        const mine = workspaceList.find((workspace) => Array.isArray(workspace?.sessionIds) && workspace.sessionIds.includes(sessionId))
        return typeof mine?.path === 'string' ? mine.path : ''
      })()

      const [status, setStatus] = useState(null)
      const [statusError, setStatusError] = useState(null)
      const [repo, setRepo] = useState('')
      const [boardId, setBoardId] = useState('')
      const [data, setData] = useState(null)
      const [loading, setLoading] = useState(false)
      const [boardError, setBoardError] = useState(null)
      const [notice, setNotice] = useState(null)

      const [query, setQuery] = useState('')
      const [onlyMine, setOnlyMine] = useState(false)
      const [assigneeFilter, setAssigneeFilter] = useState('')

      const [repoPicker, setRepoPicker] = useState(false)
      const [projectList, setProjectList] = useState(null)
      const [projQuery, setProjQuery] = useState('')
      const [projBusy, setProjBusy] = useState(false)
      const [manualRepo, setManualRepo] = useState('')
      const [pickerError, setPickerError] = useState(null)

      const [detail, setDetail] = useState(null)
      const [commentDraft, setCommentDraft] = useState('')
      const [detailBusy, setDetailBusy] = useState(null)
      const [detailNotice, setDetailNotice] = useState(null)
      const [notes, setNotes] = useState(null)
      const [notesLoading, setNotesLoading] = useState(false)
      const [notesError, setNotesError] = useState(null)

      const [composer, setComposer] = useState(null)
      const [composerError, setComposerError] = useState(null)
      const [composerBusy, setComposerBusy] = useState(false)
      const [cTitle, setCTitle] = useState('')
      const [cDesc, setCDesc] = useState('')
      const [cAssignee, setCAssignee] = useState('')
      const [cDue, setCDue] = useState('')
      const [cLabels, setCLabels] = useState([])
      const [labelQuery, setLabelQuery] = useState('')

      const [drag, setDrag] = useState(null)
      const [dragOver, setDragOver] = useState(null)
      const suppressClick = useRef(false)
      const lastFocus = useRef(null)
      const detailSeq = useRef(0)

      /** Close the drawer and invalidate any in-flight detail read. */
      const closeDetail = useCallback(() => {
        detailSeq.current += 1
        setDetail(null)
      }, [])

      const mounted = useRef(true)
      useEffect(() => {
        mounted.current = true
        return () => {
          mounted.current = false
        }
      }, [])

      const loadStatus = useCallback(async () => {
        const result = await post('status', {})
        if (!mounted.current) return null
        if (result.ok) {
          setStatus(result.data)
          setStatusError(null)
          return result.data
        }
        setStatusError(result.error)
        return null
      }, [])

      const loadBoard = useCallback(async (repoArg, boardArg) => {
        const target = String(repoArg ?? '').trim()
        if (target === '') return
        setLoading(true)
        setBoardError(null)
        const result = await post('board', { repo: target, boardId: boardArg ?? '' })
        if (!mounted.current) return
        setLoading(false)
        if (!result.ok) {
          setBoardError(result.error)
          setData(null)
          return
        }
        setData(result.data)
        rememberProject(result.data.project)
        if ((boardArg ?? '') === '' && result.data.boardId) {
          setBoardId(result.data.boardId)
          writeSelection({ repo: result.data.project.path, boardId: result.data.boardId })
        } else if (result.data.project?.path) {
          writeSelection({ repo: result.data.project.path, boardId: result.data.boardId ?? '' })
        }
      }, [])

      /** Load the board bound to one session's workspace project. */
      const loadSessionBoard = useCallback(async (sid, boardArg) => {
        if (sid === '') return
        setLoading(true)
        setBoardError(null)
        const result = await post('session', { sessionId: sid, dir: workspaceDir, boardId: boardArg ?? '' })
        if (!mounted.current) return
        setLoading(false)
        if (!result.ok) {
          setBoardError(result.error)
          setData(null)
          return
        }
        setData(result.data)
        rememberProject(result.data.project)
        setRepo(result.data.repo)
        setBoardId(result.data.boardId ?? '')
      }, [workspaceDir])

      // Open the project picker; the debounced effect below loads its first page.
      const openRepoPickerInternal = useCallback(() => {
        lastFocus.current = document.activeElement
        setRepoPicker(true)
        setProjBusy(true)
        setProjectList(null)
        setPickerError(null)
        setProjQuery('')
        setManualRepo('')
      }, [])

      /** Arm the panel from a loaded status payload. */
      const armFromStatus = useCallback((info) => {
        if (info === null) return
        if (info.glabAvailable === false || info.user === null) return
        if (sessionBound) {
          loadSessionBoard(sessionId)
          return
        }
        const saved = readSelection()
        const initialRepo = String(saved.repo || info.defaults?.repo || '').trim()
        const initialBoard = String(saved.boardId || info.defaults?.boardId || '')
        if (initialRepo !== '') {
          setRepo(initialRepo)
          setBoardId(initialBoard)
          loadBoard(initialRepo, initialBoard)
        } else {
          openRepoPickerInternal()
        }
      }, [loadBoard, openRepoPickerInternal, sessionBound, sessionId, loadSessionBoard])

      const retryStatus = useCallback(async () => {
        setStatus(null)
        setStatusError(null)
        const info = await loadStatus()
        if (!mounted.current) return
        armFromStatus(info)
      }, [loadStatus, armFromStatus])

      // Initial boot: load host status, then restore the last project or ask for one.
      useEffect(() => {
        let alive = true
        ;(async () => {
          const info = await loadStatus()
          if (!alive) return
          armFromStatus(info)
        })()
        return () => {
          alive = false
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      // Reload when the active conversation changes while this View stays mounted.
      const firstSessionRun = useRef(true)
      useEffect(() => {
        if (!sessionBound) return
        if (firstSessionRun.current) {
          firstSessionRun.current = false
          return
        }
        loadSessionBoard(sessionId)
      }, [sessionId, sessionBound, loadSessionBoard])

      // One-shot success notices clear themselves.
      useEffect(() => {
        if (notice === null) return undefined
        const handle = setTimeout(() => setNotice(null), 4000)
        return () => clearTimeout(handle)
      }, [notice])

      // Restore focus to the opener when the last overlay closes.
      const overlayOpen = detail !== null || composer !== null || repoPicker
      useEffect(() => {
        if (overlayOpen) return
        const opener = lastFocus.current
        lastFocus.current = null
        if (opener !== null && typeof opener.focus === 'function') opener.focus()
      }, [overlayOpen])

      // Escape closes the topmost overlay (composer, then detail, then repo picker).
      useEffect(() => {
        if (detail === null && composer === null && !repoPicker) return undefined
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          if (composer !== null) setComposer(null)
          else if (detail !== null) closeDetail()
          else if (repoPicker) setRepoPicker(false)
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
      }, [detail, composer, repoPicker, closeDetail])

      // Debounced project search inside the picker.
      useEffect(() => {
        if (!repoPicker) return undefined
        const handle = setTimeout(() => {
          setProjBusy(true)
          post('projects', { search: projQuery.trim() }).then((result) => {
            if (!mounted.current) return
            setProjBusy(false)
            setProjectList(result.ok ? result.data.projects : [])
            setPickerError(result.ok ? null : result.error.message)
          })
        }, 300)
        return () => clearTimeout(handle)
      }, [projQuery, repoPicker])

      const selectRepo = useCallback(
        (path) => {
          const clean = String(path ?? '').trim()
          if (clean === '') return
          setRepo(clean)
          setBoardId('')
          setData(null)
          setRepoPicker(false)
          setNotice(null)
          setPickerError(null)
          setQuery('')
          setOnlyMine(false)
          setAssigneeFilter('')
          closeDetail()
          setComposer(null)
          loadBoard(clean, '')
        },
        [loadBoard],
      )

      const reload = useCallback(() => {
        if (sessionBound) return loadSessionBoard(sessionId, boardId)
        return loadBoard(repo, boardId)
      }, [loadBoard, loadSessionBoard, repo, boardId, sessionBound, sessionId])

      const changeBoard = useCallback(
        (nextId) => {
          setBoardId(nextId)
          if (sessionBound) {
            loadSessionBoard(sessionId, nextId)
            return
          }
          writeSelection({ repo, boardId: nextId })
          loadBoard(repo, nextId)
        },
        [loadBoard, loadSessionBoard, repo, sessionBound, sessionId],
      )

      /* -------------------------- derived data ------------------------- */

      const columns = data?.columns ?? []
      const me = status?.user?.username
      const hostNotReady = status !== null && (status.glabAvailable === false || status.user === null)
      const firstRunMessage =
        status === null
          ? ''
          : status.glabAvailable === false
            ? status.glabError || t('firstRun.noGlab')
            : status.user === null
              ? t('firstRun.noAuth')
              : ''

      const assigneeOptions = useMemo(() => {
        const byName = new Map()
        for (const column of columns) {
          for (const card of column.issues ?? []) {
            for (const user of card.assignees ?? []) byName.set(user.username, user)
          }
        }
        return [...byName.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)))
      }, [columns])

      const filterActive = query.trim() !== '' || onlyMine || assigneeFilter !== ''
      const needle = query.trim().toLowerCase()

      const columnsView = useMemo(() => {
        return columns.map((column) => {
          const shownCards = (column.issues ?? []).filter((card) => {
            if (onlyMine && me !== undefined && !card.assignees.some((user) => user.username === me)) return false
            if (assigneeFilter !== '' && !card.assignees.some((user) => user.username === assigneeFilter)) return false
            if (needle !== '') {
              const haystack = `${card.iid} ${card.title} ${card.labels.map((label) => label.name).join(' ')}`.toLowerCase()
              if (!haystack.includes(needle)) return false
            }
            return true
          })
          return { ...column, shownCards }
        })
      }, [columns, onlyMine, assigneeFilter, needle, me])

      const statusLabelSet = useMemo(() => new Set(columns.filter((column) => column.label !== null).map((column) => column.label)), [columns])

      const scopeCaption = useMemo(() => {
        if (!data || data.source !== 'board') return null
        const labels = columns.filter((column) => column.label !== null).map((column) => column.label)
        if (labels.length === 0) return null
        const scopes = labels.map((label) => (label.includes('::') ? label.slice(0, label.lastIndexOf('::')) : ''))
        const first = scopes[0]
        return scopes.every((scope) => scope === first) && first !== '' ? first : null
      }, [data, columns])

      /* --------------------------- actions ----------------------------- */

      const withStatusLabelsReplaced = (labels, targetColumn) => {
        const kept = labels.filter((label) => !statusLabelSet.has(label.name))
        return [...kept, { name: targetColumn.label, color: targetColumn.color, textColor: targetColumn.textColor }]
      }

      const moveCard = useCallback(
        async (card, fromColumn, toColumn) => {
          if (!toColumn || toColumn.movable !== true || toColumn.label === null) {
            setNotice({ kind: 'error', message: t('notice.immovable') })
            return
          }
          if (fromColumn && fromColumn.label === toColumn.label) return
          const fromLabels = columns.filter((column) => column.label !== null && column.label !== toColumn.label).map((column) => column.label)
          // Optimistic move so the card lands immediately.
          setData((prev) => {
            if (prev === null) return prev
            return {
              ...prev,
              columns: prev.columns.map((column) => {
                if (fromColumn && column.id === fromColumn.id) return { ...column, issues: column.issues.filter((item) => item.iid !== card.iid), count: Math.max(0, (column.count ?? 0) - 1) }
                if (column.id === toColumn.id) return { ...column, issues: [{ ...card, labels: withStatusLabelsReplaced(card.labels, toColumn) }, ...column.issues.filter((item) => item.iid !== card.iid)], count: (column.count ?? 0) + 1 }
                return column
              }),
            }
          })
          const result = await post('move', { repo, iid: card.iid, toLabel: toColumn.label, fromLabels })
          if (!mounted.current) return
          if (!result.ok) {
            setNotice({ kind: 'error', message: result.error.message })
            reload()
          } else {
            setNotice({ kind: 'ok', message: t('notice.moved', { iid: card.iid, name: shortLabel(toColumn.label) }) })
            reload()
          }
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [columns, repo, reload, statusLabelSet, t],
      )

      const openDetail = useCallback(async (iid) => {
        const repoAtCall = repo
        const seq = ++detailSeq.current
        lastFocus.current = document.activeElement
        setDetailNotice(null)
        setCommentDraft('')
        setNotes(null)
        setNotesError(null)
        setNotesLoading(true)
        setDetail({ repo: repoAtCall, iid, loading: true, data: null, error: null })
        const [issueResult, notesResult] = await Promise.all([post('issue', { repo: repoAtCall, iid }), post('notes', { repo: repoAtCall, iid })])
        if (!mounted.current || seq !== detailSeq.current) return
        setDetail((prev) =>
          prev !== null && prev.iid === iid && prev.repo === repoAtCall
            ? { ...prev, loading: false, data: issueResult.ok ? issueResult.data.issue : null, error: issueResult.ok ? null : issueResult.error }
            : prev,
        )
        setNotesLoading(false)
        if (notesResult.ok) setNotes(notesResult.data.notes)
        else setNotesError(notesResult.error.message)
        if (!issueResult.ok) setDetailNotice({ kind: 'error', message: issueResult.error.message })
      }, [repo])

      const refreshDetail = useCallback(
        async (iid) => {
          const repoAtCall = repo
          const seq = ++detailSeq.current
          const [issueResult, notesResult] = await Promise.all([post('issue', { repo: repoAtCall, iid }), post('notes', { repo: repoAtCall, iid })])
          if (!mounted.current || seq !== detailSeq.current) return
          if (notesResult.ok) {
            setNotes(notesResult.data.notes)
            setNotesError(null)
          } else {
            setNotesError(notesResult.error.message)
          }
          if (!issueResult.ok) {
            setDetailNotice({ kind: 'error', message: issueResult.error.message })
            return
          }
          setDetail((prev) =>
            prev !== null && prev.iid === iid && prev.repo === repoAtCall
              ? { ...prev, loading: false, data: issueResult.data.issue, error: null }
              : prev,
          )
        },
        [repo],
      )

      const moveFromDetail = useCallback(
        async (iid, toLabel) => {
          const target = columns.find((column) => column.label === toLabel)
          if (target === undefined) return
          setDetailBusy('move')
          setDetailNotice(null)
          const fromLabels = columns.filter((column) => column.label !== null && column.label !== toLabel).map((column) => column.label)
          const result = await post('move', { repo, iid, toLabel, fromLabels })
          setDetailBusy(null)
          if (!mounted.current) return
          if (!result.ok) {
            setDetailNotice({ kind: 'error', message: result.error.message })
            return
          }
          setDetailNotice({ kind: 'ok', message: t('notice.moved', { iid, name: shortLabel(toLabel) }) })
          reload()
          refreshDetail(iid)
        },
        [columns, repo, reload, refreshDetail, t],
      )

      const toggleIssueState = useCallback(
        async (iid, current) => {
          const action = current === 'opened' ? 'close' : 'reopen'
          setDetailBusy('state')
          setDetailNotice(null)
          const result = await post('state', { repo, iid, action })
          setDetailBusy(null)
          if (!mounted.current) return
          if (!result.ok) {
            setDetailNotice({ kind: 'error', message: result.error.message })
            return
          }
          setDetailNotice({ kind: 'ok', message: action === 'close' ? t('notice.closed', { iid }) : t('notice.reopened', { iid }) })
          reload()
          refreshDetail(iid)
        },
        [repo, reload, refreshDetail, t],
      )

      const submitComment = useCallback(
        async (iid) => {
          const message = commentDraft.trim()
          if (message === '') return
          setDetailBusy('comment')
          setDetailNotice(null)
          const result = await post('comment', { repo, iid, message })
          setDetailBusy(null)
          if (!mounted.current) return
          if (!result.ok) {
            setDetailNotice({ kind: 'error', message: result.error.message })
            return
          }
          setCommentDraft('')
          setDetailNotice({ kind: 'ok', message: t('notice.commented', { iid }) })
          refreshDetail(iid)
        },
        [commentDraft, repo, refreshDetail, t],
      )

      const openComposer = useCallback(
        (targetLabel) => {
          lastFocus.current = document.activeElement
          setCTitle('')
          setCDesc('')
          setCAssignee('')
          setCDue('')
          setCLabels(targetLabel ? [targetLabel] : [])
          setLabelQuery('')
          setComposerError(null)
          setComposerBusy(false)
          setComposer({ targetLabel: targetLabel ?? null })
        },
        [],
      )

      const submitComposer = useCallback(async () => {
        if (cTitle.trim() === '') return
        setComposerBusy(true)
        setComposerError(null)
        const result = await post('create', { repo, title: cTitle.trim(), description: cDesc, labels: cLabels, assignee: cAssignee.trim(), dueDate: cDue })
        setComposerBusy(false)
        if (!mounted.current) return
        if (!result.ok) {
          setComposerError(result.error.message)
          return
        }
        setComposer(null)
        setNotice({ kind: 'ok', message: t('notice.created', { title: cTitle.trim() }) })
        reload()
      }, [cTitle, cDesc, cLabels, cAssignee, cDue, repo, reload, t])

      /* ------------------------- drag handling ------------------------- */

      const onDragStart = useCallback((event, card, column) => {
        suppressClick.current = true
        setDrag({ iid: card.iid, fromLabel: column.label, fromColumnId: column.id })
        try {
          event.dataTransfer.effectAllowed = 'move'
          event.dataTransfer.setData('text/plain', String(card.iid))
        } catch {
          /* Some browsers restrict dataTransfer here; dragging still works. */
        }
      }, [])

      const onDragEnd = useCallback(() => {
        setDrag(null)
        setDragOver(null)
        setTimeout(() => {
          suppressClick.current = false
        }, 60)
      }, [])

      const onDropColumn = useCallback(
        (event, column) => {
          event.preventDefault()
          setDragOver(null)
          const moving = drag
          setDrag(null)
          setTimeout(() => {
            suppressClick.current = false
          }, 60)
          if (!moving) return
          const source = columns.find((item) => item.id === moving.fromColumnId)
          const card = source?.issues.find((item) => item.iid === moving.iid)
          if (card) moveCard(card, source, column)
        },
        [drag, columns, moveCard],
      )

      /* ----------------------------- render ---------------------------- */

      const renderHeader = () =>
        h('div', { className: 'dsh-gk-top', 'aria-hidden': overlayOpen ? true : undefined },
          h('div', { className: 'dsh-gk-head' },
            h('div', { className: 'dsh-gk-mark' }, h(Glyph, { size: 20 })),
            h('div', { className: 'dsh-gk-headtext' },
              h('h1', { className: 'dsh-gk-title' }, sessionBound ? data?.project?.name ?? t('page.title') : t('page.title')),
              h('p', { className: 'dsh-gk-sub' }, data ? `${data.project.path}${data.boardName ? ` · ${data.boardName}` : ''}` : t('page.subtitle'))),
            h('span', { className: 'dsh-gk-headspacer' }),
            status?.user ? h('span', { className: 'dsh-gk-me' }, h(Avatar, { user: status.user, size: 22 }), `@${status.user.username}`) : null),
          h('div', { className: 'dsh-gk-toolbar' },
            sessionBound
              ? h('div', { className: 'dsh-gk-repo dsh-gk-repo-static', title: data?.project?.path ?? t('session.resolving') },
                  h(ICON.folder, null),
                  h('span', { className: 'dsh-gk-repo-name' }, data ? data.project.name : t('session.resolving')),
                  data ? h('span', { className: 'dsh-gk-repo-path' }, data.project.path) : null,
                  h('span', { className: 'dsh-gk-sessionbadge' }, t('session.bound')))
              : h('button', { type: 'button', className: 'dsh-gk-repo', onClick: () => openRepoPickerInternal(), title: t('repo.change') },
                  h(ICON.folder, null),
                  h('span', { className: 'dsh-gk-repo-name' }, data ? data.project.name : repo !== '' ? repo : t('repo.choose')),
                  data ? h('span', { className: 'dsh-gk-repo-path' }, data.project.path) : null,
                  h(ICON.chevronDown, null)),
            data && data.boards.length > 0
              ? h('label', { className: 'dsh-gk-selectwrap', title: t('board.label') },
                  h(ICON.board, null),
                  h('select', { className: 'dsh-gk-select', value: boardId, onChange: (event) => changeBoard(event.target.value), 'aria-label': t('board.label') },
                    data.boards.map((board) => h('option', { key: board.id, value: board.id }, board.name))))
              : null,
            h('span', { className: 'dsh-gk-headspacer' }),
            h('button', { type: 'button', className: 'dsh-gk-btn dsh-gk-btn-ghost', onClick: () => reload(), disabled: loading || (!sessionBound && repo === ''), title: t('action.refresh') },
              h(ICON.refresh, { className: loading ? 'dsh-gk-spin' : '' }), h('span', { className: 'dsh-gk-btn-label' }, t('action.refresh'))),
            h('button', { type: 'button', className: 'dsh-gk-btn dsh-gk-btn-primary', onClick: () => openComposer(null), disabled: !data || columns.length === 0 },
              h(ICON.plus, null), h('span', { className: 'dsh-gk-btn-label' }, t('action.newIssue')))),
          h('div', { className: 'dsh-gk-filters' },
            h('div', { className: 'dsh-gk-search' },
              h('span', { className: 'dsh-gk-search-icon' }, h(ICON.search, null)),
              h('input', {
                className: 'dsh-gk-input',
                value: query,
                spellCheck: false,
                placeholder: t('filter.search'),
                'aria-label': t('filter.search'),
                onChange: (event) => setQuery(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Escape') setQuery('')
                },
              }),
              query !== '' ? h('button', { type: 'button', className: 'dsh-gk-search-clear', onClick: () => setQuery(''), 'aria-label': t('filter.clear') }, h(ICON.close, null)) : null),
            assigneeOptions.length > 0
              ? h('select', { className: 'dsh-gk-filter-select', value: assigneeFilter, onChange: (event) => setAssigneeFilter(event.target.value), 'aria-label': t('filter.assignee') },
                  h('option', { value: '' }, t('filter.anyone')),
                  assigneeOptions.map((user) => h('option', { key: user.username, value: user.username }, user.name ?? user.username)))
              : null,
            me
              ? h('button', { type: 'button', className: `dsh-gk-chip${onlyMine ? ' is-on' : ''}`, onClick: () => setOnlyMine((value) => !value), 'aria-pressed': onlyMine }, h(Avatar, { user: status.user, size: 16 }), t('filter.mine'))
              : null,
            scopeCaption ? h('span', { className: 'dsh-gk-scopetag', title: t('scope.hint') }, `${scopeCaption}::`) : null,
            filterActive ? h('button', { type: 'button', className: 'dsh-gk-chip dsh-gk-chip-plain', onClick: () => { setQuery(''); setOnlyMine(false); setAssigneeFilter('') } }, t('filter.clearAll')) : null),
          statusError !== null ? h('div', { className: 'dsh-gk-notice dsh-gk-notice-error', role: 'alert' }, t('error.status', { message: statusError.message })) : null,
          notice !== null ? h('div', { className: `dsh-gk-notice ${notice.kind === 'ok' ? 'dsh-gk-notice-ok' : 'dsh-gk-notice-error'}`, role: notice.kind === 'ok' ? 'status' : 'alert' }, notice.message) : null,
          boardError !== null ? h('div', { className: 'dsh-gk-notice dsh-gk-notice-error', role: 'alert' }, boardError.message) : null)

      const renderColumn = (column) => {
        const isOver = dragOver === column.id && drag !== null && drag.fromLabel !== column.label
        const titleText =
          column.title ??
          (column.label !== null
            ? shortLabel(column.label)
            : column.id === 'backlog'
              ? t('col.backlog')
              : column.state === 'opened'
                ? t('state.open')
                : column.state === 'closed'
                  ? t('state.closed')
                  : t('col.untitled'))
        return h('section', {
          key: column.id,
          className: `dsh-gk-col${isOver ? ' is-over' : ''}${column.movable ? '' : ' is-static'}`,
          onDragOver: (event) => {
            if (drag !== null && column.movable && drag.fromLabel !== column.label) {
              event.preventDefault()
              setDragOver(column.id)
            }
          },
          onDragLeave: () => setDragOver((current) => (current === column.id ? null : current)),
          onDrop: (event) => {
            event.preventDefault()
            if (column.movable) onDropColumn(event, column)
            else {
              setDragOver(null)
              setDrag(null)
              setNotice({ kind: 'error', message: t('notice.immovable') })
            }
          },
        },
          h('div', { className: 'dsh-gk-col-head' },
            h('span', { className: 'dsh-gk-dot', style: { background: column.color } }),
            h('span', { className: 'dsh-gk-col-title', title: column.label ?? titleText }, titleText),
            h('span', { className: 'dsh-gk-count' }, filterActive ? `${column.shownCards.length} / ${column.count}` : String(column.count)),
            column.movable ? h('button', { type: 'button', className: 'dsh-gk-coladd', title: t('col.addHere'), onClick: () => openComposer(column.label) }, h(ICON.plus, null)) : null),
          h('div', { className: 'dsh-gk-col-body' },
            column.shownCards.length > 0
              ? column.shownCards.map((card) =>
                  h(Card, {
                    key: card.iid,
                    card,
                    column,
                    t,
                    dragging: drag !== null && drag.iid === card.iid,
                    onOpen: (iid) => {
                      if (suppressClick.current) return
                      openDetail(iid)
                    },
                    onDragStart,
                    onDragEnd,
                  }))
              : h('div', { className: 'dsh-gk-colempty' }, filterActive && column.count > 0 ? t('col.noMatchLoaded') : t('col.empty')),
            column.truncated
              ? h('div', { className: 'dsh-gk-trunc' }, filterActive ? t('col.truncatedFiltered', { loaded: column.issues.length, total: column.count }) : t('col.truncated', { shown: column.issues.length, total: column.count }))
              : null))
      }

      const renderBoard = () => {
        if (data === null && hostNotReady) {
          return h('div', { className: 'dsh-gk-empty' },
            h('div', { className: 'dsh-gk-empty-icon' }, h(Glyph, { size: 24 })),
            h('div', { className: 'dsh-gk-empty-title' }, t('firstRun.title')),
            h('div', { className: 'dsh-gk-empty-body' }, firstRunMessage),
            h('button', { type: 'button', className: 'dsh-gk-btn dsh-gk-btn-primary', style: { marginTop: 8 }, onClick: retryStatus }, t('firstRun.retry')))
        }
        if (loading && data === null) {
          return h('div', { className: 'dsh-gk-board' },
            [0, 1, 2].map((index) =>
              h('div', { key: index, className: 'dsh-gk-col dsh-gk-skel' },
                h('div', { className: 'dsh-gk-col-head' }, h('span', { className: 'dsh-gk-skel-bar', style: { width: 90, height: 10 } })),
                [0, 1, 2].map((row) => h('div', { key: row, className: 'dsh-gk-card' }, h('span', { className: 'dsh-gk-skel-bar', style: { width: '70%', height: 10 } }), h('span', { className: 'dsh-gk-skel-bar', style: { width: '45%', height: 8 } }))))))
        }
        if (data === null && sessionBound) {
          return h('div', { className: 'dsh-gk-empty' },
            h('div', { className: 'dsh-gk-empty-icon' }, h(Glyph, { size: 24 })),
            h('div', { className: 'dsh-gk-empty-title' }, boardError !== null ? t('session.noProjectTitle') : t('session.resolving')),
            h('div', { className: 'dsh-gk-empty-body' }, boardError !== null ? (boardError.code === 'no-gitlab' ? t('session.noGitlabBody') : boardError.code === 'no-dir' ? t('session.noDirBody') : boardError.message) : t('session.resolvingBody')),
            boardError !== null ? h('button', { type: 'button', className: 'dsh-gk-btn', style: { marginTop: 8 }, onClick: () => loadSessionBoard(sessionId) }, t('session.retry')) : null)
        }
        if (data === null) {
          return h('div', { className: 'dsh-gk-empty' },
            h('div', { className: 'dsh-gk-empty-icon' }, h(Glyph, { size: 24 })),
            h('div', { className: 'dsh-gk-empty-title' }, repo === '' ? t('empty.chooseRepoTitle') : t('empty.loadTitle')),
            h('div', null, repo === '' ? t('empty.chooseRepoBody') : boardError !== null ? t('empty.loadBody') : t('common.loading')),
            repo === '' ? h('button', { type: 'button', className: 'dsh-gk-btn dsh-gk-btn-primary', style: { marginTop: 8 }, onClick: () => openRepoPickerInternal() }, t('repo.choose')) : null,
            repo !== '' && boardError !== null ? h('button', { type: 'button', className: 'dsh-gk-btn', style: { marginTop: 8 }, onClick: () => openRepoPickerInternal() }, t('repo.change')) : null,
            statusError !== null ? h('button', { type: 'button', className: 'dsh-gk-btn', style: { marginTop: 8 }, onClick: retryStatus }, t('firstRun.retry')) : null)
        }
        if (columns.length === 0) {
          return h('div', { className: 'dsh-gk-empty' },
            h('div', { className: 'dsh-gk-empty-icon' }, h(ICON.board, null)),
            h('div', { className: 'dsh-gk-empty-title' }, t('empty.noColumnsTitle')),
            h('div', null, t('empty.noColumnsBody')))
        }
        return h('div', { className: 'dsh-gk-boardwrap', 'aria-hidden': overlayOpen ? true : undefined },
          h('div', { className: 'dsh-gk-hintbar' }, data.source === 'board' ? t('hint.drag') : data.source === 'scope' ? t('source.scope', { scope: data.statusScope ?? '' }) : t('source.state')),
          h('div', { className: 'dsh-gk-board' }, columnsView.map(renderColumn)))
      }

      const renderRepoPicker = () => {
        if (!repoPicker || sessionBound) return null
        const recent = readRecent()
        const recentPaths = new Set(recent.map((item) => item.path))
        const searching = projQuery.trim() !== ''
        const listed = (projectList ?? []).filter((project) => searching || !recentPaths.has(project.path))
        const showProjects = searching || projectList === null || projBusy || listed.length > 0 || recent.length === 0
        const tryManual = () => {
          const clean = manualRepo.trim()
          if (!REPO_RE.test(clean)) {
            setPickerError(t('repo.invalid'))
            return
          }
          selectRepo(clean)
        }
        const renderProject = (project) =>
          h('button', {
            key: project.path ?? String(project.id),
            type: 'button',
            className: 'dsh-gk-projectrow',
            onClick: () => selectRepo(project.path),
            title: project.path,
          },
            h('span', { className: 'dsh-gk-projecttile' }, h(ICON.folder, null)),
            h('span', { className: 'dsh-gk-projecttext' },
              h('span', { className: 'dsh-gk-projectname' }, project.name || project.path),
              h('span', { className: 'dsh-gk-projectpath' }, project.path)),
            h('span', { className: 'dsh-gk-projectgo' }, h(ICON.chevronRight, null)))
        return h('div', { className: 'dsh-gk-overlay', onClick: () => setRepoPicker(false) },
          h('div', { className: 'dsh-gk-modal', onClick: (event) => event.stopPropagation(), role: 'dialog', 'aria-modal': 'true', 'aria-label': t('repo.title') },
            h('div', { className: 'dsh-gk-modal-head' },
              h('span', { className: 'dsh-gk-modal-icon' }, h(ICON.folder, null)),
              h('div', { className: 'dsh-gk-modal-headtext' },
                h('h2', { className: 'dsh-gk-modal-title' }, t('repo.title')),
                h('p', { className: 'dsh-gk-modal-sub' }, t('repo.subtitle'))),
              h('button', { type: 'button', className: 'dsh-gk-iconbtn', onClick: () => setRepoPicker(false), 'aria-label': t('common.close') }, h(ICON.close, null))),
            h('div', { className: 'dsh-gk-modal-body' },
              h('div', { className: 'dsh-gk-modal-search' },
                h('span', { className: 'dsh-gk-search-icon' }, h(ICON.search, null)),
                h('input', {
                  className: 'dsh-gk-input',
                  value: projQuery,
                  spellCheck: false,
                  autoFocus: true,
                  placeholder: t('repo.searchPlaceholder'),
                  'aria-label': t('repo.searchPlaceholder'),
                  onChange: (event) => setProjQuery(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter' && listed.length > 0) {
                      event.preventDefault()
                      selectRepo(listed[0].path)
                    }
                  },
                }),
                projQuery !== '' ? h('button', { type: 'button', className: 'dsh-gk-search-clear', onClick: () => setProjQuery(''), 'aria-label': t('filter.clear') }, h(ICON.close, null)) : null),
              pickerError !== null ? h('div', { className: 'dsh-gk-notice dsh-gk-notice-error', role: 'alert' }, pickerError) : null,
              !searching && recent.length > 0
                ? h('div', { className: 'dsh-gk-projectsection' },
                    h('div', { className: 'dsh-gk-projectsection-title' }, h(ICON.history, null), t('repo.recent')),
                    h('div', { className: 'dsh-gk-projectlist' }, recent.map(renderProject)))
                : null,
              showProjects
                ? h('div', { className: 'dsh-gk-projectsection' },
                    h('div', { className: 'dsh-gk-projectsection-title' }, t('repo.projects')),
                    h('div', { className: 'dsh-gk-projectlist dsh-gk-projectlist-tall' },
                      projBusy || projectList === null
                        ? h('div', { className: 'dsh-gk-modalhint' }, t('common.loading'))
                        : listed.length === 0
                          ? h('div', { className: 'dsh-gk-modalhint' }, searching ? t('repo.none') : t('repo.noProjects'))
                          : listed.map(renderProject)))
                : null,
              h('details', { className: 'dsh-gk-manual' },
                h('summary', { className: 'dsh-gk-manual-summary' }, h(ICON.folder, null), t('repo.manual')),
                h('div', { className: 'dsh-gk-manualrow' },
                  h('input', { className: 'dsh-gk-input', value: manualRepo, spellCheck: false, placeholder: 'group/sub/project', onChange: (event) => setManualRepo(event.target.value), onKeyDown: (event) => { if (event.key === 'Enter') tryManual() } }),
                  h('button', { type: 'button', className: 'dsh-gk-btn', onClick: tryManual, disabled: manualRepo.trim() === '' }, t('repo.use'))))),
            h('div', { className: 'dsh-gk-modal-foot' },
              h('span', { className: 'dsh-gk-modal-hint' }, t('repo.footerHint')),
              h('span', { className: 'dsh-gk-headspacer' }),
              h('button', { type: 'button', className: 'dsh-gk-btn dsh-gk-btn-ghost', onClick: () => setRepoPicker(false) }, t('common.close')))))
      }

      const renderDetail = () => {
        if (detail === null) return null
        const issue = detail.data
        const projectWebUrl = issue?.project?.webUrl ?? data?.project?.webUrl ?? ''
        const currentColumn = issue ? columns.find((column) => column.label !== null && issue.labels.some((label) => label.name === column.label)) : undefined
        const targets = columns.filter((column) => column.label !== null && column.label !== currentColumn?.label)
        const description = issue ? extractImages(issue.description, projectWebUrl) : { text: '', images: [] }
        const comments = (notes ?? []).filter((note) => !note.system)
        const activity = (notes ?? []).filter((note) => note.system)
        return h('div', { className: 'dsh-gk-overlay', onClick: closeDetail },
          h('aside', { className: 'dsh-gk-drawer', onClick: (event) => event.stopPropagation(), role: 'dialog', 'aria-modal': 'true', 'aria-label': issue ? `#${detail.iid} ${issue.title}` : `#${detail.iid}` },
            h('div', { className: 'dsh-gk-drawer-head' },
              h('div', { className: 'dsh-gk-drawer-headtext' },
                h('div', { className: 'dsh-gk-drawer-kicker' },
                  h('span', { className: 'dsh-gk-drawer-iid' }, `#${detail.iid}`),
                  issue ? h('span', { className: `dsh-gk-state ${issue.state === 'opened' ? 'is-open' : 'is-closed'}` }, issue.state === 'opened' ? t('state.open') : t('state.closed')) : null,
                  currentColumn ? h('span', { className: 'dsh-gk-scopetag' }, currentColumn.title ?? shortLabel(currentColumn.label)) : null),
                h('h2', { className: 'dsh-gk-drawer-title' }, issue?.title ?? t('common.loading'))),
              h('span', { className: 'dsh-gk-headspacer' }),
              issue?.webUrl ? h('a', { className: 'dsh-gk-iconbtn', href: issue.webUrl, target: '_blank', rel: 'noreferrer noopener', title: t('detail.open') }, h(ICON.external, null)) : null,
              h('button', { type: 'button', className: 'dsh-gk-iconbtn', onClick: closeDetail, 'aria-label': t('common.close') }, h(ICON.close, null))),
            detail.loading
              ? h('div', { className: 'dsh-gk-drawer-loading' },
                  h('span', { className: 'dsh-gk-skel-bar', style: { width: '60%', height: 12 } }),
                  h('span', { className: 'dsh-gk-skel-bar', style: { width: '92%', height: 9 } }),
                  h('span', { className: 'dsh-gk-skel-bar', style: { width: '84%', height: 9 } }),
                  h('span', { className: 'dsh-gk-skel-bar', style: { width: '70%', height: 9 } }))
              : detail.error !== null
                ? h('div', { className: 'dsh-gk-drawer-body' }, h('div', { className: 'dsh-gk-notice dsh-gk-notice-error', role: 'alert' }, detail.error.message))
                : h('div', { className: 'dsh-gk-drawer-body' },
                    h('div', { className: 'dsh-gk-meta-grid' },
                      issue.author ? h('div', { className: 'dsh-gk-meta-field' }, h('span', { className: 'dsh-gk-meta-label' }, t('detail.author')), h('span', { className: 'dsh-gk-meta-value' }, h(Avatar, { user: issue.author, size: 18 }), issue.author.name ?? issue.author.username)) : null,
                      issue.assignees.length > 0
                        ? h('div', { className: 'dsh-gk-meta-field' }, h('span', { className: 'dsh-gk-meta-label' }, t('detail.assignees')), h('span', { className: 'dsh-gk-meta-value' }, issue.assignees.map((user) => h('span', { key: user.username, className: 'dsh-gk-assignee' }, h(Avatar, { user, size: 16 }), user.name ?? user.username))))
                        : null,
                      issue.milestone ? h('div', { className: 'dsh-gk-meta-field' }, h('span', { className: 'dsh-gk-meta-label' }, t('detail.milestone')), h('span', { className: 'dsh-gk-meta-value' }, h(ICON.flag, null), issue.milestone)) : null,
                      issue.dueDate ? h('div', { className: 'dsh-gk-meta-field' }, h('span', { className: 'dsh-gk-meta-label' }, t('detail.due')), h('span', { className: 'dsh-gk-meta-value' }, h(ICON.calendar, null), issue.dueDate)) : null,
                      issue.createdAt ? h('div', { className: 'dsh-gk-meta-field' }, h('span', { className: 'dsh-gk-meta-label' }, t('detail.created')), h('span', { className: 'dsh-gk-meta-value' }, fmtDate(issue.createdAt))) : null),
                    issue.labels.length > 0 ? h('div', { className: 'dsh-gk-card-labels' }, issue.labels.map((label) => h(LabelChip, { key: label.name, label }))) : null,
                    h('section', { className: 'dsh-gk-sec' },
                      h('div', { className: 'dsh-gk-sec-head' }, h('h3', { className: 'dsh-gk-sec-title' }, t('detail.description'))),
                      h('div', { className: 'dsh-gk-desc-card' }, description.text.trim() !== '' ? renderMarkdown(description.text, 'd', projectWebUrl) : h('p', { className: 'dsh-gk-md-p' }, t('detail.noDescription'))),
                      h(AttachmentList, { images: description.images, t }),
                      description.images.length > 0 ? h('div', { className: 'dsh-gk-asset-hint' }, t('detail.privateAssetHint')) : null),
                    h('section', { className: 'dsh-gk-sec' },
                      h('div', { className: 'dsh-gk-sec-head' },
                        h('h3', { className: 'dsh-gk-sec-title' }, t('detail.comments')),
                        h('span', { className: 'dsh-gk-sec-count' }, String(comments.length)),
                        h('span', { className: 'dsh-gk-headspacer' }),
                        notesLoading ? h('span', { className: 'dsh-gk-meta' }, t('common.loading')) : null),
                      notesError !== null ? h('div', { className: 'dsh-gk-notice dsh-gk-notice-error', role: 'alert' }, t('detail.commentsError', { message: notesError })) : null,
                      h('div', { className: 'dsh-gk-comments' },
                        comments.length === 0 && !notesLoading ? h('div', { className: 'dsh-gk-colempty' }, t('detail.noComments')) : null,
                        comments.map((note) => h(CommentItem, { key: note.id, note, projectWebUrl, t }))),
                      activity.length > 0
                        ? h('details', { className: 'dsh-gk-activity' },
                            h('summary', null, t('detail.activity', { n: activity.length })),
                            activity.map((note) => h('div', { key: note.id, className: 'dsh-gk-activity-row' }, h(Avatar, { user: note.author, size: 16 }), h('span', { className: 'dsh-gk-activity-body' }, note.body.replace(/\*\*/g, '')), h('span', { className: 'dsh-gk-activity-time' }, timeAgo(note.createdAt, t)))))
                        : null),
                    h('section', { className: 'dsh-gk-sec' },
                      h('div', { className: 'dsh-gk-sec-head' }, h('h3', { className: 'dsh-gk-sec-title' }, t('detail.actions'))),
                      detailNotice !== null ? h('div', { className: `dsh-gk-notice ${detailNotice.kind === 'ok' ? 'dsh-gk-notice-ok' : 'dsh-gk-notice-error'}`, role: detailNotice.kind === 'ok' ? 'status' : 'alert' }, detailNotice.message) : null,
                      columns.some((column) => column.label !== null)
                        ? h('label', { className: 'dsh-gk-field' },
                            h('span', null, t('detail.moveTo')),
                            h('select', { className: 'dsh-gk-select dsh-gk-select-wide', value: '', disabled: detailBusy !== null, onChange: (event) => { if (event.target.value !== '') moveFromDetail(detail.iid, event.target.value) } },
                              h('option', { value: '' }, currentColumn ? t('detail.currentColumn', { name: currentColumn.title ?? shortLabel(currentColumn.label) }) : t('detail.chooseColumn')),
                              targets.map((column) => h('option', { key: column.id, value: column.label }, column.title ?? shortLabel(column.label)))))
                        : null,
                      h('div', { className: 'dsh-gk-detail-btns' },
                        h('button', { type: 'button', className: `dsh-gk-btn ${issue.state === 'opened' ? 'dsh-gk-btn-danger' : ''}`, disabled: detailBusy !== null, onClick: () => toggleIssueState(detail.iid, issue.state) },
                          detailBusy === 'state' ? t('common.working') : issue.state === 'opened' ? t('detail.closeIssue') : t('detail.reopenIssue')))),
                    h('section', { className: 'dsh-gk-sec dsh-gk-composer' },
                      h('div', { className: 'dsh-gk-sec-head' }, h('h3', { className: 'dsh-gk-sec-title' }, t('detail.comment'))),
                      h('textarea', { className: 'dsh-gk-textarea', rows: 3, value: commentDraft, placeholder: t('detail.commentPlaceholder'), onChange: (event) => setCommentDraft(event.target.value) }),
                      h('div', { className: 'dsh-gk-detail-btns' },
                        h('button', { type: 'button', className: 'dsh-gk-btn dsh-gk-btn-primary', disabled: detailBusy !== null || commentDraft.trim() === '', onClick: () => submitComment(detail.iid) }, detailBusy === 'comment' ? t('common.working') : t('detail.sendComment')))))))
      }

      const renderComposer = () => {
        if (composer === null) return null
        const allLabels = data?.labels ?? []
        const byName = new Map(allLabels.map((label) => [label.name, label]))
        const labelNeedle = labelQuery.trim().toLowerCase()
        const filtered = labelNeedle === '' ? allLabels : allLabels.filter((label) => label.name.toLowerCase().includes(labelNeedle))
        const groups = labelNeedle === '' ? groupLabels(filtered) : [['', filtered]]
        const selected = cLabels.map((name) => byName.get(name) ?? { name, color: null, textColor: null })
        const target = composer.targetLabel ? byName.get(composer.targetLabel) : undefined
        const toggleLabel = (name) => setCLabels((current) => (current.includes(name) ? current.filter((item) => item !== name) : [...current, name]))
        const submitOnKey = (event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            if (cTitle.trim() !== '' && !composerBusy) submitComposer()
          }
        }
        return h('div', { className: 'dsh-gk-overlay', onClick: () => setComposer(null) },
          h('div', {
            className: 'dsh-gk-modal dsh-gk-modal-wide',
            onClick: (event) => event.stopPropagation(),
            onKeyDown: submitOnKey,
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': t('composer.title'),
          },
            h('div', { className: 'dsh-gk-modal-head' },
              h('span', { className: 'dsh-gk-modal-icon' }, h(ICON.plus, null)),
              h('div', { className: 'dsh-gk-modal-headtext' },
                h('h2', { className: 'dsh-gk-modal-title' }, t('composer.title')),
                h('p', { className: 'dsh-gk-modal-sub' }, t('composer.subtitle', { project: data?.project?.path ?? '' }))),
              h('button', { type: 'button', className: 'dsh-gk-iconbtn', onClick: () => setComposer(null), 'aria-label': t('common.close') }, h(ICON.close, null))),
            h('div', { className: 'dsh-gk-modal-body' },
              h('div', { className: 'dsh-gk-composer-grid' },
                h('div', { className: 'dsh-gk-composer-main' },
                  h('input', {
                    className: 'dsh-gk-titleinput',
                    value: cTitle,
                    autoFocus: true,
                    spellCheck: false,
                    placeholder: t('composer.titlePlaceholder'),
                    'aria-label': t('composer.titleLabel'),
                    onChange: (event) => setCTitle(event.target.value),
                  }),
                  h('textarea', {
                    className: 'dsh-gk-textarea dsh-gk-descinput',
                    rows: 7,
                    value: cDesc,
                    placeholder: t('composer.descPlaceholder'),
                    'aria-label': t('composer.descLabel'),
                    onChange: (event) => setCDesc(event.target.value),
                  }),
                  h('div', { className: 'dsh-gk-labelblock' },
                    h('div', { className: 'dsh-gk-labelblock-head' },
                      h('span', { className: 'dsh-gk-field-title' }, t('composer.labels')),
                      cLabels.length > 0 ? h('span', { className: 'dsh-gk-sec-count' }, t('composer.selected', { n: cLabels.length })) : null,
                      h('span', { className: 'dsh-gk-headspacer' }),
                      cLabels.length > 0 ? h('button', { type: 'button', className: 'dsh-gk-linkbtn', onClick: () => setCLabels([]) }, t('composer.clearLabels')) : null),
                    selected.length > 0
                      ? h('div', { className: 'dsh-gk-selectedlabels' }, selected.map((label) =>
                          h('span', { key: label.name, className: 'dsh-gk-selectedlabel' },
                            h(LabelChip, { label }),
                            h('button', { type: 'button', className: 'dsh-gk-selectedlabel-x', onClick: () => toggleLabel(label.name), 'aria-label': `${t('common.remove')} ${label.name}` }, h(ICON.close, null)))))
                      : null,
                    h('input', { className: 'dsh-gk-input', value: labelQuery, spellCheck: false, placeholder: t('composer.filterLabels'), onChange: (event) => setLabelQuery(event.target.value) }),
                    h('div', { className: 'dsh-gk-labelgroups' },
                      filtered.length === 0
                        ? h('div', { className: 'dsh-gk-modalhint' }, t('composer.labelsEmpty'))
                        : groups.map(([scope, labels]) =>
                            h('div', { key: scope === '' ? '__other' : scope, className: 'dsh-gk-labelgroup' },
                              scope !== '' ? h('div', { className: 'dsh-gk-labelgroup-title' }, scope) : null,
                              h('div', { className: 'dsh-gk-labelchips' }, labels.map((label) =>
                                h('button', {
                                  key: label.name,
                                  type: 'button',
                                  className: `dsh-gk-labelsel-chip${cLabels.includes(label.name) ? ' is-on' : ''}`,
                                  style: cLabels.includes(label.name) ? { backgroundColor: hexToRgba(label.color ?? '#9aa0a6', 0.18), borderColor: hexToRgba(label.color ?? '#9aa0a6', 0.5) } : undefined,
                                  onClick: () => toggleLabel(label.name),
                                  'aria-pressed': cLabels.includes(label.name),
                                  title: label.name,
                                }, cLabels.includes(label.name) ? h(ICON.check, null) : null, shortLabel(label.name))))))))),
                h('aside', { className: 'dsh-gk-composer-side' },
                  target ? h('div', { className: 'dsh-gk-targetcol' }, h('span', { className: 'dsh-gk-field-title' }, t('composer.target')), h(LabelChip, { label: target })) : null,
                  h('label', { className: 'dsh-gk-field' },
                    h('span', null, t('composer.assignee')),
                    h('input', {
                      className: 'dsh-gk-input',
                      value: cAssignee,
                      spellCheck: false,
                      list: 'dsh-gk-assignees',
                      placeholder: t('composer.assigneePlaceholder'),
                      onChange: (event) => setCAssignee(event.target.value),
                    }),
                    h('datalist', { id: 'dsh-gk-assignees' }, assigneeOptions.map((user) => h('option', { key: user.username, value: user.username }, user.name ?? user.username)))),
                  h('label', { className: 'dsh-gk-field' },
                    h('span', null, t('composer.due')),
                    h('input', { className: 'dsh-gk-input', type: 'date', value: cDue, onChange: (event) => setCDue(event.target.value) })))),
              composerError !== null ? h('div', { className: 'dsh-gk-notice dsh-gk-notice-error', role: 'alert' }, composerError) : null),
            h('div', { className: 'dsh-gk-modal-foot' },
              h('span', { className: 'dsh-gk-modal-hint' }, t('composer.hint')),
              h('span', { className: 'dsh-gk-headspacer' }),
              h('button', { type: 'button', className: 'dsh-gk-btn dsh-gk-btn-ghost', onClick: () => setComposer(null) }, t('common.cancel')),
              h('button', { type: 'button', className: 'dsh-gk-btn dsh-gk-btn-primary', disabled: cTitle.trim() === '' || composerBusy, onClick: submitComposer }, composerBusy ? t('common.working') : t('composer.submit')))))
      }

      return h('div', { className: 'dsh-gk-root' },
        h('style', { key: 'dsh-gk-style' }, CSS),
        renderHeader(),
        renderBoard(),
        renderRepoPicker(),
        renderDetail(),
        renderComposer())
    }

    /* ------------------------------------------------------------------ */
    /* Styles                                                              */
    /* ------------------------------------------------------------------ */

    const CSS = `
.dsh-gk-root { box-sizing: border-box; height: 100%; display: flex; flex-direction: column; min-height: 0; color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 1.5; }

/* Header */
.dsh-gk-top { padding: 16px 22px 12px; display: flex; flex-direction: column; gap: 11px; border-bottom: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); }
.dsh-gk-head { display: flex; align-items: flex-start; gap: 11px; }
.dsh-gk-mark { flex: none; width: 34px; height: 34px; border-radius: 9px; display: flex; align-items: center; justify-content: center; color: var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent); border: 1px solid var(--dsw-alias-border-l1); }
.dsh-gk-headtext { min-width: 0; flex: 1; }
.dsh-gk-title { margin: 0; font-size: 16px; font-weight: 600; letter-spacing: -0.01em; }
.dsh-gk-sub { margin: 2px 0 0; color: var(--dsw-alias-label-secondary); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-gk-headspacer { flex: 1; }
.dsh-gk-me { display: inline-flex; align-items: center; gap: 6px; color: var(--dsw-alias-label-secondary); font-size: 11.5px; white-space: nowrap; }

.dsh-gk-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsh-gk-repo { flex: 1 1 300px; min-width: 0; display: inline-flex; align-items: center; gap: 8px; padding: 7px 10px; border-radius: 9px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12.5px; cursor: pointer; text-align: left; transition: border-color 150ms ease, background-color 150ms ease; }
.dsh-gk-repo:hover { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-brand-primary); }
.dsh-gk-repo-static { cursor: default; background: var(--dsw-alias-bg-layer-2); }
.dsh-gk-repo-static:hover { border-color: var(--dsw-alias-border-l2); }
.dsh-gk-sessionbadge { margin-left: auto; flex: none; font-size: 10px; color: var(--dsw-alias-label-secondary); padding: 1px 7px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); white-space: nowrap; }
.dsh-gk-repo-name { font-weight: 600; white-space: nowrap; }
.dsh-gk-repo-path { color: var(--dsw-alias-label-secondary); font-size: 11px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.dsh-gk-selectwrap { display: inline-flex; align-items: center; gap: 6px; padding: 0 8px; height: 34px; border-radius: 9px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); }
.dsh-gk-select { appearance: none; border: 0; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 12.5px; padding: 4px 2px; cursor: pointer; outline: none; max-width: 220px; }
.dsh-gk-select-wide { width: 100%; padding: 7px 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); }
.dsh-gk-select:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; border-radius: 6px; }

.dsh-gk-filters { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsh-gk-search { position: relative; display: flex; align-items: center; flex: 1 1 240px; min-width: 0; }
.dsh-gk-search-icon { position: absolute; left: 9px; display: flex; color: var(--dsw-alias-label-secondary); pointer-events: none; }
.dsh-gk-search .dsh-gk-input { padding-left: 30px; padding-right: 30px; width: 100%; }
.dsh-gk-search-clear { position: absolute; right: 6px; display: flex; align-items: center; justify-content: center; width: 20px; height: 20px; padding: 0; border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.dsh-gk-search-clear:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.dsh-gk-input { box-sizing: border-box; padding: 7px 10px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; font: inherit; font-size: 12.5px; outline: none; min-width: 0; transition: border-color 150ms ease, box-shadow 150ms ease; }
.dsh-gk-input:focus-visible { border-color: var(--dsw-alias-brand-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary) 18%, transparent); }
.dsh-gk-input::placeholder { color: var(--dsw-alias-label-secondary); opacity: 1; }
.dsh-gk-filter-select { padding: 7px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; cursor: pointer; outline: none; max-width: 180px; }
.dsh-gk-filter-select:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }

/* Buttons */
.dsh-gk-btn { flex: none; display: inline-flex; align-items: center; justify-content: center; gap: 5px; padding: 7px 12px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; cursor: pointer; white-space: nowrap; transition: background-color 150ms ease, border-color 150ms ease, color 150ms ease; }
.dsh-gk-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
.dsh-gk-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.dsh-gk-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsh-gk-btn-primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary-foreground, #fff); }
.dsh-gk-btn-primary:hover:not(:disabled) { filter: brightness(1.06); background: var(--dsw-alias-brand-primary); }
.dsh-gk-btn-ghost { border-color: transparent; background: transparent; color: var(--dsw-alias-label-secondary); }
.dsh-gk-btn-ghost:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.dsh-gk-btn-danger { color: var(--dsw-alias-state-error-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 32%, transparent); }
.dsh-gk-btn-danger:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); }
.dsh-gk-iconbtn { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 7px; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; text-decoration: none; }
.dsh-gk-iconbtn:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.dsh-gk-chip { display: inline-flex; align-items: center; gap: 5px; padding: 5px 10px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 11.5px; cursor: pointer; transition: background-color 140ms ease, border-color 140ms ease, color 140ms ease; }
.dsh-gk-chip:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsh-gk-chip:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.dsh-gk-chip.is-on { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent); border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 42%, transparent); color: var(--dsw-alias-label-primary); }
.dsh-gk-chip-plain { padding: 5px 8px; }
.dsh-gk-scopetag { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10.5px; color: var(--dsw-alias-label-secondary); padding: 2px 7px; border-radius: 6px; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); }

/* Board */
.dsh-gk-boardwrap { flex: 1; min-height: 0; overflow: auto; padding: 14px 22px 30px; }
.dsh-gk-sourcebar { margin: 0 2px 10px; padding: 7px 11px; border-radius: 8px; font-size: 11.5px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); }
.dsh-gk-hintbar { margin: 0 2px 10px; padding: 7px 11px; border-radius: 8px; font-size: 11.5px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); }
.dsh-gk-board { display: flex; gap: 14px; align-items: flex-start; }
.dsh-gk-col { flex: 0 0 300px; width: 300px; display: flex; flex-direction: column; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; transition: border-color 140ms ease, background-color 140ms ease; }
.dsh-gk-col.is-static { background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 70%, var(--dsw-alias-bg-base)); }
.dsh-gk-col.is-over { border-color: var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 7%, var(--dsw-alias-bg-layer-1)); }
.dsh-gk-col-head { display: flex; align-items: center; gap: 7px; padding: 10px 12px 8px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dsh-gk-dot { width: 9px; height: 9px; border-radius: 999px; flex: none; box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 0%, transparent); }
.dsh-gk-col-title { font-size: 12.5px; font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.dsh-gk-count { font-size: 11px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; padding: 1px 7px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); }
.dsh-gk-coladd { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; padding: 0; border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.dsh-gk-coladd:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.dsh-gk-col-body { display: flex; flex-direction: column; gap: 8px; padding: 8px; min-height: 44px; }
.dsh-gk-colempty { padding: 16px 8px; text-align: center; color: var(--dsw-alias-label-secondary); font-size: 11.5px; border: 1px dashed var(--dsw-alias-border-l1); border-radius: 9px; }
.dsh-gk-trunc { text-align: center; color: var(--dsw-alias-label-secondary); font-size: 10.5px; padding: 2px; }

/* Card */
.dsh-gk-card { display: flex; flex-direction: column; gap: 6px; padding: 9px 10px; border-radius: 9px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); cursor: grab; transition: border-color 150ms ease, background-color 150ms ease, box-shadow 150ms ease, opacity 150ms ease; }
.dsh-gk-card:active { cursor: grabbing; }
.dsh-gk-card:hover { border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 40%, var(--dsw-alias-border-l1)); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 4%, var(--dsw-alias-bg-layer-2)); }
.dsh-gk-card:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsh-gk-card.is-dragging { opacity: 0.45; }
.dsh-gk-card-top { display: flex; align-items: center; gap: 6px; }
.dsh-gk-card-iid { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10.5px; color: var(--dsw-alias-label-secondary); }
.dsh-gk-card-notes { margin-left: auto; display: inline-flex; align-items: center; gap: 3px; font-size: 10.5px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.dsh-gk-grip { display: inline-flex; align-items: center; margin-left: 6px; color: var(--dsw-alias-label-secondary); opacity: 0; transition: opacity 140ms ease; }
.dsh-gk-card:hover .dsh-gk-grip, .dsh-gk-card:focus-visible .dsh-gk-grip { opacity: 0.6; }
.dsh-gk-card-title { font-size: 12.5px; font-weight: 550; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; word-break: break-word; }
.dsh-gk-card-labels { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.dsh-gk-label { display: inline-flex; align-items: center; padding: 0 6px; border-radius: 5px; border: 1px solid transparent; font-size: 10px; line-height: 16px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-gk-more { font-size: 10px; color: var(--dsw-alias-label-secondary); }
.dsh-gk-card-foot { display: flex; align-items: center; gap: 8px; margin-top: 1px; min-height: 18px; }
.dsh-gk-card-spacer { flex: 1; }
.dsh-gk-avatars { display: inline-flex; align-items: center; }
.dsh-gk-avatars > * { margin-left: -5px; }
.dsh-gk-avatars > *:first-child { margin-left: 0; }
.dsh-gk-avatar { object-fit: cover; border-radius: 999px; border: 1.5px solid var(--dsw-alias-bg-layer-2); background: var(--dsw-alias-bg-layer-1); display: inline-flex; align-items: center; justify-content: center; }
.dsh-gk-avatar-fallback { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 18%, var(--dsw-alias-bg-layer-1)); color: var(--dsw-alias-brand-primary); font-weight: 600; }
.dsh-gk-avatar-more { font-size: 10px; color: var(--dsw-alias-label-secondary); padding-left: 3px; }
.dsh-gk-meta { display: inline-flex; align-items: center; gap: 3px; color: var(--dsw-alias-label-secondary); font-size: 10.5px; font-variant-numeric: tabular-nums; white-space: nowrap; }

/* Notices + empty */
.dsh-gk-notice { border-radius: 9px; padding: 8px 11px; font-size: 12px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); word-break: break-word; }
.dsh-gk-notice-error { color: var(--dsw-alias-state-error-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 32%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent); }
.dsh-gk-notice-ok { color: var(--dsw-alias-label-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 40%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent); }
.dsh-gk-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 7px; padding: 40px 20px; text-align: center; color: var(--dsw-alias-label-secondary); font-size: 12.5px; }
.dsh-gk-empty-icon { width: 46px; height: 46px; border-radius: 12px; display: flex; align-items: center; justify-content: center; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); }
.dsh-gk-empty-title { color: var(--dsw-alias-label-primary); font-weight: 600; font-size: 14px; }
.dsh-gk-empty-body { max-width: 440px; line-height: 1.6; }

/* Skeleton */
.dsh-gk-skel-bar { display: block; border-radius: 5px; background: linear-gradient(90deg, var(--dsw-alias-bg-layer-2) 25%, color-mix(in srgb, var(--dsw-alias-label-secondary) 12%, var(--dsw-alias-bg-layer-2)) 50%, var(--dsw-alias-bg-layer-2) 75%); background-size: 200% 100%; animation: dsh-gk-shimmer 1.25s ease-in-out infinite; }
.dsh-gk-skel .dsh-gk-col-head { height: 38px; }
.dsh-gk-skel .dsh-gk-card { gap: 8px; }
.dsh-gk-skel { pointer-events: none; }
.dsh-gk-skel .dsh-gk-card { cursor: default; border-color: var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); }
@keyframes dsh-gk-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
.dsh-gk-spin { animation: dsh-gk-rotate 900ms linear infinite; }
@keyframes dsh-gk-rotate { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .dsh-gk-skel-bar, .dsh-gk-spin { animation: none; }
  .dsh-gk-card, .dsh-gk-btn, .dsh-gk-chip, .dsh-gk-col { transition: none; }
}

/* Overlay + modal + drawer */
.dsh-gk-overlay { position: fixed; inset: 0; z-index: 60; background: rgba(6,8,14,0.42); backdrop-filter: blur(2px); display: flex; align-items: center; justify-content: center; padding: 24px; animation: dsh-gk-fade 140ms ease; }
@keyframes dsh-gk-fade { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .dsh-gk-overlay { animation: none; } }
.dsh-gk-modal { width: min(600px, 100%); max-height: min(86vh, 840px); display: flex; flex-direction: column; background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1)); border: 1px solid var(--dsw-alias-border-l2); border-radius: 16px; box-shadow: 0 26px 70px rgba(0,0,0,0.34); overflow: hidden; animation: dsh-gk-pop 170ms cubic-bezier(.2,.7,.3,1); }
.dsh-gk-modal-wide { width: min(780px, 100%); }
@keyframes dsh-gk-pop { from { opacity: 0; transform: translateY(8px) scale(.985); } to { opacity: 1; transform: none; } }
.dsh-gk-modal-head { display: flex; align-items: flex-start; gap: 12px; padding: 18px 20px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dsh-gk-modal-icon { flex: none; width: 36px; height: 36px; border-radius: 10px; display: flex; align-items: center; justify-content: center; color: var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent); border: 1px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 26%, transparent); }
.dsh-gk-modal-headtext { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.dsh-gk-modal-title { margin: 0; font-size: 16px; font-weight: 650; letter-spacing: -0.01em; }
.dsh-gk-modal-sub { margin: 0; font-size: 12px; color: var(--dsw-alias-label-secondary); line-height: 1.45; }
.dsh-gk-modal-body { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 16px 20px 18px; display: flex; flex-direction: column; gap: 14px; }
.dsh-gk-modal-foot { flex: none; display: flex; align-items: center; gap: 8px; padding: 12px 20px 16px; border-top: 1px solid var(--dsw-alias-border-l1); background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 55%, transparent); }
.dsh-gk-modal-hint { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dsh-gk-modalhint { color: var(--dsw-alias-label-secondary); font-size: 12px; padding: 6px 2px; }
.dsh-gk-modal-search { position: relative; display: flex; align-items: center; }
.dsh-gk-modal-search .dsh-gk-input { width: 100%; padding-left: 34px; padding-right: 34px; height: 38px; font-size: 13px; }
.dsh-gk-modal-search .dsh-gk-search-icon { left: 11px; }
.dsh-gk-modal-search .dsh-gk-search-clear { right: 8px; }
.dsh-gk-projectsection { display: flex; flex-direction: column; gap: 6px; }
.dsh-gk-projectsection-title { display: flex; align-items: center; gap: 5px; font-size: 10.5px; font-weight: 650; text-transform: uppercase; letter-spacing: .06em; color: var(--dsw-alias-label-secondary); padding: 0 2px; }
.dsh-gk-projectlist { display: flex; flex-direction: column; gap: 3px; }
.dsh-gk-projectlist-tall { max-height: min(38vh, 340px); overflow: auto; padding-right: 2px; }
.dsh-gk-projectrow { display: flex; align-items: center; gap: 10px; width: 100%; padding: 8px 10px; border: 1px solid transparent; border-radius: 10px; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; text-align: left; cursor: pointer; transition: background-color 130ms ease, border-color 130ms ease; }
.dsh-gk-projectrow:hover { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l1); }
.dsh-gk-projectrow:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsh-gk-projecttile { flex: none; width: 32px; height: 32px; border-radius: 9px; display: flex; align-items: center; justify-content: center; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); }
.dsh-gk-projecttext { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.dsh-gk-projectname { font-size: 12.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-gk-projectpath { font-size: 10.5px; color: var(--dsw-alias-label-secondary); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-gk-projectgo { flex: none; color: var(--dsw-alias-label-secondary); opacity: 0; transition: opacity 130ms ease; }
.dsh-gk-projectrow:hover .dsh-gk-projectgo, .dsh-gk-projectrow:focus-visible .dsh-gk-projectgo { opacity: 1; }
.dsh-gk-manual { border-top: 1px solid var(--dsw-alias-border-l1); padding-top: 10px; }
.dsh-gk-manual-summary { display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 11.5px; color: var(--dsw-alias-label-secondary); list-style: none; }
.dsh-gk-manual-summary::-webkit-details-marker { display: none; }
.dsh-gk-manual-summary:hover { color: var(--dsw-alias-label-primary); }
.dsh-gk-manualrow { display: flex; gap: 8px; margin-top: 8px; }
.dsh-gk-manualrow .dsh-gk-input { flex: 1; }
.dsh-gk-composer-grid { display: grid; grid-template-columns: minmax(0, 1fr) 232px; gap: 18px; align-items: start; }
.dsh-gk-composer-main, .dsh-gk-composer-side { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.dsh-gk-composer-side { padding: 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 11px; background: var(--dsw-alias-bg-layer-1); }
.dsh-gk-titleinput { box-sizing: border-box; width: 100%; padding: 10px 12px; font: inherit; font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l2); border-radius: 9px; outline: none; transition: border-color 150ms ease, box-shadow 150ms ease; }
.dsh-gk-titleinput:focus-visible { border-color: var(--dsw-alias-brand-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary) 18%, transparent); }
.dsh-gk-titleinput::placeholder { color: var(--dsw-alias-label-secondary); opacity: 1; }
.dsh-gk-descinput { min-height: 150px; line-height: 1.6; }
.dsh-gk-field-title { font-size: 10.5px; font-weight: 650; text-transform: uppercase; letter-spacing: .06em; color: var(--dsw-alias-label-secondary); }
.dsh-gk-labelblock { display: flex; flex-direction: column; gap: 8px; }
.dsh-gk-labelblock-head { display: flex; align-items: center; gap: 7px; }
.dsh-gk-linkbtn { border: 0; background: transparent; color: var(--dsw-alias-brand-primary); font: inherit; font-size: 11px; cursor: pointer; padding: 2px 4px; border-radius: 5px; }
.dsh-gk-linkbtn:hover { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent); }
.dsh-gk-selectedlabels { display: flex; flex-wrap: wrap; gap: 5px; }
.dsh-gk-selectedlabel { display: inline-flex; align-items: center; gap: 2px; padding-right: 3px; border-radius: 6px; background: var(--dsw-alias-bg-layer-2); }
.dsh-gk-selectedlabel-x { display: inline-flex; align-items: center; justify-content: center; width: 17px; height: 17px; padding: 0; border: 0; border-radius: 4px; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.dsh-gk-selectedlabel-x:hover { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
.dsh-gk-labelgroups { display: flex; flex-direction: column; gap: 10px; max-height: 210px; overflow: auto; padding: 6px 2px 6px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 9px; }
.dsh-gk-labelgroup { display: flex; flex-direction: column; gap: 5px; padding: 0 8px; }
.dsh-gk-labelgroup-title { font-size: 9.5px; font-weight: 650; text-transform: uppercase; letter-spacing: .05em; color: var(--dsw-alias-label-secondary); }
.dsh-gk-labelchips { display: flex; flex-wrap: wrap; gap: 5px; }
.dsh-gk-labelsel-chip { display: inline-flex; align-items: center; gap: 4px; padding: 3px 9px; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l1); background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 10.5px; cursor: pointer; transition: color 130ms ease, background-color 130ms ease, border-color 130ms ease; }
.dsh-gk-labelsel-chip:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }
.dsh-gk-labelsel-chip.is-on { color: var(--dsw-alias-label-primary); }
.dsh-gk-targetcol { display: flex; flex-direction: column; gap: 5px; padding-bottom: 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dsh-gk-willadd { display: flex; flex-direction: column; gap: 5px; padding-top: 10px; border-top: 1px solid var(--dsw-alias-border-l1); }
@media (max-width: 720px) {
  .dsh-gk-overlay { padding: 12px; }
  .dsh-gk-modal-wide { width: min(560px, 100%); }
  .dsh-gk-composer-grid { grid-template-columns: minmax(0, 1fr); }
  .dsh-gk-composer-side { padding: 0; border: 0; background: transparent; }
  .dsh-gk-modal-head { padding: 14px 16px 12px; }
  .dsh-gk-modal-body { padding: 14px 16px 16px; }
  .dsh-gk-modal-foot { padding: 10px 16px 14px; }
}
@media (prefers-reduced-motion: reduce) { .dsh-gk-modal { animation: none; } }

.dsh-gk-drawer { width: min(560px, 100%); height: 100%; max-height: 100%; display: flex; flex-direction: column; background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1)); border-left: 1px solid var(--dsw-alias-border-l2); box-shadow: -24px 0 64px rgba(0,0,0,0.3); margin-left: auto; animation: dsh-gk-slide 200ms cubic-bezier(.2,.7,.3,1); }
@keyframes dsh-gk-slide { from { transform: translateX(28px); opacity: .55; } to { transform: none; opacity: 1; } }
.dsh-gk-overlay:has(.dsh-gk-drawer) { align-items: stretch; justify-content: flex-end; padding: 0; }
.dsh-gk-drawer-head { display: flex; align-items: flex-start; gap: 10px; padding: 16px 18px 13px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dsh-gk-drawer-headtext { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 7px; }
.dsh-gk-drawer-kicker { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsh-gk-drawer-iid { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.dsh-gk-state { font-size: 10.5px; padding: 2px 8px; border-radius: 999px; border: 1px solid transparent; }
.dsh-gk-state.is-open { color: var(--dsw-alias-label-primary); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent); border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 34%, transparent); }
.dsh-gk-state.is-closed { color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l1); }
.dsh-gk-drawer-title { margin: 0; font-size: 17px; font-weight: 650; line-height: 1.35; letter-spacing: -0.01em; word-break: break-word; }
.dsh-gk-drawer-body { flex: 1; overflow: auto; padding: 16px 18px 30px; display: flex; flex-direction: column; gap: 16px; }
.dsh-gk-drawer-loading { flex: 1; display: flex; flex-direction: column; gap: 10px; padding: 22px 18px; }
.dsh-gk-meta-grid { display: flex; flex-wrap: wrap; gap: 10px 20px; }
.dsh-gk-meta-field { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.dsh-gk-meta-label { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: var(--dsw-alias-label-secondary); }
.dsh-gk-meta-value { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-primary); min-width: 0; }
.dsh-gk-assignee { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--dsw-alias-label-secondary); padding: 2px 8px 2px 2px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); }
.dsh-gk-sec { display: flex; flex-direction: column; gap: 8px; }
.dsh-gk-sec-head { display: flex; align-items: center; gap: 8px; }
.dsh-gk-sec-title { margin: 0; font-size: 10.5px; font-weight: 650; text-transform: uppercase; letter-spacing: .06em; color: var(--dsw-alias-label-secondary); }
.dsh-gk-sec-count { font-size: 10.5px; color: var(--dsw-alias-label-secondary); padding: 0 7px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); }
.dsh-gk-desc-card { background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 12px 14px; font-size: 12.5px; line-height: 1.65; color: var(--dsw-alias-label-primary); max-height: 380px; overflow: auto; word-break: break-word; }
.dsh-gk-md-p { margin: 0 0 8px; }
.dsh-gk-md-p:last-child { margin-bottom: 0; }
.dsh-gk-md-h { margin: 12px 0 6px; font-size: 13px; font-weight: 650; line-height: 1.4; }
.dsh-gk-md-h:first-child { margin-top: 0; }
.dsh-gk-md-list { margin: 0 0 8px; padding-left: 18px; display: flex; flex-direction: column; gap: 3px; }
.dsh-gk-md-quote { margin: 0 0 8px; padding: 6px 12px; border-left: 3px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-1); border-radius: 0 6px 6px 0; }
.dsh-gk-md-code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; padding: 1px 5px; border-radius: 4px; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); }
.dsh-gk-md-pre { margin: 0 0 8px; padding: 10px 12px; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; overflow: auto; font-size: 11px; line-height: 1.55; }
.dsh-gk-md-pre code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.dsh-gk-md-hr { border: 0; border-top: 1px solid var(--dsw-alias-border-l1); margin: 10px 0; }
.dsh-gk-md-ref { color: var(--dsw-alias-brand-primary); }
.dsh-gk-md-task { display: inline-flex; align-items: center; gap: 6px; list-style: none; }
.dsh-gk-md-check { width: 13px; height: 13px; border-radius: 4px; border: 1px solid var(--dsw-alias-border-l2); display: inline-flex; align-items: center; justify-content: center; font-size: 9px; line-height: 1; }
.dsh-gk-md-check.is-done { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary-foreground, #fff); }
.dsh-gk-attachments { display: flex; flex-direction: column; gap: 6px; }
.dsh-gk-attachment { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); text-decoration: none; font-size: 12px; transition: border-color 140ms ease, background-color 140ms ease; }
.dsh-gk-attachment:hover { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-2); }
.dsh-gk-attachment-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-gk-attachment-icon { display: inline-flex; color: var(--dsw-alias-label-secondary); }
.dsh-gk-asset-hint { font-size: 10.5px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
.dsh-gk-comments { display: flex; flex-direction: column; gap: 12px; }
.dsh-gk-comment { display: flex; gap: 9px; }
.dsh-gk-comment-main { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 4px; }
.dsh-gk-comment-head { display: flex; align-items: baseline; gap: 8px; }
.dsh-gk-comment-author { font-size: 12px; font-weight: 600; }
.dsh-gk-comment-time { font-size: 10.5px; color: var(--dsw-alias-label-secondary); }
.dsh-gk-comment-body { font-size: 12.5px; line-height: 1.6; word-break: break-word; }
.dsh-gk-comment-body .dsh-gk-md-p { margin: 0 0 6px; }
.dsh-gk-activity { border-top: 1px solid var(--dsw-alias-border-l1); padding-top: 8px; }
.dsh-gk-activity summary { cursor: pointer; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dsh-gk-activity-row { display: flex; align-items: center; gap: 7px; padding: 5px 0; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dsh-gk-activity-body { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-gk-activity-time { flex: none; font-size: 10px; }
.dsh-gk-composer { border-top: 1px solid var(--dsw-alias-border-l1); padding-top: 14px; }
@media (prefers-reduced-motion: reduce) { .dsh-gk-drawer { animation: none; } }
.dsh-gk-field { display: flex; flex-direction: column; gap: 5px; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.dsh-gk-field-row { display: flex; gap: 10px; }
.dsh-gk-field-half { flex: 1; }
.dsh-gk-textarea { box-sizing: border-box; width: 100%; padding: 8px 10px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; font: inherit; font-size: 12.5px; outline: none; resize: vertical; }
.dsh-gk-textarea:focus-visible { border-color: var(--dsw-alias-brand-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary) 18%, transparent); }
.dsh-gk-detail-btns { display: flex; gap: 8px; flex-wrap: wrap; }
`

    /* ------------------------------------------------------------------ */
    /* Locale + registration                                               */
    /* ------------------------------------------------------------------ */

    const NAMESPACE = 'dsh-glab-kanban'
    const EN = {
      'page.title': 'GitLab issues kanban',
      'page.subtitle': 'A kanban board over your GitLab issues, powered by glab.',
      'view.title': 'Board',
      'session.resolving': 'Resolving project…',
      'session.resolvingBody': 'Reading this session\'s workspace and its GitLab origin remote.',
      'session.noProjectTitle': 'No GitLab project bound',
      'session.noGitlabBody': 'This session\'s workspace has no GitLab origin remote.',
      'session.noDirBody': 'Could not read this session\'s working directory.',
      'session.retry': 'Retry',
      'session.bound': 'current project',
      'repo.choose': 'Choose a project',
      'repo.change': 'Change project',
      'repo.title': 'Choose a GitLab project',
      'repo.searchPlaceholder': 'Search projects…',
      'repo.none': 'No project matched. Type a path below.',
      'repo.manual': 'Use a project path directly',
      'repo.use': 'Use',
      'repo.invalid': 'Enter a project path like group/sub/project, or a numeric project id.',
      'repo.subtitle': 'Search the projects your glab login can reach.',
      'repo.recent': 'Recent',
      'repo.projects': 'Projects',
      'repo.noProjects': 'No projects available. Use a path below.',
      'repo.footerHint': 'Uses your glab login; no token is stored.',
      'board.label': 'Board',
      'action.refresh': 'Refresh',
      'action.newIssue': 'New issue',
      'filter.search': 'Filter loaded cards by title, number or label',
      'filter.clear': 'Clear search',
      'filter.assignee': 'Filter by assignee',
      'filter.anyone': 'Anyone',
      'filter.mine': 'Mine',
      'filter.clearAll': 'Clear filters',
      'scope.hint': 'Columns are labels sharing this scope',
      'col.untitled': 'Column',
      'col.backlog': 'Backlog',
      'col.empty': 'No issues',
      'col.noMatch': 'No match',
      'col.noMatchLoaded': 'No match in the loaded cards',
      'col.addHere': 'Create an issue in this column',
      'col.truncated': 'Showing {shown} of {total}',
      'col.truncatedFiltered': 'Search covers only the {loaded} loaded of {total}',
      'hint.drag': 'Drag a card between columns to change its status label.',
      'card.drag': 'Drag to another column to change status',
      'firstRun.title': 'glab is not ready',
      'firstRun.noGlab': 'The glab CLI was not found. Install it, then retry.',
      'firstRun.noAuth': 'glab is installed but not signed in. Run "glab auth login" in a terminal, then retry.',
      'firstRun.retry': 'Retry',
      'source.scope': 'No board found — columns built from labels prefixed {scope}.',
      'source.state': 'This board has no label-backed lists — showing read-only Open and Closed columns.',
      'state.open': 'Open',
      'state.closed': 'Closed',
      'detail.description': 'Description',
      'detail.noDescription': 'No description.',
      'detail.author': 'Author',
      'detail.assignees': 'Assignees',
      'detail.milestone': 'Milestone',
      'detail.due': 'Due',
      'detail.created': 'Created',
      'detail.comments': 'Comments',
      'detail.activity': 'Activity ({n})',
      'detail.noComments': 'No comments yet.',
      'detail.commentsError': 'Could not load comments: {message}',
      'detail.privateAssetHint': 'Images hosted on this private GitLab open in GitLab; a page without a GitLab session cannot embed them.',
      'detail.actions': 'Actions',
      'detail.moveTo': 'Move to column',
      'detail.chooseColumn': 'Choose a column…',
      'detail.currentColumn': 'Current: {name}',
      'detail.closeIssue': 'Close issue',
      'detail.reopenIssue': 'Reopen issue',
      'detail.comment': 'Add a comment',
      'detail.commentPlaceholder': 'Write a comment…',
      'detail.sendComment': 'Comment',
      'detail.open': 'Open in GitLab',
      'composer.title': 'New issue',
      'composer.subtitle': 'Create an issue in {project}.',
      'composer.selected': '{n} selected',
      'composer.clearLabels': 'Clear',
      'composer.labelsEmpty': 'No labels match.',
      'composer.target': 'Target column',
      'composer.willAdd': 'Will add',
      'composer.hint': '⌘/Ctrl + Enter to create',
      'common.remove': 'Remove',
      'composer.titleLabel': 'Title',
      'composer.titlePlaceholder': 'Short summary',
      'composer.descLabel': 'Description',
      'composer.descPlaceholder': 'Add details, steps, expected result…',
      'composer.assignee': 'Assignee',
      'composer.assigneePlaceholder': 'username',
      'composer.due': 'Due date',
      'composer.labels': 'Labels',
      'composer.filterLabels': 'Filter labels…',
      'composer.submit': 'Create issue',
      'notice.moved': 'Moved #{iid} to {name}.',
      'notice.immovable': 'This column is not backed by a label, so a card cannot be moved into it.',
      'notice.closed': 'Closed #{iid}.',
      'notice.reopened': 'Reopened #{iid}.',
      'notice.commented': 'Comment added to #{iid}.',
      'notice.created': 'Created “{title}”.',
      'empty.chooseRepoTitle': 'Choose a GitLab project',
      'empty.chooseRepoBody': 'Pick a project to load its issue board. Your glab login is used — no token is asked here.',
      'empty.loadTitle': 'Board unavailable',
      'empty.loadBody': 'The board could not be loaded. Check the message above, then refresh.',
      'empty.noColumnsTitle': 'No columns yet',
      'empty.noColumnsBody': 'This project has no issue board and no status label scope. Create a board in GitLab, or set statusScope in the plugin config.',
      'error.status': 'The plugin route did not answer: {message}',
      'common.loading': 'Loading…',
      'common.working': 'Working…',
      'common.cancel': 'Cancel',
      'common.close': 'Close',
      'time.now': 'just now',
      'time.minutes': '{n}m ago',
      'time.hours': '{n}h ago',
      'time.days': '{n}d ago',
      'time.months': '{n}mo ago',
      'time.years': '{n}y ago',
    }
    const ZH = {
      'page.title': 'GitLab Issue 看板',
      'page.subtitle': '基于 glab 的 GitLab Issue 看板。',
      'view.title': '看板',
      'session.resolving': '正在解析项目…',
      'session.resolvingBody': '正在读取当前会话的工作区及其 GitLab origin 远程。',
      'session.noProjectTitle': '未绑定 GitLab 项目',
      'session.noGitlabBody': '当前会话的工作区没有 GitLab origin 远程。',
      'session.noDirBody': '无法读取当前会话的工作目录。',
      'session.retry': '重试',
      'session.bound': '当前项目',
      'repo.choose': '选择项目',
      'repo.change': '切换项目',
      'repo.title': '选择 GitLab 项目',
      'repo.searchPlaceholder': '搜索项目…',
      'repo.none': '没有匹配的项目，可在下方直接输入路径。',
      'repo.manual': '直接输入项目路径',
      'repo.use': '使用',
      'repo.invalid': '请输入 group/sub/project 形式的项目路径，或数字项目 ID。',
      'repo.subtitle': '搜索你的 glab 登录可访问的项目。',
      'repo.recent': '最近',
      'repo.projects': '项目',
      'repo.noProjects': '没有可用项目，可在下方直接输入路径。',
      'repo.footerHint': '使用你的 glab 登录，不保存令牌。',
      'board.label': '看板',
      'action.refresh': '刷新',
      'action.newIssue': '新建 Issue',
      'filter.search': '在已加载卡片中筛选标题、编号或标签',
      'filter.clear': '清除搜索',
      'filter.assignee': '按指派人筛选',
      'filter.anyone': '任何人',
      'filter.mine': '我的',
      'filter.clearAll': '清除筛选',
      'scope.hint': '这些列是共享该作用域的标签',
      'col.untitled': '列',
      'col.backlog': '待办池',
      'col.empty': '暂无 Issue',
      'col.noMatch': '无匹配',
      'col.noMatchLoaded': '已加载的卡片中无匹配',
      'col.addHere': '在此列新建 Issue',
      'col.truncated': '显示 {shown} / {total}',
      'col.truncatedFiltered': '搜索仅覆盖已加载的 {loaded} / {total} 张卡片',
      'hint.drag': '把卡片拖到另一列即可切换状态标签。',
      'card.drag': '拖到另一列以切换状态',
      'firstRun.title': 'glab 尚未就绪',
      'firstRun.noGlab': '未找到 glab 命令行工具。请先安装，然后重试。',
      'firstRun.noAuth': 'glab 已安装但未登录。请在终端执行 "glab auth login"，然后重试。',
      'firstRun.retry': '重试',
      'source.scope': '未找到看板 —— 已按标签前缀 {scope} 生成列。',
      'source.state': '该看板没有由标签驱动的列 —— 显示只读的「打开 / 已关闭」列。',
      'state.open': '打开',
      'state.closed': '已关闭',
      'detail.description': '描述',
      'detail.noDescription': '暂无描述。',
      'detail.author': '作者',
      'detail.assignees': '指派给',
      'detail.milestone': '里程碑',
      'detail.due': '截止',
      'detail.created': '创建于',
      'detail.comments': '评论',
      'detail.activity': '动态（{n}）',
      'detail.noComments': '还没有评论。',
      'detail.commentsError': '评论加载失败：{message}',
      'detail.privateAssetHint': '私有 GitLab 上的图片需在 GitLab 中打开；没有 GitLab 网页会话的页面无法内嵌显示。',
      'detail.actions': '操作',
      'detail.moveTo': '移动到列',
      'detail.chooseColumn': '选择一列…',
      'detail.currentColumn': '当前：{name}',
      'detail.closeIssue': '关闭 Issue',
      'detail.reopenIssue': '重新打开 Issue',
      'detail.comment': '添加评论',
      'detail.commentPlaceholder': '写下评论…',
      'detail.sendComment': '评论',
      'detail.open': '在 GitLab 中打开',
      'composer.title': '新建 Issue',
      'composer.subtitle': '在 {project} 创建 Issue。',
      'composer.selected': '已选 {n} 个',
      'composer.clearLabels': '清除',
      'composer.labelsEmpty': '没有匹配的标签。',
      'composer.target': '目标列',
      'composer.willAdd': '将添加',
      'composer.hint': '⌘/Ctrl + Enter 创建',
      'common.remove': '移除',
      'composer.titleLabel': '标题',
      'composer.titlePlaceholder': '简要说明',
      'composer.descLabel': '描述',
      'composer.descPlaceholder': '补充详细信息、复现步骤、预期结果…',
      'composer.assignee': '指派给',
      'composer.assigneePlaceholder': '用户名',
      'composer.due': '截止日期',
      'composer.labels': '标签',
      'composer.filterLabels': '筛选标签…',
      'composer.submit': '创建 Issue',
      'notice.moved': '已将 #{iid} 移动到「{name}」。',
      'notice.immovable': '该列不是由标签驱动的，无法把卡片移入。',
      'notice.closed': '已关闭 #{iid}。',
      'notice.reopened': '已重新打开 #{iid}。',
      'notice.commented': '已为 #{iid} 添加评论。',
      'notice.created': '已创建「{title}」。',
      'empty.chooseRepoTitle': '选择一个 GitLab 项目',
      'empty.chooseRepoBody': '选择一个项目以加载它的 Issue 看板。这里直接使用你的 glab 登录，不会索要令牌。',
      'empty.loadTitle': '看板不可用',
      'empty.loadBody': '看板加载失败，请查看上方提示后刷新。',
      'empty.noColumnsTitle': '还没有列',
      'empty.noColumnsBody': '该项目既没有 Issue 看板也没有状态标签作用域。请在 GitLab 中创建看板，或在插件配置里设置 statusScope。',
      'error.status': '插件路由未应答：{message}',
      'common.loading': '加载中…',
      'common.working': '处理中…',
      'common.cancel': '取消',
      'common.close': '关闭',
      'time.now': '刚刚',
      'time.minutes': '{n} 分钟前',
      'time.hours': '{n} 小时前',
      'time.days': '{n} 天前',
      'time.months': '{n} 个月前',
      'time.years': '{n} 年前',
    }

    return {
      name: 'dsh-glab-kanban',
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NAMESPACE, { en: EN, zh: ZH }), 'dsh-glab-kanban: dictionaries')
        const t = ctx.locale.bind(NAMESPACE)

        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 40, label: () => t('page.title'), locale: NAMESPACE },
            (owner) => h(Glyph, { size: typeof owner?.size === 'number' ? owner.size : 20 }),
          ),
        )
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NAMESPACE }, (owner) => h(KanbanPanel, { ...owner, t })),
        )
        // The session-scoped View tab, bound to the current workspace project.
        ctx.slots.inject('conversation.view', () =>
          ctx.slots.register(
            { name: 'conversation.view', id: PANEL_ID, order: 40, label: () => t('view.title'), locale: NAMESPACE },
            (owner) => h(KanbanPanel, { ...owner, t, sessionId: owner.sessionId }),
          ),
        )
      },
    }
  },
})
