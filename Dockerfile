FROM node:24 AS build


WORKDIR /tmp/buildApp

COPY ./package*.json ./
COPY .husky/ .husky/

RUN npm install
COPY . .
RUN npm run build

FROM node:24.10.0-alpine3.22 AS production

RUN apk add dumb-init

ENV NODE_ENV=production


WORKDIR /usr/src/app

COPY --chown=node:node package*.json ./
COPY .husky/ .husky/

RUN npm ci --only=production

COPY --chown=node:node --from=build /tmp/buildApp/dist .
COPY --chown=node:node ./config ./config


# Outbound-only worker: nothing to expose.
USER node
CMD ["dumb-init", "node", "--import", "./instrumentation.mjs", "./index.js"]
