# r_flix

A Netflix-style front end that merges **two (or more) home Jellyfin servers into one library**.
Browse, search and watch from a single page; r_flix figures out which server to use.

- **One catalogue.** Movies, shows, seasons, episodes, artwork and *Continue Watching* are fetched from every server in parallel and merged. A title on both servers (matched by TMDB / IMDb / TVDB id) appears once.
- **Survives an outage.** If a server is offline, r_flix keeps working from the other one and shows a small status indicator. Titles that only live on the offline server stay visible but dimmed.
- **The browser never talks to Jellyfin.** Images, video and subtitles are proxied through r_flix, so your servers' addresses and API keys never reach the browser.
- **Direct play first, transcode as a fallback.** Jellyfin decides: the original file is direct-played when the browser supports it, otherwise Jellyfin serves HLS (remux/transcode).
- **Resume that follows you.** Progress is written to *both* servers, so you can start on one device and continue on another, whichever server serves it.
- **Remote- and keyboard-friendly.** Arrow keys move between cards; works on phones, laptops and TVs.
- **Light.** Node + Express, plain JavaScript front end, no build step, ~90 MB RAM idle. Sized for a **Raspberry Pi 3B+ (1 GB)**.

```
 browser / TV / phone ──► r_flix (Node, on the Pi) ──► Jellyfin server A  (192.168.x.x)
                          │  merge · dedupe · proxy  └─► Jellyfin server B  (192.168.y.y)
                          └─ never decodes or transcodes video
```

> **Security note.** r_flix has no login of its own. Anyone who can reach its port can browse and watch your libraries. Keep it on your home network; don't port-forward it. If you want to expose it, put it behind a VPN or an authenticating reverse proxy.

---

## 1. Prepare each Jellyfin server

Each server needs **either** an API key **or** a username/password.

**API key** (Jellyfin Dashboard → *Advanced* → *API Keys* → **+**, name it `r_flix`).
Watch history is per Jellyfin *user*, so r_flix needs to know which user: it uses the first administrator, or the user named by the optional `username` field in the config.

