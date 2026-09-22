import { connect, SANDBOX, SOURCE_BINDING } from "./connect.mjs";
import { makeTools } from "./lib/tools.mjs";

const COURSE = SANDBOX.courseId;
const mark = `${SANDBOX.mark}CURRENT${Date.now()}`;
const { client, close } = await connect("morrow-canvas-current-proof");
const { read, change } = makeTools(client);

function rows(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.items)) return value.items;
  return [];
}

function requireRead(label, value) {
  if (!value?.ok) throw new Error(`${label} failed: ${value?.code || value?.reason || "unknown"}`);
  return value.data;
}

function requireVerified(label, value) {
  if (value?.outcome !== "verified") {
    throw new Error(`${label} was not verified: ${JSON.stringify(value)}`);
  }
}

function requireMatch(label, list, predicate) {
  const found = rows(list).find(predicate);
  if (!found) throw new Error(`${label} was absent from provider readback`);
  return found;
}

const receipt = {
  schema: "morrow.canvas-current-safe-proof.v1",
  startedAt: new Date().toISOString(),
  sourceBindingId: SOURCE_BINDING,
  courseId: COURSE,
  mark,
  exclusions: ["grades", "messages", "people", "enrollments", "publishing", "deletes", "cross-course writes"],
  reads: {},
  writes: {},
};

