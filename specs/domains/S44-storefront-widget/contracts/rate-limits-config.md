# Contract: rate limits and configuration

## Rate-limit policies (declared in `developerPlatformRatePolicies`, registered by `WidgetModule`)

| Name | Limit | Key | Fail mode | Route |
|---|---|---|---|---|
| `widget.config.ip` | 600/min | client address | open (a public read must stay up) | `GET config` |
| `widget.identify.ip` | 30/min | client address | closed | `POST identify` |
| `widget.identify.site` | 1,200/min | publishable key | closed | `POST identify` |
| `widget.manage.shop` | 60/min | shop | closed | dashboard mutations |

A refusal is `429` problem+json with `Retry-After` and `RateLimit` headers. Widget traffic never spends `auth.login.ip`.

## Configuration keys (validated at boot)

| Key | Rule |
|---|---|
| `widget_token_key` | required, at least 32 bytes; startup fails without it; signs and verifies widget tokens only |
| `WIDGET_APP_BUNDLE_URL` | default `/widget/v1/app.js`; an absolute value must be HTTPS (owned by W07) |
| `WIDGET_CHECKOUT_URL` | the `checkoutUrl` of `config`; HTTPS; default `<front_host>/embed/checkout` |
