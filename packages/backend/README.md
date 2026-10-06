## Description

[Nest](https://github.com/nestjs/nest) payment system.

## Project setup

```bash
$ yarn
```

## Compile and run the project

```bash
# development
$ yarn run start

# watch mode
$ yarn run start:dev

# production mode
$ yarn run start:prod
```

## Scripts

Run `scrips/auth/generate-keys.js` to generate a JWT keys to use for local development and load-testing on local.

Run `scrips/auth/generate-token.js` to generate a JWT token using keys created from `scripts/auth/generate-keys.js`.

## Load Testing

### Simple Smoke Test

```
k6 run \
  -e TARGET_ENV=local \
  -e PROFILE=smoke \
  -e USER_ID=123e4567-e89b-12d3-a456-426614174000 \
  -e JWT_TOKEN=eyJhbG... \
  load-tests/payment.test.js
```

### Massive Staging Stress Test

```
k6 run \
  -e TARGET_ENV=local \
  -e PROFILE=smoke \
  -e USER_ID=123e4567-e89b-12d3-a456-426614174000 \
  -e JWT_TOKEN=eyJhbG... \
  load-tests/payment.test.js
```
