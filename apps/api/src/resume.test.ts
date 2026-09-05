import { describe, expect, it } from "vitest";
import { resumeCheckpoint } from "./resume.js";

const empty = {
  managerPlan: null,
  researchReport: null,
  patchProposal: null,
  testReport: null,
  reviewReport: null,
  diff: null,
  approvalHash: null,
};

describe("resumeCheckpoint", () => {
  it.each([
    [empty, "QUEUED"],
    [{ ...empty, managerPlan: {} }, "RESEARCHING"],
    [{ ...empty, managerPlan: {}, researchReport: {} }, "CODING"],
    [{ ...empty, patchProposal: {}, diff: "patch" }, "TESTING"],
    [{ ...empty, patchProposal: {}, diff: "patch", testReport: { passed: true } }, "REVIEWING"],
    [
      {
        ...empty,
        patchProposal: {},
        diff: "patch",
        testReport: { passed: true },
        reviewReport: { decision: "approve" },
        approvalHash: "hash",
      },
      "AWAITING_HUMAN_APPROVAL",
    ],
  ] as const)("selects the latest durable checkpoint", (task, expected) => {
    expect(resumeCheckpoint(task)).toBe(expected);
  });
});
