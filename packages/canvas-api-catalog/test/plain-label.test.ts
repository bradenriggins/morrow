import { describe, expect, it } from "vitest";
import { parseCanvasApiCatalog } from "../src/index.js";
import catalogJson from "../../../artifacts/canvas-api/canvas-api-catalog.json";

const catalog = parseCanvasApiCatalog(catalogJson);

// The imperative verbs this catalog's plain labels use. Broader than what the catalog uses today,
// so an ordinary future Canvas addition does not fail this test; a genuinely new verb is added here
// on purpose, the way a pinned test is corrected on purpose.
const PLAIN_LABEL_VERBS = new Set([
  "Accept", "Activate", "Add", "Apply", "Approve", "Archive", "Assign", "Attach", "Bind", "Cancel", "Change",
  "Clear", "Close", "Complete", "Conclude", "Connect", "Copy", "Create", "Deactivate", "Decline",
  "Delete", "Detach", "Disable", "Duplicate", "Edit", "Enable", "Enroll", "Export", "Extend",
  "Finish", "Grade", "Grant", "Hide", "Import", "Install", "Invite", "Link", "Lock", "Mark", "Merge",
  "Move", "Mute", "Open", "Pause", "Post", "Publish", "Recalculate", "Reactivate", "Regrade",
  "Reissue", "Reject", "Remind", "Remove", "Rename", "Reopen", "Reorder", "Reply", "Reset", "Restore",
  "Resubmit", "Resume", "Revoke", "Send", "Set", "Share", "Split", "Start", "Stop", "Submit", "Sync",
  "Tag", "Uninstall", "Unassign", "Unenroll", "Unflag", "Unlink", "Unlock", "Unmark", "Unmute",
  "Unpublish", "Unshare", "Unsubscribe", "Untag", "Update", "Upload", "Withdraw",
]);

const NO_MARKUP = /^[A-Za-z0-9 '.,/()-]+$/;

describe("Canvas API catalog plain labels", () => {
  it("gives every write operation a label, and every read operation none", () => {
    for (const operation of catalog.operations) {
      if (operation.readOnly) {
        expect(operation.plainLabel, operation.toolName).toBeUndefined();
      } else {
        expect(typeof operation.plainLabel, operation.toolName).toBe("string");
        expect(operation.plainLabel!.length, operation.toolName).toBeGreaterThan(0);
      }
    }
  });

  it("keeps every label to 60 characters or fewer, with no markup", () => {
    for (const operation of catalog.operations) {
      if (!operation.plainLabel) continue;
      expect(operation.plainLabel.length, operation.toolName).toBeLessThanOrEqual(60);
      expect(operation.plainLabel, operation.toolName).toMatch(NO_MARKUP);
    }
  });

  it("starts every label with a verb", () => {
    for (const operation of catalog.operations) {
      if (!operation.plainLabel) continue;
      const [firstWord] = operation.plainLabel.split(" ");
      expect(PLAIN_LABEL_VERBS.has(firstWord), `${operation.toolName}: "${operation.plainLabel}"`).toBe(true);
    }
  });

  it("gives no two write operations of the same resource the same label", () => {
    const labelsByResource = new Map<string, Map<string, string>>();
    for (const operation of catalog.operations) {
      if (!operation.plainLabel) continue;
      const seen = labelsByResource.get(operation.resource) ?? new Map<string, string>();
      const owner = seen.get(operation.plainLabel);
      expect(owner, `${operation.resource}: "${operation.plainLabel}" (${operation.toolName} vs ${owner})`).toBeUndefined();
      seen.set(operation.plainLabel, operation.toolName);
      labelsByResource.set(operation.resource, seen);
    }
  });
});
