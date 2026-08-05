(() => {
  'use strict'

  if (window.KMusicLibraryPage && typeof window.KMusicLibraryPage.destroy === 'function') {
    window.KMusicLibraryPage.destroy()
  }

  const lifecycle = new AbortController()
  const signal = lifecycle.signal
  const root = normalizeRoot(window.GLOBAL_CONFIG && window.GLOBAL_CONFIG.root)
  const elements = {}
  const state = {
    tracks: [],
    trackMap: new Map(),
    singerAliasMap: new Map(),
    authorAliasMap: new Map(),
    filtered: [],
    selected: new Set(),
    suggestions: [],
    activeSuggestion: -1,
    player: null,
    toastTimer: 0
  }

  function normalizeRoot(value) {
    const raw = typeof value === 'string' && value ? value : '/'
    return raw.endsWith('/') ? raw : `${raw}/`
  }

  function encodePathSegment(segment) {
    if (!segment) return ''
    try {
      return encodeURIComponent(decodeURIComponent(segment))
    } catch (_) {
      return encodeURIComponent(segment)
    }
  }

  function assetUrl(path) {
    if (!path) return ''
    const raw = String(path).trim()
    if (/^(?:https?:)?\/\//i.test(raw) || /^(?:data|blob):/i.test(raw)) return raw

    const parts = raw.match(/^([^?#]*)([?#].*)?$/)
    const pathname = parts ? parts[1] : raw
    const suffix = parts && parts[2] ? parts[2] : ''
    // music-library.json 中以 /Kamonto_blog/ 开头的路径已经是部署路径，不能再次拼接 root。
    const localPath = pathname.startsWith('/')
      ? pathname
      : `${root}${pathname.replace(/^\/+/, '')}`
    const encodedPath = localPath.split('/').map(encodePathSegment).join('/')
    return `${encodedPath}${suffix}`
  }

  function text(value) {
    if (Array.isArray(value)) return value.filter(Boolean).join('、')
    if (value === null || value === undefined) return ''
    if (typeof value === 'object') return Object.values(value).map(text).filter(Boolean).join(' ')
    return String(value)
  }

  function normalize(value) {
    return text(value).toLocaleLowerCase().normalize('NFKC').trim()
  }

  function buildAliasMap(records, tableName) {
    if (!Array.isArray(records)) throw new Error(`music-library.json 中的 ${tableName} 必须是数组。`)
    const map = new Map()
    records.forEach((record, index) => {
      if (!record || typeof record.name !== 'string' || !record.name.trim()) {
        throw new Error(`${tableName}[${index}] 缺少有效的 name。`)
      }
      if (!Array.isArray(record.aliases)) {
        throw new Error(`${tableName} 中 ${record.name} 的 aliases 必须是数组。`)
      }
      const aliases = record.aliases.filter(Boolean)
      if (!aliases.length) {
        throw new Error(`${tableName} 中 ${record.name} 没有有效别名，请删除该条记录。`)
      }
      const key = normalize(record.name)
      if (map.has(key)) throw new Error(`${tableName} 中重复定义了 ${record.name}。`)
      map.set(key, { name: record.name, aliases })
    })
    return map
  }

  function aliasesFor(names, aliasMap) {
    const canonicalNames = Array.isArray(names) ? names : [names]
    return canonicalNames
      .filter(Boolean)
      // 标准名称未出现在别名表中时按“没有别名”处理，不影响标准名称搜索。
      .flatMap(name => aliasMap.get(normalize(name))?.aliases || [])
  }

  function formatDuration(seconds) {
    const value = Math.max(0, Number(seconds) || 0)
    const minutes = Math.floor(value / 60)
    const secs = Math.floor(value % 60)
    return `${minutes}:${String(secs).padStart(2, '0')}`
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;')
  }

  function cacheElements() {
    elements.total = document.getElementById('kmusic-library-total')
    elements.all = document.getElementById('kmusic-search-all')
    elements.tagSearch = document.getElementById('kmusic-search-tags')
    elements.aliasSearch = document.getElementById('kmusic-search-aliases')
    elements.suggestions = document.getElementById('kmusic-search-suggestions')
    elements.resetSearch = document.getElementById('kmusic-reset-search')
    elements.selectResults = document.getElementById('kmusic-select-results')
    elements.clearSelection = document.getElementById('kmusic-clear-selection')
    elements.resultCount = document.getElementById('kmusic-result-count')
    elements.grid = document.getElementById('kmusic-track-grid')
    elements.playSelected = document.getElementById('kmusic-play-selected')
    elements.addSelected = document.getElementById('kmusic-add-selected')
    elements.replaceQueue = document.getElementById('kmusic-replace-queue')
    elements.clearQueue = document.getElementById('kmusic-clear-queue')
    elements.queue = document.getElementById('kmusic-page-queue')
    elements.toast = document.getElementById('kmusic-page-toast')
  }

  async function loadLibrary() {
    const response = await fetch(`/Kamonto_blog/audio/music-library.json`, { cache: 'no-cache' })
    if (!response.ok) throw new Error(`音乐库请求失败：HTTP ${response.status}`)
    const data = await response.json()
    if (!data || !Array.isArray(data.tracks)) throw new Error('music-library.json 中缺少 tracks 数组。')

    state.singerAliasMap = buildAliasMap(data.singerAliases, 'singerAliases')
    state.authorAliasMap = buildAliasMap(data.authorAliases, 'authorAliases')

    const ids = new Set()
    state.tracks = data.tracks.filter(track => {
      if (!track || !track.id || !track.title || !track.file || ids.has(track.id)) return false
      ids.add(track.id)
      return true
    })
    state.trackMap = new Map(state.tracks.map(track => [track.id, track]))
    state.filtered = [...state.tracks]
    elements.total.textContent = `${state.tracks.length} 首本地歌曲`
  }

  function bindSearch() {
    elements.all.addEventListener('input', () => {
      applyFilters()
      renderSuggestions()
    })
    elements.all.addEventListener('focus', renderSuggestions)
    elements.all.addEventListener('keydown', handleSuggestionKeydown)

    ;[elements.tagSearch, elements.aliasSearch].forEach(option => {
      option.addEventListener('change', () => {
        applyFilters()
        renderSuggestions()
      })
    })

    elements.suggestions.addEventListener('mousedown', event => {
      const item = event.target.closest('[data-suggestion-index]')
      if (!item) return
      event.preventDefault()
      selectSuggestion(Number(item.dataset.suggestionIndex))
    })

    document.addEventListener('click', event => {
      if (!event.target.closest('.kmusic-library__autocomplete')) hideSuggestions()
    }, { signal })

    elements.resetSearch.addEventListener('click', () => {
      elements.all.value = ''
      elements.tagSearch.checked = false
      elements.aliasSearch.checked = false
      hideSuggestions()
      applyFilters()
      elements.all.focus()
    })

    elements.selectResults.addEventListener('click', () => {
      state.filtered.forEach(track => state.selected.add(track.id))
      renderTracks()
    })

    elements.clearSelection.addEventListener('click', () => {
      state.selected.clear()
      renderTracks()
    })
  }

  function applyFilters() {
    const query = normalize(elements.all.value)

    state.filtered = state.tracks.filter(track => {
      const singerNames = track.singers || track.artists
      const authorNames = track.authors || track.composers || track.author
      const singerAliases = aliasesFor(singerNames, state.singerAliasMap)
      const authorAliases = aliasesFor(authorNames, state.authorAliasMap)
      const strictText = normalize([track.title, track.translatedTitle, singerNames, authorNames])
      const tagText = elements.tagSearch.checked ? normalize(track.tags) : ''
      const aliasText = elements.aliasSearch.checked
        ? normalize([track.aliases, singerAliases, authorAliases])
        : ''

      return !query || strictText.includes(query) || tagText.includes(query) || aliasText.includes(query)
    })

    renderTracks()
  }

  function collectSuggestions(query) {
    const suggestions = []
    const seen = new Set()
    const add = (value, type, searchableValue = value) => {
      const label = text(value)
      if (!label || !normalize(searchableValue).includes(query)) return
      const key = `${type}:${normalize(label)}`
      if (seen.has(key)) return
      seen.add(key)
      suggestions.push({ value: label, label, type })
    }

    state.tracks.forEach(track => {
      const singerNames = track.singers || track.artists
      const authorNames = track.authors || track.composers || track.author
      add(track.title, '歌名')
      add(track.translatedTitle, '译名')
      ;(Array.isArray(singerNames) ? singerNames : [singerNames]).filter(Boolean).forEach(name => add(name, '歌手'))
      ;(Array.isArray(authorNames) ? authorNames : [authorNames]).filter(Boolean).forEach(name => add(name, '作者'))

      if (elements.tagSearch.checked) {
        ;(Array.isArray(track.tags) ? track.tags : [track.tags]).filter(Boolean).forEach(tag => add(tag, '标签'))
      }

      if (elements.aliasSearch.checked) {
        ;(Array.isArray(track.aliases) ? track.aliases : [track.aliases]).filter(Boolean)
          .forEach(alias => add(track.title, '歌名', alias))
      }
    })

    if (elements.aliasSearch.checked) {
      state.singerAliasMap.forEach(entry => {
        entry.aliases.forEach(alias => add(entry.name, '歌手', alias))
      })
      state.authorAliasMap.forEach(entry => {
        entry.aliases.forEach(alias => add(entry.name, '作者', alias))
      })
    }

    return suggestions.slice(0, 8)
  }

  function renderSuggestions() {
    const query = normalize(elements.all.value)
    if (!query) return hideSuggestions()
    state.suggestions = collectSuggestions(query)
    state.activeSuggestion = -1
    renderSuggestionList()
  }

  function renderSuggestionList() {
    if (!state.suggestions.length) return hideSuggestions()
    elements.suggestions.innerHTML = state.suggestions.map((suggestion, index) => `
      <button type="button" class="kmusic-library__suggestion${index === state.activeSuggestion ? ' is-active' : ''}"
        id="kmusic-suggestion-${index}" role="option" aria-selected="${index === state.activeSuggestion}"
        data-suggestion-index="${index}">
        <span class="kmusic-library__suggestion-label">${escapeHtml(suggestion.label)}</span>
        <span class="kmusic-library__suggestion-type">${escapeHtml(suggestion.type)}</span>
      </button>`).join('')
    elements.suggestions.hidden = false
    elements.all.setAttribute('aria-expanded', 'true')
    if (state.activeSuggestion >= 0) {
      elements.all.setAttribute('aria-activedescendant', `kmusic-suggestion-${state.activeSuggestion}`)
      elements.suggestions.children[state.activeSuggestion]?.scrollIntoView({ block: 'nearest' })
    } else {
      elements.all.removeAttribute('aria-activedescendant')
    }
  }

  function hideSuggestions() {
    state.suggestions = []
    state.activeSuggestion = -1
    elements.suggestions.hidden = true
    elements.suggestions.innerHTML = ''
    elements.all.setAttribute('aria-expanded', 'false')
    elements.all.removeAttribute('aria-activedescendant')
  }

  function selectSuggestion(index) {
    const suggestion = state.suggestions[index]
    if (!suggestion) return
    elements.all.value = suggestion.value
    hideSuggestions()
    applyFilters()
    elements.all.focus()
  }

  function handleSuggestionKeydown(event) {
    if (event.key === 'Escape') return hideSuggestions()
    if (event.key === 'Enter' && state.activeSuggestion >= 0) {
      event.preventDefault()
      return selectSuggestion(state.activeSuggestion)
    }
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return
    event.preventDefault()
    if (!state.suggestions.length) {
      renderSuggestions()
      if (!state.suggestions.length) return
    }
    const direction = event.key === 'ArrowDown' ? 1 : -1
    state.activeSuggestion = (state.activeSuggestion + direction + state.suggestions.length) % state.suggestions.length
    renderSuggestionList()
  }

  function renderTracks() {
    elements.resultCount.textContent = `${state.filtered.length} 首结果 · 已选择 ${state.selected.size} 首`
    const hasSelection = state.selected.size > 0
    elements.playSelected.disabled = !hasSelection
    elements.addSelected.disabled = !hasSelection
    elements.replaceQueue.disabled = !hasSelection

    if (!state.filtered.length) {
      elements.grid.innerHTML = '<div class="kmusic-library__empty"><i class="fas fa-search"></i><br>没有找到符合所有条件的歌曲。</div>'
      return
    }

    elements.grid.innerHTML = state.filtered.map(track => {
      const selected = state.selected.has(track.id)
      const translatedTitle = text(track.translatedTitle)
      const singers = text(track.singers || track.artists) || '未知歌手'
      const authors = text(track.authors || track.composers || track.author) || '未知作者'
      const tags = Array.isArray(track.tags) ? track.tags : []
      return `
        <article class="kmusic-library__track-card${selected ? ' is-selected' : ''}" data-track-id="${escapeHtml(track.id)}">
          <input class="kmusic-library__check" type="checkbox" aria-label="选择 ${escapeHtml(track.title)}" ${selected ? 'checked' : ''}>
          <img class="kmusic-library__cover" src="${escapeHtml(assetUrl(track.cover))}" alt="${escapeHtml(track.title)} 封面" loading="lazy">
          <div class="kmusic-library__track-main">
            <h3 class="kmusic-library__track-title" title="${escapeHtml(track.title)}">${escapeHtml(track.title)}</h3>
            ${translatedTitle ? `<div class="kmusic-library__track-translation" title="译名：${escapeHtml(translatedTitle)}">${escapeHtml(translatedTitle)}</div>` : ''}
            <div class="kmusic-library__track-singer"><i class="fas fa-microphone-alt"></i> ${escapeHtml(singers)}</div>
            <div class="kmusic-library__track-meta"><i class="fas fa-pen-nib"></i> ${escapeHtml(authors)} · ${escapeHtml(formatDuration(track.duration))}</div>
          </div>
          <div class="kmusic-library__tag-list">
            ${tags.slice(0, 4).map(tag => `<span class="kmusic-library__tag">${escapeHtml(tag)}</span>`).join('')}
          </div>
          <div class="kmusic-library__track-actions">
            <button type="button" class="kmusic-library__button" data-action="play"><i class="fas fa-play"></i> 播放</button>
            <button type="button" class="kmusic-library__button" data-action="add"><i class="fas fa-plus"></i> 加入队列</button>
          </div>
        </article>`
    }).join('')
  }

  function bindTrackGrid() {
    elements.grid.addEventListener('change', event => {
      const checkbox = event.target.closest('.kmusic-library__check')
      if (!checkbox) return
      const card = checkbox.closest('[data-track-id]')
      if (!card) return
      checkbox.checked ? state.selected.add(card.dataset.trackId) : state.selected.delete(card.dataset.trackId)
      renderTracks()
    })

    elements.grid.addEventListener('click', event => {
      const button = event.target.closest('[data-action]')
      if (!button) return
      const card = button.closest('[data-track-id]')
      if (!card) return
      const id = card.dataset.trackId
      const player = getPlayer()
      if (!player) return showToast('播放器仍在初始化，请稍后再试。')

      if (button.dataset.action === 'play') {
        player.playTrack(id)
        showToast(`开始播放：${state.trackMap.get(id)?.title || id}`)
      } else if (button.dataset.action === 'add') {
        player.addToQueue([id])
        showToast('已加入播放队列。')
      }
    })
  }

  function selectedIds() {
    return state.tracks.filter(track => state.selected.has(track.id)).map(track => track.id)
  }

  function bindBulkActions() {
    elements.playSelected.addEventListener('click', () => {
      const ids = selectedIds()
      const player = getPlayer()
      if (!player || !ids.length) return
      player.setQueue(ids, { playIndex: 0, autoplay: true })
      showToast(`已创建包含 ${ids.length} 首歌曲的队列并开始播放。`)
    })

    elements.addSelected.addEventListener('click', () => {
      const ids = selectedIds()
      const player = getPlayer()
      if (!player || !ids.length) return
      const added = player.addToQueue(ids)
      showToast(added ? `已添加 ${added} 首歌曲。` : '这些歌曲已经在队列中。')
    })

    elements.replaceQueue.addEventListener('click', () => {
      const ids = selectedIds()
      const player = getPlayer()
      if (!player || !ids.length) return
      player.setQueue(ids, { playIndex: 0, autoplay: false })
      showToast(`已用 ${ids.length} 首歌曲替换播放队列。`)
    })

    elements.clearQueue.addEventListener('click', () => {
      const player = getPlayer()
      if (!player) return
      player.clearQueue()
      showToast('播放队列已清空。')
    })
  }

  function getPlayer() {
    if (window.KMusicPlayer && window.KMusicPlayer.ready) state.player = window.KMusicPlayer
    return state.player
  }

  function connectPlayer() {
    const player = getPlayer()
    if (!player) return false
    renderQueue()
    return true
  }

  function renderQueue() {
    const player = getPlayer()
    if (!player) {
      elements.queue.innerHTML = '<li class="kmusic-library__loading">播放器正在初始化…</li>'
      return
    }

    const snapshot = player.getState()
    const queue = snapshot.queue || []
    if (!queue.length) {
      elements.queue.innerHTML = '<li class="kmusic-library__empty">当前队列为空。请从上方选择歌曲加入队列。</li>'
      return
    }

    elements.queue.innerHTML = queue.map((id, index) => {
      const track = state.trackMap.get(id) || player.getTrack(id)
      if (!track) return ''
      const singers = text(track.singers || track.artists) || '未知歌手'
      return `
        <li class="kmusic-library__queue-item${index === snapshot.currentIndex ? ' is-current' : ''}" data-queue-index="${index}">
          <span class="kmusic-library__queue-index">${index + 1}</span>
          <img class="kmusic-library__queue-cover" src="${escapeHtml(assetUrl(track.cover))}" alt="" loading="lazy">
          <div class="kmusic-library__queue-copy">
            <div class="kmusic-library__queue-title">${escapeHtml(track.title)}</div>
            <div class="kmusic-library__queue-singer">${escapeHtml(singers)}</div>
          </div>
          <div class="kmusic-library__queue-actions">
            <button type="button" class="kmusic-library__icon-button" data-queue-action="play" title="播放"><i class="fas fa-play"></i></button>
            <button type="button" class="kmusic-library__icon-button" data-queue-action="up" title="上移" ${index === 0 ? 'disabled' : ''}><i class="fas fa-arrow-up"></i></button>
            <button type="button" class="kmusic-library__icon-button" data-queue-action="down" title="下移" ${index === queue.length - 1 ? 'disabled' : ''}><i class="fas fa-arrow-down"></i></button>
            <button type="button" class="kmusic-library__icon-button" data-queue-action="remove" title="移除"><i class="fas fa-times"></i></button>
          </div>
        </li>`
    }).join('')
  }

  function bindQueue() {
    elements.queue.addEventListener('click', event => {
      const button = event.target.closest('[data-queue-action]')
      if (!button) return
      const item = button.closest('[data-queue-index]')
      const player = getPlayer()
      if (!item || !player) return
      const index = Number(item.dataset.queueIndex)

      switch (button.dataset.queueAction) {
        case 'play':
          player.playQueueIndex(index)
          break
        case 'up':
          player.moveQueue(index, -1)
          break
        case 'down':
          player.moveQueue(index, 1)
          break
        case 'remove':
          player.removeFromQueue(index)
          break
      }
    })

    window.addEventListener('kmusic:ready', () => connectPlayer(), { signal })
    window.addEventListener('kmusic:queuechange', renderQueue, { signal })
    window.addEventListener('kmusic:trackchange', renderQueue, { signal })
  }

  function showToast(message) {
    if (!elements.toast) return
    elements.toast.textContent = message
    elements.toast.classList.add('is-visible')
    window.clearTimeout(state.toastTimer)
    state.toastTimer = window.setTimeout(() => elements.toast.classList.remove('is-visible'), 2200)
  }

  function destroy() {
    lifecycle.abort()
    window.clearTimeout(state.toastTimer)
    if (window.KMusicLibraryPage && window.KMusicLibraryPage.destroy === destroy) {
      delete window.KMusicLibraryPage
    }
  }

  window.KMusicLibraryPage = { destroy }
  document.addEventListener('pjax:send', destroy, { once: true, signal })

  async function init() {
    const rootElement = document.getElementById('kmusic-library')
    if (!rootElement) return
    cacheElements()
    bindSearch()
    bindTrackGrid()
    bindBulkActions()
    bindQueue()

    try {
      await loadLibrary()
      renderTracks()
      connectPlayer()
    } catch (error) {
      console.error('[KMusic Library]', error)
      elements.grid.innerHTML = `<div class="kmusic-library__error"><i class="fas fa-exclamation-triangle"></i><br>${escapeHtml(error.message)}</div>`
      elements.total.textContent = '音乐库读取失败'
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true })
  } else {
    init()
  }
})()
