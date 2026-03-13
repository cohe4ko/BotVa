# Use Node.js 18+ as specified in package.json engines
FROM node:18-alpine AS base

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production && npm cache clean --force

# Development stage for building
FROM node:18-alpine AS build

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install all dependencies (including dev dependencies for building)
RUN npm ci

# Copy source code
COPY src/ ./src/

# Build the TypeScript code
RUN npm run build

# Production stage
FROM base AS production

# Copy built application from build stage
COPY --from=build /app/build ./build

# Copy any other necessary files (like docs if needed at runtime)
COPY docs/ ./docs/

# Create a non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Change ownership of the app directory to nodejs user
RUN chown -R nodejs:nodejs /app
USER nodejs

# Expose port (though MCP typically uses stdio, this could be useful for health checks)
EXPOSE 3000

# Set environment variables
ENV NODE_ENV=production

# Health check (optional - checks if the process is running)
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node build/index.js --version || exit 1

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Default command to run the MCP server
CMD ["node", "build/index.js"]
