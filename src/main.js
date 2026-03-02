import { collectElements } from "./app/elements.js";
import { createAppState } from "./app/state.js";
import { createExportService } from "./export/export-controller.js";
import { addDatasetsFromFileList } from "./io/dataset-loader.js";
import { createHistogramController } from "./render/histogram.js";
import { createRenderer } from "./render/render-main.js";
import { createSpectrumController } from "./render/spectrum.js";
import { createThumbnailController } from "./render/thumbnail.js";
import { bindCoreEvents } from "./ui/events.js";
import "./legacy/app.js";

// Bootstraps modular seams for progressive migration while preserving current behavior.
const appState = createAppState();
const els = collectElements();
void appState;
void els;
void createRenderer;
void createHistogramController;
void createThumbnailController;
void createSpectrumController;
void createExportService;
void addDatasetsFromFileList;
void bindCoreEvents;
