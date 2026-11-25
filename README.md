# r_flix

A Netflix-style front end that merges **two (or more) home Jellyfin servers into one library**, with its own user accounts and an admin page. Everyone signs in, browses one catalogue, and r_flix figures out which server to use.

- **One catalogue.** Movies, shows, seasons, episodes, artwork and *Continue Watching* come from every server in parallel and are merged. A title on both servers (matched by TMDB / IMDb / TVDB id) appears once.
- **Accounts and an admin page.** Users and roles live in r_flix's own database. All configuration (Jellyfin servers, users, playback and cache settings) is edited on the Admin page; there is no config file to hand-edit.
- **Their own history.** Link each person to their own Jellyfin account on each server and they get separate watch history, resume points and Continue Watching, kept in sync across servers.
- **Survives an outage.** If a server is offline, r_flix keeps working from the other one and shows a small status indicator.
- **The browser never talks to Jellyfin.** Images, video and subtitles are proxied, so server addresses and API keys never reach the browser.
- **Direct play first, transcode as a fallback.** Jellyfin decides; r_flix relays the stream.
- **Remote- and keyboard-friendly**, responsive, and light: Node + SQLite, plain JavaScript front end, ~85 MB RAM idle. Sized for a **Raspberry Pi 3B+ (1 GB)**.

```
 browser / TV / phone ──► r_flix (Node + SQLite, on the Pi) ──► Jellyfin server A
   signs in with a          accounts · admin · merge · proxy  └─► Jellyfin server B
   r_flix account           never decodes or transcodes video
```

---

## 1. Run it

### Docker (recommended)

```bash
docker compose up -d --build
docker compose logs r_flix        # shows the first-run setup code
```

Open `http://<pi-address>:8080`. On a fresh install you'll see **Welcome to r_flix**:

