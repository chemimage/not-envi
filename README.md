# not-envi

[![CI](https://github.com/chemimage/not-envi/actions/workflows/ci.yml/badge.svg?branch=main&event=push)](https://github.com/chemimage/not-envi/actions/workflows/ci.yml)
[![JS line coverage](https://img.shields.io/endpoint?url=https%3A%2F%2Fchemimage.github.io%2Fnot-envi%2Fcoverage-badge.json)](https://chemimage.github.io/not-envi/coverage-summary.json)
[![Latest release](https://img.shields.io/github/v/release/chemimage/not-envi)](https://github.com/chemimage/not-envi/releases/latest)

A lightweight, browser-based hyperspectral data viewer for band browsing,
simple spatial-spectral statistics, and format conversion.

Use **Stack** / **Split** in chart title bars to compare calculated
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

Use `+semver:` annotations (`patch`, `minor`, `major`, or `none`) in commit bodies.
Preview the next version with `npm run version:calc`.

Push to `main`; after CI passes, publication automatically creates the version
tag and release, then deploys Pages using the tested build. Optional release
notes go in `docs/releases/vX.Y.Z.md`.

### Deploy to the lab server

On Windows, run `build-and-deploy-remote.bat` with authenticated `gh` and
`ssh`/`scp` access via the `inference` alias. It deploys the latest successful
main CI build to `/srv/www/hyve`.

Add `--download-only` to download and verify without deploying.
