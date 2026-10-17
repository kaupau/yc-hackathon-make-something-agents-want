# marketplace-mcp on Manufact. No Chromium in the image: hosted runs use TinyFish for eBay/Amazon/generic
# marketplaces and a Browserbase session (BROWSER=browserbase) for the Grailed key refresh and item pages.
FROM node:22-slim
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 NODE_ENV=production HOST=0.0.0.0
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --omit=dev --ignore-scripts && npm rebuild sharp
COPY src ./src
EXPOSE 3000
CMD ["npm", "start"]
