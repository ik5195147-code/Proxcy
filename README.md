# MTProxy + Dashboard (Docker / Railway)

Telegram's official [MTProxy](https://github.com/TelegramMessenger/MTProxy) (C source in this repo), packaged with:

- a multi-stage `Dockerfile` (builds the proxy, runs it under a small Node supervisor)
- a **web dashboard** with a one-click "connect in Telegram" button, server / IP / port / secret with copy buttons, and live status
- `railway.json`, `.env.example`, and a GitHub Action that test-builds the image

The upstream README is kept in [`docs/UPSTREAM_README.md`](docs/UPSTREAM_README.md).

## ⚠️ Read this before deploying to Railway

Railway's Acceptable Use Policy lists operating proxies or anonymization services as prohibited, and
Railway staff and users report workspaces being restricted for running proxies behind a TCP Proxy.
Deploying this on Railway may get your **whole workspace** restricted. Check
<https://railway.com/legal/acceptable-use> and, if unsure, ask Railway before deploying.
The same image runs on any Docker host (see below), which is the safer choice.

## Deploy on Railway

1. Push this folder to a GitHub repo.
2. Railway → **New Project → Deploy from GitHub repo** (it picks up `railway.json` and the `Dockerfile`).
3. **Variables**: add `SECRET` (run `openssl rand -hex 16`). Optional: `DASHBOARD_PASSWORD`, `PROXY_TAG`.
4. **Settings → Networking**:
   - *Generate Domain* → this is the dashboard URL.
   - *TCP Proxy* → application port `8443`. Railway gives you a host and port, exposed to the app as
     `RAILWAY_TCP_PROXY_DOMAIN` / `RAILWAY_TCP_PROXY_PORT`.
5. **Redeploy** once so those variables reach the container, then open the dashboard and press **Connect**.

## Deploy on any Docker host / VPS

```bash
docker build -t mtproxy .
docker run -d --name mtproxy --restart unless-stopped \
  -p 443:8443 -p 8080:8080 \
  -e SECRET=$(openssl rand -hex 16) \
  -e DASHBOARD_PASSWORD=change-me \
  mtproxy
```

Dashboard: `http://SERVER_IP:8080`. The image is `linux/amd64` only (the proxy is built with x86 flags);
on Apple Silicon add `--platform linux/amd64`.

## Variables

| Name | Default | Purpose |
|---|---|---|
| `SECRET` | auto | 32 hex chars. If unset, a stable value is derived from Railway IDs (or random elsewhere). Set it so links never change. |
| `DASHBOARD_PASSWORD` | – | If set, the dashboard asks for a password (any username). `/healthz` stays open. |
| `PROXY_TAG` | – | 32-hex tag from [@MTProxybot](https://t.me/MTProxybot). |
| `PROXY_PORT` | `8443` | Port MTProxy listens on inside the container. |
| `PUBLIC_HOST` / `PUBLIC_PORT` | auto | Override the address shown in links. |
| `WORKERS` | `1` | MTProxy worker processes. |
| `NAT_INFO` | auto | `internal:external` IPs, or `off`. Detected automatically behind NAT. |

`PORT` is set by Railway for the dashboard; keep it different from `PROXY_PORT`.

## How it works

`app/server.js` downloads Telegram's `proxy-secret` and `proxy-multi.conf`, starts `mtproto-proxy`, restarts it if it
dies, refreshes the Telegram config every 24 h, and serves the dashboard from `app/public/index.html`.
Links use the `dd` secret prefix (random padding). This snapshot of MTProxy does not support fake-TLS (`ee`) secrets.
The `Makefile` has one change from upstream: `-fcommon`, needed to build with modern GCC.

## বাংলায় সংক্ষেপে

1. এই ফোল্ডার GitHub-এ আপলোড করুন।
2. Railway-তে *Deploy from GitHub repo* দিন।
3. Variables-এ `SECRET` দিন (`openssl rand -hex 16`)।
4. Networking-এ *Generate Domain* (ড্যাশবোর্ডের জন্য) আর *TCP Proxy* (port `8443`) চালু করুন, তারপর Redeploy করুন।
5. ড্যাশবোর্ড খুলে **Telegram-এ কানেক্ট করুন** বাটনে চাপ দিন।

> Railway প্রক্সি চালানো নিষিদ্ধ করে, তাই ঝুঁকি আছে (উপরের সতর্কতা দেখুন)। নিরাপদ বিকল্প: যে কোনো Docker VPS।

## License

Upstream MTProxy is licensed under GPLv2 / LGPLv2 (see `GPLv2` and `LGPLv2`).
