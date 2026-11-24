/**
 * `npm run demo`: two mock Jellyfin servers + r_flix pointed at them. No real Jellyfin needed.
 * Open http://localhost:8080 and sign in:
 *
 *   admin / demo-admin-1   administrator (sees the Admin page; uses each server's default user)
 *   alice / demo-alice-1   regular user mapped to her OWN Jellyfin accounts (separate history)
 *
 * The database is in memory, so every run starts fresh.
 * Simulate an outage:  curl localhost:8297/down   (restore: /up).  Server A: port 8296.
 */
import http from 'node:http';
import { createMockJellyfin } from './mock-jellyfin.js';
import { serverA, serverB } from './sample-data.js';
import { createApp } from '../src/app.js';

const users = ['demo', 'alice'];
const a = createMockJellyfin({
  name: 'Living Room', apiKey: 'demo-key-a', users, ...serverA,
  watchFor: { alice: { 'Glass Meridian': { pos: 15, agoMin: 4 }, 'Station Eleven Thirty S1E1': { pos: 20, agoMin: 30 } } },
});
const b = createMockJellyfin({ name: 'Basement NAS', apiKey: 'demo-key-b', users, ...serverB });
const [urlA, urlB] = [await a.start(8196), await b.start(8197)];

// A "down" mock drops every connection (including its own control routes), so outages are
// toggled through a separate tiny side-door server per mock.
for (const [m, port] of [[a, 8296], [b, 8297]]) {
  http.createServer((req, res) => { m.setDown(req.url === '/down'); res.end(req.url === '/down' ? 'down\n' : 'up\n'); }).listen(port, '127.0.0.1');
}

const ctx = createApp({
  dataDir: ':memory:',
  legacy: {
    servers: [
      { name: 'Living Room', url: urlA, authType: 'apikey', apiKey: 'demo-key-a' },
      { name: 'Basement NAS', url: urlB, authType: 'apikey', apiKey: 'demo-key-b' },
    ],
    settings: {},
  },
  log: () => {},
});
ctx.settings.update({ healthIntervalSeconds: 5 }); // snappier status indicator for the demo
await ctx.users.create({ username: 'admin', displayName: 'Admin', password: 'demo-admin-1', role: 'admin' });
const alice = await ctx.users.create({ username: 'alice', displayName: 'Alice', password: 'demo-alice-1' });
ctx.users.setMapping(alice.id, 0, a.users[1].id);
ctx.users.setMapping(alice.id, 1, b.users[1].id);
ctx.start();

const port = Number(process.env.PORT || 8080);
ctx.app.listen(port, () => {
  console.log(`\nr_flix demo: http://localhost:${port}`);
  console.log('  sign in:  admin / demo-admin-1   (administrator)   or   alice / demo-alice-1   (own watch history)');
  console.log(`  ffmpeg test video: ${a.hasMedia ? 'yes' : 'NO (install ffmpeg for playback)'}`);
  console.log('  Simulate an outage of server B:  curl localhost:8297/down   (restore: /up)\n  Same for server A on port 8296.\n');
});
