# portler setup

Run installation, build and generation steps without starting services.

```bash
portler setup [service...] [--prod]
portler setup docker [service...] [--prod]
```

- Always runs the top-level `setup` first, from the project root.
- Runs selected services' setup in dependency order, including their dependencies. With no names, selects every service.
- Each entry is a shell command, or a `{run, if_missing}` / `{run, always}` step; lists run sequentially. Output is inherited, with a heading naming each step and command. The first failure stops setup and reports its command and exit code.
- Top-level setup receives process env, `use_env` files, then top-level `env`. Service setup receives the same resolved env and `port_env` values as `up`.
- Allocates/reuses development port assignments like `env`. This writes `.portler/state.json` and may reserve ports, but starts no services, containers or proxy.
- Writes a receipt per successful plain step to [`.portler/setup.json`](/reference/generated-files), so a subsequent `up` skips it. Explicit `setup` **ignores receipts**: every plain step and every `always` step runs. An `if_missing` step still skips while its path exists (`skip <command> (<path> exists)`); delete the path to run it again.
- With `--prod`, uses production setup and env overrides, checks `prod.require` before running anything and runs only the services in `prod.services`. With `docker`, resolves Docker-mode env; setup still runs **on the host**, never inside containers.

`use_env` files are read **before** the top-level setup runs, so a setup step cannot create or refresh a listed env file for the same invocation; such files must already exist (a missing file is skipped with a notice; `up` in development still requires it).

Steps run in their own process group without a controlling terminal, so Ctrl+C reaches the whole step. Prompts that read stdin still work, but anything opening `/dev/tty` directly (SSH passphrase prompts, `sudo`, `gpg`) fails; use an agent (`ssh-agent`, `gpg-agent`) or run that step yourself.

`setup` does not wait for databases or start dependencies. Steps requiring a running dependency belong in service setup used by `up`, or require that dependency to be available externally before invoking `setup`.

`--file <path>` selects a config. Kubernetes setup is not supported; run host setup separately before building images.

See [Setup & production](/guide/setup-and-production).
