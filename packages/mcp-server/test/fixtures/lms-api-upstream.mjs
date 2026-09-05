import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { LmsApiRuntime } from "../../dist/lms-api.js";
import { createLmsApiServer } from "../../dist/lms-api-server.js";
import { MOODLE_API_OPERATIONS } from "../../dist/moodle-api.js";
import { BLACKBOARD_API_OPERATIONS } from "../../dist/blackboard-api.js";

const moodle = { id: 17, fullname: "Biology · Moodle", summary: "<p>Original introduction</p>", summaryformat: 1, visible: 0, timemodified: 1 };
const course = { id: "_12_1", courseId: "BIO101", name: "Biology · Blackboard", ultraStatus: "Ultra", closedComplete: false };
const content = { id: "_34_1", title: "Cell structure", body: '<!-- {"bbMLEditorVersion":1} --><div><h4>Cell structure</h4>' + "<p>The nucleus contains cellular DNA. Use the diagram to identify each structure.</p>".repeat(900) + "</div>", contentHandler: { id: "resource/x-bb-document" }, availability: { available: "No" }, modified: "1" };
const connections = [
  { id: "moodle-test", label: "Moodle teaching account", provider: "moodle", baseUrl: "https://moodle.example/learning", token: "synthetic-moodle-token" },
  { id: "blackboard-test", label: "Blackboard teaching account", provider: "blackboard", baseUrl: "https://blackboard.example", token: "synthetic-blackboard-token", userId: "test-user-uuid" },
];
const fetcher = async (url, options) => {
  let result;
  const address = new URL(url);
  if (address.hostname === "moodle.example") {
    const form = options.body;
    if (form.get("wsfunction") === "core_webservice_get_site_info") result = { userid: 9, siteurl: connections[0].baseUrl, functions: ["core_course_get_courses", "core_course_update_courses"].map((name) => ({ name })) };
    else if (form.get("wsfunction") === "core_course_get_courses") result = [moodle];
    else if (form.get("wsfunction") === "core_course_update_courses") {
      if (String(form.get("courses[0][summary]")).includes("NETWORK_FAILURE")) throw new Error("Synthetic uncertain Moodle write.");
      moodle.summary = form.get("courses[0][summary]");
      moodle.timemodified += 1;
      result = { warnings: [] };
    }
  } else if (address.hostname === "blackboard.example") {
    if (address.pathname.includes("/users/uuid:")) result = { id: "_7_1" };
    else if (address.pathname.endsWith("/users/me/courses")) result = { results: [{ userId: "_7_1", courseId: "_12_1" }] };
    else if (address.pathname.endsWith("/v3/courses/_12_1")) result = course;
    else if (address.pathname.endsWith("/contents/_34_1")) {
      if (options.method === "PATCH") Object.assign(content, JSON.parse(options.body), { modified: String(Number(content.modified) + 1) });
      result = content;
    }
  }
  if (result === undefined) throw new Error("Unexpected synthetic API request.");
  return Response.json(result);
};
await serveStdio(() => createLmsApiServer(new LmsApiRuntime(connections, [...MOODLE_API_OPERATIONS, ...BLACKBOARD_API_OPERATIONS], fetcher)));
