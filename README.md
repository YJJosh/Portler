# Portler

Portler runs multi-service projects with automatic port assignment and environment resolution, on a dev machine, a CI runner, or a production host. It reads `portler.yml`, finds free ports, resolves references such as `backend.url`, and starts services in dependency order.

[Documentation](https://yjjosh.github.io/Portler/) · [Getting started](https://yjjosh.github.io/Portler/guide/getting-started) · [CLI reference](https://yjjosh.github.io/Portler/reference/cli/) · [Configuration reference](https://yjjosh.github.io/Portler/reference/configuration)

## Install

Portler requires Node.js 22.6 or newer.

```sh
npm install -g portler
portler --help
```

Portler supports **Linux and macOS**. On Windows, use **WSL2**; native Windows is intentionally unsupported because safe process teardown relies on POSIX process groups. Docker and Kubernetes tooling are only required when using those modes.

## Quick start

Generate a starter configuration and adapt it to your project:

```sh
portler init
```

A `portler.yml` for a web app with a database looks like this:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    port: 5432
    env:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: app
      POSTGRES_DB: app
    volumes:
      - '@postgres-data:/var/lib/postgresql/data'
    healthcheck:
      command: docker exec $PORTLER_POSTGRES_CONTAINER pg_isready -h 127.0.0.1 -U app -d app

  backend:
    command: npm run dev
    cwd: backend
    setup:
      - run: npm install
        if_missing: node_modules
    port: 4000
    port_env: PORT
    depends_on:
      - postgres
    env:
      DATABASE_URL: postgres://app:app@localhost:${postgres.port}/app

  frontend:
    command: npm run dev
    cwd: frontend
    setup:
      - run: npm install
        if_missing: node_modules
    port: 3000
    port_env: PORT
    depends_on:
      - backend
    env:
      VITE_API_URL: backend.url
```

Start and manage the stack:

```sh
portler up
portler up -d                    # run in the background
portler ps                       # show running services
portler logs backend --follow
portler down
```

On `portler up`:

- Every service gets a free host port, so this stack can run next to other projects and checkouts. Local processes receive it through `port_env`.
- `${postgres.port}` and `backend.url` resolve to those ports, so `DATABASE_URL` and `VITE_API_URL` always point at the right place.
- Postgres runs in Docker. Its data lives in the managed volume `@postgres-data`, which survives restarts and can be forked for another checkout.
- `npm install` runs only while `node_modules` is missing.
- The backend starts once Postgres passes its healthcheck, and the frontend once the backend answers.

## Highlights

- **[Automatic ports](https://yjjosh.github.io/Portler/guide/ports)** — let multiple projects and checkouts run side by side.
- **[Service references](https://yjjosh.github.io/Portler/guide/services)** — keep URLs and environment variables in sync.
- **[Dependency and health checks](https://yjjosh.github.io/Portler/guide/dependencies)** — control startup order.
- **[Docker](https://yjjosh.github.io/Portler/guide/docker) and [local Kubernetes](https://yjjosh.github.io/Portler/guide/kubernetes)** — use the same configuration.
- **[Managed volumes](https://yjjosh.github.io/Portler/guide/volumes)** — make it easy to fork local data between checkouts.
- **[Reverse proxy](https://yjjosh.github.io/Portler/guide/proxy)** — serves the stack through one local origin when enabled.
- **[Setup & production](https://yjjosh.github.io/Portler/guide/setup-and-production)** — install and build steps live next to the services and run once per checkout, while a path is missing, or every time; `portler start` runs one service on a platform without Docker.

Portler verifies resource ownership before stopping processes or removing managed resources.

## License

[MIT](LICENSE)
