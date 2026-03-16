# ── Stage 1: install production dependencies ──────────────────
FROM node:20-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --omit=dev

# ── Stage 2: final image ──────────────────────────────────────
FROM node:20-alpine AS runner

# Create a non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Copy only the installed node_modules and source from previous stage
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src/ ./src/

USER appuser

EXPOSE 3000

ENV NODE_ENV=production

CMD ["node", "src/index.js"]
