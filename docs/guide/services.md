# Services & environment

Every entry under `services:` in `portler.yml` is one service — a local process (with a `command`) or a Docker container (with an `image` or `build`).

```yaml
services:
  backend:
    command: npm run dev   # how to start it
    cwd: backend           # working directory, relative to the project root
    port: 4000             # declared port; the assigned one usually differs (see Ports)
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
| `address` | `host:port` as the reader sees it; see [below](#one-address-for-every-mode) |
| `address_host` / `address_port` | The two halves of `address` |

When a [proxy block](/guide/proxy) exists, `proxy` can be referenced like a service: `proxy.url`, `proxy.port`.

`self` names the service itself, in its own env, setup steps, healthcheck and exports: `${self.port}`, `${self.container}`. A service can also publish named values of its own with [`exports`](#exports).

::: tip Typos don't leak through
A bare dotted value like `example.com` stays literal, but if either half looks like a reference (`backnd.port`, `backend.prot`), Portler raises an error with a did-you-mean suggestion instead of silently passing the typo to your app.
:::

References only resolve for services that declare a `port` — a service without one has no assignment to point at. `name` and exports are the exceptions.

### One address for every mode

`url`, `port` and `host` always describe the service from your machine. That is right for a browser, but a container cannot reach `localhost:51234`: it needs `postgres:5432`. `address` is the address as the **reader** sees it, so one value works everywhere:

```yaml
env:
  DATABASE_URL: postgres://app:app@${postgres.address}/app
```

| Who reads `${postgres.address}` | Gets |
| --- | --- |
| A local process (`portler up`) | `localhost:51234` (the assigned port) |
| A setup step, healthcheck command or `portler run`, in every mode | `localhost:51234`: they run on your machine |
| A container on the project network (`portler up docker`, or a Docker service in `up`) | `postgres:5432` (service name and declared `port`) |
| A pod in [Kubernetes mode](/guide/kubernetes) | `postgres:5432` (the Kubernetes Service) |
| A container reaching a local process | `host.docker.internal:51234` |

The last row works out of the box on Docker Desktop. On Linux, the local process must listen beyond `127.0.0.1` (`host: 0.0.0.0`) and the container needs a `host.docker.internal` entry. Usually both sides run in containers, or both locally, and neither matters.

So the copies of `DATABASE_URL` that `docker.env` and `k8s.env` used to need are not needed any more. Keep `url` for addresses a browser opens, such as `VITE_API_URL: backend.url`.

### Exports

A service can publish values built from its own properties and env, so the services that use it don't repeat its connection details:

```yaml
services:
  postgres:
    use: postgres          # the built-in preset already exports database_url
  api:
    env:
      DATABASE_URL: ${postgres.database_url}
```

Inside an export, `${env.KEY}` is the value the exporting service itself gets for `KEY` (config, shell or `.env`), and `${self.address}` is the address as the service that reads the export sees it. See [exports](/reference/configuration#exports) and [Databases & presets](/guide/databases).

## Environment layering

Each service's final environment is composed from (lowest to highest precedence):

1. **`default:` entries** from portler.yml: values used only when nothing above sets the key.
2. **Your shell's environment** — everything Portler itself was started with.
3. **`.env` files** listed in the top-level `use_env:` (loaded in order, later files win).
4. **Top-level `env:`** from portler.yml (shared across all services).
5. **The service's own `env:`** — the last word among your own values.
6. **Generated `PORTLER_*` variables** — ports, URLs, and Docker metadata for every service ([full list](/reference/environment)). These stay Portler's own: a service `env:` entry cannot replace them.

On top of that, `port_env` keys are set to the service's port. Local services receive the **assigned host port**; Docker services receive their declared **container port** (the Docker port mapping translates between the two).

**Production.** With `--prod` (and always in `portler start`) the deployment wins over `portler.yml`: the order becomes top-level `env:`, the service's `env:`, then `.env` files, then your shell's environment. Generated `PORTLER_*` values and `port_env` keys are still Portler's own. A config value the deployment overrides is not resolved, so a reference that only works in development cannot block it. In production a container receives only the keys `portler.yml` names for it: root and service `env` (with `prod.env`), `prod.require`, generated values and `port_env`; in development the `use_env` files' keys are forwarded too. See [Setup & production](/guide/setup-and-production).

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

An entry can also be a mapping that says more about the key:

```yaml
env:
  LOG_LEVEL: { default: debug }      # your shell or .env wins over it
  STRIPE_KEY:
    required: true                   # up stops and lists every missing key
    secret: true                     # portler env prints ***
    description: Test key from the Stripe dashboard
```

`up` then fails before anything starts:

```text
required env is missing or empty (required: true):
  STRIPE_KEY (service api): Test key from the Stripe dashboard
Set it in your shell or in a use_env file such as .env.
```

`required: prod` makes a key one the deployment must supply under `--prod`, like [`prod.require`](/guide/setup-and-production#required-values-and-external-services). All keys are in [env entries](/reference/configuration#env-entries).

## Selecting services

Most commands take service names to act on a subset:

```bash
portler up backend        # backend plus everything it depends on
portler restart backend   # restart just backend (missing deps are started)
portler logs backend
```

When you select services for `up`, their dependencies are included automatically and started in [dependency order](/guide/dependencies).

::: warning Reserved names
`docker` and `k8s` cannot be used as service names — they select run modes on the command line (`portler up docker`). `self` and `env` are reserved for references. When a `proxy:` block exists, `proxy` is reserved too.
:::
