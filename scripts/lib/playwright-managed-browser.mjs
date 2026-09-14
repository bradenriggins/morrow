/** Launches only the Chromium revision owned by the installed Playwright package. */
export async function launchManagedChromiumPersistentContext(chromium, profile, options = {}) {
  if (!chromium || typeof chromium.launchPersistentContext !== "function") {
    throw new TypeError("playwright_chromium_required");
  }
  if (Object.hasOwn(options, "channel") || Object.hasOwn(options, "executablePath")) {
    throw new Error("playwright_managed_chromium_override_refused");
  }
  return await chromium.launchPersistentContext(profile, options);
}
