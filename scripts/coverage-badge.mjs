import { readFileSync, writeFileSync } from "node:fs";

const summary = JSON.parse(readFileSync("coverage/coverage-summary.json", "utf8"));
const { total, covered } = summary.total.lines;
if (!Number.isInteger(total) || total <= 0 || !Number.isInteger(covered) || covered < 0 || covered > total) {
  throw new Error("Coverage summary must contain measured JavaScript line counts.");
}
const percent = Math.round(covered / total * 1000) / 10;
writeFileSync("coverage/coverage-badge.json", `${JSON.stringify({
  schemaVersion: 1,
  label: "JS line coverage",
  message: `${percent}%`,
  color: percent >= 90 ? "brightgreen" : percent >= 75 ? "green" : percent >= 50 ? "yellow" : "orange"
}, null, 2)}\n`);