try {
  if (!SOURCE_BINDING) throw new Error("MORROW_SB must name the current Canvas binding");

  const course = requireRead("course", await read("canvas_get_single_course_courses", { id: COURSE }));
  if (String(course?.id) !== String(COURSE)) throw new Error("course readback returned the wrong course");
  receipt.courseName = course.name;

  const initialReads = {
    modules: ["canvas_list_modules", { course_id: COURSE }],
    pages: ["canvas_list_pages_courses", { course_id: COURSE }],
    assignments: ["canvas_list_assignments_assignments", { course_id: COURSE }],
    quizzes: ["canvas_list_quizzes_in_course", { course_id: COURSE }],
    discussions: ["canvas_list_discussion_topics_courses", { course_id: COURSE }],
    sections: ["canvas_list_course_sections", { course_id: COURSE }],
    assignmentGroups: ["canvas_list_assignment_groups", { course_id: COURSE }],
  };
  for (const [key, [tool, args]] of Object.entries(initialReads)) {
    const data = requireRead(key, await read(tool, args));
    receipt.reads[key] = { tool, count: rows(data).length, verified: true };
  }

  const pageTitle = `${mark} page`;
  requireVerified("page create", await change("current.page.create", "canvas_create_page_courses", {
    course_id: COURSE,
    wiki_page_title: pageTitle,
    wiki_page_body: `<p>${mark} original</p>`,
    wiki_page_published: false,
  }));
  const createdPage = requireMatch("created page", requireRead("page list", await read("canvas_list_pages_courses", {
    course_id: COURSE,
    search_term: pageTitle,
  })), (row) => row.title === pageTitle);
  const pageTitleUpdated = `${pageTitle} updated`;
  requireVerified("page update", await change("current.page.update", "canvas_update_create_page_courses", {
    course_id: COURSE,
    url_or_id: String(createdPage.url),
    wiki_page_title: pageTitleUpdated,
    wiki_page_body: `<p>${mark} updated</p>`,
    wiki_page_published: false,
  }));
  const savedPage = requireRead("page show", await read("canvas_show_page_courses", {
    course_id: COURSE,
    url_or_id: String(createdPage.url),
  }));
  if (savedPage?.title !== pageTitleUpdated || savedPage?.published !== false || !String(savedPage?.body).includes(`${mark} updated`)) {
    throw new Error("page provider readback did not match the update");
  }
  receipt.writes.page = { create: "verified", update: "verified", providerReadback: "verified", id: String(createdPage.url) };

  const assignmentName = `${mark} assignment`;
  requireVerified("assignment create", await change("current.assignment.create", "canvas_create_assignment", {
    course_id: COURSE,
    assignment_name: assignmentName,
    assignment_description: `<p>${mark} original</p>`,
    assignment_published: false,
  }));
  const createdAssignment = requireMatch("created assignment", requireRead("assignment list", await read("canvas_list_assignments_assignments", {
    course_id: COURSE,
  })), (row) => row.name === assignmentName);
  const assignmentNameUpdated = `${assignmentName} updated`;
  requireVerified("assignment update", await change("current.assignment.update", "canvas_edit_assignment", {
    course_id: COURSE,
    id: String(createdAssignment.id),
    assignment_name: assignmentNameUpdated,
    assignment_description: `<p>${mark} updated</p>`,
    assignment_published: false,
  }));
  const savedAssignment = requireRead("assignment show", await read("canvas_get_single_assignment", {
    course_id: COURSE,
    id: String(createdAssignment.id),
  }));
  if (savedAssignment?.name !== assignmentNameUpdated || savedAssignment?.published !== false || !String(savedAssignment?.description).includes(`${mark} updated`)) {
    throw new Error("assignment provider readback did not match the update");
  }
  receipt.writes.assignment = { create: "verified", update: "verified", providerReadback: "verified", id: String(createdAssignment.id) };

  const moduleName = `${mark} module`;
  requireVerified("module create", await change("current.module.create", "canvas_create_module", {
    course_id: COURSE,
    module_name: moduleName,
  }));
  const createdModule = requireMatch("created module", requireRead("module list", await read("canvas_list_modules", {
    course_id: COURSE,
  })), (row) => row.name === moduleName);
  const moduleNameUpdated = `${moduleName} updated`;
  requireVerified("module update", await change("current.module.update", "canvas_update_module", {
    course_id: COURSE,
    id: String(createdModule.id),
    module_name: moduleNameUpdated,
  }));
  const savedModule = requireMatch("updated module", requireRead("updated module list", await read("canvas_list_modules", {
    course_id: COURSE,
  })), (row) => String(row.id) === String(createdModule.id));
  if (savedModule.name !== moduleNameUpdated) throw new Error("module provider readback did not match the update");
  receipt.writes.module = { create: "verified", update: "verified", providerReadback: "verified", id: String(createdModule.id) };

  const topicTitle = `${mark} discussion`;
  requireVerified("discussion create", await change("current.discussion.create", "canvas_create_new_discussion_topic_courses", {
    course_id: COURSE,
    title: topicTitle,
    message: `<p>${mark} original</p>`,
    published: false,
  }));
  const createdTopic = requireMatch("created discussion", requireRead("discussion list", await read("canvas_list_discussion_topics_courses", {
    course_id: COURSE,
  })), (row) => row.title === topicTitle);
  const topicTitleUpdated = `${topicTitle} updated`;
  requireVerified("discussion update", await change("current.discussion.update", "canvas_update_topic_courses", {
    course_id: COURSE,
    topic_id: String(createdTopic.id),
    title: topicTitleUpdated,
    message: `<p>${mark} updated</p>`,
    published: false,
  }));
  const savedTopic = requireRead("discussion show", await read("canvas_get_single_topic_courses", {
    course_id: COURSE,
    topic_id: String(createdTopic.id),
  }));
  if (savedTopic?.title !== topicTitleUpdated || savedTopic?.published !== false || !String(savedTopic?.message).includes(`${mark} updated`)) {
    throw new Error("discussion provider readback did not match the update");
  }
  receipt.writes.discussion = { create: "verified", update: "verified", providerReadback: "verified", id: String(createdTopic.id) };

  const quizTitle = `${mark} quiz`;
  requireVerified("classic quiz create", await change("current.quiz.create", "canvas_create_quiz", {
    course_id: COURSE,
    quiz_title: quizTitle,
    quiz_published: false,
  }));
  const savedQuiz = requireMatch("created classic quiz", requireRead("quiz list", await read("canvas_list_quizzes_in_course", {
    course_id: COURSE,
  })), (row) => row.title === quizTitle);
  if (savedQuiz?.published !== false) throw new Error("classic quiz provider readback was not unpublished");
  receipt.writes.classicQuiz = { create: "verified", providerReadback: "verified", id: String(savedQuiz.id) };

  receipt.completedAt = new Date().toISOString();
  receipt.ok = true;
  process.stdout.write(`CANVAS_CURRENT_SAFE_PROOF ${JSON.stringify(receipt)}\n`);
} finally {
  await close();
}
