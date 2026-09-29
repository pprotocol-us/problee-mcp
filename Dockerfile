FROM node:22-slim
WORKDIR /app
COPY package.json tsconfig.json tsup.config.ts ./
COPY src ./src
RUN npm install --no-audit --no-fund && npm run build && npm prune --omit=dev
# Without PROBLEE_API_KEY the bridge serves the public reads (markets, prices,
# charts, trades, leaderboard); set it to trade.
ENTRYPOINT ["node", "dist/cli.js", "serve"]
