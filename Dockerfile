FROM node:20-slim

WORKDIR /app

# Copy package files
COPY package.json package-lock.json* ./

# Install ALL dependencies (including dev for building)
RUN npm install

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Remove dev dependencies after build
RUN npm prune --production

# Set production mode
ENV NODE_ENV=production

# Expose port
EXPOSE 3002

# Start the service
CMD ["node", "dist/index.js"]
