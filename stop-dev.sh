#!/bin/bash

# 1️⃣ Stop the dev bot process
if pgrep -f 'node bot.js' > /dev/null; then
    pkill -f 'node bot.js'
    echo "Dev bot process stopped ✅"
else
    echo "Dev bot process was not running ⚠️"
fi

# 2️⃣ Stop the MySQL Docker container only if it exists
if command -v docker >/dev/null 2>&1; then
    if [ "$(docker ps -q -f name=tppc-mysql)" ]; then
        docker stop tppc-mysql
        echo "MySQL container 'tppc-mysql' stopped ✅"
    else
        echo "MySQL container 'tppc-mysql' was not running ⚠️"
    fi

    # 3️⃣ Quit Docker Desktop gracefully
    if pgrep -f 'Docker' >/dev/null 2>&1; then
        osascript -e 'quit app "Docker"'
        echo "Docker Desktop closing... ✅"

        # Optional: force quit if it hangs after 5 seconds
        sleep 5
        if pgrep -f 'Docker' >/dev/null 2>&1; then
            pkill -f 'Docker'
            echo "Docker Desktop forcibly quit ⚠️"
        fi
    else
        echo "Docker Desktop is not running, skipping quit ⚠️"
    fi
else
    echo "Docker CLI not found, skipping Docker stop/quit ⚠️"
fi
