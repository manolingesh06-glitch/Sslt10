# SSLT10 Auction Platform

A Host-managed cricket auction platform built around Node.js, Express, Socket.IO and SQLite.

## Roles

- **Host** — creates/imports teams and players, configures the auction and controls the live auction.
- **Team Owner** — logs in with the team's credentials and can bid for that team only.
- **Analyst** — read-only live monitoring role when provisioned.

There is no Admin role in SSLT10.

## Setup flow

1. Host login
2. Create/import teams
3. Create/import players
4. Validate and confirm the data
5. Start the auction
6. Teams bid in real time
7. Host controls sold/unsold, timer and auction progression
8. Review/export results

## Data model

The application starts without a preloaded team or player pool. Teams and players are stored dynamically in SQLite. The legacy tournament database is removed during the SSLT10 migration.

## Security

Authentication is verified by the backend with bcrypt + JWT. Socket.IO connections require the issued JWT, and mutation events are authorized by role. Team owners cannot perform Host operations or bid on behalf of another team.

## Environment

Recommended variables:

- `SQLITE_PATH` — SQLite database path
- `JWT_SECRET` — optional; a random secret is generated and persisted when omitted
- `SSLT10_HOST_USERNAME` — default `host`
- `SSLT10_HOST_PASSWORD` — set a strong Host password in production
- `JWT_EXPIRES_IN` — default `12h`
- `BCRYPT_SALT_ROUNDS` — default `10`
- `PORT` — default `4000`

## Run

```bash
npm install
npm start
```

Health check: `/health`
