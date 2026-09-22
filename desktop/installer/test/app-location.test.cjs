"use strict";

/*
 * Ways the app-location check can fail, written before the change:
 * - Morrow runs from the disk image (/Volumes/...) and writes that path into an assistant; the
 *   path disappears when the disk image is ejected.
 * - macOS App Translocation runs a downloaded Morrow from a random read-only path.
 * - Morrow runs from ~/Downloads or the desktop and is later moved or deleted.
 * - A development run (not packaged) or Windows is blocked by a macOS-only rule.
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const { appLocationStatus } = require("../shared/app-location.cjs");

const APPLICATIONS = "/Applications/Morrow.app/Contents/MacOS/Morrow";

test("a packaged Mac app outside Applications, on a disk image, or translocated must move first", () => {
  const packaged = { platform: "darwin", isPackaged: true };
  assert.equal(appLocationStatus({ ...packaged, executablePath: APPLICATIONS, inApplicationsFolder: true }), "ok");
  assert.equal(appLocationStatus({ ...packaged, executablePath: "/Users/t/Applications/Morrow.app/Contents/MacOS/Morrow", inApplicationsFolder: true }), "ok");
  assert.equal(appLocationStatus({ ...packaged, executablePath: "/Volumes/Morrow 1.0.4/Morrow.app/Contents/MacOS/Morrow", inApplicationsFolder: false }), "move_required");
  assert.equal(appLocationStatus({ ...packaged, executablePath: "/Volumes/Morrow/Applications/Morrow.app/Contents/MacOS/Morrow", inApplicationsFolder: true }), "move_required");
  assert.equal(appLocationStatus({
    ...packaged,
    executablePath: "/private/var/folders/xy/T/AppTranslocation/1234-ABCD/d/Morrow.app/Contents/MacOS/Morrow",
    inApplicationsFolder: false,
  }), "move_required");
  assert.equal(appLocationStatus({ ...packaged, executablePath: "/Users/t/Downloads/Morrow.app/Contents/MacOS/Morrow", inApplicationsFolder: false }), "move_required");
  assert.equal(appLocationStatus({ ...packaged, executablePath: APPLICATIONS, inApplicationsFolder: null }), "move_required", "an answer Morrow cannot read is not proof");
});

test("development runs and Windows are never blocked by the Mac rule", () => {
  assert.equal(appLocationStatus({ platform: "darwin", isPackaged: false, executablePath: "/Users/t/Downloads/x", inApplicationsFolder: false }), "ok");
  assert.equal(appLocationStatus({ platform: "win32", isPackaged: true, executablePath: "C:\\Users\\t\\Downloads\\Morrow.exe", inApplicationsFolder: false }), "ok");
});
