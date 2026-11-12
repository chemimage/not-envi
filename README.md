# not-envi

[![CI](https://github.com/chemimage/not-envi/actions/workflows/ci.yml/badge.svg?branch=main&event=push)](https://github.com/chemimage/not-envi/actions/workflows/ci.yml)
[![JS line coverage](https://img.shields.io/endpoint?url=https%3A%2F%2Fchemimage.github.io%2Fnot-envi%2Fcoverage-badge.json)](https://chemimage.github.io/not-envi/coverage-summary.json)
[![Latest release](https://img.shields.io/github/v/release/chemimage/not-envi)](https://github.com/chemimage/not-envi/releases/latest)

A lightweight, browser-based hyperspectral data viewer for band browsing,
simple spatial-spectral statistics, and format conversion.

## Development

Requires Node.js 22 and Git.

- `npm ci`
- `npm run dev`

The C/WASM fmap backend is built in and always enabled. TIFF formats outside
its supported paths continue to use the compatible decoder automatically.

## Deploy to the lab server

Run `build-and-deploy-remote.bat` from Windows with Node.js 22+, an authenticated
GitHub CLI (`gh auth login`), and working `ssh`/`scp` access through the local
`inference` SSH alias. Remote installation may prompt for your sudo password.

The script downloads `site-dist` from the latest successful push-to-main CI run,
verifies its commit and SHA-256 hashes, then deploys to `/srv/www/hyve`. It does
not build your local checkout. If newer CI runs failed or are still running,
the selected successful run can be older than main; its URL and commit are
printed before deployment. Missing or expired artifacts stop deployment.

Use `build-and-deploy-remote.bat --download-only` to download and verify without
connecting to the server. The downloaded files remain in the printed temporary
directory for inspection. Normal deployment verifies the uploaded files again
on the server and replaces the single-file app by rename, without clearing the
live directory. GitHub-hosted runners do not need access to the lab network.

## Tests

- `npm run test:unit`
- `npm run test:e2e`
- `npm test`
- `npm run test:coverage`

The coverage badge reports JavaScript line coverage from the published release's
unit and controller tests. It includes all `src/**/*.js` files; browser tests and
C/WASM coverage are separate. The badge updates when a release deploys to Pages.
Local coverage reports are written to `coverage/`.

## Production build (single file)

- `npm run build`
- Output: `dist/index.html` (self-contained single file)

The built viewer uses Tailwind CSS 4 and targets Safari 16.4+, Chrome 111+,
or Firefox 128+. See the [Tailwind browser requirements](https://tailwindcss.com/docs/compatibility).

## Preparing a release

`npm run version:calc` previews the next stable version using Git tags and
`+semver:` commit-body annotations. It runs in Node.js, with no additional SDK.
The highest bump wins across an unreleased batch; feature commits do not
each add another minor version. Unannotated commits default to a patch;
`+semver: none` leaves that commit out of the bump calculation. CI uses the same
calculator. Full Git history and release tags must be available.

For a release, run `npm run version:prepare` to update both package files,
review the release notes in `docs/releases/vX.Y.Z.md`, commit with
`+semver: none`, and wait for CI to pass on that exact commit.
Create and push the matching `vX.Y.Z` tag. The tag workflows retrieve the
`site-dist` artifact from successful CI for that exact commit on main, verify its
commit, calculated version, package files and SHA-256, then publish that same
HTML to the release and Pages. They do not rebuild it. CI retains the artifact
for 30 days; if CI is pending, wait for it before rerunning publication. For
failed CI or an expired artifact, manually dispatch CI selecting the version
tag, then rerun release/Pages after it passes. CI dispatched on that exact tag
is also accepted, provided the tagged commit is reachable from main. Manual
publication must select the version tag.
Release titles must exactly match the version tag.
The release workflow uses that version's authored notes when present, with
GitHub-generated notes as a fallback so a new release has a description.
