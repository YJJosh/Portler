# portler ps

Show services started by Portler.

```bash
portler ps [service...]
```

## Behavior

With service names, filters the rows to those services. When the project has a top-level `proxy:` block, `proxy` is also accepted as a selection; otherwise it is an unknown service.

Prints one row per running service with:

- **mode** — `local`, `docker`, or `k8s` for a port-forward started by `up k8s`, with `(prod)` when the service was started with `--prod`
- **pid** — the process id
- **status** — whether the service is still alive (below)
- **port / URL** — the assigned port and generated URL; a `udp` or `tcp+udp` port shows its [transport](/guide/ports#udp-ports), as in `19132/udp` (not for a `k8s` port-forward, which is TCP only)
- **container** — the Docker container name (Docker services)
- **image** — the `--image` pin the service runs from (shown when any service has one)

The status comes from the recorded process, its surviving process group, and, for a Docker service, its container:

| Status | Meaning |
|---|---|
| `running` | The recorded process is alive and is the one Portler started (its start time matches). |
| `running (container)` | A Docker service whose supervising `docker run` process is gone, but whose container runs on under this project's label. |
| `running (group)` | The leader has exited but its group still has live members (or cannot be confirmed gone). Ownership is unverified; `ps` warns, and `up` keeps the entry instead of starting another copy. This is not permission to signal the group. |
| `dead (stale)` | The process and its group have exited (including zombie-only groups on Linux), or its pid now belongs to an unrelated process, with no live owned container remaining. |
| `unknown` | The process is gone and its container could not be inspected (Docker daemon down, permission error); `ps` prints the reason as a warning. |

## Example

```bash
$ portler ps
SERVICE   MODE           PID   STATUS   PORT   URL                     CONTAINER
postgres  docker (prod)  4321  running  51234  http://localhost:51234  portler-myapp-ab12cd-postgres
backend   local (prod)   4322  running  51235  http://localhost:51235  -
```
