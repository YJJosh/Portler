# portler ps

Show services started by Portler.

```bash
portler ps [service...]
```

## Behavior

Prints one row per running service with:

- **mode** — `local`, `docker`, or `k8s` for a port-forward started by `up k8s`, with `(prod)` when the service was started with `--prod`
- **pid** — the process id
- **status** — whether the service is still alive (below)
- **port / URL** — the assigned port and generated URL
- **container** — the Docker container name (Docker services)
- **image** — the `--image` pin the service runs from (shown when any service has one)

The status comes from the recorded process and, for a Docker service, its container:

| Status | Meaning |
|---|---|
| `running` | The recorded process is alive and is the one Portler started (its start time matches). |
| `running (container)` | A Docker service whose supervising `docker run` process is gone, but whose container runs on under this project's label. |
| `dead (stale)` | The process has exited, is a zombie, or its pid now belongs to an unrelated process. |
| `unknown` | The process is gone and its container could not be inspected (Docker daemon down, permission error); `ps` prints the reason as a warning. |

## Example

```bash
$ portler ps
SERVICE   MODE           PID   STATUS   PORT   URL                     CONTAINER
postgres  docker (prod)  4321  running  51234  http://localhost:51234  portler-myapp-ab12cd-postgres
backend   local (prod)   4322  running  51235  http://localhost:51235  -
```
