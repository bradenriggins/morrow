export const SETUP_MODE_KEY = "morrowSetupGuideMode";

/**
 * The five checks the setup guide reports, in the order a person completes them.
 * connector/extension/onboarding/onboarding.html renders one list item per id.
 *
 * Morrow Bridge reports only what it can see from Chrome. `assistant` is the connection an
 * assistant approved through Morrow, not the assistant window itself, and `runtime` needs that
 * connection before it can compare versions at all.
 */
export const SETUP_CHECK_IDS = Object.freeze(["assistant", "connection", "runtime", "course", "read"]);

// saveMode() writes SETUP_MODE_KEY from this page. Reading the status after that write would send
// one request per mode press and answer with a state the press did not change.
export function shouldRefreshForStorageChange(changes, areaName) {
  if (areaName !== "local") return false;
  return Object.keys(changes || {}).some((key) => key !== SETUP_MODE_KEY);
}

// The recorded read names the course Morrow read. A record that names no course completes nothing,
// because the line it would write could not say where the read happened.
function readCourseName(record) {
  if (!record || typeof record !== "object") return "";
  const name = String(record.courseName || "").trim().slice(0, 200);
  if (name) return name;
  const courseId = String(record.courseId || "").trim().slice(0, 40);
  return courseId ? `course ${courseId}` : "";
}

