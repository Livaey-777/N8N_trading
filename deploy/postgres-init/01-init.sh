#!/bin/sh
# Runs once, on the first start of an empty PostgreSQL volume (docker-entrypoint-initdb.d).
# Creates n8n's database and loads the gold-intelligence schema, sources and history seeds.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-SQL
	CREATE DATABASE "${N8N_DB_DATABASE:-n8n}" OWNER "$POSTGRES_USER";
SQL

for f in /gi/sql/*.sql; do
  echo "gold_intel: applying $(basename "$f")"
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -f "$f"
done

for f in /gi/seed/historical_event_reactions.sql /gi/seed/market_history.sql; do
  if [ -f "$f" ]; then
    echo "gold_intel: loading $(basename "$f")"
    psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -f "$f"
  fi
done
