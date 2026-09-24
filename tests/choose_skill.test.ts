import { describe, expect, it } from "vitest";
import { chooseSkill } from "../src/tools/choose_skill.js";
import type { JevAdapter } from "../src/jev/adapter.js";

const skills = [
  { id: "slides", description: "Create presentations" },
  { id: "pdf", description: "Create PDFs" },
];

describe("chooseSkill", () => {
  it("accepts a selected available skill", async () => {
    const jev: JevAdapter = { decide: async () => ({ choice: "slides" }) };
    expect((await chooseSkill(jev, "Make slides", skills)).choice).toBe("slides");
  });
  it("rejects a hallucinated skill", async () => {
    const jev: JevAdapter = { decide: async () => ({ choice: "unknown" }) };
    expect((await chooseSkill(jev, "Make slides", skills)).choice).toBeNull();
  });
  it("does not call Jev without options", async () => {
    const jev: JevAdapter = { decide: async () => { throw Error("must not call"); } };
    expect((await chooseSkill(jev, "anything", [])).choice).toBeNull();
  });
});