// A status the guide could not read states that, rather than leaving the last known lines on screen
// as if they were current.
function unreadState() {
  return {
    ready: false,
    pairing: false,
    connecting: false,
    connected: false,
    runtimeHealthy: false,
    readyCourses: 0,
    readySites: 0,
    readCourse: "",
    open: "",
    checks: [
      { id: "assistant", done: false, text: "Assistant approval is not checked" },
      { id: "connection", done: false, text: "Morrow Bridge connection is not checked" },
      { id: "runtime", done: false, text: "Morrow version is not checked" },
      { id: "course", done: false, text: "Course connection is not checked" },
      { id: "read", done: false, text: "First read is not checked" },
    ],
    title: "Follow the setup steps",
    detail: "Morrow could not read this setup state, so it cannot name one next step. Select All steps to see every step. This guide reads the state again when you return to this tab.",
    showAssistantGuide: false,
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
  if (state.pairing) return {
    tone: "waiting",
    heading: "Waiting for approval",
    summary: "Morrow is waiting for you to allow this connection on the Morrow page that opened.",
  };
  if (state.connecting) return {
    tone: "waiting",
    heading: "Connecting Morrow",
    summary: "Morrow is connecting. This guide reads the state again when you return to this tab.",
  };
  if (state.open === "runtime") return {
    tone: "attention",
    heading: "Morrow needs a reload",
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
  const state = { ...(known ? readState(status) : unreadState()), known };
  return { ...state, ...readiness(state) };
}

function readState(status) {
  const bindings = Array.isArray(status?.bindings) ? status.bindings : [];
  const anchors = Array.isArray(status?.siteAnchors) ? status.siteAnchors : [];
  const readyCourses = bindings.filter((binding) => binding?.runtimeVerified === true).length;
  const readySites = anchors.filter((anchor) => anchor?.runtimeVerified === true).length;
  const paired = status?.paired === true;
  const pairing = status?.pairing === true;
  const connecting = status?.connecting === true;
  const connected = status?.connected === true;
  // Morrow Bridge compares versions through the connection, so a closed connection reports no
  // version result at all rather than a failed one.
  const runtimeHealthy = connected && status?.runtimeHealthy === true;
  const readCourse = readCourseName(status?.firstCourseRead);
  const checks = [
    {
      id: "assistant",
      done: paired,
      text: paired
        ? "An assistant approved this connection in Morrow. Morrow Bridge sees the connection, not the assistant itself."
        : pairing
          ? "An assistant approval is waiting on the Morrow page that opened"
          : "No assistant has approved this connection yet",
    },
    {
      id: "connection",
      done: connected,
      text: connected
        ? "Morrow Bridge is connected to Morrow"
        : pairing
          ? "Morrow Bridge connects after you allow this connection"
          : connecting
            ? "Morrow Bridge is connecting to Morrow"
            : "Morrow Bridge is not connected to Morrow",
    },
    {
      id: "runtime",
      done: runtimeHealthy,
      text: runtimeHealthy
        ? "Morrow matches this Morrow Bridge version and its list of course actions"
        : connected
          ? "Morrow reports a different version from this Morrow Bridge"
          : "Morrow version is checked when Morrow Bridge connects",
    },
    {
      id: "course",
      done: readyCourses > 0,
      text: readyCourses > 0
        ? `${readyCourses} selected ${readyCourses === 1 ? "course is" : "courses are"} ready`
        : readySites > 0
          ? "Course site is ready; select courses in Plan"
          : anchors.length > 0
            ? "Saved course site needs sign-in or reconnection"
            : "No course site is connected",
    },
    {
      id: "read",
      done: Boolean(readCourse),
      text: readCourse ? `First read completed in ${readCourse}` : "No first read is completed yet",
    },
  ];
  // "Ready to use" is every check, so a connection that has never read a course is not ready.
  const ready = checks.every((check) => check.done);
  // The first check that is not complete is the step this guide asks for, unless an approval or a
  // connection attempt is already open, which is the step in front of the person right now.
  const open = checks.find((check) => !check.done)?.id || "";
  const state = { ready, pairing, connecting, connected, runtimeHealthy, readyCourses, readySites, readCourse, open, checks };

  if (ready) return {
    ...state,
    title: "Plan your first change",
    detail: "Ask your assistant for a change in your selected course. Morrow keeps every change in Plan for your review.",
    showAssistantGuide: false,
    canOpenSettings: false,
  };
  if (pairing) return {
    ...state,
    title: "Allow connection",
    detail: "Select Allow connection in the Morrow page that opened. Then return here while Morrow connects.",
    showAssistantGuide: false,
    canOpenSettings: false,
  };
  if (connecting) return {
    ...state,
    title: "Connecting Morrow",
    detail: "Keep your assistant open while Morrow connects. Return here in a moment.",
    showAssistantGuide: false,
    canOpenSettings: false,
  };
  if (open === "assistant") return {
    ...state,
    title: "Open Morrow",
    detail: "Open Morrow and choose your assistant. Then return to Morrow Bridge, select Connect Morrow, and allow the connection you started.",
    showAssistantGuide: true,
    canOpenSettings: false,
  };
  if (open === "connection") return {
    ...state,
    title: "Open Morrow again",
    detail: "Open Morrow and choose your assistant again. Then return to Morrow Bridge.",
    showAssistantGuide: false,
    canOpenSettings: false,
  };
  if (open === "runtime") return {
    ...state,
    title: "Reload Morrow Bridge",
    detail: "Morrow and Morrow Bridge report different versions. Update Morrow, then reload Morrow Bridge on the Chrome extensions page and select Connect Morrow again.",
    showAssistantGuide: false,
    canOpenSettings: false,
  };
  if (open === "course" && readySites === 0) return {
    ...state,
    title: anchors.length ? "Reconnect a course site" : "Connect a course site",
    detail: anchors.length
      ? "Open the saved course site in Chrome and sign in. In Morrow Bridge, select Connect course site and allow Chrome access to that exact site."
      : "Open a permitted Canvas or Moodle course in Chrome and sign in. In Morrow Bridge, select Connect course site and allow Chrome access to that exact site.",
    showAssistantGuide: false,
    canOpenSettings: false,
  };
  if (open === "course") return {
    ...state,
    title: "Select a course in Plan",
    detail: "Open Plan and Edit settings. Find available courses, choose a course, then connect the selected course in Plan.",
    showAssistantGuide: false,
    canOpenSettings: true,
  };
  return {
    ...state,
    title: "Try a first read",
    detail: "Return to your assistant and ask: Use Morrow to list the modules in my selected course.",
    showAssistantGuide: false,
    canOpenSettings: false,
  };
}
