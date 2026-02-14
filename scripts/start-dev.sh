#!/bin/bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env.development.local"
DB_PORT=3307

if [ -f "$ENV_FILE" ]; then
    PORT_LINE="$(grep -E '^DB_PORT=' "$ENV_FILE" | tail -n 1 || true)"
    if [ -n "$PORT_LINE" ]; then
        RAW_PORT="${PORT_LINE#DB_PORT=}"
        RAW_PORT="${RAW_PORT%%#*}"
        RAW_PORT="$(echo "$RAW_PORT" | tr -d '[:space:]')"
        if [ -n "$RAW_PORT" ]; then
            DB_PORT="$RAW_PORT"
        fi
    fi
fi

# 1️⃣ Open Docker Desktop (if it’s not running)
open -a Docker

# 2️⃣ Wait until Docker engine is ready
echo "Waiting for Docker to start..."
while ! docker info >/dev/null 2>&1; do
    sleep 2
done
echo "Docker is ready ✅"

# 3️⃣ Start MySQL container (creates it if needed)
if [ "$(docker ps -q --filter name=tppc-mysql)" = "" ]; then
    if [ "$(docker ps -aq --filter name=tppc-mysql)" = "" ]; then
        echo "Creating MySQL container..."
        docker run -d \
            --name tppc-mysql \
            -e MYSQL_ROOT_PASSWORD=botpw \
            -e MYSQL_USER=bot \
            -e MYSQL_PASSWORD=botpw \
            -e MYSQL_DATABASE=tppc \
            -p "$DB_PORT":3306 \
            mysql:8
    else
        MAPPED_PORT="$(docker port tppc-mysql 3306/tcp 2>/dev/null | head -n 1 | awk -F: '{print $NF}')"
        if [ -n "$MAPPED_PORT" ] && [ "$MAPPED_PORT" != "$DB_PORT" ]; then
            echo "MySQL container port mismatch: container is on $MAPPED_PORT but DB_PORT is $DB_PORT."
            echo "Either set DB_PORT=$MAPPED_PORT in .env.development.local, or recreate tppc-mysql with host port $DB_PORT."
            exit 1
        fi
        echo "Starting MySQL container..."
        docker start tppc-mysql
    fi
else
    MAPPED_PORT="$(docker port tppc-mysql 3306/tcp 2>/dev/null | head -n 1 | awk -F: '{print $NF}')"
    if [ -n "$MAPPED_PORT" ] && [ "$MAPPED_PORT" != "$DB_PORT" ]; then
        echo "MySQL container already running, but host port is $MAPPED_PORT and DB_PORT is $DB_PORT."
        echo "Update DB_PORT to $MAPPED_PORT or recreate tppc-mysql to use $DB_PORT."
        exit 1
    fi
    echo "MySQL container already running ✅ (port $DB_PORT)"
fi

# 4️⃣ Start the bot
cd "$REPO_ROOT"
DOTENV_CONFIG_PATH=.env.development.local npm run start:dev
