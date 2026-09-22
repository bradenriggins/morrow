"use strict";

const path = require("node:path");

/**
 * Whether this copy of Morrow may write its own location into an assistant's
 * settings. An assistant starts Morrow from the path it was given, so a Mac app
 * running from a disk image (/Volumes), from App Translocation's temporary
 * copy, or from any folder other than Applications would leave the assistant
 * pointing at a path that disappears. Only a packaged Mac app is checked.
 */
function appLocationStatus({ platform, isPackaged, executablePath, inApplicationsFolder }) {
  if (platform !== "darwin" || isPackaged !== true) return "ok";
  const executable = typeof executablePath === "string" ? path.posix.normalize(executablePath) : "";
  if (!executable.startsWith("/")) return "move_required";
  if (executable.startsWith("/Volumes/") || executable.includes("/AppTranslocation/")) return "move_required";
  return inApplicationsFolder === true ? "ok" : "move_required";
}

module.exports = { appLocationStatus };
