/**
 * Playback: choosing a server and a delivery method for a title, and
 * reporting progress back so "Continue Watching" and resume work.
 *
 * Delivery is decided by Jellyfin itself: we send a device profile describing
 * what a browser can play, and Jellyfin answers with either
 *   - direct play  (the original file, served with HTTP range requests), or
 *   - an HLS URL   (remux or transcode on the Jellyfin server — the fallback).
 * Either way the URL we hand the browser points at OUR /proxy route.
 */
import { decodeUid } from './ids.js';
import { mergeUd, slimUd } from './catalogue.js';
import { HttpError } from './http-error.js';

const TEXT_SUB_CODECS = new Set(['srt', 'subrip', 'ass', 'ssa', 'vtt', 'webvtt', 'mov_text']);
const FINISHED = 0.9; // watched >= 90% counts as "played"

/** Describe what a browser can decode, so Jellyfin can pick direct play vs transcode. */
export function deviceProfile(pb) {
  const bitrate = Math.round(pb.maxBitrateMbps * 1_000_000);
  const h264Codecs = pb.allowHevc ? 'h264,hevc' : 'h264';
  return {
    Name: 'r_flix web',
    MaxStreamingBitrate: bitrate,
    MaxStaticBitrate: bitrate,
    MusicStreamingTranscodingBitrate: 192000,
    DirectPlayProfiles: [
      { Container: 'mp4,m4v', Type: 'Video', VideoCodec: h264Codecs, AudioCodec: pb.directPlayAudio },
      { Container: 'webm', Type: 'Video', VideoCodec: 'vp8,vp9,av1', AudioCodec: 'vorbis,opus' },
    ],
    TranscodingProfiles: [
      {
        Container: 'ts',
        Type: 'Video',
        Protocol: 'hls',
        Context: 'Streaming',
        VideoCodec: h264Codecs,
        AudioCodec: 'aac,mp3',
        MaxAudioChannels: '2',
        MinSegments: '1',
        BreakOnNonKeyFrames: true,
      },
    ],
    CodecProfiles: [
      {
        Type: 'Video',
        Codec: 'h264',
        Conditions: [
          { Condition: 'LessThanEqual', Property: 'VideoBitDepth', Value: '8', IsRequired: false },
          { Condition: 'LessThanEqual', Property: 'VideoLevel', Value: '52', IsRequired: false },
        ],
      },
    ],
    // Text subtitles are fetched separately as WebVTT, so never burn them in.
    SubtitleProfiles: ['vtt', 'srt', 'subrip', 'ass', 'ssa'].map((Format) => ({ Format, Method: 'External' })),
  };
}

export class Playback {
  constructor(servers, catalogue, cfg) {
    this.servers = servers;
    this.catalogue = catalogue;
    this.cfg = cfg;
    this.profile = deviceProfile(cfg.playback);
  }

  /**
   * Work out how to play `uid` right now.
   * @param {string} uid
   * @param {{exclude?:Set<number>, start?:number, forceTranscode?:boolean}} opts
   *   exclude: server indexes to skip (the player passes the one that just failed)
   */
  async prepare(uid, { exclude = new Set(), start, forceTranscode = false } = {}) {
    const variants = decodeUid(uid);
    if (!variants) throw new HttpError(400, 'Bad item id');
    const usable = variants.filter((v) => this.servers[v.s] && !exclude.has(v.s) && this.servers[v.s].online !== false);
    if (!usable.length) throw new HttpError(503, 'No reachable server has this title right now');

    // Metadata + watch state from every reachable copy (for the resume position).
    const fetched = await Promise.allSettled(usable.map((v) => this.servers[v.s].item(v.id)));
    const items = fetched.filter((r) => r.status === 'fulfilled' && r.value).map((r) => r.value);
    const meta = items[0];
    const ud = mergeUd(items.map((it) => slimUd(it.UserData)));

    const force = forceTranscode || this.cfg.playback.forceTranscode;
    let lastErr;
    for (const v of usable) {
      const srv = this.servers[v.s];
      try {
        const info = await srv.playbackInfo(v.id, {
          DeviceProfile: this.profile,
          MaxStreamingBitrate: this.profile.MaxStreamingBitrate,
          AutoOpenLiveStream: false,
          EnableDirectPlay: !force,
          EnableDirectStream: !force,
          EnableTranscoding: true,
        });
        const ms = info?.MediaSources?.[0];
        if (!ms || info.ErrorCode) throw new Error(info?.ErrorCode || 'no playable media source');
        return await this._describe({ v, srv, info, ms, meta, ud, start, force });
      } catch (err) {
        lastErr = err; // try the next copy on another server
      }
    }
    throw new HttpError(502, `Could not start playback: ${lastErr?.message || 'unknown error'}`);
  }

