# portler.yml reference

Portler looks for `portler.yml` (or `portler.yaml`) in the current directory; `-f/--file <path>` selects another file. The file must contain a top-level `services:` mapping with at least one service.

::: info YAML subset
Portler uses its own hand-rolled YAML parser covering a practical subset: mappings, block and inline lists, scalars, quoting, and comments. Anchors, multi-document files, and other exotic features are not supported.
:::

## Top-level options

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `services` | mapping | — (required) | The services to run; see [Service options](#service-options) |
| `use_env` | string \| list | `[]` | `.env` file(s) loaded for all services, later files win. Alias: `env_file` |
| `env` | mapping \| list | `{}` | Env values shared by all services; [references](#service-references) resolve |
| `host` | string | `127.0.0.1` | Default bind/probe host for all services |
| `url_host` | string | `localhost` | Default host used in generated URLs |
| `protocol` | string | `http` | Default URL scheme |
| `port_range` | `{start, end}` | `51000`–`59999` | Range scanned for free ports |
| `port_start` / `port_end` | integer | `51000` / `59999` | Flat alternative to `port_range` |
| `prefer_declared_port` | boolean | `false` | Try each service's declared `port:` first when free |
| `docker_network` | string | `portler-<project>-<hash>` | Docker network shared by the project's containers |
| `k8s_namespace` | string | `portler-<project>-<hash>` | Namespace for [Kubernetes mode](/guide/kubernetes); must be a valid Kubernetes name |
| `proxy` | object | — | Reverse proxy block; see [Proxy](#proxy) |

## Service options

Each entry under `services:` accepts the options below. Service names must be 1–63 ASCII letters, digits, `_`, or `-`, starting with a letter or digit. Names must also produce distinct upper-snake-case environment prefixes: for example, `api-main` and `api_main` cannot coexist because both would generate `PORTLER_API_MAIN_*`.

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `command` | string | — | Shell command that starts the service (local mode) |
| `cwd` | string | `.` | Working directory, relative to the project root |
| `port` | integer | — | Preferred port (local) / internal container port (Docker). Services without a port get no assignment and cannot be referenced |
| `port_env` | string \| list | `[]` | Env variable name(s) that receive the port |
| `env` | mapping \| list | `{}` | Service env; overrides everything else. Alias: `environment` |
| `host` | string | top-level `host` | Bind/probe host override |
| `url_host` | string | top-level `url_host` | URL host override |
| `protocol` | string | top-level `protocol` | URL scheme override |
| `prefer_declared_port` | boolean | top-level value | Try the declared `port:` first when free |
| `depends_on` | string \| list \| mapping | `[]` | Dependencies; see [depends_on](#depends-on) |
| `healthcheck` | string \| object \| `none`/`false` | tcp when `port` is set | Readiness check; see [healthcheck](#healthcheck). Alias: `ready` |
| `image` | string | — | Docker image; makes this a Docker service |
| `build` | string \| object | — | Docker build config; makes this a Docker service. See [build](#build) |
| `dockerfile` | string | — | Shorthand for `build: {context: ., dockerfile: ...}` |
| `volumes` | list | `[]` | Docker volumes; makes this a Docker service. See [volumes](#volumes) |
| `container_name` | string | `portler-<project>-<hash>-<service>` | Docker container name; must be unique across the project's services in a run mode. Alias: `containerName` |
| `type` | `docker` | — | Force Docker service without other Docker keys |
| `docker` | `true` \| string \| object | — | Docker-mode override, used only by `portler up docker`. See [docker](#docker-mode-override) |
| `k8s` | `true` \| object | — | Kubernetes-mode config, used only by `portler up k8s`. See [k8s](#k8s) |

A service becomes a **Docker service** (runs in Docker even under plain `portler up`) when it has `image`, `build`, `dockerfile`, `volumes`, or `type: docker`.

::: warning Reserved service names
`docker` and `k8s` are always reserved (they select run modes on the command line). `proxy` is reserved when a `proxy:` block exists.
:::

## depends_on

```yaml
depends_on: postgres          # single dependency

depends_on:                   # list form
  - postgres
  - redis

depends_on:                   # mapping form with conditions
  postgres:
    condition: ready          # default; aliases: healthy, service_healthy
  worker:
    condition: started        # don't wait for readiness
```

Unknown dependencies and cycles are rejected at load time. See [Dependencies & readiness](/guide/dependencies).

## healthcheck

```yaml
healthcheck: none             # or false: ready immediately
healthcheck: tcp              # type as a plain string

healthcheck:                  # object form
  type: http                  # none | tcp | http | command; inferred when omitted
  url: http://localhost:${backend.port}/healthz    # for type: http
  command: ./scripts/check.sh # for type: command; alias: test
  timeout_ms: 60000           # default 60000
  interval_ms: 500            # default 500
```

Type inference: `command`/`test` present → `command`; `url` present → `http`; otherwise `tcp`. Default for a service with a `port` is a TCP check on the assigned port. An explicit `command` check requires a command, an explicit `tcp` check requires a service port, and an `http` check requires either a URL or a service port. `ready:` is an alias for `healthcheck:`. Timings must be positive and no greater than `2147483647`ms (Node clamps larger timers to 1ms).

## build

```yaml
build: apps/api               # string: the build context

build:                        # object form
  context: .                  # default .
  dockerfile: apps/api/Dockerfile   # resolved relative to context
  target: dev                 # multi-stage build target
  args:                       # build args (mapping or KEY=value list)
    NODE_VERSION: 22
```

A `dockerfile:` on the service itself takes precedence over `build.dockerfile`. Built images default to the name `portler-<project>-<hash>-<service>`.

## volumes

```yaml
volumes:
  - ./data:/data                                # bind mount, resolved from the project dir
  - '@postgres-data:/var/lib/postgresql/data'   # Portler-managed named volume
  - myvolume:/somewhere                         # plain Docker named volume
```

Normal Docker syntax is supported. A source starting with `@` declares a [Portler-managed volume](/guide/volumes) named `portler-<project>-<hash>-<name>`; managed names are slugged (`a-z0-9_.-`), must contain an ASCII letter or digit, and must not contain `--`. Two differently written names that normalize to the same slug are rejected rather than silently sharing data.

## docker (mode override) {#docker-mode-override}

Configures how the service runs under `portler up docker` **only** — plain `up` ignores it:

```yaml
docker: true                  # containerize with the top-level Docker config (or a default image)
docker: node:22-alpine        # string: an image

docker:                       # object: full Docker config
  image: node:22-alpine
  build: {context: ., dockerfile: Dockerfile}
  container_name: my-api
  volumes: ['@data:/data']
  command: node server.js
  env:                        # merged OVER the service env in Docker mode
    DATABASE_URL: postgres://app:app@postgres:5432/app
```

In Docker mode, containers share the project network and reach each other by service name (`postgres:5432`).

## k8s

Configures the service under `portler up k8s` / `portler k8s render` **only**:

```yaml
k8s: true                     # defaults: replicas 1, no overrides

k8s:
  replicas: 2                 # Positive Deployment replica count, default 1
  env:                        # in-cluster overrides (k8s DNS names); alias: environment
    DATABASE_URL: postgres://app:app@postgres:5432/app
  volume: 1Gi                 # string shorthand for size

k8s:
  volume:
    size: 1Gi                 # required (PVC size)
    mount_path: /var/lib/postgresql/data   # default: first Docker volume's container path, or /data
```

See [Kubernetes mode](/guide/kubernetes).

## proxy

```yaml
proxy:
  port: auto                  # "auto" (or omitted) = Portler picks; a number is preferred when free
  allowed_hosts:              # optional: extra Host headers the proxy answers for
    - myapp.test
  routes:                     # at least one route required
    /api: backend             # prefix -> service name
    /: frontend
```

- Prefixes must start with `/`; a trailing slash is ignored (`/api/` ≡ `/api`).
- Longest prefix wins, respecting path segment boundaries; the prefix is **not** stripped before forwarding.
- Every route must target a known service that declares a `port`.
- Duplicate prefixes are an error.
- `allowed_hosts` extends the `Host` headers the proxy accepts. Loopback names (`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`) and the project's `url_host` are always allowed; everything else gets a `403`. See [DNS-rebinding protection](/guide/proxy#allowed-hosts-dns-rebinding-protection).

See [Proxy: one project URL](/guide/proxy).

## Service references

Env values (top-level and per-service) can reference other services, either as the whole value (`backend.url`) or interpolated (`${postgres.port}`). Valid properties: `url`, `port`, `host`, `url_host`, `protocol`, `desired_port`, `container`, `image`, `name`. See [Services & environment](/guide/services#service-references).

## Complete example

```yaml
use_env: .env
prefer_declared_port: false
port_range: {start: 51000, end: 59999}

proxy:
  port: auto
  routes:
    /api: backend
    /: frontend

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
    k8s:
      volume:
        size: 1Gi
        mount_path: /var/lib/postgresql/data

  backend:
    command: npm run dev
    cwd: backend
    port: 4000
    port_env: PORT
    depends_on:
      - postgres
    env:
      DATABASE_URL: postgres://app:app@localhost:${postgres.port}/app
      PUBLIC_ORIGIN: proxy.url
    docker:
      build:
        context: .
        dockerfile: apps/api/Dockerfile
      env:
        DATABASE_URL: postgres://app:app@postgres:5432/app
    k8s:
      env:
        DATABASE_URL: postgres://app:app@postgres:5432/app

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
