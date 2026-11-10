FROM node:24-alpine
WORKDIR /app
# tc (Traffic Control) — 앱 서버 → 캐시 구간에 네트워크 지연을 넣을 때 쓴다 (experiment/netem.js)
RUN apk add --no-cache iproute2
# 런타임 의존성이 없으므로 소스만 복사한다
COPY week2/redis ./week2/redis
COPY week2/dbms ./week2/dbms
COPY experiment/*.js ./experiment/
ENV NODE_ENV=production