  async _describe({ v, srv, info, ms, meta, ud, start, force }) {
    const playSessionId = info.PlaySessionId;
    let url, mode, playMethod;
    if (ms.SupportsDirectPlay && !force) {
      const q = new URLSearchParams({ Static: 'true', MediaSourceId: ms.Id, PlaySessionId: playSessionId, DeviceId: srv.deviceId });
      if (ms.ETag) q.set('Tag', ms.ETag);
      url = `/proxy/${v.s}/Videos/${v.id}/stream?${q}`;
      mode = 'direct';
      playMethod = 'DirectPlay';
    } else if (ms.TranscodingUrl) {
      // Jellyfin embeds its access token in this URL; strip it — the proxy adds auth itself.
      const u = new URL(ms.TranscodingUrl, 'http://x');
      for (const k of [...u.searchParams.keys()]) if (/^(api_key|apikey|x-emby-token)$/i.test(k)) u.searchParams.delete(k);
      const basePath = new URL(srv.base).pathname.replace(/\/$/, '');
      const p = basePath && u.pathname.startsWith(basePath) ? u.pathname.slice(basePath.length) : u.pathname;
      url = `/proxy/${v.s}${p}${u.search}`;
      mode = /\.m3u8$/i.test(u.pathname) ? 'hls' : 'direct';
      playMethod = 'Transcode';
    } else {
      throw new Error('server offered neither direct play nor a transcode');
    }

    const runtimeTicks = ms.RunTimeTicks || meta?.RunTimeTicks || 0;
    const durationSeconds = runtimeTicks / 1e7;
    let startSeconds = Number.isFinite(start) ? start : !ud.played && ud.pos > 0 ? ud.pos / 1e7 : 0;
    if (startSeconds < 10 || (durationSeconds && startSeconds > durationSeconds * 0.95)) startSeconds = 0;

    const subtitles = (ms.MediaStreams || [])
      .filter((s) => s.Type === 'Subtitle' && (s.IsTextSubtitleStream || TEXT_SUB_CODECS.has((s.Codec || '').toLowerCase())))
      .map((s) => ({
        label: s.DisplayTitle || s.Language || `Track ${s.Index}`,
        lang: (s.Language || '').slice(0, 3),
        default: !!s.IsDefault,
        url: `/proxy/${v.s}/Videos/${v.id}/${ms.Id}/Subtitles/${s.Index}/0/Stream.vtt`,
      }));

    const isEp = meta?.Type === 'Episode';
    const out = {
      url,
      mode,
      playMethod,
      serverIndex: v.s,
      serverName: srv.name,
      mediaSourceId: ms.Id,
      playSessionId,
      durationSeconds,
      startSeconds: Math.floor(startSeconds),
      title: isEp ? meta.SeriesName || meta.Name : meta?.Name || '',
      subtitle: isEp ? `S${meta.ParentIndexNumber ?? '?'}:E${meta.IndexNumber ?? '?'} · ${meta.Name}` : null,
      subtitles,
      next: null,
      seriesId: null,
    };
    if (isEp) Object.assign(out, await this._episodeContext(v.s, meta));
    return out;
  }

  /** For an episode: the parent series uid and the following episode (for "Next episode"). */
  async _episodeContext(s, ep) {
    try {
      const series = ep.SeriesId && this.catalogue.byServerId.get(`${s}:${ep.SeriesId.replace(/-/g, '')}`);
      if (!series) return {};
      const { flat, byKey } = await this.catalogue.episodesOf(series);
      const cur = byKey.get(`${ep.ParentIndexNumber ?? 0}:${ep.IndexNumber}`);
      const next = cur && flat[flat.indexOf(cur) + 1];
      return {
        seriesId: series.uid,
        next: next && { id: next.uid, title: `S${next.season}:E${next.number} · ${next.variants[0].item.name}` },
      };
    } catch {
      return {};
    }
  }

  /**
   * Handle a progress report from the player.
   * The session report goes to the server being streamed from (keeps its
   * dashboard and transcode lifecycle right); the resume position is written to
   * EVERY reachable copy so watch state stays in sync across servers.
   */
  async report({ uid, event, positionSeconds, durationSeconds = 0, playSessionId, serverIndex, mediaSourceId, playMethod, paused = false }) {
    const variants = decodeUid(uid);
    const playing = variants?.find((v) => v.s === serverIndex);
    if (!playing || !this.servers[serverIndex]) throw new HttpError(400, 'Bad playback report');
    const srv = this.servers[serverIndex];
    const ticks = Math.round(positionSeconds * 1e7);

    try {
      await srv.reportPlayback(event === 'start' ? '' : event === 'stop' ? 'Stopped' : 'Progress', {
        ItemId: playing.id,
        MediaSourceId: mediaSourceId,
        PlaySessionId: playSessionId,
        PositionTicks: ticks,
        IsPaused: !!paused,
        CanSeek: true,
        PlayMethod: playMethod || 'DirectPlay',
      });
    } catch {
      /* a failed session report must not break playback */
    }

    if (event !== 'start' && positionSeconds >= 10) {
      const finished = event === 'stop' && durationSeconds > 0 && positionSeconds / durationSeconds >= FINISHED;
      const data = finished
        ? { Played: true, PlaybackPositionTicks: 0, LastPlayedDate: new Date().toISOString() }
        : { PlaybackPositionTicks: ticks, LastPlayedDate: new Date().toISOString() };
      await Promise.allSettled(variants.filter((v) => this.servers[v.s]?.online !== false).map((v) => this.servers[v.s].writeUserData(v.id, data)));
    }

    if (event === 'stop') {
      this.catalogue.epCache.clear(); // episode progress bars are stale now
      if (playMethod === 'Transcode') srv.stopTranscode(playSessionId).catch(() => {});
    }
  }
}
