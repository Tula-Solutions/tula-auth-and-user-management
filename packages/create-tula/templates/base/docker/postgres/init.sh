#!/bin/sh
# Runs once, when the database volume is first created. The API must not connect as the schema
# owner (owners bypass row-level security), so it gets a role of its own, with the password
# create-tula generated into .env. After changing this file or the password, the volume has to
# be recreated: `tula dev down --volumes`.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v api_password="$TULA_API_DB_PASSWORD" <<'SQL'
CREATE ROLE tula_app NOLOGIN;
CREATE ROLE tula_api LOGIN PASSWORD :'api_password' IN ROLE tula_app;
SQL
