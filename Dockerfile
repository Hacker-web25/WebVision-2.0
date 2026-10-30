FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/app/data PORT=3000
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY index.html ./
COPY server ./server
# Create the data folder and hand it to the non-root user before dropping root, so SQLite
# can create its file. (A Docker VOLUME here would be owned by root and unwritable instead.)
RUN mkdir -p /app/data && chown -R node:node /app/data
EXPOSE 3000
USER node
CMD ["node", "server/src/index.js"]
