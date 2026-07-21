# portler ps

Show services started by Portler.

```bash
portler ps [service...]
```

## Behavior

Prints one row per running service with:

- **mode** — `local` or `docker`
- **pid** — the process id
- **port / URL** — the assigned port and generated URL
- **container** — the Docker container name (Docker services)

Entries whose process has died are marked `dead (stale)`.

## Example

```bash
$ portler ps
SERVICE    MODE     PID     PORT    URL                       CONTAINER
postgres   docker   4321    51234   http://localhost:51234    portler-myapp-ab12cd-postgres
backend    local    4322    51235   http://localhost:51235
```
