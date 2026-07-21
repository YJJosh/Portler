# portler logs

Show captured output of services started with `portler up -d`.

```bash
portler logs [service...] [-f|--follow]
```

## Behavior

- Local process output is captured to `.portler/logs/<service>.log` while the service runs detached; `logs` prints it, optionally filtered by service name.
- Docker services delegate to `docker logs` on the container.
- `-f` / `--follow` keeps streaming new output until you press `Ctrl+C`.
- Log files are truncated on each restart and kept after `portler down`.

::: tip `-f` means `--follow` here
For `logs` — and only for `logs` — `-f` means `--follow`, matching `docker logs -f` and `kubectl logs -f`. Everywhere else in Portler, `-f` is short for `--file`.

To point `logs` at a specific config file, use the long form: `portler logs --file other.yml`.
:::

## Examples

```bash
portler logs                     # all services
portler logs backend             # one service
portler logs backend -f          # tail it
portler logs --file other.yml    # use a different portler.yml
```
