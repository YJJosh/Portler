# portler.yml reference

Portler looks for `portler.yml` (or `portler.yaml`) in the current directory; `-f/--file <path>` selects another file. The file must contain a top-level `services:` mapping with at least one service.

::: warning Still changing
The `portler.yml` format is being improved and can change in breaking ways in upcoming releases. Check the [release notes](https://github.com/YJJosh/Portler/releases) when you upgrade.
:::

::: info YAML subset
Portler uses its own hand-rolled YAML parser covering a practical subset: mappings, block and inline lists, scalars, quoting, and comments. Anchors, multi-document files, and other exotic features are not supported.
:::

::: tip Editor autocomplete
Portler ships a JSON schema for `portler.yml` (`schema/portler.schema.json` in the package). Editors that use yaml-language-server, such as VS Code with the YAML extension, pick it up from this first line:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/YJJosh/Portler/main/schema/portler.schema.json
```

It completes keys and flags typos such as `healtcheck:`, which Portler itself ignores.
:::

## Top-level options

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `setup` | string \| list of commands and steps | — | Host shell commands run from the project root; a step object adds `if_missing`, `always` or `watch`. See [Setup and prod](#setup-and-prod) |
| `name` | string | — | Stable project name. Under `--prod` it names the Docker network, the containers and the managed volumes instead of the directory hash; `[a-z0-9][a-z0-9_.-]*` ending in a letter or digit, no `--`, up to 40 characters. See [Stable identity on a server](/guide/setup-and-production#stable-identity-on-a-server) |
| `prod` | object | — | Production `setup` replacement, `env` overrides, `require` (keys the deployment must supply) and `services` (which services run), used with `--prod` |
| `services` | mapping | — (required) | The services to run; see [Service options](#service-options) |
| `tasks` | mapping | — | Named commands for [`portler run`](/reference/cli/run); see [tasks](#tasks) |
| `use_env` | string \| list | `[]` | `.env` file(s) loaded for all services, later files win. Alias: `env_file` |
| `env` | mapping \| list | `{}` | Env values shared by all services; [references](#service-references) resolve. An entry can be a mapping with `default`, `required`, `secret` and `description`; see [env entries](#env-entries) |
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
| `use` | string | — | Start from a preset: a built-in name (`postgres`, `mysql`, `redis`) or a path to a preset file. See [use](#use-presets) |
| `exports` | mapping | — | Named values other services read as `${service.name}`, such as a connection URL. See [exports](#exports) |
| `setup` | string \| list of commands and steps | — | Host shell commands in service cwd, with resolved service env; steps as at the top level |
| `prod` | object | — | Production `setup`, `command` replacements, `env` overrides and `require` |
| `command` | string | — | Shell command that starts the service (local mode) |
| `cwd` | string | `.` | Working directory, relative to the project root: the folder Portler runs in, which `--file` does not change. A folder that does not exist stops `up`, `restart`, `setup` and `start` before anything runs |
| `port` | integer | — | Declared port (local; tried first only with `prefer_declared_port`, see [Ports](/guide/ports)) / internal container port (Docker). Services without a port get no assignment and cannot be referenced |
| `port_env` | string \| list | `[]` | Env variable name(s) that receive the port |
| `transport` | `tcp` \| `udp` \| `tcp+udp` | `tcp` | Which protocols the port uses; needs `port`. See [UDP ports](/guide/ports#udp-ports) |
| `env` | mapping \| list | `{}` | Service env; wins over root env and `.env` files in development, except `default:` entries. Entries as in [env entries](#env-entries). Alias: `environment` |
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
`docker` and `k8s` are always reserved (they select run modes on the command line). `self` and `env` are reserved too (`${self.port}` names the service itself; `${env.KEY}` reads a service's own env in its [exports](#exports)). `proxy` is reserved when a `proxy:` block exists.
:::

## Setup and prod

`setup` accepts a command or a list; each entry runs sequentially through the shell, stopping on the first non-zero exit. Root setup runs from the project root; service setup runs in its `cwd`. Setup is always on the host, even for Docker services.

`setup` may also be a single step object. A list entry is a command string or a step object with `run` and one of three modifiers:

```yaml
setup:
  - pnpm install                          # once per checkout; again when the line or cwd changes
  - run: pnpm install
    if_missing: node_modules              # only while nothing exists at this path
  - {run: pnpm run codegen, always: true} # on every up and setup
  - run: pnpm run db:generate
    watch: [prisma/schema.prisma]         # once per checkout; again when the schema changes
  - run: pnpm run db:migrate
    watch: [migrations]                   # a folder: again when a file in it changes, appears or goes
```

| Step | When it runs |
| --- | --- |
| `<command>` or `{run: <command>}` | Once per checkout. A receipt in `.portler/setup.json` records the success, per run mode, dev or prod, and [volume set](/guide/volumes#volume-sets) when the project has managed `@` volumes (a migration that ran against one set's database has not run against another's); the step runs again when its command or cwd changes, with `up --setup`, or on `portler setup`. Identical commands in one list are separate steps, told apart by their position among all entries with that command; adding or removing one of them runs every entry with that command again. A step that is removed loses its receipt before the next `up` or `setup`, even when its service is not part of that run, and so does every step of a service that leaves the config. |
| `{run, if_missing: <path>}` | Only while nothing exists at `<path>`, resolved against the step's cwd. A file, a folder, or a link whose target exists all count. No receipt: the path is the receipt, so deleting what the step produced runs it again, and `--setup` does not override it. |
| `{run, always: true}` | On every `up` (unless `--no-setup`) and every `setup`. No receipt. |
| `{run, watch: [paths]}` | Like a plain step, with the content of the listed files and folders (relative to the step's cwd) folded into its receipt: the step runs again when one of them changes, appears or disappears. A folder counts every file under it by path and content, so adding, changing or removing a file in it counts; a symlink inside it counts by its target path and is not followed. The files are read when the step is reached, so a change an earlier step made in the same run counts, and recorded as they are once the step succeeds, so a step that rewrites its own input (an install updating its lockfile) does not run again for that. A listed path that exists but cannot be read (no permission) stops setup with an error instead of counting as absent. |

Every command, bare or as `run`, must be non-empty; `if_missing`, `always` and `watch` cannot be combined with each other; other keys are rejected.

Top-level `prod` accepts `setup`, `env`, `require` and `services`; service `prod` accepts `setup`, `env`, `command` and `require`. Unknown keys are rejected. With `--prod`, setup and command replace their ordinary definitions, while env merges over env at the same level. Omitted overrides inherit ordinary values; `setup: []` disables an inherited setup.

`prod.env` wins over Docker-mode env. `prod.command` only replaces a container command that comes from `command` (top-level `image`/`build` services); a `docker:` block keeps `docker.command` or the image `CMD`. With `--prod` and in `portler start`, the deployment wins over config: process env, then the `use_env` file (a missing one is skipped), then config env. Kubernetes does not apply production overrides or setup; production/setup flags are rejected in `up k8s`. `prod` is a config key but **not** a reserved service name or positional mode; use `--prod`. See [Setup & production](/guide/setup-and-production).

`prod.require` lists variables the deployment must supply: with `--prod`, `up`, `setup`, `start` and `restart` fail before anything runs or is stopped when one of them is missing or empty, naming it. A required key is always taken from the deployment (process env or the `use_env` file); its config value is not used, and neither is a value Portler sets itself (`PORTLER_*`, a `port_env` name such as `PORT`), so a blank `prod.env` entry, a `require` entry and an env entry marked `required: prod` (see [env entries](#env-entries)) mean the same, and required keys reach containers whether or not an `env:` names them. A blank top-level `prod.env` entry belongs to the env each service and the top-level setup steps see: it is required by each service that does not set the key itself, and by the project only while its top-level setup steps run. A top-level `prod.require` holds always. Top-level `prod.services` lists the services that run under `--prod`; the rest are external to the deployment: they are not started, dependencies on them are dropped, a proxy route to one is an error, and naming one on the command line is an error. Without it every service runs.

## env entries

Every `env:` block (top-level, service, `docker.env`, `k8s.env`, `prod.env`) takes a plain value or a mapping that describes the key:

```yaml
env:
  LOG_LEVEL: { default: debug }                     # your shell or .env can override it
  STRIPE_KEY:
    required: true                                  # up fails, listing every missing key
    secret: true                                    # portler env prints ***
    description: Test key from the Stripe dashboard
  PUBLIC_URL: { value: "http://localhost:${web.port}", required: prod }
```

| Key | Meaning |
| --- | --- |
| `value` | The config value, like a plain value: in development it wins over your shell and the `use_env` files |
| `default` | Used only when neither your shell nor a `use_env` file sets the key. Cannot be combined with `value` |
| `required` | `true`: the key must end up non-empty wherever the service runs, from your shell, a `use_env` file, or a non-empty `value`/`default`. `prod`: under `--prod` the deployment must supply it, like [`prod.require`](#setup-and-prod); its config value still works in development |
| `secret` | `true` hides the value in [`portler env`](/reference/cli/env), in development too, and so does a value that reads it through an [export](#exports). `false` keeps a secret-looking name (`PASSWORD_MIN_LENGTH`) visible under `--prod` |
| `description` | Shown next to the key when it is missing |

A mapping with only `required`, `secret` or `description` sets no value: the key comes from your shell or a `use_env` file, and is forwarded to containers like the keys those files set. `up`, `setup`, `restart` and `start` check `required: true` before anything runs or stops and report every missing key in one error; `env` and `run` print the same report as a warning.

Layers merge per key. A higher layer (the service over the top level, `docker.env` or `k8s.env` over the service, `prod.env` over both) replaces the value or default, while `required`, `secret` and `description` stay unless it sets them too: a plain `docker.env` value does not drop `secret: true`. Under `--prod` (and in `portler start`) the deployment wins over config anyway, so `default` and `value` behave the same there.

## use (presets) {#use-presets}

`use:` starts a service from a preset: a built-in one by name, or a YAML file of your own by path. A preset holds ordinary service keys, so a new database needs no change to Portler.

```yaml
services:
  db:
    use: postgres                       # built-in
    env:
      POSTGRES_DB: shop                 # merges with the preset's env
  search:
    use: ./portler/presets/meili.yml    # a file: relative to the project root
```

| Built-in | Image | Port | Exports |
| --- | --- | --- | --- |
| `postgres` | `postgres:18-alpine` | 5432 | `database_url` |
| `mysql` | `mysql:8.4` | 3306 | `database_url` |
| `redis` | `redis:7-alpine` | 6379 | `redis_url` |

Each built-in preset declares a managed volume `@<service>-data`, a readiness command and env entries with development defaults (passwords marked `secret: true`). The files live in [`presets/`](https://github.com/YJJosh/Portler/tree/main/presets).

- The service's own keys replace the preset's, except `env` and `exports`, which merge key by key (as [env layers](#env-entries) do). A list such as `volumes:` replaces the preset's list.
- A value is a path when it contains `/` or ends in `.yml`/`.yaml`; anything else is a built-in name.
- `${self.name}` in a preset becomes the service's name when the file loads, so two services using one preset get separate volumes. Other `${self.*}` references resolve later, like in the service itself.
- A preset cannot `use` another preset.
- The image pins a major version, because a data volume only opens with the major that wrote it. Postgres 17 and older keep their data in `/var/lib/postgresql/data`, so set `volumes:` too when you set an older `image:`.

## exports

`exports:` gives a service named values that other services read like a property: `${db.database_url}`. A template can use `${self.*}` properties and `${env.KEY}`, the value the exporting service itself gets for `KEY` (from config, your shell or a `use_env` file).

```yaml
services:
  db:
    image: postgres:18-alpine
    port: 5432
    env:
      POSTGRES_PASSWORD: { default: dev, secret: true }
    exports:
      database_url: postgres://postgres:${env.POSTGRES_PASSWORD}@${self.address}/app
  api:
    env:
      DATABASE_URL: ${db.database_url}   # right in local, Docker and Kubernetes mode
```

An export resolves for whoever reads it, so `${self.address}` inside it is the address [as the reader sees it](#service-references). A value that reads a `secret: true` key is hidden by `portler env` too. Names use lowercase letters, digits and `_` and cannot hide a built-in property such as `url`. An export cannot use another export, and the env values an export reads cannot use one either, so exports never form a loop. `${env.KEY}` only works inside `exports`.

## tasks

`tasks:` names commands for [`portler run`](/reference/cli/run). A task is a command, or a mapping:

```yaml
tasks:
  psql: docker exec -it ${db.container} psql -U postgres app
  migrate:
    run: pnpm db:migrate
    service: api                 # run with api's env, in api's cwd
    description: Apply database migrations
```

| Key | Meaning |
| --- | --- |
| `run` | Shell command. [References](#service-references) resolve as seen from this machine, like in a healthcheck command |
| `service` | Run with that service's env and in its `cwd`. Without it, the command gets the project's env and `PORTLER_*` values, in the project root |
| `description` | Shown by `portler run` with no name |

Task names use letters, digits, `_`, `:`, `.` and `-`, and cannot be a service name, `docker` or `k8s`.

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
  accept: [200, 401]          # http only: statuses that mean ready (default: any 2xx or 3xx)
```

Type inference: `command`/`test` present → `command`; `url` present → `http`; otherwise `tcp`. Default for a service with a `port` is a TCP check on the assigned port, and no check for a `transport: udp` port, which Portler cannot probe without speaking the app's protocol (use a `command` check for that). For services that run in a container, the connection must also stay open for a moment (200 ms) or the peer must send something, because Docker's port proxy accepts connections even while nothing listens inside the container and never sends data itself; a `timeout_ms` shorter than that can never pass for a container whose listener stays silent. An explicit `command` check requires a command, an explicit `tcp` check requires a service port that is not UDP only, and an `http` check requires either a URL or a service port that is not UDP only. An `http` check counts a 2xx or 3xx response as ready; a 401 or 404 is not (the server is up, but the route or the credentials are not), unless `accept:` lists the statuses that count, for example `accept: [200, 404]`. `ready:` is an alias for `healthcheck:`. Timings must be positive and no greater than `2147483647`ms (Node clamps larger timers to 1ms).

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
  host: 127.0.0.1             # optional bind override; default: root host
  trusted_proxies: []          # exact IPv4/IPv6 source IPs of trusted edges; no implicit loopback trust
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
- `host` overrides only the proxy bind address (default: root `host`), not backend binds or advertised URLs. Use root `host: 127.0.0.1` with `proxy.host: 0.0.0.0` to expose one app endpoint while retaining loopback backend assignments. The listener remains plain HTTP; terminate TLS at a separate edge.
- `trusted_proxies` is an array of exact IPv4/IPv6 peer addresses, default `[]`. No hostnames, wildcards, CIDRs, ports, or scope identifiers; loopback is not implicitly trusted. Equivalent IPv6 and IPv4-mapped IPv6 identities match. Only allowlist controlled edges that **sanitize client forwarding headers**. Trusted peers may supply a single `http`/`https` scheme, a valid allowed hostname authority, and an IP-only client chain. Portler validates each independently, appends the socket IP to a valid chain, and otherwise falls back to socket/checked `Host` metadata. Untrusted incoming metadata is discarded. `Forwarded`, `X-Real-IP`, and unsupported `X-Forwarded-*` headers are always removed, identically for HTTP and WebSocket upgrades. See the [full forwarding/trust policy](/guide/proxy#behind-a-tls-edge) before enabling trust.
- `allowed_hosts` extends the `Host` headers the proxy accepts. Loopback names (`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`) and the project's `url_host` are always allowed; everything else gets a `403`. See [DNS-rebinding protection](/guide/proxy#allowed-hosts-dns-rebinding-protection).

See [Proxy: one project URL](/guide/proxy).

## Service references

Env values (top-level and per-service) can reference other services, either as the whole value (`backend.url`) or interpolated (`${postgres.port}`). Valid properties: `url`, `port`, `host`, `url_host`, `protocol`, `desired_port`, `container`, `image`, `name`, `address`, `address_host`, `address_port`, plus the service's [exports](#exports). `self` names the service whose env, setup, healthcheck or exports it is (`${self.port}`).

`address` is `host:port` as the reader sees it: `localhost:<assigned port>` from a process on your machine (including setup steps, healthcheck commands and `portler run`), `<service>:<port>` from a container on the project network or from a pod in [Kubernetes mode](/guide/kubernetes), and `host.docker.internal:<assigned port>` from a container reaching a local process. `url`, `port` and `host` are always the host-side values. See [Services & environment](/guide/services#service-references).

## Complete example

```yaml
setup: npm install
prod:
  setup:
    - npm ci
    - npm run build
  env:
    NODE_ENV: production

use_env: .env
prefer_declared_port: false
port_range: {start: 51000, end: 59999}

tasks:
  psql: docker exec -it ${postgres.container} psql -U postgres app

proxy:
  port: auto
  routes:
    /api: backend
    /: frontend

services:
  postgres:
    use: postgres                 # image, port, volume, healthcheck, exports.database_url
    env:
      POSTGRES_PASSWORD: { default: app, secret: true }
    k8s:
      volume: 1Gi

  backend:
    command: npm run dev
    prod:
      command: npm start
      setup: []
      env:
        LOG_LEVEL: info
    cwd: backend
    port: 4000
    port_env: PORT
    depends_on:
      - postgres
    setup:
      - npm run generate
      - run: npm run migrate
        watch: [migrations]
    env:
      DATABASE_URL: ${postgres.database_url}   # localhost:<port>, postgres:5432 in a container
      PUBLIC_ORIGIN: proxy.url
      SESSION_SECRET: { required: true, secret: true, description: "Any long random string" }
    docker:
      build:
        context: .
        dockerfile: apps/api/Dockerfile
    k8s: true

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
