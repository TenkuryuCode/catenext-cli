import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "./config.js";

const VALID = `
schema_version: 1
project_id: 6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f
repo_name: backend
stack: [go, postgres]
`;

describe("parseConfig", () => {
  it("membaca config valid", () => {
    expect(parseConfig(VALID)).toMatchObject({ repo_name: "backend", stack: ["go", "postgres"] });
  });

  it("memberi pesan yang menyebut field bermasalah", () => {
    expect(() => parseConfig(VALID.replace("backend", "Back End"))).toThrow(/repo_name/);
  });

  it("menolak schema_version yang lebih baru dari CLI", () => {
    expect(() => parseConfig(VALID.replace("schema_version: 1", "schema_version: 2"))).toThrow(
      /Perbarui CLI/,
    );
  });

  it("menolak YAML rusak", () => {
    expect(() => parseConfig("a: [")).toThrow(ConfigError);
  });
});
