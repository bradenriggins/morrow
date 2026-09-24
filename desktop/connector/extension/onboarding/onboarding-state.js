import { VERSION_MISMATCH_RECOVERY } from "../src/bridge-problem-copy.js";

export const SETUP_MODE_KEY = "morrowSetupGuideMode";

/**
 * The five checks the setup guide reports, in the order a person completes them.
 * connector/extension/onboarding/onboarding.html renders one list item per id.
 *
 * Morrow Bridge reports only what it can see from Chrome. `assistant` is the connection the
 * person made with Connect Morrow, not the assistant window itself, and `runtime` needs that
 * connection before it can compare versions at all.
 */
export const SETUP_CHECK_IDS = Object.freeze(["assistant", "connection", "runtime", "course", "read"]);

// saveMode() writes SETUP_MODE_KEY from this page. Reading the status after that write would send
// one request per mode press and answer with a state the press did not change.
export function shouldRefreshForStorageChange(changes, areaName) {
  if (areaName !== "local") return false;
  return Object.keys(changes || {}).some((key) => key !== SETUP_MODE_KEY);
}

// Only a current runtime-verified binding can carry the Bridge's exact durable first-read proof.
// A binding that names no course completes nothing because the guide could not say where it read.
function readCourseName(binding) {
  if (!binding || typeof binding !== "object" || binding.runtimeVerified !== true || binding.firstReadCompleted !== true) return "";
  const name = String(binding.courseName || "").trim().slice(0, 200);
  if (name) return name;
  const courseId = String(binding.courseId || "").trim().slice(0, 40);
  return courseId ? `course ${courseId}` : "";
}

function platformName(status) {
  const bindings = Array.isArray(status?.bindings) ? status.bindings : [];
  const anchors = Array.isArray(status?.siteAnchors) ? status.siteAnchors : [];
  const provider = bindings.at(-1)?.provider || anchors.at(-1)?.provider;
  return provider === "canvas" ? "Canvas" : provider === "moodle" ? "Moodle" : "";
}

// A status the guide could not read states that, rather than leaving the last known lines on screen
// as if they were current.
function unreadState() {
  return {
    ready: false,
    connecting: false,
    connected: false,
    runtimeHealthy: false,
    readyCourses: 0,
    readySites: 0,
    readCourse: "",
    open: "",
    checks: [
      { id: "assistant", done: false, text: "Connection to Morrow is not checked" },
      { id: "connection", done: false, text: "Morrow Bridge connection is not checked" },
      { id: "runtime", done: false, text: "Morrow version is not checked" },
      { id: "course", done: false, text: "Course connection is not checked" },
      { id: "read", done: false, text: "First read is not checked" },
    ],
    title: "Follow the setup steps",
    detail: "Morrow could not read this setup state, so it cannot name one next step. Select Setup overview to see the three stages. This guide reads the state again when you return to this tab.",
    canOpenSettings: false,
  };
}

// The dot is decorative, so each state also carries its own heading. Colour alone never separates
// waiting from ready.
function readiness(state) {
  if (!state.known) return {
    tone: "unread",
    heading: "Setup state not checked",
    summary: "Morrow could not read this setup state, so no line below states a current result.",
  };
  if (state.ready) return {
    tone: "ready",
    heading: "Ready to use",
    summary: `${state.readyCourses} selected ${state.readyCourses === 1 ? "course is" : "courses are"} ready in this Chrome session. Morrow completed a first read in ${state.readCourse}.`,
  };
  if (state.authenticationFailed) return {
    tone: "attention",
    heading: "Reconnect needed",
    summary: "Morrow no longer accepts the connection Morrow Bridge saved, so it needs to connect again.",
  };
  if (state.connecting) return {
    tone: "waiting",
    heading: "Connecting Morrow",
    summary: "Morrow is connecting. This guide reads the state again when you return to this tab.",
  };
  if (state.open === "runtime") return {
    tone: "attention",
    heading: "Morrow Bridge needs a reload",
    summary: "Morrow and Morrow Bridge report different versions, so Morrow Bridge cannot confirm which course actions Morrow can use.",
  };
  if (state.open === "read") return {
    tone: "pending",
    heading: "One step left",
    summary: `${state.readyCourses} selected ${state.readyCourses === 1 ? "course is" : "courses are"} ready in this Chrome session. One read from your assistant completes this setup.`,
  };
  return {
    tone: "pending",
    heading: "Setup in progress",
    summary: "Morrow checks the assistant, this connection, your selected course and the first read each time this guide opens.",
  };
}

export function setupGuideState(status) {
  const known = Boolean(status) && typeof status === "object";
  const state = { canReconnect: false, ...(known ? readState(status) : unreadState()), known };
  return { ...state, ...readiness(state) };
}

