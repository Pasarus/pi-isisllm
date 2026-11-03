// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Samuel Jones

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, normalizeBaseUrl, parseSettings } from "../config.js";

const tempDirs: string[] = [];

function settingsFileWith(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-isisllm-config-"));
  tempDirs.push(dir);
  const path = join(dir, "pi-isisllm.json");
  writeFileSync(path, contents, "utf-8");
  return path;
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("normalizeBaseUrl", () => {
  it("strips trailing slashes and ignores blanks", () => {
    expect(normalizeBaseUrl("https://gw.example.test/v1///")).toBe("https://gw.example.test/v1");
    expect(normalizeBaseUrl("   ")).toBe("https://isisllm.rl.ac.uk/v1");
  });
});

describe("parseSettings", () => {
  it("accepts the documented fields", () => {
    const { settings, warnings } = parseSettings(
      JSON.stringify({
        baseUrl: "https://gw.example.test/v1",
        apiKeyEnv: "MY_GATEWAY_KEY",
        timeoutMs: 1500,
        exclude: ["^sandbox-"],
        models: { "qwen3-x": { reasoning: true } },
        quietModelsJsonWarning: true,
      }),
    );
    expect(warnings).toEqual([]);
    expect(settings).toEqual({
      baseUrl: "https://gw.example.test/v1",
      apiKeyEnv: "MY_GATEWAY_KEY",
      timeoutMs: 1500,
      exclude: ["^sandbox-"],
      models: { "qwen3-x": { reasoning: true } },
      quietModelsJsonWarning: true,
    });
  });

  it("drops invalid fields with warnings instead of throwing", () => {
    const { settings, warnings } = parseSettings(
      JSON.stringify({
        baseUrl: 12,
        apiKeyEnv: "not an env var",
        timeoutMs: "soon",
        exclude: "embed",
        models: [],
      }),
    );
    expect(settings).toEqual({});
    expect(warnings).toHaveLength(5);
    expect(warnings.join("\n")).toContain("apiKeyEnv");
  });

  it("clamps timeouts and reports unparsable files", () => {
    expect(parseSettings('{"timeoutMs": 1}').settings.timeoutMs).toBe(1000);
    expect(parseSettings('{"timeoutMs": 999999}').settings.timeoutMs).toBe(120000);
    const broken = parseSettings("{oops");
    expect(broken.settings).toEqual({});
    expect(broken.warnings[0]).toContain("not valid JSON");
    expect(parseSettings("[1,2]").warnings[0]).toContain("JSON object");
  });
});

describe("loadConfig", () => {
  it("prefers ISISLLM_BASE_URL over the settings file", () => {
    const path = settingsFileWith(JSON.stringify({ baseUrl: "https://from-settings.test/v1" }));
    const fromSettings = loadConfig({ env: {}, settingsPath: path });
    expect(fromSettings.baseUrl).toBe("https://from-settings.test/v1");
    expect(fromSettings.modelsUrl).toBe("https://from-settings.test/v1/models");

    const fromEnv = loadConfig({
      env: { ISISLLM_BASE_URL: "https://from-env.test/v1" },
      settingsPath: path,
    });
    expect(fromEnv.baseUrl).toBe("https://from-env.test/v1");
  });

  it("exposes bundled presets and the default key env var", () => {
    const path = settingsFileWith("{}");
    const config = loadConfig({ env: {}, settingsPath: path });
    expect(Object.keys(config.presets.models ?? {})).toContain("qwen3-coder-next");
    expect(config.apiKeyEnv).toBe("ISISLLM_API_KEY");
    expect(config.timeoutMs).toBe(8000);
  });
});
