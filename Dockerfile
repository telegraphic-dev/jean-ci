FROM node:22-alpine

# Install build dependencies for better-sqlite3
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

# Create data directory for SQLite
RUN mkdir -p /data

EXPOSE 3000

CMD ["node", "index.js"]
