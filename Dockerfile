FROM node:22-alpine

WORKDIR /app

# Install wget for healthcheck
RUN apk add --no-cache wget

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source
COPY . .

# Build
RUN npm run build

# Copy static files to standalone (REQUIRED for standalone output!)
# See: https://nextjs.org/docs/app/api-reference/config/next-config-js/output#automatically-copying-traced-files
RUN cp -r .next/static .next/standalone/.next/static
RUN cp -r public .next/standalone/public

# Create non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs && \
    chown -R nextjs:nodejs /app

USER nextjs

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=5 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/api/health || exit 1

CMD ["node", ".next/standalone/server.js"]
