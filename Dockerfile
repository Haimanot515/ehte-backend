# ============================================
# Ehte Backend - Build Stage
# ============================================

FROM node:22-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy source code
COPY . .

# Generate Prisma Client
# This URL is only a build-time placeholder.
# It is NOT your real database connection.
RUN DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder" \
    npx prisma generate

# Build NestJS
RUN npm run build


# ============================================
# Ehte Backend - Production Stage
# ============================================

FROM node:22-alpine AS production

WORKDIR /app

ENV NODE_ENV=production

# Install production dependencies
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

# Copy compiled NestJS application
COPY --from=builder /app/dist ./dist

# Copy Prisma generated client
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma

# Prisma CLI
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder /app/node_modules/.bin/prisma ./node_modules/.bin/prisma

# Prisma schema and migrations
COPY --from=builder /app/prisma ./prisma

# Prisma configuration
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts

# Ehte API port
EXPOSE 3000

# Start Ehte
CMD ["node", "dist/src/main"]