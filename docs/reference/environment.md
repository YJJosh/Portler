# Environment variables

Portler injects a set of generated `PORTLER_*` variables into every service, on top of your `.env` files and config env. See [Environment layering](/guide/services#environment-layering) for precedence.

## Per-service variables

For **every service that has an assigned port**, all services receive (with `<NAME>` being the service name upper-snake-cased, e.g. `my-api` → `MY_API`). Config loading rejects two names that would collapse onto the same prefix (`api-main` and `api_main`, for example), so generated values can never silently overwrite one another:

| Variable | Value |
| --- | --- |
| `PORTLER_<NAME>_PORT` | Assigned host port |
| `PORTLER_<NAME>_URL` | Full URL, e.g. `http://localhost:51235` |
| `PORTLER_<NAME>_HOST` | Bind host (default `127.0.0.1`) |
| `PORTLER_<NAME>_URL_HOST` | URL host (default `localhost`) |
| `PORTLER_<NAME>_PROTOCOL` | URL scheme (default `http`) |
| `PORTLER_<NAME>_DESIRED_PORT` | The `port:` declared in portler.yml (only when declared) |
| `PORTLER_<NAME>_CONTAINER` | Docker container name (Docker services only) |
| `PORTLER_<NAME>_IMAGE` | Docker image (Docker services only) |

When a [proxy](/guide/proxy) is configured, it appears as a service named `proxy`: `PORTLER_PROXY_URL`, `PORTLER_PROXY_PORT`, and so on.

## Stack-wide variables

| Variable | Value |
| --- | --- |
| `PORTLER_SERVICE_NAMES` | Comma-separated, sorted names of all services with an assigned port |
| `PORTLER_SERVICE_NAME` | The name of the service receiving this environment |

## port_env

Each name listed in a service's `port_env:` is set to the service's port:

- **Local services** get the assigned host port.
- **Docker services** get the declared internal container port (the Docker port mapping translates the assigned host port to it).

## Variables Portler reads

| Variable | Effect |
| --- | --- |
| `PORTLER_VOLUME_SET` | Fallback for `--volume-set`; selects [volume set](/guide/volumes#volume-sets) variants of managed volumes |
| `PORTLER_GLOBAL_DIR` | Location of the shared state directory (the global port registry). Defaults to `~/.portler` |
| `PORTLER_ALLOW_K8S_CONTEXT` | Allows one specific, otherwise-unrecognized kubectl context for [Kubernetes mode](/guide/kubernetes#local-clusters-only). Must name the exact context |
| `PORTLER_ALLOW_K8S_ENDPOINT` | Allows one specific Kubernetes API server URL that is not a loopback endpoint — including a **private/LAN** one such as minikube's `https://192.168.49.2:8443`. Must name the exact URL. Separate from the context override on purpose: the [endpoint check](/guide/kubernetes#the-endpoint-is-checked-too-not-just-the-name) is an independent gate, and it does not cover an endpoint Portler cannot read at all |

## Inspecting the environment

```bash
portler env             # generated + top-level env
portler env backend     # everything the backend would receive
```

Values reflect current assignments — run it while the stack is up (or after an `up`) to see real ports.

::: details pnpm note
Portler sets `pnpm_config_verify_deps_before_run=false` for spawned services (unless you set it yourself). Service stdin is not attached to the terminal, and pnpm's script runner might otherwise abort waiting for an interactive prompt to reinstall dependencies.
:::
