FROM node:24-bookworm-slim AS dependencies

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false
WORKDIR /app

ARG DEBIAN_MIRROR=https://mirrors.tuna.tsinghua.edu.cn/debian
ARG DEBIAN_SECURITY_MIRROR=https://mirrors.tuna.tsinghua.edu.cn/debian-security

RUN mkdir -p /etc/ssl/certs \
    && node -e "require('fs').writeFileSync('/etc/ssl/certs/ca-certificates.crt', require('tls').rootCertificates.join('\n') + '\n')" \
    && sed -i -E \
        -e "s|https?://deb\.debian\.org/debian-security/?|${DEBIAN_SECURITY_MIRROR%/}|g" \
        -e "s|https?://security\.debian\.org/debian-security/?|${DEBIAN_SECURITY_MIRROR%/}|g" \
        -e "s#https?://deb\.debian\.org/debian/?([[:space:]]|$)#${DEBIAN_MIRROR%/}\1#g" \
        /etc/apt/sources.list.d/debian.sources \
    && printf '%s\n' \
        'Acquire::Retries "3";' \
        'Acquire::http::Timeout "30";' \
        'Acquire::https::Timeout "30";' \
        'Acquire::http::Pipeline-Depth "0";' \
        > /etc/apt/apt.conf.d/99proctor-downloads \
    && apt-get -o APT::Update::Error-Mode=any update -y \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends openssl ca-certificates chromium chromium-sandbox fonts-noto-cjk ffmpeg \
    && rm -rf /var/lib/apt/lists/*
ARG NPM_REGISTRY=https://registry.npmjs.org
ARG NPM_FALLBACK_REGISTRY=https://registry.npmmirror.com
COPY deployment/install-with-registry-fallback.sh /usr/local/bin/install-with-registry-fallback.sh
RUN --mount=type=cache,id=proctor-web-npm,target=/root/.npm,sharing=locked \
    sh /usr/local/bin/install-with-registry-fallback.sh npm install -g pnpm@11.16.0 --no-audit --no-fund
RUN pnpm config set verify-deps-before-run false

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY apps/client-web/package.json apps/client-web/package.json
COPY apps/desktop/package.json apps/desktop/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY hydro-plugin/cwnupaa-proctor-auth/package.json hydro-plugin/cwnupaa-proctor-auth/package.json

RUN --mount=type=cache,id=proctor-web-pnpm,target=/pnpm/store,sharing=locked \
    --mount=type=cache,id=proctor-web-prisma,target=/root/.cache/prisma,sharing=locked \
    PNPM_MAX_WORKERS=1 NODE_OPTIONS="--max-old-space-size=512" \
    sh /usr/local/bin/install-with-registry-fallback.sh pnpm install --frozen-lockfile \
      --store-dir=/pnpm/store --package-import-method=copy --prefer-offline \
      --child-concurrency=1 --network-concurrency=4 --filter @cwnupaa/proctor-web...

FROM dependencies AS base

COPY packages/shared packages/shared
# The web language regression test imports this plugin helper during type checking.
COPY hydro-plugin/cwnupaa-proctor-auth/judge-language.ts hydro-plugin/cwnupaa-proctor-auth/judge-language.ts
COPY hydro-plugin/cwnupaa-proctor-auth/judge-language-list.ts hydro-plugin/cwnupaa-proctor-auth/judge-language-list.ts
COPY hydro-plugin/cwnupaa-proctor-auth/problem-score.ts hydro-plugin/cwnupaa-proctor-auth/problem-score.ts
COPY apps/web apps/web
# NovaJudge regression checks share the desktop's request policy.
COPY apps/desktop/src/main/novajudge-policy.ts apps/desktop/src/main/novajudge-policy.ts

ARG NEXT_PUBLIC_MEDIA_HLS_BASE
ARG PROCTOR_CLIENT_WEB_INTERNAL_BASE=http://client-web:4032
ENV NEXT_PUBLIC_MEDIA_HLS_BASE=$NEXT_PUBLIC_MEDIA_HLS_BASE
ENV PROCTOR_CLIENT_WEB_INTERNAL_BASE=$PROCTOR_CLIENT_WEB_INTERNAL_BASE
ENV NODE_ENV=production
# Keep production builds bounded on hosts that also run MySQL and Hydro.
# Webpack avoids Turbopack's additional native-memory demand on small servers.
RUN --mount=type=cache,id=proctor-web-prisma,target=/root/.cache/prisma,sharing=locked \
    pnpm --filter @cwnupaa/proctor-web db:generate \
    && NODE_OPTIONS="--max-old-space-size=1024" pnpm --filter @cwnupaa/proctor-web exec next build --webpack

ENV CHROME_PATH=/usr/bin/chromium
ENV FFPROBE_PATH=/usr/bin/ffprobe
# Next.js caches/uploads and startup Prisma generation need write access.
# Avoid recursively changing ownership of the entire pnpm dependency tree.
RUN mkdir -p /app/apps/web/uploads \
    && chown -R node:node \
        /app/apps/web/uploads \
        /app/apps/web/.next \
        /app/node_modules/.pnpm/@prisma+client@*/node_modules/.prisma
USER node

EXPOSE 4031

CMD ["pnpm", "--filter", "@cwnupaa/proctor-web", "start"]
