import assert from "node:assert/strict";
import test from "node:test";
import { collectMoodleCourseParticipantRoster } from "../../connector/extension/src/moodle-privacy.js";

const SESSION_SECRET = "moodle-session-secret";
const CATALOG_DIGEST = "a".repeat(64);
const PRINCIPAL_FINGERPRINT = "b".repeat(64);
const SOURCE_BINDING_ID = "moodle-anchor:c2";
const ORIGIN = "https://sandbox.moodledemo.net";
const SERVICE_URL = `${ORIGIN}/lib/ajax/service.php`;
const REQUIRED_CAPABILITIES = [
  "moodle/site:accessallgroups",
  "moodle/course:enrolreview",
  "moodle/course:viewsuspendedusers",
  "moodle/user:viewdetails",
];

function decodeDetachedHtml(value) {
  return String(value)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "")
    .replace(/<br\b[^>]*>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#([0-9]+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&eacute;/gi, "é")
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (_, name) => ({ amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " })[name.toLowerCase()]);
}

class DetachedDomParser {
  parseFromString(value) {
    return {
      querySelectorAll: () => [],
      body: { textContent: decodeDetachedHtml(value) },
    };
  }
}

async function withMoodlePage(callback, overrides = {}) {
  const keys = ["location", "M", "document", "fetch", "DOMParser"];
  const descriptors = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  try {
    Object.defineProperties(globalThis, {
      location: {
        configurable: true,
        writable: true,
        value: { origin: ORIGIN, pathname: "/course/view.php", href: `${ORIGIN}/course/view.php?id=2` },
      },
      M: {
        configurable: true,
        writable: true,
        value: { cfg: { wwwroot: ORIGIN, sesskey: SESSION_SECRET, userId: 3, courseId: 2 } },
      },
      document: {
        configurable: true,
        writable: true,
        value: { body: { className: "path-course course-2" } },
      },
      DOMParser: { configurable: true, writable: true, value: DetachedDomParser },
    });
    Object.assign(globalThis.location, overrides.location || {});
    if (overrides.cfg) Object.assign(globalThis.M.cfg, overrides.cfg);
    if (overrides.bodyClass !== undefined) globalThis.document.body.className = overrides.bodyClass;
    await callback();
  } finally {
    for (const key of keys) {
      const descriptor = descriptors.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

function rosterInput(overrides = {}) {
  const binding = {
    sourceBindingId: SOURCE_BINDING_ID,
    courseId: "2",
    origin: ORIGIN,
    siteUrl: `${ORIGIN}/`,
    principalId: "3",
    principalFingerprint: PRINCIPAL_FINGERPRINT,
    sessionGeneration: 7,
    catalogDigest: CATALOG_DIGEST,
    ...(overrides.binding || {}),
  };
  return {
    courseId: "2",
    binding,
    expiresAt: Date.now() + 30_000,
    ...overrides,
    binding,
  };
}

function nativeAjaxResponse(data, extra = {}) {
  // public/lib/ajax/service.php writes results at the request array index.
  return new Response(JSON.stringify([{ error: false, data, ...extra }]), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function nativePageResponse(url, html, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    text: async () => html,
  };
}

function parseAjaxRequest(url, init) {
  const parsedUrl = new URL(String(url));
  assert.equal(`${parsedUrl.origin}${parsedUrl.pathname}`, SERVICE_URL);
  assert.equal(parsedUrl.searchParams.get("sesskey"), SESSION_SECRET);
  assert.equal(init.method, "POST");
  const request = JSON.parse(init.body);
  assert.equal(request.length, 1);
  assert.equal(request[0].index, 0);
  assert.equal(parsedUrl.searchParams.get("info"), request[0].methodname);
  return request[0];
}

function courseConfig(courseId = 2, contextId = 42, userId = 3, extra = "") {
  return `<!doctype html><script>M.cfg = {"wwwroot":"${ORIGIN}","courseId":${courseId},"courseContextId":${contextId},"userId":${userId}};</script>${extra}`;
}

function capabilityPage(capabilities = REQUIRED_CAPABILITIES, {
  principalId = 3,
  contextId = 42,
  action = `${ORIGIN}/admin/roles/check.php?contextid=${contextId}`,
  selectedAttribute = ' selected="selected"',
} = {}) {
  const rows = REQUIRED_CAPABILITIES.map((capability) => {
    const allowed = capabilities.includes(capability);
    return `<tr class="rolecap ${allowed ? "yes" : "no"}"><th scope="row"><span class="cap-name">${capability}</span></th><td>${allowed ? "Yes" : "No"}</td></tr>`;
  }).join("");
  return `<!doctype html><form method="post" action="${action}"><select name="reportuser"><option value="${principalId}"${selectedAttribute}>Bound user</option></select></form><table id="explaincaps"><tbody>${rows}</tbody></table>`;
}

function tablePage(courseId, totalRows, identities, options = {}) {
  const rows = identities.map(({ id, name }) => `<tr><td><input class="usercheckbox m-1" name="user${id}" type="checkbox"></td><td><a href="/user/view.php?id=${id}">${name}</a></td><td>not-egress</td></tr>`).join("");
  const content = options.rawRows ?? rows;
  return `<div class="table-dynamic" data-region="core_table/dynamic" data-table-component="core_user" data-table-handler="participants" data-table-uniqueid="user-index-participants-${courseId}" data-table-total-rows="${totalRows}"><table><tbody>${content}</tbody></table></div>`;
}

function assertNativeCourseRequest(url, init, expectedCourseId) {
  const parsed = new URL(String(url));
  assert.equal(`${parsed.origin}${parsed.pathname}`, `${ORIGIN}/user/index.php`);
  assert.equal(parsed.searchParams.get("id"), String(expectedCourseId));
  assert.equal(parsed.searchParams.get("page"), "0");
  assert.equal(parsed.searchParams.get("perpage"), "1");
  assert.equal(init.method, "GET");
}

function assertCapabilityRequest(url, init, contextId) {
  const parsed = new URL(String(url));
  assert.equal(`${parsed.origin}${parsed.pathname}`, `${ORIGIN}/admin/roles/check.php`);
  assert.equal(parsed.searchParams.get("contextid"), String(contextId));
  assert.equal(parsed.searchParams.has("reportuser"), false);
  assert.equal(init.method, "POST");
  assert.equal(init.headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.deepEqual(Object.fromEntries(new URLSearchParams(init.body)), { reportuser: "3" });
}

function assertTableRequest(url, init, courseId, pageNumber) {
  const request = parseAjaxRequest(url, init);
  assert.equal(request.methodname, "core_table_get_dynamic_table_content");
  assert.deepEqual(request.args, {
    component: "core_user",
    handler: "participants",
    uniqueid: `user-index-participants-${courseId}`,
    sortdata: [{ sortby: "lastname", sortorder: 4 }],
    filters: [{ name: "courseid", jointype: 1, values: [courseId] }],
    jointype: 1,
    firstinitial: "",
    lastinitial: "",
    pagenumber: pageNumber,
    pagesize: 100,
    hiddencolumns: [],
    resetpreferences: false,
  });
}

test("Moodle roster requires native source capability proof and returns every bounded table page", async () => {
  await withMoodlePage(async () => {
    const calls = [];
    const firstPage = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, name: `Participant ${index + 1}` }));
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      const path = new URL(String(url)).pathname;
      if (path === "/user/index.php") {
        assertNativeCourseRequest(url, init, 2);
        return nativePageResponse(String(url), courseConfig());
      }
      if (path === "/admin/roles/check.php") {
        assertCapabilityRequest(url, init, 42);
        return nativePageResponse(String(url), capabilityPage());
      }
      assertTableRequest(url, init, 2, calls.length - 2);
      return nativeAjaxResponse({ html: tablePage(2, 101, calls.length === 3 ? firstPage : [{ id: 101, name: "Final participant" }]), warnings: [] });
    };

    const result = await collectMoodleCourseParticipantRoster(JSON.stringify(rosterInput()));
    assert.equal(calls.length, 4);
    assert.deepEqual(result, {
      schema: "morrow.moodle-course-roster.v1",
      provider: "moodle",
      sourceBindingId: SOURCE_BINDING_ID,
      courseId: "2",
      origin: ORIGIN,
      siteUrl: `${ORIGIN}/`,
      principalFingerprint: PRINCIPAL_FINGERPRINT,
      sessionGeneration: 7,
      catalogDigest: CATALOG_DIGEST,
      status: "complete",
      complete: true,
      identities: [...firstPage.map(({ id, name }) => ({ id: String(id), name })), { id: "101", name: "Final participant" }],
      proof: {
        method: "core_table_get_dynamic_table_content",
        pageSize: 100,
        requestCount: 2,
        pageCount: 2,
        rowCount: 101,
        identityCount: 101,
        totalRows: 101,
        scope: {
          method: "moodle.native.admin.roles.check",
          outcome: "explicit_course_capabilities",
        },
      },
    });
    const egress = JSON.stringify(result);
    assert.equal(egress.includes(SESSION_SECRET), false);
    assert.equal(egress.includes("not-egress"), false);
    assert.equal(egress.includes("explaincaps"), false);
  });
});

test("Moodle roster proves a selected logical course from its own native page", async () => {
  await withMoodlePage(async () => {
    const methods = [];
    globalThis.fetch = async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/user/index.php") {
        methods.push("course-page");
        assertNativeCourseRequest(url, init, 3);
        return nativePageResponse(String(url), courseConfig(3, 43));
      }
      if (path === "/admin/roles/check.php") {
        methods.push("capability-page");
        assertCapabilityRequest(url, init, 43);
        return nativePageResponse(String(url), capabilityPage(REQUIRED_CAPABILITIES, { contextId: 43 }));
      }
      methods.push("table");
      assertTableRequest(url, init, 3, 1);
      return nativeAjaxResponse({ html: tablePage(3, 1, [{ id: 31, name: "Selected course participant" }]), warnings: [] });
    };

    const result = await collectMoodleCourseParticipantRoster(rosterInput({
      courseId: "3",
      binding: { courseId: "3", sourceBindingId: "moodle-anchor:c3" },
    }));
    assert.deepEqual(methods, ["course-page", "capability-page", "table"]);
    assert.equal(result.complete, true);
    assert.equal(result.courseId, "3");
    assert.deepEqual(result.identities, [{ id: "31", name: "Selected course participant" }]);
  });
});

test("Moodle roster proves an empty source table complete after capability proof", async () => {
  await withMoodlePage(async () => {
    let tableRequests = 0;
    globalThis.fetch = async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/user/index.php") return nativePageResponse(String(url), courseConfig());
      if (path === "/admin/roles/check.php") return nativePageResponse(String(url), capabilityPage());
      tableRequests += 1;
      assertTableRequest(url, init, 2, 1);
      return nativeAjaxResponse({ html: tablePage(2, 0, []), warnings: [] });
    };
    const result = await collectMoodleCourseParticipantRoster(rosterInput());
    assert.equal(tableRequests, 1);
    assert.equal(result.complete, true);
    assert.equal(result.status, "complete");
    assert.deepEqual(result.identities, []);
    assert.equal(result.proof.totalRows, 0);
  });
});

