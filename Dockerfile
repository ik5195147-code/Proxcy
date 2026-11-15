# ---- build the MTProxy C binary --------------------------------------------
FROM debian:bookworm-slim AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential libssl-dev zlib1g-dev ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY Makefile ./
COPY common common
COPY crypto crypto
COPY engine engine
COPY jobs jobs
COPY mtproto mtproto
COPY net net
COPY vv vv
RUN make -j"$(nproc)" && strip objs/bin/mtproto-proxy
# Bundled fallback copies of Telegram's config (refreshed at runtime too)
RUN mkdir -p /seed \
 && (curl -fsS https://core.telegram.org/getProxySecret -o /seed/proxy-secret; \
     curl -fsS https://core.telegram.org/getProxyConfig -o /seed/proxy-multi.conf) || true

# ---- runtime: proxy + dashboard ----------------------------------------------
FROM node:24-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends libssl3 zlib1g ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/objs/bin/mtproto-proxy /usr/local/bin/mtproto-proxy
COPY --from=build /seed /opt/mtproxy-seed
WORKDIR /app
COPY app/ ./
ENV NODE_ENV=production PROXY_PORT=8443 WORKERS=1
EXPOSE 8080 8443
CMD ["node", "server.js"]
