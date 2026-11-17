FROM node:24-alpine
WORKDIR /app
# tc (Traffic Control) — 앱 서버 → 캐시 구간에 네트워크 지연을 넣을 때 쓴다 (mini_redis/experiment/netem.js)
RUN apk add --no-cache iproute2
# 런타임 의존성이 없으므로 소스만 복사한다
# 저장소와 같은 폴더 구조로 복사한다 (실험 코드가 ../hashtable.js · ../../mini_DBMS/ 처럼 상대 경로로 불러온다)
COPY mini_redis/*.js ./mini_redis/
COPY mini_DBMS/*.js ./mini_DBMS/
COPY mini_redis/experiment/*.js ./mini_redis/experiment/
ENV NODE_ENV=production
