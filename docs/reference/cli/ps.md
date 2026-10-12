# portler ps

Show services started by Portler.

```bash
portler ps [service...]
```

## Behavior

Prints one row per running service with:

- **mode** — `local` or `docker`, with `(prod)` when the service was started with `--prod`
- **pid** — the process id
- **port / URL** — the assigned port and generated URL
- **container** — the Docker container name (Docker services)
- **image** — the `--image` pin the service runs from (shown when any service has one)

Entries whose process has died are marked `dead (stale)`.

## Example

```bash
$ portler ps
SERVICE    MODE            PID     PORT    URL                       CONTAINER
postgres   docker (prod)   4321    51234   http://localhost:51234    portler-myapp-ab12cd-postgres
backend    local (prod)    4322    51235   http://localhost:51235
```
