FROM node:20-alpine

WORKDIR /app

# Install better-sqlite3 build dependencies
RUN apk add --no-cache python3 make g++ sqlite-dev

# Copy package files and install
COPY package*.json ./
RUN npm install

# Copy application
COPY . .

# Create data directory for SQLite
RUN mkdir -p /app/data

# Expose port
EXPOSE 3000

# Start server
CMD ["node", "server.js"]
