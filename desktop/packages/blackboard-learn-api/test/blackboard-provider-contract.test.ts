import { readFile } from "node:fs/promises";
import { isJsonObject } from "@morrow/contracts";
import { describe, expect, it } from "vitest";
import {
  assignmentCreateIdentity,
  BLACKBOARD_GROUP_MEMBERSHIP_IDENTITY_FIELD,
  BLACKBOARD_PROVIDER_CONTRACT,
  displayGrade,
  pathScopedContentMatches,
  providerAnnouncementDuration,
  publicAnnouncementDuration,
} from "../src/provider-contract.js";

describe("checked Blackboard provider contract", () => {
  it("matches the compact artifact derived from the pinned public Swagger", async () => {
    const path = new URL("../../../artifacts/blackboard/learn-4000.21.0-contract.json", import.meta.url);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(BLACKBOARD_PROVIDER_CONTRACT);
  });

  it("owns collection identity and path-scoped Content semantics", () => {
    expect(BLACKBOARD_GROUP_MEMBERSHIP_IDENTITY_FIELD).toBe("userId");
    expect(pathScopedContentMatches({ id: "_33_1" }, "_22_1", "_33_1")).toBe(true);
    expect(pathScopedContentMatches({ id: "_33_1", courseId: "_22_1" }, "_22_1", "_33_1")).toBe(true);
    expect(pathScopedContentMatches({ id: "_33_1", courseId: "_99_1" }, "_22_1", "_33_1")).toBe(false);
  });

  it("parses official assignment identities and maps announcement vocabulary", () => {
    expect(assignmentCreateIdentity({ contentId: "_33_1", gradeColumnId: "_44_1", assessmentId: "_55_1" }))
      .toEqual({ contentId: "_33_1", gradeColumnId: "_44_1", assessmentId: "_55_1" });
    expect(providerAnnouncementDuration("Continuous")).toBe("Permanent");
    expect(providerAnnouncementDuration("DateRange")).toBe("Restricted");
    expect(publicAnnouncementDuration("Permanent")).toBe("Continuous");
    expect(publicAnnouncementDuration("Restricted")).toBe("DateRange");
  });

  it("keeps normal displayed values separate from grade overrides", () => {
    const record = {
      score: 7,
      text: "override",
      displayGrade: { score: 8, possible: 10, scaleType: "Percent", text: "80%" },
    };
    const displayed = displayGrade(record);
    expect(displayed).toEqual({ score: 8, possible: 10, scaleType: "Percent", text: "80%" });
    expect(isJsonObject(displayed) ? displayed.score : null).not.toBe(record.score);
  });
});
