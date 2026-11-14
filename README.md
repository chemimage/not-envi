# not-envi

[![CI](https://github.com/chemimage/not-envi/actions/workflows/ci.yml/badge.svg?branch=main&event=push)](https://github.com/chemimage/not-envi/actions/workflows/ci.yml)
[![JS line coverage](https://img.shields.io/endpoint?url=https%3A%2F%2Fchemimage.github.io%2Fnot-envi%2Fcoverage-badge.json)](https://chemimage.github.io/not-envi/coverage-summary.json)
[![Latest release](https://img.shields.io/github/v/release/chemimage/not-envi)](https://github.com/chemimage/not-envi/releases/latest)

A lightweight, browser-based hyperspectral data viewer for band browsing,
simple spatial-spectral statistics, and format conversion.

[Open the viewer](https://chemimage.github.io/not-envi/) or
[download the standalone HTML](https://github.com/chemimage/not-envi/releases/latest)
for offline use.

## Development

With Node.js 22:

```sh
npm ci
npm run dev
```

Run `npm run build` to create `dist/index.html`.
See [development notes](docs/development.md) for testing, builds, and releases.