test("Moodle roster refuses incomplete capability, course, account, session, and origin proof before result egress", async () => {
  await withMoodlePage(async () => {
    let calls = 0;
    globalThis.fetch = async (url, init) => {
      calls += 1;
      const path = new URL(String(url)).pathname;
      if (path === "/user/index.php") return nativePageResponse(String(url), courseConfig());
      assertCapabilityRequest(url, init, 42);
      return nativePageResponse(String(url), capabilityPage(REQUIRED_CAPABILITIES.slice(0, -1)));
    };
    const missingCapability = await collectMoodleCourseParticipantRoster(rosterInput());
    assert.equal(calls, 2);
    assert.equal(missingCapability.status, "refused");
    assert.equal(missingCapability.complete, false);
    assert.equal(missingCapability.error, "moodle_roster_capability_proof_unavailable");
    assert.deepEqual(missingCapability.identities, []);

    globalThis.fetch = async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/user/index.php") return nativePageResponse(String(url), courseConfig());
      return nativePageResponse(String(url), capabilityPage(REQUIRED_CAPABILITIES, { principalId: 4 }));
    };
    const wrongReportUser = await collectMoodleCourseParticipantRoster(rosterInput());
    assert.equal(wrongReportUser.error, "moodle_roster_capability_proof_unavailable");
    assert.deepEqual(wrongReportUser.identities, []);

    globalThis.fetch = async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/user/index.php") return nativePageResponse(String(url), courseConfig());
      return nativePageResponse(String(url), capabilityPage(REQUIRED_CAPABILITIES, { contextId: 43 }));
    };
    const wrongReportContext = await collectMoodleCourseParticipantRoster(rosterInput());
    assert.equal(wrongReportContext.error, "moodle_roster_capability_proof_unavailable");
    assert.deepEqual(wrongReportContext.identities, []);

    globalThis.fetch = async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/user/index.php") return nativePageResponse(String(url), courseConfig());
      return nativePageResponse(String(url), capabilityPage(REQUIRED_CAPABILITIES, {
        action: `${ORIGIN}/admin/roles/check.php?contextid=42&contextid=43`,
      }));
    };
    const duplicateReportContext = await collectMoodleCourseParticipantRoster(rosterInput());
    assert.equal(duplicateReportContext.error, "moodle_roster_capability_proof_unavailable");
    assert.deepEqual(duplicateReportContext.identities, []);

    globalThis.fetch = async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/user/index.php") return nativePageResponse(String(url), courseConfig());
      return nativePageResponse(String(url), capabilityPage(REQUIRED_CAPABILITIES, {
        selectedAttribute: ' data-selected="true"',
      }));
    };
    const unselectedReportUser = await collectMoodleCourseParticipantRoster(rosterInput());
    assert.equal(unselectedReportUser.error, "moodle_roster_capability_proof_unavailable");
    assert.deepEqual(unselectedReportUser.identities, []);

    globalThis.fetch = async (url) => nativePageResponse(String(url), courseConfig(3, 42));
    const wrongCourse = await collectMoodleCourseParticipantRoster(rosterInput());
    assert.equal(wrongCourse.error, "moodle_roster_native_course_proof_invalid");

    globalThis.fetch = async (url) => nativePageResponse(String(url), courseConfig(2, 42, 4));
    const wrongAccount = await collectMoodleCourseParticipantRoster(rosterInput());
    assert.equal(wrongAccount.error, "moodle_roster_native_course_proof_invalid");

    globalThis.fetch = async (url) => {
      globalThis.M.cfg.sesskey = "replacement-session-secret";
      return nativePageResponse(String(url), courseConfig());
    };
    const changedSession = await collectMoodleCourseParticipantRoster(rosterInput());
    assert.equal(changedSession.error, "moodle_roster_session_changed");

    globalThis.M.cfg.sesskey = SESSION_SECRET;
    globalThis.fetch = async (url) => nativePageResponse("https://other.example.test/user/index.php?id=2", courseConfig());
    const crossOriginRedirect = await collectMoodleCourseParticipantRoster(rosterInput());
    assert.equal(crossOriginRedirect.error, "moodle_roster_response_origin_invalid");
  });
});

