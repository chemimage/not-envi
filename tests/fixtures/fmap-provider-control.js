export const FMAP_PROVIDER_RELEASE = "fmap-test-release-provider";

/** Instrument the served worker only. The bridge fixture's first provider call
 * waits for an explicit release so a slow CI host cannot race a fixed timeout.
 * Other benchmark files retain their controlled service-delay workload. */
export function instrumentFmapProvider(body, delayMs = 100) {
  const needle = "async function readFile(file, pageSize, stats, offset, length) {";
  if (!body.includes(needle)) throw new Error("Provider timing instrumentation did not match.");
  const prefix = `let releaseTestProvider;
const testProviderGate = new Promise(resolve => { releaseTestProvider = resolve; });
self.addEventListener("message", event => {
  if (event.data?.type === ${JSON.stringify(FMAP_PROVIDER_RELEASE)}) {
    event.stopImmediatePropagation(); releaseTestProvider();
  }
});\n`;
  return prefix + body.replace(needle, `${needle}
if (file.name === "pan-cancel.dat") await testProviderGate;
else await new Promise(resolve => setTimeout(resolve, ${Number(delayMs)}));`);
}
