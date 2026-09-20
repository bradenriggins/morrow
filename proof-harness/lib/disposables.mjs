// Objects this sweep makes for itself, so a write is proved against something the
// sweep created and never against content the course already held. Each one is
// stamped with the sweep's mark, and the sweep removes every one it made.
import { SANDBOX } from "../connect.mjs";
import { OPERATIONS } from "./catalog.mjs";

const COURSE = SANDBOX.courseId;

export function disposablePlan(mark) {
  return [
    { key: "page_id", alsoKey: "url_or_id", tool: "canvas_create_page_courses", args: { course_id: COURSE, wiki_page_title: `${mark} page`, wiki_page_body: "<p>sweep</p>", wiki_page_published: false },
      idFromArgs: () => `${mark.toLowerCase()}-page`,
      list: { tool: "canvas_list_pages_courses", args: { course_id: COURSE } }, match: (row) => String(row.title || "").includes(mark), id: (row) => String(row.url),
      remove: { tool: "canvas_delete_page_courses", args: (id) => ({ course_id: COURSE, url_or_id: id }) } },
    { key: "assignment_id", tool: "canvas_create_assignment", args: { course_id: COURSE, assignment_name: `${mark} assignment`, assignment_published: false },
      list: { tool: "canvas_list_assignments_assignments", args: { course_id: COURSE } }, match: (row) => String(row.name || "").includes(mark), id: (row) => String(row.id),
      remove: { tool: "canvas_delete_assignment", args: (id) => ({ course_id: COURSE, id }) } },
    { key: "topic_id", tool: "canvas_create_new_discussion_topic_courses", args: { course_id: COURSE, title: `${mark} topic`, message: "sweep", published: false },
      list: { tool: "canvas_list_discussion_topics_courses", args: { course_id: COURSE } }, match: (row) => String(row.title || "").includes(mark), id: (row) => String(row.id),
      remove: { tool: "canvas_delete_topic_courses", args: (id) => ({ course_id: COURSE, topic_id: id }) } },
    { key: "quiz_id", tool: "canvas_create_quiz", args: { course_id: COURSE, quiz_title: `${mark} quiz`, quiz_published: false },
      list: { tool: "canvas_list_quizzes_in_course", args: { course_id: COURSE } }, match: (row) => String(row.title || "").includes(mark), id: (row) => String(row.id),
      remove: { tool: "canvas_delete_quiz", args: (id) => ({ course_id: COURSE, id }) } },
    { key: "module_id", tool: "canvas_create_module", args: { course_id: COURSE, module_name: `${mark} module` },
      list: { tool: "canvas_list_modules", args: { course_id: COURSE } }, match: (row) => String(row.name || "").includes(mark), id: (row) => String(row.id),
      remove: { tool: "canvas_delete_module", args: (id) => ({ course_id: COURSE, id }) } },
    { key: "assignment_group_id", tool: "canvas_create_assignment_group", args: { course_id: COURSE, name: `${mark} group` },
      list: { tool: "canvas_list_assignment_groups", args: { course_id: COURSE } }, match: (row) => String(row.name || "").includes(mark), id: (row) => String(row.id),
      remove: { tool: "canvas_destroy_assignment_group", args: (id) => ({ course_id: COURSE, assignment_group_id: id }) } },
    { key: "section_id", tool: "canvas_create_course_section", args: { course_id: COURSE, course_section_name: `${mark} section` },
      list: { tool: "canvas_list_course_sections", args: { course_id: COURSE } }, match: (row) => String(row.name || "").includes(mark), id: (row) => String(row.id),
      remove: { tool: "canvas_delete_section", args: (id) => ({ id }) } },
    { key: "column_id", tool: "canvas_create_custom_gradebook_column", args: { course_id: COURSE, column_title: `${mark} column` },
      list: { tool: "canvas_list_custom_gradebook_columns", args: { course_id: COURSE, include_hidden: true } }, match: (row) => String(row.title || "").includes(mark), id: (row) => String(row.id),
      remove: { tool: "canvas_delete_custom_gradebook_column", args: (id) => ({ course_id: COURSE, id }) } },
    { key: "group_category_id", tool: "canvas_create_group_category_courses", args: { course_id: COURSE, name: `${mark} set` },
      list: { tool: "canvas_list_group_categories_for_context_courses", args: { course_id: COURSE } }, match: (row) => String(row.name || "").includes(mark), id: (row) => String(row.id),
      remove: { tool: "canvas_delete_group_category", args: (id) => ({ group_category_id: id }) } },
    { key: "event_id", tool: "canvas_create_calendar_event", args: { calendar_event_context_code: `course_${COURSE}`, calendar_event_title: `${mark} event`, calendar_event_start_at: "2026-10-04T15:00:00Z", calendar_event_end_at: "2026-10-04T16:00:00Z" },
      list: { tool: "canvas_list_calendar_events", args: { context_codes: [`course_${COURSE}`], all_events: true } }, match: (row) => String(row.title || "").includes(mark), id: (row) => String(row.id),
      remove: { tool: "canvas_delete_calendar_event", args: (id) => ({ id }) } },
    // A group lives inside the set made just above, so this one is built from
    // what the sweep already made rather than from anything the course held.
    { key: "group_id", needs: ["group_category_id"],
      tool: "canvas_create_group_group_categories", argsFrom: (made) => ({ group_category_id: made.group_category_id, name: `${mark} team` }),
      list: { tool: "canvas_list_groups_available_in_context_courses", args: { course_id: COURSE } }, match: (row) => String(row.name || "").includes(mark), id: (row) => String(row.id),
      remove: { tool: "canvas_delete_group", args: (id) => ({ group_id: id }) } },
    // Polls are global objects outside the test course, so this sandbox sweep
    // does not make them. Poll routes stay unreachable rather than touch
    // anything outside course 89585.
    // The same kinds of object inside the group this sweep made, so a group route
    // is proved against the group's own content and never against the course's.
    { key: "page_id", context: "group", needs: ["group_id"], alsoKey: "url_or_id",
      tool: "canvas_create_page_groups", argsFrom: (made) => ({ group_id: made.group_id, wiki_page_title: `${mark} group page`, wiki_page_body: "<p>sweep</p>", wiki_page_published: false }),
      idFromArgs: () => `${mark.toLowerCase()}-group-page`,
      listFrom: (made) => ({ tool: "canvas_list_pages_groups", args: { group_id: made.group_id } }), match: (row) => String(row.title || "").includes(mark), id: (row) => String(row.url),
      remove: { tool: "canvas_delete_page_groups", args: (id, made) => ({ group_id: made.group_id, url_or_id: id }) } },
    { key: "topic_id", context: "group", needs: ["group_id"],
      tool: "canvas_create_new_discussion_topic_groups", argsFrom: (made) => ({ group_id: made.group_id, title: `${mark} group topic`, message: "sweep", published: false }),
      listFrom: (made) => ({ tool: "canvas_list_discussion_topics_groups", args: { group_id: made.group_id } }), match: (row) => String(row.title || "").includes(mark), id: (row) => String(row.id),
      remove: { tool: "canvas_delete_topic_groups", args: (id, made) => ({ group_id: made.group_id, topic_id: id }) } },
    { key: "folder_id", context: "group", needs: ["group_id"],
      tool: "canvas_create_folder_groups", argsFrom: (made) => ({ group_id: made.group_id, name: `${mark}-folder`, parent_folder_path: "/" }),
      listFrom: (made) => ({ tool: "canvas_list_all_folders_groups", args: { group_id: made.group_id } }), match: (row) => String(row.name || "").includes(mark), id: (row) => String(row.id),
      remove: { tool: "canvas_delete_folder", args: (id) => ({ id }) } },
    // Objects inside the objects above, so a change that needs a module item, a
    // discussion entry, a quiz question or a rubric has one this sweep made.
    { key: "item_id", needs: ["module_id", "page_id"],
      tool: "canvas_create_module_item", argsFrom: (made) => ({ course_id: COURSE, module_id: made.module_id, module_item_type: "Page", module_item_title: `${mark} item`, module_item_page_url: made.page_id }),
      listFrom: (made) => ({ tool: "canvas_list_module_items", args: { course_id: COURSE, module_id: made.module_id } }), match: (row) => String(row.title || "").includes(mark), id: (row) => String(row.id),
      remove: { tool: "canvas_delete_module_item", args: (id, made) => ({ course_id: COURSE, module_id: made.module_id, id }) } },
    { key: "entry_id", needs: ["topic_id"],
      tool: "canvas_post_entry_courses", argsFrom: (made) => ({ course_id: COURSE, topic_id: made.topic_id, message: `${mark} entry` }),
      listFrom: (made) => ({ tool: "canvas_list_topic_entries_courses", args: { course_id: COURSE, topic_id: made.topic_id } }), match: (row) => String(row.message || "").includes(mark), id: (row) => String(row.id),
      remove: { tool: "canvas_delete_entry_courses", args: (id, made) => ({ course_id: COURSE, topic_id: made.topic_id, id }) } },
    { key: "question_id", needs: ["quiz_id"],
      tool: "canvas_create_single_quiz_question", argsFrom: (made) => ({ course_id: COURSE, quiz_id: made.quiz_id, question_question_name: `${mark} question`, question_question_text: "Which one?", question_question_type: "true_false_question" }),
      listFrom: (made) => ({ tool: "canvas_list_questions_in_quiz_or_submission", args: { course_id: COURSE, quiz_id: made.quiz_id } }), match: (row) => String(row.question_name || "").includes(mark), id: (row) => String(row.id),
      remove: { tool: "canvas_delete_quiz_question", args: (id, made) => ({ course_id: COURSE, quiz_id: made.quiz_id, id }) } },
    { key: "override_id", needs: ["assignment_id", "section_id"],
      tool: "canvas_create_assignment_override", argsFrom: (made) => ({ course_id: COURSE, assignment_id: made.assignment_id, assignment_override_course_section_id: made.section_id, assignment_override_title: `${mark} override` }),
      listFrom: (made) => ({ tool: "canvas_list_assignment_overrides", args: { course_id: COURSE, assignment_id: made.assignment_id } }), match: (row) => String(row.title || "").includes(mark), id: (row) => String(row.id),
      remove: { tool: "canvas_delete_assignment_override", args: (id, made) => ({ course_id: COURSE, assignment_id: made.assignment_id, id }) } },
    { key: "rubric_id", needs: ["assignment_id"],
      tool: "canvas_create_single_rubric", argsFrom: (made) => ({ course_id: COURSE, rubric_title: `${mark} rubric`, rubric_association_association_id: made.assignment_id, rubric_association_association_type: "Assignment", rubric_association_purpose: "grading" }),
      list: { tool: "canvas_list_rubrics_courses", args: { course_id: COURSE } }, match: (row) => String(row.title || "").includes(mark), id: (row) => String(row.id),
      remove: null },
    { key: "rubric_association_id", needs: ["rubric_id", "assignment_id"],
      tool: "canvas_create_rubricassociation", argsFrom: (made) => ({ course_id: COURSE, rubric_association_rubric_id: made.rubric_id, rubric_association_association_id: made.assignment_id, rubric_association_association_type: "Assignment", rubric_association_purpose: "grading", rubric_association_title: `${mark} association` }),
      list: { tool: "canvas_list_rubrics_courses", args: { course_id: COURSE } }, match: (row) => String(row.title || "").includes(mark), id: (row) => String(row.id),
      remove: { tool: "canvas_delete_rubricassociation", args: (id) => ({ course_id: COURSE, id }) } },
    { key: "external_tool_id", tool: "canvas_create_external_tool_courses",
      args: { course_id: COURSE, name: `${mark} tool`, privacy_level: "anonymous", consumer_key: "morrow-sweep-key", shared_secret: "morrow-sweep-secret", url: "https://example.edu/morrow-sweep-lti" },
      list: { tool: "canvas_list_external_tools_courses", args: { course_id: COURSE } }, match: (row) => String(row.name || "").includes(mark), id: (row) => String(row.id),
      remove: { tool: "canvas_delete_external_tool_courses", args: (id) => ({ course_id: COURSE, external_tool_id: id }) } },
    // Canvas names a course feature by a word, not a number, and the course
    // already has its own list of them.
    { key: "feature", tool: null,
      readOnlySeed: { tool: "canvas_list_features_courses", args: { course_id: COURSE } }, match: (row) => Boolean(row && row.feature), id: (row) => String(row.feature) },
    { key: "outcome_group_id", tool: null,
      readOnlySeed: { tool: "canvas_get_all_outcome_groups_for_context_courses", args: { course_id: COURSE } }, match: () => true, id: (row) => String(row.id) },
    { key: "grading_standard_id", tool: "canvas_create_new_grading_standard_courses",
      args: { course_id: COURSE, title: `${mark} standard`, grading_scheme_entry_name: ["A", "F"], grading_scheme_entry_value: [90, 0] },
      list: { tool: "canvas_list_grading_standards_available_in_context_courses", args: { course_id: COURSE } }, match: (row) => String(row.title || "").includes(mark), id: (row) => String(row.id),
      remove: null },
  ];
}

