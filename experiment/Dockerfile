FROM node:24-alpine
WORKDIR /app
# 런타임 의존성이 없으므로 소스만 복사한다
COPY week2/redis ./week2/redis
COPY week2/dbms ./week2/dbms
COPY experiment/*.js ./experiment/
ENV NODE_ENV=production
