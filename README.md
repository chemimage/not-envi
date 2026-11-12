# Hyve

Versioning follows SemVer, starting at `1.0.0`.

The Tailwind CSS 4 build requires Safari 16.4+, Chrome 111+, or Firefox 128+.
See the [Tailwind browser requirements](https://tailwindcss.com/docs/upgrade-guide#browser-requirements).

## Development

- `npm install`
- `npm run dev`

The C/WASM fmap backend is enabled by default. Use `?fmap=0` (or
`?fmap=false`) to use the existing backend, including for TIFF codecs or
photometrics not supported by fmap. `?fmap=1` remains supported.

## Tests

- `npm run test:unit`
- `npm run test:e2e`
- `npm test`

## Production build (single file)

- `npm run build`
- Output: `dist/index.html` (self-contained single file)
