# Hyve

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
