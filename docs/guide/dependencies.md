# Dependencies & readiness

Use `depends_on` to start services in order, and healthchecks to define what "ready" means. Portler waits for a service's dependencies to become ready before starting it.

## depends_on

```yaml
services:
  backend:
    command: npm run dev
    port: 4000
    depends_on:
      - postgres
```

Three forms are accepted:

```yaml
# single service
depends_on: postgres

# list (each waits for readiness)
depends_on:
  - postgres
  - redis

# mapping with per-dependency conditions
depends_on:
  postgres:
    condition: ready      # wait until the healthcheck passes (default)
  worker:
    condition: started    # only wait until the process is started
```

`healthy` and `service_healthy` (Docker-Compose spelling) are accepted as aliases for `ready`.

Dependency cycles are rejected at load time with the cycle spelled out (`a -> b -> a`), and a dependency on an unknown service fails with a did-you-mean suggestion.

## Healthchecks

A service with a `port` defaults to a **TCP** check: Portler repeatedly tries to connect until the port accepts connections. You can override the check:

```yaml
healthcheck:
  command: docker exec $PORTLER_POSTGRES_CONTAINER pg_isready -U app -d app
```

Supported types:

| Type | Ready when | Selected by |
| --- | --- | --- |
| `tcp` | The assigned port accepts TCP connections | Default for services with a `port` |
| `http` | The given URL answers with a success status | Presence of `url:` |
| `command` | The shell command exits with status 0 | Presence of `command:` (or `test:`) |
| `none` | Immediately after start | `healthcheck: none` (or `false`) |

The type is inferred from the keys you use, or set explicitly with `type:`. All options:

```yaml
healthcheck:
  type: http               # optional; inferred from the keys below
  url: http://localhost:${backend.port}/healthz
  command: ./scripts/check.sh    # for type: command ("test:" is an alias)
  timeout_ms: 60000        # give up after this long (default 60000)
  interval_ms: 500         # poll interval (default 500)
```

`ready:` is accepted as an alias for `healthcheck:`.

Healthcheck commands run with the service's full resolved environment, so `PORTLER_*` variables and references work — the sample uses `$PORTLER_POSTGRES_CONTAINER` to exec into the right container.

::: info Kubernetes mode
`command` healthchecks are ignored under `portler up k8s` — they usually shell into Docker containers that don't exist there. Readiness falls back to the Deployment rollout plus a TCP check through the port-forward. See [Kubernetes mode](/guide/kubernetes).
:::

## What startup looks like

1. Portler computes the dependency order from `depends_on`.
2. Each service starts once all of its dependencies are ready (or merely started, with `condition: started`).
3. A service is *ready* when its healthcheck passes; with `healthcheck: none` (or no port and no healthcheck) it is ready immediately.
4. If a healthcheck never passes within `timeout_ms`, startup fails loudly.

`portler restart <service>` follows the same rules: dependencies that are not running are started too, while already-running ones are left untouched.
