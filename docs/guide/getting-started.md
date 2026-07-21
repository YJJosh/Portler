# Getting started

## Install

Portler needs Node.js `>= 22.6`.

```bash
npm install -g portler
portler --help
```

Docker is only required if you use Docker services, and `kubectl` plus a local cluster only for [Kubernetes mode](/guide/kubernetes).

## Create a portler.yml

Run `portler init` in your project root to generate a starter config:

```bash
portler init
```

It writes this `portler.yml` (the same sample shown by `portler --help`):

```yaml
use_env: .env

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
      command: docker exec $PORTLER_POSTGRES_CONTAINER pg_isready -U app -d app

  backend:
    command: npm run dev
    cwd: backend
    port: 4000
    port_env: PORT
    depends_on:
      - postgres
    env:
      DATABASE_URL: postgres://app:app@localhost:${postgres.port}/app
      CORS_ALLOWED_ORIGIN: frontend.url

  frontend:
    command: npm run dev
    cwd: frontend
    port: 3000
    port_env: PORT
    depends_on:
      - backend
    env:
      VITE_API_URL: backend.url
```

Adapt it to your project: each entry under `services:` is one process (or container) with a `command` or an `image`, an optional preferred `port`, and its environment.

::: warning Env files must exist
The sample lists `use_env: .env`, and every file listed in `use_env` is required — `portler up` fails with an error when one is missing. Create it first (`touch .env`) or remove the `use_env` line if you don't need it.
:::

## Start the stack

```bash
portler up
```

Portler assigns a free port to every service, prints a table, and starts everything in dependency order:

```text
SERVICE    PORT    URL
postgres   51234   http://localhost:51234
backend    51235   http://localhost:51235
frontend   51236   http://localhost:51236
```

What happened here:

- **`postgres`** has an `image`, so it runs as a Docker container. Its container port `5432` is mapped to the assigned host port `51234`.
- **`backend`** received `PORT=51235` (via `port_env`) and `DATABASE_URL=postgres://app:app@localhost:51234/app` — the `${postgres.port}` reference resolved to the assigned port.
- **`frontend`** received `VITE_API_URL=http://localhost:51235` — `backend.url` resolved to the backend's full URL.
- Startup order respected `depends_on`: postgres passed its healthcheck before the backend started, and the backend answered on its port before the frontend started.

Press `Ctrl+C` to stop everything, or run in the background:

```bash
portler up -d       # detached
portler ps          # what's running?
portler logs backend --follow
portler down        # stop everything
```

## Everyday commands

| Command | What it does |
| --- | --- |
| `portler up [-d]` | Start all services (optionally detached) |
| `portler up backend` | Start one service (plus its dependencies) |
| `portler down` | Stop services started by Portler |
| `portler restart [service]` | Restart in the background, keeping ports when possible |
| `portler ps` | Show running services with pid, port, URL |
| `portler logs [service] [--follow]` | Show captured output of detached services |
| `portler ports` | Show assigned ports |
| `portler env <service>` | Print the resolved env for one service |
| `portler clean` | Remove `.portler/` runtime files and release ports |

See the [CLI reference](/reference/cli/) for every command and flag.

## Ignore the runtime directory

Portler writes runtime state to `.portler/` in your project. Add it to `.gitignore`:

```text
.portler/
```

See [Generated files](/reference/generated-files) for what lives there.

## Where to go next

- [Services & environment](/guide/services) — references like `backend.url`, `.env` loading, and the generated `PORTLER_*` variables.
- [Ports](/guide/ports) — how assignment works and how to steer it.
- [Docker services](/guide/docker) — images, builds, container ports, and Docker mode.
- [Proxy](/guide/proxy) — put the whole stack behind one URL.