**Username/password** (recommended if you want r_flix to follow a specific user's watch history): create or reuse a normal Jellyfin user. r_flix logs in on start-up and again if the token expires.

Use the URL you'd use on the LAN, e.g. `http://192.168.1.10:8096` (include a path prefix if Jellyfin is served from one).

## 2. Configure r_flix

Copy the sample and edit it:

```bash
cp config/config.sample.json config/config.json
```

```jsonc
{
  "servers": [
    { "name": "Living Room", "url": "http://192.168.1.10:8096", "apiKey": "…" },
    { "name": "Basement NAS", "url": "http://192.168.1.20:8096", "username": "me", "password": "…" }
  ]
}
```

`config/config.json` is git-ignored. **Credentials are never hardcoded**: they come only from this file or from environment variables.

**Order = priority.** When a title exists on both servers, the first *reachable* server in the list is used.

### Environment variables

Instead of (or on top of) the file, set `JELLYFIN_<n>_*` for server *n* (1–9). Variables override the same-numbered server in the file and can add servers. See `.env.example`.

| Variable | Meaning |
|---|---|
| `JELLYFIN_<n>_URL` | Base URL of the server |
| `JELLYFIN_<n>_API_KEY` | API key (or use username + password) |
| `JELLYFIN_<n>_USERNAME` / `_PASSWORD` | Login (with an API key, `_USERNAME` only picks the user) |
| `JELLYFIN_<n>_USER_ID` | Jellyfin user id to use with an API key |
| `JELLYFIN_<n>_NAME` | Display name in the status indicator |
| `PORT` | Listen port (default `8080`) |
| `RFLIX_CACHE_TTL` | Library refresh interval in seconds (default `300`) |
| `RFLIX_CONFIG` | Path to the JSON config (default `./config/config.json`) |

### Other options (config file)

| Key | Default | Meaning |
|---|---|---|
| `healthIntervalSeconds` | `20` | How often each server is pinged for the status dots |
| `requestTimeoutMs` | `8000` | Timeout for Jellyfin API calls |
| `dedupe.fallbackToTitleYear` | `true` | For items with no TMDB/IMDb/TVDB id, match on title + year |
| `playback.maxBitrateMbps` | `12` | Bitrate cap. Streams go through the Pi's network port, so keep it modest |
| `playback.allowHevc` | `false` | Allow HEVC direct play (Safari, most smart TVs) |
| `playback.directPlayAudio` | `aac,mp3,opus,flac` | Audio codecs your browsers can direct-play in MP4 |
| `playback.forceTranscode` | `false` | Always transcode (debugging) |

## 3. Run it

### Docker (recommended)

```bash
docker compose up -d --build
# open http://<pi-address>:8080
```

The compose file mounts `./config` read-only, caps the container at 256 MB, and limits log size to protect the SD card. Logs: `docker compose logs -f r_flix`.

### Plain Node (Node 20+)

```bash
npm ci --omit=dev
npm start
```

### Try it without Jellyfin (demo mode)

```bash
npm install
npm run demo      # two fake Jellyfin servers + r_flix on http://localhost:8080
```

Needs `ffmpeg` for the test video. Simulate an outage of the second server with `curl localhost:8297/down` (restore: `/up`) and watch the status dots, banner and playback failover.

## Raspberry Pi 3B+ notes

- **Use a wired connection.** The 3B+'s Ethernet shares a USB 2.0 bus (~300 Mbit/s real-world); Wi-Fi is slower still. A 1080p direct-play stream is typically 5-25 Mbit/s, which is fine. Very high-bitrate 4K remuxes may not be: lower `maxBitrateMbps` and Jellyfin will transcode them instead.
- **Prefer 64-bit Raspberry Pi OS Lite.** 32-bit works if the Docker base image supports it; if `node:22-alpine` has no armv7 build for you, change the first line of the Dockerfile to `node:20-bookworm-slim`.
- **The Pi does no video work.** It relays bytes and serves small JSON. All transcoding happens on your Jellyfin servers, and decoding happens on the device you watch on.
- **Memory.** Measured idle RSS is ~90 MB with ~5,500 titles (peak ~110 MB during a library refresh with 60 parallel image fetches). The Node heap is capped at 160 MB and the container at 256 MB.
- **SD card wear.** r_flix writes nothing to disk. Docker logs are size-capped.

## Using it

| Key | Browsing | Player |
|---|---|---|
| ← ↑ ↓ → | Move between cards, buttons, rows | ←/→ seek ±10 s · ↑/↓ open the controls (then ←/→ move between buttons) |
| Enter | Open | Play/pause (or press the focused button) |
| Esc / Backspace / TV Back | Go back | Leave the player (Esc first leaves the controls) |
| `/` | Jump to search | |
| `m` `f` `c` `n` `j` `l` | | mute · fullscreen · subtitles · next episode · −10 s · +10 s |

Tizen/webOS Back and media keys are handled. On phones everything is touch/tap.

## How it works

| File | Role |
|---|---|
| `src/config.js` | Loads the JSON file + env vars, validates |
| `src/jellyfin.js` | One client per server: auth (API key or login), health monitor, version-compat fallbacks |
| `src/catalogue.js` | Parallel library fetch, dedupe/merge, home rows, search, merged episodes and watch state |
| `src/playback.js` | Asks Jellyfin for direct play vs HLS, subtitles, next episode, progress reporting |
| `src/proxy.js` | Allow-listed media proxy (Range support, HLS playlist rewriting) and image proxy |
| `src/app.js`, `src/server.js` | Routes, security headers, startup |
| `public/` | Front end (ES modules, no framework): router, home, browse, search, title page, player, spatial navigation |
| `dev/` | Mock Jellyfin servers for the demo and tests |

**Item ids.** The browser only sees an opaque id that encodes every server's copy of an item (server index + Jellyfin id). It never sees a server address, and the ids are stateless, so links survive restarts.

**Duplicates.** Two items are the same title if they share any TMDB / IMDb / TVDB id (scoped by type: a movie and a series with the same TMDB number are different). Items with no provider ids fall back to title + year. Two copies on the *same* server are never merged.

**Watch state.** The most recently played copy wins, and progress is written to every reachable copy, so the servers stay in sync.

**Proxy safety.** `/proxy` only forwards an allow-list of media paths (video stream, HLS playlists/segments, WebVTT subtitles). Credentials in the query string are dropped and r_flix adds its own, so the proxy can't be used to reach the rest of the Jellyfin API.

## Limitations

- No built-in login (see the security note above).
- Audio-track switching isn't supported (the default track plays). Text subtitles work (WebVTT); image-based subtitles (PGS) aren't offered.
- Search covers movies and shows (title, genre, year), not episodes or people.
- Live TV, music and photo libraries aren't shown.
- Only the reachable server's *cached* titles are shown when the other is down: a title that exists on one offline server is dimmed and can't be played.

## Development

```bash
npm install
npm test          # unit + integration tests against mock Jellyfin servers
npm run demo
```

The code is commented to explain *why*, not just what; start with `src/catalogue.js` and `src/playback.js`.