/** Creates one of each disposable and returns the ids the sweep may address. */
export async function makeDisposables(mark, { read, change, log }) {
  const made = {};
  const cleanup = [];
  const plan = disposablePlan(mark);
  for (const [planIndex, entry] of plan.entries()) {
    if ((entry.needs || []).some((name) => made[name] === undefined)) {
      // `needs` always names a course-scoped id this plan made earlier.
      if (log) await log(`disposable ${entry.key}: skipped, needs ${(entry.needs || []).join(" ")}`);
      continue;
    }
    // Some kinds are not made: the course already has one, and this sweep only
    // needs its id to address it. Nothing is created and nothing is removed.
    if (entry.readOnlySeed) {
      const listed = await read(entry.readOnlySeed.tool, entry.readOnlySeed.args);
      const found = (Array.isArray(listed.data) ? listed.data : []).find(entry.match);
      if (found) made[`${entry.context ? `${entry.context}:` : ""}${entry.key}`] = entry.id(found);
      else if (log) await log(`disposable ${entry.key}: the course has none to address`);
      continue;
    }
    const created = await change(`disposable.${entry.key}`, entry.tool, entry.argsFrom ? entry.argsFrom(made) : entry.args);
    // A change Morrow could not confirm may still have been saved. The listing
    // below decides that, not the outcome: what matters here is whether the
    // object this sweep needs is there.
    if (!["verified", "sent_unchecked", "applied_or_unknown", "awaiting_verification"].includes(String(created.outcome))) {
      if (log) await log(`disposable ${entry.key}: ${created.outcome} ${(created.error || created.plan?.text || "").slice(0, 100)}`);
      continue;
    }
    // Canvas gives a page its address from its title, so the page this sweep made
    // is named without searching a listing the course has filled for years.
    if (entry.idFromArgs) {
      const id = entry.idFromArgs(made);
      const scope = entry.context ? `${entry.context}:` : "";
      made[`${scope}${entry.key}`] = id;
      if (entry.alsoKey) made[`${scope}${entry.alsoKey}`] = id;
      if (entry.remove) cleanup.push({ key: entry.key, context: entry.context || null, planIndex, id, remove: entry.remove, made: { ...made } });
      continue;
    }
    const listing = entry.listFrom ? entry.listFrom(made) : entry.list;
    // The course already holds years of content, so the object this sweep just
    // made can be past the end of its listing. A listing that can be searched is
    // asked for this sweep's own mark instead of being read page by page.
    const searchable = OPERATIONS.find((candidate) => candidate.toolName === listing.tool)
      ?.parameters?.some((parameter) => parameter.inputName === "search_term");
    const listed = await read(listing.tool, {
      ...listing.args,
      ...(searchable ? { search_term: mark } : {}),
      morrow_max_pages: 10,
    });
    const rowsValue = Array.isArray(listed.data) ? listed.data : [];
    const row = rowsValue.find(entry.match);
    if (!row) { if (log) await log(`disposable ${entry.key}: created but not found in its listing`); continue; }
    const id = entry.id(row);
    const scope = entry.context ? `${entry.context}:` : "";
    made[`${scope}${entry.key}`] = id;
    if (entry.alsoKey) made[`${scope}${entry.alsoKey}`] = id;
    if (entry.remove) cleanup.push({ key: entry.key, context: entry.context || null, planIndex, id, remove: entry.remove, made: { ...made } });
  }
  if (log) await log(`disposables: ${Object.entries(made).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  return { made, cleanup };
}

/** Removes every object this sweep made, through Morrow. */
export async function removeDisposables(cleanup, { change, log }) {
  // Each removal is reported, so a run can state what it left behind instead of assuming none.
  const removedEach = [];
  for (const entry of [...cleanup].reverse()) {
    const removed = await change(`disposable.remove.${entry.key}`, entry.remove.tool, entry.remove.args(entry.id, entry.made || {}));
    removedEach.push({ key: entry.key, id: entry.id, outcome: removed.outcome });
    if (log && removed.outcome !== "verified") await log(`disposable remove ${entry.key}: ${removed.outcome}`);
  }
  return { removed: removedEach, leftBehind: removedEach.filter((row) => row.outcome !== "verified") };
}
