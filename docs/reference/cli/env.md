# portler env

Print generated and resolved environment values.

```bash
portler env [service]
```

## Behavior

- Without a service: prints the generated [`PORTLER_*` variables](/reference/environment) plus the resolved top-level `env:`.
- With a service: additionally layers the service's own `env:` and `port_env` values — everything the service would receive on top of your shell environment and `.env` files.

Useful for debugging [references](/guide/services#service-references) and for sourcing values into other tooling.

## Example

```bash
$ portler env backend
PORTLER_SERVICE_NAMES=backend,frontend,postgres
PORTLER_BACKEND_PORT=51235
PORTLER_BACKEND_URL=http://localhost:51235
...
DATABASE_URL=postgres://app:app@localhost:51234/app
PORT=51235
```
