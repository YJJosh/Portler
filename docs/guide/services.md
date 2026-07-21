# Services & environment

Every entry under `services:` in `portler.yml` is one service — a local process (with a `command`) or a Docker container (with an `image` or `build`).

```yaml
services:
  backend:
    command: npm run dev   # how to start it
    cwd: backend           # working directory, relative to the project root
    port: 4000             # preferred port (Portler may assign another one)
    port_env: PORT         # env variable(s) that receive the assigned port
    env:
      DATABASE_URL: postgres://app:app@localhost:${postgres.port}/app
      CORS_ALLOWED_ORIGIN: frontend.url
```

The full list of per-service options is in the [portler.yml reference](/reference/configuration#service-options).

## Service references

Environment values can refer to other services. Two forms are supported:

- **Bare references** — the whole value is `service.property`:

  ```yaml
  env:
    VITE_API_URL: backend.url
  ```

- **Interpolations** — `${service.property}` inside a longer string:

  ```yaml
  env:
    DATABASE_URL: postgres://app:app@localhost:${postgres.port}/app
  ```

Available properties:

| Property | Resolves to |
| --- | --- |
| `url` | Full URL, e.g. `http://localhost:51235` |
| `port` | Assigned host port |
| `host` | Bind host (default `127.0.0.1`) |
| `url_host` | Host used in URLs (default `localhost`) |
| `protocol` | URL protocol (default `http`) |
| `desired_port` | The `port:` declared in portler.yml (empty when none) |
| `container` | Docker container name (empty for local services) |
| `image` | Docker image name (empty for local services) |
| `name` | The service name itself |

When a [proxy block](/guide/proxy) exists, `proxy` can be referenced like a service: `proxy.url`, `proxy.port`.

::: tip Typos don't leak through
A bare dotted value like `example.com` stays literal, but if either half looks like a reference (`backnd.port`, `backend.prot`), Portler raises an error with a did-you-mean suggestion instead of silently passing the typo to your app.
:::

References only resolve for services that declare a `port` — a service without one has no assignment to point at.

## Environment layering

Each service's final environment is composed from (lowest to highest precedence):

1. **Your shell's environment** — everything Portler itself was started with.
2. **`.env` files** listed in the top-level `use_env:` (loaded in order, later files win).
3. **Top-level `env:`** from portler.yml (shared across all services).
4. **Generated `PORTLER_*` variables** — ports, URLs, and Docker metadata for every service ([full list](/reference/environment)).
5. **The service's own `env:`** — the final word.

On top of that, `port_env` keys are set to the service's port. Local services receive the **assigned host port**; Docker services receive their declared **container port** (the Docker port mapping translates between the two).

Inspect the result at any time:

```bash
portler env backend
```

## .env files

```yaml
use_env: .env            # one file...
# use_env: [.env, .env.local]   # ...or several, later files win
```

Paths are relative to the project root. A listed file that does not exist is an error — remove it from `use_env` or create it. `env_file` is accepted as an alias for `use_env`.

Values from `.env` files are visible to **all** services and can be overridden per service.

## Env value forms

`env:` accepts a YAML mapping or the Docker-Compose list form:

```yaml
env:
  KEY: value

# equivalent:
env:
  - KEY=value
```

`environment:` is accepted as an alias for `env:`. Numbers and booleans are stringified; keys must look like environment variable names (`[A-Za-z_][A-Za-z0-9_]*`).

## Selecting services

Most commands take service names to act on a subset:

```bash
portler up backend        # backend plus everything it depends on
portler restart backend   # restart just backend (missing deps are started)
portler logs backend
```

When you select services for `up`, their dependencies are included automatically and started in [dependency order](/guide/dependencies).

::: warning Reserved names
`docker` and `k8s` cannot be used as service names — they select run modes on the command line (`portler up docker`). When a `proxy:` block exists, `proxy` is reserved too.
:::
