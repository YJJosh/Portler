# portler clean

Remove runtime files and release port reservations.

```bash
portler clean [--ports] [--global] [--force]
```

## Behavior

Plain `portler clean` removes the local [`.portler/` runtime files](/reference/generated-files) and releases this project's ports from the global registry (`~/.portler/ports.json`).

Clean **refuses to run while services are running**; pass `--force` to stop them first.

## Options

| Flag | Description |
| --- | --- |
| `--ports` | Only release this project's port reservations, keeping `.portler/` |
| `--global` | Prune stale entries left behind by crashed or deleted projects from the global registry (entries whose port is free again) |
| `--force` | Stop running services first. With `--global`, explicitly reset an unreadable/corrupt global registry (pending not-yet-bound reservations may be lost). |

## Examples

```bash
portler clean            # remove .portler/ + release this project's ports
portler clean --ports    # only release ports
portler clean --global   # machine-wide registry cleanup
portler clean --global --force  # recover an unreadable global registry
portler clean --force    # stop services, then clean
```
