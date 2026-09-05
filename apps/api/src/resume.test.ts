import { describe, expect, it } from "vitest";
import { resumeCheckpoint } from "./resume.js";

const empty = {
  managerPlan: null,
  researchReport: null,
  reproductionReport: null,
  patchProposal: null,
  testReport: null,
  reviewReport: null,
  diff: null,
  approvalHash: null,
};

const plan = { objective: "fix" };
const research = { diagnosis: "x" };
const reproduced = { reproduced: true, testPath: "test/repro.test.js" };
const patch = { summary: "fix" };
const verified = { passed: true, reproductionFixed: "passed" };

describe("resumeCheckpoint", () => {
  it("starts from the beginning with nothing persisted", () => {
    expect(resumeCheckpoint(empty)).toBe("QUEUED");
  });

  it("resumes research once a plan exists", () => {
    expect(resumeCheckpoint({ ...empty, managerPlan: plan })).toBe(
      "RESEARCHING",
    );
  });

  it("resumes reproduction once research exists", () => {
    expect(
      resumeCheckpoint({
        ...empty,
        managerPlan: plan,
        researchReport: research,
      }),
    ).toBe("REPRODUCING");
  });

  it("does not resume coding until the bug was reproduced", () => {
    // Without a failing test there is no oracle, so coding cannot begin.
    expect(
      resumeCheckpoint({
        ...empty,
        managerPlan: plan,
        researchReport: research,
        reproductionReport: { reproduced: false },
      }),
    ).toBe("REPRODUCING");
  });

  it("resumes coding once the bug was reproduced", () => {
    expect(
      resumeCheckpoint({
        ...empty,
        managerPlan: plan,
        researchReport: research,
        reproductionReport: reproduced,
      }),
    ).toBe("CODING");
  });

  it("resumes testing once a patch and diff exist", () => {
    expect(
      resumeCheckpoint({
        ...empty,
        managerPlan: plan,
        researchReport: research,
        reproductionReport: reproduced,
        patchProposal: patch,
        diff: "--- a\n+++ b",
      }),
    ).toBe("TESTING");
  });

  it("does not treat a patch without a diff as a completed coding stage", () => {
    expect(
      resumeCheckpoint({
        ...empty,
        managerPlan: plan,
        researchReport: research,
        reproductionReport: reproduced,
        patchProposal: patch,
      }),
    ).toBe("CODING");
  });

  it("resumes review once tests both passed and proved the fix", () => {
    expect(
      resumeCheckpoint({
        ...empty,
        managerPlan: plan,
        researchReport: research,
        reproductionReport: reproduced,
        patchProposal: patch,
        diff: "d",
        testReport: verified,
      }),
    ).toBe("REVIEWING");
  });

  it("re-tests when the suite passed but the bug is still not fixed", () => {
    // A green regression suite is not a verified stage if the reproduction
    // test still fails.
    expect(
      resumeCheckpoint({
        ...empty,
        managerPlan: plan,
        researchReport: research,
        reproductionReport: reproduced,
        patchProposal: patch,
        diff: "d",
        testReport: { passed: true, reproductionFixed: "failed" },
      }),
    ).toBe("TESTING");
  });

  it("returns to the human gate for an approved review with a fingerprint", () => {
    expect(
      resumeCheckpoint({
        ...empty,
        managerPlan: plan,
        researchReport: research,
        reproductionReport: reproduced,
        patchProposal: patch,
        diff: "d",
        testReport: verified,
        reviewReport: { decision: "approve" },
        approvalHash: "abc",
      }),
    ).toBe("AWAITING_HUMAN_APPROVAL");
  });

  it("never returns to the human gate for a rejected review", () => {
    expect(
      resumeCheckpoint({
        ...empty,
        managerPlan: plan,
        researchReport: research,
        reproductionReport: reproduced,
        patchProposal: patch,
        diff: "d",
        testReport: verified,
        reviewReport: { decision: "reject" },
        approvalHash: "abc",
      }),
    ).toBe("REVIEWING");
  });

  it("never returns to the human gate without a fingerprint", () => {
    expect(
      resumeCheckpoint({
        ...empty,
        managerPlan: plan,
        researchReport: research,
        reproductionReport: reproduced,
        patchProposal: patch,
        diff: "d",
        testReport: verified,
        reviewReport: { decision: "approve" },
      }),
    ).toBe("REVIEWING");
  });
});
