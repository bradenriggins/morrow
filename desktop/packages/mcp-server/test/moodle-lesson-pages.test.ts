import { describe, expect, it } from "vitest";
import {
  MOODLE_LESSON_PAGE_LIST_SCHEMA,
  MOODLE_LESSON_PAGE_SCHEMA,
  projectMoodleLessonPage,
  projectMoodleLessonPageList,
} from "../src/moodle-lesson-pages.js";

const listProof = {
  list_source: "mod_lesson_edit_page",
  page_source: "mod_lesson_editpage_form",
  exact_module_binding: "course_modedit_form",
  required_capability: "mod/lesson:manage",
  page_form_capability: "mod/lesson:edit",
  jump_source: "editpage_form_stored_answers",
  learner_progress: "not_recorded",
  page_content: "not_returned",
  view_route: "never_opened",
  page_limit: 100,
  answer_limit: 40,
  page_request_count: 3,
};

const pageProof = {
  list_source: "mod_lesson_edit_page",
  page_source: "mod_lesson_editpage_form",
  exact_module_binding: "course_modedit_form",
  required_capability: "mod/lesson:manage",
  page_form_capability: "mod/lesson:edit",
  jump_source: "editpage_form_stored_answers",
  learner_progress: "not_recorded",
  file_bearing_text: "refused",
  view_route: "never_opened",
  page_limit: 100,
  answer_limit: 40,
};

const graph = {
  schema: MOODLE_LESSON_PAGE_LIST_SCHEMA,
  provider: "moodle",
  course_id: 2,
  module_id: 8,
  lesson_id: 71,
  page_count: 3,
  pages: [
    {
      page_id: 101, position: 1, title: "Choose a path", page_type: "branchtable", page_type_id: 20, page_kind: "content",
      jumps: [{ index: 0, target: "page", page_id: 102 }, { index: 1, target: "page", page_id: 103 }],
      branch_target_page_ids: [102, 103],
    },
    {
      page_id: 102, position: 2, title: "Cell overview", page_type: "branchtable", page_type_id: 20, page_kind: "content",
      jumps: [{ index: 0, target: "next_page" }],
      branch_target_page_ids: [],
    },
    {
      page_id: 103, position: 3, title: "Organelle check", page_type: "multichoice", page_type_id: 3, page_kind: "question",
      jumps: [{ index: 0, target: "page", page_id: 101 }, { index: 1, target: "this_page" }],
      branch_target_page_ids: [101],
    },
  ],
  proof: listProof,
};

const lessonPage = {
  schema: MOODLE_LESSON_PAGE_SCHEMA,
  provider: "moodle",
  course_id: 2,
  module_id: 8,
  lesson_id: 71,
  page_id: 103,
  position: 3,
  page_count: 3,
  title: "Organelle check",
  page_type: "multichoice",
  page_type_id: 3,
  page_kind: "question",
  contents_text: "<p>Which one makes ATP?</p>",
  contents_format: "1",
  answer_count: 2,
  answers: [
    { index: 0, answer_text: "Mitochondria", answer_format: "1", response_text: "Correct.", response_format: "1", score: "1", jump: { target: "page", page_id: 101 } },
    { index: 1, answer_text: "Ribosome", answer_format: "1", response_text: "Try again.", response_format: "1", score: "0", jump: { target: "this_page" } },
  ],
  proof: pageProof,
};

const listTarget = { courseId: 2, moduleId: 8 };
const pageTarget = { courseId: 2, moduleId: 8, pageId: 103 };

describe("Moodle Lesson page-list projection", () => {
  it("keeps the complete ordered graph and drops every field the browser added", () => {
    const result = projectMoodleLessonPageList({
      ...graph,
      sesskey: "moodle-private-session",
      pages: graph.pages.map((page) => ({ ...page, contents_text: "<p>private</p>", draft_item_id: 987654321 })),
    }, listTarget);
    expect(result).toEqual(graph);
    const serialized = JSON.stringify(result);
    for (const dropped of ["moodle-private-session", "987654321", "contents_text", "draft_item_id"]) {
      expect(serialized).not.toContain(dropped);
    }
  });

  it("refuses a changed target, a broken order, and a count that the pages contradict", () => {
    expect(() => projectMoodleLessonPageList({ ...graph, module_id: 9 }, listTarget)).toThrow("moodle_lesson_pages_invalid");
    expect(() => projectMoodleLessonPageList({ ...graph, course_id: 3 }, listTarget)).toThrow("moodle_lesson_pages_invalid");
    expect(() => projectMoodleLessonPageList({ ...graph, page_count: 4 }, listTarget)).toThrow("moodle_lesson_pages_invalid");
    expect(() => projectMoodleLessonPageList({
      ...graph,
      pages: [graph.pages[0], { ...graph.pages[1], position: 3 }, { ...graph.pages[2], position: 2 }],
    }, listTarget)).toThrow("moodle_lesson_pages_invalid");
    expect(() => projectMoodleLessonPageList({
      ...graph,
      pages: [graph.pages[0], { ...graph.pages[1], page_id: 101 }, graph.pages[2]],
    }, listTarget)).toThrow("moodle_lesson_pages_invalid");
    expect(() => projectMoodleLessonPageList({ ...graph, proof: { ...listProof, page_request_count: 2 } }, listTarget))
      .toThrow("moodle_lesson_pages_invalid");
    expect(() => projectMoodleLessonPageList({ ...graph, proof: { ...listProof, view_route: "opened" } }, listTarget))
      .toThrow("moodle_lesson_pages_invalid");
  });

  it("refuses a page type it cannot name and a page kind that does not match the type", () => {
    expect(() => projectMoodleLessonPageList({
      ...graph,
      pages: [{ ...graph.pages[0], page_type: "h5p", page_type_id: 99 }, graph.pages[1], graph.pages[2]],
    }, listTarget)).toThrow("moodle_lesson_pages_invalid");
    expect(() => projectMoodleLessonPageList({
      ...graph,
      pages: [{ ...graph.pages[0], page_kind: "question" }, graph.pages[1], graph.pages[2]],
    }, listTarget)).toThrow("moodle_lesson_pages_invalid");
  });

  it("refuses a jump Morrow cannot name, a jump outside the Lesson, and branch targets the jumps contradict", () => {
    expect(() => projectMoodleLessonPageList({
      ...graph,
      pages: [graph.pages[0], { ...graph.pages[1], jumps: [{ index: 0, target: "somewhere_else" }] }, graph.pages[2]],
    }, listTarget)).toThrow("moodle_lesson_pages_invalid");
    expect(() => projectMoodleLessonPageList({
      ...graph,
      pages: [
        graph.pages[0],
        { ...graph.pages[1], jumps: [{ index: 0, target: "page", page_id: 999 }], branch_target_page_ids: [999] },
        graph.pages[2],
      ],
    }, listTarget)).toThrow("moodle_lesson_pages_invalid");
    expect(() => projectMoodleLessonPageList({
      ...graph,
      pages: [{ ...graph.pages[0], branch_target_page_ids: [102] }, graph.pages[1], graph.pages[2]],
    }, listTarget)).toThrow("moodle_lesson_pages_invalid");
  });
});

