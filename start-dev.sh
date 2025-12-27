#!/bin/bash

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
            -p 3307:3306 \
            mysql:8
    else
        echo "Starting MySQL container..."
        docker start tppc-mysql
    fi
else
    echo "MySQL container already running ✅"
fi

# 4️⃣ Start the bot
cd ~/Desktop/tppc-faqbot
DOTENV_CONFIG_PATH=.env.development.local npm run start:dev
