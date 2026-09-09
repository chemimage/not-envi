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

  test("parses a JSON description and formats its entries for display", () => {
    const entries = parseExperimentSettings('{"laserPower":45,"scan_mode":"fast","flags":{"a":1}}');
    expect(entries).toEqual([
      { key: "laserPower", label: "Laser power", value: "45" },
      { key: "scan_mode", label: "Scan mode", value: "fast" },
      { key: "flags", label: "Flags", value: "{\"a\":1}" }
    ]);
    expect(formatExperimentSettingsInline(entries)).toBe(
      'Laser power: 45 | Scan mode: fast | Flags: {"a":1}'
    );
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
