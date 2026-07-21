# portler volumes

Manage this project's Portler-managed Docker volumes. See the [Volumes guide](/guide/volumes) for concepts and the worktree workflow.

```bash
portler volumes [list]
portler volumes fork <volume> <new-set>
portler volumes remove <volume> [--force]
```

All volume commands need the Docker daemon; when it is not running they fail with a clear error.

## `volumes` / `volumes list`

Lists this project's volumes with their volume set, declaring services, size, and the containers using them.

## `volumes fork <volume> <new-set>`

Clones a volume's data into a `<volume>--<new-set>` variant:

```bash
portler volumes fork postgres-data migration
```

- The copy runs `cp -a` inside a throwaway `alpine:3` container; the original is untouched.
- `<volume>` can be the short name from portler.yml (`postgres-data`), a `name--set` variant (`postgres-data--migration`), or the full Docker volume name.
- Set names may contain `a-z0-9_.-` but not `--`.

Run the stack against the fork with `portler up --volume-set migration`.

## `volumes remove <volume> [--force]`

Removes a project volume. This destroys its data for good, so Portler refuses when:

- a running container mounts the volume, or
- the volume is not labelled `portler.project=<project>`, meaning Portler cannot confirm it created it.

`--force` overrides **only** the in-use protection; ownership is never bypassed. An older Portler may have let `docker run -v` create a legitimately expected but unlabelled volume. Portler will not delete that legacy volume: inspect it explicitly with `docker volume inspect <name>`, confirm its data is disposable, then remove it manually with `docker volume rm <name>`.
