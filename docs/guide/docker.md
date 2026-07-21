# Docker services

Services can run in Docker instead of as local processes. A service becomes a Docker service when it has `image`, `build`, `dockerfile`, `volumes`, or `type: docker`.

## Image services

```yaml
services:
  redis:
    image: redis:7-alpine
    port: 6379
```

## Built services

Similar to Docker Compose — `dockerfile` is resolved relative to `context`:

```yaml
services:
  api:
    build:
      context: .
      dockerfile: apps/api/Dockerfile
    port: 4000
    port_env: PORT
```

`build:` also accepts a plain string (the context directory), plus `target:` for multi-stage builds and `args:` for build arguments:

```yaml
build:
  context: .
  dockerfile: apps/api/Dockerfile
  target: dev
  args:
    NODE_VERSION: 22
```

A top-level `dockerfile:` on the service (without `build:`) is shorthand for `build: { context: ., dockerfile: ... }`.

## Ports in Docker services

For Docker services, `port:` is the **internal container port**. Portler maps a dynamically assigned host port to it, so from the outside the service behaves exactly like a local one: references (`api.url`, `${api.port}`) and `PORTLER_*` variables use the assigned host port. Inside the container, `port_env` receives the internal container port.

## Environment

You can use either `env:` or the Docker-Compose-style `environment:` for environment variables — mapping or `KEY=value` list form. Portler forwards exactly the variables it composed (env files, config env, generated values, `port_env`) into the container; your shell's unrelated variables don't leak in. An inherited `PORTLER_*` prefix does not make a host variable explicit, so host paths, Kubernetes safety overrides, arbitrary Portler secrets, and Portler's internal package-manager defaults stay outside the container. Generated `PORTLER_*` values and keys you deliberately declare are still forwarded.

## Volumes

Docker volumes support normal Docker syntax:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    port: 5432
    volumes:
      - ./data:/docker-entrypoint-initdb.d       # bind mount, resolved from the project dir
      - '@postgres-data:/var/lib/postgresql/data' # Portler-managed named volume
```

- Relative bind mounts like `./data:/data` are resolved from the project directory.
- A source starting with `@` creates a **Portler-managed, project-scoped Docker named volume** — recommended for database data on Docker Desktop. See [Volumes](/guide/volumes) for naming, forking, and management.

## Naming and networking

Portler derives stable, project-scoped default names so projects never collide:

| Resource | Default name |
| --- | --- |
| Container | `portler-<project>-<hash>-<service>` |
| Image (built) | `portler-<project>-<hash>-<service>` |
| Network | `portler-<project>-<hash>` |

`<project>` is the project directory basename, `<hash>` a short hash of its full path. Override with `container_name:` per service or a top-level `docker_network:`. Explicit container names must remain unique across the project's services in each run mode; Portler rejects a collision before starting anything.

All Docker services of a project share the project network, with the service name as network alias — so in full Docker mode containers can reach each other as `postgres:5432`.

## Docker mode: `portler up docker`

Plain `portler up` runs Docker services in Docker and everything else locally. `portler up docker` runs the project **completely in Docker**: every service with any Docker configuration runs in a container.

The per-service `docker:` key configures how a service runs *only* in Docker mode (plain `up` ignores it):

```yaml
services:
  api:
    command: npm run dev        # plain "up": local process
    port: 4000
    port_env: PORT
    docker:                      # "up docker": containerized
      build:
        context: .
        dockerfile: apps/api/Dockerfile
      env:
        DATABASE_URL: postgres://app:app@postgres:5432/app
```

`docker:` accepts:

- `true` — reuse the service's top-level Docker config (or a default image name),
- a string — an image name,
- an object — full Docker config (`image`, `build`, `container_name`, `volumes`, `env`/`environment`, `command`).

Env values under `docker:` are merged **over** the service's env in Docker mode, which is how the example above swaps `localhost:${postgres.port}` for the in-network `postgres:5432` address.

::: warning
`docker` is a reserved word on the command line (`portler up docker`) and cannot be used as a service name.
:::

## Requirements & failure behavior

Docker services need the Docker daemon; when it is not running, commands that need it fail with a clear error. `portler down` stops and removes the project's containers.
