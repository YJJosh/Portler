# portler init

Write a starter `portler.yml` into the current directory.

```bash
portler init
```

## Behavior

- Writes the canonical sample config (the same one shown by `portler --help`): a Postgres container with a managed volume and healthcheck, a backend, and a frontend wired together with references.
- Refuses to overwrite: if `portler.yml` already exists, it errors instead.

See [Getting started](/guide/getting-started) for the generated file and how to adapt it.
