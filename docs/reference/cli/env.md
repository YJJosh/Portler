# portler env

Print generated and resolved environment values.

```bash
portler env [service] [--prod] [--reveal]
```

`--prod` prints what `up --prod` hands the service: the production overrides applied, the deployment's values with their precedence (process env, then the `use_env` file, then config), and only the keys the service receives. Secret-looking values are masked unless `--reveal` is given: a name containing `SECRET`, `TOKEN`, `PASS`, `PWD`, `PRIVATE`, `CREDENTIAL`, `SALT` or `APIKEY`, or `KEY` or `CERT` as a word (`SIGNING_KEY`, `SSH_KEY`), and the password in a URL, and missing `prod.require` keys are reported on stderr. Port assignment is the same as `up`; `start` uses the platform's `PORT` instead.

## Behavior

- Without a service: prints the generated [`PORTLER_*` variables](/reference/environment) plus the resolved top-level `env:`.
- With a service: additionally layers the service's own `env:` and `port_env` values — everything the service would receive on top of your shell environment and `.env` files.

Useful for debugging [references](/guide/services#service-references); in development the output can be sourced into other tooling.

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
