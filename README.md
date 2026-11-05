# Portler

Portler runs multi-service projects with automatic port assignment and environment resolution, on a dev machine, a CI runner, or a production host. It reads `portler.yml`, finds free ports, resolves references such as `backend.url`, and starts services in dependency order.

[Documentation](https://yjjosh.github.io/Portler/) · [Getting started](https://yjjosh.github.io/Portler/guide/getting-started) · [CLI reference](https://yjjosh.github.io/Portler/reference/cli/) · [Configuration reference](https://yjjosh.github.io/Portler/reference/configuration)

> **Note:** Portler is still evolving. The `portler.yml` format is being improved and can change in breaking ways in upcoming releases, so check the [release notes](https://github.com/YJJosh/Portler/releases) when you upgrade.

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
    use: postgres@18       # built-in preset: image, port, volume, healthcheck

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
      DATABASE_URL: ${postgres.database_url}

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

proxy:
  routes:
    /api: backend
    /: frontend
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
- `${postgres.database_url}` resolves to Postgres's assigned port, so `DATABASE_URL` always points at the right place. In `portler up docker` the same `DATABASE_URL` becomes `postgres:5432`, the address a container needs.
- Postgres runs in Docker. Its data lives in the managed volume `@postgres-data`, which survives restarts and can be forked for another checkout.
- `npm install` runs only while `node_modules` is missing.
- The backend starts once Postgres passes its healthcheck, and the frontend once the backend answers.
- The proxy serves the whole stack on one URL, printed as `project url`. `/api/users` goes to `backend` with the path unchanged, so the backend serves its routes under `/api`, and everything else goes to `frontend`. The browser only talks to one origin, so CORS stops being a problem, and WebSockets work too, so dev-server hot reload keeps working.

## Highlights

- **[Automatic ports](https://yjjosh.github.io/Portler/guide/ports)** — let multiple projects and checkouts run side by side.
- **[Service references](https://yjjosh.github.io/Portler/guide/services)** — keep URLs and environment variables in sync.
- **[Dependency and health checks](https://yjjosh.github.io/Portler/guide/dependencies)** — control startup order.
- **[Docker](https://yjjosh.github.io/Portler/guide/docker) and [local Kubernetes](https://yjjosh.github.io/Portler/guide/kubernetes)** — use the same configuration.
- **[Managed volumes](https://yjjosh.github.io/Portler/guide/volumes)** — make it easy to fork local data between checkouts.
- **[Database presets](https://yjjosh.github.io/Portler/guide/databases)** — `use: postgres@18`, `mysql@8.4` or `redis@8`, or a preset file of your own for any other database.
- **[Reverse proxy](https://yjjosh.github.io/Portler/guide/proxy)** — puts the stack behind one URL, so the browser only talks to one origin.
- **[Setup & production](https://yjjosh.github.io/Portler/guide/setup-and-production)** — install and build steps live next to the services and run once per checkout, while a path is missing, or every time; `portler start` runs one service on a platform without Docker.

Portler verifies resource ownership before stopping processes or removing managed resources.

## License

[MIT](LICENSE)
