FROM node:24-bookworm-slim AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false
WORKDIR /app

ARG NPM_REGISTRY=https://registry.npmjs.org
ARG NPM_FALLBACK_REGISTRY=https://registry.npmmirror.com
COPY deployment/install-with-registry-fallback.sh /usr/local/bin/install-with-registry-fallback.sh
RUN --mount=type=cache,id=proctor-client-npm,target=/root/.npm,sharing=locked \
    sh /usr/local/bin/install-with-registry-fallback.sh npm install -g pnpm@11.16.0 --no-audit --no-fund

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/client-web/package.json apps/client-web/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/desktop/package.json apps/desktop/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY hydro-plugin/cwnupaa-proctor-auth/package.json hydro-plugin/cwnupaa-proctor-auth/package.json

RUN --mount=type=cache,id=proctor-client-pnpm,target=/pnpm/store,sharing=locked \
    PNPM_MAX_WORKERS=1 NODE_OPTIONS="--max-old-space-size=512" \
    sh /usr/local/bin/install-with-registry-fallback.sh pnpm install --frozen-lockfile \
      --store-dir=/pnpm/store --package-import-method=copy --prefer-offline \
      --child-concurrency=1 --network-concurrency=4 --filter @cwnupaa/proctor-client-web...

COPY packages/shared packages/shared
COPY apps/client-web apps/client-web

ARG NEXT_PUBLIC_PROCTOR_API_BASE
ENV NEXT_PUBLIC_PROCTOR_API_BASE=$NEXT_PUBLIC_PROCTOR_API_BASE
ARG NEXT_PUBLIC_PROCTOR_CONTEST_MOCK=0
ENV NEXT_PUBLIC_PROCTOR_CONTEST_MOCK=$NEXT_PUBLIC_PROCTOR_CONTEST_MOCK
ENV NODE_ENV=production

RUN NODE_OPTIONS="--max-old-space-size=1024" pnpm --filter @cwnupaa/proctor-client-web exec next build --webpack

EXPOSE 4032

CMD ["pnpm", "--filter", "@cwnupaa/proctor-client-web", "start"]
