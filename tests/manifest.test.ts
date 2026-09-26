import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import pkg from "../package.json";
import { DEFAULTS, PLUGIN_NAME, parseSettings } from "../src/settings.ts";

const ROOT = resolve(import.meta.dir, "..");

test("package name is the key omp stores settings under", () => {
  expect(pkg.name).toBe(PLUGIN_NAME);
});

test("every omp extension entry point exists", () => {
  for (const entry of pkg.omp.extensions) expect(existsSync(join(ROOT, entry))).toBe(true);
});

test("manifest setting defaults match the code's defaults", () => {
  const defaults = Object.fromEntries(
    Object.entries(pkg.omp.settings).map(([key, schema]) => [key, schema.default]),
  );
  expect(parseSettings(defaults)).toEqual(DEFAULTS);
  expect(Object.keys(pkg.omp.settings).sort()).toEqual(Object.keys(DEFAULTS).sort());
});
