#!/bin/bash
# chaya-engine restart script
# Usage: ./restart.sh

PORT=3002

echo "Stopping chaya-engine on port $PORT..."
lsof -ti:$PORT | xargs kill -9 2>/dev/null
sleep 1
echo "✅ Cleaned"

echo ""
echo "Starting chaya-engine..."
echo "========================"
go run ./cmd/server/
