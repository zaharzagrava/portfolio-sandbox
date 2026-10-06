# Postgres 18 + PostGIS (SD-13 proximity) + pgvector (SD-43 RAG).
# The official Debian-based image ships with the PGDG apt repo configured, so
# extensions come from the same build as the server. Both extensions are
# available on Amazon RDS for PostgreSQL, so local == prod (D20).
FROM postgres:18

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      postgresql-18-postgis-3 \
      postgresql-18-pgvector \
 && rm -rf /var/lib/apt/lists/*
