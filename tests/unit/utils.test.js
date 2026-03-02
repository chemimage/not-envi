import { describe, expect, test } from "vitest";
import { clamp, fmt, fmtNoGroup, fmtUm, humanBytes } from "../../src/core/utils.js";

describe("utils", () => {
  test("clamp bounds values", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });

  test("humanBytes formats units", () => {
    expect(humanBytes(0)).toBe("0 B");
    expect(humanBytes(1024)).toBe("1.0 KB");
    expect(humanBytes(1024 * 1024)).toBe("1.0 MB");
  });

  test("formatters return stable numeric strings", () => {
    expect(fmt(12.34)).toBe("12.34");
    expect(fmtNoGroup(1234.5)).toBe("1234.5");
    expect(fmtUm(3.4567)).toBe("3.457");
  });
});