1. Enter the **setup code** from the log (it proves you control the machine, so a stranger who finds the port first can't claim the admin account).
2. Choose the administrator's username and password.
3. You land on **Admin → Servers**: add your Jellyfin servers (below), then add people under **Users**.

Your data lives in the `rflix-data` Docker volume (`rflix.db` + `secret.key`). **Back it up.**

### Plain Node (22.13+)

```bash
npm ci --omit=dev
npm start                 # data in ./data (override with RFLIX_DATA)
```

### Try it without Jellyfin

```bash
npm install
npm run demo              # two fake Jellyfin servers + r_flix on http://localhost:8080
```

Sign in as `admin` / `demo-admin-1` (administrator) or `alice` / `demo-alice-1` (own watch history). Needs `ffmpeg` for the test video. Simulate an outage of the second server with `curl localhost:8297/down` (restore: `/up`).

## 2. Prepare each Jellyfin server

r_flix needs an **API key** or a **username/password** for each server.

- **API key (recommended):** Jellyfin Dashboard → *Advanced* → *API Keys* → **+**. An API key can act as any user on that server, which is what makes per-person watch history possible.
- **Username/password:** create or reuse a Jellyfin user. For per-person history this login must be an **administrator**; a non-admin login works for the shared library but can't be mapped to other people.

Use the address you'd use on your LAN, e.g. `http://192.168.1.10:8096`.

## 3. The Admin page

Administrators see **Admin** in the top bar.

**Servers.** Add, edit, test, reorder, disable and delete servers; changes apply immediately, with no restart.
- **Test connection** checks reachability and the credentials, and tells you whether per-person history is available.
- **Order = priority.** When a title exists on several servers, the first reachable one is used. Use ↑/↓ to reorder.
- Credentials are write-only: after saving, they are never shown again (leave a field blank to keep the saved value).

**Users.** Add people, set roles (Member / Administrator), reset passwords, disable or delete accounts, sign someone out everywhere.
- **Jellyfin accounts:** pick which Jellyfin user each person is on each server, or press **Link by username** to match names automatically. Leave a server on *Shared* and that person uses the server's default user's history there.
- Safeguards: you can't delete, demote or disable yourself, and the last enabled admin can't be removed.

**Settings.** Library refresh interval, server check interval, request timeout, duplicate matching, maximum bitrate, HEVC, direct-play audio codecs. Values are validated and applied immediately.

**Status.** Server health and latency, catalogue size (how many titles are shared across servers), memory use and uptime.

Everyone can change their own display name and password under **My account**.

## 4. Settings reference

| Setting | Default | Meaning |
|---|---|---|
| Library refresh interval | `300` s | How often each server's movie/show list is re-read |
| Server check interval | `20` s | How often servers are pinged for the status dots |
| Request timeout | `8000` ms | How long to wait for a server before treating it as unreachable |
| Match duplicates by title + year | on | For items with no TMDB/IMDb/TVDB id |
| Maximum bitrate | `12` Mbit/s | All video is relayed through r_flix's network port; keep it within what that can carry |
| Allow HEVC | off | Turn on if your browsers/TVs decode H.265 (Safari, most smart TVs) |
| Direct-play audio | `aac,mp3,opus,flac` | Audio codecs your devices can play inside MP4 |
| Always transcode | off | Debugging only |

### Bootstrap environment variables

Only what must be known before the database opens:

| Variable | Meaning |
|---|---|
| `PORT` | Listen port (default `8080`) |
| `RFLIX_DATA` | Directory for `rflix.db` and `secret.key` (default `./data`; `/data` in Docker) |
| `RFLIX_SECRET` | Optional: encrypts stored Jellyfin credentials with this instead of `secret.key` (keeps the key off the data volume) |
| `RFLIX_TRUST_PROXY` | `1` when running behind a reverse proxy |
| `RFLIX_SETUP_CODE` | Optional fixed first-run code instead of a random one in the log |

### Upgrading from the config-file version

If the database has **no servers yet**, `config/config.json` (and `JELLYFIN_<n>_*` variables) are imported **once** at start-up, then ignored. Mount your old config for the first run (`-v ./config:/config:ro -e RFLIX_CONFIG=/config/config.json`), then create the admin account and manage everything on the Admin page. See `config/config.sample.json` for the format.

## 5. Security

- **Sign-in:** passwords are hashed with scrypt (per-user salt). Sessions are random tokens in an `HttpOnly`, `SameSite=Lax` cookie; only a hash of the token is stored. Failed sign-ins are throttled per account and per address.
- **Everything needs a session:** the catalogue, artwork, and video proxy all require sign-in. Disabling or deleting a user, resetting their password, or changing your own password signs out the affected sessions.
- **Jellyfin credentials** are stored encrypted (AES-256-GCM) and never sent to the browser. By default the key is `secret.key` in the data directory; set `RFLIX_SECRET` to keep it elsewhere. Losing the key makes saved credentials unreadable: re-enter them on the Admin page.
- **No HTTPS built in.** On a home LAN, plain HTTP works. To share with others, use the Tailscale add-on below (private HTTPS, no open ports). If you use a different reverse proxy with HTTPS instead, set `RFLIX_TRUST_PROXY=1`. Don't forward the plain HTTP port to the internet.
- **Library visibility is shared.** Everyone sees the same titles (the catalogue is built from each server's default user). Per-person mapping separates *watch history*, not parental controls or library access: Jellyfin's per-user restrictions are not enforced inside r_flix.
- `/proxy` only forwards an allow-list of media paths and drops any credentials in the query string, so it can't be used to reach the rest of the Jellyfin API.

## Share with friends and family (Tailscale) and install as an app

[Tailscale](https://tailscale.com) is a free private network. With the included add-on, r_flix gets an **HTTPS address that only you and the people you invite can reach**. Nothing is opened on your router and r_flix is never on the public internet. HTTPS also unlocks **Install app** in browsers.

### One-time setup (about 5 minutes)

1. **Create a free Tailscale account** at tailscale.com.
2. In the [admin console → DNS](https://login.tailscale.com/admin/dns), turn on **MagicDNS** and **HTTPS Certificates**. The HTTPS address won't work without this.
3. In [Settings → Keys](https://login.tailscale.com/admin/settings/keys), **Generate auth key** (the defaults are fine) and copy it.
4. On the Pi, in the r_flix folder:

   ```bash
   git pull
   echo 'TS_AUTHKEY=tskey-auth-PASTE-YOUR-KEY' >> .env
   echo 'COMPOSE_FILE=docker-compose.yml:docker-compose.tailscale.yml' >> .env
   docker compose up -d --build
   docker compose logs tailscale     # look for "Serving ... https://rflix.<name>.ts.net"
   ```

   (`COMPOSE_FILE` just saves typing both files every time.)
5. Open **`https://rflix.<your-tailnet>.ts.net`** from any device signed in to your Tailscale account (the exact name is in the log and under *Machines* in the admin console). It shows the same r_flix sign-in as `http://<pi>:8080`, which keeps working on your home network.

### Invite someone

1. They install the Tailscale app (Android, iPhone, Windows, Mac, Linux, **Android TV / Google TV / Fire TV / Apple TV**) and make their own free Tailscale account.
2. In the Tailscale admin console go to **Machines → `rflix` → ⋯ → Share…**, and send them the link. They accept it, and `rflix` appears for them. Sharing gives access to **that one machine only**, not your other devices. (Check Tailscale's current plan limits on sharing.)
3. In r_flix, **Admin → Users → Add user** for them, and **Link by username** if they have their own Jellyfin accounts.
4. They open `https://rflix.<your-tailnet>.ts.net` and sign in with the r_flix account you made.

### Install it as an app

Use the **HTTPS** address, not the plain LAN one.

| Device | How |
|---|---|
| Android (Chrome) | Menu ⋮ → **Install app** |
| iPhone / iPad (Safari) | Share → **Add to Home Screen** |
| Windows / Mac / Linux (Chrome, Edge) | The install icon at the right of the address bar |
| Android TV / Google TV / Fire TV | Run the Tailscale app, then open the HTTPS address in a browser. TV remotes work: arrows, Enter and Back are handled. |
| Samsung / LG TV | These TVs have no Tailscale app. Use a Fire TV Stick or Google TV box, or cast from a phone. |

The installed app opens full screen with its own icon. It only caches the page itself: your library, artwork and video are always fetched live and never stored by the app.

### Things to know when sharing

- **Your upload speed and your Jellyfin servers are the limit**, not the Pi: each remote viewer's stream leaves your home connection, and transcoding happens on the Jellyfin servers. Lower **Admin → Settings → Maximum bitrate** (for example 4-8 Mbit/s) if you share with several people.
- Tailscale hands r_flix each person's address, so sign-in throttling works per person. Failed sign-ins are also limited per account, so guessing one password from many places doesn't get around it.
- To stop sharing with someone: remove the share in the Tailscale console and/or disable their user in **Admin → Users**.

## Raspberry Pi 3B+ notes

- **Use a wired connection.** The 3B+'s Ethernet shares a USB 2.0 bus (~300 Mbit/s real-world); Wi-Fi is slower still. A 1080p direct-play stream is typically 5-25 Mbit/s, which is fine. Very high-bitrate 4K remuxes may not be: lower the maximum bitrate and Jellyfin will transcode them instead.
- **Prefer 64-bit Raspberry Pi OS Lite.** 32-bit works if Docker's `node:22-alpine` has an armv7 build for you; otherwise change the first line of the Dockerfile to `node:22-bookworm-slim`. r_flix needs Node **22.13+** (built-in SQLite).
- **The Pi does no video work.** It relays bytes and serves small JSON. Transcoding happens on your Jellyfin servers, decoding on the device you watch on.
- **Memory.** With a ~5,500-title library, measured RSS is ~85 MB idle, ~115 MB while serving a page of artwork (60 images, 20 in parallel), and ~130 MB peak (a sign-in briefly needs ~16 MB for password hashing). The Node heap is capped at 160 MB and the container at 256 MB. Typical home libraries are much smaller.
- **SD card wear.** The database uses WAL with relaxed sync and is written only when you change something, sign in, or play (progress is saved on the Jellyfin side). Docker logs are size-capped.

## Using it

| Key | Browsing | Player |
|---|---|---|
| ← ↑ ↓ → | Move between cards, buttons, rows | ←/→ seek ±10 s · ↑/↓ open the controls (then ←/→ move between buttons) |
| Enter | Open | Play/pause (or press the focused button) |
| Esc / Backspace / TV Back | Go back | Leave the player (Esc first leaves the controls) |
| `/` | Jump to search | |
| `m` `f` `c` `n` `j` `l` | | mute · fullscreen · subtitles · next episode · −10 s · +10 s |

## How it works

| File | Role |
|---|---|
| `src/config.js` | Bootstrap env + the one-time legacy import reader |
| `src/db.js`, `src/crypto.js`, `src/settings.js` | SQLite (built-in `node:sqlite`), credential encryption, live settings |
| `src/auth.js` | Users, scrypt passwords, sessions, login throttling |
| `src/servers.js` | Server registry: stable slots, priority, encrypted credentials, live apply, connection test |
| `src/jellyfin.js` | One client per server: auth, health monitor, per-user calls, version-compat fallbacks |
| `src/catalogue.js` | Library fetch, dedupe/merge, per-user watch-state overlay, home rows, search, episodes |
| `src/playback.js` | Direct play vs HLS, subtitles, next episode, per-user progress reporting |
| `src/proxy.js` | Allow-listed media proxy (Range, HLS rewriting) and artwork proxy |
| `src/app.js`, `src/server.js` | Routes (public / signed-in / admin), security headers, startup |
| `public/` | Front end (ES modules, no framework): router, sign-in/setup, home, browse, search, title page, player, account, admin |
| `dev/` | Mock Jellyfin servers for the demo and tests |

**Item ids.** The browser only sees an opaque id that encodes every server's copy of an item (a stable server *slot* + the Jellyfin id). It never sees a server address, and ids survive re-ordering or renaming servers.

**Watch state.** The library is shared; watch state is per user and fetched live (one request per server) and overlaid on the cards. Progress you make is written to every reachable copy of the title, as *your* Jellyfin account on each server. The most recently played copy wins when the servers disagree.

## Limitations

- Per-person history needs an API key or an administrator login on that server.
- Audio-track switching isn't supported (the default track plays). Text subtitles work (WebVTT); image-based subtitles (PGS) aren't offered.
- Search covers movies and shows (title, genre, year), not episodes or people.
- Live TV, music and photo libraries aren't shown.
- Titles that exist only on an offline server stay visible but dimmed and can't be played.
- No password-reset email; an admin resets passwords. If the only admin forgets theirs, stop r_flix and delete `rflix.db` to start the setup again (this removes users and servers).

## Development

```bash
npm install
npm test          # unit + integration tests against mock Jellyfin servers (in-memory database)
npm run demo
```
