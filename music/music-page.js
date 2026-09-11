(() => {
  'use strict'

  if (window.KMusicLibraryPage && typeof window.KMusicLibraryPage.destroy === 'function') {
    window.KMusicLibraryPage.destroy()
  }

  const lifecycle = new AbortController()
  const signal = lifecycle.signal
  const root = normalizeRoot(window.GLOBAL_CONFIG && window.GLOBAL_CONFIG.root)
  const LIBRARY_URL = '/Kamonto_blog/audio/music-library.json'
  const DEFAULT_COVERS = ['/Kamonto_blog/cover/default1.png', '/Kamonto_blog/cover/default2.png']
  const SEARCH_KEYS = ['all', 'title', 'singer', 'author', 'tag']
  const elements = {}
  const state = {
    tracks: [],
    trackMap: new Map(),
    singerAliasMap: new Map(),
    authorAliasMap: new Map(),
    tagDisplayMap: new Map(),
    tagCatalog: [],
    filtered: [],
    selected: new Set(),
    suggestions: [],
    activeSuggestion: -1,
    activeSearchKey: 'all',
    trackPage: 1,
    trackPageSize: 6,
    queuePage: 1,
    queuePageSize: 5,
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

  function coverPath(track) {
    const configuredCover = typeof track?.cover === 'string' ? track.cover.trim() : ''
    if (configuredCover) return configuredCover

    const key = String(track?.id || track?.file || track?.title || '')
    const assignments = window.KMusicDefaultCoverAssignments instanceof Map
      ? window.KMusicDefaultCoverAssignments
      : (window.KMusicDefaultCoverAssignments = new Map())
    if (!assignments.has(key)) {
      assignments.set(key, DEFAULT_COVERS[Math.floor(Math.random() * DEFAULT_COVERS.length)])
    }
    return assignments.get(key)
  }

  function text(value) {
    if (Array.isArray(value)) return value.filter(Boolean).join(' ')
    if (value === null || value === undefined) return ''
    if (typeof value === 'object') return Object.values(value).map(text).filter(Boolean).join(' ')
    return String(value)
  }

  function formatPeople(value) {
    const names = (Array.isArray(value) ? value : [value]).filter(Boolean).map(String)
    const fullwidthPunctuationAtEnd = /[\u3000-\u303f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65]$/u
    const fullwidthPunctuationAtStart = /^[\u3000-\u303f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65]/u
    return names.reduce((result, name) => {
      if (!result) return name
      const leftSpace = fullwidthPunctuationAtEnd.test(result) ? '' : ' '
      const rightSpace = fullwidthPunctuationAtStart.test(name) ? '' : ' '
      return `${result}${leftSpace}×${rightSpace}${name}`
    }, '')
  }

  function normalize(value) {
    return text(value).toLocaleLowerCase().normalize('NFKC').trim()
  }

  function tagValues(track) {
    const seen = new Set()
    return (Array.isArray(track?.tags) ? track.tags : [])
      .filter(tag => typeof tag === 'string' && tag.trim())
      .map(tag => tag.trim())
      .filter(tag => {
        const key = normalize(tag)
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
  }

  function buildTagDisplayMap(records) {
    if (!Array.isArray(records)) throw new Error('music-library.json 中的 tagSettings 必须是数组。')
    const map = new Map()
    records.forEach((record, index) => {
      if (!record || typeof record.name !== 'string' || !record.name.trim()) {
        throw new Error(`tagSettings[${index}] 缺少有效的 name。`)
      }
      if (typeof record.showOnCard !== 'boolean') {
        throw new Error(`tagSettings 中 ${record.name} 的 showOnCard 必须是布尔值。`)
      }
      const key = normalize(record.name)
      if (map.has(key)) throw new Error(`tagSettings 中重复定义了 ${record.name}。`)
      map.set(key, record.showOnCard)
    })
    return map
  }

  function collectTagCatalog(tracks) {
    const catalog = new Map()
    tracks.forEach(track => {
      tagValues(track).forEach(tag => {
        const key = normalize(tag)
        const entry = catalog.get(key)
        entry ? entry.count += 1 : catalog.set(key, { name: tag, count: 1 })
      })
    })
    return [...catalog.values()].sort((left, right) =>
      right.count - left.count || left.name.localeCompare(right.name, 'zh-CN')
    )
  }

  function visibleTagsFor(track) {
    return tagValues(track).filter(tag => state.tagDisplayMap.get(normalize(tag)) === true)
  }

  function buildAliasMap(records, tableName) {
    if (!Array.isArray(records)) throw new Error(`music-library.json 中的 ${tableName} 必须是数组。`)
    const map = new Map()
    records.forEach((record, index) => {
      if (!record || typeof record.name !== 'string' || !record.name.trim()) {
        throw new Error(`${tableName}[${index}] 缺少有效的 name。`)
      }
      if (typeof record.translatedName !== 'string' || !record.translatedName.trim()) {
        throw new Error(`${tableName} 中 ${record.name} 缺少有效的 translatedName。`)
      }
      if (!Array.isArray(record.aliases)) {
        throw new Error(`${tableName} 中 ${record.name} 的 aliases 必须是数组。`)
      }
      if (!Array.isArray(record.links)) {
        throw new Error(`${tableName} 中 ${record.name} 的 links 必须是数组。`)
      }
      const translatedName = record.translatedName.trim()
      const aliases = record.aliases.filter(Boolean)
      const links = [...new Set(record.links.filter(link => typeof link === 'string' && link.trim()).map(link => link.trim()))]
      // 允许只登记标准名称的条目：作者已被完整收录，但萌娘百科未记载可用译名或别名时，
      // 仍可保留结构完整的记录；标准名称搜索继续由曲目本身提供，不会产生额外匹配。
      const key = normalize(record.name)
      if (map.has(key)) throw new Error(`${tableName} 中重复定义了 ${record.name}。`)
      map.set(key, { name: record.name, translatedName, aliases, links })
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

  function translatedNamesFor(names, aliasMap) {
    const canonicalNames = Array.isArray(names) ? names : [names]
    return canonicalNames
      .filter(Boolean)
      .map(name => aliasMap.get(normalize(name))?.translatedName)
      .filter(Boolean)
  }

  function directlyLinkedNames(query, aliasMap) {
    const linkedNames = new Set()
    if (!query) return linkedNames
    aliasMap.forEach(entry => {
      // 只用用户的原始查询匹配当前记录，不使用 links 的结果继续查表。
      if (!normalize([entry.name, entry.translatedName, ...entry.aliases]).includes(query)) return
      entry.links.forEach(name => linkedNames.add(normalize(name)))
    })
    return linkedNames
  }

  function containsLinkedName(names, linkedNames) {
    const canonicalNames = Array.isArray(names) ? names : [names]
    return canonicalNames.filter(Boolean).some(name => linkedNames.has(normalize(name)))
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

  function paginationElements(kind) {
    return {
      container: document.getElementById(`kmusic-${kind}-pagination`),
      summary: document.getElementById(`kmusic-${kind}-page-summary`),
      pageSize: document.getElementById(`kmusic-${kind}-page-size`),
      previous: document.getElementById(`kmusic-${kind}-page-prev`),
      status: document.getElementById(`kmusic-${kind}-page-status`),
      next: document.getElementById(`kmusic-${kind}-page-next`),
      input: document.getElementById(`kmusic-${kind}-page-input`),
      go: document.getElementById(`kmusic-${kind}-page-go`)
    }
  }

  function cacheElements() {
    elements.total = document.getElementById('kmusic-library-total')
    elements.searchInputs = Object.fromEntries(SEARCH_KEYS.map(key => [key, document.querySelector(`[data-search-key="${key}"]`)]))
    elements.suggestionLists = Object.fromEntries(SEARCH_KEYS.map(key => [key, document.querySelector(`[data-suggestions-key="${key}"]`)]))
    elements.tagField = document.getElementById('kmusic-search-tag-field')
    elements.tagSearch = document.getElementById('kmusic-search-tags')
    elements.aliasSearch = document.getElementById('kmusic-search-aliases')
    elements.tagBrowser = document.querySelector('.kmusic-library__tag-browser')
    elements.tagBrowserToggle = document.getElementById('kmusic-tag-browser-toggle')
    elements.tagBrowserCount = document.getElementById('kmusic-tag-browser-count')
    elements.tagBrowserPanel = document.getElementById('kmusic-tag-browser-panel')
    elements.tagBrowserList = document.getElementById('kmusic-tag-browser-list')
    elements.featuredTags = [...document.querySelectorAll('[data-featured-tag]')]
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
    elements.trackPagination = paginationElements('track')
    elements.queuePagination = paginationElements('queue')
  }

  async function loadLibrary() {
    if (!window.KMusicLibraryPromise) {
      const request = fetch(LIBRARY_URL, { cache: 'default', credentials: 'same-origin' })
        .then(response => {
          if (!response.ok) throw new Error(`音乐库请求失败：HTTP ${response.status}`)
          return response.json()
        })
        .then(data => {
          if (!data || !Array.isArray(data.tracks)) throw new Error('music-library.json 中缺少 tracks 数组。')
          return data
        })
        .catch(error => {
          if (window.KMusicLibraryPromise === request) delete window.KMusicLibraryPromise
          throw error
        })
      window.KMusicLibraryPromise = request
    }

    const data = await window.KMusicLibraryPromise
    if (!data || !Array.isArray(data.tracks)) throw new Error('music-library.json 中缺少 tracks 数组。')

    state.singerAliasMap = buildAliasMap(data.singerAliases, 'singerAliases')
    state.authorAliasMap = buildAliasMap(data.authorAliases, 'authorAliases')
    state.tagDisplayMap = buildTagDisplayMap(data.tagSettings)

    const ids = new Set()
    state.tracks = data.tracks.filter(track => {
      if (!track || !track.id || !track.title || !track.file || ids.has(track.id)) return false
      ids.add(track.id)
      return true
    })
    state.trackMap = new Map(state.tracks.map(track => [track.id, track]))
    state.tagCatalog = collectTagCatalog(state.tracks)
    state.filtered = [...state.tracks]
    elements.total.textContent = `${state.tracks.length} 首本地歌曲`
    renderTagBrowser()
  }

  function bindSearch() {
    SEARCH_KEYS.forEach(key => {
      const input = elements.searchInputs[key]
      const suggestions = elements.suggestionLists[key]
      input.addEventListener('input', () => {
        state.activeSearchKey = key
        applyFilters()
        if (key === 'tag') syncTagBrowserSelection()
        renderSuggestions(key)
      })
      input.addEventListener('focus', () => renderSuggestions(key))
      input.addEventListener('keydown', event => handleSuggestionKeydown(event, key))

      suggestions.addEventListener('mousedown', event => {
        const item = event.target.closest('[data-suggestion-index]')
        if (!item) return
        event.preventDefault()
        selectSuggestion(Number(item.dataset.suggestionIndex), key)
      })
    })

    elements.tagSearch.addEventListener('change', () => {
      syncTagSearchState()
      applyFilters()
      renderSuggestions(state.activeSearchKey)
    })

    elements.aliasSearch.addEventListener('change', () => {
      applyFilters()
      renderSuggestions(state.activeSearchKey)
    })

    elements.tagBrowserToggle.addEventListener('click', () => {
      setTagBrowserOpen(elements.tagBrowserPanel.hidden)
    })

    elements.tagBrowserList.addEventListener('click', event => {
      const button = event.target.closest('[data-tag-filter]')
      if (!button) return
      selectTag(button.dataset.tagFilter)
    })

    elements.featuredTags.forEach(button => {
      button.addEventListener('click', () => selectTag(button.dataset.featuredTag, { clearSearches: true }))
    })

    document.addEventListener('click', event => {
      if (!event.target.closest('.kmusic-library__autocomplete')) hideSuggestions()
      if (!event.target.closest('.kmusic-library__tag-browser')) setTagBrowserOpen(false)
    }, { signal })

    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') setTagBrowserOpen(false)
    }, { signal })

    elements.resetSearch.addEventListener('click', () => {
      SEARCH_KEYS.forEach(key => { elements.searchInputs[key].value = '' })
      elements.tagSearch.checked = false
      elements.aliasSearch.checked = false
      syncTagSearchState()
      setTagBrowserOpen(false)
      hideSuggestions()
      applyFilters()
      elements.searchInputs.all.focus()
    })

    elements.selectResults.addEventListener('click', () => {
      state.filtered.forEach(track => state.selected.add(track.id))
      renderTracks()
    })

    elements.clearSelection.addEventListener('click', () => {
      state.selected.clear()
      renderTracks()
    })

    syncTagSearchState()
  }

  function syncTagSearchState() {
    const enabled = elements.tagSearch.checked
    const input = elements.searchInputs.tag
    elements.searchInputs.all.placeholder = enabled
      ? '跨歌名、歌手、作者和标签搜索'
      : '跨歌名、歌手和作者搜索'
    input.disabled = !enabled
    input.setAttribute('aria-disabled', String(!enabled))
    input.placeholder = enabled ? '仅搜索标签' : '请先勾选“标签搜索”'
    elements.tagField.classList.toggle('is-disabled', !enabled)
    if (!enabled) {
      input.value = ''
      if (state.activeSearchKey === 'tag') hideSuggestions()
    }
    syncTagBrowserSelection()
  }

  function setTagBrowserOpen(open) {
    const expanded = Boolean(open)
    elements.tagBrowserPanel.hidden = !expanded
    elements.tagBrowserToggle.setAttribute('aria-expanded', String(expanded))
  }

  function renderTagBrowser() {
    elements.tagBrowserCount.textContent = `(${state.tagCatalog.length})`
    if (!state.tagCatalog.length) {
      elements.tagBrowserList.innerHTML = '<div class="kmusic-library__tag-browser-empty">音乐库中暂时还没有标签。</div>'
      return
    }
    elements.tagBrowserList.innerHTML = state.tagCatalog.map(tag => `
      <button type="button" class="kmusic-library__tag-choice" data-tag-filter="${escapeHtml(tag.name)}" aria-pressed="false">
        <span>${escapeHtml(tag.name)}</span><small>${tag.count} 首</small>
      </button>`).join('')
    syncTagBrowserSelection()
  }

  function syncTagBrowserSelection() {
    if (!elements.tagBrowserList) return
    const selected = elements.tagSearch.checked ? normalize(elements.searchInputs.tag.value) : ''
    elements.tagBrowserList.querySelectorAll('[data-tag-filter]').forEach(button => {
      const active = Boolean(selected) && normalize(button.dataset.tagFilter) === selected
      button.classList.toggle('is-active', active)
      button.setAttribute('aria-pressed', String(active))
    })
  }

  function selectTag(tag, options = {}) {
    const value = text(tag).trim()
    if (!value) return
    if (options.clearSearches) {
      SEARCH_KEYS.forEach(key => { elements.searchInputs[key].value = '' })
    }
    // 当前界面只写入一个标签；未来若开放多标签，可在这里改为维护标签数组。
    elements.tagSearch.checked = true
    elements.searchInputs.tag.value = value
    state.activeSearchKey = 'tag'
    syncTagSearchState()
    setTagBrowserOpen(false)
    applyFilters()
    elements.searchInputs.tag.focus()
    hideSuggestions()
  }

  function searchQueries() {
    return {
      all: normalize(elements.searchInputs.all.value),
      title: normalize(elements.searchInputs.title.value),
      singer: normalize(elements.searchInputs.singer.value),
      author: normalize(elements.searchInputs.author.value),
      tag: elements.tagSearch.checked ? normalize(elements.searchInputs.tag.value) : ''
    }
  }

  function applyFilters() {
    const queries = searchQueries()
    const aliasSearchEnabled = elements.aliasSearch.checked
    state.trackPage = 1
    const linkedNames = {
      globalSingers: aliasSearchEnabled ? directlyLinkedNames(queries.all, state.singerAliasMap) : new Set(),
      globalAuthors: aliasSearchEnabled ? directlyLinkedNames(queries.all, state.authorAliasMap) : new Set(),
      singers: aliasSearchEnabled ? directlyLinkedNames(queries.singer, state.singerAliasMap) : new Set(),
      authors: aliasSearchEnabled ? directlyLinkedNames(queries.author, state.authorAliasMap) : new Set()
    }

    state.filtered = state.tracks.filter(track => {
      const singerNames = track.singers || track.artists
      const authorNames = track.authors || track.composers || track.author
      const singerAliases = aliasesFor(singerNames, state.singerAliasMap)
      const authorAliases = aliasesFor(authorNames, state.authorAliasMap)
      const singerTranslatedNames = translatedNamesFor(singerNames, state.singerAliasMap)
      const authorTranslatedNames = translatedNamesFor(authorNames, state.authorAliasMap)
      const titleText = normalize([track.title, track.translatedTitle])
      const singerText = normalize([singerNames, singerTranslatedNames])
      const authorText = normalize([authorNames, authorTranslatedNames])
      const tagText = normalize(track.tags)
      const titleAliasText = aliasSearchEnabled ? normalize(track.aliases) : ''
      const singerAliasText = aliasSearchEnabled ? normalize(singerAliases) : ''
      const authorAliasText = aliasSearchEnabled ? normalize(authorAliases) : ''
      const strictGlobalText = normalize([
        track.title,
        track.translatedTitle,
        singerNames,
        singerTranslatedNames,
        authorNames,
        authorTranslatedNames
      ])
      const aliasGlobalText = aliasSearchEnabled ? normalize([track.aliases, singerAliases, authorAliases]) : ''

      const globalMatch = !queries.all ||
        strictGlobalText.includes(queries.all) ||
        (elements.tagSearch.checked && tagText.includes(queries.all)) ||
        (aliasSearchEnabled && (
          aliasGlobalText.includes(queries.all) ||
          containsLinkedName(singerNames, linkedNames.globalSingers) ||
          containsLinkedName(authorNames, linkedNames.globalAuthors)
        ))
      const titleMatch = !queries.title ||
        titleText.includes(queries.title) ||
        (aliasSearchEnabled && titleAliasText.includes(queries.title))
      const singerMatch = !queries.singer ||
        singerText.includes(queries.singer) ||
        (aliasSearchEnabled && (
          singerAliasText.includes(queries.singer) ||
          containsLinkedName(singerNames, linkedNames.singers)
        ))
      const authorMatch = !queries.author ||
        authorText.includes(queries.author) ||
        (aliasSearchEnabled && (
          authorAliasText.includes(queries.author) ||
          containsLinkedName(authorNames, linkedNames.authors)
        ))
      const tagMatch = !queries.tag || tagText.includes(queries.tag)

      return globalMatch && titleMatch && singerMatch && authorMatch && tagMatch
    })

    renderTracks()
  }

  function collectSuggestions(query, searchKey) {
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
    const addNames = (names, type, aliasMap) => {
      ;(Array.isArray(names) ? names : [names]).filter(Boolean).forEach(name => {
        add(name, type)
        const translatedName = aliasMap.get(normalize(name))?.translatedName
        if (translatedName && normalize(translatedName) !== normalize(name)) {
          add(translatedName, `${type}译名`)
        }
      })
    }

    state.tracks.forEach(track => {
      const singerNames = track.singers || track.artists
      const authorNames = track.authors || track.composers || track.author
      if (searchKey === 'all' || searchKey === 'title') {
        add(track.title, '歌名')
        if (track.translatedTitle && normalize(track.translatedTitle) !== normalize(track.title)) {
          add(track.translatedTitle, '译名')
        }
      }
      if (searchKey === 'all' || searchKey === 'singer') {
        addNames(singerNames, '歌手', state.singerAliasMap)
      }
      if (searchKey === 'all' || searchKey === 'author') {
        addNames(authorNames, '作者', state.authorAliasMap)
      }

      if (elements.tagSearch.checked && (searchKey === 'all' || searchKey === 'tag')) {
        ;(Array.isArray(track.tags) ? track.tags : [track.tags]).filter(Boolean).forEach(tag => add(tag, '标签'))
      }

      if (elements.aliasSearch.checked && (searchKey === 'all' || searchKey === 'title')) {
        ;(Array.isArray(track.aliases) ? track.aliases : [track.aliases]).filter(Boolean)
          .forEach(alias => add(track.title, '歌名', alias))
      }
    })

    if (elements.aliasSearch.checked && (searchKey === 'all' || searchKey === 'singer')) {
      state.singerAliasMap.forEach(entry => {
        if (normalize([entry.name, entry.translatedName, ...entry.aliases]).includes(query)) {
          add(entry.name, '歌手', query)
          if (normalize(entry.translatedName) !== normalize(entry.name)) {
            add(entry.translatedName, '歌手译名', query)
          }
          entry.links.forEach(name => add(name, '关联歌手', query))
        }
      })
    }
    if (elements.aliasSearch.checked && (searchKey === 'all' || searchKey === 'author')) {
      state.authorAliasMap.forEach(entry => {
        if (normalize([entry.name, entry.translatedName, ...entry.aliases]).includes(query)) {
          add(entry.name, '作者', query)
          if (normalize(entry.translatedName) !== normalize(entry.name)) {
            add(entry.translatedName, '作者译名', query)
          }
          entry.links.forEach(name => add(name, '关联作者', query))
        }
      })
    }

    return suggestions.slice(0, 8)
  }

  function renderSuggestions(searchKey = state.activeSearchKey) {
    const input = elements.searchInputs[searchKey]
    if (!input || input.disabled) return hideSuggestions()
    const query = normalize(input.value)
    if (!query) return hideSuggestions()
    state.activeSearchKey = searchKey
    state.suggestions = collectSuggestions(query, searchKey)
    state.activeSuggestion = -1
    renderSuggestionList()
  }

  function renderSuggestionList() {
    if (!state.suggestions.length) return hideSuggestions()
    const searchKey = state.activeSearchKey
    const input = elements.searchInputs[searchKey]
    const suggestionList = elements.suggestionLists[searchKey]
    SEARCH_KEYS.forEach(key => {
      if (key === searchKey) return
      elements.suggestionLists[key].hidden = true
      elements.suggestionLists[key].innerHTML = ''
      elements.searchInputs[key].setAttribute('aria-expanded', 'false')
      elements.searchInputs[key].removeAttribute('aria-activedescendant')
    })
    suggestionList.innerHTML = state.suggestions.map((suggestion, index) => `
      <button type="button" class="kmusic-library__suggestion${index === state.activeSuggestion ? ' is-active' : ''}"
        id="kmusic-suggestion-${searchKey}-${index}" role="option" aria-selected="${index === state.activeSuggestion}"
        data-suggestion-index="${index}">
        <span class="kmusic-library__suggestion-label">${escapeHtml(suggestion.label)}</span>
        <span class="kmusic-library__suggestion-type">${escapeHtml(suggestion.type)}</span>
      </button>`).join('')
    suggestionList.hidden = false
    input.setAttribute('aria-expanded', 'true')
    if (state.activeSuggestion >= 0) {
      input.setAttribute('aria-activedescendant', `kmusic-suggestion-${searchKey}-${state.activeSuggestion}`)
      suggestionList.children[state.activeSuggestion]?.scrollIntoView({ block: 'nearest' })
    } else {
      input.removeAttribute('aria-activedescendant')
    }
  }

  function hideSuggestions() {
    state.suggestions = []
    state.activeSuggestion = -1
    SEARCH_KEYS.forEach(key => {
      elements.suggestionLists[key].hidden = true
      elements.suggestionLists[key].innerHTML = ''
      elements.searchInputs[key].setAttribute('aria-expanded', 'false')
      elements.searchInputs[key].removeAttribute('aria-activedescendant')
    })
  }

  function selectSuggestion(index, searchKey = state.activeSearchKey) {
    const suggestion = state.suggestions[index]
    if (!suggestion) return
    state.activeSearchKey = searchKey
    elements.searchInputs[searchKey].value = suggestion.value
    hideSuggestions()
    applyFilters()
    if (searchKey === 'tag') syncTagBrowserSelection()
    elements.searchInputs[searchKey].focus()
  }

  function handleSuggestionKeydown(event, searchKey) {
    state.activeSearchKey = searchKey
    if (event.key === 'Escape') return hideSuggestions()
    if (event.key === 'Enter' && state.activeSuggestion >= 0) {
      event.preventDefault()
      return selectSuggestion(state.activeSuggestion, searchKey)
    }
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return
    event.preventDefault()
    if (!state.suggestions.length) {
      renderSuggestions(searchKey)
      if (!state.suggestions.length) return
    }
    const direction = event.key === 'ArrowDown' ? 1 : -1
    state.activeSuggestion = (state.activeSuggestion + direction + state.suggestions.length) % state.suggestions.length
    renderSuggestionList()
  }

  function bindPaginationControls(controls, pageKey, pageSizeKey, render) {
    controls.pageSize.addEventListener('change', () => {
      state[pageSizeKey] = Math.max(1, Number(controls.pageSize.value) || state[pageSizeKey])
      state[pageKey] = 1
      render()
    })

    controls.previous.addEventListener('click', () => {
      state[pageKey] -= 1
      render()
    })

    controls.next.addEventListener('click', () => {
      state[pageKey] += 1
      render()
    })

    const jump = () => {
      const requestedPage = Math.trunc(Number(controls.input.value))
      if (!Number.isFinite(requestedPage)) return
      state[pageKey] = requestedPage
      render()
      controls.input.select()
    }

    controls.go.addEventListener('click', jump)
    controls.input.addEventListener('keydown', event => {
      if (event.key !== 'Enter') return
      event.preventDefault()
      jump()
    })
  }

  function bindPagination() {
    bindPaginationControls(elements.trackPagination, 'trackPage', 'trackPageSize', renderTracks)
    bindPaginationControls(elements.queuePagination, 'queuePage', 'queuePageSize', renderQueue)
  }

  function paginate(controls, totalItems, pageKey, pageSizeKey) {
    if (totalItems <= 0) {
      controls.container.hidden = true
      state[pageKey] = 1
      return { start: 0, end: 0, page: 1, totalPages: 1 }
    }

    const pageSize = Math.max(1, Number(state[pageSizeKey]) || 1)
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize))
    const page = Math.min(totalPages, Math.max(1, Math.trunc(Number(state[pageKey])) || 1))
    const start = (page - 1) * pageSize
    const end = Math.min(totalItems, start + pageSize)
    state[pageKey] = page

    controls.container.hidden = false
    controls.summary.textContent = `第 ${start + 1}–${end} 首，共 ${totalItems} 首`
    controls.status.textContent = `${page} / ${totalPages} 页`
    controls.previous.disabled = page <= 1
    controls.next.disabled = page >= totalPages
    controls.input.max = String(totalPages)
    controls.input.value = String(page)

    return { start, end, page, totalPages }
  }

  function renderTracks() {
    elements.resultCount.textContent = `${state.filtered.length} 首结果 · 已选择 ${state.selected.size} 首`
    const hasSelection = state.selected.size > 0
    elements.playSelected.disabled = !hasSelection
    elements.addSelected.disabled = !hasSelection
    elements.replaceQueue.disabled = !hasSelection

    const page = paginate(elements.trackPagination, state.filtered.length, 'trackPage', 'trackPageSize')
    if (!state.filtered.length) {
      elements.grid.innerHTML = '<div class="kmusic-library__empty"><i class="fas fa-search"></i><br>没有找到符合所有条件的歌曲。</div>'
      return
    }

    elements.grid.innerHTML = state.filtered.slice(page.start, page.end).map(track => {
      const selected = state.selected.has(track.id)
      const translatedTitle = text(track.translatedTitle)
      const singers = formatPeople(track.singers || track.artists) || '未知歌手'
      const authors = formatPeople(track.authors || track.composers || track.author) || '未知作者'
      const tags = visibleTagsFor(track)
      return `
        <article class="kmusic-library__track-card${selected ? ' is-selected' : ''}" data-track-id="${escapeHtml(track.id)}" tabindex="0" role="option" aria-selected="${selected}">
          <input class="kmusic-library__check" type="checkbox" aria-label="选择 ${escapeHtml(track.title)}" ${selected ? 'checked' : ''}>
          <img class="kmusic-library__cover" src="${escapeHtml(assetUrl(coverPath(track)))}" alt="${escapeHtml(track.title)} 封面" loading="lazy">
          <div class="kmusic-library__track-main">
            <h3 class="kmusic-library__track-title" title="${escapeHtml(track.title)}">${escapeHtml(track.title)}</h3>
            ${translatedTitle ? `<div class="kmusic-library__track-translation" title="译名：${escapeHtml(translatedTitle)}">${escapeHtml(translatedTitle)}</div>` : ''}
            <div class="kmusic-library__track-singer"><i class="fas fa-microphone-alt"></i> ${escapeHtml(singers)}</div>
            <div class="kmusic-library__track-meta"><i class="fas fa-pen-nib"></i> ${escapeHtml(authors)} · ${escapeHtml(formatDuration(track.duration))}</div>
          </div>
          ${tags.length ? `<div class="kmusic-library__tag-list">
            ${tags.map(tag => `<button type="button" class="kmusic-library__tag" data-tag-filter="${escapeHtml(tag)}" title="搜索标签：${escapeHtml(tag)}">${escapeHtml(tag)}</button>`).join('')}
          </div>` : ''}
          <div class="kmusic-library__track-actions">
            <button type="button" class="kmusic-library__button" data-action="play"><i class="fas fa-play"></i> 播放</button>
            <button type="button" class="kmusic-library__button" data-action="add"><i class="fas fa-plus"></i> 加入队列</button>
          </div>
        </article>`
    }).join('')
  }

  function toggleTrackSelection(card) {
    const id = card?.dataset.trackId
    if (!id) return
    state.selected.has(id) ? state.selected.delete(id) : state.selected.add(id)
    renderTracks()
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
      const tagButton = event.target.closest('[data-tag-filter]')
      if (tagButton) {
        selectTag(tagButton.dataset.tagFilter)
        return
      }

      const button = event.target.closest('[data-action]')
      if (button) {
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
        return
      }

      const card = event.target.closest('[data-track-id]')
      if (!card || event.target.closest('input, a, button, select, textarea, label, .kmusic-library__track-actions')) return
      toggleTrackSelection(card)
    })

    elements.grid.addEventListener('keydown', event => {
      if (!['Enter', ' '].includes(event.key)) return
      if (event.target.closest('input, a, button, select, textarea, label, .kmusic-library__track-actions')) return
      const card = event.target.closest('[data-track-id]')
      if (!card) return
      event.preventDefault()
      toggleTrackSelection(card)
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
    renderQueue({ followCurrent: true })
    return true
  }

  function renderQueue(options = {}) {
    const player = getPlayer()
    if (!player) {
      elements.queue.innerHTML = '<li class="kmusic-library__loading">播放器正在初始化…</li>'
      elements.queuePagination.container.hidden = true
      return
    }

    const snapshot = player.getState()
    const queue = snapshot.queue || []
    if (options.followCurrent && queue.length) {
      state.queuePage = Math.floor(snapshot.currentIndex / state.queuePageSize) + 1
    }
    const page = paginate(elements.queuePagination, queue.length, 'queuePage', 'queuePageSize')
    if (!queue.length) {
      elements.queue.innerHTML = '<li class="kmusic-library__empty">当前队列为空。请从上方选择歌曲加入队列。</li>'
      return
    }

    elements.queue.innerHTML = queue.slice(page.start, page.end).map((id, offset) => {
      const index = page.start + offset
      const track = state.trackMap.get(id) || player.getTrack(id)
      if (!track) return ''
      const singers = formatPeople(track.singers || track.artists) || '未知歌手'
      return `
        <li class="kmusic-library__queue-item${index === snapshot.currentIndex ? ' is-current' : ''}" data-queue-index="${index}">
          <span class="kmusic-library__queue-index">${index + 1}</span>
          <img class="kmusic-library__queue-cover" src="${escapeHtml(assetUrl(coverPath(track)))}" alt="" loading="lazy">
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
    window.addEventListener('kmusic:queuechange', () => renderQueue(), { signal })
    window.addEventListener('kmusic:trackchange', () => renderQueue({ followCurrent: true }), { signal })
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
    bindPagination()

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
