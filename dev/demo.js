/**
 * `npm run demo`: start two mock Jellyfin servers and r_flix pointed at them.
 * Requires no real Jellyfin. Visit http://localhost:8080
 *
 * Simulate server B going offline:  curl localhost:8297/down   (restore: curl localhost:8297/up)
 */
import http from 'node:http';
import { createMockJellyfin } from './mock-jellyfin.js';
import { serverA, serverB } from './sample-data.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const a = createMockJellyfin({ name: 'Living Room', apiKey: 'demo-key-a', ...serverA });
const b = createMockJellyfin({ name: 'Basement NAS', apiKey: 'demo-key-b', ...serverB });
const [urlA, urlB] = [await a.start(8196), await b.start(8197)];
// A "down" mock drops every connection (including its own control routes), so outages are
// toggled through a separate tiny side-door server per mock.
for (const [m, port] of [[a, 8296], [b, 8297]]) {
  http.createServer((req, res) => { m.setDown(req.url === '/down'); res.end(req.url === '/down' ? 'down\n' : 'up\n'); }).listen(port, '127.0.0.1');
}

const cfg = loadConfig({
  PORT: process.env.PORT || '8080',
  JELLYFIN_1_URL: urlA, JELLYFIN_1_API_KEY: 'demo-key-a', JELLYFIN_1_NAME: 'Living Room',
  JELLYFIN_2_URL: urlB, JELLYFIN_2_API_KEY: 'demo-key-b', JELLYFIN_2_NAME: 'Basement NAS',
}, '/nonexistent');
cfg.healthIntervalSeconds = 3;
const { app, start } = createApp(cfg);
start();
app.listen(cfg.port, () => {
  console.log(`\nr_flix demo: http://localhost:${cfg.port}`);
  console.log(`  server A mock: ${urlA}   server B mock: ${urlB}`);
  console.log(`  ffmpeg test video: ${a.hasMedia ? 'yes' : 'NO (install ffmpeg for playback)'}`);
  console.log('  Simulate an outage of server B:  curl localhost:8297/down   (restore: /up)\n  Same for server A on port 8296.\n');
});
