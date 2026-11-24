/** Admin → Settings: caching, health checks, playback. Validated by the server; applied immediately. */
import { h } from './util.js';
import { get, put } from './api.js';
import { field, check, notice, run } from './ui.js';

export async function mount(root) {
  const { values } = await get('/api/admin/settings');
  const note = notice();
  const num = (v, min, max, step = 1) => h('input', { type: 'number', value: String(v), min: String(min), max: String(max), step: String(step), required: true });

  const ttl = num(values.cacheTtlSeconds, 30, 86400);
  const health = num(values.healthIntervalSeconds, 5, 3600);
  const timeout = num(values.requestTimeoutMs, 1000, 60000, 500);
  const dedupe = check('Match duplicates by title + year when there is no TMDB / IMDb / TVDB id', values.dedupe.fallbackToTitleYear);
  const bitrate = num(values.playback.maxBitrateMbps, 1, 200, 1);
  const hevc = check('Allow HEVC (H.265) direct play', values.playback.allowHevc, 'Turn on only if your browsers/TVs can decode it (Safari, most smart TVs).');
  const audio = h('input', { type: 'text', value: values.playback.directPlayAudio, required: true, pattern: '[A-Za-z0-9_,\\- ]+' });
  const force = check('Always transcode (skip direct play)', values.playback.forceTranscode, 'For debugging. Puts a lot of load on your Jellyfin servers.');

  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Save settings');
  const form = h('form', { class: 'form panel', onsubmit: async (e) => {
    e.preventDefault();
    const r = await run(btn, note, () => put('/api/admin/settings', {
      cacheTtlSeconds: Number(ttl.value), healthIntervalSeconds: Number(health.value), requestTimeoutMs: Number(timeout.value),
      dedupe: { fallbackToTitleYear: dedupe.input.checked },
      playback: { maxBitrateMbps: Number(bitrate.value), allowHevc: hevc.input.checked, directPlayAudio: audio.value, forceTranscode: force.input.checked },
    }));
    if (r) note.show('Saved. Changes are already in effect.');
  } },
    h('h3', null, 'Library and servers'),
    field('Library refresh interval (seconds)', ttl, 'How often each server\'s movie and show list is re-read.'),
    field('Server check interval (seconds)', health, 'How often servers are pinged for the online/offline indicator.'),
    field('Jellyfin request timeout (milliseconds)', timeout, 'How long to wait for a server before treating it as unreachable.'),
    dedupe.el,
    h('h3', null, 'Playback'),
    field('Maximum bitrate (Mbit/s)', bitrate, 'All video is relayed through r_flix, so keep this within what its network connection can carry. Higher-bitrate files are transcoded by Jellyfin.'),
    hevc.el,
    field('Audio codecs your devices can direct-play', audio, 'Comma-separated, e.g. aac,mp3,opus,flac'),
    force.el,
    note.el, btn);
  root.replaceChildren(form);
}
