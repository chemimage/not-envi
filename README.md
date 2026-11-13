# not-envi

[![CI](https://github.com/chemimage/not-envi/actions/workflows/ci.yml/badge.svg?branch=main&event=push)](https://github.com/chemimage/not-envi/actions/workflows/ci.yml)
[![JS line coverage](https://img.shields.io/endpoint?url=https%3A%2F%2Fchemimage.github.io%2Fnot-envi%2Fcoverage-badge.json)](https://chemimage.github.io/not-envi/coverage-summary.json)
[![Latest release](https://img.shields.io/github/v/release/chemimage/not-envi)](https://github.com/chemimage/not-envi/releases/latest)

A lightweight, browser-based hyperspectral data viewer for band browsing,
simple spatial-spectral statistics, and format conversion.

Use **Stack all** / **Split all** in chart title bars to compare calculated
spectra, histograms, or line profiles. Lines are solid and retain their source
colors; each brush color owns one line and its profile window. See
[plot comparisons](docs/plot-comparisons.md).

## Development

Requires Node.js 22 and Git.

- `npm ci`
- `npm run dev`

The C/WASM fmap backend is built in and always enabled. TIFF formats outside
its supported paths continue to use the compatible decoder automatically.
TIFF parsing and bounded compressed decoding use a pinned libtiff WASM build;
see [reader architecture and rebuild instructions](docs/libtiff-reader.md).

### Tests

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

### Preparing a release

`npm run version:calc` previews the next stable version using Git tags and
`+semver:` commit-body annotations. It runs in Node.js, with no additional SDK.
The highest bump wins across an unreleased batch; feature commits do not
each add another minor version. Unannotated commits default to a patch;
`+semver: none` leaves that commit out of the bump calculation. CI uses the same
calculator. Full Git history and release tags must be available.

After a successful push-to-main CI run, `Publish release and Pages` automatically
creates the calculated `vX.Y.Z` tag, publishes the release, and deploys Pages.
It downloads `site-dist` from that exact run and verifies commit/version/hashes;
it does not rebuild. CI stamps the calculated version into its build checkout
before packaging and offline tests, so the viewer reports the published version.
The source package files need not receive a separate version-bump commit.

Only the latest main commit is eligible. Failed/canceled CI cannot publish.
Commits containing only `+semver: none` do not create a new release when the
calculated version already belongs to an earlier tag. Rerunning publication for
the same tagged commit can repair a failed release/Pages publication without
moving its tag. Review `docs/releases/vX.Y.Z.md` before pushing a release batch;
authored notes are used when present, otherwise GitHub generates release notes.
Release titles exactly match the version tag.

Manual tag publication remains available for recovery. Select a stable version
tag for the Publish release or Deploy Pages workflow. They retrieve successful
CI for that exact commit on main, normalize the build version, and verify the
same artifact. CI retains artifacts for 30 days. If one expires, manually run
CI selecting that tag and rerun the publication after CI succeeds.

### Deploy to the lab server

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
