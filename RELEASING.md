# Releasing Portler

Keep `main` protected. Version changes go through a pull request; the **prepare
release** workflow never commits or pushes to `main`.

## 1. Merge the version bump

Starting from an up-to-date `main` in a clean checkout:

```sh
git switch -c release/0.2.1
npm version 0.2.1 --no-git-tag-version --ignore-scripts
git add package.json package-lock.json
git commit -m "Release v0.2.1"
git push -u origin release/0.2.1
gh pr create --base main --title "Release v0.2.1" --body "Prepare the package version for release."
```

Replace `0.2.1` with the next stable semantic version. Review the PR, wait for CI
to pass, and merge it. Both package files, including the root package entry in
`package-lock.json`, must contain the release version.

## 2. Prepare a draft from main

In GitHub Actions, run **prepare release** on `main` with the merged version
(without the `v` prefix), or use:

```sh
gh workflow run prepare-release.yml --ref main -f version=0.2.1
```

The workflow rejects a version that does not match the committed package files.
It installs dependencies, verifies the release contents, checks that tracked
files remain unchanged, tags the exact checked-out `main` commit, and creates a
draft GitHub Release with generated notes. It does not publish to npm.

## 3. Review and publish

Open the draft under GitHub Releases and review its notes. Keep the hidden
`<!-- release-sha:... -->` comment: the publish workflow uses it to verify that
the tag still points to the reviewed commit.

Publish the draft manually. This starts **npm publish**, which verifies the
version and commit again, runs the package checks, and publishes using npm
trusted publishing. Confirm that the workflow succeeds before announcing the
release. Neither merging the version PR nor creating a tag publishes to npm.

## Retrying

- If version validation fails, fix and merge the package files through a PR,
  then start a fresh **prepare release** run on `main`.
- If a draft already exists, review and publish that draft rather than preparing
  another release for the same version.
- If a run created the tag but failed before creating the draft, rerunning that
  job can reuse the tag only when it points to the same checked-out commit. If
  `main` has advanced, stop and inspect the partial release before retrying;
  never move or force-push a release tag.
