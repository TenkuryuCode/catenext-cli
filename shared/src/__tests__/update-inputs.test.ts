import { describe, expect, it } from "vitest";
import { UpdateEpicInput, UpdatePersonaInput, UpdateProjectInput } from "../api.js";

// PATCH parsial tidak boleh mengisi field yang tidak dikirim dengan nilai default.
describe("skema update parsial", () => {
  it("UpdateProjectInput hanya berisi field yang dikirim", () => {
    expect(UpdateProjectInput.parse({ name: "Nama baru" })).toEqual({ name: "Nama baru" });
  });

  it("UpdateProjectInput menolak nama kosong", () => {
    expect(UpdateProjectInput.safeParse({ name: "   " }).success).toBe(false);
  });

  it("UpdatePersonaInput tidak mengosongkan rules saat hanya role diubah", () => {
    expect(UpdatePersonaInput.parse({ role: "backend" })).toEqual({ role: "backend" });
  });

  it("UpdateEpicInput hanya berisi field yang dikirim", () => {
    expect(UpdateEpicInput.parse({ title: "Epic baru" })).toEqual({ title: "Epic baru" });
  });
});
