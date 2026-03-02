import { describe, expect, test } from "vitest";
import {
  formatExperimentSettingsInline,
  normalizeExperimentKey,
  parseExperimentSettings
} from "../../src/app/experiment-meta.js";

describe("experiment meta formatting", () => {
  test("normalizes keys into readable labels", () => {
    expect(normalizeExperimentKey("exposure_time_ms")).toBe("Exposure time ms");
    expect(normalizeExperimentKey("laserPower")).toBe("Laser power");
    expect(normalizeExperimentKey("camera-gain")).toBe("Camera gain");
  });

  test("parses JSON dictionary description", () => {
    const entries = parseExperimentSettings('{"laserPower":45,"scan_mode":"fast","flags":{"a":1}}');
    expect(entries).toEqual([
      { key: "laserPower", label: "Laser power", value: "45" },
      { key: "scan_mode", label: "Scan mode", value: "fast" },
      { key: "flags", label: "Flags", value: "{\"a\":1}" }
    ]);
  });

  test("formats parsed entries inline with separators", () => {
    const text = formatExperimentSettingsInline([
      { label: "Laser power", value: "45" },
      { label: "Scan mode", value: "fast" }
    ]);
    expect(text).toBe("Laser power: 45 | Scan mode: fast");
  });

  test("returns empty list for non-json description", () => {
    expect(parseExperimentSettings("not a json dict")).toEqual([]);
  });

  test("parses ENVI-tokenized array description", () => {
    const entries = parseExperimentSettings([
      "\"laserPower\":45",
      "\"scan_mode\":\"fast\""
    ]);
    expect(entries).toEqual([
      { key: "laserPower", label: "Laser power", value: "45" },
      { key: "scan_mode", label: "Scan mode", value: "fast" }
    ]);
  });

  test("parses loose key/value format", () => {
    const entries = parseExperimentSettings("laserPower=45, scan_mode=fast");
    expect(entries).toEqual([
      { key: "laserPower", label: "Laser power", value: "45" },
      { key: "scan_mode", label: "Scan mode", value: "fast" }
    ]);
  });
});
