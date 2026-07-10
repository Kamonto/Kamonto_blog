(() => {
  'use strict'

  if (window.KMusicPlayer && window.KMusicPlayer.ready) return

  const STORAGE_KEY = 'kmusic-player-state-v1'
  const MODES = ['list', 'one', 'shuffle']
  const MODE_META = {
    list: { label: '列表循环', icon: 'fa-long-arrow-alt-right' },
    one: { label: '单曲循环', icon: 'fa-redo' },
    shuffle: { label: '随机播放', icon: 'fa-random' }
  }
  const root = normalizeRoot(window.GLOBAL_CONFIG && window.GLOBAL_CONFIG.root)
  const audio = new Audio()
  audio.preload = 'metadata'

  const state = {
    library: [],
    trackMap: new Map(),
    queue: [],
    currentIndex: 0,
    mode: 'list',
    volume: 0.75,
    muted: false,
    collapsed: false,
    queueOpen: false,
    savedPosition: 0,
    positionRestored: false,
    isSeeking: false,
    pendingSeekTime: null,
    pendingSeekApplied: false,
    seekSettleTimer: 0,
    lastPersistAt: 0,
    initialized: false,
    error: ''
  }

  const el = {}

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

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;')
  }

  function formatTime(seconds) {
    const value = Math.max(0, Number(seconds) || 0)
    const minutes = Math.floor(value / 60)
    const secs = Math.floor(value % 60)
    return `${minutes}:${String(secs).padStart(2, '0')}`
  }

  function uniqueValidIds(ids) {
    const seen = new Set()
    return (Array.isArray(ids) ? ids : [])
      .filter(id => state.trackMap.has(id) && !seen.has(id) && seen.add(id))
  }

  function currentTrack() {
    return state.queue.length ? state.trackMap.get(state.queue[state.currentIndex]) || null : null
  }

  function emit(name, detail = {}) {
    window.dispatchEvent(new CustomEvent(`kmusic:${name}`, {
      detail: { ...detail, state: publicState() }
    }))
  }

  function publicState() {
    return {
      queue: [...state.queue],
      currentIndex: state.currentIndex,
      currentTrackId: state.queue[state.currentIndex] || null,
      mode: state.mode,
      volume: state.volume,
      muted: state.muted,
      collapsed: state.collapsed,
      playing: !audio.paused && !audio.ended,
      currentTime: getEffectiveCurrentTime(),
      duration: Number(audio.duration) || Number(currentTrack()?.duration) || 0
    }
  }

  function readSavedState() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
      return saved && typeof saved === 'object' ? saved : {}
    } catch (error) {
      console.warn('[KMusic] 无法读取本地播放器状态。', error)
      return {}
    }
  }

  function persist(force = false) {
    const now = Date.now()
    if (!force && now - state.lastPersistAt < 2500) return
    state.lastPersistAt = now
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        queue: state.queue,
        currentIndex: state.currentIndex,
        currentTrackId: state.queue[state.currentIndex] || null,
        mode: state.mode,
        volume: state.volume,
        muted: state.muted,
        collapsed: state.collapsed,
        currentTime: getEffectiveCurrentTime()
      }))
    } catch (error) {
      console.warn('[KMusic] 无法保存播放器状态。', error)
    }
  }

  function createPlayerDom() {
    const wrapper = document.createElement('div')
    wrapper.id = 'kmusic-player'
    wrapper.className = 'kmusic-player'
    wrapper.innerHTML = `
      <section class="kmusic-player__queue-panel" aria-label="当前播放队列">
        <header class="kmusic-player__queue-head">
          <h2 class="kmusic-player__queue-title">播放队列 <span class="kmusic-player__queue-count">0 首</span></h2>
          <div class="kmusic-player__queue-actions">
            <button type="button" class="kmusic-player__text-button" data-kmusic-action="clear">清空</button>
            <button type="button" class="kmusic-player__queue-tool" data-kmusic-action="close-queue" title="关闭队列" aria-label="关闭队列"><i class="fas fa-times"></i></button>
          </div>
        </header>
        <ol class="kmusic-player__queue-list"></ol>
        <div class="kmusic-player__error" hidden></div>
      </section>

      <button type="button" class="kmusic-player__toggle" data-kmusic-action="collapse" aria-expanded="true" title="收起播放器">
        <i class="fas fa-chevron-down"></i><span class="kmusic-player__toggle-label">收起播放器</span>
      </button>

      <div class="kmusic-player__bar">
        <div class="kmusic-player__track">
          <div class="kmusic-player__cover-wrap">
            <img class="kmusic-player__cover" alt="当前歌曲封面">
          </div>
          <div class="kmusic-player__track-copy">
            <div class="kmusic-player__title">暂无歌曲</div>
            <div class="kmusic-player__artist">请前往音乐馆选择歌曲</div>
          </div>
        </div>

        <div class="kmusic-player__center">
          <div class="kmusic-player__controls">
            <button type="button" class="kmusic-player__button kmusic-player__button--mode" data-kmusic-action="mode" title="列表循环" aria-label="切换播放模式"><i class="fas fa-long-arrow-alt-right"></i></button>
            <button type="button" class="kmusic-player__button" data-kmusic-action="previous" title="上一首" aria-label="上一首"><i class="fas fa-step-backward"></i></button>
            <button type="button" class="kmusic-player__button kmusic-player__button--play" data-kmusic-action="play" title="播放" aria-label="播放"><i class="fas fa-play"></i></button>
            <button type="button" class="kmusic-player__button" data-kmusic-action="next" title="下一首" aria-label="下一首"><i class="fas fa-step-forward"></i></button>
            <button type="button" class="kmusic-player__button kmusic-player__button--queue" data-kmusic-action="queue" title="播放队列" aria-label="播放队列"><i class="fas fa-list-ul"></i></button>
          </div>
          <div class="kmusic-player__progress-row">
            <span class="kmusic-player__time kmusic-player__time--current">0:00</span>
            <input class="kmusic-player__range kmusic-player__progress" type="range" min="0" max="1000" value="0" step="1" aria-label="播放进度">
            <span class="kmusic-player__time kmusic-player__time--duration">0:00</span>
          </div>
        </div>

        <div class="kmusic-player__right">
          <span class="kmusic-player__status">音乐库已就绪</span>
          <button type="button" class="kmusic-player__button kmusic-player__button--mute" data-kmusic-action="mute" title="静音" aria-label="静音"><i class="fas fa-volume-up"></i></button>
          <input class="kmusic-player__range kmusic-player__volume" type="range" min="0" max="1" value="0.75" step="0.01" aria-label="音量">
          <a class="kmusic-player__library-link" href="/Kamonto_blog/music" title="打开音乐馆" aria-label="打开音乐馆"><i class="fas fa-compact-disc"></i></a>
        </div>
      </div>`

    document.body.appendChild(wrapper)
    el.wrapper = wrapper
    el.bar = wrapper.querySelector('.kmusic-player__bar')
    el.toggle = wrapper.querySelector('.kmusic-player__toggle')
    el.toggleIcon = el.toggle.querySelector('i')
    el.toggleLabel = wrapper.querySelector('.kmusic-player__toggle-label')
    el.cover = wrapper.querySelector('.kmusic-player__cover')
    el.title = wrapper.querySelector('.kmusic-player__title')
    el.artist = wrapper.querySelector('.kmusic-player__artist')
    el.playButton = wrapper.querySelector('[data-kmusic-action="play"]')
    el.playIcon = el.playButton.querySelector('i')
    el.modeButton = wrapper.querySelector('[data-kmusic-action="mode"]')
    el.modeIcon = el.modeButton.querySelector('i')
    el.queueButton = wrapper.querySelector('[data-kmusic-action="queue"]')
    el.progress = wrapper.querySelector('.kmusic-player__progress')
    el.currentTime = wrapper.querySelector('.kmusic-player__time--current')
    el.duration = wrapper.querySelector('.kmusic-player__time--duration')
    el.volume = wrapper.querySelector('.kmusic-player__volume')
    el.muteButton = wrapper.querySelector('[data-kmusic-action="mute"]')
    el.muteIcon = el.muteButton.querySelector('i')
    el.status = wrapper.querySelector('.kmusic-player__status')
    el.queueList = wrapper.querySelector('.kmusic-player__queue-list')
    el.queueCount = wrapper.querySelector('.kmusic-player__queue-count')
    el.libraryLink = wrapper.querySelector('.kmusic-player__library-link')
    el.error = wrapper.querySelector('.kmusic-player__error')
  }

  function bindDomEvents() {
    el.wrapper.addEventListener('click', event => {
      const actionButton = event.target.closest('[data-kmusic-action]')
      if (!actionButton) return

      switch (actionButton.dataset.kmusicAction) {
        case 'collapse': toggleCollapsed(); break
        case 'play': togglePlay(); break
        case 'previous': previous(); break
        case 'next': next(); break
        case 'mode': cycleMode(); break
        case 'queue': toggleQueuePanel(); break
        case 'close-queue': setQueuePanel(false); break
        case 'mute': toggleMute(); break
        case 'clear': clearQueue(); break
      }
    })

    el.queueList.addEventListener('click', event => {
      const item = event.target.closest('[data-queue-index]')
      if (!item) return
      const index = Number(item.dataset.queueIndex)
      const tool = event.target.closest('[data-queue-tool]')

      if (!tool) return playQueueIndex(index)
      switch (tool.dataset.queueTool) {
        case 'up': moveQueue(index, -1); break
        case 'down': moveQueue(index, 1); break
        case 'remove': removeFromQueue(index); break
      }
    })

    const beginSeek = () => {
      state.isSeeking = true
    }

    const previewSeek = () => {
      state.isSeeking = true
      const duration = getPlaybackDuration()
      const ratio = Math.min(1, Math.max(0, Number(el.progress.value) / 1000))
      state.pendingSeekTime = duration * ratio
      el.currentTime.textContent = formatTime(state.pendingSeekTime)
      el.duration.textContent = formatTime(duration)
    }

    const commitSeek = () => {
      if (!state.isSeeking) return
      const duration = getPlaybackDuration()
      const ratio = Math.min(1, Math.max(0, Number(el.progress.value) / 1000))
      const targetTime = duration * ratio
      state.isSeeking = false
      queuePendingSeek(targetTime)
      updateProgress(true)
      persist(true)
      emit('seek', { currentTime: targetTime })
    }

    el.progress.addEventListener('pointerdown', beginSeek)
    el.progress.addEventListener('mousedown', beginSeek)
    el.progress.addEventListener('touchstart', beginSeek, { passive: true })
    el.progress.addEventListener('input', previewSeek)
    el.progress.addEventListener('change', commitSeek)
    el.progress.addEventListener('pointerup', commitSeek)
    el.progress.addEventListener('touchend', commitSeek)
    el.progress.addEventListener('pointercancel', () => {
      state.isSeeking = false
      resetPendingSeek()
      updateProgress(true)
    })

    el.libraryLink.addEventListener('click', event => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      event.preventDefault()
      event.stopPropagation()

      const targetUrl = el.libraryLink.getAttribute('href') || '/Kamonto_blog/music'
      if (window.pjax && typeof window.pjax.loadUrl === 'function') {
        window.pjax.loadUrl(targetUrl)
      } else {
        window.location.assign(targetUrl)
      }
    })

    el.volume.addEventListener('input', () => {
      state.volume = Math.min(1, Math.max(0, Number(el.volume.value)))
      audio.volume = state.volume
      if (state.volume > 0 && state.muted) {
        state.muted = false
        audio.muted = false
      }
      updateVolumeUi()
      persist(true)
      emit('volumechange')
    })

    document.addEventListener('keydown', event => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target
      const isTyping = target && (target.matches('input, textarea, select') || target.isContentEditable)
      if (isTyping) return

      if (event.code === 'Space' && event.shiftKey) {
        event.preventDefault()
        togglePlay()
      }
    })
  }

  function bindAudioEvents() {
    audio.addEventListener('play', () => {
      updatePlayUi()
      setStatus('正在播放')
      emit('play')
    })

    audio.addEventListener('pause', () => {
      updatePlayUi()
      if (!audio.ended) setStatus('已暂停')
      persist(true)
      emit('pause')
    })

    audio.addEventListener('loadedmetadata', () => {
      if (state.pendingSeekTime === null && !state.positionRestored && state.savedPosition > 0) {
        queuePendingSeek(state.savedPosition, { applyImmediately: false })
      }
      applyPendingSeek(true)
      updateProgress(true)
    })

    audio.addEventListener('loadeddata', () => applyPendingSeek())
    audio.addEventListener('durationchange', () => {
      applyPendingSeek()
      updateProgress()
    })
    audio.addEventListener('seeking', () => updateProgress(true))
    audio.addEventListener('seeked', () => {
      settlePendingSeek()
      updateProgress(true)
      persist(true)
    })
    audio.addEventListener('timeupdate', () => {
      updateProgress()
      persist(false)
    })

    audio.addEventListener('ended', handleEnded)
    audio.addEventListener('waiting', () => setStatus('正在缓冲…'))
    audio.addEventListener('canplay', () => {
      applyPendingSeek()
      if (!audio.paused) setStatus('正在播放')
    })

    audio.addEventListener('error', () => {
      const track = currentTrack()
      state.error = track ? `无法加载《${track.title}》，请检查文件路径。` : '无法加载当前音频。'
      showError(state.error)
      setStatus('加载失败')
      updatePlayUi()
      emit('error', { message: state.error })
    })

    window.addEventListener('beforeunload', () => persist(true))
  }

  function hydrate(saved) {
    state.mode = MODES.includes(saved.mode) ? saved.mode : 'list'
    state.volume = Number.isFinite(Number(saved.volume)) ? Math.min(1, Math.max(0, Number(saved.volume))) : 0.75
    state.muted = Boolean(saved.muted)
    state.collapsed = Boolean(saved.collapsed)
    state.queue = uniqueValidIds(saved.queue)
    if (!state.queue.length) state.queue = state.library.map(track => track.id)

    const savedTrackIndex = saved.currentTrackId ? state.queue.indexOf(saved.currentTrackId) : -1
    const numericIndex = Number(saved.currentIndex)
    state.currentIndex = savedTrackIndex >= 0
      ? savedTrackIndex
      : Number.isInteger(numericIndex) && numericIndex >= 0 && numericIndex < state.queue.length
        ? numericIndex
        : 0

    state.savedPosition = Math.max(0, Number(saved.currentTime) || 0)
    audio.volume = state.volume
    audio.muted = state.muted
  }

  function loadCurrent(options = {}) {
    const { autoplay = false, preservePosition = false } = options
    const track = currentTrack()
    state.error = ''
    showError('')
    state.positionRestored = false
    state.isSeeking = false
    resetPendingSeek()
    if (!preservePosition) {
      state.savedPosition = 0
    } else if (state.savedPosition > 0) {
      queuePendingSeek(state.savedPosition, { applyImmediately: false })
    }

    if (!track) {
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
      updateTrackUi()
      updateProgress()
      persist(true)
      return
    }

    const targetSrc = assetUrl(track.file)
    if (audio.src !== new URL(targetSrc, window.location.href).href) {
      audio.src = targetSrc
      audio.load()
    }
    updateTrackUi()
    updateQueueUi()
    persist(true)
    emit('trackchange', { track })

    if (autoplay) safePlay()
  }

  async function safePlay() {
    if (!currentTrack()) {
      setStatus('播放队列为空')
      return false
    }
    try {
      await audio.play()
      return true
    } catch (error) {
      setStatus('请点击播放按钮')
      console.info('[KMusic] 浏览器阻止了自动播放。', error)
      return false
    }
  }

  function togglePlay() {
    if (!currentTrack()) return setStatus('播放队列为空')
    audio.paused ? safePlay() : audio.pause()
  }

  function playQueueIndex(index) {
    const nextIndex = Number(index)
    if (!Number.isInteger(nextIndex) || nextIndex < 0 || nextIndex >= state.queue.length) return false
    state.currentIndex = nextIndex
    loadCurrent({ autoplay: true })
    return true
  }

  function playTrack(id, options = {}) {
    if (!state.trackMap.has(id)) return false
    if (options.replaceQueue) {
      state.queue = [id]
      state.currentIndex = 0
    } else {
      let index = state.queue.indexOf(id)
      if (index < 0) {
        state.queue.push(id)
        index = state.queue.length - 1
      }
      state.currentIndex = index
    }
    updateQueueUi()
    emit('queuechange')
    loadCurrent({ autoplay: options.autoplay !== false })
    return true
  }

  function previous() {
    if (!state.queue.length) return
    if (audio.currentTime > 4) {
      audio.currentTime = 0
      return safePlay()
    }
    state.currentIndex = state.currentIndex > 0 ? state.currentIndex - 1 : state.queue.length - 1
    loadCurrent({ autoplay: true })
  }

  function next() {
    if (!state.queue.length) return
    if (state.mode === 'shuffle' && state.queue.length > 1) {
      state.currentIndex = randomIndexExcept(state.currentIndex)
    } else {
      state.currentIndex = (state.currentIndex + 1) % state.queue.length
    }
    loadCurrent({ autoplay: true })
  }

  function handleEnded() {
    if (!state.queue.length) return
    if (state.mode === 'one') {
      audio.currentTime = 0
      return safePlay()
    }
    if (state.mode === 'shuffle') {
      state.currentIndex = state.queue.length > 1 ? randomIndexExcept(state.currentIndex) : 0
      return loadCurrent({ autoplay: true })
    }
    state.currentIndex = (state.currentIndex + 1) % state.queue.length
    loadCurrent({ autoplay: true })
  }

  function randomIndexExcept(excluded) {
    if (state.queue.length <= 1) return 0
    let index = excluded
    while (index === excluded) index = Math.floor(Math.random() * state.queue.length)
    return index
  }

  function setQueue(ids, options = {}) {
    const queue = uniqueValidIds(ids)
    state.queue = queue
    const requestedIndex = Number(options.playIndex)
    state.currentIndex = queue.length
      ? Number.isInteger(requestedIndex) && requestedIndex >= 0 && requestedIndex < queue.length ? requestedIndex : 0
      : 0
    updateQueueUi()
    emit('queuechange')
    loadCurrent({ autoplay: Boolean(options.autoplay) })
    return [...state.queue]
  }

  function addToQueue(ids) {
    const incoming = uniqueValidIds(ids)
    const existing = new Set(state.queue)
    const additions = incoming.filter(id => !existing.has(id))
    if (!additions.length) return 0
    const wasEmpty = state.queue.length === 0
    state.queue.push(...additions)
    if (wasEmpty) {
      state.currentIndex = 0
      loadCurrent({ autoplay: false })
    } else {
      updateQueueUi()
      persist(true)
    }
    emit('queuechange')
    return additions.length
  }

  function removeFromQueue(index) {
    const target = Number(index)
    if (!Number.isInteger(target) || target < 0 || target >= state.queue.length) return false
    const removingCurrent = target === state.currentIndex
    state.queue.splice(target, 1)

    if (!state.queue.length) {
      state.currentIndex = 0
      loadCurrent({ autoplay: false })
    } else if (target < state.currentIndex) {
      state.currentIndex -= 1
      updateQueueUi()
      persist(true)
    } else if (removingCurrent) {
      if (state.currentIndex >= state.queue.length) state.currentIndex = state.queue.length - 1
      loadCurrent({ autoplay: !audio.paused })
    } else {
      updateQueueUi()
      persist(true)
    }

    emit('queuechange')
    return true
  }

  function moveQueue(index, delta) {
    const from = Number(index)
    const to = from + Number(delta)
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from >= state.queue.length || to < 0 || to >= state.queue.length) return false
    const [id] = state.queue.splice(from, 1)
    state.queue.splice(to, 0, id)

    if (state.currentIndex === from) state.currentIndex = to
    else if (from < state.currentIndex && to >= state.currentIndex) state.currentIndex -= 1
    else if (from > state.currentIndex && to <= state.currentIndex) state.currentIndex += 1

    updateQueueUi()
    persist(true)
    emit('queuechange')
    return true
  }

  function clearQueue() {
    state.queue = []
    state.currentIndex = 0
    state.queueOpen = false
    loadCurrent({ autoplay: false })
    updateCollapsedUi()
    updateQueueUi()
    emit('queuechange')
  }

  function cycleMode() {
    const index = MODES.indexOf(state.mode)
    state.mode = MODES[(index + 1) % MODES.length]
    updateModeUi()
    persist(true)
    emit('modechange')
  }

  function toggleMute() {
    state.muted = !state.muted
    audio.muted = state.muted
    updateVolumeUi()
    persist(true)
    emit('volumechange')
  }

  function toggleCollapsed() {
    state.collapsed = !state.collapsed
    if (state.collapsed) state.queueOpen = false
    updateCollapsedUi()
    persist(true)
    emit('collapsechange')
  }

  function toggleQueuePanel() {
    setQueuePanel(!state.queueOpen)
  }

  function setQueuePanel(open) {
    state.queueOpen = Boolean(open)
    if (state.queueOpen && state.collapsed) state.collapsed = false
    updateCollapsedUi()
    updateQueueUi()
  }

  function updateTrackUi() {
    const track = currentTrack()
    if (!track) {
      el.cover.removeAttribute('src')
      el.cover.alt = ''
      el.title.textContent = '暂无歌曲'
      el.artist.textContent = '请前往音乐馆选择歌曲'
      setStatus('播放队列为空')
      return
    }

    el.cover.src = assetUrl(track.cover)
    el.cover.alt = `${track.title} 封面`
    el.title.textContent = track.title
    el.title.title = track.title
    el.artist.textContent = text(track.singers || track.artists) || '未知歌手'
    el.artist.title = el.artist.textContent
    document.title = document.title.replace(/^▶\s*/, '')
  }

  function updatePlayUi() {
    const playing = !audio.paused && !audio.ended
    el.wrapper.classList.toggle('kmusic-player--playing', playing)
    el.playIcon.className = playing ? 'fas fa-pause' : 'fas fa-play'
    el.playButton.title = playing ? '暂停' : '播放'
    el.playButton.setAttribute('aria-label', playing ? '暂停' : '播放')
  }

  function getPlaybackDuration() {
    const mediaDuration = Number(audio.duration)
    if (Number.isFinite(mediaDuration) && mediaDuration > 0) return mediaDuration
    return Math.max(0, Number(currentTrack()?.duration) || 0)
  }

  function getEffectiveCurrentTime() {
    if (state.pendingSeekTime !== null) return Math.max(0, Number(state.pendingSeekTime) || 0)
    return Math.max(0, Number(audio.currentTime) || 0)
  }

  function resetPendingSeek() {
    if (state.seekSettleTimer) window.clearTimeout(state.seekSettleTimer)
    state.seekSettleTimer = 0
    state.pendingSeekTime = null
    state.pendingSeekApplied = false
  }

  function queuePendingSeek(targetTime, options = {}) {
    const duration = getPlaybackDuration()
    const rawTarget = Math.max(0, Number(targetTime) || 0)
    const target = duration > 0 ? Math.min(rawTarget, duration) : rawTarget

    if (state.seekSettleTimer) window.clearTimeout(state.seekSettleTimer)
    state.seekSettleTimer = 0
    state.pendingSeekTime = target
    state.pendingSeekApplied = false
    state.savedPosition = target
    state.positionRestored = false

    if (options.applyImmediately !== false) applyPendingSeek()
  }

  function applyPendingSeek() {
    if (state.pendingSeekTime === null || state.pendingSeekApplied) return false

    const mediaDuration = Number(audio.duration)
    if (!Number.isFinite(mediaDuration) || mediaDuration <= 0 || audio.readyState < 1) return false

    const target = Math.min(Math.max(0, Number(state.pendingSeekTime) || 0), mediaDuration)
    state.pendingSeekTime = target

    try {
      // 每次拖动只提交一次 currentTime。重复赋值会不断触发 seeking/waiting，
      // 导致播放器在“正在缓冲”和“正在播放”之间循环。
      state.pendingSeekApplied = true
      audio.currentTime = target

      // 极少数浏览器不会派发 seeked；超时只做状态收敛，不再次跳转。
      state.seekSettleTimer = window.setTimeout(() => {
        if (state.pendingSeekTime === null) return
        settlePendingSeek()
        updateProgress(true)
        persist(true)
      }, 2000)
      return true
    } catch (_) {
      state.pendingSeekApplied = false
      return false
    }
  }

  function settlePendingSeek() {
    if (state.pendingSeekTime === null) return true

    const actual = Math.max(0, Number(audio.currentTime) || 0)
    state.savedPosition = actual
    state.positionRestored = true
    resetPendingSeek()
    return true
  }

  function updateProgress(force = false) {
    if (state.isSeeking && !force) return
    const duration = getPlaybackDuration()
    const current = Math.min(getEffectiveCurrentTime(), duration || Infinity)
    el.currentTime.textContent = formatTime(current)
    el.duration.textContent = formatTime(duration)
    el.progress.value = duration > 0 ? String(Math.round((current / duration) * 1000)) : '0'
  }

  function updateModeUi() {
    const meta = MODE_META[state.mode]
    // 直接同步原生 Audio.loop，第一次切换到单曲循环后立即生效。
    audio.loop = state.mode === 'one'
    el.modeIcon.className = `fas ${meta.icon}`
    el.modeButton.dataset.mode = state.mode
    el.modeButton.title = `${meta.label}（点击切换）`
    el.modeButton.setAttribute('aria-label', `当前为${meta.label}，点击切换`)
    // 三种模式在非悬浮状态下统一使用黑色图标，不再保留激活态颜色。
    el.modeButton.classList.remove('is-active')
  }

  function updateVolumeUi() {
    el.volume.value = String(state.volume)
    const silent = state.muted || state.volume === 0
    el.muteIcon.className = silent
      ? 'fas fa-volume-mute'
      : state.volume < 0.5
        ? 'fas fa-volume-down'
        : 'fas fa-volume-up'
    el.muteButton.title = silent ? '取消静音' : '静音'
    el.muteButton.setAttribute('aria-label', silent ? '取消静音' : '静音')
  }

  function updateCollapsedUi() {
    el.wrapper.classList.toggle('kmusic-player--collapsed', state.collapsed)
    el.wrapper.classList.toggle('kmusic-player--queue-open', state.queueOpen)
    document.documentElement.classList.toggle('kmusic-player-expanded', !state.collapsed)
    el.toggleIcon.className = state.collapsed ? 'fas fa-music' : 'fas fa-chevron-down'
    el.toggleLabel.textContent = state.collapsed ? '展开播放器' : '收起播放器'
    el.toggle.title = state.collapsed ? '展开播放器' : '收起播放器'
    el.toggle.setAttribute('aria-expanded', String(!state.collapsed))
    el.queueButton.classList.toggle('is-active', state.queueOpen)
  }

  function updateQueueUi() {
    el.queueCount.textContent = `${state.queue.length} 首`
    if (!state.queue.length) {
      el.queueList.innerHTML = '<li class="kmusic-player__queue-empty">队列为空，前往音乐馆添加歌曲。</li>'
      return
    }

    el.queueList.innerHTML = state.queue.map((id, index) => {
      const track = state.trackMap.get(id)
      if (!track) return ''
      return `
        <li class="kmusic-player__queue-item${index === state.currentIndex ? ' is-current' : ''}" data-queue-index="${index}">
          <span class="kmusic-player__queue-index">${index + 1}</span>
          <button type="button" class="kmusic-player__queue-main" title="播放 ${escapeHtml(track.title)}">
            <span class="kmusic-player__queue-name">${escapeHtml(track.title)}</span>
            <span class="kmusic-player__queue-artist">${escapeHtml(text(track.singers || track.artists) || '未知歌手')}</span>
          </button>
          <span class="kmusic-player__queue-tools">
            <button type="button" class="kmusic-player__queue-tool" data-queue-tool="up" title="上移" ${index === 0 ? 'disabled' : ''}><i class="fas fa-arrow-up"></i></button>
            <button type="button" class="kmusic-player__queue-tool" data-queue-tool="down" title="下移" ${index === state.queue.length - 1 ? 'disabled' : ''}><i class="fas fa-arrow-down"></i></button>
            <button type="button" class="kmusic-player__queue-tool" data-queue-tool="remove" title="移除"><i class="fas fa-times"></i></button>
          </span>
        </li>`
    }).join('')
  }

  function setStatus(message) {
    if (el.status) el.status.textContent = message
  }

  function showError(message) {
    if (!el.error) return
    el.error.hidden = !message
    el.error.textContent = message || ''
  }

  function exposeApi() {
    window.KMusicPlayer = Object.freeze({
      ready: true,
      getLibrary: () => state.library.map(track => ({ ...track })),
      getTrack: id => state.trackMap.has(id) ? { ...state.trackMap.get(id) } : null,
      getQueue: () => [...state.queue],
      getState: publicState,
      setQueue,
      addToQueue,
      removeFromQueue,
      moveQueue,
      clearQueue,
      playTrack,
      playQueueIndex,
      play: safePlay,
      pause: () => audio.pause(),
      next,
      previous,
      toggleQueuePanel,
      setMode: mode => {
        if (!MODES.includes(mode)) return false
        state.mode = mode
        updateModeUi()
        persist(true)
        emit('modechange')
        return true
      }
    })
  }

  async function init() {
    try {
      const response = await fetch(`/Kamonto_blog/audio/music-library.json`, { cache: 'no-cache' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = await response.json()
      if (!data || !Array.isArray(data.tracks)) throw new Error('music-library.json 中缺少 tracks 数组。')

      const seen = new Set()
      state.library = data.tracks.filter(track => {
        if (!track || !track.id || !track.title || !track.file || seen.has(track.id)) return false
        seen.add(track.id)
        return true
      })
      state.trackMap = new Map(state.library.map(track => [track.id, track]))

      createPlayerDom()
      bindDomEvents()
      bindAudioEvents()
      hydrate(readSavedState())
      updateModeUi()
      updateVolumeUi()
      updateCollapsedUi()
      updateQueueUi()
      loadCurrent({ autoplay: false, preservePosition: true })
      exposeApi()
      state.initialized = true
      emit('ready', { librarySize: state.library.length })
    } catch (error) {
      console.error('[KMusic] 播放器初始化失败：', error)
      createPlayerDom()
      state.collapsed = false
      updateCollapsedUi()
      setStatus('音乐库加载失败')
      showError(`播放器初始化失败：${error.message}`)
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true })
  } else {
    init()
  }
})()
