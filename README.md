# not-envi

[![CI](https://github.com/chemimage/not-envi/actions/workflows/ci.yml/badge.svg?branch=main&event=push)](https://github.com/chemimage/not-envi/actions/workflows/ci.yml)
[![Release](https://github.com/chemimage/not-envi/actions/workflows/release.yml/badge.svg?event=push)](https://github.com/chemimage/not-envi/actions/workflows/release.yml)

A lightweight, browser-based hyperspectral data viewer for band browsing,
simple spatial-spectral statistics, and format conversion.

Versioning follows SemVer, starting at `1.0.0`.

The Tailwind CSS 4 build requires Safari 16.4+, Chrome 111+, or Firefox 128+.
See the [Tailwind browser requirements](https://tailwindcss.com/docs/upgrade-guide#browser-requirements).

## Development

- `npm install`
- `npm run dev`

The C/WASM fmap backend is built in and always enabled. There is no backend
selection setting or URL switch. TIFF formats outside its supported paths
continue to use the compatible decoder automatically.

## Tests

- `npm run test:unit`
- `npm run test:e2e`
- `npm test`

## Production build (single file)

- `npm run build`
- Output: `dist/index.html` (self-contained single file)

## Release version

Install the .NET 10 SDK, then run `dotnet tool restore` once.
`npm run version:calc` previews the next stable version using the pinned
GitVersion tool and `+semver:` commit-body annotations since the last tag.
The highest bump wins across an unreleased batch; feature commits do not
each add another minor version. CI calculates the same version independently.

For a release, run `npm run version:prepare` to update both package files,
commit with `+semver: none`, and wait for CI to pass on that exact commit.
Create and push the matching `vX.Y.Z` tag. The tag workflows verify the
calculated version and package files, then publish the HTML and deploy Pages.
Release titles must exactly match the version tag.
