# Lisa Ballay for Congress

Production campaign site for Louisiana's 2nd Congressional District.

Pushes to `main` deploy through GitHub Actions to `/opt/apps/lb26`. The container is exposed on host port `8098`; a public domain or reverse proxy can be added once the campaign domain is confirmed.

## Local stack

The public site and protected campaign admin are served by Node.js and backed by PostgreSQL.

1. Copy `.env.example` to `.env`.
2. Replace every placeholder with unique credentials. The admin password must be at least 14 characters.
3. Run `docker compose up --build`.
4. Open `http://localhost:8098` for the public site or `http://localhost:8098/admin` for campaign admin.

Database migrations run automatically at startup. The first startup creates the initial admin from `ADMIN_EMAIL` and `ADMIN_PASSWORD` only when no admin exists. Changing those variables later does not silently reset a password.

Production requires `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD` in `/opt/apps/lb26/.env` on the deployment host. Never commit that file.
