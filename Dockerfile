FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=3000
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY index.html ./
COPY server ./server
VOLUME /data
EXPOSE 3000
USER node
CMD ["node", "server/src/index.js"]
