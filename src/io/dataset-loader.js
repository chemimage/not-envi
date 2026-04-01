import {
  addDatasetFromFiles as addEnviDatasetFromFiles,
  addDatasetsFromFileList as addEnviDatasetsFromFileList
} from "./envi-loader.js";
import {
  addDatasetFromFile as addTiffDatasetFromFile,
  addDatasetsFromFileList as addTiffDatasetsFromFileList,
  isTiffFile
} from "./tiff-loader.js";

export async function addDatasetsFromFileList(files, deps = {}) {
  const list = Array.from(files || []);
  if (!list.length) {
    return { datasets: [], missing: [], headersFound: 0, directFound: 0 };
  }

  const tiffFiles = list.filter((file) => isTiffFile(file));
  const otherFiles = list.filter((file) => !isTiffFile(file));

  const [enviResult, tiffResult] = await Promise.all([
    addEnviDatasetsFromFileList(otherFiles, deps),
    addTiffDatasetsFromFileList(tiffFiles, deps)
  ]);

  return {
    datasets: [...(enviResult.datasets || []), ...(tiffResult.datasets || [])],
    missing: enviResult.missing || [],
    headersFound: Number(enviResult.headersFound) || 0,
    directFound: Number(tiffResult.directFound) || 0
  };
}

export async function addDatasetFromFiles(hdrFile, dataFile, deps = {}) {
  if (!dataFile && isTiffFile(hdrFile)) {
    return addTiffDatasetFromFile(hdrFile, deps);
  }
  return addEnviDatasetFromFiles(hdrFile, dataFile, deps);
}