test("Moodle roster decodes detached participant names without returning hidden cell content", async () => {
  await withMoodlePage(async () => {
    globalThis.fetch = async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/user/index.php") return nativePageResponse(String(url), courseConfig());
      if (path === "/admin/roles/check.php") return nativePageResponse(String(url), capabilityPage());
      return nativeAjaxResponse({ html: tablePage(2, 1, [{ id: 11, name: "Jos&eacute; <script>session-secret</script>" }]), warnings: [] });
    };
    const result = await collectMoodleCourseParticipantRoster(rosterInput());
    assert.equal(result.complete, true);
    assert.deepEqual(result.identities, [{ id: "11", name: "José" }]);
    assert.equal(JSON.stringify(result).includes("session-secret"), false);
  });
});

test("Moodle roster refuses malformed, duplicate, and changing native table records without usable identities", async () => {
  await withMoodlePage(async () => {
    const standardPages = (html) => {
      globalThis.fetch = async (url) => {
        const path = new URL(String(url)).pathname;
        if (path === "/user/index.php") return nativePageResponse(String(url), courseConfig());
        if (path === "/admin/roles/check.php") return nativePageResponse(String(url), capabilityPage());
        return nativeAjaxResponse({ html, warnings: [] });
      };
    };

    standardPages(tablePage(2, 2, [{ id: 11, name: "First" }, { id: 11, name: "Repeated" }]));
    const duplicate = await collectMoodleCourseParticipantRoster(rosterInput());
    assert.equal(duplicate.status, "partial");
    assert.equal(duplicate.complete, false);
    assert.equal(duplicate.error, "moodle_roster_duplicate_identity");
    assert.deepEqual(duplicate.identities, []);

    standardPages(tablePage(2, 1, [], {
      rawRows: "<tr><td><input class=\"usercheckbox\" name=\"user12\"></td><td></td></tr>",
    }));
    const malformed = await collectMoodleCourseParticipantRoster(rosterInput());
    assert.equal(malformed.status, "refused");
    assert.equal(malformed.complete, false);
    assert.equal(malformed.error, "moodle_roster_table_row_invalid");
    assert.deepEqual(malformed.identities, []);

    let tablePageCall = 0;
    globalThis.fetch = async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/user/index.php") return nativePageResponse(String(url), courseConfig());
      if (path === "/admin/roles/check.php") return nativePageResponse(String(url), capabilityPage());
      tablePageCall += 1;
      const identities = tablePageCall === 1
        ? Array.from({ length: 100 }, (_, index) => ({ id: index + 1, name: `Participant ${index + 1}` }))
        : [{ id: 101, name: "Final participant" }];
      return nativeAjaxResponse({ html: tablePage(2, tablePageCall === 1 ? 101 : 102, identities), warnings: [] });
    };
    const changingTotal = await collectMoodleCourseParticipantRoster(rosterInput());
    assert.equal(changingTotal.status, "partial");
    assert.equal(changingTotal.complete, false);
    assert.equal(changingTotal.error, "moodle_roster_table_total_changed");
    assert.deepEqual(changingTotal.identities, []);
  });
});

test("Moodle roster retains the email aliases rendered in each participant row", async () => {
  await withMoodlePage(async () => {
    globalThis.fetch = async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/user/index.php") return nativePageResponse(String(url), courseConfig());
      if (path === "/admin/roles/check.php") return nativePageResponse(String(url), capabilityPage());
      return nativeAjaxResponse({ html: tablePage(2, 1, [], {
        rawRows: '<tr><td><input class="usercheckbox" name="user7"></td><td>Michaela Adams</td><td>michaela@example.edu</td><td>m.adams@example.edu</td></tr>',
      }), warnings: [] });
    };
    const result = await collectMoodleCourseParticipantRoster(rosterInput());
    assert.equal(result.complete, true);
    assert.deepEqual(result.identities, [{ id: "7", name: "Michaela Adams", email: "michaela@example.edu", aliases: ["m.adams@example.edu"] }]);
  });
});
