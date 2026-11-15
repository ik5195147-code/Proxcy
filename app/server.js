'use strict';
// Supervisor + dashboard for the Telegram MTProxy binary.
// No npm dependencies (Node 18+ built-ins only).

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dns = require('dns').promises;
const crypto = require('crypto');
const { spawn } = require('child_process');

const env = process.env;
const HTTP_PORT = Number(env.PORT) || 8080;          // dashboard (Railway sets PORT)
const PROXY_PORT = Number(env.PROXY_PORT) || 8443;   // MTProxy client port
const STATS_PORT = 8888;                             // MTProxy local stats (loopback only)
const WORKERS = String(Number(env.WORKERS) || 1);
const DATA_DIR = env.DATA_DIR || '/tmp/mtproxy';
const SEED_DIR = '/opt/mtproxy-seed';
const BIN = env.MTPROTO_BIN || '/usr/local/bin/mtproto-proxy';
const ON_RAILWAY = Boolean(env.RAILWAY_ENVIRONMENT_ID);
const log = (...a) => console.log('[mtproxy]', ...a);

if (PROXY_PORT === HTTP_PORT) {
  console.error('PROXY_PORT must be different from PORT');
  process.exit(1);
}

// ---- secret ---------------------------------------------------------------
function resolveSecrets() {
  const given = (env.SECRET || '').split(',').map(s => s.trim().toLowerCase().replace(/^dd(?=[0-9a-f]{32}$)/, '')).filter(Boolean);
  if (given.length) {
    for (const s of given) {
      if (!/^[0-9a-f]{32}$/.test(s)) throw new Error('SECRET must be 32 hex characters, e.g. the output of: openssl rand -hex 16');
    }
    return { list: given, source: 'env' };
  }
  // Stable fallback so links survive redeploys when SECRET is not set.
  const seed = [env.RAILWAY_PROJECT_ID, env.RAILWAY_SERVICE_ID].filter(Boolean).join(':');
  if (seed) return { list: [crypto.createHash('sha256').update('mtproxy:' + seed).digest('hex').slice(0, 32)], source: 'derived' };
  return { list: [crypto.randomBytes(16).toString('hex')], source: 'random' };
}
let secrets;
try { secrets = resolveSecrets(); } catch (e) { console.error(e.message); process.exit(1); }
if (secrets.source !== 'env') log(`SECRET not set (${secrets.source} secret in use). Set a SECRET variable so your links never change.`);

// ---- Telegram config files ---------------------------------------------------
const FILES = [
  { name: 'proxy-secret', url: 'https://core.telegram.org/getProxySecret', valid: b => b.length >= 32 },
  { name: 'proxy-multi.conf', url: 'https://core.telegram.org/getProxyConfig', valid: b => b.includes('proxy_for') },
];

async function refreshConfig() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o755 });
  for (const f of FILES) {
    const dest = path.join(DATA_DIR, f.name);
    try {
      const r = await fetch(f.url, { signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      if (!f.valid(buf)) throw new Error('unexpected content');
      fs.writeFileSync(dest, buf, { mode: 0o644 });
    } catch (e) {
      log(`could not download ${f.name}: ${e.message}`);
      if (fs.existsSync(dest)) continue; // keep the previous copy
      const seed = path.join(SEED_DIR, f.name);
      if (!fs.existsSync(seed) || fs.statSync(seed).size === 0) throw new Error(`no ${f.name} available`);
      fs.copyFileSync(seed, dest);
      fs.chmodSync(dest, 0o644);
      log(`using bundled ${f.name}`);
    }
  }
}

// Behind NAT (Docker/Railway) the proxy must know its public IPv4.
let publicIp = null;
async function natInfo() {
  if (env.NAT_INFO === 'off') return null;
  if (env.NAT_INFO) return env.NAT_INFO;
  const internal = Object.values(os.networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal)?.address;
  for (const url of ['https://api.ipify.org', 'https://ifconfig.me/ip', 'https://icanhazip.com']) {
    try {
      const t = (await (await fetch(url, { signal: AbortSignal.timeout(5000) })).text()).trim();
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(t)) { publicIp = t; break; }
    } catch { /* try next */ }
  }
  return internal && publicIp && internal !== publicIp ? `${internal}:${publicIp}` : null;
}

// ---- supervisor ---------------------------------------------------------------
const state = { status: 'starting', restarts: 0, startedAt: null, lastExit: null, error: null };
let child = null;
let stopping = false;
let backoff = 1000;
let retryTimer = null;

function scheduleRestart() {
  if (stopping || retryTimer) return;
  state.status = 'restarting';
  retryTimer = setTimeout(() => { retryTimer = null; launch(); }, backoff);
  backoff = Math.min(backoff * 2, 30000);
}

