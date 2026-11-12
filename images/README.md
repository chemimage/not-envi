# Favicon source

`ciViewer.ico` is the unchanged application icon used by QCL-PT / ciMicroscope:

- Source: [`Cisl.CiMicroscope.Desktop/Resources/Brand/ciMicroscope.ico`](https://github.com/chemimage/QCL-PT/blob/6b29d949551e3fc9e70c6eeb1f0c0fe53d399392/Cisl.CiMicroscope.Desktop/Resources/Brand/ciMicroscope.ico)
- The desktop project selects this file through its `ApplicationIcon` property.
- The icon contains a 256 x 256 RGBA PNG frame; browsers scale it to tab size.
- Vite embeds it as a data URL in the single-file distribution, so it also works offline.
