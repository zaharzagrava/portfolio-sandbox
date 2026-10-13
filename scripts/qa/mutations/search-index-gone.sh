# 2026-10-12: search answered 503 because the product index was missing or had a stale mapping (the S32 bootstrap and a legacy creator disagreed).
EXPECT='search|503|index|product'
apply()  { curl -s -X DELETE "localhost:9200/products_m1_init" >/dev/null; sleep 3; }
revert() { bash scripts/sdd/stack-fix.sh reindex >/dev/null 2>&1; }
