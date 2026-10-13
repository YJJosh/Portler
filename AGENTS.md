# AGENTS.md

Notes for coding agents working on the Portler source. For how to *use*
Portler in another project, see [`skills/portler/SKILL.md`](skills/portler/SKILL.md);
user documentation lives in [`docs/`](docs/).

## Setup and checks

- Node 22.6 or newer and npm (`package-lock.json` is committed). There are no
  runtime dependencies; YAML and `.env` parsing live in `src/parse/`.
- The source is TypeScript that Node runs directly with type stripping.
  Imports use `.ts` extensions, which `tsc` rewrites on build. Only erasable
  syntax works: no `enum`, `namespace` or constructor parameter properties.
- Before opening a PR, run what CI runs:

  ```sh
  npm run verify       # typecheck (including tests), tests, build, smoke
  npm pack --dry-run   # the files the npm package would contain
  npm run docs:build   # the docs site; dead links fail the build
  ```

- One test file: `node --experimental-strip-types --test test/stop.test.ts`.
- `npm run dev -- <args>` runs the CLI from source (Node 23.6+; on Node 22 use
  `node --experimental-strip-types bin/portler.ts`). `npm run dev:link`
  installs the build as `devportler`, leaving an installed `portler` alone.

## Tests

- CI runs on Ubuntu and macOS with Node 22 and 24. Windows is not supported.
- No test needs real Docker or Kubernetes; they use fake `docker` and
  `kubectl` shell scripts.
- Tests that touch the port registry set `PORTLER_GLOBAL_DIR` to a temp
  directory. New tests must do the same, so they never touch `~/.portler`.
- Three zombie-process tests in `pids.test.ts` and `stop.test.ts` only run on
  Linux. On macOS, run them in a container (`--init` reaps orphans, which a
  plain PID 1 does not):

  ```sh
  docker run --rm --init -v "$PWD":/work:ro -w /work node:22 \
    node --experimental-strip-types --test test/pids.test.ts test/stop.test.ts
  ```

- Test files run in parallel and some bind real ports. A rare `EADDRINUSE` or
  readiness timeout is usually two files colliding on a port: rerun that file
  on its own before debugging.

## Layout

- `bin/portler.ts`: entry point. `src/index.ts`: the public library API.
- `src/cli/`: argument parsing (`args.ts`), help text (`help.ts`), the
  `portler init` sample (`sample.ts`) and one file per command in `commands/`.
- `src/config/`: loading and validating `portler.yml`.
- `src/process/`: spawning, liveness, stopping, Docker ownership.
- `src/ports/`: allocation and the global registry. `src/state/`: `.portler/`
  files and locks.
- `src/env/`, `src/setup/`, `src/readiness/`, `src/proxy/`, `src/k8s/`,
  `src/volumes/`: the features their names say.

## Rules that must hold

These describe how the code protects users' processes and data today. The
exceptions listed are deliberate: keep them, and call out any new one in the
PR description.

- Signal a process group only when Portler can prove it is ours: the leader's
  recorded start token matches now (`maySignal` in
  `src/process/identity.ts`), or it matched earlier in the same stop while the
  group stayed alive, so `down` can still stop children after the leader exits
  (`provenOurs` in `signalDecision`, `src/process/stop.ts`). When in doubt,
  treat it as not ours and still running. Only `down --force` and
  `clean --force` (both through the `force` option of `stopServices`) signal
  an unverifiable process, and never one whose pid was provably reused.
- Only touch existing Docker containers, networks and volumes, or Kubernetes
  resources, labelled as this project's (`src/process/ownership.ts`), and
  re-check ownership right before a destructive call. The unlabelled things
  Portler removes are tied to something it owns or just created: a removed
  container's own anonymous volumes (`removeOwnedContainer` runs
  `docker rm -f -v` on a container it verified as ours, so an image `VOLUME`
  does not leak; `test/ownership.test.ts`), and the `--rm` copy container that
  `volumes fork` starts (`forkVolume` in `src/volumes/manager.ts`).
- `down` never deletes named volumes. Only `portler volumes remove` deletes
  existing ones, and only those this project owns. The one other deletion is
  `volumes fork` rolling back the target it just created when the copy fails,
  again only while it is still ours.
- Change `.portler/` state and the registry only under the existing locks
  (`src/state/lock.ts`, `src/ports/lock.ts`).

## Keep docs in sync

A change to a command, flag or config key also updates:

- `src/cli/help.ts` and `docs/reference/cli/<command>.md`;
- for a new or renamed command, also the table in `docs/reference/cli/index.md`
  and the sidebar list in `docs/.vitepress/config.mts` (the docs build does not
  catch these);
- `docs/reference/configuration.md` for config keys;
- `skills/portler/SKILL.md` if it changes how an agent should use Portler.

The `portler.yml` format may still change in breaking ways before 1.0. Call
out any breaking change in the PR description so it reaches the release notes.

## Releases

- The docs site deploys automatically when a release is published, and a
  maintainer can also run **deploy docs** by hand. The skill installs from
  `main`.
- A maintainer runs the GitHub Actions in order: **1. Prepare version PR**
  opens the version bump, then after it is merged **prepare release** tags
  `main` and drafts the notes, and publishing that draft runs **npm publish**
  and **deploy docs**. Feature PRs don't change the version in `package.json`.
