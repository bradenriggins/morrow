// Scenario checks. Each one passes only when the claimed work was read back. Callers inject
// the tool client, so a test never opens a live course.
import {
  QUIZ_TIME_LIMIT_SECONDS,
  absenceOf,
  judgeCourseComparison,
  judgePrivacyScenario,
  judgeQuizAuthoring,
  judgeUndoRestoration,
  listRead,
  questionReadBack,
  quizSettingsReadBack,
  rowByIdentity,
} from "../lib/proof-rules.mjs";

const RAW_IDENTITY = /"(?:user_id|sis_user_id|login_id|integration_id|email|primary_email|short_name|sortable_name)"\s*:/;
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

export function privacyFindings(value) {
  const text = JSON.stringify(value ?? null);
  const findings = [];
  if (RAW_IDENTITY.test(text)) findings.push("a raw learner identity field reached the result");
  if (EMAIL.test(text)) findings.push("an email address reached the result");
  return findings;
}

export async function runPrivacyScenario({ read, courseId }) {
  const assignments = await read("canvas_list_assignments_assignments", { course_id: courseId });
  const assignmentRows = listRead(assignments);
  if (!assignments?.ok || !assignmentRows.ok) {
    return { verdict: "FAIL", reason: "The assignment list did not answer.", privacy: { tokenized: false } };
  }
  const first = assignmentRows.rows[0];
  if (!first) return { verdict: "BLOCKED", reason: "The sandbox course holds no assignment to read scores from.", privacy: { tokenized: false } };
  const submissions = await read("canvas_list_assignment_submissions_courses", { course_id: courseId, assignment_id: String(first.id) });
  const findings = [...privacyFindings(submissions?.data), ...privacyFindings(assignments.data)];
  return judgePrivacyScenario({ submissions, findings });
}

export async function runQuizScenario({ plan, read, courseId, mark }) {
  const title = `${mark} Cell Structure`;
  const questionTitle = `${mark} cell question`;
  const made = await plan("scenario.quiz.create", "morrow_plan_new_quiz_create", { course_id: courseId, quiz: { title } });
  if (made.outcome !== "verified") {
    return {
      verdict: made.outcome === "approval_withheld" ? "BLOCKED" : "FAIL",
      reason: `Morrow did not complete the quiz creation: ${made.outcome}.`,
      detail: made.approvalSentence,
    };
  }
  const quizzes = await read("canvas_list_new_quizzes", { course_id: courseId });
  const quizRows = listRead(quizzes);
  const saved = quizRows.ok ? rowByIdentity(quizRows.rows, { title }) : null;
  if (!quizRows.ok || !saved) {
    return { verdict: "FAIL", reason: "Canvas does not list the quiz Morrow reported as saved." };
  }
  const quizId = String(saved.id);
  const question = await plan("scenario.quiz.question", "morrow_plan_new_quiz_item_create", {
    course_id: courseId,
    quiz_id: quizId,
    item: {
      entry_type: "Item",
      points_possible: 1,
      entry: {
        title: questionTitle,
        item_body: "<p>Which part holds the DNA?</p>",
        interaction_type_slug: "true-false",
        calculator_type: "none",
        interaction_data: { true_choice: "True", false_choice: "False" },
        scoring_data: { value: true },
        scoring_algorithm: "Equivalence",
      },
    },
  });
  const settings = await plan("scenario.quiz.time", "morrow_plan_new_quiz_settings", {
    course_id: courseId,
    quiz_id: quizId,
    settings: { has_time_limit: true, session_time_limit_in_seconds: QUIZ_TIME_LIMIT_SECONDS },
  });
  const items = await read("canvas_list_quiz_items", { course_id: courseId, assignment_id: quizId });
  const quiz = await read("canvas_get_new_quiz", { course_id: courseId, assignment_id: quizId });
  const judged = judgeQuizAuthoring({
    quizId,
    questionAdded: question.outcome === "verified",
    questionReadBack: questionReadBack(items, questionTitle),
    timeLimitSet: settings.outcome === "verified",
    timeLimitReadBack: quizSettingsReadBack(quiz, QUIZ_TIME_LIMIT_SECONDS),
  });
  return {
    ...judged,
    cleanupTarget: { tool: "canvas_delete_assignment", args: { course_id: courseId, id: quizId } },
  };
}

export async function runUndoScenario({ change, read, callTool, courseId, mark, binding }) {
  const title = `${mark} undo page`;
  const made = await change("scenario.undo.create", "canvas_create_page_courses", {
    course_id: courseId, wiki_page_title: title, wiki_page_body: "<p>undo me</p>", wiki_page_published: false,
  });
  const before = await read("canvas_list_pages_courses", { course_id: courseId, search_term: title });
  const prior = listRead(before);
  const saved = prior.ok ? rowByIdentity(prior.rows, { title }) : null;
  if (!made.operationId || !saved?.url) {
    return {
      verdict: "BLOCKED",
      reason: `The page this scenario needs was not created (${made.outcome}), so undo could not be asked for.`,
    };
  }
  await callTool("morrow_operation_undo", {
    operation_id: made.operationId,
    correction_tool: "canvas_delete_page_courses",
    correction_arguments: { course_id: courseId, url_or_id: String(saved.url), _morrow: { source_binding_id: binding } },
  }, 600_000).catch((error) => ({ threw: String(error).slice(0, 200) }));
  const after = await read("canvas_list_pages_courses", { course_id: courseId, search_term: title });
  const judged = judgeUndoRestoration({ before, after, identity: { title, id: String(saved.url) } });
  const still = absenceOf(after, { title, id: String(saved.url) });
  return {
    ...judged,
    ...(still.gone ? {} : { cleanupTarget: { tool: "canvas_delete_page_courses", args: { course_id: courseId, url_or_id: String(saved.url) } } }),
  };
}

export async function runCompareScenario({ read, courseId }) {
  const listed = await read("canvas_list_your_courses", {});
  const courses = listRead(listed);
  if (!listed?.ok || !courses.ok) {
    return { verdict: "FAIL", reason: "The course list did not answer, so there is no comparison." };
  }
  if (courses.rows.length < 2) {
    return {
      verdict: "BLOCKED",
      reason: `This connection sees ${courses.rows.length} course, so there is no second course to compare against.`,
      readback: { source: "canvas", coursesVisible: courses.rows.length },
    };
  }
  const left = courses.rows.find((row) => String(row.id) === String(courseId)) ?? courses.rows[0];
  const right = courses.rows.find((row) => String(row.id) !== String(left.id));
  const leftPages = await read("canvas_list_pages_courses", { course_id: String(left.id) });
  const rightPages = await read("canvas_list_pages_courses", { course_id: String(right.id) });
  return judgeCourseComparison({
    coursesVisible: courses.rows.length,
    left: leftPages,
    right: rightPages,
    leftId: String(left.id),
    rightId: String(right.id),
  });
}
