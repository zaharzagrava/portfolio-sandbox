-- ScyllaDB locally (D24). On Amazon Keyspaces the keyspace is created by
-- Terraform (O-03) with SingleRegionStrategy; this file only runs locally.
-- RF=1 locally (single node); production uses RF=3 + LOCAL_QUORUM.
CREATE KEYSPACE IF NOT EXISTS marketplace
  WITH replication = {'class': 'NetworkTopologyStrategy', 'datacenter1': 1}
  AND tablets = {'enabled': false};

CREATE TABLE IF NOT EXISTS marketplace.schema_migrations (
  file text PRIMARY KEY,
  applied_at timestamp
);
