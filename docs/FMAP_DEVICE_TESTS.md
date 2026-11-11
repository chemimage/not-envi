# fmap physical-device test protocol

Automated Chromium desktop and iPhone/Pixel emulation, the >4 GiB on-disk gate,
and offline packaged-HTML tests run in CI. Physical iOS/iPadOS Safari and
Android Chrome need the following manual run before default enablement.

## Record the environment

For each run record device model, OS and browser versions, file size, storage
provider (local Files/drive, removable media, or cloud-backed), page/pool/request
limits, and the tested commit. Use an ENVI BSQ Float32 dataset larger than the
device's physical RAM, plus small known-value BSQ, BIL/BIP, and TIFF fixtures.

Keep the file on the chosen provider. Open it with the viewer's file picker or
drag-and-drop. A path string alone does not grant the browser file access.

## Exercise the viewer

1. Open the hosted viewer with `?fmap=1`. Record time to a useful view.
2. Pan and zoom repeatedly; change bands while an overview is loading.
3. Repeatedly probe the same point, then probe distant points. Compare spectra
   and representative pixel values with a small independently checked region.
4. Start area/histogram work, immediately move to a different view, and confirm
   foreground interaction continues and obsolete results do not replace it.
5. Open multiple datasets, hide them, close them, and repeat. Record memory
   observations and any tab reload/termination. The whole-application allocator
   is deferred, so an enforced global memory plateau is not an acceptance claim.
6. Open BIL/BIP, another ENVI numeric type, and TIFF; confirm their existing
   fallback renders the expected values with fmap requested.
7. Repeat with the downloaded single HTML in airplane mode where that device
   supports executing local HTML. Record provider/OS restrictions separately.

For performance measurements, use at least 20 cold/distinct views, warm views,
adjacent pans, and spectra. Record p50/p95 latency, browser-delivered/copy bytes,
configured resident allocation, and any available browser memory observation.
The automated benchmark command is documented in `tests/README.md`; its
synthetic File workload is a desktop reference, not a physical-storage result.

## Evidence table

No physical-device runs have been recorded yet.

| Device / browser | File and provider | Commit / limits | Correct values | Latency / stability |
| --- | --- | --- | --- | --- |
| iOS/iPadOS Safari | pending | pending | pending | pending |
| Android Chrome | pending | pending | pending | pending |
