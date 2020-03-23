#!/bin/sh

# Wipe all redis data in the default database. Start redis, then run this.

echo "redis must be running"
redis-cli FLUSHDB