describe("Moodle Lesson page projection", () => {
  it("keeps the page, its answers, responses, scores and jumps", () => {
    const result = projectMoodleLessonPage({ ...lessonPage, sesskey: "moodle-private-session", draft_item_id: 987654321 }, pageTarget);
    expect(result).toEqual(lessonPage);
    expect(JSON.stringify(result)).not.toContain("moodle-private-session");
    expect(JSON.stringify(result)).not.toContain("987654321");
  });

  it("keeps a page whose type carries no answer control", () => {
    const essay = {
      ...lessonPage,
      page_id: 105,
      position: 3,
      title: "Reflection",
      page_type: "essay",
      page_type_id: 10,
      contents_text: "<p>Write a paragraph.</p>",
      answer_count: 1,
      answers: [{ index: 0, answer_text: null, answer_format: null, response_text: null, response_format: null, score: "1", jump: { target: "end_of_lesson" } }],
    };
    expect(projectMoodleLessonPage(essay, { ...pageTarget, pageId: 105 })).toEqual(essay);
  });

  it("refuses rich text that carries a draft-file reference or embedded media", () => {
    for (const field of ["contents_text", "answer_text", "response_text"]) {
      const carrier = '<p><img src="draftfile.php/999/private-diagram.png"></p>';
      const value = field === "contents_text"
        ? { ...lessonPage, contents_text: carrier }
        : { ...lessonPage, answers: [{ ...lessonPage.answers[0], [field]: carrier }, lessonPage.answers[1]] };
      expect(() => projectMoodleLessonPage(value, pageTarget), field).toThrow("moodle_lesson_page_invalid");
    }
    expect(() => projectMoodleLessonPage({ ...lessonPage, contents_text: "<p>@@PLUGINFILE@@/map.png</p>" }, pageTarget))
      .toThrow("moodle_lesson_page_invalid");
  });

  it("refuses a changed target, a position outside the Lesson, and an answer list the count contradicts", () => {
    expect(() => projectMoodleLessonPage({ ...lessonPage, page_id: 104 }, pageTarget)).toThrow("moodle_lesson_page_invalid");
    expect(() => projectMoodleLessonPage({ ...lessonPage, module_id: 9 }, pageTarget)).toThrow("moodle_lesson_page_invalid");
    expect(() => projectMoodleLessonPage({ ...lessonPage, position: 4 }, pageTarget)).toThrow("moodle_lesson_page_invalid");
    expect(() => projectMoodleLessonPage({ ...lessonPage, answer_count: 3 }, pageTarget)).toThrow("moodle_lesson_page_invalid");
    expect(() => projectMoodleLessonPage({ ...lessonPage, answers: [lessonPage.answers[1], lessonPage.answers[0]] }, pageTarget))
      .toThrow("moodle_lesson_page_invalid");
    expect(() => projectMoodleLessonPage({ ...lessonPage, proof: { ...pageProof, file_bearing_text: "returned" } }, pageTarget))
      .toThrow("moodle_lesson_page_invalid");
  });

  it("refuses a score, a format and a jump it cannot name", () => {
    expect(() => projectMoodleLessonPage({
      ...lessonPage,
      answers: [{ ...lessonPage.answers[0], score: "one" }, lessonPage.answers[1]],
    }, pageTarget)).toThrow("moodle_lesson_page_invalid");
    expect(() => projectMoodleLessonPage({
      ...lessonPage,
      answers: [{ ...lessonPage.answers[0], response_format: null }, lessonPage.answers[1]],
    }, pageTarget)).toThrow("moodle_lesson_page_invalid");
    expect(() => projectMoodleLessonPage({
      ...lessonPage,
      answers: [{ ...lessonPage.answers[0], jump: { target: "somewhere_else" } }, lessonPage.answers[1]],
    }, pageTarget)).toThrow("moodle_lesson_page_invalid");
    expect(() => projectMoodleLessonPage({ ...lessonPage, contents_format: "html" }, pageTarget))
      .toThrow("moodle_lesson_page_invalid");
  });
});
