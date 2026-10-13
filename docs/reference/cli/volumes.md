# portler volumes

Manage this project's Portler-managed Docker volumes. See the [Volumes guide](/guide/volumes) for concepts and the worktree workflow.

```bash
portler volumes [list] [--prod]
portler volumes fork <volume> <new-set> [--prod]
portler volumes remove <volume> [--force] [--prod]
```

All volume commands need the Docker daemon; when it is not running they fail with a clear error. With `--prod` they work on the production volumes of a project that sets `name:` (`portler-<name>--<volume>`, listed by their owner label); see [Stable identity on a server](/guide/setup-and-production#stable-identity-on-a-server).

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
- The target must not exist yet. If two forks into the same target race, only the one that created it copies; the other fails with "another fork created target volume … at the same time" rather than mixing two datasets.

Run the stack against the fork with `portler up --volume-set migration`. A fork made with `--prod` (or `--file`) lives in that scope, so run `up` with the same flags: `portler up --prod --volume-set migration`. Without them `up` would mount the development variant instead. The command Portler prints after the fork already includes them.

## `volumes remove <volume> [--force]`

Removes a project volume. This destroys its data for good, so Portler refuses when:

- a running container mounts the volume, or
- the volume is not labelled `portler.project=<project>`, meaning Portler cannot confirm it created it.

`--force` overrides **only** the in-use protection; ownership is never bypassed. An older Portler may have let `docker run -v` create a legitimately expected but unlabelled volume. Portler will not delete that legacy volume: inspect it explicitly with `docker volume inspect <name>`, confirm its data is disposable, then remove it manually with `docker volume rm <name>`.