function readState(status) {
  const bindings = Array.isArray(status?.bindings) ? status.bindings : [];
  const anchors = Array.isArray(status?.siteAnchors) ? status.siteAnchors : [];
  const readyCourses = bindings.filter((binding) => binding?.runtimeVerified === true).length;
  const readySites = anchors.filter((anchor) => anchor?.runtimeVerified === true).length;
  // Morrow refused the saved connection (it was reinstalled, or its data was removed), so the
  // earlier connection no longer counts, and opening Morrow again cannot fix it.
  const authenticationFailed = status?.authenticationFailed === true;
  const paired = status?.paired === true && !authenticationFailed;
  const connecting = status?.connecting === true;
  const connected = status?.connected === true;
  // Morrow closes a connection from a Bridge build it does not expect with its own reason, so the
  // connection reached Morrow and the version result is known even though it closed.
  const versionMismatch = !connected && status?.versionMismatch === true;
  // Morrow Bridge compares versions through the connection, so a closed connection reports no
  // version result at all rather than a failed one.
  const runtimeHealthy = connected && status?.runtimeHealthy === true;
  const readBinding = bindings.find((binding) => binding?.runtimeVerified === true && binding?.firstReadCompleted === true);
  const readCourse = readCourseName(readBinding);
  const platform = platformName(status);
  const checks = [
    {
      id: "assistant",
      done: paired,
      text: paired
        ? "Morrow Bridge is set up to work with Morrow on this computer. Morrow Bridge sees the connection, not your assistant itself."
        : authenticationFailed
          ? "Morrow no longer accepts this saved connection, so it needs to connect again"
          : "Morrow Bridge is not set up to work with Morrow yet",
    },
    {
      id: "connection",
      done: connected || versionMismatch,
      text: connected
        ? "Morrow Bridge is connected to Morrow"
        : versionMismatch
          ? "Morrow Bridge reached Morrow, and Morrow expects a different version"
          : connecting
            ? "Morrow Bridge is connecting to Morrow"
            : "Morrow Bridge is not connected to Morrow",
    },
    {
      id: "runtime",
      done: runtimeHealthy,
      text: runtimeHealthy
        ? "Morrow matches this Morrow Bridge version and its list of course actions"
        : connected || versionMismatch
          ? "Morrow reports a different version from this Morrow Bridge"
          : "Morrow version is checked when Morrow Bridge connects",
    },
    {
      id: "course",
      done: readyCourses > 0,
      text: readyCourses > 0
        ? `${readyCourses} selected ${readyCourses === 1 ? "course is" : "courses are"} ready`
        : readySites > 0
          ? `${platform || "Learning platform"} is ready; select courses in Plan`
          : anchors.length > 0
            ? `Saved ${platform || "learning platform"} needs sign-in or reconnection`
            : "No Canvas or Moodle course is connected",
    },
    {
      id: "read",
      done: Boolean(readCourse),
      text: readCourse ? `First read completed in ${readCourse}` : "No first read is completed yet",
    },
  ];
  // "Ready to use" is every check, so a connection that has never read a course is not ready.
  const ready = checks.every((check) => check.done);
  // The first check that is not complete is the step this guide asks for, unless a connection
  // attempt is already open, which is the step in front of the person right now.
  const open = checks.find((check) => !check.done)?.id || "";
  const state = { ready, authenticationFailed, connecting, connected, runtimeHealthy, readyCourses, readySites, readCourse, open, checks };

  if (ready) return {
    ...state,
    title: "Plan your first change",
    detail: "Ask your assistant for a change in your selected course. Each change waits for your review unless you turned on Edit for that kind of change in that course.",
    canOpenSettings: false,
  };
  // The same step and words as the Morrow Bridge popup (popup/popup-view.js).
  if (authenticationFailed) return {
    ...state,
    title: "Reconnect Morrow",
    detail: "Morrow refused the connection Morrow Bridge saved. Select Reconnect Morrow to connect again. Your selected courses stay saved.",
    canOpenSettings: false,
    canReconnect: true,
  };
  if (connecting) return {
    ...state,
    title: "Connecting Morrow",
    detail: "Keep your assistant open while Morrow connects. Return here in a moment.",
    canOpenSettings: false,
  };
  if (open === "assistant") return {
    ...state,
    title: "Open Morrow",
    detail: "Open Morrow and choose your assistant. Then return to Morrow Bridge and select Connect Morrow.",
    canOpenSettings: false,
  };
  if (open === "connection") return {
    ...state,
    title: "Open Morrow again",
    detail: "Open Morrow and choose your assistant again. Then return to Morrow Bridge.",
    canOpenSettings: false,
  };
  if (open === "runtime") return {
    ...state,
    title: "Reload Morrow Bridge",
    detail: `Morrow and Morrow Bridge report different versions. ${VERSION_MISMATCH_RECOVERY}`,
    canOpenSettings: false,
  };
  if (open === "course" && readySites === 0) return {
    ...state,
    title: anchors.length ? `Reconnect ${platform || "your learning platform"}` : "Open Canvas or Moodle",
    detail: anchors.length
      ? `Select ${platform ? `Open ${platform}` : "Open Canvas or Open Moodle"} in the Morrow Bridge popup, or open the saved ${platform || "learning platform"} course in Chrome yourself, and sign in if ${platform || "it"} asks.`
      : "Open a Canvas or Moodle course in Chrome and sign in. The Morrow Bridge popup then shows Connect this course. Select it and allow Chrome access to the exact address shown.",
    canOpenSettings: false,
  };
  if (open === "course") return {
    ...state,
    title: "Select a course in Plan",
    detail: "Open Plan and Edit settings. The courses on your signed-in site are listed under Not connected. Select Connect on a course. It connects in Plan.",
    canOpenSettings: true,
  };
  return {
    ...state,
    title: "Try a first read",
    detail: "Return to your assistant and ask: Use Morrow to list the modules in my selected course.",
    canOpenSettings: false,
  };
}
