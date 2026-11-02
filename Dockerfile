# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim

# Set environment
ENV NODE_ENV=production
ENV PORT=24681

# Working directory
WORKDIR /app

# Install native dependencies required for audio/networking builds
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy package manifests first for efficient Docker layer caching
COPY package*.json ./

# Install production dependencies
RUN npm install --omit=dev

# Copy application source code
COPY . .

# Ensure data directory exists for persistent SQLite database & accounts
RUN mkdir -p /app/data

# Expose web server port
EXPOSE 24681

# Start server
CMD ["node", "--max-old-space-size=450", "--unhandled-rejections=warn", "server.js"]
