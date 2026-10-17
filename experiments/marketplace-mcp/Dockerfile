# marketplace-mcp on Manufact. No Chromium in the image: hosted runs use TinyFish for eBay/Amazon/generic
# marketplaces and a Browserbase session (BROWSER=browserbase) for the Grailed key refresh and item pages.
FROM node:22-slim
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 HOST=0.0.0.0
WORKDIR /app
COPY package.json package-lock.json tsconfig.json mcp-env.d.ts index.ts ./
COPY src ./src
COPY views ./views
COPY public ./public
RUN npm ci --ignore-scripts && npm rebuild sharp && npx mcp-use build
EXPOSE 3000
CMD ["npx", "mcp-use", "start"]
