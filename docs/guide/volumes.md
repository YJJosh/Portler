# Volumes

Portler manages project-scoped Docker named volumes for you, with first-class support for **forking data** — made for the git-worktree workflow of testing a migration against a copy of your database.

## Managed `@` volumes

Declare a managed volume by prefixing the source with `@`:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    port: 5432
    volumes:
      - '@postgres-data:/var/lib/postgresql/data'
```

`@postgres-data` becomes the Docker volume `portler-<project>-<hash>-postgres-data`, where `<project>` and `<hash>` come from the project root. Portler creates it with `portler.*` labels before the first run so it can find it again later. Before mounting it, Portler verifies that project label again (including after a concurrent create race); an unlabelled or foreign volume that merely has the expected name is refused rather than exposed to the service.

::: tip Stable across git worktrees
Linked worktrees of the same repository resolve `@` volumes to the **main repository's** volumes, so a worktree sees the same data as the main checkout. Containers and networks stay per-directory — only volumes are shared.
:::

## Listing volumes

```bash
portler volumes
```

Lists this project's volumes with their volume set, declaring services, size, and the containers using them.

## Forking a volume

```bash
portler volumes fork <volume> <new-set>
```

Clones a volume's data into a `<volume>--<new-set>` variant:

```bash
portler volumes fork postgres-data migration
```

The copy runs `cp -a` inside a throwaway `alpine:3` container, so the original is untouched. `<volume>` can be the short name from portler.yml, a `name--set` variant, or the full Docker volume name. Both the source and the newly-created target must carry this project's ownership label; a name match alone never authorizes reading, overwriting, or rollback-removing volume data.

## Volume sets

```bash
portler up --volume-set <name>
```

Runs the stack against the `--<name>` variants of **all** `@` volumes. `PORTLER_VOLUME_SET=<name>` works as an environment fallback, which is handy as a per-worktree default (e.g. via direnv). Volume set names may contain `a-z0-9_.-` but not `--`.

Starting with a set that was never forked creates a fresh **empty** variant. When the base volume or other sets already exist for that volume — usually a sign of a typo — `up` prints a warning first (with a did-you-mean suggestion) but still proceeds; fork an existing volume instead if you wanted its data.

### The worktree flow

1. Create a worktree for your branch:
   ```bash
   git worktree add ../myapp-migration migration-branch
   ```
2. Fork the database volume:
   ```bash
   portler volumes fork postgres-data my-branch
   ```
3. Run the worktree's stack against the fork:
   ```bash
   cd ../myapp-migration
   portler up --volume-set my-branch
   ```

Now you can test a destructive migration without touching the original data. Avoid running two stacks against the **same** volume at once.

## Removing volumes

```bash
portler volumes remove <volume> [--force]
```

Removes a project volume. Portler requires its project ownership label and refuses while a running container mounts it. `--force` bypasses only the in-use check—it never authorizes deletion of an unlabelled or foreign volume.

Older Portler versions could leave a managed-name volume unlabelled. Inspect such a legacy volume yourself with `docker volume inspect <name>`; after confirming its data is disposable, remove it manually with `docker volume rm <name>`. Portler deliberately provides no ownership bypass.

## Requirements

All volume commands need the Docker daemon; when it is not running they fail with a clear error.