async function launch() {
  if (stopping) return;
  try {
    await refreshConfig();
    const nat = await natInfo();
    const args = ['-u', 'nobody', '-p', String(STATS_PORT), '-H', String(PROXY_PORT)];
    for (const s of secrets.list) args.push('-S', s);
    if (/^[0-9a-f]{32}$/i.test(env.PROXY_TAG || '')) args.push('-P', env.PROXY_TAG);
    if (nat) args.push('--nat-info', nat);
    args.push('--aes-pwd', path.join(DATA_DIR, 'proxy-secret'), path.join(DATA_DIR, 'proxy-multi.conf'), '-M', WORKERS);
    log('starting mtproto-proxy', nat ? `(nat-info ${nat})` : '');
    const p = spawn(BIN, args, { stdio: ['ignore', 'inherit', 'inherit'] });
    child = p;
    state.status = 'running';
    state.startedAt = Date.now();
    state.error = null;
    const resetBackoff = setTimeout(() => { backoff = 1000; }, 60000);
    resetBackoff.unref();
    p.on('error', e => { state.error = e.message; log('spawn error:', e.message); child = null; scheduleRestart(); });
    p.on('exit', (code, sig) => {
      clearTimeout(resetBackoff);
      if (child === p) child = null;
      state.lastExit = sig || code;
      state.restarts += 1;
      state.startedAt = null;
      log('mtproto-proxy exited:', state.lastExit);
      scheduleRestart();
    });
  } catch (e) {
    state.error = e.message;
    log('start failed:', e.message);
    scheduleRestart();
  }
}

// Telegram recommends refreshing its config daily: restart picks up fresh files.
setInterval(() => { if (child) { log('daily config refresh'); child.kill('SIGTERM'); } }, 24 * 3600 * 1000).unref();

// ---- stats + info ---------------------------------------------------------------
function fetchStats() {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port: STATS_PORT, path: '/stats', timeout: 2000 }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; });
      res.on('end', () => {
        const out = {};
        for (const line of body.split('\n')) {
          const [k, ...v] = line.split('\t');
          if (k && v.length) out[k.trim()] = v.join('\t').trim();
        }
        resolve(out);
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

const ipCache = { host: null, ip: null, at: 0 };
async function lookupIp(host) {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host;
  if (ipCache.host === host && Date.now() - ipCache.at < 60000) return ipCache.ip;
  let ip = null;
  try { ip = (await dns.lookup(host, { family: 4 })).address; } catch { /* ignore */ }
  Object.assign(ipCache, { host, ip, at: Date.now() });
  return ip;
}

async function buildInfo(req) {
  const reqHost = (req.headers.host || '').replace(/:\d+$/, '');
  const host = env.PUBLIC_HOST || env.RAILWAY_TCP_PROXY_DOMAIN || (ON_RAILWAY ? null : reqHost);
  const port = Number(env.PUBLIC_PORT || env.RAILWAY_TCP_PROXY_PORT) || PROXY_PORT;
  const raw = child ? await fetchStats() : null;
  const num = k => (raw && raw[k] !== undefined ? Number(raw[k]) : null);

  let status = state.status;
  if (child && raw) status = num('total_ready_targets') > 0 ? 'connected' : 'connecting';
  else if (child) status = 'starting';
  if (state.error && !child) status = 'error';

  const links = host
    ? secrets.list.map(s => {
        const q = `server=${encodeURIComponent(host)}&port=${port}&secret=dd${s}`;
        return { secret: 'dd' + s, web: `https://t.me/proxy?${q}`, tg: `tg://proxy?${q}` };
      })
    : [];

  return {
    status,
    error: state.error,
    needsTcpProxy: !host,
    onRailway: ON_RAILWAY,
    proxyPort: PROXY_PORT,
    server: host,
    ip: host ? await lookupIp(host) : null,
    port,
    secretSource: secrets.source,
    links,
    stats: {
      uptime: state.startedAt ? Math.floor((Date.now() - state.startedAt) / 1000) : null,
      clients: num('total_special_connections'),
      telegramLinks: num('total_ready_targets'),
      restarts: state.restarts,
    },
  };
}

// ---- HTTP server ----------------------------------------------------------------
const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));

function authorized(req) {
  if (!env.DASHBOARD_PASSWORD) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const pass = Buffer.from(h.slice(6), 'base64').toString().split(':').slice(1).join(':');
  const hash = s => crypto.createHash('sha256').update(s).digest();
  return crypto.timingSafeEqual(hash(pass), hash(env.DASHBOARD_PASSWORD));
}

function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/healthz') return send(res, 200, 'ok', 'text/plain');
  if (!authorized(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="MTProxy dashboard"' });
    return res.end('Authentication required');
  }
  try {
    if (pathname === '/api/info') return send(res, 200, JSON.stringify(await buildInfo(req)), 'application/json');
    if (pathname === '/' || pathname === '/index.html') return send(res, 200, INDEX_HTML, 'text/html; charset=utf-8');
    return send(res, 404, 'not found', 'text/plain');
  } catch (e) {
    return send(res, 500, 'error', 'text/plain');
  }
});

server.listen(HTTP_PORT, '0.0.0.0', () => {
  log(`dashboard on :${HTTP_PORT}, proxy port :${PROXY_PORT}`);
  launch();
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    stopping = true;
    if (child) child.kill('SIGTERM');
    server.close();
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
