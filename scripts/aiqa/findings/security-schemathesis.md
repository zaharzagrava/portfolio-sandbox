# Security: Schemathesis (API fuzzing from the OpenAPI document)

Run 2026-10-25 07:34. Schemathesis reads the API description and sends generated requests (valid, edge and invalid) to every operation of the four areas, with a test API key of the demo seller, and checks the answers against the description (no 5xx, right status codes and content types, bodies match the schema, no access without a key, other users' objects not reachable).

## Raw result (end of the log)

```
    Expected: 2xx, 3xx, 401, 403, 404, 409, 429, 5xx

[400] Bad Request:

    `{"type":"https://errors.marketplace.invalid/validation_failed","title":"Bad Request","status":400,"detail":"The request is not valid.","instance":"/v1/batch","code":"validation_failed","requestId":"req_eea74f4f4465451cb153b9497aa4b981","traceId":"0b45c2338f306f7395523622e9db91e7","errors":[{"field":"operations.0.path","code":"matches"}]}`

Reproduce with:

    curl -X POST -H 'Idempotency-Key: [Filtered]' -H 'Authorization: [Filtered]' -H 'Content-Type: application/json' -d '{"operations": [{"method": "GET", "path": "0"}]}' http://localhost:8005/v1/batch

    st replay 28zkzs

______________________________ POST /v1/products _______________________________
1. Test Case ID: 44m3iy

- ST202 Schema-valid request rejected

    Valid data should have been accepted
    Expected: 2xx, 3xx, 401, 403, 404, 409, 429, 5xx

[400] Bad Request:

    `{"type":"https://errors.marketplace.invalid/validation_failed","title":"Validation failed","status":400,"detail":"The currency is not supported.","instance":"/v1/products","code":"validation_failed","requestId":"req_f73260c52be043a2bd24d9673207e313","traceId":"7e61678fbc5be6000c2fbd9c87ca366f","errors":[{"field":"price.currency","code":"unsupported"}]}`

Reproduce with:

    curl -X POST -H 'Idempotency-Key: [Filtered]' -H 'Authorization: [Filtered]' -H 'Content-Type: application/json' -d '{"brand": "0", "category": "0", "description": "", "price": {"amount": 1, "currency": "AAA"}, "stock": 0, "title": "0"}' http://localhost:8005/v1/products

    st replay 44m3iy

2. Test Case ID: SnnWtm

- ST202 Schema-valid request rejected

    Valid data should have been accepted
    Expected: 2xx, 3xx, 401, 403, 404, 409, 429, 5xx

[422] Unprocessable Content:

    `{"type":"https://errors.marketplace.invalid/idempotency_key_reused","title":"Idempotency key reused","status":422,"detail":"This Idempotency-Key was already used with a different request.","instance":"/v1/products","code":"idempotency_key_reused","requestId":"req_91a841372b4244ba949535a1a066e34d","traceId":"cff785667db8deff44fbd1edd6a527df"}`

Reproduce with:

    curl -X POST -H 'Authorization: [Filtered]' -H 'Idempotency-Key: [Filtered]' -H 'Content-Type: application/json' -d '{"brand": "0", "category": "0", "price": {"amount": 1, "currency": "AAA"}, "title": "0"}' http://localhost:8005/v1/products

    st replay SnnWtm

_____________________________ POST /v1/stock/bulk ______________________________
1. Test Case ID: xcCrQO

- ST202 Schema-valid request rejected

    Valid data should have been accepted
    Expected: 2xx, 3xx, 401, 403, 404, 409, 429, 5xx

[400] Bad Request:

    `{"type":"https://errors.marketplace.invalid/validation_failed","title":"Validation failed","status":400,"detail":"The request is not valid.","instance":"/v1/stock/bulk","code":"validation_failed","requestId":"req_562e4cdf0532427e9319e74842061cd9","traceId":"fdd87765bf22b2440ae59290a7db8a24","errors":[{"field":"items.0.delta","code":"custom"}]}`

Reproduce with:

    curl -X POST -H 'Idempotency-Key: [Filtered]' -H 'Authorization: [Filtered]' -H 'Content-Type: application/json' -d '{"items": [{"delta": 0, "operationId": "0", "productId": "e3e70682-c209-1cac-a29f-6fbed82c07cd"}]}' http://localhost:8005/v1/stock/bulk

    st replay xcCrQO

________________________________ Stateful tests ________________________________
1. Test Case ID: SNhp07

- ST202 Schema-valid request rejected

    Valid data should have been accepted
    Expected: 2xx, 3xx, 401, 403, 404, 409, 429, 5xx

[422] Unprocessable Content:

    `{"type":"https://errors.marketplace.invalid/idempotency_key_reused","title":"Idempotency key reused","status":422,"detail":"This Idempotency-Key was already used with a different request.","instance":"/v1/stock/bulk","code":"idempotency_key_reused","requestId":"req_a617335337804d0fa4cc80f90633715c","traceId":"b67b4694b44e1863c1e83787b8747b9b"}`

Reproduce with:

    curl -X GET -H 'Authorization: [Filtered]' http://localhost:8005/v1/products
    curl -X POST -H 'Authorization: [Filtered]' -H 'Idempotency-Key: [Filtered]' -H 'Marketplace-Version: 2026-01-15' -H 'Content-Type: application/json' -d '{"items": [{"delta": -11110.0, "operationId": "B\u0015\udb55\udc62\u008a\b \udb56\udf1a", "productId": "df961ded-cabf-54de-8200-d7cf6bbc51a8"}, {"productId": "b7df3ff1-52e0-2ed8-a023-114ffa585893", "operationId": "\u00cfX\u0004\u00b8", "delta": -69461082114091.0}, {"productId": "78f371c1-1a86-2966-be0c-c43368be74ea", "operationId": "\ud867\uddee\u00ed\u00a4.W\u00924r\u008f\u00bd\ud8b7\udfdf\ud8a3\uddbb", "delta": -7609.0}, {"productId": "22816e3d-1c52-1136-8f1d-88da844885d7", "delta": 9271.0, "operationId": "\u7773\n\uda45\udf45\u008d\u00b1g\u008f"}, {"productId": "80352100-1809-24f3-abc5-75991a5afd57", "delta": 598.0, "operationId": "\u00a2\fy\u0005\r\ud90b\ude57u"}, {"delta": -53757.0, "productId": "4b9c8b06-1d41-5038-8a9d-3e32da3303ee", "operationId": "y>\udaed\udc49"}, {"productId": "501e7a11-c484-3d0b-b4d0-a53cca1bb4b8", "operationId": "\u00ee", "delta": -492}, {"delta": -4370.0, "operationId": "\u00cf\u00ba\u00c9\u00bd", "productId": "9615631f-a0ed-2037-9a98-0ed3420b4dae"}, {"operationId": "\u00c9GC\u00a0", "productId": "624c3086-914c-269a-baf9-fb1fe651ba9c", "delta": -114354}, {"productId": "7dd4ee20-cb25-11ad-bd3e-05d6f25ec89c", "delta": 99130211820.0, "operationId": "\ud893\udd7d[\udaf9\udea7}\u0007{\u00a9,\ud878\udffb\u0087\uda10\udd8c,?\ud821\udce5\uda68\udc7c"}, {"operationId": "\u00a0", "productId": "6186a8af-bd8d-3613-af0d-ade64e6a7384", "delta": 109669}, {"operationId": ":#00o*", "productId": "4fd09ca9-03a9-5d2e-bb78-a604b87f62d1", "delta": -245937.0}, {"operationId": "S\u00ae\u00aa", "delta": 88305, "productId": "2ee5b57f-59f7-2026-9cce-1a76f87c2c06"}, {"productId": "03c06b57-bb1a-2b77-af62-df5d46da8b3e", "delta": 9007199254740991.0, "operationId": "/\ud8bb\udff4w"}, {"delta": -124688706663.0, "operationId": "}\u0014", "productId": "ed3459c1-5a1b-1e7b-ba5d-bbfd5c11f8b8"}, {"delta": -715.0, "operationId": "\u00bc", "productId": "3e8427fc-c2ea-3111-9274-f42b539c8167"}, {"operationId": "\u001aL\u00acU\u00d2\u0088\ud9af\uddc2\u001e\u000eX\u00c7\u00ce\u00a9\udaea\udf26\u00e0=\u00f4", "productId": "6183f553-052e-1b6a-88b4-8b3ff2300be0", "delta": 2211}, {"delta": -4272, "productId": "bf22e1ba-646a-37bc-94eb-745a27a3830f", "operationId": "6"}, {"productId": "a8d7dd71-c168-3252-b12c-78ca7701b0a5", "operationId": "F\u009d\u00ae\\\u001d", "delta": -354194.0}]}' http://localhost:8005/v1/stock/bulk

    st replay SNhp07

=================================== SUMMARY ====================================

API Operations:
  Selected: 11/20
  Tested: 11

Test Phases:
  ⏭  Examples
  ❌ Coverage
  ❌ Fuzzing
  ❌ Stateful

Failures:
  ❌ ST202 Schema-valid request rejected: 10
  ❌ ST103 Undocumented status code: 4

For more information, run `st explain <code>` for ST103, ST202.

_______________________________ Schema Coverage ________________________________

Operations            11/21     52.3%
Parameters            27/45     60.0%  (6 partial)
Keywords              85/148    57.4%  (44 partial)
Examples               2/2     100.0%
Responses             25/125    20.0%
Response Keywords    455/3014   15.0%

HTML report         ./schema-coverage.html

Test cases:
  11931 generated, 14 found 14 unique failures, 6 skipped

Seed: 98318320686876939692913914431704070036

============================ 14 failures in 240.03s ============================

```

---

## Verdicts after reading the code (by hand)

Read all 14 failures. NONE is a security hole: no 5xx errors (the server never crashed), no request without the key got through, no invalid body was accepted, no answer leaked a stack trace or an internal path, and 1,842 of 2,041 stateful scenarios passed. The 14 are all places where the written API description is looser than the real rules:

- `GET /v1/products`, `/v1/orders`, `/v1/products/{id}`: the description allows `expand=` with any text, but the server only accepts `expand=shop` (400 `invalid_expand`). LOW: document the allowed value as an enum.
- `GET` of orders, product, stock, bulk job: a bad `Marketplace-Version` header answers 400 `invalid_version`, which the description does not list among the possible answers. LOW (documentation).
- `PATCH /v1/products/{id}`: without `If-Match` the server answers 428, with a bad one 400; the description does not say the header is required. LOW (documentation).
- `POST /v1/products`: the price currency is a free string in the description, the server accepts only supported currencies (400 `unsupported`). Re-using an `Idempotency-Key` with a different body answers 422 `idempotency_key_reused`, not documented. LOW.
- `POST /v1/stock/bulk`: a `delta` of 0 is refused, not said in the description. `POST /v1/batch`: sub-request `path` must match a pattern, not said. LOW.

Limits of this run: (1) the API description only covers the public integration API (`/v1/products`, `/v1/stock`, `/v1/orders`, `/v1/batch`); the dashboard routes of the four areas (`/api/shops/{id}/products`, `/orders`, photos, shop setup) have NO OpenAPI description, so Schemathesis cannot reach them; the in-house fuzzer (`scripts/qa/fuzz-seller-api.mjs`) is what covers those. (2) "Stateful links: 0 covered": the description declares no links between operations, so the stateful phase only chained operations by path. (3) The `/v1` routes are served by the separate public-api application (port 8005), not by the monolith on 8000 (`GET /v1/openapi.json` answers 404 on 8000; the same document is at `GET /api/developers/openapi.json`). The script starts that app and stops it again. (4) The test key is sandbox (sk_test_) and was revoked at the end; the scan created sandbox products with random text in the demo shop.
