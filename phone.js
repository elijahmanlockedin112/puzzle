/* phone.js — serve the app to your own phone over Tailscale.
   Tailscale Serve gives this machine a real Let's Encrypt cert on its
   *.ts.net name, which is what makes the camera work: browsers only hand out
   getUserMedia on a secure context, and plain http://100.x.y.z is not one.
   Tailnet only — this is Serve, not Funnel, so nothing is exposed publicly. */
const { execFileSync } = require('child_process');
const fs = require('fs');
const serve = require('./serve');

const PORT = Number(process.argv[2]) || 8757;
const HTTPS_PORT = Number(process.argv[3]) || 8443;

const CANDIDATES = [
  'C:\\Program Files\\Tailscale\\tailscale.exe',
  'C:\\Program Files (x86)\\Tailscale IPN\\tailscale.exe',
  '/usr/bin/tailscale',
  '/usr/local/bin/tailscale',
  'tailscale'
];

function findTailscale() {
  for (const c of CANDIDATES) {
    try {
      if (c === 'tailscale' || fs.existsSync(c)) {
        execFileSync(c, ['version'], { stdio: 'ignore' });
        return c;
      }
    } catch (e) { /* try the next one */ }
  }
  return null;
}

function hostname(ts) {
  const json = JSON.parse(execFileSync(ts, ['status', '--json'], { encoding: 'utf8', maxBuffer: 1 << 24 }));
  return (json.Self && json.Self.DNSName || '').replace(/\.$/, '');
}

const ts = findTailscale();
if (!ts) {
  console.error('Tailscale not found — falling back to localhost only.');
  serve.start(PORT);
  return;
}

let host;
try {
  host = hostname(ts);
} catch (e) {
  console.error('Could not read Tailscale status (is it signed in?): ' + e.message);
  serve.start(PORT);
  return;
}

serve.start(PORT, () => {
  try {
    execFileSync(ts, ['serve', '--bg', '--https=' + HTTPS_PORT, 'http://127.0.0.1:' + PORT], { stdio: 'pipe' });
  } catch (e) {
    console.error('\ntailscale serve failed: ' + (e.stderr ? e.stderr.toString().trim() : e.message));
    console.error('If it mentions certificates, enable HTTPS in the Tailscale admin console under DNS.\n');
    return;
  }
  const url = 'https://' + host + ':' + HTTPS_PORT;
  const bar = '─'.repeat(url.length + 6);
  console.log('\n┌' + bar + '┐');
  console.log('│   ' + url + '   │');
  console.log('└' + bar + '┘');
  console.log('\nOpen that on any device signed into your tailnet. Real cert, so the camera works.');
  console.log('Stop sharing later with:  tailscale serve --https=' + HTTPS_PORT + ' off');
  console.log('Ctrl+C here stops the server.\n');
});
