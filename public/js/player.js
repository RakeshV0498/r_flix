/**
 * Video player.
 *
 *  - Asks the backend how to play the title (direct play, or HLS when the server
 *    has to remux/transcode) and which server it will come from.
 *  - Resumes where you left off; reports progress every 15 s and on exit so
 *    Continue Watching works (and stays in sync across both servers).
 *  - If playback fails it retries once as a transcode, then fails over to the
 *    other server's copy, resuming at the same position.
 *  - Fully usable with a TV remote / keyboard (see onKey) and with touch/mouse.
 */
import { h, fmtTime, store } from './util.js';
import { get } from './api.js';

const REPORT_EVERY_MS = 15000;
const HIDE_CONTROLS_MS = 3500;
const NEXT_COUNTDOWN_S = 8;
const SEEK_S = 10;

export async function mount(root, { id, goBack }) {
  document.body.classList.add('in-player');
  const S = {
    info: null, hls: null, exclude: new Set(), forceTranscode: false, failovers: 0,
    started: false, stopped: false, reportTimer: null, hideTimer: null, nextTimer: null,
    dragging: false, wakeLock: null, destroyed: false,
  };

  // ---------------------------------------------------------------- DOM
  const video = h('video', { playsinline: true, preload: 'auto' });
  video.volume = store.get('rflix.volume', 1);
  video.muted = store.get('rflix.muted', false);

  const title = h('div', { class: 'p-title' });
  const sub = h('div', { class: 'p-sub' });
  const seek = h('input', { type: 'range', min: '0', max: '1000', value: '0', tabindex: '-1', 'aria-label': 'Seek' });
  const time = h('span', { class: 'p-time' }, '0:00');
  const btn = (label, text, onclick, extra = {}) => h('button', { class: 'p-btn', 'aria-label': label, title: label, onclick, ...extra }, text);
  const bPlay = btn('Play / pause', '▶', () => toggle());
  const bBack = btn('Back 10 seconds', '⟲ 10', () => skip(-SEEK_S));
  const bFwd = btn('Forward 10 seconds', '10 ⟳', () => skip(SEEK_S));
  const bNext = btn('Next episode', '⏭', () => playNext(), { hidden: true });
  const bMute = btn('Mute', '🔊', () => { video.muted = !video.muted; });
  const bCC = btn('Subtitles', 'CC', () => cycleSubs(), { hidden: true });
  const bFull = btn('Fullscreen', '⛶', () => toggleFullscreen());
  const bExit = btn('Back', '←', () => exit());
  const controls = [bExit, bPlay, bBack, bFwd, bNext, bMute, bCC, bFull];

  const center = h('div', { class: 'p-center' });
  const spinner = h('div', { class: 'spinner' });
  const wrap = h(
    'div',
    { class: 'player show-controls buffering' },
    video,
    h('div', { class: 'p-top' }, bExit, h('div', null, title, sub)),
    center,
    h('div', { class: 'p-bottom' },
      h('div', { class: 'p-seek' }, seek, time),
      h('div', { class: 'p-btns' }, bPlay, bBack, bFwd, bNext, h('span', { class: 'p-spacer' }), bMute, bCC, bFull)),
  );
  center.append(spinner);
  root.replaceChildren(wrap);

  // ---------------------------------------------------------------- helpers
  const toast = (text, action) => {
    wrap.querySelector('.p-toast')?.remove();
    const el = h('div', { class: 'p-toast' }, text, action ? h('button', { class: 'btn', onclick: () => { action.fn(); el.remove(); } }, action.label) : null);
    wrap.append(el);
    setTimeout(() => el.remove(), action ? 9000 : 1600);
  };
  const duration = () => (Number.isFinite(video.duration) && video.duration > 0 ? video.duration : S.info?.durationSeconds || 0);

  function showControls() {
    wrap.classList.add('show-controls');
    clearTimeout(S.hideTimer);
    S.hideTimer = setTimeout(() => {
      // Keep them up while paused or while a control has focus on a remote.
      const a = document.activeElement;
      const onControl = wrap.contains(a) && a.tagName === 'BUTTON';
      if (!video.paused && !onControl) wrap.classList.remove('show-controls');
    }, HIDE_CONTROLS_MS);
  }

  function toggle() {
    if (video.paused) video.play().catch(() => {});
    else video.pause();
    showControls();
  }

  function skip(delta) {
    const d = duration();
    video.currentTime = Math.max(0, Math.min(d || Infinity, video.currentTime + delta));
    toast(`${delta > 0 ? '+' : '−'}${Math.abs(delta)}s`);
    showControls();
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else wrap.requestFullscreen?.().catch(() => {});
  }

  function cycleSubs() {
    const tracks = [...video.textTracks];
    if (!tracks.length) return;
    const on = tracks.findIndex((t) => t.mode === 'showing');
    tracks.forEach((t) => { t.mode = 'disabled'; });
    const next = on + 1;
    if (next < tracks.length) {
      tracks[next].mode = 'showing';
      toast(`Subtitles: ${tracks[next].label}`);
    } else toast('Subtitles off');
  }

  function exit() {
    goBack();
  }

  // ---------------------------------------------------------------- loading / failover
  function setCenterMessage(text, actions = []) {
    center.replaceChildren(spinner);
    if (text) center.append(h('p', { class: 'p-msg' }, text));
    if (actions.length) center.append(h('div', { class: 'actions' }, actions));
  }

  function showError(message) {
    wrap.classList.remove('buffering');
    wrap.classList.add('show-controls');
    setCenterMessage(message, [
      h('button', { class: 'btn primary', 'data-autofocus': '', onclick: () => { S.exclude.clear(); S.failovers = 0; S.forceTranscode = false; start(video.currentTime || 0); } }, 'Try again'),
      h('button', { class: 'btn', onclick: exit }, 'Back'),
    ]);
    center.querySelector('button')?.focus();
  }

  /** Fetch a playback plan and attach it. `at` = resume position in seconds (undefined: use saved position). */
  async function start(at) {
    if (S.destroyed) return;
    teardownMedia();
    wrap.classList.add('buffering');
    setCenterMessage('');
    const q = new URLSearchParams();
    if (S.exclude.size) q.set('exclude', [...S.exclude].join(','));
    if (at != null) q.set('start', String(Math.floor(at)));
    if (S.forceTranscode) q.set('transcode', '1');
    let info;
    try {
      info = await get(`/api/play/${id}?${q}`);
    } catch (err) {
      if (!S.destroyed) showError(err.status === 503 ? 'No reachable server has this title right now.' : err.message);
      return;
    }
    if (S.destroyed) return;
    S.info = info;
    S.started = false;
    S.stopped = false;
    title.textContent = info.title;
    sub.textContent = info.subtitle || '';
    bNext.hidden = !info.next;
    bCC.hidden = !info.subtitles.length;
    attach(info, info.startSeconds);
    if (info.startSeconds > 0 && at == null) {
      toast(`Resuming from ${fmtTime(info.startSeconds)}`, { label: 'Start over', fn: () => { video.currentTime = 0; } });
    }
    setupMediaSession(info);
  }

  function attach(info, startAt) {
    for (const s of info.subtitles) {
      video.append(h('track', { kind: 'subtitles', label: s.label, srclang: s.lang || 'und', src: s.url }));
    }
    for (const t of video.textTracks) t.mode = 'disabled';

    const seekOnReady = () => video.addEventListener('loadedmetadata', () => { if (startAt > 0) video.currentTime = startAt; }, { once: true });
    if (info.mode === 'hls') {
      if (window.Hls?.isSupported()) {
        const hls = new Hls({
          startPosition: startAt > 0 ? startAt : -1,
          maxBufferLength: 30, maxMaxBufferLength: 60, maxBufferSize: 30 * 1000 * 1000, backBufferLength: 20, // modest: TVs/phones have little RAM
          enableWorker: true,
        });
        S.hls = hls;
        let mediaRecoveries = 0;
        hls.on(Hls.Events.ERROR, (_, data) => {
          if (!data.fatal) return;
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries++ < 2) hls.recoverMediaError();
          else onFailure(`hls ${data.type}`);
        });
        hls.loadSource(info.url);
        hls.attachMedia(video);
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = info.url; // Safari / iOS play HLS natively
        seekOnReady();
      } else {
        showError('This browser cannot play HLS video.');
        return;
      }
    } else {
      video.src = info.url;
      seekOnReady();
    }
    video.play().catch(() => { /* autoplay blocked: user presses play */ });
  }

  function teardownMedia() {
    S.hls?.destroy();
    S.hls = null;
    video.querySelectorAll('track').forEach((t) => t.remove());
    video.pause();
    video.removeAttribute('src');
    video.load(); // closes the proxied connection so the Pi and Jellyfin stop sending
  }

  /** Something broke: retry as a transcode, then try the other server. */
  async function onFailure(why) {
    if (S.destroyed || S.recovering) return;
    S.recovering = true;
    const pos = video.currentTime || S.info?.startSeconds || 0;
    try {
      // Is the server itself down? Then skip the "transcode instead" step and go straight to the other copy.
      const serverDown = await get('/api/status')
        .then((s) => s.servers[S.info?.serverIndex]?.online === false)
        .catch(() => false);
      if (S.info?.playMethod === 'DirectPlay' && !S.forceTranscode && !serverDown) {
        S.forceTranscode = true; // maybe the browser can't decode the original file
        toast('Switching to a compatible stream…');
      } else if (S.failovers < 2 && S.info) {
        S.failovers++;
        S.forceTranscode = false;
        S.exclude.add(S.info.serverIndex);
        toast(`Trying another server… (${why})`);
      } else {
        showError('Playback failed. The server may be offline or the file may be unsupported.');
        return;
      }
      await start(pos);
    } finally {
      S.recovering = false;
    }
  }

  // ---------------------------------------------------------------- progress reporting
  function report(event, { beacon = false } = {}) {
    const info = S.info;
    if (!info || (event !== 'start' && !S.started)) return;
    const body = JSON.stringify({
      uid: id, event,
      positionSeconds: Math.max(0, video.currentTime || 0),
      durationSeconds: duration(),
      playSessionId: info.playSessionId, serverIndex: info.serverIndex, mediaSourceId: info.mediaSourceId,
      playMethod: info.playMethod, paused: video.paused,
    });
    if (beacon && navigator.sendBeacon) navigator.sendBeacon('/api/progress', new Blob([body], { type: 'application/json' }));
    else fetch('/api/progress', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
  }

  function sendStop(opts) {
    if (!S.started || S.stopped) return;
    S.stopped = true;
    report('stop', opts);
  }

  // ---------------------------------------------------------------- next episode
  function playNext() {
    if (!S.info?.next) return;
    sendStop();
    // replace, so Back from the next episode returns to the title page, not the previous episode
    location.replace(`#/watch/${S.info.next.id}`);
  }

  function showNextCard() {
    const next = S.info.next;
    let left = NEXT_COUNTDOWN_S;
    const label = h('span', null, `Next episode in ${left}s`);
    const card = h('div', { class: 'p-next' },
      h('div', null, label),
      h('div', { class: 'p-sub' }, next.title),
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary', 'data-autofocus': '', onclick: playNext }, '▶ Play now'),
        h('button', { class: 'btn', onclick: () => { clearInterval(S.nextTimer); card.remove(); exit(); } }, 'Close')));
    wrap.append(card);
    wrap.classList.add('show-controls');
    card.querySelector('button').focus();
    S.nextTimer = setInterval(() => {
      left--;
      label.textContent = `Next episode in ${left}s`;
      if (left <= 0) { clearInterval(S.nextTimer); playNext(); }
    }, 1000);
  }

  // ---------------------------------------------------------------- media events
  const on = (target, ev, fn, opts) => { target.addEventListener(ev, fn, opts); disposers.push(() => target.removeEventListener(ev, fn, opts)); };
  const disposers = [];

  on(video, 'playing', () => {
    wrap.classList.remove('buffering');
    if (!S.started) {
      S.started = true;
      report('start');
      clearInterval(S.reportTimer);
      S.reportTimer = setInterval(() => !video.paused && report('progress'), REPORT_EVERY_MS);
    }
    requestWakeLock();
  });
  on(video, 'waiting', () => wrap.classList.add('buffering'));
  on(video, 'canplay', () => wrap.classList.remove('buffering'));
  on(video, 'pause', () => { bPlay.textContent = '▶'; showControls(); report('progress'); });
  on(video, 'play', () => { bPlay.textContent = '⏸'; showControls(); });
  on(video, 'seeked', () => report('progress'));
  on(video, 'volumechange', () => {
    bMute.textContent = video.muted || video.volume === 0 ? '🔇' : '🔊';
    store.set('rflix.volume', video.volume);
    store.set('rflix.muted', video.muted);
  });
  on(video, 'timeupdate', () => {
    const d = duration();
    time.textContent = `${fmtTime(video.currentTime)} / ${fmtTime(d)}`;
    if (!S.dragging && d) seek.value = String(Math.round((video.currentTime / d) * 1000));
  });
  on(video, 'ended', () => {
    sendStop();
    if (S.info?.next) showNextCard();
    else exit();
  });
  on(video, 'error', () => onFailure(`media error ${video.error?.code ?? ''}`));
  on(seek, 'pointerdown', () => { S.dragging = true; });
  on(seek, 'input', () => { const d = duration(); if (d) video.currentTime = (Number(seek.value) / 1000) * d; });
  on(seek, 'change', () => { S.dragging = false; });
  on(video, 'click', toggle);
  on(video, 'dblclick', toggleFullscreen);
  on(wrap, 'pointermove', showControls);
  on(wrap, 'pointerdown', showControls);
  on(window, 'pagehide', () => sendStop({ beacon: true }));
  on(document, 'visibilitychange', () => { if (document.visibilityState === 'hidden') report('progress', { beacon: true }); });

  // ---------------------------------------------------------------- keyboard / remote
  /**
   * Two modes. "Playback" (nothing focused): ←/→ seek, Enter/Space pause, ↑/↓ open the controls.
   * "Controls" (a button focused): ←/→ move between buttons, Enter presses, ↓ or Esc leaves them.
   * Also: j/l ±10 s, m mute, f fullscreen, c subtitles, n next, and TV media keys.
   */
  function onKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const a = document.activeElement;
    const inControls = wrap.contains(a) && a.tagName === 'BUTTON';
    const key = e.key;
    const code = e.keyCode;
    let handled = true;

    if (key === 'Escape' || key === 'BrowserBack' || key === 'GoBack' || key === 'XF86Back' || code === 10009 || code === 461 || key === 'Backspace') {
      if (inControls && key === 'Escape') a.blur();
      else exit();
    } else if ((key === 'Enter' || key === ' ') && inControls) {
      handled = false; // the focused button handles it natively
    } else if (key === ' ' || key === 'Enter' || key === 'k' || key === 'MediaPlayPause' || code === 415 || code === 19) {
      if (code === 415 && !video.paused) { /* play key while playing: ignore */ } else if (code === 19 && video.paused) { /* pause key while paused */ } else toggle();
    } else if (key === 'ArrowLeft' || key === 'ArrowRight') {
      const dir = key === 'ArrowRight' ? 1 : -1;
      if (inControls) {
        const vis = controls.filter((b) => !b.hidden);
        const i = vis.indexOf(a) + dir;
        if (vis[i]) vis[i].focus();
      } else skip(dir * SEEK_S);
    } else if (key === 'ArrowUp' || key === 'ArrowDown') {
      showControls();
      if (!inControls) bPlay.focus();
      else if (key === 'ArrowDown') a.blur();
    } else if (key === 'j' || key === 'MediaRewind' || code === 412) skip(-SEEK_S);
    else if (key === 'l' || key === 'MediaFastForward' || code === 417) skip(SEEK_S);
    else if (key === 'm') video.muted = !video.muted;
    else if (key === 'f') toggleFullscreen();
    else if (key === 'c') cycleSubs();
    else if (key === 'n' || key === 'MediaTrackNext') playNext();
    else handled = false;

    if (handled) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
    if (handled || key.startsWith('Arrow')) showControls();
  }
  on(document, 'keydown', onKey, true); // capture: runs before the global navigation handler

  // ---------------------------------------------------------------- wake lock + media session
  async function requestWakeLock() {
    try {
      if (!S.wakeLock && navigator.wakeLock) {
        S.wakeLock = await navigator.wakeLock.request('screen');
        S.wakeLock.addEventListener('release', () => { S.wakeLock = null; });
      }
    } catch { /* not allowed: fine */ }
  }

  function setupMediaSession(info) {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title: info.title, artist: info.subtitle || '' });
      navigator.mediaSession.setActionHandler('play', () => video.play());
      navigator.mediaSession.setActionHandler('pause', () => video.pause());
      navigator.mediaSession.setActionHandler('seekbackward', () => skip(-SEEK_S));
      navigator.mediaSession.setActionHandler('seekforward', () => skip(SEEK_S));
      navigator.mediaSession.setActionHandler('nexttrack', info.next ? playNext : null);
    } catch { /* unsupported action */ }
  }

  // ---------------------------------------------------------------- go
  showControls();
  start();

  return () => {
    S.destroyed = true;
    sendStop();
    clearInterval(S.reportTimer);
    clearInterval(S.nextTimer);
    clearTimeout(S.hideTimer);
    disposers.forEach((d) => d());
    teardownMedia();
    S.wakeLock?.release().catch(() => {});
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
    document.body.classList.remove('in-player');
  };
}
