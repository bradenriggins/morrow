import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { executeMoodleInPage } from "../../connector/extension/src/moodle-executor.js";

const listOperation = {
  key: "moodle.ajax.core_course_get_enrolled_courses_by_timeline_classification.v1",
  toolName: "moodle_list_my_courses",
  provider: "moodle",
  readOnly: true,
};

const pageReadOperation = {
  key: "moodle.form.course.modedit.page.read.v1",
  toolName: "moodle_get_page",
  provider: "moodle",
  readOnly: true,
};

const pageWriteOperation = {
  key: "moodle.form.course.modedit.page.write.v1",
  toolName: "moodle_update_page",
  provider: "moodle",
  readOnly: false,
};

const labelReadOperation = {
  key: "moodle.form.course.modedit.label.read.v1",
  toolName: "moodle_get_label",
  provider: "moodle",
  readOnly: true,
};

const labelWriteOperation = {
  key: "moodle.form.course.modedit.label.write.v1",
  toolName: "moodle_update_label",
  provider: "moodle",
  readOnly: false,
};

const labelCreateReadOperation = {
  key: "moodle.form.course.modedit.label.create.read.v1",
  toolName: "moodle_get_label_creation_form",
  provider: "moodle",
  readOnly: true,
};

const labelCreateWriteOperation = {
  key: "moodle.form.course.modedit.label.create.write.v1",
  toolName: "moodle_create_label",
  provider: "moodle",
  readOnly: false,
};

const urlReadOperation = {
  key: "moodle.form.course.modedit.url.read.v1",
  toolName: "moodle_get_url",
  provider: "moodle",
  readOnly: true,
};

const urlWriteOperation = {
  key: "moodle.form.course.modedit.url.write.v1",
  toolName: "moodle_update_url",
  provider: "moodle",
  readOnly: false,
};

const urlCreateReadOperation = {
  key: "moodle.form.course.modedit.url.create.read.v1",
  toolName: "moodle_get_url_creation_form",
  provider: "moodle",
  readOnly: true,
};

const urlCreateWriteOperation = {
  key: "moodle.form.course.modedit.url.create.write.v1",
  toolName: "moodle_create_url",
  provider: "moodle",
  readOnly: false,
};

const resourceFilesReadOperation = {
  key: "moodle.form.course.modedit.resource.files.read.v1",
  toolName: "moodle_get_resource_files",
  provider: "moodle",
  readOnly: true,
};

const resourceFileCreationReadOperation = {
  key: "moodle.form.course.modedit.resource.file.create.read.v1",
  toolName: "moodle_get_resource_file_creation_form",
  provider: "moodle",
  readOnly: true,
};

const resourceFileCreationWriteOperation = {
  key: "moodle.form.course.modedit.resource.file.create.write.v1",
  toolName: "moodle_create_resource_file",
  provider: "moodle",
  readOnly: false,
};

const pageCreateReadOperation = {
  key: "moodle.form.course.modedit.page.create.read.v1",
  toolName: "moodle_get_page_creation_form",
  provider: "moodle",
  readOnly: true,
};

const pageCreateWriteOperation = {
  key: "moodle.form.course.modedit.page.create.write.v1",
  toolName: "moodle_create_page",
  provider: "moodle",
  readOnly: false,
};

const assignmentReadOperation = {
  key: "moodle.form.course.modedit.assign.read.v1",
  toolName: "moodle_get_assignment",
  provider: "moodle",
  readOnly: true,
};

const assignmentWriteOperation = {
  key: "moodle.form.course.modedit.assign.write.v1",
  toolName: "moodle_update_assignment",
  provider: "moodle",
  readOnly: false,
};

const assignmentCreateReadOperation = {
  key: "moodle.form.course.modedit.assign.create.read.v1",
  toolName: "moodle_get_assignment_creation_form",
  provider: "moodle",
  readOnly: true,
};

const assignmentCreateWriteOperation = {
  key: "moodle.form.course.modedit.assign.create.write.v1",
  toolName: "moodle_create_assignment",
  provider: "moodle",
  readOnly: false,
};

const assignmentOverridesReadOperation = {
  key: "moodle.form.mod.assign.overrides.read.v1",
  toolName: "moodle_get_assignment_overrides",
  provider: "moodle",
  readOnly: true,
};

const assignmentOverrideCreateOperation = {
  key: "moodle.form.mod.assign.override.create.write.v1",
  toolName: "moodle_create_assignment_override",
  provider: "moodle",
  readOnly: false,
};

const assignmentOverrideWriteOperation = {
  key: "moodle.form.mod.assign.override.write.v1",
  toolName: "moodle_update_assignment_override",
  provider: "moodle",
  readOnly: false,
};

const quizQuestionsReadOperation = {
  key: "moodle.form.mod.quiz.edit.read.v1",
  toolName: "moodle_list_quiz_questions",
  provider: "moodle",
  readOnly: true,
};

const quizQuestionReadOperation = {
  key: "moodle.form.question.bank.editquestion.read.v1",
  toolName: "moodle_get_quiz_question",
  provider: "moodle",
  readOnly: true,
};


const quizQuestionCreationWriteOperation = {
  key: "moodle.form.mod.quiz.question.multichoice.create.write.v1",
  toolName: "moodle_create_quiz_multichoice_question",
  provider: "moodle",
  readOnly: false,
};

async function withMoodlePage(callback) {
  const keys = ["location", "M", "document", "fetch"];
  const descriptors = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  try {
    Object.defineProperties(globalThis, {
      location: { configurable: true, writable: true, value: { origin: "https://sandbox.moodledemo.net", pathname: "/course/view.php", href: "https://sandbox.moodledemo.net/course/view.php?id=2" } },
      M: { configurable: true, writable: true, value: { cfg: { wwwroot: "https://sandbox.moodledemo.net", sesskey: "moodle-session-secret", userId: 3, courseId: 2 } } },
      document: { configurable: true, writable: true, value: { body: { className: "path-course course-2" }, querySelector: (selector) => selector === "h1" ? { textContent: "My first course" } : null } },
    });
    await callback();
  } finally {
    for (const key of keys) {
      const descriptor = descriptors.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

function listInput(expiresAt = Date.now() + 60_000) {
  return {
    mode: "execute",
    operation: listOperation,
    arguments: { limit: 25, _morrow: { ignored: true } },
    binding: { origin: "https://sandbox.moodledemo.net", siteUrl: "https://sandbox.moodledemo.net/", principalId: "3", courseId: "2" },
    expiresAt,
  };
}

function pageForm(state, moduleId = 6, editorItemId = 0) {
  return `<!doctype html><html><body><form method="post" action="/course/modedit.php?update=${moduleId}&amp;return=0">
    <input name="update" value="${moduleId}"><input name="course" value="2"><input name="modulename" value="page"><input name="section" value="4">
    <input name="name" value="${state.name}"><textarea name="page[text]">${state.content}</textarea><input name="page[format]" value="1"><input name="page[itemid]" value="${editorItemId}">
    <input name="revision" value="${state.revision}"><input name="visible" value="${state.visible ? 1 : 0}"><input name="displayoptions[display]" value="1">
    <input type="checkbox" name="completionexpected[enabled]" value="1">
    <input name="completionexpected[year]" value="${state.completion.year}"><input name="completionexpected[month]" value="${state.completion.month}"><input name="completionexpected[day]" value="${state.completion.day}"><input name="completionexpected[hour]" value="${state.completion.hour}"><input name="completionexpected[minute]" value="${state.completion.minute}">
    <input type="submit" name="submitbutton" value="Save and return to course">
  </form></body></html>`;
}

function pageCreationForm(state, editorItemId = 0) {
  return `<!doctype html><html><body><form method="post" action="/course/modedit.php?add=page&amp;course=2&amp;sectionid=7&amp;return=0">
    <input name="course" value="2"><input name="add" value="page"><input name="modulename" value="page"><input name="section" value="4"><input name="return" value="0">
    <input name="name" value="${state.name}"><textarea name="page[text]">${state.content}</textarea><input name="page[format]" value="1"><input name="page[itemid]" value="${editorItemId}"><input name="visible" value="${state.visible ? 1 : 0}">
    <input name="coursecontentnotification" value="1"><input name="displayoptions[display]" value="1">
    <input type="checkbox" name="completionexpected[enabled]" value="1">
    <input name="completionexpected[year]" value="${state.completion.year}"><input name="completionexpected[month]" value="${state.completion.month}"><input name="completionexpected[day]" value="${state.completion.day}"><input name="completionexpected[hour]" value="${state.completion.hour}"><input name="completionexpected[minute]" value="${state.completion.minute}">
    <input type="submit" name="submitbutton" value="Save and return to course">
  </form></body></html>`;
}

function resourceForm(name, draftId) {
  return `<!doctype html><html><body><form method="post" action="/course/modedit.php?update=58&amp;return=0">
    <input name="update" value="58"><input name="course" value="2"><input name="modulename" value="resource"><input name="name" value="${name}">
    <div data-fieldtype="filemanager"><input type="hidden" name="files" value="${draftId}"></div>
    <input type="submit" name="submitbutton" value="Save and return to course">
  </form></body></html>`;
}

function labelForm(state, editorItemId, { moduleId = 11, creation = false, availability = "label-availability" } = {}) {
  const action = creation ? "/course/modedit.php?add=label&amp;course=2&amp;sectionid=7&amp;return=0" : `/course/modedit.php?update=${moduleId}&amp;return=0`;
  const identity = creation
    ? '<input name="course" value="2"><input name="add" value="label"><input name="modulename" value="label"><input name="section" value="4"><input name="return" value="0"><input name="coursecontentnotification" value="1">'
    : `<input name="update" value="${moduleId}"><input name="course" value="2"><input name="modulename" value="label"><input name="section" value="4">`;
  return `<!doctype html><html><body><form method="post" action="${action}">
    ${identity}
    <input name="name" value="${state.name}"><textarea name="introeditor[text]">${state.content}</textarea><input name="introeditor[format]" value="1"><input name="introeditor[itemid]" value="${editorItemId}">
    <input name="visible" value="${state.visible === false ? 0 : 1}"><input name="completion" value="2"><input name="showdescription" value="1"><input name="availability" value="${availability}"><input name="tags" value="label-tag">
    <input type="submit" name="submitbutton2" value="Save changes and return to course">
  </form></body></html>`;
}

function urlForm(state, editorItemId, { moduleId = 12, creation = false, display = "5" } = {}) {
  const action = creation ? "/course/modedit.php?add=url&amp;course=2&amp;sectionid=7&amp;return=0" : "/course/modedit.php";
  const identity = creation
    ? '<input name="course" value="2"><input name="add" value="url"><input name="modulename" value="url"><input name="section" value="4"><input name="return" value="0"><input name="coursecontentnotification" value="1">'
    : `<input name="update" value="${moduleId}"><input name="return" value="0"><input name="course" value="2"><input name="modulename" value="url"><input name="section" value="4">`;
  return `<!doctype html><html><body><form method="post" action="${action}">
    ${identity}
    <input name="name" value="${state.name}"><input name="externalurl" value="${state.externalUrl}">
    <textarea name="introeditor[text]">${state.description}</textarea><input name="introeditor[format]" value="1"><input name="introeditor[itemid]" value="${editorItemId}">
    <input name="display" value="${display}"><input name="popupwidth" value="900"><input name="popupheight" value="600"><input name="printintro" value="1">
    <input name="parameter_0" value="utm_source"><input name="variable_0" value="courseid"><input name="parameter_1" value="utm_campaign"><input name="variable_1" value="fullname">
    <input name="visible" value="${state.visible === false ? 0 : 1}"><input name="completion" value="2"><input name="showdescription" value="1"><input name="availability" value="url-availability"><input name="tags" value="url-tag">
    <input type="submit" name="submitbutton2" value="Save changes and return to course"><input type="submit" name="submitbutton" value="Save and display">
  </form></body></html>`;
}

const ASSIGNMENT_DATE_FIELDS = ["allowsubmissionsfromdate", "duedate", "cutoffdate", "gradingduedate"];
const OVERRIDE_DATE_FIELDS = ["allowsubmissionsfromdate", "duedate", "cutoffdate"];
const ASSIGNMENT_BOOLEAN_SETTINGS = [
  "alwaysshowdescription", "assignsubmission_onlinetext_enabled", "assignsubmission_file_enabled",
  "assignfeedback_comments_enabled", "assignfeedback_comments_commentinline", "assignfeedback_file_enabled",
  "assignfeedback_offline_enabled", "assignfeedback_editpdf_enabled", "submissiondrafts", "requiresubmissionstatement",
  "teamsubmission", "preventsubmissionnotgroup", "requireallteammemberssubmit",
  "sendnotifications", "sendlatenotifications", "sendstudentnotifications", "markingworkflow", "blindmarking",
];
const ASSIGNMENT_SELECT_SETTINGS = {
  assignsubmission_file_maxfiles: ["1", "2", "20"],
  assignsubmission_file_maxsizebytes: ["1048576", "2097152"],
  attemptreopenmethod: ["none", "manual", "automatic"],
  maxattempts: ["-1", "1", "2", "3"],
  teamsubmissiongroupingid: ["0", "5"],
  gradecat: ["3", "4"],
  "grade[modgrade_type]": ["none", "scale", "point"],
  "grade[modgrade_scale]": ["1", "2"],
};

function assignmentSettingDefaults() {
  return {
    alwaysshowdescription: "1",
    assignsubmission_onlinetext_enabled: "0",
    assignsubmission_onlinetext_wordlimit: "0",
    assignsubmission_onlinetext_wordlimit_enabled: "",
    assignsubmission_file_enabled: "1",
    assignsubmission_file_maxfiles: "20",
    assignsubmission_file_maxsizebytes: "1048576",
    assignsubmission_file_filetypes: "",
    assignfeedback_comments_enabled: "1",
    assignfeedback_comments_commentinline: "0",
    assignfeedback_file_enabled: "0",
    assignfeedback_offline_enabled: "0",
    assignfeedback_editpdf_enabled: "0",
    submissiondrafts: "0",
    requiresubmissionstatement: "0",
    attemptreopenmethod: "none",
    maxattempts: "-1",
    teamsubmission: "0",
    preventsubmissionnotgroup: "0",
    requireallteammemberssubmit: "0",
    teamsubmissiongroupingid: "0",
    sendnotifications: "0",
    sendlatenotifications: "0",
    sendstudentnotifications: "1",
    gradecat: "3",
    markingworkflow: "0",
    blindmarking: "0",
    "grade[modgrade_type]": "point",
    "grade[modgrade_point]": "100",
    "grade[modgrade_scale]": "2",
  };
}

function yesNoControl(name, value, frozen = false) {
  if (frozen) return `<input type="hidden" name="${name}" value="${value}">`;
  return `<select name="${name}"><option value="0"${value === "0" ? ' selected="selected"' : ""}>No</option><option value="1"${value === "1" ? ' selected="selected"' : ""}>Yes</option></select>`;
}

function selectControl(name, value, values) {
  const options = values.map((entry) => `<option value="${entry}"${entry === value ? ' selected="selected"' : ""}>${entry}</option>`).join("");
  return `<select name="${name}">${options}</select>`;
}

function dateControls(name, value) {
  const date = value || { year: 2026, month: 9, day: 5, hour: 9, minute: 30 };
  const parts = ["year", "month", "day", "hour", "minute"].map((part) => `<input name="${name}[${part}]" value="${date[part]}">`).join("");
  return `<input type="checkbox" name="${name}[enabled]" value="1"${value ? " checked" : ""}>${parts}`;
}

function assignmentSettingControls(settings, { submissionsExist = false, missing = [] } = {}) {
  const absent = new Set(missing);
  const booleans = ASSIGNMENT_BOOLEAN_SETTINGS
    .filter((name) => !absent.has(name))
    .map((name) => yesNoControl(name, settings[name], submissionsExist && name === "blindmarking"))
    .join("\n    ");
  const selects = Object.entries(ASSIGNMENT_SELECT_SETTINGS)
    .filter(([name]) => !absent.has(name))
    .map(([name, values]) => selectControl(name, settings[name], values))
    .join("\n    ");
  return `${booleans}
    ${selects}
    <input name="assignsubmission_onlinetext_wordlimit" value="${settings.assignsubmission_onlinetext_wordlimit}"><input type="checkbox" name="assignsubmission_onlinetext_wordlimit_enabled" value="1"${settings.assignsubmission_onlinetext_wordlimit_enabled === "1" ? " checked" : ""}>
    <input name="assignsubmission_file_filetypes" value="${settings.assignsubmission_file_filetypes}">
    <input name="grade[modgrade_point]" value="${settings["grade[modgrade_point]"]}">`;
}

function assignmentForm(state, draftId, { moduleId = 8, creation = false } = {}) {
  const action = creation ? "/course/modedit.php?add=assign&amp;course=2&amp;sectionid=7&amp;return=0" : `/course/modedit.php?update=${moduleId}&amp;return=0`;
  const identity = creation
    ? '<input name="course" value="2"><input name="add" value="assign"><input name="modulename" value="assign"><input name="section" value="4"><input name="return" value="0"><input name="coursecontentnotification" value="1">'
    : `<input name="update" value="${moduleId}"><input name="course" value="2"><input name="modulename" value="assign"><input name="section" value="4">`;
  const dates = ASSIGNMENT_DATE_FIELDS.map((name) => dateControls(name, state.dates[name])).join("\n    ");
  return `<!doctype html><html><body><form method="post" action="${action}">
    ${identity}
    <input name="name" value="${state.name}"><textarea name="introeditor[text]">${state.instructions}</textarea><input name="introeditor[format]" value="1"><input name="introeditor[itemid]" value="${draftId + 10000}">
    <input name="visible" value="${state.visible ? 1 : 0}">
    <div data-fieldtype="filemanager"><input type="hidden" name="introattachments" value="${draftId}"></div>
    <input name="gradepass" value="${state.gradePass}">
    ${dates}
    ${assignmentSettingControls(state.settings, { submissionsExist: state.submissionsExist, missing: state.missingControls || [] })}
    <input type="submit" name="submitbutton" value="Save and return to course">
  </form></body></html>`;
}

function savedDates(values, fields) {
  const dates = {};
  for (const name of fields) {
    dates[name] = values.get(`${name}[enabled]`) === "1"
      ? {
        year: Number(values.get(`${name}[year]`)), month: Number(values.get(`${name}[month]`)), day: Number(values.get(`${name}[day]`)),
        hour: Number(values.get(`${name}[hour]`)), minute: Number(values.get(`${name}[minute]`)),
      }
      : null;
  }
  return dates;
}

function savedSettings(values, current) {
  const settings = { ...current };
  for (const name of Object.keys(current)) {
    if (name === "assignsubmission_onlinetext_wordlimit_enabled") settings[name] = values.has(name) ? "1" : "";
    else if (values.has(name)) settings[name] = values.get(name);
  }
  return settings;
}

function assignmentOverridesPage(overrides, mode) {
  const rows = overrides.filter((entry) => entry.scope === mode).map((entry) => `<tr><td>${mode === "group" ? entry.groupName : entry.userName}</td><td>Due date</td><td>
      <a href="/mod/assign/overrideedit.php?id=${entry.id}">Edit</a>
      <a href="/mod/assign/overrideedit.php?id=${entry.id}&amp;action=duplicate">Copy</a>
      <a href="/mod/assign/overridedelete.php?id=${entry.id}&amp;sesskey=synthetic-session">Delete</a></td></tr>`).join("");
  return `<!doctype html><html><body class="path-mod-assign course-2"><h2>Evidence analysis</h2>
    <table><tbody>${rows}</tbody></table>
    <form method="post" action="/mod/assign/overrideedit.php"><input type="hidden" name="cmid" value="8"><input type="hidden" name="action" value="add${mode}"><input type="hidden" name="sesskey" value="synthetic-session"><button type="submit">Add override</button></form>
  </body></html>`;
}

function assignmentOverrideForm(entry, { scope, users, groups } = {}) {
  const overrideScope = entry ? entry.scope : scope;
  const action = entry
    ? `/mod/assign/overrideedit.php?id=${entry.id}`
    : `/mod/assign/overrideedit.php?cmid=8&amp;action=add${overrideScope}`;
  const target = overrideScope === "group"
    ? `<select name="groupid">${groups.map((group) => `<option value="${group.id}"${entry && entry.groupId === group.id ? ' selected="selected"' : ""}>${group.name}</option>`).join("")}</select>`
    : `<select name="userid">${users.map((user) => `<option value="${user.id}"${entry && entry.userId === user.id ? ' selected="selected"' : ""}>${user.name}</option>`).join("")}</select>`;
  const dates = OVERRIDE_DATE_FIELDS.map((name) => dateControls(name, entry ? entry.dates[name] : null)).join("\n    ");
  return `<!doctype html><html><body><form method="post" action="${action}">
    <input type="hidden" name="_qf__assign_override_form" value="1"><input type="hidden" name="cmid" value="8">${entry ? `<input type="hidden" name="id" value="${entry.id}">` : ""}
    ${target}
    ${dates}
    <input type="submit" name="submitbutton" value="Save"><input type="submit" name="againbutton" value="Save and enter another override">
  </form></body></html>`;
}

function quizSlot({ slotId, qtype, questionId, name, maxMark, version = "0" }) {
  const selected = version === "0" ? '<option value="0" selected="selected">Always latest</option><option value="1">v1</option>' : `<option value="0">Always latest</option><option value="${version}" selected="selected">v${version}</option>`;
  const question = questionId
    ? `<a href="/question/bank/editquestion/question.php?id=${questionId}&amp;cmid=9"><span class="instancename">${name}</span></a>`
    : `<span class="instancename">${name}</span>`;
  return `<li class="activity ${qtype} qtype_${qtype} slot" id="slot-${slotId}"><div class="activityinstance">${question}</div><span class="instancemaxmark">${maxMark || ""}</span><div class="actions"><select class="form-select version-selection" data-slot-id="${slotId}">${selected}</select></div></li>`;
}

function quizEditPage(createdQuestions = [], priorSlotsReordered = false, hasRandomSlot = true) {
  const created = createdQuestions.map((question, index) => quizSlot({
    slotId: 20 + index, qtype: "multichoice", questionId: question.id, name: question.name, maxMark: question.defaultMark,
  })).join("");
  const initial = [
    quizSlot({ slotId: 17, qtype: "multichoice", questionId: 401, name: "Evidence check", maxMark: "1.00" }),
    ...(hasRandomSlot ? ['<li class="activity random qtype_random slot" id="slot-18"><div class="activityinstance"><span class="instancename">Random evidence question</span></div><span class="instancemaxmark"></span></li>'] : []),
    quizSlot({ slotId: 19, qtype: "truefalse", questionId: 402, name: "Unsupported question", maxMark: "1.00", version: "2" }),
  ];
  if (priorSlotsReordered) initial.reverse();
  return `<!doctype html><html><body><ul class="slots" role="presentation"><li class="section main clearfix" id="section-1" role="presentation"><div class="content"><ul class="section img-text">
      ${initial.join("\n      ")}${created}
    </ul></div></li></ul><a class="addquestion" href="/question/bank/editquestion/addquestion.php?returnurl=%2Fmod%2Fquiz%2Fedit.php%3Fcmid%3D9%26addonpage%3D0&amp;cmid=9&amp;category=42&amp;addonpage=0&amp;appendqnumstring=addquestion">Add a question</a></body></html>`;
}

function multipleChoiceDefaultControls() {
  return `<textarea name="correctfeedback[text]"><p>Correct.</p></textarea><input name="correctfeedback[format]" value="1"><input name="correctfeedback[itemid]" value="979">
    <textarea name="partiallycorrectfeedback[text]"><p>Partly correct.</p></textarea><input name="partiallycorrectfeedback[format]" value="1"><input name="partiallycorrectfeedback[itemid]" value="980">
    <textarea name="incorrectfeedback[text]"><p>Incorrect.</p></textarea><input name="incorrectfeedback[format]" value="1"><input name="incorrectfeedback[itemid]" value="981"><input type="hidden" name="shownumcorrect" value="0"><input type="checkbox" name="shownumcorrect" value="1" checked>
    <select name="penalty"><option value="1.0000000">100%</option><option value="0.3333333" selected="selected">33.33333%</option><option value="0.0000000">None</option></select>
    <textarea name="hint[0][text]"><p>Review the evidence.</p></textarea><input name="hint[0][format]" value="1"><input name="hint[0][itemid]" value="982"><input type="hidden" name="hintclearwrong[0]" value="0"><input type="checkbox" name="hintclearwrong[0]" value="1" checked><input type="hidden" name="hintshownumcorrect[0]" value="0"><input type="checkbox" name="hintshownumcorrect[0]" value="1" checked>
    <textarea name="hint[1][text]"></textarea><input name="hint[1][format]" value="1"><input name="hint[1][itemid]" value="983"><input type="hidden" name="hintclearwrong[1]" value="0"><input type="checkbox" name="hintclearwrong[1]" value="1"><input type="hidden" name="hintshownumcorrect[1]" value="0"><input type="checkbox" name="hintshownumcorrect[1]" value="1">`;
}

function multipleChoiceDefaultData() {
  return {
    combined_feedback: {
      correct: { text: "<p>Correct.</p>", format: "1" },
      partially_correct: { text: "<p>Partly correct.</p>", format: "1" },
      incorrect: { text: "<p>Incorrect.</p>", format: "1" },
    },
    penalty: "0.3333333",
    show_num_correct: true,
    hints: [{ text: "<p>Review the evidence.</p>", format: "1", clear_wrong: true, show_num_correct: true }],
  };
}

function tagControls(name, values) {
  const options = [...new Set([...values, `unused-${name}`])];
  return `<input type="hidden" name="${name}" value="_qf__force_multiselect_submission"><select name="${name}[]" multiple>${options.map((value) => `<option value="${value}"${values.includes(value) ? ' selected="selected"' : ""}>${value}</option>`).join("")}</select>`;
}

function multipleChoiceQuestionForm(question = {
  id: 401,
  name: "Evidence check",
  questionText: "<p>Which claim has evidence?</p>",
  defaultMark: "1.00",
  idNumber: "evidence-1",
  tags: ["evidence-tag"],
  courseTags: ["course-evidence-tag"],
  answers: [
    { text: "<p>Use the cited source.</p>", fraction: "1.0", feedback: "<p>Correct.</p>" },
    { text: "<p>Guess.</p>", fraction: "0.0", feedback: "" },
  ],
}, copy = false) {
  const answerControls = [0, 1, 2].map((index) => {
    const answer = question.answers[index] || { text: "", fraction: "0.0", feedback: "" };
    return `<textarea name="answer[${index}][text]">${answer.text}</textarea><input name="answer[${index}][format]" value="1"><select name="fraction[${index}]"><option value="1.0"${answer.fraction === "1.0" ? " selected=\"selected\"" : ""}>100%</option><option value="0.0"${answer.fraction === "0.0" ? " selected=\"selected\"" : ""}>None</option></select><textarea name="feedback[${index}][text]">${answer.feedback}</textarea><input name="feedback[${index}][format]" value="1"><input name="answer[${index}][itemid]" value="${973 + index * 2}"><input name="feedback[${index}][itemid]" value="${974 + index * 2}">`;
  }).join("\n");
  return `<!doctype html><html><body><form method="post" action="/question/bank/editquestion/question.php">
    <input type="hidden" name="id" value="${question.id}"><input type="hidden" name="cmid" value="9"><input type="hidden" name="courseid" value="2"><input type="hidden" name="qtype" value="multichoice"><input type="hidden" name="sesskey" value="synthetic-session"><input name="makecopy" value="${copy ? 1 : 0}"><span>Current category: Quiz question bank</span>
    ${copy ? '<input type="checkbox" name="usecurrentcat" value="1" checked><select name="categorymoveto" disabled><option value="42,420" selected="selected">Quiz question bank</option></select>' : ''}
    <input name="name" value="${question.name}"><textarea name="questiontext[text]">${question.questionText}</textarea><input name="questiontext[format]" value="1"><input name="questiontext[itemid]" value="971">
    <select name="status"><option value="ready" selected="selected">Ready</option><option value="draft">Draft</option></select><input name="defaultmark" value="${question.defaultMark}"><textarea name="generalfeedback[text]"></textarea><input name="generalfeedback[format]" value="1"><input name="generalfeedback[itemid]" value="972"><input name="idnumber" value="${question.idNumber || ""}">
    <select name="single"><option value="0">Multiple</option><option value="1" selected="selected">One</option></select><input type="hidden" name="shuffleanswers" value="0"><input type="checkbox" name="shuffleanswers" value="1" checked><select name="answernumbering"><option value="abc" selected="selected">a.</option></select><select name="showstandardinstruction"><option value="0">No</option><option value="1" selected="selected">Yes</option></select>
    ${multipleChoiceDefaultControls()}${answerControls}${tagControls("tags", question.tags || [])}${tagControls("coursetags", question.courseTags || [])}
  </form></body></html>`;
}

function multipleChoiceCreationForm(idNumber = "quiz-evidence-fresh", tagDefaults = { tags: ["quiz-evidence-tag"], courseTags: ["quiz-course-tag"] }) {
  const controls = [0, 1].map((index) => `<textarea name="answer[${index}][text]"></textarea><input name="answer[${index}][format]" value="1"><select name="fraction[${index}]"><option value="1.0">100%</option><option value="0.0" selected="selected">None</option></select><textarea name="feedback[${index}][text]"></textarea><input name="feedback[${index}][format]" value="1"><input name="answer[${index}][itemid]" value="${1203 + index * 2}"><input name="feedback[${index}][itemid]" value="${1204 + index * 2}">`).join("\n");
  return `<!doctype html><html><body><form method="post" action="/question/bank/editquestion/question.php">
    <input type="hidden" name="id" value=""><input type="hidden" name="cmid" value="9"><input type="hidden" name="courseid" value="2"><input type="hidden" name="qtype" value="multichoice"><input type="hidden" name="returnurl" value="/mod/quiz/edit.php?cmid=9&amp;addonpage=0"><input type="hidden" name="appendqnumstring" value="addquestion"><input type="hidden" name="sesskey" value="synthetic-session"><input type="hidden" name="_qf__qtype_multichoice_edit_form" value="1">
    <select name="category"><option value="42,420" selected="selected">Quiz question bank</option></select><input name="name" value=""><textarea name="questiontext[text]"></textarea><input name="questiontext[format]" value="1"><input name="questiontext[itemid]" value="1201">
    <select name="status"><option value="ready" selected="selected">Ready</option><option value="draft">Draft</option></select><input name="defaultmark" value="1.00"><textarea name="generalfeedback[text]"></textarea><input name="generalfeedback[format]" value="1"><input name="generalfeedback[itemid]" value="1202"><input name="idnumber" value="${idNumber}">
    <select name="single"><option value="0" selected="selected">Multiple</option><option value="1">One</option></select><input type="hidden" name="shuffleanswers" value="0"><input type="checkbox" name="shuffleanswers" value="1" checked><select name="answernumbering"><option value="abc" selected="selected">a.</option></select><select name="showstandardinstruction"><option value="0">No</option><option value="1" selected="selected">Yes</option></select>
    ${multipleChoiceDefaultControls()}${controls}${tagControls("tags", tagDefaults.tags)}${tagControls("coursetags", tagDefaults.courseTags)}<input type="submit" name="submitbutton" value="Save changes">
  </form></body></html>`;
}

function questionAuthoringTags(question) {
  return `${tagControls("tags", question.tags || ["authoring-tag"])}${tagControls("coursetags", question.courseTags || ["course-authoring-tag"])}`;
}

function questionAuthoringCommon(question, qtype, creation) {
  const defaultMark = qtype === "multianswer" ? "" : `<input name="defaultmark" value="${qtype === "description" ? "0" : question.defaultMark ?? "1"}">`;
  return `<input type="hidden" name="id" value="${creation ? "" : question.id}"><input type="hidden" name="cmid" value="9"><input type="hidden" name="courseid" value="2"><input type="hidden" name="qtype" value="${qtype}"><input type="hidden" name="sesskey" value="question-session">${creation ? '<input type="hidden" name="returnurl" value="/mod/quiz/edit.php?cmid=9&amp;addonpage=0"><input type="hidden" name="appendqnumstring" value="addquestion">' : ""}
    <select name="category"><option value="42,420" selected="selected">Quiz question bank</option></select><input name="name" value="${question.name || ""}"><textarea name="questiontext[text]">${question.questionText || ""}</textarea><input name="questiontext[format]" value="1"><input name="questiontext[itemid]" value="3001">
    <select name="status"><option value="ready" selected="selected">Ready</option><option value="draft">Draft</option></select>${defaultMark}<textarea name="generalfeedback[text]">${question.generalFeedback || ""}</textarea><input name="generalfeedback[format]" value="1"><input name="generalfeedback[itemid]" value="3002"><input name="idnumber" value="${question.idNumber || "authoring-id"}">${questionAuthoringTags(question)}`;
}

function authoringAnswerFields(question, numerical = false) {
  const answers = [...(question.answers || []), { text: "", fraction: "0.0", feedback: "", tolerance: "0" }, { text: "", fraction: "0.0", feedback: "", tolerance: "0" }].slice(0, 3);
  return answers.map((answer, index) => `<textarea name="answer[${index}][text]">${answer.text || ""}</textarea><input name="answer[${index}][format]" value="1"><select name="fraction[${index}]"><option value="1.0"${String(answer.fraction) === "1.0" ? ' selected="selected"' : ""}>100%</option><option value="0.5"${String(answer.fraction) === "0.5" ? ' selected="selected"' : ""}>50%</option><option value="0.0"${String(answer.fraction) === "0.0" ? ' selected="selected"' : ""}>None</option></select>${numerical ? `<input name="tolerance[${index}]" value="${answer.tolerance || "0"}">` : ""}<textarea name="feedback[${index}][text]">${answer.feedback || ""}</textarea><input name="feedback[${index}][format]" value="1"><input name="answer[${index}][itemid]" value="${3100 + index * 2}"><input name="feedback[${index}][itemid]" value="${3101 + index * 2}">`).join("");
}

function authoringInteractiveFields() {
  return '<select name="penalty"><option value="1.0000000" selected="selected">100%</option><option value="0.3333333">33%</option></select>';
}

function authoringMultianswerInteractiveFields(question) {
  const penalty = question.multianswerPenalty || "0.3333333";
  return `<select name="penalty"><option value="1.0000000"${penalty === "1.0000000" ? ' selected="selected"' : ""}>100%</option><option value="0.3333333"${penalty === "0.3333333" ? ' selected="selected"' : ""}>33%</option><option value="0.0000000"${penalty === "0.0000000" ? ' selected="selected"' : ""}>None</option></select>
    <textarea name="hint[0][text]"><p>Review the embedded answer.</p></textarea><input name="hint[0][format]" value="1"><input name="hint[0][itemid]" value="3501"><input type="hidden" name="hintclearwrong[0]" value="0"><input type="checkbox" name="hintclearwrong[0]" value="1" checked><input type="hidden" name="hintshownumcorrect[0]" value="0"><input type="checkbox" name="hintshownumcorrect[0]" value="1" checked>
    <textarea name="hint[1][text]"></textarea><input name="hint[1][format]" value="1"><input name="hint[1][itemid]" value="3502"><input type="hidden" name="hintclearwrong[1]" value="0"><input type="checkbox" name="hintclearwrong[1]" value="1"><input type="hidden" name="hintshownumcorrect[1]" value="0"><input type="checkbox" name="hintshownumcorrect[1]" value="1">`;
}

function authoringOrderingDefaultControls() {
  return `<textarea name="correctfeedback[text]"><p>Correct.</p></textarea><input name="correctfeedback[format]" value="1"><input name="correctfeedback[itemid]" value="979">
    <textarea name="partiallycorrectfeedback[text]"><p>Partly correct.</p></textarea><input name="partiallycorrectfeedback[format]" value="1"><input name="partiallycorrectfeedback[itemid]" value="980">
    <textarea name="incorrectfeedback[text]"><p>Incorrect.</p></textarea><input name="incorrectfeedback[format]" value="1"><input name="incorrectfeedback[itemid]" value="981"><input type="hidden" name="shownumcorrect" value="0"><input type="checkbox" name="shownumcorrect" value="1" checked>
    <select name="penalty"><option value="1.0000000">100%</option><option value="0.3333333" selected="selected">33.33333%</option><option value="0.0000000">None</option></select>
    <textarea name="hint[0][text]"><p>Review the order.</p></textarea><input name="hint[0][format]" value="1"><input name="hint[0][itemid]" value="982"><input type="hidden" name="hintshownumcorrect[0]" value="0"><input type="checkbox" name="hintshownumcorrect[0]" value="1" checked><input type="hidden" name="hintoptions[0][hintoptions]" value="0"><input type="checkbox" name="hintoptions[0][hintoptions]" value="1" checked>
    <textarea name="hint[1][text]"></textarea><input name="hint[1][format]" value="1"><input name="hint[1][itemid]" value="983"><input type="hidden" name="hintshownumcorrect[1]" value="0"><input type="checkbox" name="hintshownumcorrect[1]" value="1"><input type="hidden" name="hintoptions[1][hintoptions]" value="0"><input type="checkbox" name="hintoptions[1][hintoptions]" value="1">`;
}

function authoringMarkerDefaultControls() {
  return `<textarea name="correctfeedback[text]"><p>Correct.</p></textarea><input name="correctfeedback[format]" value="1"><input name="correctfeedback[itemid]" value="979">
    <textarea name="partiallycorrectfeedback[text]"><p>Partly correct.</p></textarea><input name="partiallycorrectfeedback[format]" value="1"><input name="partiallycorrectfeedback[itemid]" value="980">
    <textarea name="incorrectfeedback[text]"><p>Incorrect.</p></textarea><input name="incorrectfeedback[format]" value="1"><input name="incorrectfeedback[itemid]" value="981"><input type="hidden" name="shownumcorrect" value="0"><input type="checkbox" name="shownumcorrect" value="1" checked>
    <select name="penalty"><option value="1.0000000">100%</option><option value="0.3333333" selected="selected">33.33333%</option><option value="0.0000000">None</option></select>
    <textarea name="hint[0][text]"><p>Check where each marker sits.</p></textarea><input name="hint[0][format]" value="1"><input name="hint[0][itemid]" value="982"><input type="checkbox" name="hintshownumcorrect[0]" value="1" checked><input type="checkbox" name="hintoptions[0]" value="1" checked><input type="checkbox" name="hintclearwrong[0]" value="1">
    <textarea name="hint[1][text]"></textarea><input name="hint[1][format]" value="1"><input name="hint[1][itemid]" value="983"><input type="checkbox" name="hintshownumcorrect[1]" value="1"><input type="checkbox" name="hintoptions[1]" value="1"><input type="checkbox" name="hintclearwrong[1]" value="1">`;
}

function authoringDragImageFields(question) {
  const items = question.dragItems || [];
  const zones = question.dropZones || [];
  const dragItem = (item, index) => `<select name="drags[${index}][dragitemtype]"><option value="image"${item.contentType === "image" ? ' selected="selected"' : ""}>Draggable image</option><option value="word"${item.contentType === "image" ? "" : ' selected="selected"'}>Draggable text</option></select><select name="drags[${index}][draggroup]">${[1, 2, 3].map((group) => `<option value="${group}"${Number(item.group) === group ? ' selected="selected"' : ""}>${group}</option>`).join("")}</select><input type="hidden" name="drags[${index}][infinite]" value="0"><input type="checkbox" name="drags[${index}][infinite]" value="1"${item.unlimited ? " checked" : ""}><div data-fieldtype="filepicker"><input type="hidden" name="dragitem[${index}]" value="${4100 + index}"></div><input name="draglabel[${index}]" value="${item.label}">`;
  const dropZone = (zone, index) => `<input name="drops[${index}][xleft]" value="${zone.xLeft}"><input name="drops[${index}][ytop]" value="${zone.yTop}"><select name="drops[${index}][choice]"><option value="0"${zone.dragItem ? "" : ' selected="selected"'}></option>${items.map((item, itemIndex) => `<option value="${itemIndex + 1}"${Number(zone.dragItem) === itemIndex + 1 ? ' selected="selected"' : ""}>${itemIndex + 1}</option>`).join("")}</select><input name="drops[${index}][droplabel]" value="${zone.label}">`;
  return `<input type="hidden" name="shuffleanswers" value="0"><input type="checkbox" name="shuffleanswers" value="1"${question.shuffleAnswers === false ? "" : " checked"}><select name="dropzonevisibility"><option value="0"${question.dropZoneVisibility === "1" ? "" : ' selected="selected"'}>Display drop zones</option><option value="1"${question.dropZoneVisibility === "1" ? ' selected="selected"' : ""}>Hide drop zones</option></select>
    <div data-fieldtype="filepicker"><input type="hidden" name="bgimage" value="${question.backgroundDraftId}"></div><input type="hidden" name="noitems" value="${items.length}"><input type="hidden" name="nodropzone" value="${zones.length}">
    ${items.map(dragItem).join("")}${zones.map(dropZone).join("")}${multipleChoiceDefaultControls()}`;
}

function authoringDragMarkerFields(question) {
  const markers = question.markers || [];
  const zones = question.dropZones || [];
  const marker = (entry, index) => `<input name="drags[${index}][label]" value="${entry.label}"><select name="drags[${index}][noofdrags]"><option value="0"${entry.maxDrags ? "" : ' selected="selected"'}>Unlimited</option>${[1, 2, 3, 4, 5, 6].map((count) => `<option value="${count}"${Number(entry.maxDrags) === count ? ' selected="selected"' : ""}>${count}</option>`).join("")}</select>`;
  const dropZone = (zone, index) => `<select name="drops[${index}][shape]">${["circle", "rectangle", "polygon"].map((shape) => `<option value="${shape}"${zone.shape === shape ? ' selected="selected"' : ""}>${shape}</option>`).join("")}</select><select name="drops[${index}][choice]"><option value="0"${zone.marker ? "" : ' selected="selected"'}></option>${markers.map((entry, markerIndex) => `<option value="${markerIndex + 1}"${Number(zone.marker) === markerIndex + 1 ? ' selected="selected"' : ""}>${markerIndex + 1}</option>`).join("")}</select><input name="drops[${index}][coords]" value="${zone.coordinates}">`;
  return `<input type="hidden" name="showmisplaced" value="0"><input type="checkbox" name="showmisplaced" value="1"${question.showMisplaced ? " checked" : ""}><input type="hidden" name="shuffleanswers" value="0"><input type="checkbox" name="shuffleanswers" value="1"${question.shuffleAnswers === false ? "" : " checked"}>
    <div data-fieldtype="filepicker"><input type="hidden" name="bgimage" value="${question.backgroundDraftId}"></div><input type="hidden" name="noitems" value="${markers.length}"><input type="hidden" name="nodropzone" value="${zones.length}">
    ${markers.map(marker).join("")}${zones.map(dropZone).join("")}${authoringMarkerDefaultControls()}`;
}

function authoringCalculatedAnswerFields(question, qtype) {
  const editorAnswers = qtype === "calculatedmulti";
  const blank = () => ({ formula: "", fraction: "0.0", tolerance: "0.01", toleranceType: "1", answerLength: "2", answerFormat: "1", feedback: "" });
  const written = question.calculatedAnswers || [];
  const rows = [...written, blank(), blank(), blank(), blank(), blank()].slice(0, editorAnswers ? 5 : written.length + 1);
  const formulaField = (row, index) => editorAnswers
    ? `<textarea name="answer[${index}][text]">${row.formula}</textarea><input name="answer[${index}][format]" value="1"><input name="answer[${index}][itemid]" value="${3700 + index}">`
    : `<input name="answer[${index}]" value="${row.formula}">`;
  const toleranceTypeField = (row, index) => editorAnswers
    ? `<input type="hidden" name="tolerancetype[${index}]" value="${row.toleranceType || "1"}">`
    : `<select name="tolerancetype[${index}]">${["1", "2", "3"].map((value) => `<option value="${value}"${(row.toleranceType || "1") === value ? ' selected="selected"' : ""}>${value}</option>`).join("")}</select>`;
  const select = (name, values, current) => `<select name="${name}">${values.map((value) => `<option value="${value}"${String(current) === String(value) ? ' selected="selected"' : ""}>${value}</option>`).join("")}</select>`;
  return rows.map((row, index) => `${formulaField(row, index)}${select(`fraction[${index}]`, ["1.0", "0.5", "0.0"], row.fraction || "0.0")}<input name="tolerance[${index}]" value="${row.tolerance ?? "0.01"}">${toleranceTypeField(row, index)}${select(`correctanswerlength[${index}]`, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], row.answerLength ?? "2")}${select(`correctanswerformat[${index}]`, ["1", "2"], row.answerFormat || "1")}<textarea name="feedback[${index}][text]">${row.feedback || ""}</textarea><input name="feedback[${index}][format]" value="1"><input name="feedback[${index}][itemid]" value="${3750 + index}">`).join("");
}

function authoringCalculatedUnitFields(question) {
  const units = [...(question.calculatedUnits || []), { unit: "", multiplier: "" }];
  const role = question.unitRole || "0";
  return `<select name="unitrole">${["0", "1", "3"].map((value) => `<option value="${value}"${role === value ? ' selected="selected"' : ""}>${value}</option>`).join("")}</select><input name="unitpenalty" value="0.1"><select name="unitgradingtypes"><option value="1" selected="selected">Response mark</option><option value="2">Question mark</option></select><select name="multichoicedisplay"><option value="0" selected="selected">Editable text</option><option value="1">Radio buttons</option></select><select name="unitsleft"><option value="0"${question.unitsLeft ? "" : ' selected="selected"'}>Right</option><option value="1"${question.unitsLeft ? ' selected="selected"' : ""}>Left</option></select><input type="hidden" name="nounits" value="${units.length}">${units.map((entry, index) => `<input name="unit[${index}]" value="${entry.unit}"><input name="multiplier[${index}]" value="${entry.multiplier}">`).join("")}`;
}

function authoringCalculatedInteractiveFields(question) {
  return `<select name="penalty"><option value="1.0000000">100%</option><option value="0.3333333" selected="selected">33.33333%</option><option value="0.0000000">None</option></select><textarea name="hint[0][text]">${question.calculatedHint || ""}</textarea><input name="hint[0][format]" value="1"><input name="hint[0][itemid]" value="3800">`;
}

function authoringCalculatedDatasetFields(question) {
  const definitions = question.datasetDefinitions || [];
  const rows = [];
  for (let set = 0; set < (question.datasetValueSets || 0); set += 1) {
    for (const definition of definitions) {
      const position = rows.length + 1;
      const stored = question.unsavedValueSet && set === question.datasetValueSets - 1 ? "" : String(9000 + position);
      rows.push(`<input type="hidden" name="number[${position}]" value="${(set + 1) * 3}"><input type="hidden" name="itemid[${position}]" value="${stored}"><input type="hidden" name="definition[${position}]" value="${definition.key}">`);
    }
  }
  const definitionFields = definitions.map((definition, index) => `<input type="hidden" name="datasetdef[${index + 1}]" value="${definition.key}"><input type="hidden" name="defoptions[${index + 1}]" value="uniform:1:10:1"><input name="calcmin[${index + 1}]" value="1"><input name="calcmax[${index + 1}]" value="10"><select name="calclength[${index + 1}]"><option value="1" selected="selected">1</option></select><select name="calcdistribution[${index + 1}]"><option value="uniform" selected="selected">Uniform</option></select>`).join("");
  return `${definitionFields}<input type="submit" name="analyzequestion" value="Find the wild cards"><input type="submit" name="addbutton" value="Generate new item set"><select name="selectadd"><option value="1" selected="selected">1</option></select><input type="submit" name="showbutton" value="Display"><select name="selectshow"><option value="1" selected="selected">1</option></select><input type="submit" name="updatedatasets" value="Update the wildcard values">${rows.join("")}`;
}

function questionAuthoringForm(question, qtype, creation = false) {
  const common = questionAuthoringCommon(question, qtype, creation);
  let details = "";
  if (qtype === "truefalse") {
    details = `<select name="correctanswer"><option value="0"${question.correctAnswer ? "" : ' selected="selected"'}>False</option><option value="1"${question.correctAnswer ? ' selected="selected"' : ""}>True</option></select><select name="showstandardinstruction"><option value="0">No</option><option value="1" selected="selected">Yes</option></select><textarea name="feedbacktrue[text]">${question.trueFeedback || ""}</textarea><input name="feedbacktrue[format]" value="1"><input name="feedbacktrue[itemid]" value="3201"><textarea name="feedbackfalse[text]">${question.falseFeedback || ""}</textarea><input name="feedbackfalse[format]" value="1"><input name="feedbackfalse[itemid]" value="3202"><input name="penalty" value="1">`;
  } else if (qtype === "shortanswer") {
    details = `<select name="usecase"><option value="0"${question.caseSensitive ? "" : ' selected="selected"'}>No</option><option value="1"${question.caseSensitive ? ' selected="selected"' : ""}>Yes</option></select>${authoringAnswerFields(question)}${authoringInteractiveFields()}`;
  } else if (qtype === "numerical") {
    details = `${authoringAnswerFields(question, true)}<select name="unitrole"><option value="0" selected="selected">No units</option></select><input name="unitpenalty" value="0.1"><select name="unitgradingtypes"><option value="0" selected="selected">Response mark</option></select><select name="multichoicedisplay"><option value="0" selected="selected">Input</option></select><select name="unitsleft"><option value="0" selected="selected">Right</option><option value="1">Left</option></select><input name="unit[0]" value=""><input name="multiplier[0]" value="1.0">${authoringInteractiveFields()}`;
  } else if (qtype === "essay") {
    details = `<select name="responseformat"><option value="editor" selected="selected">Editor</option></select><select name="responserequired"><option value="0">No</option><option value="1" selected="selected">Yes</option></select><select name="responsefieldlines"><option value="10" selected="selected">10</option></select><input name="minwordlimit" value=""><input name="maxwordlimit" value=""><select name="attachments"><option value="0" selected="selected">None</option></select><select name="attachmentsrequired"><option value="0" selected="selected">None</option></select><input name="filetypeslist" value=""><select name="maxbytes"><option value="0" selected="selected">Site limit</option></select><textarea name="responsetemplate[text]">${question.responseTemplate || ""}</textarea><input name="responsetemplate[format]" value="1"><textarea name="graderinfo[text]">${question.graderInfo || ""}</textarea><input name="graderinfo[format]" value="1"><input name="graderinfo[itemid]" value="3301">`;
  } else if (qtype === "match") {
    const rows = [...(question.pairs || []), ...(question.distractors || []).map((answerText) => ({ questionText: "", answerText })), { questionText: "", answerText: "" }, { questionText: "", answerText: "" }, { questionText: "", answerText: "" }].slice(0, 3);
    details = `<input type="hidden" name="shuffleanswers" value="0"><input type="checkbox" name="shuffleanswers" value="1"${question.shuffleAnswers === false ? "" : " checked"}>${rows.map((row, index) => `<textarea name="subquestions[${index}][text]">${row.questionText || ""}</textarea><input name="subquestions[${index}][format]" value="1"><input name="subquestions[${index}][itemid]" value="${3400 + index}"><input name="subanswers[${index}]" value="${row.answerText || ""}">`).join("")}${multipleChoiceDefaultControls()}`;
  } else if (qtype === "ordering") {
    const items = [...(question.orderingItems || []), "", "", ""].slice(0, 3);
    details = `<select name="layouttype"><option value="vertical" selected="selected">Vertical</option><option value="horizontal">Horizontal</option></select><select name="selecttype"><option value="all" selected="selected">All</option><option value="random">Random</option></select><input name="selectcount" value="3"><select name="gradingtype"><option value="absolute_position" selected="selected">Absolute position</option><option value="relative">Relative</option></select><select name="showgrading"><option value="0">Hide</option><option value="1" selected="selected">Show</option></select><select name="numberingstyle"><option value="abc" selected="selected">a.</option><option value="123">1.</option></select>${items.map((item, index) => `<textarea name="answer[${index}][text]">${item}</textarea><input name="answer[${index}][format]" value="1"><input name="answer[${index}][itemid]" value="${3600 + index}">`).join("")}${authoringOrderingDefaultControls()}`;
  } else if (qtype === "randomsamatch") {
    const choose = String(question.randomChoose || 2);
    details = `<select name="choose">${Array.from({ length: 9 }, (_, index) => index + 2).map((count) => `<option value="${count}"${choose === String(count) ? " selected=\"selected\"" : ""}>${count}</option>`).join("")}</select><input type="hidden" name="subcats" value="0"><input type="checkbox" name="subcats" value="1"${question.includeSubcategories === false ? "" : " checked"}><input type="hidden" name="fraction" value="0">${multipleChoiceDefaultControls()}`;
  } else if (["gapselect", "ddwtos"].includes(qtype)) {
    const rows = [...(question.choices || []), { text: "", group: 1, unlimited: false }, { text: "", group: 1, unlimited: false }, { text: "", group: 1, unlimited: false }].slice(0, 3);
    const maxGroup = qtype === "gapselect" ? 20 : 8;
    details = `<input type="hidden" name="shuffleanswers" value="0"><input type="checkbox" name="shuffleanswers" value="1"${question.shuffleAnswers === false ? "" : " checked"}>${rows.map((row, index) => `<input name="choices[${index}][answer]" value="${row.text || ""}"><select name="choices[${index}][choicegroup]">${Array.from({ length: maxGroup }, (_, group) => `<option value="${group + 1}"${Number(row.group) === group + 1 ? " selected=\"selected\"" : ""}>${group + 1}</option>`).join("")}</select>${qtype === "ddwtos" ? `<input type="hidden" name="choices[${index}][infinite]" value="0"><input type="checkbox" name="choices[${index}][infinite]" value="1"${row.unlimited ? " checked" : ""}>` : ""}`).join("")}${multipleChoiceDefaultControls()}`;
  } else if (qtype === "ddimageortext") {
    details = authoringDragImageFields(question);
  } else if (qtype === "ddmarker") {
    details = authoringDragMarkerFields(question);
  } else if (qtype === "multianswer") {
    details = `<input type="hidden" name="reload" value="1"><input type="hidden" name="confirm" value="0">${authoringMultianswerInteractiveFields(question)}`;
  } else if (qtype === "calculated") {
    details = `<input type="hidden" name="initialcategory" value="1"><input type="hidden" name="reload" value="1"><input type="submit" name="updatecategory" value="Update the category">${authoringCalculatedAnswerFields(question, qtype)}${authoringCalculatedUnitFields(question)}${authoringCalculatedInteractiveFields(question)}<input type="hidden" name="synchronize" value="${question.synchronize || "0"}"><input type="hidden" name="wizard" value="${question.wizardPage || "datasetdefinitions"}">${question.midWizard ? '<select name="dataset[0]"><option value="1-0-a" selected="selected">a</option></select>' : ""}`;
  } else if (qtype === "calculatedmulti") {
    details = `<input type="hidden" name="initialcategory" value="1"><input type="hidden" name="reload" value="1"><input type="submit" name="updatecategory" value="Update the category"><input type="hidden" name="multichoice" value="1"><select name="single"><option value="0"${question.single ? "" : ' selected="selected"'}>Multiple answers</option><option value="1"${question.single ? ' selected="selected"' : ""}>One answer</option></select><input type="hidden" name="shuffleanswers" value="0"><input type="checkbox" name="shuffleanswers" value="1"${question.shuffleAnswers === false ? "" : " checked"}><select name="answernumbering"><option value="abc" selected="selected">a.</option><option value="123">1.</option></select>${authoringCalculatedAnswerFields(question, qtype)}<input type="hidden" name="nounits" value="1"><input type="hidden" name="unit[0]" value=""><input type="hidden" name="multiplier[0]" value="">${multipleChoiceDefaultControls()}<input type="hidden" name="synchronize" value="${question.synchronize || "0"}"><input type="hidden" name="wizard" value="datasetdefinitions">`;
  } else if (qtype === "calculatedsimple") {
    details = `<input type="hidden" name="synchronize" value="0"><input type="hidden" name="initialcategory" value="1"><input type="hidden" name="reload" value="1">${authoringCalculatedAnswerFields(question, qtype)}${authoringCalculatedUnitFields(question)}${authoringCalculatedInteractiveFields(question)}${authoringCalculatedDatasetFields(question)}`;
  }
  return `<!doctype html><html><body><form method="post" action="/question/bank/editquestion/question.php">${common}${details}<input type="submit" name="submitbutton" value="Save changes"></form></body></html>`;
}

function authoringQuizPage(questions) {
  const slots = questions.map((question) => {
    const name = question.qtype === "random"
      ? `<span class="instancename">${question.name}</span>`
      : `<a class="instancename" href="/question/bank/editquestion/question.php?id=${question.id}&amp;cmid=9">${question.name}</a>`;
    return `<li class="activity ${question.qtype} qtype_${question.qtype} slot" id="slot-${question.slotId}"><div class="activityinstance">${name}</div><span class="instancemaxmark">${question.defaultMark}</span><div class="actions"><select class="form-select version-selection" data-slot-id="${question.slotId}"><option value="0" selected="selected">Always latest</option></select></div></li>`;
  }).join("");
  return `<!doctype html><html><body><a href="/question/bank/editquestion/addquestion.php?cmid=9&amp;category=42&amp;returnurl=/mod/quiz/edit.php?cmid=9%26addonpage=0&amp;appendqnumstring=addquestion">Add a question</a><ul class="slots" role="presentation"><li class="section main" id="section-0"><ul class="section img-text">${slots}</ul></li></ul></body></html>`;
}


async function executeInBrowser(page, input) {
  return page.evaluate(executeMoodleInPage, JSON.stringify(input));
}

test("Moodle discovery includes a fresh verified current course without dropping timeline courses", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-discovery-browser-"));
  const key = join(directory, "key.pem");
  const certificate = join(directory, "certificate.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", certificate], { stdio: "ignore" });
  let origin = "";
  let timeline = [];
  let currentCourseAllowed = true;
  const stateRequests = [];
  const courseViews = [];
  const server = createServer({ key: readFileSync(key), cert: readFileSync(certificate) }, (request, response) => {
    const url = new URL(request.url || "/", origin || "https://127.0.0.1");
    if (url.pathname === "/course/view.php") {
      const courseId = url.searchParams.get("id") || "";
      courseViews.push(courseId);
      const name = courseId === "99" ? "Open administration course" : `Timeline course ${courseId}`;
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><body class="path-course course-${courseId}"><h1>${name}</h1><script>var M = {}; M.cfg = ${JSON.stringify({ wwwroot: origin, sesskey: "synthetic-session", userId: 3 })};</script></body>`);
      return;
    }
    if (url.pathname === "/lib/ajax/service.php") {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const call = JSON.parse(Buffer.concat(chunks).toString("utf8"))[0];
        if (call?.methodname === "core_course_get_enrolled_courses_by_timeline_classification") {
          const courses = timeline.slice(call.args.offset, call.args.offset + call.args.limit);
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify([{ data: { courses } }]));
          return;
        }
        if (call?.methodname === "core_courseformat_get_state") {
          stateRequests.push(call.args.courseid);
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(currentCourseAllowed && call.args.courseid === 99
            ? [{ data: JSON.stringify({ course: { id: 99 }, section: [], cm: [] }) }]
            : [{ exception: { errorcode: "nopermissions" } }]));
          return;
        }
        response.writeHead(404).end();
      });
      return;
    }
    response.writeHead(404).end();
  });
  let browser;
  let context;
  try {
    await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Discovery test server did not bind a port");
    origin = `https://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await page.goto(`${origin}/course/view.php?id=99`);
    await page.evaluate((wwwroot) => { globalThis.M = { cfg: { wwwroot, sesskey: "synthetic-session", userId: 3, courseId: 99 } }; }, origin);
    const discover = (limit, offset = 0) => executeInBrowser(page, { mode: "discover_courses", limit, offset, expiresAt: Date.now() + 60_000 });

    timeline = [];
    stateRequests.length = 0;
    courseViews.length = 0;
    assert.deepEqual((await discover(3)).data, { courses: [{ id: "99", name: "Open administration course" }], offset: 0, limit: 3, next_offset: null, complete: true });
    assert.deepEqual(stateRequests, [99]);
    assert.deepEqual(courseViews, ["99"]);

    timeline = [{ id: 99, fullname: "Timeline current course" }];
    stateRequests.length = 0;
    courseViews.length = 0;
    assert.deepEqual((await discover(3)).data, { courses: [{ id: "99", name: "Timeline current course" }], offset: 0, limit: 3, next_offset: null, complete: true });
    assert.deepEqual(stateRequests, []);
    assert.deepEqual(courseViews, []);

    timeline = [{ id: 1, fullname: "Timeline one" }, { id: 2, fullname: "Timeline two" }, { id: 3, fullname: "Timeline three" }];
    stateRequests.length = 0;
    assert.deepEqual((await discover(3)).data, {
      courses: [{ id: "99", name: "Open administration course" }, { id: "1", name: "Timeline one" }, { id: "2", name: "Timeline two" }],
      offset: 0, limit: 3, next_offset: 2, complete: false,
    });
    assert.deepEqual((await discover(3, 2)).data, {
      courses: [{ id: "3", name: "Timeline three" }], offset: 2, limit: 3, next_offset: null, complete: true,
    });
    assert.deepEqual(stateRequests, [99]);

    timeline = [];
    currentCourseAllowed = false;
    stateRequests.length = 0;
    courseViews.length = 0;
    assert.deepEqual((await discover(3)).data, { courses: [], offset: 0, limit: 3, next_offset: null, complete: true });
    assert.deepEqual(stateRequests, [99]);
    assert.deepEqual(courseViews, []);
  } finally {
    await context?.close();
    await browser?.close();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

const imscpReadOperation = { key: "moodle.form.course.modedit.imscp.read.v1", toolName: "moodle_get_imscp", provider: "moodle", readOnly: true };
const imscpCreationReadOperation = { key: "moodle.form.course.modedit.imscp.package.create.read.v1", toolName: "moodle_get_imscp_package_creation_form", provider: "moodle", readOnly: true };
const imscpCreationWriteOperation = { key: "moodle.form.course.modedit.imscp.package.create.write.v1", toolName: "moodle_create_imscp_package", provider: "moodle", readOnly: false };

test("Moodle executor verifies a hidden IMS content package without opening it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-imscp-browser-"));
  const key = join(directory, "key.pem"); const certificate = join(directory, "certificate.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", certificate], { stdio: "ignore" });
  const filename = "package.zip"; const manifestFile = Buffer.from("imsmanifest.xml", "utf8"); const content = Buffer.from("<manifest/>", "utf8");
  const local = Buffer.alloc(30 + manifestFile.length + content.length); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(0, 8); local.writeUInt32LE(content.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(manifestFile.length, 26); manifestFile.copy(local, 30); content.copy(local, 30 + manifestFile.length);
  const central = Buffer.alloc(46 + manifestFile.length); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0, 8); central.writeUInt16LE(0, 10); central.writeUInt32LE(content.length, 20); central.writeUInt32LE(content.length, 24); central.writeUInt16LE(manifestFile.length, 28); manifestFile.copy(central, 46);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(local.length, 16);
  const bytes = Buffer.concat([local, central, end]); const manifest = { filename, size_bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  let origin = ""; let created = null; const drafts = new Map(); const posts = []; const requests = [];
  const picker = (itemId) => ({ elementid: "id_package", itemid: itemId, context: { id: 77 }, maxbytes: -1, accepted_types: [".zip", ".imscc"], repositories: { 17: { id: "17", type: "upload" } }, author: "Morrow" });
  const form = (itemId, add) => `<!doctype html><body><form method="post" action="/course/modedit.php?${add ? "add=imscp&amp;course=2&amp;sectionid=7&amp;return=0" : "update=99&amp;return=0"}"><input name="${add ? "course" : "update"}" value="${add ? "2" : "99"}"><input name="${add ? "add" : "course"}" value="${add ? "imscp" : "2"}"><input name="modulename" value="imscp"><input name="section" value="4"><input name="return" value="0"><input name="name" value="${add ? "" : "IMS package"}"><input name="visible" value="${add ? "1" : "0"}"><input name="revision" value="1"><textarea name="introeditor[text]"></textarea><input name="introeditor[format]" value="1"><input name="keepold" value="-1"><input class="filepickerhidden" type="hidden" id="id_package" name="package" value="${itemId}"><input type="submit" name="submitbutton2" value="Save changes and return to course"><input name="sesskey" value="synthetic-session"></form><script>M.form_filepicker.init(Y, ${JSON.stringify(picker(itemId))});</script></body>`;
  const state = () => JSON.stringify([{ data: JSON.stringify({ course: { id: 2, fullname: "IMS course" }, section: [{ id: 7, number: 4, title: "IMS section", component: "", visible: true, hasrestrictions: false }], cm: created ? [{ id: 99, module: "imscp", sectionid: 7, name: created.name, visible: false }] : [] }) }]);
  const server = createServer({ key: readFileSync(key), cert: readFileSync(certificate) }, (request, response) => { const url = new URL(request.url || "/", origin); requests.push(`${request.method} ${url.pathname}${url.search}`); if (url.pathname === "/course/view.php") return response.end('<body class="path-course course-2">'); if (url.pathname === "/lib/ajax/service.php") { request.resume(); return request.on("end", () => response.end(state())); } if (url.pathname === "/repository/draftfiles_ajax.php") { const chunks=[]; request.on("data",x=>chunks.push(x)); return request.on("end",()=>{const item=new URLSearchParams(Buffer.concat(chunks).toString()).get("itemid"); const draft=drafts.get(item); response.setHeader("content-type","application/json"); response.end(JSON.stringify(draft ? {filecount:1,list:[{filename,filepath:"/",type:"zip",size:bytes.length,sortorder:1,mimetype:"application/zip"}],tree:{children:[]}} : {filecount:0,list:[],tree:{children:[]}}));}); } if (url.pathname === "/repository/repository_ajax.php") { const chunks=[]; request.on("data",x=>chunks.push(x)); return request.on("end",()=>{const item=Buffer.concat(chunks).toString("latin1").match(/name="itemid"\r\n\r\n([0-9]+)/)?.[1]; drafts.set(item,bytes); response.setHeader("content-type","application/json"); response.end(JSON.stringify({id:Number(item),file:filename,url:`${origin}/draftfile.php/3/user/draft/${item}/${filename}`}));}); } if (url.pathname.startsWith("/draftfile.php/")) { const draft=drafts.get(url.pathname.split("/")[5]); response.setHeader("content-length",draft.length); return response.end(draft); } if (url.pathname === "/pluginfile.php/77/mod_imscp/backup/1/package.zip") { response.setHeader("content-length",bytes.length); return response.end(bytes); } if (url.pathname === "/course/modedit.php" && request.method === "GET") return response.end(url.searchParams.get("add") === "imscp" ? form("100",true) : created && url.searchParams.get("update") === "99" ? form("101",false) : ""); if (url.pathname === "/course/modedit.php") { const chunks=[]; request.on("data",x=>chunks.push(x)); return request.on("end",()=>{const values=new URLSearchParams(Buffer.concat(chunks).toString());posts.push(values);created={name:values.get("name")};response.writeHead(303,{location:"/course/view.php?id=2"}).end();}); } response.writeHead(404).end(); });
  let browser; let context; try { await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",error=>error?reject(error):resolve())); const address=server.address(); origin=`https://127.0.0.1:${address.port}`; browser=await chromium.launch({headless:true,executablePath:chromium.executablePath()}); context=await browser.newContext({ignoreHTTPSErrors:true}); const page=await context.newPage(); await page.goto(`${origin}/course/view.php?id=2`); await page.evaluate(wwwroot=>{globalThis.M={cfg:{wwwroot,sesskey:"synthetic-session",userId:3,courseId:2}};},origin); const binding={origin,siteUrl:`${origin}/`,principalId:"3",courseId:"2"}; const base={mode:"execute",binding,expiresAt:Date.now()+60_000}; assert.equal((await executeInBrowser(page,{...base,operation:imscpReadOperation,arguments:{course_id:2,module_id:99}})).error,"moodle_form_target_invalid"); const prepared=await executeInBrowser(page,{...base,operation:imscpCreationReadOperation,arguments:{course_id:2,section_id:7}}); assert.equal(prepared.ok,true,JSON.stringify(prepared)); const unsafeName=Buffer.from("../after-manifest.txt","utf8"); const unsafeContent=Buffer.from("bad","utf8"); const unsafeLocal=Buffer.alloc(30+unsafeName.length+unsafeContent.length); unsafeLocal.writeUInt32LE(0x04034b50,0); unsafeLocal.writeUInt16LE(20,4); unsafeLocal.writeUInt32LE(unsafeContent.length,18); unsafeLocal.writeUInt32LE(unsafeContent.length,22); unsafeLocal.writeUInt16LE(unsafeName.length,26); unsafeName.copy(unsafeLocal,30); unsafeContent.copy(unsafeLocal,30+unsafeName.length); const unsafeCentral=Buffer.alloc(46+unsafeName.length); unsafeCentral.writeUInt32LE(0x02014b50,0); unsafeCentral.writeUInt16LE(20,4); unsafeCentral.writeUInt16LE(20,6); unsafeCentral.writeUInt32LE(unsafeContent.length,20); unsafeCentral.writeUInt32LE(unsafeContent.length,24); unsafeCentral.writeUInt16LE(unsafeName.length,28); unsafeCentral.writeUInt32LE(local.length,42); unsafeName.copy(unsafeCentral,46); const unsafeEnd=Buffer.alloc(22); unsafeEnd.writeUInt32LE(0x06054b50,0); unsafeEnd.writeUInt16LE(2,8); unsafeEnd.writeUInt16LE(2,10); unsafeEnd.writeUInt32LE(central.length+unsafeCentral.length,12); unsafeEnd.writeUInt32LE(local.length+unsafeLocal.length,16); const unsafeBytes=Buffer.concat([local,unsafeLocal,central,unsafeCentral,unsafeEnd]); const unsafeManifest={filename,size_bytes:unsafeBytes.length,sha256:createHash("sha256").update(unsafeBytes).digest("hex")}; const unsafe=await executeInBrowser(page,{...base,operation:imscpCreationWriteOperation,arguments:{course_id:2,section_id:7,name:"IMS package",...unsafeManifest,expected_digest:prepared.snapshot_digest},privateAttachment:{schema:"morrow.private-file-attachment.v1",handle:"file:imscp-unsafe",manifest:unsafeManifest,bytes_base64:unsafeBytes.toString("base64")}}); assert.deepEqual(unsafe,{ok:false,sent:false,error:"moodle_imscp_package_manifest_invalid"}); assert.equal(posts.length,0); assert.equal(requests.some(x=>x.startsWith("POST /repository/repository_ajax.php")),false); const result=await executeInBrowser(page,{...base,operation:imscpCreationWriteOperation,arguments:{course_id:2,section_id:7,name:"IMS package",...manifest,expected_digest:prepared.snapshot_digest},privateAttachment:{schema:"morrow.private-file-attachment.v1",handle:"file:imscp-1",manifest,bytes_base64:bytes.toString("base64")}}); assert.equal(result.ok,true,JSON.stringify(result)); assert.equal(posts.length,1); assert.equal(posts[0].get("package"),"100"); assert.equal(posts[0].get("visible"),"0"); assert.ok(requests.includes("GET /pluginfile.php/77/mod_imscp/backup/1/package.zip?forcedownload=1")); assert.equal(requests.some(x=>x.startsWith("GET /mod/imscp/view.php")),false); } finally { await context?.close(); await browser?.close(); await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve())); rmSync(directory,{recursive:true,force:true}); }
});

const scormReadOperation = { key: "moodle.form.course.modedit.scorm.read.v1", toolName: "moodle_get_scorm", provider: "moodle", readOnly: true };
const scormCreationReadOperation = { key: "moodle.form.course.modedit.scorm.package.create.read.v1", toolName: "moodle_get_scorm_package_creation_form", provider: "moodle", readOnly: true };
const scormCreationWriteOperation = { key: "moodle.form.course.modedit.scorm.package.create.write.v1", toolName: "moodle_create_scorm_package", provider: "moodle", readOnly: false };

test("Moodle executor verifies a hidden local SCORM package without launching it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-scorm-browser-"));
  const key = join(directory, "key.pem");
  const certificate = join(directory, "certificate.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", certificate], { stdio: "ignore" });
  const filename = "course.zip";
  const manifestName = Buffer.from("imsmanifest.xml", "utf8");
  const manifestContent = Buffer.from("<manifest/>", "utf8");
  const local = Buffer.alloc(30 + manifestName.length + manifestContent.length);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(manifestContent.length, 18); local.writeUInt32LE(manifestContent.length, 22); local.writeUInt16LE(manifestName.length, 26); manifestName.copy(local, 30); manifestContent.copy(local, 30 + manifestName.length);
  const central = Buffer.alloc(46 + manifestName.length);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(manifestContent.length, 20); central.writeUInt32LE(manifestContent.length, 24); central.writeUInt16LE(manifestName.length, 28); manifestName.copy(central, 46);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(local.length, 16);
  const bytes = Buffer.concat([local, central, end]);
  const manifest = { filename, size_bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  let origin = "";
  let created = null;
  let saveUnknown = false;
  let nextDraftItem = 100;
  const drafts = new Map();
  const posts = [];
  const requests = [];
  const manager = (itemId) => ({ target: "id_packagefile", itemid: itemId, context: { id: 88 }, maxbytes: -1, areamaxbytes: -1, maxfiles: 1, subdirs: 0, accepted_types: [".zip", ".xml"], filepicker: { repositories: { 17: { id: "17", type: "upload" } } }, author: "Morrow" });
  const form = (itemId, add) => `<!doctype html><body><form method="post" action="/course/modedit.php?${add ? "add=scorm&amp;course=2&amp;sectionid=7&amp;return=0" : "update=99&amp;return=0"}"><input name="${add ? "course" : "update"}" value="${add ? "2" : "99"}"><input name="${add ? "add" : "course"}" value="${add ? "scorm" : "2"}"><input name="modulename" value="scorm"><input name="section" value="4"><input name="return" value="0"><input name="name" value="${add ? "" : "SCORM package"}"><textarea name="introeditor[text]"></textarea><input name="introeditor[format]" value="1"><input name="scormtype" value="local"><input name="updatefreq" value="0"><input name="popup" value="0"><input name="skipview" value="1"><input name="displaycoursestructure" value="1"><input name="hidebrowse" value="0"><input name="visible" value="${add ? "1" : "0"}"><div data-fieldtype="filemanager"><input type="hidden" id="id_packagefile" name="packagefile" value="${itemId}"></div><input type="submit" name="submitbutton2" value="Save changes and return to course"><input name="sesskey" value="synthetic-session"></form><script>M.form_filemanager.init(Y, ${JSON.stringify(manager(itemId))});</script></body>`;
  const state = () => JSON.stringify([{ data: JSON.stringify({ course: { id: 2, fullname: "SCORM course" }, section: [{ id: 7, number: 4, title: "SCORM section", component: "", visible: true, hasrestrictions: false }], cm: created ? [{ id: 99, module: "scorm", sectionid: 7, name: created.name, visible: false }] : [] }) }]);
  const server = createServer({ key: readFileSync(key), cert: readFileSync(certificate) }, (request, response) => {
    const url = new URL(request.url || "/", origin); requests.push(`${request.method} ${url.pathname}${url.search}`);
    if (url.pathname === "/course/view.php") return response.end('<body class="path-course course-2">');
    if (url.pathname === "/lib/ajax/service.php") { request.resume(); return request.on("end", () => response.end(state())); }
    if (url.pathname === "/repository/draftfiles_ajax.php") { const chunks=[]; request.on("data", (chunk) => chunks.push(chunk)); return request.on("end", () => { const item = new URLSearchParams(Buffer.concat(chunks).toString()).get("itemid"); const saved = item === "200" && created; const draft = saved ? bytes : drafts.get(item); response.setHeader("content-type", "application/json"); response.end(JSON.stringify(draft ? { filecount: 1, list: [{ filename, filepath: "/", type: "zip", size: bytes.length, sortorder: 1, mimetype: "application/zip" }], tree: { children: [] } } : { filecount: 0, list: [], tree: { children: [] } })); }); }
    if (url.pathname === "/repository/repository_ajax.php") { const chunks=[]; request.on("data", (chunk) => chunks.push(chunk)); return request.on("end", () => { const item = Buffer.concat(chunks).toString("latin1").match(/name="itemid"\r\n\r\n([0-9]+)/)?.[1]; drafts.set(item, bytes); response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ id: Number(item), file: filename, url: `${origin}/draftfile.php/3/user/draft/${item}/${filename}` })); }); }
    if (url.pathname.startsWith("/draftfile.php/")) { const draft = drafts.get(url.pathname.split("/")[5]); response.setHeader("content-length", draft.length); return response.end(draft); }
    if (url.pathname === "/pluginfile.php/88/mod_scorm/package/course.zip") { response.setHeader("content-length", bytes.length); return response.end(bytes); }
    if (url.pathname === "/course/modedit.php" && request.method === "GET") return response.end(url.searchParams.get("add") === "scorm" ? form(String(nextDraftItem), true) : created && url.searchParams.get("update") === "99" ? form("200", false) : "");
    if (url.pathname === "/course/modedit.php") { const chunks=[]; request.on("data", (chunk) => chunks.push(chunk)); return request.on("end", () => { const values = new URLSearchParams(Buffer.concat(chunks).toString()); posts.push(values); nextDraftItem += 1; if (saveUnknown) return response.writeHead(500).end("unknown"); created = { name: values.get("name") }; response.writeHead(303, { location: "/course/view.php?id=2" }).end(); }); }
    response.writeHead(404).end();
  });
  let browser; let context;
  try {
    await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
    const address = server.address(); origin = `https://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() }); context = await browser.newContext({ ignoreHTTPSErrors: true }); const page = await context.newPage();
    await page.goto(`${origin}/course/view.php?id=2`); await page.evaluate((wwwroot) => { globalThis.M = { cfg: { wwwroot, sesskey: "synthetic-session", userId: 3, courseId: 2 } }; }, origin);
    const binding = { origin, siteUrl: `${origin}/`, principalId: "3", courseId: "2" }; const base = { mode: "execute", binding, expiresAt: Date.now() + 60_000 };
    const prepared = await executeInBrowser(page, { ...base, operation: scormCreationReadOperation, arguments: { course_id: 2, section_id: 7 } });
    assert.equal(prepared.ok, true, JSON.stringify(prepared)); assert.deepEqual(prepared.data, { course_id: 2, section_id: 7, name: "", visible: true });
    const saved = await executeInBrowser(page, { ...base, operation: scormCreationWriteOperation, arguments: { course_id: 2, section_id: 7, name: "SCORM package", ...manifest, expected_digest: prepared.snapshot_digest }, privateAttachment: { schema: "morrow.private-file-attachment.v1", handle: "file:scorm-1", manifest, bytes_base64: bytes.toString("base64") } });
    assert.equal(saved.ok, true, JSON.stringify(saved)); assert.equal(posts.length, 1); assert.equal(posts[0].get("packagefile"), "100"); assert.equal(posts[0].get("visible"), "0"); assert.equal(posts[0].get("scormtype"), "local"); assert.equal(posts[0].get("updatefreq"), "0"); assert.equal(posts[0].get("skipview"), "1"); assert.equal(posts[0].get("displaycoursestructure"), "1");
    assert.ok(requests.includes("GET /pluginfile.php/88/mod_scorm/package/course.zip?forcedownload=1")); assert.equal(requests.some((entry) => /GET \/mod\/scorm\/(?:view|player|report)\.php/.test(entry)), false);
    const read = await executeInBrowser(page, { ...base, operation: scormReadOperation, arguments: { course_id: 2, module_id: 99 } });
    assert.equal(read.ok, true, JSON.stringify(read)); assert.deepEqual(read.data, { course_id: 2, module_id: 99, name: "SCORM package", instructions: "", instructions_format: 1, package_type: "local", update_frequency: "0", display_mode: "0", package_state: "not_read" });
    const unknownPreparation = await executeInBrowser(page, { ...base, operation: scormCreationReadOperation, arguments: { course_id: 2, section_id: 7 } }); assert.equal(unknownPreparation.ok, true, JSON.stringify(unknownPreparation)); saveUnknown = true;
    const unknown = await executeInBrowser(page, { ...base, operation: scormCreationWriteOperation, arguments: { course_id: 2, section_id: 7, name: "Uncertain SCORM", ...manifest, expected_digest: unknownPreparation.snapshot_digest }, privateAttachment: { schema: "morrow.private-file-attachment.v1", handle: "file:scorm-2", manifest, bytes_base64: bytes.toString("base64") } });
    assert.equal(unknown.ok, false, JSON.stringify(unknown)); assert.equal(unknown.sent, true, JSON.stringify(unknown)); assert.equal(unknown.outcomeUnknown, true, JSON.stringify(unknown)); assert.equal(unknown.error, "moodle_scorm_save_unknown"); assert.equal(posts.length, 2);
  } finally { await context?.close(); await browser?.close(); await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); rmSync(directory, { recursive: true, force: true }); }
});

test("Moodle executor updates and creates hidden Pages and Assignments from native forms in Chrome for Testing", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-browser-"));
  const key = join(directory, "key.pem");
  const certificate = join(directory, "certificate.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", certificate], { stdio: "ignore" });
  const state = {
    name: "Week 1 notes",
    content: "<p>Original content</p>",
    revision: 7,
    visible: true,
    completion: { year: 2026, month: 9, day: 5, hour: 9, minute: 30 },
  };
  const creationDefaults = {
    name: "",
    content: "",
    visible: true,
    completion: { year: 2026, month: 9, day: 5, hour: 9, minute: 30 },
  };
  const assignment = {
    name: "Evidence analysis",
    instructions: "<p>Original brief</p>",
    visible: true,
    dates: {
      allowsubmissionsfromdate: null,
      duedate: { year: 2026, month: 9, day: 5, hour: 9, minute: 30 },
      cutoffdate: null,
      gradingduedate: null,
    },
    settings: assignmentSettingDefaults(),
    submissionsExist: false,
    gradePass: "0.00",
  };
  const assignmentCreationDefaults = {
    name: "",
    instructions: "",
    visible: true,
    dates: { allowsubmissionsfromdate: null, duedate: null, cutoffdate: null, gradingduedate: null },
    settings: assignmentSettingDefaults(),
    submissionsExist: false,
    gradePass: "",
  };
  const overrideUsers = [{ id: "9", name: "Robin Fields" }, { id: "10", name: "Sam Ortega" }];
  const overrideGroups = [{ id: "5", name: "Section A" }, { id: "6", name: "Section B" }];
  const assignmentOverrides = [
    { id: 41, scope: "user", userId: "9", userName: "Robin Fields", dates: { allowsubmissionsfromdate: null, duedate: { year: 2026, month: 9, day: 12, hour: 17, minute: 0 }, cutoffdate: null } },
    { id: 42, scope: "group", groupId: "5", groupName: "Section A", dates: { allowsubmissionsfromdate: null, duedate: { year: 2026, month: 9, day: 14, hour: 9, minute: 0 }, cutoffdate: null } },
  ];
  const overridePosts = [];
  let nextOverrideId = 43;
  const resource = { name: "Evidence files", visible: true, visibleOld: true };
  const label = { name: "Orientation text", content: "<p>Original Label text</p>" };
  const urlResource = { name: "Course library", externalUrl: "https://library.example.test/original", description: "<p>Original URL description</p>" };
  const labelCreationDefaults = { name: "", content: "", visible: true };
  const urlCreationDefaults = { name: "", externalUrl: "https://library.example.test/", description: "", visible: true };
  const hiddenSectionActivity = { visible: false, visibleOld: false, stealth: false };
  const quizActivity = { visible: true, visibleOld: true };
  const posts = [];
  const assignmentPosts = [];
  const assignmentCreationPosts = [];
  const quizQuestionPosts = [];
  const visibilityActions = [];
  const draftListIds = [];
  const requests = [];
  let discoveryArgs;
  let structureReads = 0;
  let createdPage = null;
  let createdAssignment = null;
  let createdLabel = null;
  let createdUrl = null;
  const createdQuizQuestions = [];
  let priorSlotsReordered = false;
  let reorderPriorSlotsOnNextQuestion = false;
  let changeName = false;
  let draftId = 700;
  let editorDraftId = 20000;
  let draftFileCount = 0;
  const pageEditorDraftIds = new Set();
  const labelEditorDraftIds = new Set();
  const urlEditorDraftIds = new Set();
  let editorFileAppearsAfterNextPageDraftRead = false;
  let editorFileAppearsAfterNextLabelDraftRead = false;
  let editorFileAppearsAfterNextUrlDraftRead = false;
  let urlIdentityAltered = false;
  let labelCreationAvailability = "label-create-availability";
  let urlCreationDisplay = "5";
  let changeLabelCreationAfterNextFormRead = false;
  let changeUrlCreationAfterNextFormRead = false;
  let resourceDraftId = 9001;
  let resourceListing = {
    filecount: 2,
    list: [
      { filename: "brief.pdf", filepath: "/", type: "file", size: 512, sortorder: "1", mimetype: "PDF document" },
      { filename: "evidence.zip", filepath: "/", type: "zip", size: null, sortorder: 0, mimetype: "ZIP archive" },
    ],
    tree: { children: [] },
  };
  let sectionVisible = false;
  let sectionHasRestrictions = false;
  let leaveHiddenActivityVisibleOnSectionHide = false;
  let quizEditNative = true;
  let quizCopyCategoryValid = true;
  let quizHasRandomSlot = true;
  let quizCreationIdNumber = "quiz-evidence-fresh";
  let quizCreationTags = { tags: ["quiz-evidence-tag"], courseTags: ["quiz-course-tag"] };
  let changeQuizCreationTagsAfterNextRead = false;
  let moveFixture = false;
  let moveActivitySection = 7;
  let moveActivityModule = "page";
  let moveCourseFormat = "topics";
  let moveCourseFormatAfter = "";
  let moveCourseFormatAfterState = "";
  let moveCourseFormUnavailable = false;
  let moveCourseFormUnavailableAfter = false;
  let moveActivityDelegated = false;
  let moveActivityRestricted = false;
  let moveUnexpected = false;
  let moveUnexpectedAfter = false;
  const moveActions = [];
  let nativeFormSesskey = "synthetic-session";
  let nativePageSesskey = "synthetic-session";
  let switchNativeSessionAfterNextPageRead = false;
  let changePageAfterNextFormRead = false;
  const formWithSession = (html) => html.replace("</form>", `<input type="hidden" name="sesskey" value="${nativeFormSesskey}"></form>`);
  const moveState = () => {
    const moved = {
      id: 59, module: moveActivityModule, sectionid: String(moveActivitySection), sectionnumber: moveActivitySection === 7 ? 4 : 5,
      name: "Evidence notebook", visible: true, stealth: false, hasdelegatedsection: moveActivityDelegated,
      uservisible: true, accessvisible: true, hascmrestrictions: moveActivityRestricted, allowstealth: true,
    };
    const destination = {
      id: 60, module: "url", sectionid: "8", sectionnumber: 5, name: "Further reading", visible: true,
      stealth: false, hasdelegatedsection: false, uservisible: true, accessvisible: true, hascmrestrictions: false, allowstealth: true,
    };
    return {
      course: { id: 2, fullname: moveUnexpected ? "Unexpected course name" : "Week 1" },
      section: [
        { id: "7", number: 4, title: "Week 4: Evidence", visible: true, hasrestrictions: false, component: "", cmlist: moveActivitySection === 7 ? ["59"] : [] },
        { id: "8", number: 5, title: "Week 5: Synthesis", visible: true, hasrestrictions: false, component: null, cmlist: moveActivitySection === 7 ? ["60"] : ["60", "59"] },
      ],
      cm: moveActivitySection === 7 ? [moved, destination] : [destination, moved],
    };
  };
  const server = createServer({ key: readFileSync(key), cert: readFileSync(certificate) }, (request, response) => {
    const url = new URL(request.url || "/", "https://127.0.0.1");
    requests.push(`${request.method} ${url.pathname}${url.search}`);
    if (url.pathname === "/course/view.php") {
      const courseId = url.searchParams.get("id") === "1" ? "1" : "2";
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><body class="path-course course-${courseId}"><h1>Week ${courseId}</h1><script>var M = {}; M.cfg = ${JSON.stringify({ wwwroot: `https://${request.headers.host}`, sesskey: nativePageSesskey, userId: 3 })};</script></body>`);
      return;
    }
    if (url.pathname === "/mod/page/view.php" || url.pathname === "/mod/assign/view.php" || url.pathname === "/mod/url/view.php") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end('<!doctype html><body class="path-course course-2"><h1>Week 1</h1></body>');
      return;
    }
    if (url.pathname === "/course/edit.php" && request.method === "GET" && url.search === "?id=2") {
      if (moveCourseFormUnavailable) {
        response.writeHead(503).end();
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end(formWithSession(`<!doctype html><html><body><form method="post" action="/course/edit.php">
        <input type="hidden" name="id" value="2"><input name="fullname" value="Week 1"><input name="shortname" value="W1">
        <input type="hidden" name="format" value="${moveCourseFormat}"><input type="hidden" name="visible" value="1">
        <textarea name="summary_editor[text]"></textarea><input type="hidden" name="summary_editor[format]" value="1">
        <input type="submit" name="saveanddisplay" value="Save and display"></form></body></html>`));
      return;
    }
    if (url.pathname === "/lib/ajax/service.php") {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const call = JSON.parse(Buffer.concat(chunks).toString("utf8"))[0];
        if (call?.methodname === "core_courseformat_update_course") {
          if (call.args.action === "cm_move") {
            moveActions.push(call.args);
            moveActivitySection = 8;
            if (moveCourseFormatAfter) moveCourseFormat = moveCourseFormatAfter;
            if (moveCourseFormUnavailableAfter) moveCourseFormUnavailable = true;
            if (moveUnexpectedAfter) moveUnexpected = true;
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify([{ data: null }]));
            return;
          }
          visibilityActions.push(call.args.action);
          if (createdPage) {
            if (call.args.action === "section_hide") {
              createdPage.visibleOld = createdPage.visible;
              createdPage.visible = false;
              resource.visibleOld = resource.visible;
              resource.visible = false;
              hiddenSectionActivity.visibleOld = hiddenSectionActivity.visible;
              if (!leaveHiddenActivityVisibleOnSectionHide) hiddenSectionActivity.visible = false;
              quizActivity.visibleOld = quizActivity.visible;
              quizActivity.visible = false;
              sectionVisible = false;
              sectionHasRestrictions = false;
            } else if (call.args.action === "section_show") {
              createdPage.visible = createdPage.visibleOld;
              resource.visible = resource.visibleOld;
              hiddenSectionActivity.visible = hiddenSectionActivity.visibleOld;
              quizActivity.visible = quizActivity.visibleOld;
              sectionVisible = true;
              sectionHasRestrictions = true;
            } else {
              createdPage.visible = call.args.action === "cm_show";
              createdPage.visibleOld = createdPage.visible;
            }
            if (changeName) { createdPage.name = "Unexpected Page name"; changeName = false; }
          }
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify([{ data: null }]));
          return;
        }
        if (call?.methodname === "core_course_get_enrolled_courses_by_timeline_classification") {
          discoveryArgs = call.args;
          const courses = [{ id: 1, fullname: "Week 1" }, { id: 2, fullname: "Week 2" }]
            .slice(call.args.offset, call.args.offset + call.args.limit);
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify([{ data: { courses } }]));
          return;
        }
        structureReads += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify([{
          data: JSON.stringify(moveFixture ? moveState() : {
            course: { id: 2 },
            section: [{ id: 7, number: 4, title: "Week 4: Evidence", visible: sectionVisible, hasrestrictions: sectionHasRestrictions, component: "" }],
            cm: [
              ...(createdPage ? [{ id: 55, module: "page", sectionid: 7, name: createdPage.name, visible: createdPage.visible, uservisible: true, accessvisible: createdPage.visible, hascmrestrictions: false, stealth: createdPage.visible && !sectionVisible, allowstealth: sectionVisible }] : []),
              ...(createdLabel ? [{ id: 60, module: "label", sectionid: 7, name: createdLabel.name, visible: createdLabel.visible, uservisible: true, accessvisible: createdLabel.visible, hascmrestrictions: false, stealth: createdLabel.visible && !sectionVisible, allowstealth: sectionVisible }] : []),
              ...(createdUrl ? [{ id: 61, module: "url", sectionid: 7, name: createdUrl.name, visible: createdUrl.visible, uservisible: true, accessvisible: createdUrl.visible, hascmrestrictions: false, stealth: createdUrl.visible && !sectionVisible, allowstealth: sectionVisible }] : []),
              { id: 58, module: "resource", sectionid: 7, name: resource.name, visible: resource.visible, uservisible: true, accessvisible: resource.visible, hascmrestrictions: false, stealth: resource.visible && !sectionVisible, allowstealth: sectionVisible },
              { id: 57, module: "url", sectionid: 7, name: "Already hidden resource", visible: hiddenSectionActivity.visible, uservisible: true, accessvisible: hiddenSectionActivity.visible, hascmrestrictions: false, stealth: hiddenSectionActivity.stealth, allowstealth: sectionVisible },
              { id: 9, module: "quiz", sectionid: 7, name: "Evidence quiz", visible: quizActivity.visible, uservisible: true, accessvisible: quizActivity.visible, hascmrestrictions: false, stealth: quizActivity.visible && !sectionVisible, allowstealth: sectionVisible },
              ...(createdAssignment ? [{ id: 56, module: "assign", sectionid: 7, visible: createdAssignment.visible }] : []),
            ],
          }),
        }]));
        if (moveFixture && moveCourseFormatAfterState) {
          moveCourseFormat = moveCourseFormatAfterState;
          moveCourseFormatAfterState = "";
        }
      });
      return;
    }
    if (url.pathname === "/repository/draftfiles_ajax.php") {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const itemId = new URLSearchParams(Buffer.concat(chunks).toString("utf8")).get("itemid");
        draftListIds.push(itemId);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(itemId === String(resourceDraftId) ? resourceListing : { filecount: draftFileCount, filesize: draftFileCount, list: draftFileCount ? [{ filename: "existing.pdf" }] : [] }));
        if (editorFileAppearsAfterNextPageDraftRead && pageEditorDraftIds.has(String(itemId))) {
          editorFileAppearsAfterNextPageDraftRead = false;
          draftFileCount = 1;
        }
        if (editorFileAppearsAfterNextLabelDraftRead && labelEditorDraftIds.has(String(itemId))) {
          editorFileAppearsAfterNextLabelDraftRead = false;
          draftFileCount = 1;
        }
        if (editorFileAppearsAfterNextUrlDraftRead && urlEditorDraftIds.has(String(itemId))) {
          editorFileAppearsAfterNextUrlDraftRead = false;
          draftFileCount = 1;
        }
      });
      return;
    }
    if (url.pathname === "/mod/quiz/edit.php" && request.method === "GET" && url.searchParams.get("cmid") === "9") {
      if (url.searchParams.get("addquestion")) {
        response.writeHead(303, { location: "/mod/quiz/edit.php?cmid=9" }).end();
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end(quizEditNative ? quizEditPage(createdQuizQuestions, priorSlotsReordered, quizHasRandomSlot) : "<!doctype html><html><body>Quiz access denied</body></html>");
      return;
    }
    if (url.pathname === "/question/bank/editquestion/addquestion.php" && request.method === "GET"
      && url.searchParams.get("cmid") === "9" && url.searchParams.get("category") === "42"
      && url.searchParams.get("returnurl") === "/mod/quiz/edit.php?cmid=9&addonpage=0"
      && url.searchParams.get("appendqnumstring") === "addquestion") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><html><body><form method="get" action="/question/bank/editquestion/question.php"><input name="category" value="42"><input name="cmid" value="9"><input name="returnurl" value="/mod/quiz/edit.php?cmid=9&amp;addonpage=0"><input name="appendqnumstring" value="addquestion"><input type="radio" name="qtype" value="multichoice"><input type="submit" value="Choose"></form></body></html>`);
      return;
    }
    if (url.pathname === "/question/bank/editquestion/question.php" && request.method === "GET" && url.searchParams.get("id") === "401" && url.searchParams.get("cmid") === "9") {
      response.writeHead(200, { "content-type": "text/html" });
      const form = multipleChoiceQuestionForm(undefined, url.searchParams.get("makecopy") === "1");
      response.end(quizCopyCategoryValid ? form : form.replace('name="categorymoveto"', 'name="unknowncategory"'));
      return;
    }
    if (url.pathname === "/question/bank/editquestion/question.php" && request.method === "GET" && url.searchParams.get("id") && url.searchParams.get("cmid") === "9") {
      const question = createdQuizQuestions.find((entry) => String(entry.id) === url.searchParams.get("id"));
      if (!question) { response.writeHead(404).end(); return; }
      response.writeHead(200, { "content-type": "text/html" });
      response.end(multipleChoiceQuestionForm(question, url.searchParams.get("makecopy") === "1"));
      return;
    }
    if (url.pathname === "/question/bank/editquestion/question.php" && request.method === "GET"
      && url.searchParams.get("category") === "42" && url.searchParams.get("cmid") === "9"
      && url.searchParams.get("qtype") === "multichoice"
      && url.searchParams.get("returnurl") === "/mod/quiz/edit.php?cmid=9&addonpage=0"
      && url.searchParams.get("appendqnumstring") === "addquestion") {
      response.writeHead(200, { "content-type": "text/html" });
      const form = multipleChoiceCreationForm(quizCreationIdNumber, quizCreationTags);
      if (changeQuizCreationTagsAfterNextRead) {
        changeQuizCreationTagsAfterNextRead = false;
        quizCreationTags = { tags: ["quiz-evidence-changed"], courseTags: ["quiz-course-tag"] };
      }
      response.end(form);
      return;
    }
    if (url.pathname === "/mod/assign/overrides.php" && request.method === "GET") {
      const mode = url.searchParams.get("mode");
      if (url.searchParams.get("cmid") !== "8" || !["user", "group"].includes(mode)) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end(assignmentOverridesPage(assignmentOverrides, mode));
      return;
    }
    if (url.pathname === "/mod/assign/overrideedit.php" && request.method === "GET") {
      const overrideId = url.searchParams.get("id");
      const action = url.searchParams.get("action");
      const entry = assignmentOverrides.find((candidate) => String(candidate.id) === overrideId);
      if (!entry && !(url.searchParams.get("cmid") === "8" && ["adduser", "addgroup"].includes(action))) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end(formWithSession(assignmentOverrideForm(entry || null, {
        scope: action === "addgroup" ? "group" : "user", users: overrideUsers, groups: overrideGroups,
      })));
      return;
    }
    if (url.pathname === "/mod/assign/overrideedit.php" && request.method === "POST") {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const values = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        overridePosts.push(values);
        const dates = savedDates(values, OVERRIDE_DATE_FIELDS);
        const existing = assignmentOverrides.find((candidate) => String(candidate.id) === values.get("id"));
        const scope = values.has("groupid") ? "group" : "user";
        if (existing) existing.dates = dates;
        else {
          const groupId = values.get("groupid") || "";
          const userId = values.get("userid") || "";
          assignmentOverrides.push({
            id: nextOverrideId, scope, dates,
            ...(scope === "group"
              ? { groupId, groupName: overrideGroups.find((group) => group.id === groupId)?.name || "" }
              : { userId, userName: overrideUsers.find((user) => user.id === userId)?.name || "" }),
          });
          nextOverrideId += 1;
        }
        response.writeHead(303, { location: `/mod/assign/overrides.php?cmid=8&mode=${scope}` }).end();
      });
      return;
    }
    if (url.pathname === "/question/bank/editquestion/question.php" && request.method === "POST") {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const values = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        quizQuestionPosts.push(values);
        const id = 403 + createdQuizQuestions.length;
        createdQuizQuestions.push({
          id,
          name: values.get("name") || "",
          questionText: values.get("questiontext[text]") || "",
          defaultMark: values.get("defaultmark") || "",
          idNumber: values.get("idnumber") || "",
          tags: values.getAll("tags[]"),
          courseTags: values.getAll("coursetags[]"),
          answers: [0, 1].map((index) => ({ text: values.get(`answer[${index}][text]`) || "", fraction: values.get(`fraction[${index}]`) || "", feedback: values.get(`feedback[${index}][text]`) || "" })),
        });
        if (reorderPriorSlotsOnNextQuestion) {
          priorSlotsReordered = true;
          reorderPriorSlotsOnNextQuestion = false;
        }
        response.writeHead(303, { location: `/mod/quiz/edit.php?cmid=9&addquestion=${id}&sesskey=synthetic-session` }).end();
      });
      return;
    }
    if (url.pathname !== "/course/modedit.php") {
      response.writeHead(404).end();
      return;
    }
    if (request.method === "GET") {
      response.writeHead(200, { "content-type": "text/html" });
      let form;
      if (url.searchParams.get("add") === "page") {
        const itemId = ++editorDraftId;
        pageEditorDraftIds.add(String(itemId));
        form = pageCreationForm(creationDefaults, itemId);
      }
      else if (url.searchParams.get("add") === "label") {
        const itemId = ++editorDraftId;
        labelEditorDraftIds.add(String(itemId));
        form = labelForm(labelCreationDefaults, itemId, { creation: true, availability: labelCreationAvailability });
      }
      else if (url.searchParams.get("add") === "url") {
        const itemId = ++editorDraftId;
        urlEditorDraftIds.add(String(itemId));
        form = urlForm(urlCreationDefaults, itemId, { creation: true, display: urlCreationDisplay });
      }
      else if (url.searchParams.get("add") === "assign") form = assignmentForm(assignmentCreationDefaults, ++draftId, { creation: true });
      else if (url.searchParams.get("update") === "6") {
        const itemId = ++editorDraftId;
        pageEditorDraftIds.add(String(itemId));
        form = pageForm(state, 6, itemId);
      }
      else if (url.searchParams.get("update") === "55" && createdPage) {
        const itemId = ++editorDraftId;
        pageEditorDraftIds.add(String(itemId));
        form = pageForm(createdPage, 55, itemId);
      }
      else if (url.searchParams.get("update") === "58") form = resourceForm(resource.name, resourceDraftId);
      else if (url.searchParams.get("update") === "11") {
        const itemId = ++editorDraftId;
        labelEditorDraftIds.add(String(itemId));
        form = labelForm(label, itemId);
      }
      else if (url.searchParams.get("update") === "60" && createdLabel) {
        const itemId = ++editorDraftId;
        labelEditorDraftIds.add(String(itemId));
        form = labelForm(createdLabel, itemId, { moduleId: 60, availability: createdLabel.availability });
      }
      else if (url.searchParams.get("update") === "12") {
        const itemId = ++editorDraftId;
        urlEditorDraftIds.add(String(itemId));
        form = urlForm(urlResource, itemId);
        if (urlIdentityAltered) {
          urlIdentityAltered = false;
          form = form.replace('action="/course/modedit.php"', 'action="/course/modedit.php?update=12&amp;return=1"').replace('<input name="update" value="12">', '<input name="update" value="12"><input name="update" value="99">');
        }
      }
      else if (url.searchParams.get("update") === "61" && createdUrl) {
        const itemId = ++editorDraftId;
        urlEditorDraftIds.add(String(itemId));
        form = urlForm(createdUrl, itemId, { moduleId: 61, display: createdUrl.display });
      }
      else if (url.searchParams.get("update") === "8") form = assignmentForm(assignment, ++draftId);
      else if (url.searchParams.get("update") === "56" && createdAssignment) form = assignmentForm(createdAssignment, ++draftId, { moduleId: 56 });
      else { response.writeHead(404).end(); return; }
      const rendered = formWithSession(form);
      if (url.searchParams.get("update") === "6" && changePageAfterNextFormRead) {
        changePageAfterNextFormRead = false;
        state.content = "<p>External edit</p>";
      }
      if (url.searchParams.get("update") === "6" && switchNativeSessionAfterNextPageRead) {
        switchNativeSessionAfterNextPageRead = false;
        nativeFormSesskey = "cookie-session-b";
      }
      if (url.searchParams.get("add") === "label" && changeLabelCreationAfterNextFormRead) {
        changeLabelCreationAfterNextFormRead = false;
        labelCreationAvailability = "label-create-availability-changed";
      }
      if (url.searchParams.get("add") === "url" && changeUrlCreationAfterNextFormRead) {
        changeUrlCreationAfterNextFormRead = false;
        urlCreationDisplay = "6";
      }
      response.end(rendered);
      return;
    }
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const values = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      posts.push(values);
      if (values.get("add") === "label") {
        createdLabel = {
          name: values.get("name") || "",
          content: values.get("introeditor[text]") || "",
          visible: values.get("visible") === "1",
          availability: values.get("availability") || "",
        };
        response.writeHead(303, { location: "/course/view.php?id=2" }).end();
        return;
      }
      if (values.get("add") === "url") {
        const submittedUrl = (values.get("externalurl") || "").replace(/&amp;/g, "&");
        createdUrl = {
          name: values.get("name") || "",
          externalUrl: /^(?:[a-z]+:|\/)/i.test(submittedUrl) ? submittedUrl : `http://${submittedUrl}`,
          description: values.get("introeditor[text]") || "",
          visible: values.get("visible") === "1",
          display: values.get("display") || "",
        };
        response.writeHead(303, { location: "/mod/url/view.php?id=61" }).end();
        return;
      }
      if (values.get("add") === "assign") {
        assignmentCreationPosts.push(values);
        createdAssignment = {
          name: values.get("name") || "",
          instructions: values.get("introeditor[text]") || "",
          visible: values.get("visible") === "1",
          dates: savedDates(values, ASSIGNMENT_DATE_FIELDS, assignmentCreationDefaults.dates),
          settings: savedSettings(values, assignmentCreationDefaults.settings),
          submissionsExist: false,
          gradePass: "0.00",
        };
        response.writeHead(303, { location: "/mod/assign/view.php?id=56" }).end();
        return;
      }
      if (values.get("update") === "8") {
        assignmentPosts.push(values);
        assignment.name = values.get("name") || "";
        assignment.instructions = values.get("introeditor[text]") || "";
        assignment.dates = savedDates(values, ASSIGNMENT_DATE_FIELDS, assignment.dates);
        assignment.settings = savedSettings(values, assignment.settings);
        response.writeHead(303, { location: "/course/view.php" }).end();
        return;
      }
      if (values.get("update") === "11") {
        label.content = values.get("introeditor[text]") || "";
        response.writeHead(303, { location: "/course/view.php" }).end();
        return;
      }
      if (values.get("update") === "12") {
        const submittedUrl = (values.get("externalurl") || "").replace(/&amp;/g, "&");
        urlResource.name = values.get("name") || "";
        urlResource.externalUrl = /^(?:[a-z]+:|\/)/i.test(submittedUrl) ? submittedUrl : `http://${submittedUrl}`;
        urlResource.description = values.get("introeditor[text]") || "";
        response.writeHead(303, { location: "/course/view.php" }).end();
        return;
      }
      if (values.get("add") === "page") {
        createdPage = {
          name: values.get("name") || "",
          content: values.get("page[text]") || "",
          revision: 1,
          visible: false,
          visibleOld: false,
          completion: creationDefaults.completion,
        };
        response.writeHead(303, { location: "/mod/page/view.php?id=55" }).end();
        return;
      }
      state.content = values.get("page[text]") || "";
      state.revision += 1;
      state.completion = { year: 2031, month: 1, day: 2, hour: 3, minute: 4 };
      response.writeHead(303, { location: "/course/view.php" }).end();
    });
  });
  let browser;
  let context;
  try {
    await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Moodle test server did not bind a port");
    const origin = `https://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await page.goto(`${origin}/course/view.php?id=1`);
    await page.evaluate((wwwroot) => {
      globalThis.M = { cfg: { wwwroot, sesskey: "synthetic-session", userId: 3, courseId: 1 } };
    }, origin);
    const binding = { origin, siteUrl: `${origin}/`, principalId: "3", courseId: "2" };
    const discovered = await executeInBrowser(page, {
      mode: "discover_courses",
      limit: 1,
      offset: 1,
      expiresAt: Date.now() + 60_000,
    });
    assert.deepEqual(discovered.data, {
      courses: [{ id: "2", name: "Week 2" }],
      offset: 1,
      limit: 1,
      next_offset: 2,
      complete: false,
    });
    assert.deepEqual(discoveryArgs, {
      classification: "allincludinghidden",
      limit: 1,
      offset: 1,
      sort: null,
      customfieldname: null,
      customfieldvalue: null,
      searchvalue: null,
      requiredfields: [],
    });
    const checkedCourse = await executeInBrowser(page, {
      mode: "check_course",
      courseId: "2",
      expiresAt: Date.now() + 60_000,
    });
    assert.deepEqual(checkedCourse.data, { id: "2", name: "Week 2" });
    nativePageSesskey = "cookie-session-b";
    assert.deepEqual(await executeInBrowser(page, {
      mode: "check_course",
      courseId: "2",
      expiresAt: Date.now() + 60_000,
    }), { ok: false, sent: false, status: 200, error: "moodle_binding_mismatch" });
    assert.equal(await page.evaluate(() => globalThis.M.cfg.sesskey), "synthetic-session");
    nativePageSesskey = "synthetic-session";
    assert.deepEqual(await executeInBrowser(page, {
      mode: "execute",
      operation: pageReadOperation,
      arguments: { course_id: 1, module_id: 6 },
      binding,
      expiresAt: Date.now() + 60_000,
    }), { ok: false, sent: false, error: "moodle_course_mismatch" });
    const read = await executeInBrowser(page, {
      mode: "execute",
      operation: pageReadOperation,
      arguments: { course_id: 2, module_id: 6 },
      binding,
      expiresAt: Date.now() + 60_000,
    });
    assert.equal(read.ok, true);
    assert.equal(read.data.content, "<p>Original content</p>");
    state.completion.minute = 31;
    const result = await executeInBrowser(page, {
      mode: "execute",
      operation: pageWriteOperation,
      arguments: { course_id: 2, module_id: 6, content: "<p>Updated content</p>", expected_digest: read.snapshot_digest },
      binding,
      expiresAt: Date.now() + 60_000,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.verification, { schema: "morrow.browser-verification.v1", status: "verified" });
    assert.equal(result.data.content, "<p>Updated content</p>");
    assert.equal(result.data.name, "Week 1 notes");
    assert.equal(state.revision, 8);
    assert.equal(posts.length, 1);
    const post = posts[0];
    assert.equal(post.get("page[text]"), "<p>Updated content</p>");
    assert.equal(post.get("name"), "Week 1 notes");
    assert.equal(post.get("revision"), "7");
    assert.equal(post.get("page[format]"), "1");
    assert.match(post.get("page[itemid]") || "", /^[1-9][0-9]*$/);
    assert.equal(JSON.stringify(result).includes(post.get("page[itemid]") || ""), false);
    assert.equal(post.get("displayoptions[display]"), "1");
    assert.equal(post.get("completionexpected[enabled]"), null);
    assert.equal(post.get("completionexpected[year]"), "2026");
    assert.equal(post.get("completionexpected[month]"), "9");
    assert.equal(post.get("completionexpected[day]"), "5");
    assert.equal(post.get("completionexpected[hour]"), "9");
    assert.equal(post.get("completionexpected[minute]"), "31");

    const preparation = await executeInBrowser(page, {
      mode: "execute",
      operation: pageCreateReadOperation,
      arguments: { course_id: 2, section_id: 7 },
      binding,
      expiresAt: Date.now() + 60_000,
    });
    assert.equal(preparation.ok, true);
    assert.match(preparation.snapshot_digest, /^[a-f0-9]{64}$/);
    assert.deepEqual(preparation.data, { course_id: 2, section_id: 7, name: "", content: "", content_format: 1, visible: true });
    assert.deepEqual(preparation.targets, [
      { field: "course_id", label: "Course", name: "Week 1" },
      { field: "section_id", label: "Section", name: "Week 4: Evidence" },
    ]);

    const created = await executeInBrowser(page, {
      mode: "execute",
      operation: pageCreateWriteOperation,
      arguments: {
        course_id: 2,
        section_id: 7,
        name: "Evidence notebook",
        content: "<p>Write one claim.</p>",
        expected_digest: preparation.snapshot_digest,
      },
      binding,
      expiresAt: Date.now() + 60_000,
    });
    assert.equal(created.ok, true);
    assert.deepEqual(created.verification, { schema: "morrow.browser-verification.v1", status: "verified" });
    assert.deepEqual(created.data, {
      course_id: 2,
      module_id: 55,
      name: "Evidence notebook",
      content: "<p>Write one claim.</p>",
      content_format: 1,
      section_id: 7,
      visible: false,
    });
    assert.deepEqual(created.targets, preparation.targets);
    assert.ok(requests.includes("GET /course/modedit.php?add=page&course=2&sectionid=7&return=0"));
    assert.ok(requests.includes("GET /course/modedit.php?update=55&return=0"));
    assert.equal(structureReads, 6);
    assert.equal(posts.length, 2);
    const creationPost = posts[1];
    assert.equal(creationPost.get("course"), "2");
    assert.equal(creationPost.get("add"), "page");
    assert.equal(creationPost.get("modulename"), "page");
    assert.equal(creationPost.get("section"), "4");
    assert.equal(creationPost.get("name"), "Evidence notebook");
    assert.equal(creationPost.get("page[text]"), "<p>Write one claim.</p>");
    assert.equal(creationPost.get("visible"), "0");
    assert.equal(creationPost.get("coursecontentnotification"), null);
    assert.equal(creationPost.get("page[format]"), "1");
    assert.match(creationPost.get("page[itemid]") || "", /^[1-9][0-9]*$/);
    assert.equal(creationPost.get("displayoptions[display]"), "1");
    assert.equal(creationPost.get("completionexpected[enabled]"), null);

    const resourceDraftRequests = draftListIds.length;
    const resourceFiles = await executeInBrowser(page, {
      mode: "execute",
      operation: resourceFilesReadOperation,
      arguments: { course_id: 2, module_id: 58 },
      binding,
      expiresAt: Date.now() + 60_000,
    });
    assert.equal(resourceFiles.ok, true);
    assert.deepEqual(resourceFiles.data, {
      course_id: 2,
      module_id: 58,
      name: "Evidence files",
      files: [
        { filename: "brief.pdf", relative_path: "brief.pdf", size_bytes: 512, media_type_label: "PDF document", main_file: true },
        { filename: "evidence.zip", relative_path: "evidence.zip", size_bytes: 0, media_type_label: "ZIP archive", main_file: false },
      ],
      provenance: { source: "native_resource_settings_form", private_draft_copy_prepared: true, form_submitted: false, root_folder_only: true },
    });
    assert.deepEqual(resourceFiles.targets, [
      { field: "course_id", label: "Course", name: "Week 1" },
      { field: "module_id", label: "Resource", name: "Evidence files" },
    ]);
    assert.ok(requests.includes("GET /course/modedit.php?update=58&return=0"));
    assert.equal(draftListIds.length, resourceDraftRequests + 1);
    assert.equal(JSON.stringify(resourceFiles.data).includes("9001"), false);
    assert.equal(requests.some((entry) => entry.startsWith("GET /mod/resource/view.php")), false);

    resourceListing = { ...resourceListing, tree: { children: [{ filepath: "/nested/", children: [] }] } };
    assert.deepEqual(await executeInBrowser(page, {
      mode: "execute",
      operation: resourceFilesReadOperation,
      arguments: { course_id: 2, module_id: 58 },
      binding,
      expiresAt: Date.now() + 60_000,
    }), { ok: false, sent: false, error: "moodle_resource_files_listing_refused" });
    assert.equal(draftListIds.length, resourceDraftRequests + 2);

    label.name = "";
    const blankLabelRead = await executeInBrowser(page, {
      mode: "execute",
      operation: labelReadOperation,
      arguments: { course_id: 2, module_id: 11 },
      binding,
      expiresAt: Date.now() + 60_000,
    });
    assert.equal(blankLabelRead.ok, true);
    assert.equal(blankLabelRead.data.name, "");
    const postsBeforeBlankLabel = posts.length;
    assert.deepEqual(await executeInBrowser(page, {
      mode: "execute",
      operation: labelWriteOperation,
      arguments: { course_id: 2, module_id: 11, content: "<p>Must not change a blank Label name.</p>", expected_digest: blankLabelRead.snapshot_digest },
      binding,
      expiresAt: Date.now() + 60_000,
    }), { ok: false, sent: false, error: "moodle_label_name_blank" });
    assert.equal(posts.length, postsBeforeBlankLabel);
    label.name = "Orientation text";

    const labelRead = await executeInBrowser(page, {
      mode: "execute",
      operation: labelReadOperation,
      arguments: { course_id: 2, module_id: 11 },
      binding,
      expiresAt: Date.now() + 60_000,
    });
    assert.equal(labelRead.ok, true);
    assert.deepEqual(labelRead.data, { course_id: 2, module_id: 11, name: "Orientation text", content: "<p>Original Label text</p>", content_format: 1 });
    assert.deepEqual(labelRead.targets, [
      { field: "course_id", label: "Course", name: "Week 1" },
      { field: "module_id", label: "Text and media area", name: "Orientation text" },
    ]);
    const labelGetsBeforeWrite = requests.filter((entry) => entry === "GET /course/modedit.php?update=11&return=0").length;
    const labelResult = await executeInBrowser(page, {
      mode: "execute",
      operation: labelWriteOperation,
      arguments: { course_id: 2, module_id: 11, content: "<p>Updated Label text</p>", expected_digest: labelRead.snapshot_digest },
      binding,
      expiresAt: Date.now() + 60_000,
    });
    assert.equal(labelResult.ok, true);
    assert.deepEqual(labelResult.verification, { schema: "morrow.browser-verification.v1", status: "verified" });
    assert.deepEqual(labelResult.data, { course_id: 2, module_id: 11, name: "Orientation text", content: "<p>Updated Label text</p>", content_format: 1 });
    assert.equal(requests.filter((entry) => entry === "GET /course/modedit.php?update=11&return=0").length, labelGetsBeforeWrite + 3);
    const labelPost = posts.at(-1);
    assert.equal(labelPost.get("introeditor[text]"), "<p>Updated Label text</p>");
    assert.equal(labelPost.get("name"), "Orientation text");
    assert.equal(labelPost.get("introeditor[format]"), "1");
    assert.match(labelPost.get("introeditor[itemid]") || "", /^[1-9][0-9]*$/);
    assert.equal(JSON.stringify(labelResult).includes(labelPost.get("introeditor[itemid]") || ""), false);
    assert.equal(labelPost.get("visible"), "1");
    assert.equal(labelPost.get("completion"), "2");
    assert.equal(labelPost.get("showdescription"), "1");
    assert.equal(labelPost.get("availability"), "label-availability");
    assert.equal(labelPost.get("tags"), "label-tag");
    assert.equal(labelPost.get("submitbutton"), null);
    assert.equal(labelPost.get("submitbutton2"), "Save changes and return to course");

    const labelEditorRead = await executeInBrowser(page, {
      mode: "execute",
      operation: labelReadOperation,
      arguments: { course_id: 2, module_id: 11 },
      binding,
      expiresAt: Date.now() + 60_000,
    });
    assert.equal(labelEditorRead.ok, true);
    const postCountBeforeLabelEditorFile = posts.length;
    editorFileAppearsAfterNextLabelDraftRead = true;
    assert.deepEqual(await executeInBrowser(page, {
      mode: "execute",
      operation: labelWriteOperation,
      arguments: { course_id: 2, module_id: 11, content: "<p>Must not replay Label editor draft.</p>", expected_digest: labelEditorRead.snapshot_digest },
      binding,
      expiresAt: Date.now() + 60_000,
    }), { ok: false, sent: false, error: "moodle_form_changed" });
    assert.equal(posts.length, postCountBeforeLabelEditorFile);
    draftFileCount = 0;

    const postCountBeforeUrlIdentity = posts.length;
    urlIdentityAltered = true;
    assert.deepEqual(await executeInBrowser(page, {
      mode: "execute",
      operation: urlReadOperation,
      arguments: { course_id: 2, module_id: 12 },
      binding,
      expiresAt: Date.now() + 60_000,
    }), { ok: false, sent: false, status: 200, error: "moodle_form_target_invalid" });
    assert.equal(posts.length, postCountBeforeUrlIdentity);

    const urlRead = await executeInBrowser(page, {
      mode: "execute",
      operation: urlReadOperation,
      arguments: { course_id: 2, module_id: 12 },
      binding,
      expiresAt: Date.now() + 60_000,
    });
    assert.equal(urlRead.ok, true);
    assert.deepEqual(urlRead.data, {
      course_id: 2,
      module_id: 12,
      name: "Course library",
      external_url: "https://library.example.test/original",
      description: "<p>Original URL description</p>",
      description_format: 1,
    });
    assert.deepEqual(urlRead.targets, [
      { field: "course_id", label: "Course", name: "Week 1" },
      { field: "module_id", label: "URL resource", name: "Course library" },
    ]);
    assert.equal(requests.some((entry) => entry.startsWith("GET /mod/url/view.php")), false);
    assert.equal(requests.some((entry) => entry.includes("library.example.test")), false);
    const urlGetsBeforeWrite = requests.filter((entry) => entry === "GET /course/modedit.php?update=12&return=0").length;
    const urlResult = await executeInBrowser(page, {
      mode: "execute",
      operation: urlWriteOperation,
      arguments: {
        course_id: 2,
        module_id: 12,
        name: "Research library",
        external_url: "library.example.test/evidence?course=2&amp;source=morrow",
        description: "<p>Updated URL description</p>",
        expected_digest: urlRead.snapshot_digest,
      },
      binding,
      expiresAt: Date.now() + 60_000,
    });
    assert.equal(urlResult.ok, true);
    assert.deepEqual(urlResult.verification, { schema: "morrow.browser-verification.v1", status: "verified" });
    assert.deepEqual(urlResult.data, {
      course_id: 2,
      module_id: 12,
      name: "Research library",
      external_url: "http://library.example.test/evidence?course=2&source=morrow",
      description: "<p>Updated URL description</p>",
      description_format: 1,
    });
    assert.equal(requests.filter((entry) => entry === "GET /course/modedit.php?update=12&return=0").length, urlGetsBeforeWrite + 3);
    const urlPost = posts.at(-1);
    assert.equal(urlPost.get("name"), "Research library");
    assert.equal(urlPost.get("externalurl"), "library.example.test/evidence?course=2&amp;source=morrow");
    assert.equal(urlPost.get("introeditor[text]"), "<p>Updated URL description</p>");
    assert.equal(urlPost.get("introeditor[format]"), "1");
    assert.match(urlPost.get("introeditor[itemid]") || "", /^[1-9][0-9]*$/);
    assert.equal(JSON.stringify(urlResult).includes(urlPost.get("introeditor[itemid]") || ""), false);
    assert.equal(urlPost.get("display"), "5");
    assert.equal(urlPost.get("popupwidth"), "900");
    assert.equal(urlPost.get("popupheight"), "600");
    assert.equal(urlPost.get("printintro"), "1");
    assert.equal(urlPost.get("parameter_0"), "utm_source");
    assert.equal(urlPost.get("variable_0"), "courseid");
    assert.equal(urlPost.get("parameter_1"), "utm_campaign");
    assert.equal(urlPost.get("variable_1"), "fullname");
    assert.equal(urlPost.get("visible"), "1");
    assert.equal(urlPost.get("completion"), "2");
    assert.equal(urlPost.get("showdescription"), "1");
    assert.equal(urlPost.get("availability"), "url-availability");
    assert.equal(urlPost.get("tags"), "url-tag");
    assert.equal(urlPost.get("submitbutton"), null);
    assert.equal(urlPost.get("submitbutton2"), "Save changes and return to course");

    const urlEditorRead = await executeInBrowser(page, {
      mode: "execute",
      operation: urlReadOperation,
      arguments: { course_id: 2, module_id: 12 },
      binding,
      expiresAt: Date.now() + 60_000,
    });
    assert.equal(urlEditorRead.ok, true);
    const postCountBeforeUrlEditorFile = posts.length;
    editorFileAppearsAfterNextUrlDraftRead = true;
    assert.deepEqual(await executeInBrowser(page, {
      mode: "execute",
      operation: urlWriteOperation,
      arguments: { course_id: 2, module_id: 12, description: "<p>Must not replay URL editor draft.</p>", expected_digest: urlEditorRead.snapshot_digest },
      binding,
      expiresAt: Date.now() + 60_000,
    }), { ok: false, sent: false, error: "moodle_form_changed" });
    assert.equal(posts.length, postCountBeforeUrlEditorFile);
    draftFileCount = 0;

    const labelCreation = await executeInBrowser(page, {
      mode: "execute",
      operation: labelCreateReadOperation,
      arguments: { course_id: 2, section_id: 7 },
      binding,
      expiresAt: Date.now() + 60_000,
    });
    assert.equal(labelCreation.ok, true, JSON.stringify(labelCreation));
    assert.deepEqual(labelCreation.data, { course_id: 2, section_id: 7, name: "", content: "", content_format: 1, visible: true });
    assert.deepEqual(labelCreation.targets, [
      { field: "course_id", label: "Course", name: "Week 1" },
      { field: "section_id", label: "Section", name: "Week 4: Evidence" },
    ]);
    const postsBeforeLabelCreationStale = posts.length;
    changeLabelCreationAfterNextFormRead = true;
    assert.deepEqual(await executeInBrowser(page, {
      mode: "execute",
      operation: labelCreateWriteOperation,
      arguments: { course_id: 2, section_id: 7, name: "Study reminder", content: "<p>Check the source before you answer.</p>", expected_digest: labelCreation.snapshot_digest },
      binding,
      expiresAt: Date.now() + 60_000,
    }), { ok: false, sent: false, error: "moodle_form_changed" });
    assert.equal(posts.length, postsBeforeLabelCreationStale);

    const refreshedLabelCreation = await executeInBrowser(page, {
      mode: "execute",
      operation: labelCreateReadOperation,
      arguments: { course_id: 2, section_id: 7 },
      binding,
      expiresAt: Date.now() + 60_000,
    });
    assert.equal(refreshedLabelCreation.ok, true, JSON.stringify(refreshedLabelCreation));
    const createdLabelResult = await executeInBrowser(page, {
      mode: "execute",
      operation: labelCreateWriteOperation,
      arguments: { course_id: 2, section_id: 7, name: "Study reminder", content: "<p>Check the source before you answer.</p>", expected_digest: refreshedLabelCreation.snapshot_digest },
      binding,
      expiresAt: Date.now() + 60_000,
    });
    assert.equal(createdLabelResult.ok, true, JSON.stringify(createdLabelResult));
    assert.deepEqual(createdLabelResult.verification, { schema: "morrow.browser-verification.v1", status: "verified" });
    assert.deepEqual(createdLabelResult.data, {
      course_id: 2,
      module_id: 60,
      name: "Study reminder",
      content: "<p>Check the source before you answer.</p>",
      content_format: 1,
      section_id: 7,
      visible: false,
    });
    assert.deepEqual(createdLabelResult.targets, refreshedLabelCreation.targets);
    const labelCreationPost = posts.at(-1);
    assert.equal(labelCreationPost.get("add"), "label");
    assert.equal(labelCreationPost.get("name"), "Study reminder");
    assert.equal(labelCreationPost.get("introeditor[text]"), "<p>Check the source before you answer.</p>");
    assert.equal(labelCreationPost.get("visible"), "0");
    assert.equal(labelCreationPost.get("coursecontentnotification"), null);
    assert.equal(labelCreationPost.get("submitbutton"), null);
    assert.equal(labelCreationPost.get("submitbutton2"), "Save changes and return to course");
    assert.ok(requests.includes("GET /course/modedit.php?add=label&course=2&sectionid=7&return=0"));
    assert.ok(requests.includes("GET /course/modedit.php?update=60&return=0"));

    const urlCreation = await executeInBrowser(page, {
      mode: "execute",
      operation: urlCreateReadOperation,
      arguments: { course_id: 2, section_id: 7 },
      binding,
      expiresAt: Date.now() + 60_000,
    });
    assert.equal(urlCreation.ok, true, JSON.stringify(urlCreation));
    assert.deepEqual(urlCreation.data, {
      course_id: 2,
      section_id: 7,
      name: "",
      external_url: "https://library.example.test/",
      description: "",
      description_format: 1,
      visible: true,
    });
    const postsBeforeUrlCreationStale = posts.length;
    changeUrlCreationAfterNextFormRead = true;
    assert.deepEqual(await executeInBrowser(page, {
      mode: "execute",
      operation: urlCreateWriteOperation,
      arguments: { course_id: 2, section_id: 7, name: "Reading list", external_url: "library.example.test/evidence", description: "<p>Open the reading list in a new tab.</p>", expected_digest: urlCreation.snapshot_digest },
      binding,
      expiresAt: Date.now() + 60_000,
    }), { ok: false, sent: false, error: "moodle_form_changed" });
    assert.equal(posts.length, postsBeforeUrlCreationStale);

    const refreshedUrlCreation = await executeInBrowser(page, {
      mode: "execute",
      operation: urlCreateReadOperation,
      arguments: { course_id: 2, section_id: 7 },
      binding,
      expiresAt: Date.now() + 60_000,
    });
    assert.equal(refreshedUrlCreation.ok, true, JSON.stringify(refreshedUrlCreation));
    const createdUrlResult = await executeInBrowser(page, {
      mode: "execute",
      operation: urlCreateWriteOperation,
      arguments: { course_id: 2, section_id: 7, name: "Reading list", external_url: "library.example.test/evidence", description: "<p>Open the reading list in a new tab.</p>", expected_digest: refreshedUrlCreation.snapshot_digest },
      binding,
      expiresAt: Date.now() + 60_000,
    });
    assert.equal(createdUrlResult.ok, true, JSON.stringify(createdUrlResult));
    assert.deepEqual(createdUrlResult.verification, { schema: "morrow.browser-verification.v1", status: "verified" });
    assert.deepEqual(createdUrlResult.data, {
      course_id: 2,
      module_id: 61,
      name: "Reading list",
      external_url: "http://library.example.test/evidence",
      description: "<p>Open the reading list in a new tab.</p>",
      description_format: 1,
      section_id: 7,
      visible: false,
    });
    assert.deepEqual(createdUrlResult.targets, refreshedUrlCreation.targets);
    const urlCreationPost = posts.at(-1);
    assert.equal(urlCreationPost.get("add"), "url");
    assert.equal(urlCreationPost.get("name"), "Reading list");
    assert.equal(urlCreationPost.get("externalurl"), "library.example.test/evidence");
    assert.equal(urlCreationPost.get("introeditor[text]"), "<p>Open the reading list in a new tab.</p>");
    assert.equal(urlCreationPost.get("visible"), "0");
    assert.equal(urlCreationPost.get("coursecontentnotification"), null);
    assert.equal(urlCreationPost.get("submitbutton"), "Save and display");
    assert.equal(urlCreationPost.get("submitbutton2"), null);
    assert.ok(requests.includes("GET /course/modedit.php?add=url&course=2&sectionid=7&return=0"));
    assert.ok(requests.includes("GET /course/modedit.php?update=61&return=0"));

    const quizQuestions = await executeInBrowser(page, {
      mode: "execute",
      operation: quizQuestionsReadOperation,
      arguments: { course_id: 2, module_id: 9 },
      binding,
      expiresAt: Date.now() + 60_000,
    });
    assert.equal(quizQuestions.ok, true);
    assert.deepEqual(quizQuestions.data.questions, [
      { slot_id: 17, position: 1, qtype: "multichoice", status: "not_exposed", version: { mode: "latest" }, question_id: 401, name: "Evidence check", max_mark: "1.00", inspectable: true },
      { slot_id: 18, position: 2, qtype: "random", status: "not_exposed", name: "Random evidence question", max_mark: null, inspectable: false, reason: "random_slot" },
      { slot_id: 19, position: 3, qtype: "truefalse", status: "not_exposed", version: { mode: "pinned", number: 2 }, question_id: 402, name: "Unsupported question", max_mark: "1.00", inspectable: true },
    ]);
    const quizQuestion = await executeInBrowser(page, {
      mode: "execute",
      operation: quizQuestionReadOperation,
      arguments: { course_id: 2, module_id: 9, slot_id: 17 },
      binding,
      expiresAt: Date.now() + 60_000,
    });
    assert.equal(quizQuestion.ok, true);
    assert.deepEqual(quizQuestion.data, {
      course_id: 2,
      module_id: 9,
      slot_id: 17,
      question_id: 401,
      version: { mode: "latest" },
      qtype: "multichoice",
      question_bank: { category_id: 42, context_id: 420, name: "Quiz question bank" },
      name: "Evidence check",
      question_text: "<p>Which claim has evidence?</p>",
      question_text_format: "1",
      status: "ready",
      default_mark: "1.00",
      general_feedback: "",
      general_feedback_format: "1",
      id_number: "evidence-1",
      tags: ["evidence-tag"],
      course_tags: ["course-evidence-tag"],
      details: {
        single: true,
        shuffle_answers: true,
        answer_numbering: "abc",
        show_standard_instruction: true,
        ...multipleChoiceDefaultData(),
        choices: [
          { text: "<p>Use the cited source.</p>", format: "1", fraction: "1.0", feedback: "<p>Correct.</p>", feedback_format: "1" },
          { text: "<p>Guess.</p>", format: "1", fraction: "0.0", feedback: "", feedback_format: "1" },
        ],
        choices_truncated: false,
      },
    });
    assert.ok(requests.includes("GET /mod/quiz/edit.php?cmid=9"));
    assert.ok(requests.includes("GET /question/bank/editquestion/question.php?id=401&cmid=9"));
    assert.ok(requests.includes("GET /question/bank/editquestion/question.php?id=401&cmid=9&makecopy=1"));
    assert.doesNotMatch(JSON.stringify(quizQuestion.data), /97[1-8]|draftfile\.php/);
    quizCopyCategoryValid = false;
    const categoryRefusal = await executeInBrowser(page, {
      mode: "execute", operation: quizQuestionReadOperation,
      arguments: { course_id: 2, module_id: 9, slot_id: 17 }, binding, expiresAt: Date.now() + 60_000,
    });
    assert.equal(categoryRefusal.error, "moodle_question_content_refused");
    quizCopyCategoryValid = true;
    const questionRequests = requests.filter((request) => request.startsWith("GET /question/bank/editquestion/question.php")).length;
    assert.deepEqual(await executeInBrowser(page, {
      mode: "execute",
      operation: quizQuestionReadOperation,
      arguments: { course_id: 2, module_id: 9, slot_id: 18 },
      binding,
      expiresAt: Date.now() + 60_000,
    }), { ok: false, sent: false, error: "moodle_quiz_random_slot_uninspectable" });
    assert.equal(requests.filter((request) => request.startsWith("GET /question/bank/editquestion/question.php")).length, questionRequests);
    quizEditNative = false;
    assert.deepEqual(await executeInBrowser(page, {
      mode: "execute",
      operation: quizQuestionsReadOperation,
      arguments: { course_id: 2, module_id: 9 },
      binding,
      expiresAt: Date.now() + 60_000,
    }), { ok: false, sent: false, status: 200, error: "moodle_quiz_questions_target_invalid" });
    quizEditNative = true;
    const questionPostsBeforeHeldCreate = quizQuestionPosts.length;
    const requestsBeforeHeldCreate = requests.length;
    assert.deepEqual(await executeInBrowser(page, {
      mode: "execute",
      operation: quizQuestionCreationWriteOperation,
      arguments: {
        course_id: 2,
        module_id: 9,
        name: "Must not enter the shared bank",
        question_text: "<p>The reviewed category has a random reference.</p>",
        default_mark: 2,
        answers: [
          { answer_text: "<p>Supported.</p>", correct_answer: true, feedback: "<p>Correct.</p>" },
          { answer_text: "<p>Unsupported.</p>", correct_answer: false, feedback: "<p>Incorrect.</p>" },
        ],
        expected_digest: "a".repeat(64),
      },
      binding,
      expiresAt: Date.now() + 60_000,
    }), { ok: false, sent: false, error: "moodle_question_bank_impact_unresolved" });
    assert.equal(quizQuestionPosts.length, questionPostsBeforeHeldCreate, "question-bank creation must not POST when the category has a random Quiz reference");
    assert.equal(requests.length, requestsBeforeHeldCreate, "question-bank creation must stop before the first native request");

    const run = (toolName, key, params) => executeInBrowser(page, { mode: "execute", operation: { toolName, key, provider: "moodle", readOnly: toolName === "moodle_get_contents" }, arguments: params, binding, expiresAt: Date.now() + 60_000 });
    const activity = (result) => result.data.activities.find((item) => item.id === 55);
    const hiddenActivity = (result) => result.data.activities.find((item) => item.id === 57);
    const setVisible = (show, digest) => run(`moodle_${show ? "show" : "hide"}_activity`, `moodle.ajax.core_courseformat_update_course.cm_${show ? "show" : "hide"}.v1`, { course_id: 2, module_id: 55, expected_digest: digest });
    let visibility = await setVisible(true, (await run("moodle_get_contents", "moodle.ajax.core_courseformat_get_state.v1", { course_id: 2 })).snapshot_digest);
    assert.equal(visibility.ok, true);
    assert.deepEqual([activity(visibility).name, activity(visibility).visible, activity(visibility).accessvisible, activity(visibility).hascmrestrictions, activity(visibility).stealth], ["Evidence notebook", true, true, false, true]);
    visibility = await setVisible(false, visibility.snapshot_digest);
    assert.equal(visibility.ok, true);
    assert.deepEqual([activity(visibility).name, activity(visibility).visible, activity(visibility).accessvisible, activity(visibility).hascmrestrictions, activity(visibility).stealth], ["Evidence notebook", false, false, false, false]);
    changeName = true;
    const renamed = await setVisible(true, visibility.snapshot_digest);
    assert.deepEqual([renamed.ok, renamed.sent, renamed.error, activity(renamed).name], [false, true, "moodle_write_not_verified", "Unexpected Page name"]);
    assert.deepEqual(visibilityActions, ["cm_show", "cm_hide", "cm_show"]);

    createdPage.name = "Evidence notebook";
    createdPage.visible = true;
    createdPage.visibleOld = true;
    sectionVisible = true;
    sectionHasRestrictions = true;
    const setSectionVisible = (show, digest) => run(`moodle_${show ? "show" : "hide"}_section`, `moodle.ajax.core_courseformat_update_course.section_${show ? "show" : "hide"}.v1`, { course_id: 2, section_id: 7, expected_digest: digest });
    let sectionVisibility = await setSectionVisible(false, (await run("moodle_get_contents", "moodle.ajax.core_courseformat_get_state.v1", { course_id: 2 })).snapshot_digest);
    assert.equal(sectionVisibility.ok, true);
    assert.deepEqual([activity(sectionVisibility).visible, hiddenActivity(sectionVisibility).visible], [false, false]);
    sectionVisibility = await setSectionVisible(true, sectionVisibility.snapshot_digest);
    assert.equal(sectionVisibility.ok, true);
    assert.deepEqual([activity(sectionVisibility).visible, hiddenActivity(sectionVisibility).visible], [true, false]);
    hiddenSectionActivity.visible = true;
    hiddenSectionActivity.visibleOld = true;
    hiddenSectionActivity.stealth = true;
    const criticalDigest = (await run("moodle_get_contents", "moodle.ajax.core_courseformat_get_state.v1", { course_id: 2 })).snapshot_digest;
    leaveHiddenActivityVisibleOnSectionHide = true;
    const sectionMismatch = await setSectionVisible(false, criticalDigest);
    assert.deepEqual([sectionMismatch.ok, sectionMismatch.sent, sectionMismatch.error, hiddenActivity(sectionMismatch).visible], [false, true, "moodle_write_not_verified", true]);
    assert.deepEqual(visibilityActions.slice(-3), ["section_hide", "section_show", "section_hide"]);

    await page.evaluate(() => {
      history.replaceState(null, "", "/mod/assign/view.php?id=8");
      document.querySelector("h1").textContent = "Evidence analysis";
      document.body.insertAdjacentHTML("beforeend", '<nav id="page-navbar"><ol class="breadcrumb"><li><a href="/course/view.php?id=2">Week 1</a></li></ol></nav>');
    });
    const assignmentRead = await executeInBrowser(page, {
      mode: "execute",
      operation: assignmentReadOperation,
      arguments: { course_id: 2, module_id: 8 },
      binding,
      expiresAt: Date.now() + 60_000,
    });
    const assignmentReadAgain = await executeInBrowser(page, {
      mode: "execute",
      operation: assignmentReadOperation,
      arguments: { course_id: 2, module_id: 8 },
      binding,
      expiresAt: Date.now() + 60_000,
    });
    assert.equal(assignmentRead.ok, true);
    assert.equal(assignmentReadAgain.ok, true);
    assert.equal(assignmentRead.targets[0].name, "Moodle course");
    assert.equal(assignmentRead.snapshot_digest, assignmentReadAgain.snapshot_digest);
    assert.deepEqual(assignmentRead.data.due_date, { year: 2026, month: 9, day: 5, hour: 9, minute: 30 });
    assert.notEqual(draftListIds[draftListIds.length - 2], draftListIds[draftListIds.length - 1]);

    const assignmentWrite = await executeInBrowser(page, {
      mode: "execute",
      operation: assignmentWriteOperation,
      arguments: { course_id: 2, module_id: 8, instructions: "<p>Approved brief</p>", due_date: null, expected_digest: assignmentRead.snapshot_digest },
      binding,
      expiresAt: Date.now() + 60_000,
    });
    assert.equal(assignmentWrite.ok, true);
    assert.deepEqual(assignmentWrite.verification, { schema: "morrow.browser-verification.v1", status: "verified" });
    assert.equal(assignmentWrite.data.due_date, null);
    assert.equal(assignmentPosts.length, 1);
    assert.equal(assignmentPosts[0].get("introeditor[text]"), "<p>Approved brief</p>");
    assert.match(assignmentPosts[0].get("introeditor[itemid]") || "", /^[1-9][0-9]*$/);
    assert.equal(assignmentPosts[0].get("duedate[enabled]"), null);

    const assignmentPreparation = await executeInBrowser(page, {
      mode: "execute",
      operation: assignmentCreateReadOperation,
      arguments: { course_id: 2, section_id: 7 },
      binding,
      expiresAt: Date.now() + 60_000,
    });
    assert.equal(assignmentPreparation.ok, true);
    assert.deepEqual(assignmentPreparation.data, {
      course_id: 2,
      section_id: 7,
      name: "",
      instructions: "",
      instructions_format: 1,
      visible: true,
      available_from: null,
      due_date: null,
      cutoff_at: null,
      grading_due_at: null,
    });
    assert.deepEqual(assignmentPreparation.targets, [
      { field: "course_id", label: "Course", name: "Moodle course" },
      { field: "section_id", label: "Section", name: "Week 4: Evidence" },
    ]);

    const createdAssignmentResult = await executeInBrowser(page, {
      mode: "execute",
      operation: assignmentCreateWriteOperation,
      arguments: {
        course_id: 2,
        section_id: 7,
        name: "Evidence practice",
        instructions: "<p>Read the evidence.</p>",
        available_from: null,
        due_date: null,
        cutoff_at: null,
        grading_due_at: null,
        expected_digest: assignmentPreparation.snapshot_digest,
      },
      binding,
      expiresAt: Date.now() + 60_000,
    });
    assert.equal(createdAssignmentResult.ok, true);
    assert.deepEqual(createdAssignmentResult.verification, { schema: "morrow.browser-verification.v1", status: "verified" });
    const createdAssignmentFields = ["course_id", "module_id", "name", "instructions", "instructions_format", "available_from", "due_date", "cutoff_at", "grading_due_at", "section_id", "visible"];
    assert.deepEqual(Object.fromEntries(createdAssignmentFields.map((field) => [field, createdAssignmentResult.data[field]])), {
      course_id: 2,
      module_id: 56,
      name: "Evidence practice",
      instructions: "<p>Read the evidence.</p>",
      instructions_format: 1,
      available_from: null,
      due_date: null,
      cutoff_at: null,
      grading_due_at: null,
      section_id: 7,
      visible: false,
    });
    assert.deepEqual(
      [createdAssignmentResult.data.online_text, createdAssignmentResult.data.file_submissions, createdAssignmentResult.data.grade, createdAssignmentResult.data.grade_category, createdAssignmentResult.data.submissions_or_grades_exist],
      [false, true, { type: "point", maximum_points: 100 }, "3", false],
    );
    assert.deepEqual(createdAssignmentResult.targets, assignmentPreparation.targets);
    assert.equal(assignmentCreationPosts.length, 1);
    const assignmentCreationPost = assignmentCreationPosts[0];
    assert.equal(assignmentCreationPost.get("course"), "2");
    assert.equal(assignmentCreationPost.get("add"), "assign");
    assert.equal(assignmentCreationPost.get("modulename"), "assign");
    assert.equal(assignmentCreationPost.get("section"), "4");
    assert.equal(assignmentCreationPost.get("name"), "Evidence practice");
    assert.equal(assignmentCreationPost.get("introeditor[text]"), "<p>Read the evidence.</p>");
    assert.equal(assignmentCreationPost.get("visible"), "0");
    assert.equal(assignmentCreationPost.get("coursecontentnotification"), null);
    assert.equal(assignmentCreationPost.get("gradepass"), "");
    for (const field of ["allowsubmissionsfromdate", "duedate", "cutoffdate", "gradingduedate"]) {
      assert.equal(assignmentCreationPost.get(`${field}[enabled]`), null);
    }
    assert.ok(requests.includes("GET /course/modedit.php?add=assign&course=2&sectionid=7&return=0"));
    assert.ok(requests.includes("GET /course/modedit.php?update=56&return=0"));

    const call = (operation, params) => executeInBrowser(page, { mode: "execute", operation, arguments: params, binding, expiresAt: Date.now() + 60_000 });
    const readAssignment = () => call(assignmentReadOperation, { course_id: 2, module_id: 8 });
    const writeAssignment = (params, digest) => call(assignmentWriteOperation, { course_id: 2, module_id: 8, ...params, expected_digest: digest });

    const settingsRead = await readAssignment();
    assert.equal(settingsRead.ok, true, JSON.stringify(settingsRead));
    assert.deepEqual(settingsRead.data.grade, { type: "point", maximum_points: 100 });
    assert.deepEqual(
      [settingsRead.data.always_show_description, settingsRead.data.online_text, settingsRead.data.online_text_word_limit, settingsRead.data.file_submissions, settingsRead.data.maximum_files, settingsRead.data.blind_marking, settingsRead.data.submissions_or_grades_exist],
      [true, false, null, true, "20", false, false],
    );
    assert.deepEqual(settingsRead.data.available_maximum_files, ["1", "2", "20"]);
    assert.deepEqual(settingsRead.data.available_grade_scales, ["1", "2"]);

    const settingGroups = [
      {
        label: "availability",
        arguments: {
          available_from: { year: 2026, month: 9, day: 1, hour: 8, minute: 0 },
          due_date: { year: 2026, month: 9, day: 10, hour: 17, minute: 0 },
          cutoff_at: { year: 2026, month: 9, day: 11, hour: 17, minute: 0 },
          grading_due_at: { year: 2026, month: 9, day: 12, hour: 17, minute: 0 },
          always_show_description: false,
        },
      },
      { label: "submission types", arguments: { online_text: true, online_text_word_limit: 500, file_submissions: true, maximum_files: "2", maximum_submission_size: "2097152", accepted_file_types: ".pdf,.docx" } },
      { label: "feedback types", arguments: { feedback_comments: true, comment_inline: true, feedback_files: true, offline_grading_worksheet: true, annotate_pdf: true } },
      { label: "submission settings", arguments: { require_click_submit: true, require_submission_statement: true, additional_attempts: "manual", maximum_attempts: "3" } },
      { label: "group submission", arguments: { group_submission: true, require_group_membership: true, require_all_members_submit: true, grouping_id: "5" } },
      { label: "notifications", arguments: { notify_graders: true, notify_graders_late: true, notify_students_default: false } },
      { label: "grade", arguments: { grade: { type: "scale", scale: "1" }, grade_category: "4" } },
      { label: "marking", arguments: { marking_workflow: true, blind_marking: true } },
    ];
    let settingsDigest = settingsRead.snapshot_digest;
    for (const group of settingGroups) {
      const priorPosts = assignmentPosts.length;
      const saved = await writeAssignment(group.arguments, settingsDigest);
      assert.equal(saved.ok, true, `${group.label}: ${JSON.stringify(saved)}`);
      assert.deepEqual(saved.verification, { schema: "morrow.browser-verification.v1", status: "verified" }, group.label);
      assert.equal(assignmentPosts.length, priorPosts + 1, group.label);
      for (const [argument, value] of Object.entries(group.arguments)) assert.deepEqual(saved.data[argument], value, `${group.label}.${argument}`);
      assert.equal(saved.data.name, "Evidence analysis", group.label);
      assert.equal(saved.data.instructions, "<p>Approved brief</p>", group.label);
      assert.equal(assignmentPosts[assignmentPosts.length - 1].get("gradepass"), "0.00", group.label);
      settingsDigest = saved.snapshot_digest;
    }
    assert.equal(assignment.gradePass, "0.00");
    assert.equal(assignment.settings["grade[modgrade_point]"], "100");
    assert.deepEqual(assignment.dates.duedate, { year: 2026, month: 9, day: 10, hour: 17, minute: 0 });

    const postsAfterGroups = assignmentPosts.length;
    const refusedValue = await writeAssignment({ maximum_attempts: "99" }, settingsDigest);
    assert.deepEqual([refusedValue.ok, refusedValue.sent, refusedValue.error], [false, false, "moodle_assignment_native_setting_refused"]);

    assignment.missingControls = ["assignfeedback_editpdf_enabled"];
    const missingControlRead = await readAssignment();
    assert.equal(missingControlRead.data.annotate_pdf, null);
    assert.equal(missingControlRead.data.feedback_comments, true);
    const missingControlWrite = await writeAssignment({ annotate_pdf: true }, missingControlRead.snapshot_digest);
    assert.deepEqual([missingControlWrite.ok, missingControlWrite.sent, missingControlWrite.error], [false, false, "moodle_assignment_native_setting_refused"]);
    assignment.missingControls = [];

    assignment.submissionsExist = true;
    const frozenRead = await readAssignment();
    assert.equal(frozenRead.data.submissions_or_grades_exist, true);
    assert.equal(frozenRead.data.blind_marking, true);
    for (const refusedArguments of [{ blind_marking: false }, { marking_workflow: false }, { blind_marking: false, notify_graders: false }]) {
      const refused = await writeAssignment(refusedArguments, frozenRead.snapshot_digest);
      assert.deepEqual([refused.ok, refused.sent, refused.error], [false, false, "moodle_assignment_submissions_exist"], JSON.stringify(refusedArguments));
    }
    assert.equal(assignmentPosts.length, postsAfterGroups);
    const stillWritable = await writeAssignment({ notify_graders: false }, frozenRead.snapshot_digest);
    assert.equal(stillWritable.ok, true, JSON.stringify(stillWritable));
    assert.equal(stillWritable.data.blind_marking, true);
    assert.equal(assignmentPosts.length, postsAfterGroups + 1);

    const overridesRead = await call(assignmentOverridesReadOperation, { course_id: 2, module_id: 8 });
    assert.equal(overridesRead.ok, true, JSON.stringify(overridesRead));
    assert.deepEqual(overridesRead.data, {
      course_id: 2,
      module_id: 8,
      overrides: [
        { override_id: 41, scope: "user", available_from: null, due_date: { year: 2026, month: 9, day: 12, hour: 17, minute: 0 }, cutoff_at: null },
        { override_id: 42, scope: "group", group_id: 5, group_name: "Section A", available_from: null, due_date: { year: 2026, month: 9, day: 14, hour: 9, minute: 0 }, cutoff_at: null },
      ],
      user_override_count: 1,
      group_override_count: 1,
      complete: true,
    });
    assert.deepEqual(overridesRead.targets, [
      { field: "course_id", label: "Course", name: "Moodle course" },
      { field: "module_id", label: "Assignment", name: "Evidence analysis" },
    ]);
    assert.equal(JSON.stringify(overridesRead).includes("Robin Fields"), false);
    assert.ok(requests.includes("GET /mod/assign/overrides.php?cmid=8&mode=user"));
    assert.ok(requests.includes("GET /mod/assign/overrides.php?cmid=8&mode=group"));

    const createdOverride = await call(assignmentOverrideCreateOperation, {
      course_id: 2,
      module_id: 8,
      user_id: 10,
      available_from: null,
      due_date: { year: 2026, month: 9, day: 20, hour: 12, minute: 0 },
      cutoff_at: { year: 2026, month: 9, day: 21, hour: 12, minute: 0 },
      expected_digest: overridesRead.snapshot_digest,
    });
    assert.equal(createdOverride.ok, true, JSON.stringify(createdOverride));
    assert.deepEqual(createdOverride.verification, { schema: "morrow.browser-verification.v1", status: "verified" });
    assert.equal(createdOverride.data.override_id, 43);
    assert.deepEqual(createdOverride.data.overrides.map((entry) => entry.override_id), [41, 43, 42]);
    assert.deepEqual(createdOverride.data.overrides[1], {
      override_id: 43, scope: "user", available_from: null,
      due_date: { year: 2026, month: 9, day: 20, hour: 12, minute: 0 },
      cutoff_at: { year: 2026, month: 9, day: 21, hour: 12, minute: 0 },
    });
    assert.deepEqual([createdOverride.data.user_override_count, createdOverride.data.group_override_count, createdOverride.data.complete], [2, 1, true]);
    assert.deepEqual(createdOverride.data.overrides[0], overridesRead.data.overrides[0]);
    assert.deepEqual(createdOverride.data.overrides[2], overridesRead.data.overrides[1]);
    assert.deepEqual(createdOverride.targets, [
      { field: "course_id", label: "Course", name: "Moodle course" },
      { field: "module_id", label: "Assignment", name: "Evidence analysis" },
      { field: "user_id", label: "User override", name: "One Moodle user" },
    ]);
    assert.equal(JSON.stringify(createdOverride).includes("Sam Ortega"), false);
    assert.deepEqual(createdOverride.data.overrides.flatMap((entry) => Object.keys(entry)).filter((key) => /user/i.test(key)), []);
    assert.equal(overridePosts.length, 1);
    assert.equal(overridePosts[0].get("userid"), "10");
    assert.equal(overridePosts[0].get("duedate[day]"), "20");
    assert.equal(overridePosts[0].get("allowsubmissionsfromdate[enabled]"), null);

    const updatedOverride = await call(assignmentOverrideWriteOperation, {
      course_id: 2,
      module_id: 8,
      override_id: 42,
      group_id: 5,
      available_from: null,
      due_date: { year: 2026, month: 9, day: 16, hour: 9, minute: 0 },
      cutoff_at: null,
      expected_digest: createdOverride.snapshot_digest,
    });
    assert.equal(updatedOverride.ok, true, JSON.stringify(updatedOverride));
    assert.deepEqual(updatedOverride.verification, { schema: "morrow.browser-verification.v1", status: "verified" });
    assert.equal(updatedOverride.data.override_id, 42);
    assert.deepEqual(updatedOverride.data.overrides[2], {
      override_id: 42, scope: "group", group_id: 5, group_name: "Section A",
      available_from: null, due_date: { year: 2026, month: 9, day: 16, hour: 9, minute: 0 }, cutoff_at: null,
    });
    assert.deepEqual(updatedOverride.data.overrides.slice(0, 2), createdOverride.data.overrides.slice(0, 2));
    assert.deepEqual([updatedOverride.data.user_override_count, updatedOverride.data.group_override_count], [2, 1]);
    assert.equal(overridePosts.length, 2);
    assert.equal(overridePosts[1].get("groupid"), "5");
    assert.equal(overridePosts[1].get("id"), "42");

    const overrideRefusals = [
      { params: { override_id: 42, group_id: 6 }, error: "moodle_assignment_override_target_mismatch" },
      { params: { override_id: 42, user_id: 9 }, error: "moodle_assignment_override_not_found" },
      { params: { override_id: 99, group_id: 5 }, error: "moodle_assignment_override_not_found" },
    ];
    for (const refusal of overrideRefusals) {
      const refused = await call(assignmentOverrideWriteOperation, {
        course_id: 2, module_id: 8, ...refusal.params,
        available_from: null, due_date: { year: 2026, month: 9, day: 18, hour: 9, minute: 0 }, cutoff_at: null,
        expected_digest: updatedOverride.snapshot_digest,
      });
      assert.deepEqual([refused.ok, refused.sent, refused.error], [false, false, refusal.error], JSON.stringify(refusal.params));
    }
    const staleOverride = await call(assignmentOverrideCreateOperation, {
      course_id: 2, module_id: 8, group_id: 6,
      available_from: null, due_date: { year: 2026, month: 9, day: 22, hour: 9, minute: 0 }, cutoff_at: null,
      expected_digest: overridesRead.snapshot_digest,
    });
    assert.deepEqual([staleOverride.ok, staleOverride.sent, staleOverride.error], [false, false, "moodle_expected_digest_mismatch"]);
    assert.equal(overridePosts.length, 2);

    for (let index = 0; index < 25; index += 1) {
      assignmentOverrides.push({
        id: 200 + index, scope: "group", groupId: "6", groupName: "Section B",
        dates: { allowsubmissionsfromdate: null, duedate: { year: 2026, month: 10, day: 1, hour: 9, minute: 0 }, cutoffdate: null },
      });
    }
    const crowdedOverrides = await call(assignmentOverridesReadOperation, { course_id: 2, module_id: 8 });
    assert.equal(crowdedOverrides.ok, true, JSON.stringify(crowdedOverrides));
    assert.deepEqual(
      [crowdedOverrides.data.complete, crowdedOverrides.data.overrides, crowdedOverrides.data.user_override_count, crowdedOverrides.data.group_override_count],
      [false, [], 2, 26],
    );
    const crowdedWrite = await call(assignmentOverrideCreateOperation, {
      course_id: 2, module_id: 8, group_id: 6,
      available_from: null, due_date: { year: 2026, month: 10, day: 2, hour: 9, minute: 0 }, cutoff_at: null,
      expected_digest: crowdedOverrides.snapshot_digest,
    });
    assert.deepEqual([crowdedWrite.ok, crowdedWrite.sent, crowdedWrite.error], [false, false, "moodle_assignment_overrides_incomplete"]);
    assert.equal(overridePosts.length, 2);
    assignmentOverrides.length = 3;

    moveFixture = true;
    moveActivitySection = 7;
    moveUnexpected = false;
    moveUnexpectedAfter = false;
    const moveActivity = (digest) => run("moodle_move_activity", "moodle.ajax.core_courseformat_update_course.cm_move.v1", {
      course_id: 2, module_id: 59, target_section_id: 8, expected_digest: digest,
    });
    const moveRead = await run("moodle_get_contents", "moodle.ajax.core_courseformat_get_state.v1", { course_id: 2 });
    const moved = await moveActivity(moveRead.snapshot_digest);
    assert.equal(moved.ok, true);
    assert.deepEqual(moved.verification, { schema: "morrow.browser-verification.v1", status: "verified" });
    assert.deepEqual([moved.data.activities.find((entry) => entry.id === 59).sectionid, moved.data.sections.find((entry) => entry.id === "7").cmlist, moved.data.sections.find((entry) => entry.id === "8").cmlist], ["8", [], ["60", "59"]]);
    assert.deepEqual(moved.targets, [
      { field: "course_id", label: "Course", name: "Week 1" },
      { field: "module_id", label: "Activity", name: "Evidence notebook" },
      { field: "target_section_id", label: "Destination section", name: "Week 5: Synthesis" },
    ]);
    moveActivitySection = 7;
    moveUnexpected = false;
    moveUnexpectedAfter = true;
    const moveMismatch = await moveActivity((await run("moodle_get_contents", "moodle.ajax.core_courseformat_get_state.v1", { course_id: 2 })).snapshot_digest);
    assert.deepEqual([moveMismatch.ok, moveMismatch.sent, moveMismatch.error], [false, true, "moodle_write_not_verified"]);
    assert.deepEqual(moveActions.map(({ action, courseid, ids, targetsectionid, targetcmid }) => ({ action, courseid, ids, targetsectionid, targetcmid })), [
      { action: "cm_move", courseid: 2, ids: [59], targetsectionid: 8, targetcmid: null },
      { action: "cm_move", courseid: 2, ids: [59], targetsectionid: 8, targetcmid: null },
    ]);

    moveUnexpected = false;
    moveUnexpectedAfter = false;
    for (const [module, format] of [["label", "topics"], ["url", "weeks"]]) {
      moveActivityModule = module;
      moveCourseFormat = format;
      moveActivitySection = 7;
      const initial = await run("moodle_get_contents", "moodle.ajax.core_courseformat_get_state.v1", { course_id: 2 });
      const actionCount = moveActions.length;
      const result = await moveActivity(initial.snapshot_digest);
      assert.deepEqual([result.ok, result.verification?.status, moveActions.length - actionCount], [true, "verified", 1]);
      assert.equal(result.data.activities.find((entry) => entry.id === 59).module, module);
      assert.deepEqual(result.data.sections.map((entry) => entry.cmlist), [[], ["60", "59"]]);
      const replay = await moveActivity(initial.snapshot_digest);
      assert.deepEqual([replay.ok, replay.sent, moveActions.length - actionCount], [false, false, 1]);
    }

    moveActivitySection = 7;
    const allowedMoveActions = moveActions.length;
    moveCourseFormat = "custom_format";
    let initial = await run("moodle_get_contents", "moodle.ajax.core_courseformat_get_state.v1", { course_id: 2 });
    assert.deepEqual(await moveActivity(initial.snapshot_digest), { ok: false, sent: false, error: "moodle_move_course_format_unverified" });
    moveCourseFormat = "topics";
    initial = await run("moodle_get_contents", "moodle.ajax.core_courseformat_get_state.v1", { course_id: 2 });
    moveCourseFormatAfterState = "custom_format";
    assert.deepEqual(await moveActivity(initial.snapshot_digest), { ok: false, sent: false, error: "moodle_move_course_format_changed" });
    assert.equal(moveActions.length, allowedMoveActions);
    moveCourseFormat = "topics";
    // An activity that says it delegates a section that no section in this
    // state matches is a pairing Morrow cannot read, and a restricted activity
    // is outside the move contract. Both refuse before anything is sent.
    for (const [delegated, restricted, error] of [
      [true, false, "moodle_delegated_membership_incomplete"],
      [false, true, "moodle_move_precondition_refused"],
    ]) {
      moveActivityDelegated = delegated;
      moveActivityRestricted = restricted;
      initial = await run("moodle_get_contents", "moodle.ajax.core_courseformat_get_state.v1", { course_id: 2 });
      const refused = await moveActivity(initial.snapshot_digest);
      assert.deepEqual([refused.ok, refused.sent, refused.error], [false, false, error]);
    }
    assert.equal(moveActions.length, allowedMoveActions);
    moveActivityDelegated = false;
    moveActivityRestricted = false;
    moveCourseFormatAfter = "weeks";
    initial = await run("moodle_get_contents", "moodle.ajax.core_courseformat_get_state.v1", { course_id: 2 });
    const changedFormat = await moveActivity(initial.snapshot_digest);
    assert.deepEqual([changedFormat.ok, changedFormat.sent, changedFormat.verification?.status, moveActions.length - allowedMoveActions], [false, true, "mismatch", 1]);
    moveCourseFormatAfter = "";
    moveActivitySection = 7;
    moveCourseFormat = "topics";
    moveCourseFormUnavailableAfter = true;
    initial = await run("moodle_get_contents", "moodle.ajax.core_courseformat_get_state.v1", { course_id: 2 });
    const unreadFormat = await moveActivity(initial.snapshot_digest);
    assert.deepEqual([unreadFormat.ok, unreadFormat.sent, unreadFormat.outcomeUnknown, unreadFormat.verification?.status, moveActions.length - allowedMoveActions], [false, true, true, "unconfirmed", 2]);
    moveCourseFormUnavailable = false;
    moveCourseFormUnavailableAfter = false;

    draftFileCount = 1;
    const postsBeforeBlockedAssignment = assignmentPosts.length;
    const nonemptyAssignment = await executeInBrowser(page, {
      mode: "execute",
      operation: assignmentReadOperation,
      arguments: { course_id: 2, module_id: 8 },
      binding,
      expiresAt: Date.now() + 60_000,
    });
    assert.equal(nonemptyAssignment.ok, true);
    assert.deepEqual(await executeInBrowser(page, {
      mode: "execute",
      operation: assignmentWriteOperation,
      arguments: { course_id: 2, module_id: 8, instructions: "<p>Blocked brief</p>", expected_digest: nonemptyAssignment.snapshot_digest },
      binding,
      expiresAt: Date.now() + 60_000,
    }), { ok: false, sent: false, error: "moodle_filemanager_nonempty" });
    assert.equal(assignmentPosts.length, postsBeforeBlockedAssignment);

    draftFileCount = 0;
    nativeFormSesskey = "synthetic-session";
    const editorFileRead = await executeInBrowser(page, {
      mode: "execute",
      operation: pageReadOperation,
      arguments: { course_id: 2, module_id: 6 },
      binding,
      expiresAt: Date.now() + 60_000,
    });
    assert.equal(editorFileRead.ok, true);
    const postCountBeforeEditorFile = posts.length;
    editorFileAppearsAfterNextPageDraftRead = true;
    assert.deepEqual(await executeInBrowser(page, {
      mode: "execute",
      operation: pageWriteOperation,
      arguments: { course_id: 2, module_id: 6, content: "<p>Must not replay editor draft.</p>", expected_digest: editorFileRead.snapshot_digest },
      binding,
      expiresAt: Date.now() + 60_000,
    }), { ok: false, sent: false, error: "moodle_form_changed" });
    assert.equal(posts.length, postCountBeforeEditorFile);
    draftFileCount = 0;

    const externallyChangedRead = await executeInBrowser(page, {
      mode: "execute",
      operation: pageReadOperation,
      arguments: { course_id: 2, module_id: 6 },
      binding,
      expiresAt: Date.now() + 60_000,
    });
    assert.equal(externallyChangedRead.ok, true);
    const postCountBeforeExternalChange = posts.length;
    changePageAfterNextFormRead = true;
    assert.deepEqual(await executeInBrowser(page, {
      mode: "execute",
      operation: pageWriteOperation,
      arguments: { course_id: 2, module_id: 6, content: "<p>Must not overwrite external edit.</p>", expected_digest: externallyChangedRead.snapshot_digest },
      binding,
      expiresAt: Date.now() + 60_000,
    }), { ok: false, sent: false, error: "moodle_form_changed" });
    assert.equal(posts.length, postCountBeforeExternalChange);
    assert.equal(state.content, "<p>External edit</p>");

    const sessionBoundRead = await executeInBrowser(page, {
      mode: "execute",
      operation: pageReadOperation,
      arguments: { course_id: 2, module_id: 6 },
      binding,
      expiresAt: Date.now() + 60_000,
    });
    assert.equal(sessionBoundRead.ok, true);
    const postCount = posts.length;
    switchNativeSessionAfterNextPageRead = true;
    assert.deepEqual(await executeInBrowser(page, {
      mode: "execute",
      operation: pageWriteOperation,
      arguments: { course_id: 2, module_id: 6, content: "<p>Must not send.</p>", expected_digest: sessionBoundRead.snapshot_digest },
      binding,
      expiresAt: Date.now() + 60_000,
    }), { ok: false, sent: false, status: 200, error: "moodle_form_session_mismatch" });
    assert.equal(posts.length, postCount);
    assert.deepEqual(await executeInBrowser(page, {
      mode: "execute",
      operation: pageReadOperation,
      arguments: { course_id: 2, module_id: 6 },
      binding,
      expiresAt: Date.now() + 60_000,
    }), { ok: false, sent: false, status: 200, error: "moodle_form_session_mismatch" });
  } finally {
    await context?.close();
    await browser?.close();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Moodle executor reads supported Quiz question forms and holds Question bank writes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-question-authoring-"));
  const key = join(directory, "key.pem");
  const certificate = join(directory, "certificate.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", certificate], { stdio: "ignore" });
  const qtypes = ["truefalse", "shortanswer", "numerical", "essay", "match", "description", "gapselect", "ddwtos", "multianswer", "ordering", "randomsamatch", "ddimageortext", "ddmarker", "calculated", "calculatedmulti", "calculatedsimple"];
  const questions = [];
  const posts = [];
  const requests = [];
  let nonemptyQuestionFileAreas = false;
  const draftListings = [];
  const backgroundImages = new Map([
    ["4001", { filename: "campus-map.png", filepath: "/", type: "file", size: 20480, sortorder: 1, mimetype: "Image (PNG)" }],
    ["4002", { filename: "cell-diagram.jpg", filepath: "/", type: "file", size: 30720, sortorder: 1, mimetype: "Image (JPEG)" }],
  ]);
  let multianswerInteractivePenalty = "0.3333333";
  let changeMultianswerInteractiveAfterNextFormRead = false;
  let nextQuestionId = 500;
  let nextSlotId = 30;
  const questionFor = (qtype, values = {}) => ({ id: values.id || nextQuestionId++, slotId: values.slotId || nextSlotId++, qtype,
    name: values.name || `${qtype} question`, questionText: values.questionText || "<p>Original prompt.</p>", defaultMark: values.defaultMark ?? (qtype === "description" ? "0" : "1"), generalFeedback: values.generalFeedback || "<p>General feedback.</p>", idNumber: values.idNumber || `${qtype}-id`, tags: values.tags || ["authoring-tag"], courseTags: values.courseTags || ["course-authoring-tag"],
    correctAnswer: values.correctAnswer || false, trueFeedback: values.trueFeedback || "<p>True feedback.</p>", falseFeedback: values.falseFeedback || "<p>False feedback.</p>", caseSensitive: values.caseSensitive || false, answers: values.answers || [], responseTemplate: values.responseTemplate || "<p>Response template.</p>", graderInfo: values.graderInfo || "<p>Grader information.</p>", pairs: values.pairs || [], distractors: values.distractors || [], choices: values.choices || [], orderingItems: values.orderingItems || [], randomChoose: values.randomChoose || 2, includeSubcategories: values.includeSubcategories !== false, shuffleAnswers: values.shuffleAnswers !== false, multianswerPenalty: values.multianswerPenalty || multianswerInteractivePenalty,
    backgroundDraftId: values.backgroundDraftId || "4001", dropZoneVisibility: values.dropZoneVisibility || "0", showMisplaced: values.showMisplaced === true, dragItems: values.dragItems || [], markers: values.markers || [], dropZones: values.dropZones || [],
    calculatedAnswers: values.calculatedAnswers || [], calculatedUnits: values.calculatedUnits || [], calculatedHint: values.calculatedHint || "", unitRole: values.unitRole || "0", unitsLeft: values.unitsLeft === true,
    synchronize: values.synchronize || "0", single: values.single === true, datasetDefinitions: values.datasetDefinitions || [], datasetValueSets: values.datasetValueSets || 0,
    unsavedValueSet: values.unsavedValueSet === true, midWizard: values.midWizard === true, wizardPage: values.wizardPage || "datasetdefinitions",
  });
  questions.push(
    questionFor("truefalse"),
    questionFor("shortanswer", { answers: [{ text: "source", fraction: "1.0", feedback: "<p>Correct.</p>" }] }),
    questionFor("numerical", { answers: [{ text: "4", fraction: "1.0", tolerance: "0", feedback: "<p>Correct.</p>" }] }),
    questionFor("essay"),
    questionFor("match", { pairs: [{ questionText: "<p>Claim</p>", answerText: "Evidence" }, { questionText: "<p>Method</p>", answerText: "Citation" }], distractors: ["Opinion"] }),
    questionFor("description", { defaultMark: "0" }),
    questionFor("gapselect", { questionText: "<p>[[1]] supports [[2]].</p>", choices: [{ text: "Evidence", group: 1 }, { text: "Claim", group: 2 }] }),
    questionFor("ddwtos", { questionText: "<p>[[1]] and [[1]] support [[2]].</p>", choices: [{ text: "Evidence", group: 1, unlimited: true }, { text: "Claim", group: 2, unlimited: false }] }),
    questionFor("multianswer", { questionText: "<p>Use {2:SHORTANSWER:=evidence}.</p>" }),
    questionFor("ordering", { name: "Order the evidence", orderingItems: ["Find the source", "Cite the source"] }),
    questionFor("randomsamatch", { name: "Match a random answer", randomChoose: 3, includeSubcategories: false }),
    questionFor("ddimageortext", {
      name: "Place the evidence on the map", questionText: "<p>Drag each label onto the matching building.</p>", dropZoneVisibility: "1",
      dragItems: [{ contentType: "word", label: "Library", group: 1, unlimited: false }, { contentType: "image", label: "Laboratory", group: 2, unlimited: true }],
      dropZones: [
        { xLeft: "40", yTop: "120", dragItem: 1, label: "North wing" },
        { xLeft: "180", yTop: "260", dragItem: 2, label: "South wing" },
        { xLeft: "", yTop: "", dragItem: 0, label: "" },
      ],
    }),
    questionFor("ddmarker", {
      name: "Mark the cell structures", questionText: "<p>Place each marker on the matching structure.</p>", backgroundDraftId: "4002", showMisplaced: true, shuffleAnswers: false,
      markers: [{ label: "Nucleus", maxDrags: 1 }, { label: "Membrane", maxDrags: 0 }],
      dropZones: [
        { shape: "circle", marker: 1, coordinates: "120,140;35" },
        { shape: "rectangle", marker: 2, coordinates: "10,10;60,40" },
        { shape: "circle", marker: 0, coordinates: "" },
      ],
    }),
    questionFor("calculated", {
      name: "Calculate the resistance", questionText: "<p>What is {a} divided by {b}?</p>", synchronize: "1", unitRole: "3", calculatedHint: "<p>Divide the first wildcard by the second.</p>",
      calculatedAnswers: [{ formula: "{a}/{b}", fraction: "1.0", tolerance: "0.01", toleranceType: "2", answerLength: "3", answerFormat: "1", feedback: "<p>Correct.</p>" }],
      calculatedUnits: [{ unit: "ohm", multiplier: "1.0" }, { unit: "kohm", multiplier: "0.001" }],
    }),
    questionFor("calculatedmulti", {
      name: "Choose the computed value", questionText: "<p>Which value equals {x} times {y}?</p>", single: true, shuffleAnswers: false,
      calculatedAnswers: [
        { formula: "<p>{x}*{y}</p>", fraction: "1.0", tolerance: "0.01", toleranceType: "1", answerLength: "2", answerFormat: "1", feedback: "<p>Correct.</p>" },
        { formula: "<p>{x}+{y}</p>", fraction: "0.0", tolerance: "0.01", toleranceType: "1", answerLength: "2", answerFormat: "1", feedback: "<p>That is the sum.</p>" },
      ],
    }),
    questionFor("calculatedsimple", {
      name: "Add the two wildcards", questionText: "<p>Add {p} and {q}.</p>", calculatedHint: "<p>Add the two values.</p>",
      calculatedAnswers: [{ formula: "{p}+{q}", fraction: "1.0", tolerance: "0.05", toleranceType: "1", answerLength: "1", answerFormat: "2", feedback: "<p>Correct.</p>" }],
      datasetDefinitions: [{ key: "1-0-p", name: "p" }, { key: "1-420-q", name: "q" }], datasetValueSets: 3,
    }),
  );
  const calculatedFormula = [{ formula: "{a}/{b}", fraction: "1.0", tolerance: "0.01", toleranceType: "1", answerLength: "2", answerFormat: "1", feedback: "<p>Correct.</p>" }];
  const wizardItemsCalculated = questionFor("calculated", {
    name: "Calculated question on the dataset item page", questionText: "<p>What is {a} divided by {b}?</p>", wizardPage: "datasetitems", calculatedAnswers: calculatedFormula,
  });
  questions.push(wizardItemsCalculated);
  const datasetMenuCalculated = questionFor("calculated", {
    name: "Calculated question on the dataset definition page", questionText: "<p>What is {a} divided by {b}?</p>", midWizard: true, calculatedAnswers: calculatedFormula,
  });
  questions.push(datasetMenuCalculated);
  const simpleFormula = [{ formula: "{p}+{q}", fraction: "1.0", tolerance: "0.05", toleranceType: "1", answerLength: "1", answerFormat: "2", feedback: "<p>Correct.</p>" }];
  const generatedCalculatedSimple = questionFor("calculatedsimple", {
    name: "Calculated simple with generated values", questionText: "<p>Add {p} and {q}.</p>", unsavedValueSet: true, calculatedAnswers: simpleFormula,
    datasetDefinitions: [{ key: "1-0-p", name: "p" }, { key: "1-420-q", name: "q" }], datasetValueSets: 2,
  });
  questions.push(generatedCalculatedSimple);
  const pendingWildcardCalculatedSimple = questionFor("calculatedsimple", {
    name: "Calculated simple with an undefined wildcard", questionText: "<p>Add {p} and {q}.</p>", calculatedAnswers: simpleFormula,
    datasetDefinitions: [{ key: "1-0-p", name: "p" }], datasetValueSets: 2,
  });
  questions.push(pendingWildcardCalculatedSimple);
  const fileBearingOrdering = questionFor("ordering", { name: "File-bearing ordering", questionText: '<p><a href="draftfile.php/999/file.pdf">Private file</a></p>', orderingItems: ["First", "Second"] });
  questions.push(fileBearingOrdering);
  const fileBearingMarker = questionFor("ddmarker", {
    name: "File-bearing drag and drop markers", questionText: '<p><img src="draftfile.php/999/private-map.png" alt="Private map"></p>', backgroundDraftId: "4002",
    markers: [{ label: "Nucleus", maxDrags: 1 }],
    dropZones: [{ shape: "circle", marker: 1, coordinates: "120,140;35" }],
  });
  questions.push(fileBearingMarker);
  questions.push({ slotId: 99, qtype: "random", name: "Random reference for Question bank category 42", defaultMark: "1.00" });
  const formQuestion = (values, existing) => {
    const qtype = values.get("qtype") || "";
    const current = existing || questionFor(qtype);
    current.name = values.get("name") || "";
    current.questionText = values.get("questiontext[text]") || "";
    current.defaultMark = values.get("defaultmark") || (qtype === "description" ? "0" : qtype === "multianswer" ? [...current.questionText.matchAll(/\{([1-9][0-9]*(?:[.,][0-9]+)?):SHORTANSWER:=([^~#{}\\]+)\}/g)].reduce((total, match) => total + Number(match[1].replace(",", ".")), 0).toString() : "");
    current.generalFeedback = values.get("generalfeedback[text]") || "";
    current.idNumber = values.get("idnumber") || "";
    current.tags = values.getAll("tags[]");
    current.courseTags = values.getAll("coursetags[]");
    if (qtype === "multianswer") current.multianswerPenalty = values.get("penalty") || "";
    if (qtype === "truefalse") {
      current.correctAnswer = values.get("correctanswer") === "1";
      current.trueFeedback = values.get("feedbacktrue[text]") || "";
      current.falseFeedback = values.get("feedbackfalse[text]") || "";
    }
    if (["shortanswer", "numerical"].includes(qtype)) {
      current.caseSensitive = values.get("usecase") === "1";
      current.answers = [0, 1, 2].map((index) => ({ text: values.get(`answer[${index}][text]`) || "", fraction: values.get(`fraction[${index}]`) || "0.0", feedback: values.get(`feedback[${index}][text]`) || "", tolerance: values.get(`tolerance[${index}]`) || "0" }))
        .filter((answer) => answer.text || answer.feedback || answer.fraction !== "0.0");
    }
    if (qtype === "essay") {
      current.responseTemplate = values.get("responsetemplate[text]") || "";
      current.graderInfo = values.get("graderinfo[text]") || "";
    }
    if (qtype === "match") {
      current.shuffleAnswers = values.getAll("shuffleanswers").at(-1) === "1";
      const rows = [0, 1, 2].map((index) => ({ questionText: values.get(`subquestions[${index}][text]`) || "", answerText: values.get(`subanswers[${index}]`) || "" }));
      current.pairs = rows.filter((row) => row.questionText && row.answerText);
      current.distractors = rows.filter((row) => !row.questionText && row.answerText).map((row) => row.answerText);
    }
    if (["gapselect", "ddwtos"].includes(qtype)) {
      current.shuffleAnswers = values.getAll("shuffleanswers").at(-1) === "1";
      current.choices = [0, 1, 2].map((index) => ({ text: values.get(`choices[${index}][answer]`) || "", group: Number(values.get(`choices[${index}][choicegroup]`) || 1), unlimited: values.getAll(`choices[${index}][infinite]`).at(-1) === "1" }))
        .filter((choice) => choice.text)
        .map((choice) => qtype === "ddwtos" ? choice : { text: choice.text, group: choice.group });
    }
    return current;
  };
  const server = createServer({ key: readFileSync(key), cert: readFileSync(certificate) }, (request, response) => {
    const url = new URL(request.url || "/", "https://127.0.0.1");
    requests.push(`${request.method} ${url.pathname}${url.search}`);
    if (url.pathname === "/course/view.php") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><body class="path-course course-2"><h1>Question authoring course</h1><script>var M = {}; M.cfg = ${JSON.stringify({ wwwroot: `https://${request.headers.host}`, sesskey: "question-session", userId: 3 })};</script></body>`);
      return;
    }
    if (url.pathname === "/lib/ajax/service.php") {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const call = JSON.parse(Buffer.concat(chunks).toString("utf8"))[0];
        if (call?.methodname !== "core_courseformat_get_state") { response.writeHead(400).end(); return; }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify([{ data: JSON.stringify({ course: { id: 2, fullname: "Question authoring course" }, section: [{ id: 7, number: 4, title: "Questions", component: "" }], cm: [{ id: 9, module: "quiz", sectionid: 7, name: "Authoring Quiz" }] }) }]));
      });
      return;
    }
    if (url.pathname === "/repository/draftfiles_ajax.php") {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const itemId = new URLSearchParams(Buffer.concat(chunks).toString("utf8")).get("itemid") || "";
        draftListings.push(itemId);
        const background = backgroundImages.get(itemId);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(background
          ? { filecount: 1, list: [background], tree: { children: [] } }
          : nonemptyQuestionFileAreas ? { filecount: 1, list: [{ filename: "protected-question-file.pdf" }] } : { filecount: 0, list: [] }));
      });
      return;
    }
    if (url.pathname === "/mod/quiz/edit.php" && request.method === "GET") {
      response.writeHead(200, { "content-type": "text/html" }); response.end(authoringQuizPage(questions)); return;
    }
    if (url.pathname === "/question/bank/editquestion/addquestion.php" && request.method === "GET") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><form method="get" action="/question/bank/editquestion/question.php"><input name="category" value="42"><input name="cmid" value="9"><input name="returnurl" value="/mod/quiz/edit.php?cmid=9&amp;addonpage=0"><input name="appendqnumstring" value="addquestion">${qtypes.map((qtype) => `<input type="radio" name="qtype" value="${qtype}">`).join("")}</form>`);
      return;
    }
    if (url.pathname === "/question/bank/editquestion/question.php" && request.method === "GET") {
      const qtype = url.searchParams.get("qtype");
      const question = url.searchParams.get("id") ? questions.find((entry) => String(entry.id) === url.searchParams.get("id")) : null;
      const nativeQtype = question?.qtype || qtype;
      if (!nativeQtype || !qtypes.includes(nativeQtype)) { response.writeHead(404).end(); return; }
      const content = questionAuthoringForm(question || questionFor(nativeQtype, { id: 0, slotId: 0, name: "", questionText: "", defaultMark: "1", idNumber: `${nativeQtype}-default`, answers: [], pairs: [], distractors: [] }), nativeQtype, !question);
      if (!question && nativeQtype === "multianswer" && changeMultianswerInteractiveAfterNextFormRead) {
        changeMultianswerInteractiveAfterNextFormRead = false;
        multianswerInteractivePenalty = "1.0000000";
      }
      response.writeHead(200, { "content-type": "text/html" }); response.end(content); return;
    }
    if (url.pathname === "/question/bank/editquestion/question.php" && request.method === "POST") {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const values = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        posts.push(values);
        const current = values.get("id") ? questions.find((entry) => String(entry.id) === values.get("id")) : null;
        const saved = formQuestion(values, current);
        if (!current) questions.push(saved);
        response.writeHead(303, { location: "/mod/quiz/edit.php?cmid=9" }).end();
      });
      return;
    }
    response.writeHead(404).end();
  });
  let browser;
  let context;
  try {
    await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Question-authoring test server did not bind a port");
    const origin = `https://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await page.goto(`${origin}/course/view.php?id=2`);
    await page.evaluate((wwwroot) => { globalThis.M = { cfg: { wwwroot, sesskey: "question-session", userId: 3, courseId: 2 } }; }, origin);
    const binding = { origin, siteUrl: `${origin}/`, principalId: "3", courseId: "2" };
    const execute = (operation, args) => executeInBrowser(page, { mode: "execute", operation, arguments: args, binding, expiresAt: Date.now() + 60_000 });
    const genericRead = { key: "moodle.form.question.bank.editquestion.read.v1", toolName: "moodle_get_quiz_question", provider: "moodle", readOnly: true };
    const refused = new Set([fileBearingOrdering, fileBearingMarker, wizardItemsCalculated, datasetMenuCalculated, generatedCalculatedSimple, pendingWildcardCalculatedSimple]);
    const safeQuestions = questions.filter((question) => question.qtype !== "random" && !refused.has(question));
    const reads = new Map();
    const requestsBeforeReads = requests.length;
    for (const question of safeQuestions) {
      const read = await execute(genericRead, { course_id: 2, module_id: 9, slot_id: question.slotId });
      assert.equal(read.ok, true, `${question.qtype}: ${JSON.stringify(read)}`);
      assert.equal(read.data.qtype, question.qtype);
      reads.set(question.qtype, read);
    }
    assert.deepEqual(requests.slice(requestsBeforeReads).filter((entry) => entry.startsWith("POST /question/bank/editquestion/")), [], "a question read must never submit the question form");
    const ordering = reads.get("ordering");
    assert.deepEqual(ordering.data.details, {
      layout_type: "vertical",
      select_type: "all",
      select_count: 3,
      grading_type: "absolute_position",
      show_grading: true,
      numbering_style: "abc",
      items: [{ text: "Find the source", format: "1" }, { text: "Cite the source", format: "1" }],
      combined_feedback: {
        correct: { text: "<p>Correct.</p>", format: "1" },
        partially_correct: { text: "<p>Partly correct.</p>", format: "1" },
        incorrect: { text: "<p>Incorrect.</p>", format: "1" },
      },
      penalty: "0.3333333",
      show_num_correct: true,
      hints: [{ text: "<p>Review the order.</p>", format: "1", show_num_correct: true, highlight_response: true }],
    });
    const randomSamatch = reads.get("randomsamatch");
    assert.equal(randomSamatch.data.details.choose, 3);
    assert.equal(randomSamatch.data.details.include_subcategories, false);
    assert.equal(randomSamatch.data.details.fraction, "0");
    assert.deepEqual(randomSamatch.data.details.hints, [{ text: "<p>Review the evidence.</p>", format: "1", clear_wrong: true, show_num_correct: true }]);

    const dragImage = reads.get("ddimageortext");
    assert.deepEqual(dragImage.data.details, {
      shuffle_answers: true,
      drop_zone_visibility: "1",
      drag_items: [
        { number: 1, content_type: "word", label: "Library", group: 1, unlimited: false },
        { number: 2, content_type: "image", label: "Laboratory", group: 2, unlimited: true },
      ],
      drop_zones: [
        { number: 1, x_left: "40", y_top: "120", drag_item: 1, label: "North wing" },
        { number: 2, x_left: "180", y_top: "260", drag_item: 2, label: "South wing" },
      ],
      ...multipleChoiceDefaultData(),
      background_image: { filename: "campus-map.png", size_bytes: 20480, media_type_label: "Image (PNG)" },
    });
    assert.equal(dragImage.data.question_text, "<p>Drag each label onto the matching building.</p>");
    assert.equal(dragImage.data.file_areas, undefined, "an empty native question file area is not reported as content");

    const dragMarker = reads.get("ddmarker");
    assert.deepEqual(dragMarker.data.details, {
      shuffle_answers: false,
      show_misplaced: true,
      markers: [
        { number: 1, label: "Nucleus", unlimited: false, max_drags: 1 },
        { number: 2, label: "Membrane", unlimited: true, max_drags: null },
      ],
      drop_zones: [
        { number: 1, shape: "circle", marker: 1, coordinates: "120,140;35" },
        { number: 2, shape: "rectangle", marker: 2, coordinates: "10,10;60,40" },
      ],
      combined_feedback: {
        correct: { text: "<p>Correct.</p>", format: "1" },
        partially_correct: { text: "<p>Partly correct.</p>", format: "1" },
        incorrect: { text: "<p>Incorrect.</p>", format: "1" },
      },
      penalty: "0.3333333",
      show_num_correct: true,
      hints: [{ text: "<p>Check where each marker sits.</p>", format: "1", clear_wrong: false, show_num_correct: true, state_incorrectly_placed: true }],
      background_image: { filename: "cell-diagram.jpg", size_bytes: 30720, media_type_label: "Image (JPEG)" },
    });
    assert.ok(draftListings.includes("4001") && draftListings.includes("4002"), "each drag-and-drop background image is read as draft file metadata");
    assert.deepEqual(requests.filter((entry) => entry.startsWith("GET /draftfile.php")), [], "a background image read must never fetch the image bytes");

    const calculated = reads.get("calculated");
    assert.equal(calculated.data.question_text, "<p>What is {a} divided by {b}?</p>", "a calculated read keeps the wildcard placeholders in the question text");
    assert.deepEqual(calculated.data.details, {
      shared_dataset_sync: "1",
      formula_wildcards: ["a", "b"],
      answers: [{ formula: "{a}/{b}", fraction: "1.0", tolerance: "0.01", tolerance_type: "2", correct_answer_length: "3", correct_answer_format: "1", feedback: "<p>Correct.</p>", feedback_format: "1" }],
      unit_role: "3",
      unit_penalty: "0.1",
      unit_grading_type: "1",
      multiple_choice_display: "0",
      units_left: false,
      units: [{ unit: "ohm", multiplier: "1.0" }, { unit: "kohm", multiplier: "0.001" }],
      penalty: "0.3333333",
      hints: [{ text: "<p>Divide the first wildcard by the second.</p>", format: "1" }],
    });

    const calculatedMulti = reads.get("calculatedmulti");
    assert.deepEqual(calculatedMulti.data.details, {
      shared_dataset_sync: "0",
      formula_wildcards: ["x", "y"],
      single: true,
      shuffle_answers: false,
      answer_numbering: "abc",
      answers: [
        { formula: "<p>{x}*{y}</p>", formula_format: "1", fraction: "1.0", tolerance: "0.01", tolerance_type: "1", correct_answer_length: "2", correct_answer_format: "1", feedback: "<p>Correct.</p>", feedback_format: "1" },
        { formula: "<p>{x}+{y}</p>", formula_format: "1", fraction: "0.0", tolerance: "0.01", tolerance_type: "1", correct_answer_length: "2", correct_answer_format: "1", feedback: "<p>That is the sum.</p>", feedback_format: "1" },
      ],
      ...multipleChoiceDefaultData(),
    });

    const calculatedSimple = reads.get("calculatedsimple");
    assert.deepEqual(calculatedSimple.data.details, {
      shared_dataset_sync: "0",
      formula_wildcards: ["p", "q"],
      dataset_definitions: [{ name: "p", shared: false }, { name: "q", shared: true }],
      dataset_value_sets: 3,
      answers: [{ formula: "{p}+{q}", fraction: "1.0", tolerance: "0.05", tolerance_type: "1", correct_answer_length: "1", correct_answer_format: "2", feedback: "<p>Correct.</p>", feedback_format: "1" }],
      unit_role: "0",
      unit_penalty: "0.1",
      unit_grading_type: "1",
      multiple_choice_display: "0",
      units_left: false,
      units: [],
      penalty: "0.3333333",
      hints: [{ text: "<p>Add the two values.</p>", format: "1" }],
    });

    for (const question of safeQuestions.filter((entry) => ["calculated", "calculatedmulti", "calculatedsimple"].includes(entry.qtype))) {
      const before = requests.length;
      const read = await execute(genericRead, { course_id: 2, module_id: 9, slot_id: question.slotId });
      assert.equal(read.ok, true, `${question.qtype}: ${JSON.stringify(read)}`);
      const sent = requests.slice(before);
      const formReads = sent.filter((entry) => entry.startsWith("GET /question/bank/editquestion/question.php"));
      assert.equal(formReads.length, 1, `${question.qtype}: one read opens the question form exactly once`);
      assert.ok(formReads[0].includes(`id=${question.id}`) && formReads[0].includes("cmid=9"), `${question.qtype}: the form read binds the listed slot`);
      assert.deepEqual(sent.filter((entry) => /wizardnow|forceregeneration|analyzequestion|addbutton|updatedatasets|datasetdefinitions|datasetitems/i.test(entry)), [],
        `${question.qtype}: a read must never advance the dataset wizard or generate dataset items`);
      const allowed = ["GET /mod/quiz/edit.php", "GET /question/bank/editquestion/question.php", "POST /repository/draftfiles_ajax.php", "POST /lib/ajax/service.php"];
      assert.deepEqual(sent.filter((entry) => !allowed.some((prefix) => entry.startsWith(prefix))), [],
        `${question.qtype}: a read sends only the course-state and slot-list reads, the one question form read, and the native draft-file listings`);
    }
    for (const question of [wizardItemsCalculated, datasetMenuCalculated, generatedCalculatedSimple, pendingWildcardCalculatedSimple]) {
      assert.deepEqual(await execute(genericRead, { course_id: 2, module_id: 9, slot_id: question.slotId }),
        { ok: false, sent: false, status: 200, error: "moodle_question_dataset_wizard_pending" }, `${question.name} must be refused`);
    }

    assert.deepEqual(await execute(genericRead, { course_id: 2, module_id: 9, slot_id: fileBearingOrdering.slotId }), { ok: false, sent: false, status: 200, error: "moodle_question_content_refused" });
    assert.deepEqual(await execute(genericRead, { course_id: 2, module_id: 9, slot_id: fileBearingMarker.slotId }), { ok: false, sent: false, status: 200, error: "moodle_question_content_refused" });
    assert.deepEqual(await execute(genericRead, { course_id: 2, module_id: 9, slot_id: 99 }), { ok: false, sent: false, error: "moodle_quiz_random_slot_uninspectable" });

    const legacyCreateArguments = {
      multichoice: { name: "New multiple choice", question_text: "<p>Choose the evidence.</p>", default_mark: 2, answers: [{ answer_text: "<p>Source.</p>", correct_answer: true, feedback: "<p>Correct.</p>" }, { answer_text: "<p>Guess.</p>", correct_answer: false, feedback: "<p>Try again.</p>" }] },
      truefalse: { name: "New true false", question_text: "<p>True or false?</p>", default_mark: 2, correct_answer: true, true_feedback: "<p>Right.</p>", false_feedback: "<p>Try again.</p>" },
      shortanswer: { name: "New short answer", question_text: "<p>Name the evidence.</p>", default_mark: 2, case_sensitive: true, answers: [{ answer_text: "source", grade_fraction: 1, feedback: "<p>Correct.</p>" }, { answer_text: "citation", grade_fraction: 0.5, feedback: "<p>Partial.</p>" }] },
      numerical: { name: "New numerical", question_text: "<p>What is two plus two?</p>", default_mark: 2, answers: [{ answer_text: "4", grade_fraction: 1, tolerance: 0, feedback: "<p>Correct.</p>" }, { answer_text: "5", grade_fraction: 0.5, tolerance: 0, feedback: "<p>Close.</p>" }] },
      essay: { name: "New essay", question_text: "<p>Explain the source.</p>", default_mark: 4 },
      match: { name: "New matching", question_text: "<p>Match the terms.</p>", default_mark: 3, shuffle_answers: true, pairs: [{ question_text: "<p>Claim</p>", answer_text: "Evidence" }, { question_text: "<p>Method</p>", answer_text: "Citation" }], distractors: ["Opinion"] },
      description: { name: "New description", question_text: "<p>Read the source before answering.</p>", default_mark: 0 },
      gapselect: { name: "New missing words", question_text: "<p>[[1]] supports [[2]].</p>", default_mark: 3, shuffle_answers: true, choices: [{ text: "Evidence", group: 1 }, { text: "Claim", group: 2 }] },
      ddwtos: { name: "New drag words", question_text: "<p>[[1]] and [[1]] support [[2]].</p>", default_mark: 3, shuffle_answers: false, choices: [{ text: "Evidence", group: 1, unlimited: true }, { text: "Claim", group: 2, unlimited: false }] },
      multianswer: { name: "New embedded answers", question_text: "<p>Use {2:SHORTANSWER:=evidence} with {1:SHORTANSWER:=citation}.</p>" },
    };
    const createOperation = (qtype) => ({
      key: `moodle.form.mod.quiz.question.${qtype}.create.write.v1`,
      toolName: `moodle_create_quiz_${qtype === "match" ? "matching" : qtype}_question`,
      provider: "moodle",
      readOnly: false,
    });
    const updateOperation = (qtype) => ({
      key: `moodle.form.question.bank.editquestion.${qtype}.write.v1`,
      toolName: `moodle_update_quiz_${qtype === "match" ? "matching" : qtype}_question`,
      provider: "moodle",
      readOnly: false,
    });
    const postsBeforeHeldWrites = posts.length;
    const requestsBeforeHeldWrites = requests.length;
    for (const [qtype, args] of Object.entries(legacyCreateArguments)) {
      assert.deepEqual(await execute(createOperation(qtype), { course_id: 2, module_id: 9, ...args, expected_digest: "a".repeat(64) }), { ok: false, sent: false, error: "moodle_question_bank_impact_unresolved" }, `${qtype} creation must stop before native contact`);
    }
    const withoutWriteRoute = ["ordering", "randomsamatch", "ddimageortext", "ddmarker", "calculated", "calculatedmulti", "calculatedsimple"];
    for (const question of safeQuestions.filter((question) => !withoutWriteRoute.includes(question.qtype))) {
      assert.deepEqual(await execute(updateOperation(question.qtype), { course_id: 2, module_id: 9, slot_id: question.slotId, name: `Held ${question.qtype}`, expected_digest: "b".repeat(64) }), { ok: false, sent: false, error: "moodle_question_bank_impact_unresolved" }, `${question.qtype} update must stop before native contact`);
    }
    for (const question of safeQuestions.filter((question) => ["ddimageortext", "ddmarker", "calculated", "calculatedmulti", "calculatedsimple"].includes(question.qtype))) {
      assert.deepEqual(await execute(createOperation(question.qtype), { course_id: 2, module_id: 9, name: `New ${question.qtype}`, question_text: "<p>New prompt.</p>", expected_digest: "c".repeat(64) }), { ok: false, sent: false, error: "moodle_operation_refused" }, `${question.qtype} has no creation route`);
      assert.deepEqual(await execute(updateOperation(question.qtype), { course_id: 2, module_id: 9, slot_id: question.slotId, name: `Held ${question.qtype}`, expected_digest: "c".repeat(64) }), { ok: false, sent: false, error: "moodle_operation_refused" }, `${question.qtype} has no update route`);
    }
    assert.equal(posts.length, postsBeforeHeldWrites, "all Question bank writes must stop before a POST");
    const heldWriteRequests = requests.slice(requestsBeforeHeldWrites);
    assert.deepEqual(heldWriteRequests.filter((entry) => entry.includes("/question/bank/editquestion/")), [], "held Question bank writes must not reach the question editor");
    assert.deepEqual(heldWriteRequests, [], "held Question bank writes must stop before any native request");
  } finally {
    await context?.close();
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Moodle executor verifies bounded Forum and Choice forms over HTTPS", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-forum-choice-"));
  const key = join(directory, "key.pem");
  const certificate = join(directory, "certificate.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", certificate], { stdio: "ignore" });
  const forumRead = { key: "moodle.form.course.modedit.forum.read.v1", toolName: "moodle_get_forum", provider: "moodle", readOnly: true };
  const forumCreateRead = { key: "moodle.form.course.modedit.forum.create.read.v1", toolName: "moodle_get_forum_creation_form", provider: "moodle", readOnly: true };
  const forumWrite = { key: "moodle.form.course.modedit.forum.write.v1", toolName: "moodle_update_forum", provider: "moodle", readOnly: false };
  const forumCreateWrite = { key: "moodle.form.course.modedit.forum.create.write.v1", toolName: "moodle_create_forum", provider: "moodle", readOnly: false };
  const choiceRead = { key: "moodle.form.course.modedit.choice.read.v1", toolName: "moodle_get_choice", provider: "moodle", readOnly: true };
  const choiceCreateRead = { key: "moodle.form.course.modedit.choice.create.read.v1", toolName: "moodle_get_choice_creation_form", provider: "moodle", readOnly: true };
  const choiceWrite = { key: "moodle.form.course.modedit.choice.write.v1", toolName: "moodle_update_choice", provider: "moodle", readOnly: false };
  const choiceCreateWrite = { key: "moodle.form.course.modedit.choice.create.write.v1", toolName: "moodle_create_choice", provider: "moodle", readOnly: false };
  const requests = [];
  const posts = [];
  let createdForum = null;
  let createdChoice = null;
  let origin = "";
  const date = (name, value) => `<input type="checkbox" name="${name}[enabled]" value="1"${value ? " checked" : ""}><input name="${name}[year]" value="${value?.year || 2026}"><input name="${name}[month]" value="${value?.month || 9}"><input name="${name}[day]" value="${value?.day || 6}"><input name="${name}[hour]" value="${value?.hour || 9}"><input name="${name}[minute]" value="${value?.minute || 30}">`;
  const select = (name, values, selected, disabled = false) => `<select name="${name}"${disabled ? " disabled" : ""}>${values.map((value) => `<option value="${value}"${String(value) === String(selected) ? " selected" : ""}>${value}</option>`).join("")}</select>`;
  const yesNo = (name, value, disabled = false) => select(name, ["0", "1"], value ? "1" : "0", disabled);
  const identity = (module, moduleId, creation) => creation
    ? `<input name="course" value="2"><input name="add" value="${module}"><input name="modulename" value="${module}"><input name="section" value="4"><input name="return" value="0"><input name="coursecontentnotification" value="1">`
    : `<input name="update" value="${moduleId}"><input name="return" value="0"><input name="course" value="2"><input name="modulename" value="${module}"><input name="section" value="4">`;
  const forumForm = (state, { moduleId = 17, creation = false } = {}) => {
    const action = creation ? "/course/modedit.php?add=forum&amp;course=2&amp;sectionid=7&amp;return=0" : `/course/modedit.php?update=${moduleId}&amp;return=0`;
    const assessment = state.assessment || { type: "none" };
    return `<!doctype html><html><body><form method="post" action="${action}">${identity("forum", moduleId, creation)}
      <input name="name" value="${state.name}"><textarea name="introeditor[text]">${state.instructions}</textarea><input name="introeditor[format]" value="1"><input name="introeditor[itemid]" value="7001">
      ${select("type", ["general", "qanda", "single"], state.forumType)}${select("forcesubscribe", ["0", "1", "2", "3"], state.subscriptionMode)}${select("trackingtype", ["0", "1", "2"], state.trackingType)}
      ${date("duedate", state.dueDate)}${date("cutoffdate", state.cutoffAt)}${select("grade_forum[modgrade_type]", ["none", "point"], assessment.type)}<input name="grade_forum[modgrade_point]" value="${assessment.maximum_points || 100}">
      <input name="visible" value="${state.visible ? 1 : 0}"><input name="completion" value="2"><input name="availability" value="forum-availability"><input name="sesskey" value="synthetic-session"><input type="submit" name="submitbutton" value="Save and return to course"></form></body></html>`;
  };
  const choiceForm = (state, { moduleId = 18, creation = false } = {}) => {
    const action = creation ? "/course/modedit.php?add=choice&amp;course=2&amp;sectionid=7&amp;return=0" : `/course/modedit.php?update=${moduleId}&amp;return=0`;
    const options = [...state.options, "", "", "", "", ""].slice(0, 5);
    return `<!doctype html><html><body><form method="post" action="${action}">${identity("choice", moduleId, creation)}
      <input name="name" value="${state.name}"><textarea name="introeditor[text]">${state.instructions}</textarea><input name="introeditor[format]" value="1"><input name="introeditor[itemid]" value="7002">
      ${select("display", ["0", "1"], state.display)}${yesNo("allowupdate", state.allowUpdate)}${yesNo("allowmultiple", state.allowMultiple, state.hasResponses)}${yesNo("limitanswers", state.limitAnswers)}${yesNo("showavailable", state.showAvailable)}
      ${options.map((option, index) => `<input name="option[${index}]" value="${option}"><input name="limit[${index}]" value="${state.limits[index] || 0}"><input type="hidden" name="optionid[${index}]" value="${state.optionIds?.[index] || 0}">`).join("")}
      ${date("timeopen", state.openAt)}${date("timeclose", state.closeAt)}<input type="hidden" name="showpreview" value="0"><input type="checkbox" name="showpreview" value="1"${state.showPreview ? " checked" : ""}>
      ${select("showresults", ["0", "1", "2", "3"], state.showResults)}${select("publish", ["0", "1"], state.publishNames)}${yesNo("showunanswered", state.showUnanswered)}${yesNo("includeinactive", state.includeInactive)}
      <input name="visible" value="${state.visible ? 1 : 0}"><input name="completion" value="2"><input name="availability" value="choice-availability"><input name="sesskey" value="synthetic-session"><input type="submit" name="submitbutton" value="Save and return to course"></form></body></html>`;
  };
  const defaults = {
    forum: { name: "", instructions: "", forumType: "general", subscriptionMode: "2", trackingType: "1", assessment: { type: "none" }, dueDate: null, cutoffAt: null, visible: true },
    choice: { name: "", instructions: "", display: "0", allowUpdate: false, allowMultiple: false, limitAnswers: false, showAvailable: false, options: ["", "", "", "", ""], limits: [0, 0, 0, 0, 0], openAt: null, closeAt: null, showPreview: false, showResults: "0", publishNames: "0", showUnanswered: false, includeInactive: false, visible: true, hasResponses: false },
  };
  const savedDate = (values, name) => values.has(`${name}[enabled]`) ? { year: Number(values.get(`${name}[year]`)), month: Number(values.get(`${name}[month]`)), day: Number(values.get(`${name}[day]`)), hour: Number(values.get(`${name}[hour]`)), minute: Number(values.get(`${name}[minute]`)) } : null;
  const saveForum = (values, prior = defaults.forum) => ({ ...prior, name: values.get("name") || "", instructions: values.get("introeditor[text]") || "", forumType: values.get("type") || "", subscriptionMode: values.get("forcesubscribe") || "", trackingType: values.get("trackingtype") || "", assessment: values.get("grade_forum[modgrade_type]") === "point" ? { type: "point", maximum_points: Number(values.get("grade_forum[modgrade_point]") || 0) } : { type: "none" }, dueDate: savedDate(values, "duedate"), cutoffAt: savedDate(values, "cutoffdate"), visible: values.get("visible") === "1" });
  const saveChoice = (values, prior = defaults.choice) => {
    const indexes = [0, 1, 2, 3, 4];
    const kept = indexes.filter((index) => values.get(`option[${index}]`));
    return { ...prior, name: values.get("name") || "", instructions: values.get("introeditor[text]") || "", display: values.get("display") || "", allowUpdate: values.get("allowupdate") === "1", allowMultiple: values.get("allowmultiple") === "1", limitAnswers: values.get("limitanswers") === "1", showAvailable: values.get("showavailable") === "1", options: kept.map((index) => values.get(`option[${index}]`)), limits: kept.map((index) => Number(values.get(`limit[${index}]`) || 0)), optionIds: kept.map((_, index) => 200 + index), openAt: savedDate(values, "timeopen"), closeAt: savedDate(values, "timeclose"), showPreview: values.getAll("showpreview").includes("1"), showResults: values.get("showresults") || "", publishNames: values.get("publish") || "", showUnanswered: values.get("showunanswered") === "1", includeInactive: values.get("includeinactive") === "1", visible: values.get("visible") === "1" };
  };
  const stateResponse = () => JSON.stringify([{ data: JSON.stringify({ course: { id: 2, fullname: "Moodle evidence" }, section: [{ id: 7, number: 4, title: "Forum and Choice", component: "" }], cm: [
    ...(createdForum ? [{ id: 71, module: "forum", sectionid: 7, name: createdForum.name, visible: createdForum.visible }] : []),
    ...(createdChoice ? [{ id: 72, module: "choice", sectionid: 7, name: createdChoice.name, visible: createdChoice.visible }] : []),
  ] }) }]);
  const server = createServer({ key: readFileSync(key), cert: readFileSync(certificate) }, (request, response) => {
    const url = new URL(request.url || "/", "https://127.0.0.1");
    requests.push(`${request.method} ${url.pathname}${url.search}`);
    if (url.pathname === "/course/view.php") { response.writeHead(200, { "content-type": "text/html" }); response.end(`<!doctype html><body class="path-course course-2"><h1>Moodle evidence</h1><script>var M = {}; M.cfg = ${JSON.stringify({ wwwroot: `https://${request.headers.host}`, sesskey: "synthetic-session", userId: 3 })};</script></body>`); return; }
    if (url.pathname === "/lib/ajax/service.php") {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => { response.writeHead(200, { "content-type": "application/json" }); response.end(stateResponse()); });
      return;
    }
    if (url.pathname === "/repository/draftfiles_ajax.php") {
      request.on("data", () => {});
      request.on("end", () => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ filecount: 0, list: [] })); });
      return;
    }
    if (url.pathname === "/mod/forum/view.php" || url.pathname === "/mod/choice/view.php") { response.writeHead(200, { "content-type": "text/html" }); response.end("<!doctype html><body>Saved</body>"); return; }
    if (url.pathname !== "/course/modedit.php") { response.writeHead(404).end(); return; }
    if (request.method === "GET") {
      let form;
      if (url.searchParams.get("add") === "forum") form = forumForm(defaults.forum, { creation: true });
      else if (url.searchParams.get("add") === "choice") form = choiceForm(defaults.choice, { creation: true });
      else if (url.searchParams.get("update") === "71" && createdForum) form = forumForm(createdForum, { moduleId: 71 });
      else if (url.searchParams.get("update") === "72" && createdChoice) form = choiceForm(createdChoice, { moduleId: 72 });
      else { response.writeHead(404).end(); return; }
      response.writeHead(200, { "content-type": "text/html" }); response.end(form); return;
    }
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const values = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      posts.push(values);
      if (values.get("add") === "forum") { createdForum = saveForum(values); response.writeHead(303, { location: "/mod/forum/view.php?id=71" }).end(); return; }
      if (values.get("add") === "choice") { createdChoice = saveChoice(values); response.writeHead(303, { location: "/mod/choice/view.php?id=72" }).end(); return; }
      if (values.get("update") === "71") { createdForum = saveForum(values, createdForum); response.writeHead(303, { location: "/course/view.php?id=2" }).end(); return; }
      if (values.get("update") === "72") { createdChoice = saveChoice(values, createdChoice); response.writeHead(303, { location: "/course/view.php?id=2" }).end(); return; }
      response.writeHead(404).end();
    });
  });
  let browser;
  let context;
  try {
    await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Forum and Choice test server did not bind a port");
    origin = `https://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await page.goto(`${origin}/course/view.php?id=2`);
    await page.evaluate((wwwroot) => { globalThis.M = { cfg: { wwwroot, sesskey: "synthetic-session", userId: 3, courseId: 2 } }; }, origin);
    const binding = { origin, siteUrl: `${origin}/`, principalId: "3", courseId: "2" };
    const execute = (operation, args) => executeInBrowser(page, { mode: "execute", operation, arguments: args, binding, expiresAt: Date.now() + 60_000 });

    const forumPreparation = await execute(forumCreateRead, { course_id: 2, section_id: 7 });
    assert.equal(forumPreparation.ok, true, JSON.stringify(forumPreparation));
    assert.deepEqual(forumPreparation.data.available_forum_types, ["general", "qanda", "single"]);
    const postsBeforeInvalidForum = posts.length;
    assert.deepEqual(await execute(forumCreateWrite, { course_id: 2, section_id: 7, name: "Must not create", instructions: "", forum_type: "blog", subscription_mode: "2", tracking_type: "1", assessment: { type: "none" }, due_date: null, cutoff_at: null, expected_digest: forumPreparation.snapshot_digest }), { ok: false, sent: false, error: "moodle_forum_native_setting_refused" });
    assert.equal(posts.length, postsBeforeInvalidForum);
    const forumCreated = await execute(forumCreateWrite, { course_id: 2, section_id: 7, name: "Evidence discussion", instructions: "<p>Use one cited source.</p>", forum_type: "qanda", subscription_mode: "2", tracking_type: "1", assessment: { type: "point", maximum_points: 10 }, due_date: { year: 2026, month: 9, day: 8, hour: 9, minute: 30 }, cutoff_at: { year: 2026, month: 9, day: 9, hour: 9, minute: 30 }, expected_digest: forumPreparation.snapshot_digest });
    assert.equal(forumCreated.ok, true, JSON.stringify(forumCreated));
    assert.deepEqual(forumCreated.data.assessment, { type: "point", maximum_points: 10 });
    assert.equal(forumCreated.data.visible, false);
    assert.deepEqual(forumCreated.targets, [{ field: "course_id", label: "Course", name: "Moodle evidence" }, { field: "section_id", label: "Section", name: "Forum and Choice" }]);
    const forumUpdateRead = await execute(forumRead, { course_id: 2, module_id: 71 });
    const forumUpdated = await execute(forumWrite, { course_id: 2, module_id: 71, forum_type: "general", subscription_mode: "1", tracking_type: "0", assessment: { type: "none" }, expected_digest: forumUpdateRead.snapshot_digest });
    assert.equal(forumUpdated.ok, true, JSON.stringify(forumUpdated));
    assert.deepEqual(forumUpdated.data.assessment, { type: "none" });
    const forumPost = posts.at(-1);
    assert.equal(forumPost.get("availability"), "forum-availability");
    assert.equal(forumPost.get("visible"), "0");

    const choicePreparation = await execute(choiceCreateRead, { course_id: 2, section_id: 7 });
    assert.equal(choicePreparation.ok, true, JSON.stringify(choicePreparation));
    const choiceCreated = await execute(choiceCreateWrite, { course_id: 2, section_id: 7, name: "Evidence session", instructions: "<p>Choose one session.</p>", display: "0", allow_update: true, allow_multiple: false, limit_answers: true, show_available: true, options: ["Monday", "Tuesday"], limits: [5, 10], open_at: null, close_at: null, show_preview: true, show_results: "3", publish_names: "1", show_unanswered: false, include_inactive: true, expected_digest: choicePreparation.snapshot_digest });
    assert.equal(choiceCreated.ok, true, JSON.stringify(choiceCreated));
    assert.deepEqual([choiceCreated.data.options, choiceCreated.data.limits, choiceCreated.data.has_responses], [["Monday", "Tuesday"], [5, 10], false]);
    const choiceUpdateRead = await execute(choiceRead, { course_id: 2, module_id: 72 });
    const choiceUpdated = await execute(choiceWrite, { course_id: 2, module_id: 72, name: "Updated evidence session", options: ["Wednesday"], limits: [12], limit_answers: true, expected_digest: choiceUpdateRead.snapshot_digest });
    assert.equal(choiceUpdated.ok, true, JSON.stringify(choiceUpdated));
    assert.deepEqual(choiceUpdated.data.options, ["Wednesday"]);
    const choicePost = posts.at(-1);
    assert.equal(choicePost.get("availability"), "choice-availability");
    assert.equal(choicePost.get("visible"), "0");
    createdChoice.hasResponses = true;
    const lockedChoice = await execute(choiceRead, { course_id: 2, module_id: 72 });
    assert.equal(lockedChoice.data.has_responses, true);
    const postCount = posts.length;
    assert.deepEqual(await execute(choiceWrite, { course_id: 2, module_id: 72, options: ["Friday", "Saturday"], limits: [8, 8], limit_answers: true, expected_digest: lockedChoice.snapshot_digest }), { ok: false, sent: false, error: "moodle_choice_responses_exist" });
    assert.equal(posts.length, postCount);
    assert.ok(requests.includes("GET /course/modedit.php?add=forum&course=2&sectionid=7&return=0"));
    assert.ok(requests.includes("GET /course/modedit.php?update=71&return=0"));
    assert.ok(requests.includes("GET /course/modedit.php?add=choice&course=2&sectionid=7&return=0"));
    assert.ok(requests.includes("GET /course/modedit.php?update=72&return=0"));
  } finally {
    await context?.close();
    await browser?.close();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Moodle executor verifies bounded Book chapters and Lesson settings over HTTPS", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-book-lesson-browser-"));
  const key = join(directory, "key.pem");
  const certificate = join(directory, "certificate.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", certificate], { stdio: "ignore" });
  const bookRead = { key: "moodle.form.course.modedit.book.read.v1", toolName: "moodle_get_book", provider: "moodle", readOnly: true };
  const bookWrite = { key: "moodle.form.course.modedit.book.write.v1", toolName: "moodle_update_book", provider: "moodle", readOnly: false };
  const bookCreateRead = { key: "moodle.form.course.modedit.book.create.read.v1", toolName: "moodle_get_book_creation_form", provider: "moodle", readOnly: true };
  const bookCreate = { key: "moodle.form.course.modedit.book.create.write.v1", toolName: "moodle_create_book", provider: "moodle", readOnly: false };
  const lessonRead = { key: "moodle.form.course.modedit.lesson.read.v1", toolName: "moodle_get_lesson", provider: "moodle", readOnly: true };
  const lessonWrite = { key: "moodle.form.course.modedit.lesson.write.v1", toolName: "moodle_update_lesson", provider: "moodle", readOnly: false };
  const lessonCreateRead = { key: "moodle.form.course.modedit.lesson.create.read.v1", toolName: "moodle_get_lesson_creation_form", provider: "moodle", readOnly: true };
  const lessonCreate = { key: "moodle.form.course.modedit.lesson.create.write.v1", toolName: "moodle_create_lesson", provider: "moodle", readOnly: false };
  const listChapters = { key: "moodle.form.mod.book.chapters.read.v1", toolName: "moodle_list_book_chapters", provider: "moodle", readOnly: true };
  const chapterRead = { key: "moodle.form.mod.book.chapter.read.v1", toolName: "moodle_get_book_chapter", provider: "moodle", readOnly: true };
  const chapterCreateRead = { key: "moodle.form.mod.book.chapter.create.read.v1", toolName: "moodle_get_book_chapter_creation_form", provider: "moodle", readOnly: true };
  const chapterCreate = { key: "moodle.form.mod.book.chapter.create.write.v1", toolName: "moodle_create_book_chapter", provider: "moodle", readOnly: false };
  const chapterWrite = { key: "moodle.form.mod.book.chapter.write.v1", toolName: "moodle_update_book_chapter", provider: "moodle", readOnly: false };
  const chapterMove = { key: "moodle.form.mod.book.chapter.move.write.v1", toolName: "moodle_move_book_chapter", provider: "moodle", readOnly: false };
  const filterInventory = { key: "moodle.form.question.bank.filter.inventory.read.v1", toolName: "moodle_get_question_bank_filter_inventory", provider: "moodle", readOnly: true };
  const chapterShow = { key: "moodle.form.mod.book.chapter.show.write.v1", toolName: "moodle_show_book_chapter", provider: "moodle", readOnly: false };
  const chapterHide = { key: "moodle.form.mod.book.chapter.hide.write.v1", toolName: "moodle_hide_book_chapter", provider: "moodle", readOnly: false };
  const chapterDelete = { key: "moodle.form.mod.book.chapter.delete.write.v1", toolName: "moodle_delete_book_chapter", provider: "moodle", readOnly: false };
  const posts = [];
  let chapterDeleteRequests = 0;
  const book = { name: "Field guide", instructions: "<p>Original Book intro.</p>", numbering: "1", customTitles: false, visible: true };
  const lesson = { name: "Study lesson", instructions: "<p>Original Lesson intro.</p>", available: null, deadline: null, visible: true, mediaNonempty: false };
  let createdBook = null;
  let createdLesson = null;
  let nextChapterId = 304;
  const chapters = [
    { id: 301, title: "Observations", content: "<p>Observe closely.</p>", subchapter: false, hidden: false },
    { id: 302, title: "Details", content: "<p>Record the detail.</p>", subchapter: true, hidden: false },
    { id: 303, title: "Conclusion", content: "<p>Draw a conclusion.</p>", subchapter: false, hidden: false },
  ];
  const date = (name, value) => `<input type="checkbox" name="${name}[enabled]" value="1"${value ? " checked" : ""}><input name="${name}[year]" value="${value?.year || 2026}"><input name="${name}[month]" value="${value?.month || 9}"><input name="${name}[day]" value="${value?.day || 7}"><input name="${name}[hour]" value="${value?.hour || 9}"><input name="${name}[minute]" value="${value?.minute || 30}">`;
  const readDate = (values, name) => values.has(`${name}[enabled]`) ? { year: Number(values.get(`${name}[year]`)), month: Number(values.get(`${name}[month]`)), day: Number(values.get(`${name}[day]`)), hour: Number(values.get(`${name}[hour]`)), minute: Number(values.get(`${name}[minute]`)) } : null;
  const bookForm = (state = book, moduleId = 70, creation = false) => { const action = creation ? "/course/modedit.php?add=book&amp;course=2&amp;sectionid=7&amp;return=0" : `/course/modedit.php?update=${moduleId}&amp;return=0`; const identity = creation ? '<input name="course" value="2"><input name="add" value="book"><input name="modulename" value="book"><input name="section" value="4"><input name="return" value="0"><input name="coursecontentnotification" value="1">' : `<input name="update" value="${moduleId}"><input name="return" value="0"><input name="course" value="2"><input name="modulename" value="book"><input name="section" value="4">`; return `<!doctype html><html><body><form method="post" action="${action}">${identity}<input name="name" value="${state.name}"><textarea name="introeditor[text]">${state.instructions}</textarea><input name="introeditor[format]" value="1"><input name="introeditor[itemid]" value="8001"><select name="numbering"><option value="0">None</option><option value="1"${state.numbering === "1" ? " selected" : ""}>Numbers</option><option value="2"${state.numbering === "2" ? " selected" : ""}>Bullets</option></select><input type="checkbox" name="customtitles" value="1"${state.customTitles ? " checked" : ""}><input name="visible" value="${state.visible ? 1 : 0}"><input name="availability" value="book-availability"><input name="sesskey" value="synthetic-session"><input type="submit" name="submitbutton" value="Save and return to course"></form></body></html>`; };
  const lessonForm = (state = lesson, moduleId = 71, creation = false) => { const action = creation ? "/course/modedit.php?add=lesson&amp;course=2&amp;sectionid=7&amp;return=0" : `/course/modedit.php?update=${moduleId}&amp;return=0`; const identity = creation ? '<input name="course" value="2"><input name="add" value="lesson"><input name="modulename" value="lesson"><input name="section" value="4"><input name="return" value="0"><input name="coursecontentnotification" value="1">' : `<input name="update" value="${moduleId}"><input name="return" value="0"><input name="course" value="2"><input name="modulename" value="lesson"><input name="section" value="4">`; return `<!doctype html><html><body><form method="post" action="${action}">${identity}<input name="name" value="${state.name}"><textarea name="introeditor[text]">${state.instructions}</textarea><input name="introeditor[format]" value="1"><input name="introeditor[itemid]" value="8002"><div data-fieldtype="filemanager"><input type="hidden" name="mediafile" value="8003"></div>${date("available", state.available)}${date("deadline", state.deadline)}<input name="password" value="private-password"><input name="visible" value="${state.visible ? 1 : 0}"><input name="availability" value="lesson-availability"><input name="sesskey" value="synthetic-session"><input type="submit" name="submitbutton" value="Save and return to course"></form></body></html>`; };
  const chapterForm = (chapter, pagenum = 0, subchapter = false) => `<!doctype html><html><body><form method="post" action="/mod/book/edit.php"><input name="id" value="${chapter?.id || ""}"><input name="cmid" value="70"><input name="pagenum" value="${chapter ? chapters.indexOf(chapter) + 1 : pagenum + 1}"><input name="title" value="${chapter?.title || ""}"><input type="checkbox" name="subchapter" value="1"${(chapter ? chapter.subchapter : subchapter) ? " checked" : ""}><textarea name="content_editor[text]">${chapter?.content || ""}</textarea><input name="content_editor[format]" value="1"><input name="content_editor[itemid]" value="${chapter ? 8100 + chapter.id : 8999}"><input name="tags" value="book-tag"><input name="sesskey" value="synthetic-session"><input type="submit" name="submitbutton" value="Save changes"></form></body></html>`;
  const toc = () => `<!doctype html><html><body>${chapters.map((chapter) => `<a href="/mod/book/view.php?id=70&amp;chapterid=${chapter.id}">${chapter.title}</a><a href="/mod/book/show.php?id=70&amp;chapterid=${chapter.id}&amp;sesskey=synthetic-session"><img src="/pix/t/${chapter.hidden ? "show" : "hide"}.svg"></a>`).join("")}</body></html>`;
  const stateResponse = () => JSON.stringify([{ data: JSON.stringify({ course: { id: 2, fullname: "Book and Lesson evidence" }, section: [{ id: 7, number: 4, title: "Evidence", component: "" }], cm: [{ id: 70, module: "book", sectionid: 7, name: book.name, visible: book.visible }, { id: 71, module: "lesson", sectionid: 7, name: lesson.name, visible: lesson.visible }, ...(createdBook ? [{ id: 72, module: "book", sectionid: 7, name: createdBook.name, visible: false }] : []), ...(createdLesson ? [{ id: 73, module: "lesson", sectionid: 7, name: createdLesson.name, visible: false }] : []), { id: 74, module: "qbank", sectionid: 7, name: "Private question bank", visible: false }] }) }]);
  const server = createServer({ key: readFileSync(key), cert: readFileSync(certificate) }, (request, response) => {
    const url = new URL(request.url || "/", "https://127.0.0.1");
    if (url.pathname === "/course/view.php") { response.writeHead(200, { "content-type": "text/html" }); response.end(`<!doctype html><body class="path-course course-2"><h1>Book and Lesson evidence</h1><script>var M = {}; M.cfg = ${JSON.stringify({ wwwroot: `https://${request.headers.host}`, sesskey: "synthetic-session", userId: 3 })};</script></body>`); return; }
    if (url.pathname === "/lib/ajax/service.php") { request.resume(); response.writeHead(200, { "content-type": "application/json" }); response.end(stateResponse()); return; }
    if (url.pathname === "/question/edit.php") { response.writeHead(200, { "content-type": "text/html" }); response.end(`<!doctype html><body class="path-question course-2"><script>var M = {}; M.cfg = ${JSON.stringify({ wwwroot: `https://${request.headers.host}`, sesskey: "synthetic-session", userId: 3 })};</script><div data-filterregion="filtertypedata"><select data-field-name="category" data-field-title="Category" data-required="true"></select><select data-field-name="hidden" data-field-title="Hidden" data-required="false" data-filter-type-class="qbank/filter/hidden"></select></div></body>`); return; }
    if (url.pathname === "/repository/draftfiles_ajax.php") { request.resume(); response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ filecount: lesson.mediaNonempty ? 1 : 0, list: lesson.mediaNonempty ? [{ filename: "media.mp4" }] : [] })); return; }
    if (url.pathname === "/course/modedit.php") {
      if (request.method === "GET") { const form = url.searchParams.get("update") === "70" ? bookForm() : url.searchParams.get("update") === "71" ? lessonForm() : url.searchParams.get("update") === "72" && createdBook ? bookForm(createdBook, 72) : url.searchParams.get("update") === "73" && createdLesson ? lessonForm(createdLesson, 73) : url.searchParams.get("add") === "book" ? bookForm({ name: "", instructions: "", numbering: "1", customTitles: false, visible: true }, 0, true) : url.searchParams.get("add") === "lesson" ? lessonForm({ name: "", instructions: "", available: null, deadline: null, visible: true, mediaNonempty: false }, 0, true) : ""; if (!form) { response.writeHead(404).end(); return; } response.writeHead(200, { "content-type": "text/html" }); response.end(form); return; }
      const chunks = []; request.on("data", (chunk) => chunks.push(chunk)); request.on("end", () => { const values = new URLSearchParams(Buffer.concat(chunks).toString("utf8")); posts.push(values); if (values.get("update") === "70") { book.name = values.get("name") || ""; book.instructions = values.get("introeditor[text]") || ""; book.numbering = values.get("numbering") || ""; book.customTitles = values.get("customtitles") === "1"; response.writeHead(303, { location: "/course/view.php?id=2" }).end(); return; } if (values.get("update") === "71") { lesson.name = values.get("name") || ""; lesson.instructions = values.get("introeditor[text]") || ""; lesson.available = readDate(values, "available"); lesson.deadline = readDate(values, "deadline"); response.writeHead(303, { location: "/course/view.php?id=2" }).end(); return; } if (values.get("add") === "book") { createdBook = { name: values.get("name") || "", instructions: values.get("introeditor[text]") || "", numbering: values.get("numbering") || "", customTitles: values.get("customtitles") === "1", visible: false }; response.writeHead(303, { location: "/mod/book/view.php?id=72" }).end(); return; } if (values.get("add") === "lesson") { createdLesson = { name: values.get("name") || "", instructions: values.get("introeditor[text]") || "", available: readDate(values, "available"), deadline: readDate(values, "deadline"), visible: false, mediaNonempty: false }; response.writeHead(303, { location: "/mod/lesson/view.php?id=73" }).end(); return; } response.writeHead(404).end(); }); return;
    }
    if (url.pathname === "/mod/book/edit.php") {
      if (request.method === "GET") { const chapter = chapters.find((entry) => String(entry.id) === url.searchParams.get("id")); response.writeHead(200, { "content-type": "text/html" }); response.end(chapter ? chapterForm(chapter) : url.searchParams.get("pagenum") === "0" ? toc() : chapterForm(null, Number(url.searchParams.get("pagenum") || 0), url.searchParams.get("subchapter") === "1")); return; }
      const chunks = []; request.on("data", (chunk) => chunks.push(chunk)); request.on("end", () => { const values = new URLSearchParams(Buffer.concat(chunks).toString("utf8")); posts.push(values); const chapter = chapters.find((entry) => String(entry.id) === values.get("id")); const subchapter = values.get("subchapter") === "1"; if (chapter) { chapter.title = values.get("title") || ""; chapter.content = values.get("content_editor[text]") || ""; response.writeHead(303, { location: `/mod/book/view.php?id=70&chapterid=${chapter.id}` }).end(); return; } const created = { id: nextChapterId++, title: values.get("title") || "", content: values.get("content_editor[text]") || "", subchapter, hidden: false }; chapters.splice(Number(values.get("pagenum") || 1) - 1, 0, created); response.writeHead(303, { location: `/mod/book/view.php?id=70&chapterid=${created.id}` }).end(); }); return;
    }
    if (url.pathname === "/mod/book/move.php") { const index = chapters.findIndex((chapter) => String(chapter.id) === url.searchParams.get("chapterid")); if (index >= 0 && !chapters[index].subchapter && url.searchParams.get("up") === "1") { let end = index + 1; while (end < chapters.length && chapters[end].subchapter) end += 1; let prior = index - 1; while (prior >= 0 && chapters[prior].subchapter) prior -= 1; const target = chapters.splice(index, end - index); chapters.splice(Math.max(prior, 0), 0, ...target); } response.writeHead(303, { location: `/mod/book/view.php?id=70&chapterid=${url.searchParams.get("chapterid")}` }).end(); return; }
    if (url.pathname === "/mod/book/show.php") { const index = chapters.findIndex((chapter) => String(chapter.id) === url.searchParams.get("chapterid")); if (index >= 0 && url.searchParams.get("id") === "70" && url.searchParams.get("sesskey") === "synthetic-session") { const hidden = !chapters[index].hidden; chapters[index].hidden = hidden; if (!chapters[index].subchapter) for (let next = index + 1; next < chapters.length && chapters[next].subchapter; next += 1) chapters[next].hidden = hidden; } response.writeHead(303, { location: `/mod/book/view.php?id=70&chapterid=${url.searchParams.get("chapterid")}` }).end(); return; }
    if (url.pathname === "/mod/book/delete.php") { const index = chapters.findIndex((chapter) => String(chapter.id) === url.searchParams.get("chapterid")); if (index >= 0 && url.searchParams.get("id") === "70" && url.searchParams.get("confirm") === "1" && url.searchParams.get("sesskey") === "synthetic-session") { chapterDeleteRequests += 1; let count = 1; if (!chapters[index].subchapter) while (chapters[index + count]?.subchapter) count += 1; chapters.splice(index, count); } response.writeHead(303, { location: "/mod/book/view.php?id=70" }).end(); return; }
    if (url.pathname === "/mod/book/view.php") { response.writeHead(200, { "content-type": "text/html" }); response.end("<!doctype html><body>Saved</body>"); return; }
    if (url.pathname === "/mod/lesson/view.php") { response.writeHead(200, { "content-type": "text/html" }); response.end("<!doctype html><body>Saved</body>"); return; }
    response.writeHead(404).end();
  });
  let browser;
  let context;
  try {
    await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Book and Lesson test server did not bind a port");
    const origin = `https://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await page.goto(`${origin}/course/view.php?id=2`);
    await page.evaluate((wwwroot) => { globalThis.M = { cfg: { wwwroot, sesskey: "synthetic-session", userId: 3, courseId: 2 } }; }, origin);
    const binding = { origin, siteUrl: `${origin}/`, principalId: "3", courseId: "2" };
    const execute = (operation, args) => executeInBrowser(page, { mode: "execute", operation, arguments: args, binding, expiresAt: Date.now() + 60_000 });
    const readBook = await execute(bookRead, { course_id: 2, module_id: 70 });
    assert.deepEqual([readBook.data.numbering, readBook.data.custom_titles], ["1", false]);
    const updatedBook = await execute(bookWrite, { course_id: 2, module_id: 70, numbering: "2", custom_titles: true, expected_digest: readBook.snapshot_digest });
    assert.equal(updatedBook.ok, true, JSON.stringify(updatedBook));
    const bookPreparation = await execute(bookCreateRead, { course_id: 2, section_id: 7 });
    const createdBookResult = await execute(bookCreate, { course_id: 2, section_id: 7, name: "Created Book", instructions: "<p>Prepared Book intro.</p>", numbering: "1", custom_titles: false, expected_digest: bookPreparation.snapshot_digest });
    assert.equal(createdBookResult.ok, true, JSON.stringify(createdBookResult));
    const readLesson = await execute(lessonRead, { course_id: 2, module_id: 71 });
    const updatedLesson = await execute(lessonWrite, { course_id: 2, module_id: 71, available_from: { year: 2026, month: 9, day: 7, hour: 9, minute: 30 }, deadline: { year: 2026, month: 9, day: 8, hour: 9, minute: 30 }, expected_digest: readLesson.snapshot_digest });
    assert.equal(updatedLesson.ok, true, JSON.stringify(updatedLesson));
    const lessonPreparation = await execute(lessonCreateRead, { course_id: 2, section_id: 7 });
    const createdLessonResult = await execute(lessonCreate, { course_id: 2, section_id: 7, name: "Created Lesson", instructions: "<p>Prepared Lesson intro.</p>", available_from: null, deadline: null, expected_digest: lessonPreparation.snapshot_digest });
    assert.equal(createdLessonResult.ok, true, JSON.stringify(createdLessonResult));
    lesson.mediaNonempty = true;
    const lockedLesson = await execute(lessonRead, { course_id: 2, module_id: 71 });
    const postsBeforeMediaRefusal = posts.length;
    assert.deepEqual(await execute(lessonWrite, { course_id: 2, module_id: 71, name: "Must not save", expected_digest: lockedLesson.snapshot_digest }), { ok: false, sent: false, error: "moodle_filemanager_nonempty" });
    assert.equal(posts.length, postsBeforeMediaRefusal);
    lesson.mediaNonempty = false;
    const initial = await execute(listChapters, { course_id: 2, module_id: 70 });
    assert.deepEqual(initial.data.chapters.map((chapter) => [chapter.chapter_id, chapter.subchapter, chapter.hidden]), [[301, false, false], [302, true, false], [303, false, false]]);
    const hidden = await execute(chapterHide, { course_id: 2, module_id: 70, chapter_id: 301, expected_digest: initial.snapshot_digest });
    assert.equal(hidden.ok, true, JSON.stringify(hidden));
    assert.deepEqual(hidden.data.chapters.map((chapter) => [chapter.chapter_id, chapter.hidden]), [[301, true], [302, true], [303, false]]);
    const shown = await execute(chapterShow, { course_id: 2, module_id: 70, chapter_id: 301, expected_digest: hidden.snapshot_digest });
    assert.equal(shown.ok, true, JSON.stringify(shown));
    assert.deepEqual(shown.data.chapters.map((chapter) => [chapter.chapter_id, chapter.hidden]), [[301, false], [302, false], [303, false]]);
    const beforeVisibilityRefusal = posts.length;
    assert.deepEqual(await execute(chapterShow, { course_id: 2, module_id: 70, chapter_id: 301, expected_digest: shown.snapshot_digest }), { ok: false, sent: false, error: "moodle_book_chapter_already_visible" });
    assert.equal(posts.length, beforeVisibilityRefusal);
    const chapter = await execute(chapterRead, { course_id: 2, module_id: 70, chapter_id: 302 });
    const changedChapter = await execute(chapterWrite, { course_id: 2, module_id: 70, chapter_id: 302, title: "Evidence details", expected_digest: chapter.snapshot_digest });
    assert.equal(changedChapter.ok, true, JSON.stringify(changedChapter));
    const createForm = await execute(chapterCreateRead, { course_id: 2, module_id: 70, after_chapter_id: 302, subchapter: true });
    const created = await execute(chapterCreate, { course_id: 2, module_id: 70, after_chapter_id: 302, subchapter: true, title: "More evidence", content: "<p>Use the original source.</p>", expected_digest: createForm.snapshot_digest });
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.equal(created.data.chapter_id, 304);
    const beforeMove = await execute(listChapters, { course_id: 2, module_id: 70 });
    const moved = await execute(chapterMove, { course_id: 2, module_id: 70, chapter_id: 303, direction: "up", expected_digest: beforeMove.snapshot_digest });
    assert.equal(moved.ok, true, JSON.stringify(moved));
    assert.deepEqual(moved.data.chapters.map((entry) => entry.chapter_id), [303, 301, 302, 304]);
    const refusalDigest = (await execute(listChapters, { course_id: 2, module_id: 70 })).snapshot_digest;
    const postsBeforeMoveRefusal = posts.length;
    assert.deepEqual(await execute(chapterMove, { course_id: 2, module_id: 70, chapter_id: 302, direction: "up", expected_digest: refusalDigest }), { ok: false, sent: false, error: "moodle_book_chapter_move_unavailable" });
    assert.equal(posts.length, postsBeforeMoveRefusal);
    const beforeDelete = await execute(listChapters, { course_id: 2, module_id: 70 });
    assert.deepEqual(await execute(chapterDelete, { course_id: 2, module_id: 70, chapter_id: 301, expected_digest: beforeMove.snapshot_digest }), { ok: false, sent: false, error: "moodle_expected_digest_mismatch" });
    assert.equal(chapterDeleteRequests, 0);
    const deleted = await execute(chapterDelete, { course_id: 2, module_id: 70, chapter_id: 301, expected_digest: beforeDelete.snapshot_digest });
    assert.equal(deleted.ok, true, JSON.stringify(deleted));
    assert.equal(chapterDeleteRequests, 1);
    assert.deepEqual(deleted.data.chapters.map((entry) => entry.chapter_id), [303]);
    assert.deepEqual(await execute(chapterDelete, { course_id: 2, module_id: 70, chapter_id: 301, expected_digest: deleted.snapshot_digest }), { ok: false, sent: false, error: "moodle_book_chapter_delete_unavailable" });
    assert.equal(chapterDeleteRequests, 1);
    await page.goto(`${origin}/question/edit.php?cmid=74`);
    const inventory = await execute(filterInventory, { course_id: 2, module_id: 74 });
    assert.deepEqual(inventory.data, {
      course_id: 2, module_id: 74, module_type: "qbank",
      filter_conditions: [{ key: "category", title: "Category", required: true }, { key: "hidden", title: "Hidden", required: false, javascript_filter_class: "qbank/filter/hidden" }],
      provider_condition_classes: "not_exposed", plugin_components: "not_exposed", question_bank_isolation_eligible: false,
      reason: "moodle_qbank_filter_class_inventory_unavailable",
    });
  } finally {
    await context?.close();
    await browser?.close();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Moodle executor verifies hidden Glossary, Wiki, Feedback, and Database settings over HTTPS", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-settings-browser-"));
  const key = join(directory, "key.pem");
  const certificate = join(directory, "certificate.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", certificate], { stdio: "ignore" });
  const operation = (keyValue, toolName, readOnly) => ({ key: keyValue, toolName, provider: "moodle", readOnly });
  const glossaryRead = operation("moodle.form.course.modedit.glossary.read.v1", "moodle_get_glossary", true);
  const glossaryWrite = operation("moodle.form.course.modedit.glossary.write.v1", "moodle_update_glossary", false);
  const glossaryCreateRead = operation("moodle.form.course.modedit.glossary.create.read.v1", "moodle_get_glossary_creation_form", true);
  const glossaryCreate = operation("moodle.form.course.modedit.glossary.create.write.v1", "moodle_create_glossary", false);
  const wikiRead = operation("moodle.form.course.modedit.wiki.read.v1", "moodle_get_wiki", true);
  const wikiWrite = operation("moodle.form.course.modedit.wiki.write.v1", "moodle_update_wiki", false);
  const wikiCreateRead = operation("moodle.form.course.modedit.wiki.create.read.v1", "moodle_get_wiki_creation_form", true);
  const wikiCreate = operation("moodle.form.course.modedit.wiki.create.write.v1", "moodle_create_wiki", false);
  const feedbackRead = operation("moodle.form.course.modedit.feedback.read.v1", "moodle_get_feedback", true);
  const feedbackWrite = operation("moodle.form.course.modedit.feedback.write.v1", "moodle_update_feedback", false);
  const feedbackCreateRead = operation("moodle.form.course.modedit.feedback.create.read.v1", "moodle_get_feedback_creation_form", true);
  const feedbackCreate = operation("moodle.form.course.modedit.feedback.create.write.v1", "moodle_create_feedback", false);
  const databaseRead = operation("moodle.form.course.modedit.data.read.v1", "moodle_get_database", true);
  const databaseWrite = operation("moodle.form.course.modedit.data.write.v1", "moodle_update_database", false);
  const databaseCreateRead = operation("moodle.form.course.modedit.data.create.read.v1", "moodle_get_database_creation_form", true);
  const databaseCreate = operation("moodle.form.course.modedit.data.create.write.v1", "moodle_create_database", false);
  const activities = new Map([
    ["glossary", { id: 80, name: "Field terms", instructions: "<p>Original glossary introduction.</p>", defaultApproval: true, allowComments: false, visible: true }],
    ["wiki", { id: 81, name: "Research notebook", instructions: "<p>Original wiki introduction.</p>", wikiMode: "collaborative", firstPageTitle: "Home", defaultFormat: "html", forceFormat: false, visible: true }],
    ["feedback", { id: 82, name: "Source check", instructions: "<p>Original feedback description.</p>", anonymous: "2", openAt: null, closeAt: null, visible: true }],
    ["data", { id: 83, name: "Evidence records", instructions: "<p>Original database introduction.</p>", approval: false, availableFrom: null, availableTo: null, visible: true }],
  ]);
  const posts = [];
  let nextModuleId = 90;
  let nonemptyDraft = false;
  let duplicateNativeIdentity = "";
  const date = (field, value) => `<input type="checkbox" name="${field}[enabled]" value="1"${value ? " checked" : ""}><input name="${field}[year]" value="${value?.year || 2026}"><input name="${field}[month]" value="${value?.month || 9}"><input name="${field}[day]" value="${value?.day || 7}"><input name="${field}[hour]" value="${value?.hour || 9}"><input name="${field}[minute]" value="${value?.minute || 30}">`;
  const select = (field, value, options) => `<select name="${field}">${options.map(([option, label]) => `<option value="${option}"${option === value ? " selected" : ""}>${label}</option>`).join("")}</select>`;
  const identity = (module, activity, creation) => {
    const fields = creation
      ? `<input name="course" value="2"><input name="add" value="${module}"><input name="modulename" value="${module}"><input name="section" value="4"><input name="return" value="0"><input name="coursecontentnotification" value="1">`
      : `<input name="update" value="${activity.id}"><input name="return" value="0"><input name="course" value="2"><input name="modulename" value="${module}"><input name="section" value="4">`;
    if (duplicateNativeIdentity === "update" && !creation) return `${fields}<input name="update" value="${activity.id}"><input name="course" value="2"><input name="modulename" value="${module}">`;
    if (duplicateNativeIdentity === "create" && creation) return `${fields}<input name="add" value="${module}"><input name="section" value="4">`;
    return fields;
  };
  const form = (module, activity, creation = false) => {
    const action = creation ? `/course/modedit.php?add=${module}&amp;course=2&amp;sectionid=7&amp;return=0` : `/course/modedit.php?update=${activity.id}&amp;return=0`;
    const intro = `<input name="name" value="${activity.name}"><textarea name="introeditor[text]">${activity.instructions}</textarea><input name="introeditor[format]" value="1"><input name="introeditor[itemid]" value="${9000 + activity.id}">`;
    const common = `<input name="visible" value="${activity.visible ? 1 : 0}"><input name="availability" value="${module}-availability"><input name="sesskey" value="synthetic-session"><input type="submit" name="submitbutton" value="Save and return to course">`;
    let controls = "";
    if (module === "glossary") controls = `${select("defaultapproval", activity.defaultApproval ? "1" : "0", [["0", "No"], ["1", "Yes"]])}${select("allowcomments", activity.allowComments ? "1" : "0", [["0", "No"], ["1", "Yes"]])}<input name="displayformat" value="dictionary">`;
    if (module === "wiki") controls = `${select("wikimode", activity.wikiMode, [["collaborative", "Collaborative"], ["individual", "Individual"]])}<input name="firstpagetitle" value="${activity.firstPageTitle}">${select("defaultformat", activity.defaultFormat, [["html", "HTML"], ["creole", "Creole"]])}<input type="checkbox" name="forceformat" value="1"${activity.forceFormat ? " checked" : ""}>`;
    if (module === "feedback") controls = `${date("timeopen", activity.openAt)}${date("timeclose", activity.closeAt)}${select("anonymous", activity.anonymous, [["1", "Anonymous"], ["2", "Named"]])}<textarea name="page_after_submit_editor[text]"></textarea><input name="page_after_submit_editor[format]" value="1"><input name="page_after_submit_editor[itemid]" value="${9100 + activity.id}"><input name="multiple_submit" value="0">`;
    if (module === "data") controls = `${select("approval", activity.approval ? "1" : "0", [["0", "No"], ["1", "Yes"]])}${date("timeavailablefrom", activity.availableFrom)}${date("timeavailableto", activity.availableTo)}<input name="requiredentriestoview" value="0">`;
    return `<!doctype html><html><body><form method="post" action="${action}">${identity(module, activity, creation)}${intro}${controls}${common}</form></body></html>`;
  };
  const readDate = (values, field) => values.has(`${field}[enabled]`) ? { year: Number(values.get(`${field}[year]`)), month: Number(values.get(`${field}[month]`)), day: Number(values.get(`${field}[day]`)), hour: Number(values.get(`${field}[hour]`)), minute: Number(values.get(`${field}[minute]`)) } : null;
  const stateResponse = () => JSON.stringify([{ data: JSON.stringify({ course: { id: 2, fullname: "Settings evidence" }, section: [{ id: 7, number: 4, title: "Evidence", component: "" }], cm: [...activities.entries()].map(([module, activity]) => ({ id: activity.id, module: activity.module || module, sectionid: 7, name: activity.name, visible: activity.visible })) }) }]);
  const apply = (module, activity, values) => {
    activity.name = values.get("name") || "";
    activity.instructions = values.get("introeditor[text]") || "";
    if (module === "glossary") { activity.defaultApproval = values.get("defaultapproval") === "1"; activity.allowComments = values.get("allowcomments") === "1"; }
    if (module === "wiki") { activity.wikiMode = values.get("wikimode") || ""; activity.firstPageTitle = values.get("firstpagetitle") || ""; activity.defaultFormat = values.get("defaultformat") || ""; activity.forceFormat = values.get("forceformat") === "1"; }
    if (module === "feedback") { activity.anonymous = values.get("anonymous") || ""; activity.openAt = readDate(values, "timeopen"); activity.closeAt = readDate(values, "timeclose"); }
    if (module === "data") { activity.approval = values.get("approval") === "1"; activity.availableFrom = readDate(values, "timeavailablefrom"); activity.availableTo = readDate(values, "timeavailableto"); }
  };
  const server = createServer({ key: readFileSync(key), cert: readFileSync(certificate) }, (request, response) => {
    const url = new URL(request.url || "/", "https://127.0.0.1");
    if (url.pathname === "/course/view.php") { response.writeHead(200, { "content-type": "text/html" }); response.end(`<!doctype html><body class="path-course course-2"><h1>Settings evidence</h1><script>var M = {}; M.cfg = ${JSON.stringify({ wwwroot: `https://${request.headers.host}`, sesskey: "synthetic-session", userId: 3 })};</script></body>`); return; }
    if (url.pathname === "/lib/ajax/service.php") { request.resume(); response.writeHead(200, { "content-type": "application/json" }); response.end(stateResponse()); return; }
    if (url.pathname === "/repository/draftfiles_ajax.php") { request.resume(); response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ filecount: nonemptyDraft ? 1 : 0, list: nonemptyDraft ? [{ filename: "protected.png" }] : [] })); return; }
    if (url.pathname === "/course/modedit.php") {
      const existing = [...activities.entries()].find(([, activity]) => String(activity.id) === url.searchParams.get("update"));
      const module = url.searchParams.get("add") || existing?.[1]?.module || existing?.[0];
      if (!module) { response.writeHead(404).end(); return; }
      if (request.method === "GET") { const activity = url.searchParams.get("add") ? ({ id: 0, name: "", instructions: "", defaultApproval: false, allowComments: false, wikiMode: "collaborative", firstPageTitle: "Home", defaultFormat: "html", forceFormat: false, anonymous: "2", openAt: null, closeAt: null, approval: false, availableFrom: null, availableTo: null, visible: true }) : existing?.[1]; response.writeHead(200, { "content-type": "text/html" }); response.end(form(module, activity, Boolean(url.searchParams.get("add")))); return; }
      const chunks = []; request.on("data", (chunk) => chunks.push(chunk)); request.on("end", () => { const values = new URLSearchParams(Buffer.concat(chunks).toString("utf8")); posts.push(values); let activity = existing?.[1]; if (values.get("add")) { activity = { id: nextModuleId++, visible: false, module }; activities.set(`${module}-${activity.id}`, activity); } apply(module, activity, values); response.writeHead(303, { location: `/mod/${module}/view.php?id=${activity.id}` }).end(); }); return;
    }
    if (/^\/mod\/(glossary|wiki|feedback|data)\/view\.php$/.test(url.pathname)) { response.writeHead(200, { "content-type": "text/html" }); response.end("<!doctype html><body>Saved</body>"); return; }
    response.writeHead(404).end();
  });
  let browser;
  let context;
  try {
    await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Settings test server did not bind a port");
    const origin = `https://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await page.goto(`${origin}/course/view.php?id=2`);
    await page.evaluate((wwwroot) => { globalThis.M = { cfg: { wwwroot, sesskey: "synthetic-session", userId: 3, courseId: 2 } }; }, origin);
    const binding = { origin, siteUrl: `${origin}/`, principalId: "3", courseId: "2" };
    const execute = (entry, argumentsValue) => executeInBrowser(page, { mode: "execute", operation: entry, arguments: argumentsValue, binding, expiresAt: Date.now() + 60_000 });
    const glossary = await execute(glossaryRead, { course_id: 2, module_id: 80 });
    assert.equal((await execute(glossaryWrite, { course_id: 2, module_id: 80, default_approval: false, allow_comments: true, expected_digest: glossary.snapshot_digest })).ok, true);
    const glossaryPreparation = await execute(glossaryCreateRead, { course_id: 2, section_id: 7 });
    assert.equal(glossaryPreparation.ok, true, JSON.stringify(glossaryPreparation));
    const createdGlossary = await execute(glossaryCreate, { course_id: 2, section_id: 7, name: "Created terms", instructions: "<p>Reviewed terms.</p>", default_approval: true, allow_comments: false, expected_digest: glossaryPreparation.snapshot_digest });
    assert.equal(createdGlossary.ok, true, JSON.stringify(createdGlossary));
    const wiki = await execute(wikiRead, { course_id: 2, module_id: 81 });
    assert.equal((await execute(wikiWrite, { course_id: 2, module_id: 81, default_format: "creole", force_format: true, expected_digest: wiki.snapshot_digest })).ok, true);
    const wikiPreparation = await execute(wikiCreateRead, { course_id: 2, section_id: 7 });
    const createdWiki = await execute(wikiCreate, { course_id: 2, section_id: 7, name: "Created notebook", instructions: "<p>Reviewed notebook.</p>", wiki_mode: "collaborative", first_page_title: "Evidence home", default_format: "html", force_format: false, expected_digest: wikiPreparation.snapshot_digest });
    assert.equal(createdWiki.ok, true, JSON.stringify(createdWiki));
    const feedback = await execute(feedbackRead, { course_id: 2, module_id: 82 });
    assert.equal((await execute(feedbackWrite, { course_id: 2, module_id: 82, anonymous: "1", open_at: { year: 2026, month: 9, day: 7, hour: 9, minute: 30 }, close_at: { year: 2026, month: 9, day: 8, hour: 9, minute: 30 }, expected_digest: feedback.snapshot_digest })).ok, true);
    const feedbackPreparation = await execute(feedbackCreateRead, { course_id: 2, section_id: 7 });
    assert.equal((await execute(feedbackCreate, { course_id: 2, section_id: 7, name: "Created source check", instructions: "<p>Reviewed source check.</p>", anonymous: "2", open_at: null, close_at: null, expected_digest: feedbackPreparation.snapshot_digest })).ok, true);
    const database = await execute(databaseRead, { course_id: 2, module_id: 83 });
    assert.equal((await execute(databaseWrite, { course_id: 2, module_id: 83, approval: true, available_from: { year: 2026, month: 9, day: 7, hour: 9, minute: 30 }, available_to: { year: 2026, month: 9, day: 8, hour: 9, minute: 30 }, expected_digest: database.snapshot_digest })).ok, true);
    const databasePreparation = await execute(databaseCreateRead, { course_id: 2, section_id: 7 });
    assert.equal((await execute(databaseCreate, { course_id: 2, section_id: 7, name: "Created records", instructions: "<p>Reviewed records.</p>", approval: false, available_from: null, available_to: null, expected_digest: databasePreparation.snapshot_digest })).ok, true);

    const duplicateUpdateRead = await execute(glossaryRead, { course_id: 2, module_id: 80 });
    const postsBeforeDuplicateUpdate = posts.length;
    duplicateNativeIdentity = "update";
    assert.deepEqual(await execute(glossaryWrite, { course_id: 2, module_id: 80, name: "Must not send duplicate update", expected_digest: duplicateUpdateRead.snapshot_digest }), { ok: false, sent: false, status: 200, error: "moodle_form_target_invalid" });
    assert.equal(posts.length, postsBeforeDuplicateUpdate, "duplicate update, course, and modulename fields must refuse before POST");
    duplicateNativeIdentity = "";

    const duplicateCreateRead = await execute(wikiCreateRead, { course_id: 2, section_id: 7 });
    const postsBeforeDuplicateCreate = posts.length;
    duplicateNativeIdentity = "create";
    assert.deepEqual(await execute(wikiCreate, { course_id: 2, section_id: 7, name: "Must not send duplicate create", instructions: "<p>Duplicate identity.</p>", wiki_mode: "collaborative", first_page_title: "Duplicate", default_format: "html", force_format: false, expected_digest: duplicateCreateRead.snapshot_digest }), { ok: false, sent: false, status: 200, error: "moodle_form_target_invalid" });
    assert.equal(posts.length, postsBeforeDuplicateCreate, "duplicate add and section fields must refuse before POST");
    duplicateNativeIdentity = "";

    nonemptyDraft = true;
    const protectedGlossary = await execute(glossaryRead, { course_id: 2, module_id: 80 });
    const postsBeforeRefusal = posts.length;
    assert.deepEqual(await execute(glossaryWrite, { course_id: 2, module_id: 80, name: "Must not save", expected_digest: protectedGlossary.snapshot_digest }), { ok: false, sent: false, error: "moodle_filemanager_nonempty" });
    assert.equal(posts.length, postsBeforeRefusal);
  } finally {
    await context?.close();
    await browser?.close();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Moodle executor rejects expired work before it calls Moodle", async () => {
  await withMoodlePage(async () => {
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; throw new Error("must not run"); };
    assert.deepEqual(await executeMoodleInPage(JSON.stringify(listInput(Date.now() - 1))), { ok: false, sent: false, error: "moodle_execution_expired" });
    assert.equal(calls, 0);
  });
});

test("Moodle Resource file creation verifies native bytes and refuses a mismatched draft", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-resource-browser-"));
  const key = join(directory, "key.pem");
  const certificate = join(directory, "certificate.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", certificate], { stdio: "ignore" });
  const bytes = Buffer.from("Morrow Resource bytes\\n", "utf8");
  const manifest = { filename: "evidence.txt", size_bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
  const requests = [];
  const resourcePosts = [];
  const drafts = new Map();
  let nextDraft = 100;
  let created = null;
  let mismatch = true;
  let origin = "";
  let nativeMaxBytes = -1;
  let managerTarget = "id_files";
  const managerConfig = (itemId) => ({ target: managerTarget, itemid: itemId, context: { id: 77 }, mainfile: true, maxfiles: -1, maxbytes: nativeMaxBytes, areamaxbytes: -1, accepted_types: "*", filepicker: { repositories: { 17: { id: "17", type: "upload" } } } });
  const creationForm = (itemId) => `<!doctype html><html><body><form method="post" action="/course/modedit.php?add=resource&amp;course=2&amp;sectionid=7&amp;return=0">
    <input name="course" value="2"><input name="add" value="resource"><input name="modulename" value="resource"><input name="section" value="4"><input name="return" value="0"><input name="name" value=""><input name="visible" value="1"><input name="revision" value="1"><input name="coursecontentnotification" value="1"><textarea name="introeditor[text]"></textarea><input name="introeditor[format]" value="1"><input name="introeditor[itemid]" value="6000"><div data-fieldtype="filemanager"><input type="hidden" id="id_files" name="files" value="${itemId}"></div><input type="submit" name="submitbutton" value="Save and display"><input type="submit" name="submitbutton2" value="Save changes and return to course"><input name="sesskey" value="synthetic-session"></form><script>M.form_filemanager.init(Y, ${JSON.stringify({ ...managerConfig(itemId), author: "Morrow" })});</script></body></html>`;
  const savedForm = (itemId) => `<!doctype html><html><body><form method="post" action="/course/modedit.php?update=99&amp;return=0">
    <input name="update" value="99"><input name="course" value="2"><input name="modulename" value="resource"><input name="name" value="Evidence resource"><input name="visible" value="0"><input name="revision" value="1"><textarea name="introeditor[text]"></textarea><input name="introeditor[format]" value="1"><input name="introeditor[itemid]" value="6000"><div data-fieldtype="filemanager"><input type="hidden" id="id_files" name="files" value="${itemId}"></div><input type="submit" name="submitbutton2" value="Save changes and return to course"><input name="sesskey" value="synthetic-session"></form><script>M.form_filemanager.init(Y, ${JSON.stringify(managerConfig(itemId))});</script></body></html>`;
  const responseState = () => JSON.stringify([{ data: JSON.stringify({
    course: { id: 2, fullname: "Evidence course" }, section: [{ id: 7, number: 4, title: "Evidence section", component: "", visible: true, hasrestrictions: false }],
    cm: created ? [{ id: 99, module: "resource", sectionid: 7, name: created.name, visible: false }] : [],
  }) }]);
  const server = createServer({ key: readFileSync(key), cert: readFileSync(certificate) }, (request, response) => {
    const url = new URL(request.url || "/", origin || "https://127.0.0.1");
    requests.push(`${request.method} ${url.pathname}${url.search}`);
    if (url.pathname === "/course/view.php") { response.writeHead(200, { "content-type": "text/html" }); response.end('<!doctype html><body class="path-course course-2"><h1>Evidence course</h1></body>'); return; }
    if (url.pathname === "/lib/ajax/service.php") { request.resume(); request.on("end", () => { response.writeHead(200, { "content-type": "application/json" }); response.end(responseState()); }); return; }
    if (url.pathname === "/repository/draftfiles_ajax.php") {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const itemId = new URLSearchParams(Buffer.concat(chunks).toString("utf8")).get("itemid") || "";
        const draft = drafts.get(itemId);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(draft ? { filecount: 1, list: [{ filename: manifest.filename, filepath: "/", type: "file", size: manifest.size_bytes, sortorder: 1, mimetype: "text/plain" }], tree: { children: [] } } : { filecount: 0, list: [], tree: { children: [] } }));
      });
      return;
    }
    if (url.pathname === "/repository/repository_ajax.php") {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const payload = Buffer.concat(chunks).toString("latin1");
        const itemId = payload.match(/name="itemid"\r\n\r\n([0-9]+)/)?.[1] || "";
        if (!itemId) { response.writeHead(400).end(); return; }
        drafts.set(itemId, mismatch ? Buffer.from("not the reviewed file", "utf8") : bytes);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: Number(itemId), file: manifest.filename, url: `${origin}/draftfile.php/3/user/draft/${itemId}/${manifest.filename}` }));
      });
      return;
    }
    if (url.pathname.startsWith("/draftfile.php/")) {
      const itemId = url.pathname.split("/")[5] || "";
      const draft = drafts.get(itemId);
      if (!draft) { response.writeHead(404).end(); return; }
      response.writeHead(200, { "content-type": "text/plain", "content-length": draft.byteLength }); response.write(draft); response.end(); return;
    }
    if (url.pathname === "/pluginfile.php/77/mod_resource/content/1/evidence.txt") {
      response.writeHead(200, { "content-type": "application/octet-stream", "content-length": bytes.byteLength }); response.end(bytes); return;
    }
    if (url.pathname === "/course/modedit.php" && request.method === "GET") {
      if (url.searchParams.get("add") === "resource") { response.writeHead(200, { "content-type": "text/html" }); response.end(creationForm(++nextDraft)); return; }
      if (url.searchParams.get("update") === "99" && created) { response.writeHead(200, { "content-type": "text/html" }); response.end(savedForm(created.itemId)); return; }
      response.writeHead(404).end(); return;
    }
    if (url.pathname === "/course/modedit.php" && request.method === "POST") {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const values = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        resourcePosts.push(values);
        created = { name: values.get("name") || "", itemId: values.get("files") || "" };
        response.writeHead(303, { location: "/course/view.php?id=2" }).end();
      });
      return;
    }
    response.writeHead(404).end();
  });
  let browser;
  let context;
  try {
    await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Resource test server did not bind a port");
    origin = `https://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await page.goto(`${origin}/course/view.php?id=2`);
    await page.evaluate((wwwroot) => { globalThis.M = { cfg: { wwwroot, sesskey: "synthetic-session", userId: 3, courseId: 2 } }; }, origin);
    const binding = { origin, siteUrl: `${origin}/`, principalId: "3", courseId: "2" };
    const attachment = { schema: "morrow.private-file-attachment.v1", handle: "file:resource-attachment-1", manifest, bytes_base64: bytes.toString("base64") };
    const executeResourceCreate = (expectedDigest) => executeInBrowser(page, {
      mode: "execute",
      operation: resourceFileCreationWriteOperation,
      arguments: { course_id: 2, section_id: 7, name: "Evidence resource", ...manifest, expected_digest: expectedDigest },
      privateAttachment: attachment,
      binding,
      expiresAt: Date.now() + 60_000,
    });
    managerTarget = "files";
    const wrongManager = await executeInBrowser(page, { mode: "execute", operation: resourceFileCreationReadOperation, arguments: { course_id: 2, section_id: 7 }, binding, expiresAt: Date.now() + 60_000 });
    assert.equal(wrongManager.error, "moodle_resource_creation_form_invalid");
    managerTarget = "id_files";
    nativeMaxBytes = bytes.byteLength - 1;
    const limitedPreparation = await executeInBrowser(page, { mode: "execute", operation: resourceFileCreationReadOperation, arguments: { course_id: 2, section_id: 7 }, binding, expiresAt: Date.now() + 60_000 });
    assert.equal(limitedPreparation.ok, true, JSON.stringify(limitedPreparation));
    assert.deepEqual(await executeResourceCreate(limitedPreparation.snapshot_digest), { ok: false, sent: false, error: "moodle_file_exceeds_native_limit" });
    assert.equal(resourcePosts.length, 0);
    assert.equal(requests.some((entry) => entry.startsWith("POST /repository/repository_ajax.php")), false);
    nativeMaxBytes = -1;
    const mismatchPreparation = await executeInBrowser(page, { mode: "execute", operation: resourceFileCreationReadOperation, arguments: { course_id: 2, section_id: 7 }, binding, expiresAt: Date.now() + 60_000 });
    assert.equal(mismatchPreparation.ok, true, JSON.stringify(mismatchPreparation));
    assert.deepEqual(mismatchPreparation.data, { course_id: 2, section_id: 7, name: "", visible: true });
    const mismatchResult = await executeResourceCreate(mismatchPreparation.snapshot_digest);
    assert.deepEqual([mismatchResult.ok, mismatchResult.sent, mismatchResult.error, mismatchResult.verification], [
      false,
      true,
      "moodle_resource_upload_succeeded_save_not_sent",
      { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_resource_upload_succeeded_save_not_sent" },
    ]);
    assert.equal(resourcePosts.length, 0);
    assert.equal(requests.filter((entry) => entry === "POST /repository/repository_ajax.php?action=upload").length, 1);
    assert.equal(requests.some((entry) => entry.startsWith("GET /pluginfile.php/")), false);

    mismatch = false;
    const preparation = await executeInBrowser(page, { mode: "execute", operation: resourceFileCreationReadOperation, arguments: { course_id: 2, section_id: 7 }, binding, expiresAt: Date.now() + 60_000 });
    assert.equal(preparation.ok, true, JSON.stringify(preparation));
    const result = await executeResourceCreate(preparation.snapshot_digest);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.verification, { schema: "morrow.browser-verification.v1", status: "verified" });
    assert.deepEqual(result.data, {
      course_id: 2,
      section_id: 7,
      module_id: 99,
      name: "Evidence resource",
      visible: false,
      file: manifest,
    });
    assert.deepEqual(result.targets, [
      { field: "course_id", label: "Course", name: "Evidence course" },
      { field: "section_id", label: "Section", name: "Evidence section" },
    ]);
    assert.equal(resourcePosts.length, 1);
    const post = resourcePosts[0];
    assert.equal(post.get("course"), "2");
    assert.equal(post.get("add"), "resource");
    assert.equal(post.get("modulename"), "resource");
    assert.equal(post.get("section"), "4");
    assert.equal(post.get("name"), "Evidence resource");
    assert.equal(post.get("visible"), "0");
    assert.match(post.get("files") || "", /^[1-9][0-9]*$/);
    assert.equal(post.get("coursecontentnotification"), null);
    assert.equal(post.get("submitbutton"), null);
    assert.equal(post.get("submitbutton2"), "Save changes and return to course");
    assert.equal(post.toString().includes(attachment.bytes_base64), false);
    const uploadIndices = requests.map((entry, index) => entry === "POST /repository/repository_ajax.php?action=upload" ? index : -1).filter((index) => index >= 0);
    const saveIndex = requests.findIndex((entry) => entry === "POST /course/modedit.php?add=resource&course=2&sectionid=7&return=0");
    const savedSettingsIndex = requests.findIndex((entry, index) => index > saveIndex && entry === "GET /course/modedit.php?update=99&return=0");
    const pluginfileIndex = requests.findIndex((entry, index) => index > savedSettingsIndex && entry === "GET /pluginfile.php/77/mod_resource/content/1/evidence.txt?forcedownload=1");
    assert.equal(uploadIndices.length, 2);
    assert.ok(saveIndex > uploadIndices[1]);
    assert.ok(savedSettingsIndex > saveIndex);
    assert.ok(pluginfileIndex > savedSettingsIndex);
    assert.equal(requests.some((entry) => entry.startsWith("GET /mod/resource/view.php")), false);
    assert.equal(JSON.stringify([mismatchResult, result]).includes(attachment.bytes_base64), false);
  } finally {
    await context?.close();
    await browser?.close();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

const folderReadOperation = {
  key: "moodle.form.course.modedit.folder.read.v1",
  toolName: "moodle_get_folder",
  provider: "moodle",
  readOnly: true,
};
const folderFilesReadOperation = {
  key: "moodle.form.course.modedit.folder.files.read.v1",
  toolName: "moodle_get_folder_files",
  provider: "moodle",
  readOnly: true,
};
const folderFileCreationReadOperation = {
  key: "moodle.form.course.modedit.folder.file.create.read.v1",
  toolName: "moodle_get_folder_file_creation_form",
  provider: "moodle",
  readOnly: true,
};
const folderFileCreationWriteOperation = {
  key: "moodle.form.course.modedit.folder.file.create.write.v1",
  toolName: "moodle_create_folder_file",
  provider: "moodle",
  readOnly: false,
};

test("Moodle Folder recursively lists native drafts and verifies one hidden staged file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-folder-browser-"));
  const key = join(directory, "key.pem");
  const certificate = join(directory, "certificate.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", certificate], { stdio: "ignore" });
  const bytes = Buffer.from("Morrow Folder bytes\\n", "utf8");
  const manifest = { filename: "evidence.txt", size_bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
  const requests = [];
  const posts = [];
  const drafts = new Map();
  let nextDraft = 100;
  let created = null;
  let origin = "";
  let folderMainfile = "";
  const config = (itemId) => ({ target: "id_files", itemid: itemId, context: { id: 77 }, mainfile: folderMainfile, subdirs: 1, maxfiles: -1, maxbytes: -1, areamaxbytes: -1, accepted_types: "*", filepicker: { repositories: { 17: { id: "17", type: "upload" } } } });
  const folderControls = '<select name="display"><option value="0" selected>Page</option><option value="1">Inline</option></select><input type="checkbox" name="showexpanded" value="1" checked><input type="checkbox" name="showdownloadfolder" value="1" checked><input type="checkbox" name="forcedownload" value="1" checked>';
  const form = (itemId, add, update = 88) => `<!doctype html><html><body><form method="post" action="/course/modedit.php?${add ? "add=folder&amp;course=2&amp;sectionid=7&amp;return=0" : `update=${update}&amp;return=0`}">
    ${add ? '<input name="course" value="2"><input name="add" value="folder"><input name="modulename" value="folder"><input name="section" value="4"><input name="return" value="0">' : `<input name="update" value="${update}"><input name="course" value="2"><input name="modulename" value="folder">`}
    <input name="name" value="${add ? "" : "Evidence folder"}"><input name="visible" value="${add ? "1" : "0"}"><input name="revision" value="1"><textarea name="introeditor[text]"></textarea><input name="introeditor[format]" value="1"><input name="introeditor[itemid]" value="6000">${folderControls}<div data-fieldtype="filemanager"><input type="hidden" id="id_files" name="files" value="${itemId}"></div><input type="submit" name="submitbutton" value="Save and display"><input type="submit" name="submitbutton2" value="Save changes and return to course"><input name="sesskey" value="synthetic-session"></form><script>M.form_filemanager.init(Y, ${JSON.stringify(config(itemId))});</script></body></html>`;
  const tree = { children: [{ filepath: "/materials/", children: [] }] };
  const empty = { filecount: 0, list: [], tree: { children: [] } };
  const responseState = () => JSON.stringify([{ data: JSON.stringify({
    course: { id: 2, fullname: "Evidence course" }, section: [{ id: 7, number: 4, title: "Evidence section", component: "", visible: true, hasrestrictions: false }],
    cm: [{ id: 50, module: "folder", sectionid: 7, name: "Evidence folder", visible: true }, ...(created ? [{ id: 88, module: "folder", sectionid: 7, name: created.name, visible: false }] : [])],
  }) }]);
  const server = createServer({ key: readFileSync(key), cert: readFileSync(certificate) }, (request, response) => {
    const url = new URL(request.url || "/", origin || "https://127.0.0.1");
    requests.push(`${request.method} ${url.pathname}${url.search}`);
    if (url.pathname === "/course/view.php") { response.writeHead(200, { "content-type": "text/html" }); response.end('<!doctype html><body class="path-course course-2"></body>'); return; }
    if (url.pathname === "/lib/ajax/service.php") { request.resume(); request.on("end", () => { response.writeHead(200, { "content-type": "application/json" }); response.end(responseState()); }); return; }
    if (url.pathname === "/repository/draftfiles_ajax.php") {
      const chunks = []; request.on("data", (chunk) => chunks.push(chunk)); request.on("end", () => {
        const data = new URLSearchParams(Buffer.concat(chunks).toString("utf8")); const itemId = data.get("itemid") || ""; const filepath = data.get("filepath") || "/";
        let result = empty;
        if (itemId === "500") result = filepath === "/" ? { filecount: 2, list: [{ filename: "root.txt", filepath: "/", type: "file", size: 4, mimetype: "Text" }, { filename: ".", filepath: "/materials/", type: "folder", size: null }], tree } : filepath === "/materials/" ? { filecount: 2, list: [{ filename: "deep.txt", filepath: "/materials/", type: "file", size: 5, mimetype: "Text" }], tree } : empty;
        else if (drafts.has(itemId)) result = { filecount: 1, list: [{ filename: manifest.filename, filepath: "/", type: "file", size: manifest.size_bytes, mimetype: "Text" }], tree: { children: [] } };
        response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(result));
      }); return;
    }
    if (url.pathname === "/repository/repository_ajax.php") { const chunks = []; request.on("data", (chunk) => chunks.push(chunk)); request.on("end", () => { const payload = Buffer.concat(chunks).toString("latin1"); const itemId = payload.match(/name="itemid"\r\n\r\n([0-9]+)/)?.[1] || ""; if (!itemId) { response.writeHead(400).end(); return; } drafts.set(itemId, bytes); response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ id: Number(itemId), file: manifest.filename, url: `${origin}/draftfile.php/3/user/draft/${itemId}/${manifest.filename}` })); }); return; }
    if (url.pathname.startsWith("/draftfile.php/")) { const itemId = url.pathname.split("/")[5] || ""; const draft = drafts.get(itemId); if (!draft) { response.writeHead(404).end(); return; } response.writeHead(200, { "content-type": "application/octet-stream", "content-length": draft.byteLength }); response.end(draft); return; }
    if (url.pathname === "/pluginfile.php/77/mod_folder/content/1/evidence.txt") { response.writeHead(200, { "content-type": "application/octet-stream", "content-length": bytes.byteLength }); response.end(bytes); return; }
    if (url.pathname === "/course/modedit.php" && request.method === "GET") { if (url.searchParams.get("update") === "50") { response.writeHead(200, { "content-type": "text/html" }); response.end(form("500", false, 50)); return; } if (url.searchParams.get("add") === "folder") { response.writeHead(200, { "content-type": "text/html" }); response.end(form(String(++nextDraft), true)); return; } if (url.searchParams.get("update") === "88" && created) { response.writeHead(200, { "content-type": "text/html" }); response.end(form(created.itemId, false)); return; } response.writeHead(404).end(); return; }
    if (url.pathname === "/course/modedit.php" && request.method === "POST") { const chunks = []; request.on("data", (chunk) => chunks.push(chunk)); request.on("end", () => { const values = new URLSearchParams(Buffer.concat(chunks).toString("utf8")); posts.push(values); created = { name: values.get("name") || "", itemId: values.get("files") || "" }; response.writeHead(303, { location: "/course/view.php?id=2" }).end(); }); return; }
    response.writeHead(404).end();
  });
  let browser; let context;
  try {
    await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Folder test server did not bind a port"); origin = `https://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() }); context = await browser.newContext({ ignoreHTTPSErrors: true }); const page = await context.newPage(); await page.goto(`${origin}/course/view.php?id=2`); await page.evaluate((wwwroot) => { globalThis.M = { cfg: { wwwroot, sesskey: "synthetic-session", userId: 3, courseId: 2 } }; }, origin);
    const binding = { origin, siteUrl: `${origin}/`, principalId: "3", courseId: "2" };
    const base = { mode: "execute", binding, expiresAt: Date.now() + 60_000 };
    const folderSettings = await executeInBrowser(page, { ...base, operation: folderReadOperation, arguments: { course_id: 2, module_id: 50 } });
    assert.equal(folderSettings.ok, true, JSON.stringify(folderSettings));
    assert.deepEqual(folderSettings.data, { course_id: 2, module_id: 50, name: "Evidence folder", instructions: "", instructions_format: 1, display: "0", show_expanded: true, show_download_folder: true, force_download: true, file_state: "nonempty" });
    const listed = await executeInBrowser(page, { ...base, operation: folderFilesReadOperation, arguments: { course_id: 2, module_id: 50 } });
    assert.equal(listed.ok, true, JSON.stringify(listed));
    assert.deepEqual(listed.data.files, [{ filename: "deep.txt", relative_path: "materials/deep.txt", size_bytes: 5, media_type_label: "Text" }, { filename: "root.txt", relative_path: "root.txt", size_bytes: 4, media_type_label: "Text" }]);
    folderMainfile = true;
    assert.equal((await executeInBrowser(page, { ...base, operation: folderFileCreationReadOperation, arguments: { course_id: 2, section_id: 7 } })).error, "moodle_folder_creation_form_invalid");
    folderMainfile = "";
    const prepared = await executeInBrowser(page, { ...base, operation: folderFileCreationReadOperation, arguments: { course_id: 2, section_id: 7 } }); assert.equal(prepared.ok, true, JSON.stringify(prepared));
    const attachment = { schema: "morrow.private-file-attachment.v1", handle: "file:folder-attachment-1", manifest, bytes_base64: bytes.toString("base64") };
    const saved = await executeInBrowser(page, { ...base, operation: folderFileCreationWriteOperation, arguments: { course_id: 2, section_id: 7, name: "Evidence folder", ...manifest, expected_digest: prepared.snapshot_digest }, privateAttachment: attachment });
    assert.equal(saved.ok, true, JSON.stringify(saved)); assert.equal(posts.length, 1); const post = posts[0]; assert.equal(post.get("add"), "folder"); assert.equal(post.get("modulename"), "folder"); assert.equal(post.get("visible"), "0"); assert.equal(post.get("display"), "0"); assert.equal(post.get("showexpanded"), "1"); assert.equal(post.get("showdownloadfolder"), "1"); assert.equal(post.get("forcedownload"), "1"); assert.equal(requests.some((entry) => entry.startsWith("GET /mod/folder/view.php")), false); assert.ok(requests.includes("POST /repository/draftfiles_ajax.php?action=list")); assert.ok(requests.includes("POST /repository/draftfiles_ajax.php?action=list"));
  } finally { await context?.close(); await browser?.close(); await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); rmSync(directory, { recursive: true, force: true }); }
});

const QUIZ_REVIEW_FIELDS = [
  ["attempt", "attempt"], ["correctness", "correctness"], ["maximum_marks", "maxmarks"], ["marks", "marks"],
  ["specific_feedback", "specificfeedback"], ["general_feedback", "generalfeedback"], ["right_answer", "rightanswer"], ["overall_feedback", "overallfeedback"],
];
const QUIZ_REVIEW_WHENS = ["during", "immediately", "open", "closed"];
const QUIZ_SELECT_SETTINGS = {
  overduehandling: ["autosubmit", "graceperiod", "autoabandon"],
  gradecat: ["3", "4"],
  attempts: ["0", "1", "2", "3"],
  grademethod: ["1", "2", "3", "4"],
  questionsperpage: ["0", "1", "2", "5"],
  navmethod: ["free", "sequential"],
  shuffleanswers: ["0", "1"],
  preferredbehaviour: ["deferredfeedback", "adaptive", "immediatefeedback"],
  attemptonlast: ["0", "1"],
  showuserpicture: ["0", "1", "2"],
  decimalpoints: ["0", "1", "2", "3"],
  questiondecimalpoints: ["-1", "0", "1", "2"],
  showblocks: ["0", "1"],
  browsersecurity: ["-", "securewindow"],
};
const QUIZ_DURATION_FIELDS = ["timelimit", "graceperiod", "delay1", "delay2"];
const QUIZ_OVERRIDE_ATTEMPTS = ["0", "1", "2", "3"];

// Moodle re-renders a saved duration in the largest whole unit it fits.
function durationControls(field, seconds) {
  const unit = seconds === null ? 60 : seconds % 3600 === 0 ? 3600 : seconds % 60 === 0 ? 60 : 1;
  const units = [["1", "seconds"], ["60", "minutes"], ["3600", "hours"], ["86400", "days"]];
  const options = units.map(([value, label]) => `<option value="${value}"${Number(value) === unit ? ' selected="selected"' : ""}>${label}</option>`).join("");
  return `<input type="checkbox" name="${field}[enabled]" value="1"${seconds === null ? "" : " checked"}><input name="${field}[number]" value="${seconds === null ? 0 : seconds / unit}"><select name="${field}[timeunit]">${options}</select>`;
}

function quizFeedbackControls(quiz) {
  const parts = [`<input type="hidden" name="boundary_repeats" value="2">`];
  for (let index = 0; index < 3; index += 1) {
    const row = quiz.feedback[index] || { text: "", boundary: "" };
    parts.push(`<textarea name="feedbacktext[${index}][text]">${row.text}</textarea><input name="feedbacktext[${index}][format]" value="1"><input name="feedbacktext[${index}][itemid]" value="${7100 + index}">`);
    if (index < 2) parts.push(`<input name="feedbackboundaries[${index}]" value="${row.boundary}">`);
  }
  parts.push('<input type="hidden" name="feedbackboundarycount" value="2">');
  return parts.join("");
}

function quizSettingsForm(quiz) {
  const selects = Object.entries(QUIZ_SELECT_SETTINGS).map(([name, values]) => selectControl(name, quiz.selects[name], values)).join("");
  const durations = QUIZ_DURATION_FIELDS.map((field) => durationControls(field, quiz.durations[field])).join("");
  const review = QUIZ_REVIEW_FIELDS
    .flatMap(([argument, field]) => QUIZ_REVIEW_WHENS.map((when) => `<input type="checkbox" name="${field}${when}" value="1"${quiz.review[argument][when] ? " checked" : ""}>`))
    .join("");
  return `<!doctype html><html><body><form method="post" action="/course/modedit.php?update=9&amp;return=0">
    <input name="update" value="9"><input name="course" value="2"><input name="modulename" value="quiz"><input name="section" value="4">
    <input name="name" value="${quiz.name}"><textarea name="introeditor[text]">${quiz.instructions}</textarea><input name="introeditor[format]" value="1"><input name="introeditor[itemid]" value="7000">
    <input name="visible" value="1"><input type="hidden" name="grade" value="10.00"><input name="gradepass" value="${quiz.gradePass}">
    ${dateControls("timeopen", quiz.dates.timeopen)}${dateControls("timeclose", quiz.dates.timeclose)}
    ${durations}${selects}
    <input name="subnet" value="${quiz.subnet}"><input type="password" name="quizpassword" value="${quiz.password}">
    ${review}${quizFeedbackControls(quiz)}
    ${selectControl("seb_requiresafeexambrowser", quiz.safeExamBrowser, ["0", "1"])}
    <input type="hidden" name="sesskey" value="synthetic-session">
    <input type="submit" name="submitbutton" value="Save and return to course">
  </form></body></html>`;
}

function quizOverridesPage(overrides, mode) {
  const rows = overrides.filter((entry) => entry.scope === mode).map((entry) => `<tr><td>${mode === "group" ? entry.groupName : entry.userName}</td><td>Open the quiz</td><td>
      <a href="/mod/quiz/overrideedit.php?id=${entry.id}">Edit</a>
      <a href="/mod/quiz/overridedelete.php?id=${entry.id}&amp;sesskey=synthetic-session">Delete</a></td></tr>`).join("");
  return `<!doctype html><html><body class="path-mod-quiz course-2"><h2>Evidence quiz</h2>
    <table><tbody>${rows}</tbody></table>
    <form method="post" action="/mod/quiz/overrideedit.php"><input type="hidden" name="cmid" value="9"><input type="hidden" name="action" value="add${mode}"><input type="hidden" name="sesskey" value="synthetic-session"><button type="submit">Add override</button></form>
  </body></html>`;
}

function quizOverrideForm(entry, { scope, users, groups }) {
  const overrideScope = entry ? entry.scope : scope;
  const action = entry ? `/mod/quiz/overrideedit.php?id=${entry.id}` : `/mod/quiz/overrideedit.php?cmid=9&amp;action=add${overrideScope}`;
  const target = overrideScope === "group"
    ? `<select name="groupid">${groups.map((group) => `<option value="${group.id}"${entry && entry.groupId === group.id ? ' selected="selected"' : ""}>${group.name}</option>`).join("")}</select>`
    : `<select name="userid">${users.map((user) => `<option value="${user.id}"${entry && entry.userId === user.id ? ' selected="selected"' : ""}>${user.name}</option>`).join("")}</select>`;
  return `<!doctype html><html><body><form method="post" action="${action}">
    <input type="hidden" name="_qf__mod_quiz_form_edit_override_form" value="1">${entry ? `<input type="hidden" name="id" value="${entry.id}">` : ""}
    ${target}<input type="password" name="password" value="">
    ${dateControls("timeopen", entry ? entry.openAt : null)}${dateControls("timeclose", entry ? entry.closeAt : null)}
    ${durationControls("timelimit", entry ? entry.timeLimit : null)}
    ${selectControl("attempts", entry ? entry.attempts : "0", QUIZ_OVERRIDE_ATTEMPTS)}
    <textarea name="reason_editor[text]"></textarea><input name="reason_editor[format]" value="1"><input name="reason_editor[itemid]" value="7300">
    <input type="hidden" name="sesskey" value="synthetic-session">
    <input type="submit" name="submitbutton" value="Save"><input type="submit" name="againbutton" value="Save and enter another override">
  </form></body></html>`;
}

test("Moodle executor writes the complete Quiz settings scope and Quiz overrides over HTTPS", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-quiz-browser-"));
  const key = join(directory, "key.pem");
  const certificate = join(directory, "certificate.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", certificate], { stdio: "ignore" });
  const operation = (keyValue, toolName, readOnly) => ({ key: keyValue, toolName, provider: "moodle", readOnly });
  const quizRead = operation("moodle.form.course.modedit.quiz.read.v1", "moodle_get_quiz", true);
  const quizWrite = operation("moodle.form.course.modedit.quiz.write.v1", "moodle_update_quiz", false);
  const overridesRead = operation("moodle.form.mod.quiz.overrides.read.v1", "moodle_get_quiz_overrides", true);
  const overrideCreate = operation("moodle.form.mod.quiz.override.create.write.v1", "moodle_create_quiz_override", false);
  const overrideUpdate = operation("moodle.form.mod.quiz.override.write.v1", "moodle_update_quiz_override", false);
  const defaultReview = () => Object.fromEntries(QUIZ_REVIEW_FIELDS.map(([argument]) => [argument, {
    during: argument === "attempt", immediately: argument !== "overall_feedback", open: false, closed: false,
  }]));
  const quiz = {
    name: "Evidence quiz",
    instructions: "<p>Original brief</p>",
    gradePass: "0.00",
    subnet: "",
    password: "",
    safeExamBrowser: "0",
    dates: { timeopen: null, timeclose: null },
    durations: { timelimit: null, graceperiod: null, delay1: null, delay2: null },
    selects: {
      overduehandling: "autosubmit", gradecat: "3", attempts: "0", grademethod: "1", questionsperpage: "1",
      navmethod: "free", shuffleanswers: "1", preferredbehaviour: "deferredfeedback", attemptonlast: "0",
      showuserpicture: "0", decimalpoints: "2", questiondecimalpoints: "-1", showblocks: "0", browsersecurity: "-",
    },
    review: defaultReview(),
    feedback: [{ text: "", boundary: "" }, { text: "", boundary: "" }, { text: "", boundary: "" }],
  };
  const overrideUsers = [{ id: "9", name: "Robin Fields" }, { id: "10", name: "Sam Ortega" }];
  const overrideGroups = [{ id: "5", name: "Section A" }, { id: "6", name: "Section B" }];
  const overrides = [
    { id: 71, scope: "user", userId: "9", userName: "Robin Fields", openAt: null, closeAt: { year: 2026, month: 9, day: 12, hour: 17, minute: 0 }, timeLimit: null, attempts: "0" },
    { id: 72, scope: "group", groupId: "5", groupName: "Section A", openAt: null, closeAt: null, timeLimit: 1800, attempts: "2" },
  ];
  let nextOverrideId = 73;
  let driftProtectedField = false;
  const posts = [];
  const overridePosts = [];
  const requests = [];
  const readDate = (values, field) => values.get(`${field}[enabled]`) === "1"
    ? {
      year: Number(values.get(`${field}[year]`)), month: Number(values.get(`${field}[month]`)), day: Number(values.get(`${field}[day]`)),
      hour: Number(values.get(`${field}[hour]`)), minute: Number(values.get(`${field}[minute]`)),
    }
    : null;
  const readDuration = (values, field) => {
    if (values.get(`${field}[enabled]`) !== "1") return null;
    const seconds = Number(values.get(`${field}[number]`)) * Number(values.get(`${field}[timeunit]`));
    return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : null;
  };
  const applyQuiz = (values) => {
    quiz.name = values.get("name") || "";
    quiz.instructions = values.get("introeditor[text]") || "";
    quiz.dates = { timeopen: readDate(values, "timeopen"), timeclose: readDate(values, "timeclose") };
    for (const field of QUIZ_DURATION_FIELDS) quiz.durations[field] = readDuration(values, field);
    for (const name of Object.keys(QUIZ_SELECT_SETTINGS)) if (values.has(name)) quiz.selects[name] = values.get(name) || "";
    quiz.subnet = values.get("subnet") || "";
    if (values.has("quizpassword")) quiz.password = values.get("quizpassword") || "";
    quiz.review = Object.fromEntries(QUIZ_REVIEW_FIELDS.map(([argument, field]) => [
      argument, Object.fromEntries(QUIZ_REVIEW_WHENS.map((when) => [when, values.has(`${field}${when}`)])),
    ]));
    // quiz_process_options always adds the attempt to the during-attempt review
    // and always removes overall feedback from it.
    quiz.review.attempt.during = true;
    quiz.review.overall_feedback.during = false;
    quiz.feedback = [0, 1, 2].map((index) => {
      const raw = index < 2 ? (values.get(`feedbackboundaries[${index}]`) || "").trim() : "";
      return { text: values.get(`feedbacktext[${index}][text]`) || "", boundary: raw ? Number(raw).toFixed(2) : "" };
    });
    if (driftProtectedField) quiz.gradePass = "1.00";
  };
  const server = createServer({ key: readFileSync(key), cert: readFileSync(certificate) }, (request, response) => {
    const url = new URL(request.url || "/", "https://127.0.0.1");
    requests.push(`${request.method} ${url.pathname}${url.search}`);
    if (url.pathname === "/course/view.php") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><body class="path-course course-2"><h1>Quiz evidence</h1><script>var M = {}; M.cfg = ${JSON.stringify({ wwwroot: `https://${request.headers.host}`, sesskey: "synthetic-session", userId: 3 })};</script></body>`);
      return;
    }
    if (url.pathname === "/repository/draftfiles_ajax.php") {
      request.resume();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ filecount: 0, list: [] }));
      return;
    }
    if (url.pathname === "/course/modedit.php" && request.method === "GET") {
      if (url.searchParams.get("update") !== "9") { response.writeHead(404).end(); return; }
      response.writeHead(200, { "content-type": "text/html" });
      response.end(quizSettingsForm(quiz));
      return;
    }
    if (url.pathname === "/course/modedit.php" && request.method === "POST") {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const values = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        posts.push(values);
        applyQuiz(values);
        response.writeHead(303, { location: "/course/view.php?id=2" }).end();
      });
      return;
    }
    if (url.pathname === "/mod/quiz/overrides.php" && request.method === "GET") {
      const mode = url.searchParams.get("mode");
      if (url.searchParams.get("cmid") !== "9" || !["user", "group"].includes(mode)) { response.writeHead(404).end(); return; }
      response.writeHead(200, { "content-type": "text/html" });
      response.end(quizOverridesPage(overrides, mode));
      return;
    }
    if (url.pathname === "/mod/quiz/overrideedit.php" && request.method === "GET") {
      const action = url.searchParams.get("action");
      const entry = overrides.find((candidate) => String(candidate.id) === url.searchParams.get("id"));
      if (!entry && !(url.searchParams.get("cmid") === "9" && ["adduser", "addgroup"].includes(action))) { response.writeHead(404).end(); return; }
      response.writeHead(200, { "content-type": "text/html" });
      response.end(quizOverrideForm(entry || null, { scope: action === "addgroup" ? "group" : "user", users: overrideUsers, groups: overrideGroups }));
      return;
    }
    if (url.pathname === "/mod/quiz/overrideedit.php" && request.method === "POST") {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const values = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        overridePosts.push(values);
        const scope = values.has("groupid") ? "group" : "user";
        const saved = {
          openAt: readDate(values, "timeopen"), closeAt: readDate(values, "timeclose"),
          timeLimit: readDuration(values, "timelimit"), attempts: values.get("attempts") || "0",
        };
        const existing = overrides.find((candidate) => String(candidate.id) === values.get("id"));
        if (existing) Object.assign(existing, saved);
        else {
          const groupId = values.get("groupid") || "";
          const userId = values.get("userid") || "";
          overrides.push({
            id: nextOverrideId, scope, ...saved,
            ...(scope === "group"
              ? { groupId, groupName: overrideGroups.find((group) => group.id === groupId)?.name || "" }
              : { userId, userName: overrideUsers.find((user) => user.id === userId)?.name || "" }),
          });
          nextOverrideId += 1;
        }
        response.writeHead(303, { location: `/mod/quiz/overrides.php?cmid=9&mode=${scope}` }).end();
      });
      return;
    }
    response.writeHead(404).end();
  });
  let browser;
  let context;
  try {
    await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Quiz test server did not bind a port");
    const origin = `https://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await page.goto(`${origin}/course/view.php?id=2`);
    await page.evaluate((wwwroot) => { globalThis.M = { cfg: { wwwroot, sesskey: "synthetic-session", userId: 3, courseId: 2 } }; }, origin);
    const binding = { origin, siteUrl: `${origin}/`, principalId: "3", courseId: "2" };
    const execute = (entry, argumentsValue) => executeInBrowser(page, { mode: "execute", operation: entry, arguments: argumentsValue, binding, expiresAt: Date.now() + 60_000 });
    const readQuiz = () => execute(quizRead, { course_id: 2, module_id: 9 });
    const writeQuiz = (params, digest) => execute(quizWrite, { course_id: 2, module_id: 9, ...params, expected_digest: digest });

    const first = await readQuiz();
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.snapshot_digest, (await readQuiz()).snapshot_digest);
    assert.deepEqual(
      [first.data.name, first.data.instructions, first.data.time_limit_seconds, first.data.when_time_expires, first.data.grace_period_seconds, first.data.attempts_allowed, first.data.grading_method, first.data.navigation_method, first.data.shuffle_within_questions, first.data.each_attempt_builds_on_last, first.data.show_blocks, first.data.network_address, first.data.browser_security],
      ["Evidence quiz", "<p>Original brief</p>", null, "autosubmit", null, "0", "1", "free", true, false, false, "", "-"],
    );
    assert.deepEqual(first.data.available_attempts_allowed, ["0", "1", "2", "3"]);
    assert.deepEqual(first.data.available_question_behaviours, ["deferredfeedback", "adaptive", "immediatefeedback"]);
    assert.deepEqual(first.data.review_options, defaultReview());
    assert.deepEqual(first.data.overall_feedback_bands, []);
    assert.deepEqual([first.data.available_overall_feedback_rows, first.data.password_set, first.data.safe_exam_browser], [3, false, "0"]);
    assert.deepEqual(first.targets, [
      { field: "course_id", label: "Course", name: "Quiz evidence" },
      { field: "module_id", label: "Activity", name: "Evidence quiz" },
    ]);

    const reviewMatrix = {
      attempt: { during: true, immediately: true, open: false, closed: true },
      correctness: { during: true, immediately: true, open: false, closed: false },
      maximum_marks: { during: false, immediately: true, open: true, closed: true },
      marks: { during: true, immediately: false, open: true, closed: true },
      specific_feedback: { during: false, immediately: true, open: false, closed: true },
      general_feedback: { during: true, immediately: true, open: true, closed: false },
      right_answer: { during: false, immediately: false, open: true, closed: true },
      overall_feedback: { during: false, immediately: true, open: false, closed: true },
    };
    const settingGroups = [
      {
        label: "timing",
        arguments: {
          open_at: { year: 2026, month: 9, day: 1, hour: 8, minute: 0 },
          close_at: { year: 2026, month: 9, day: 10, hour: 17, minute: 0 },
          time_limit_seconds: 3600, when_time_expires: "graceperiod", grace_period_seconds: 600,
        },
      },
      { label: "grade", arguments: { grade_category: "4", attempts_allowed: "3", grading_method: "2" } },
      { label: "layout", arguments: { new_page: "2", navigation_method: "sequential" } },
      { label: "question behaviour", arguments: { shuffle_within_questions: false, how_questions_behave: "immediatefeedback", each_attempt_builds_on_last: true } },
      { label: "review options", arguments: { review_options: reviewMatrix } },
      { label: "appearance", arguments: { show_user_picture: "1", decimal_places_in_grades: "3", decimal_places_in_question_grades: "2", show_blocks: true } },
      { label: "extra restrictions", arguments: { network_address: "10.0.0.1/24", delay_between_first_and_second_seconds: 300, delay_between_later_attempts_seconds: 900, browser_security: "securewindow" } },
      {
        label: "overall feedback",
        arguments: {
          overall_feedback_bands: [
            { feedback: "<p>Excellent</p>", lower_boundary: 8 },
            { feedback: "<p>Good</p>", lower_boundary: 5 },
            { feedback: "<p>Keep going</p>", lower_boundary: null },
          ],
        },
      },
    ];
    let digest = first.snapshot_digest;
    for (const group of settingGroups) {
      const priorPosts = posts.length;
      const saved = await writeQuiz(group.arguments, digest);
      assert.equal(saved.ok, true, `${group.label}: ${JSON.stringify(saved)}`);
      assert.deepEqual(saved.verification, { schema: "morrow.browser-verification.v1", status: "verified" }, group.label);
      assert.equal(posts.length, priorPosts + 1, group.label);
      for (const [argument, value] of Object.entries(group.arguments)) assert.deepEqual(saved.data[argument], value, `${group.label}.${argument}`);
      assert.deepEqual([saved.data.name, saved.data.instructions, saved.data.password_set], ["Evidence quiz", "<p>Original brief</p>", false], group.label);
      assert.equal(posts[posts.length - 1].get("gradepass"), "0.00", group.label);
      assert.equal(posts[posts.length - 1].get("grade"), "10.00", group.label);
      digest = saved.snapshot_digest;
    }
    assert.deepEqual(quiz.durations, { timelimit: 3600, graceperiod: 600, delay1: 300, delay2: 900 });
    assert.deepEqual(quiz.review, reviewMatrix);
    assert.deepEqual(quiz.feedback, [
      { text: "<p>Excellent</p>", boundary: "8.00" },
      { text: "<p>Good</p>", boundary: "5.00" },
      { text: "<p>Keep going</p>", boundary: "" },
    ]);
    assert.equal(quiz.selects.browsersecurity, "securewindow");

    const postsAfterGroups = posts.length;
    const unavailable = await writeQuiz({ attempts_allowed: "99" }, digest);
    assert.deepEqual([unavailable.ok, unavailable.sent, unavailable.error], [false, false, "moodle_quiz_native_setting_refused"]);
    const fixedCell = await writeQuiz({ review_options: { ...reviewMatrix, attempt: { ...reviewMatrix.attempt, during: false } } }, digest);
    assert.deepEqual([fixedCell.ok, fixedCell.sent, fixedCell.error], [false, false, "moodle_quiz_review_option_fixed"]);
    const tooManyBands = await writeQuiz({
      overall_feedback_bands: [
        { feedback: "<p>A</p>", lower_boundary: 9 }, { feedback: "<p>B</p>", lower_boundary: 7 },
        { feedback: "<p>C</p>", lower_boundary: 5 }, { feedback: "<p>D</p>", lower_boundary: null },
      ],
    }, digest);
    assert.deepEqual([tooManyBands.ok, tooManyBands.sent, tooManyBands.error], [false, false, "moodle_quiz_feedback_rows_unavailable"]);
    assert.equal(posts.length, postsAfterGroups, "a refused Quiz setting must not POST");

    const cleared = await writeQuiz({ overall_feedback_bands: [] }, digest);
    assert.equal(cleared.ok, true, JSON.stringify(cleared));
    assert.deepEqual(cleared.data.overall_feedback_bands, []);
    assert.deepEqual(cleared.data.review_options, reviewMatrix);
    digest = cleared.snapshot_digest;

    quiz.password = "letmein";
    const passworded = await readQuiz();
    assert.equal(passworded.data.password_set, true);
    assert.equal(JSON.stringify(passworded).includes("letmein"), false, "a Quiz password must never cross the bridge");
    const refusedPassword = await writeQuiz({ password: "letmein" }, passworded.snapshot_digest);
    assert.deepEqual(refusedPassword, { ok: false, sent: false, error: "moodle_arguments_invalid" });
    const clearedPassword = await writeQuiz({ password: null }, passworded.snapshot_digest);
    assert.equal(clearedPassword.ok, true, JSON.stringify(clearedPassword));
    assert.deepEqual([clearedPassword.data.password_set, quiz.password], [false, ""]);
    digest = clearedPassword.snapshot_digest;

    quiz.safeExamBrowser = "1";
    const exam = await readQuiz();
    assert.equal(exam.data.safe_exam_browser, "1");
    const postsBeforeExam = posts.length;
    const refusedExam = await writeQuiz({ name: "Must not save" }, exam.snapshot_digest);
    assert.deepEqual([refusedExam.ok, refusedExam.sent, refusedExam.error], [false, false, "moodle_quiz_seb_settings_refused"]);
    assert.equal(posts.length, postsBeforeExam, "a Safe Exam Browser Quiz must refuse before send");
    quiz.safeExamBrowser = "0";

    const stale = await writeQuiz({ name: "Must not save" }, first.snapshot_digest);
    assert.deepEqual([stale.ok, stale.sent, stale.error], [false, false, "moodle_expected_digest_mismatch"]);

    const beforeDrift = await readQuiz();
    driftProtectedField = true;
    const drifted = await writeQuiz({ instructions: "<p>Reviewed brief</p>" }, beforeDrift.snapshot_digest);
    driftProtectedField = false;
    assert.deepEqual([drifted.ok, drifted.sent, drifted.error], [false, true, "moodle_write_not_verified"]);
    assert.deepEqual(drifted.verification, { schema: "morrow.browser-verification.v1", status: "mismatch", reason: "moodle_readback_mismatch" });
    assert.equal(quiz.gradePass, "1.00", "the fixture must have changed the protected passing grade");
    quiz.gradePass = "0.00";

    const overrideList = await execute(overridesRead, { course_id: 2, module_id: 9 });
    assert.equal(overrideList.ok, true, JSON.stringify(overrideList));
    assert.deepEqual(overrideList.data, {
      course_id: 2,
      module_id: 9,
      overrides: [
        { override_id: 71, scope: "user", open_at: null, close_at: { year: 2026, month: 9, day: 12, hour: 17, minute: 0 }, time_limit_seconds: null, attempts_allowed: "0" },
        { override_id: 72, scope: "group", group_id: 5, group_name: "Section A", open_at: null, close_at: null, time_limit_seconds: 1800, attempts_allowed: "2" },
      ],
      user_override_count: 1,
      group_override_count: 1,
      complete: true,
    });
    assert.deepEqual(overrideList.targets, [
      { field: "course_id", label: "Course", name: "Quiz evidence" },
      { field: "module_id", label: "Quiz", name: "Evidence quiz" },
    ]);
    assert.equal(JSON.stringify(overrideList).includes("Robin Fields"), false);
    assert.ok(requests.includes("GET /mod/quiz/overrides.php?cmid=9&mode=user"));
    assert.ok(requests.includes("GET /mod/quiz/overrides.php?cmid=9&mode=group"));

    const created = await execute(overrideCreate, {
      course_id: 2, module_id: 9, user_id: 10,
      open_at: { year: 2026, month: 9, day: 20, hour: 12, minute: 0 }, close_at: null,
      time_limit_seconds: 5400, attempts_allowed: "3", expected_digest: overrideList.snapshot_digest,
    });
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.deepEqual(created.verification, { schema: "morrow.browser-verification.v1", status: "verified" });
    assert.equal(created.data.override_id, 73);
    assert.deepEqual(created.data.overrides.map((entry) => entry.override_id), [71, 73, 72]);
    assert.deepEqual(created.data.overrides[1], {
      override_id: 73, scope: "user", open_at: { year: 2026, month: 9, day: 20, hour: 12, minute: 0 },
      close_at: null, time_limit_seconds: 5400, attempts_allowed: "3",
    });
    assert.deepEqual(created.data.overrides[0], overrideList.data.overrides[0]);
    assert.deepEqual(created.data.overrides[2], overrideList.data.overrides[1]);
    assert.deepEqual([created.data.user_override_count, created.data.group_override_count, created.data.complete], [2, 1, true]);
    assert.deepEqual(created.targets[2], { field: "user_id", label: "User override", name: "One Moodle user" });
    assert.equal(JSON.stringify(created).includes("Sam Ortega"), false);
    assert.equal(overridePosts.length, 1);
    assert.deepEqual([overridePosts[0].get("userid"), overridePosts[0].get("timelimit[number]"), overridePosts[0].get("timelimit[timeunit]"), overridePosts[0].get("attempts"), overridePosts[0].get("timeclose[enabled]")], ["10", "5400", "1", "3", null]);

    const updated = await execute(overrideUpdate, {
      course_id: 2, module_id: 9, override_id: 72, group_id: 5,
      open_at: null, close_at: { year: 2026, month: 9, day: 16, hour: 9, minute: 0 },
      time_limit_seconds: null, attempts_allowed: "1", expected_digest: created.snapshot_digest,
    });
    assert.equal(updated.ok, true, JSON.stringify(updated));
    assert.deepEqual(updated.data.overrides[2], {
      override_id: 72, scope: "group", group_id: 5, group_name: "Section A",
      open_at: null, close_at: { year: 2026, month: 9, day: 16, hour: 9, minute: 0 }, time_limit_seconds: null, attempts_allowed: "1",
    });
    assert.deepEqual(updated.data.overrides.slice(0, 2), created.data.overrides.slice(0, 2));
    assert.equal(overridePosts.length, 2);

    const refusals = [
      { params: { override_id: 72, group_id: 6 }, error: "moodle_quiz_override_target_mismatch" },
      { params: { override_id: 72, user_id: 9 }, error: "moodle_quiz_override_not_found" },
      { params: { override_id: 99, group_id: 5 }, error: "moodle_quiz_override_not_found" },
    ];
    for (const refusal of refusals) {
      const refused = await execute(overrideUpdate, {
        course_id: 2, module_id: 9, ...refusal.params,
        open_at: null, close_at: { year: 2026, month: 9, day: 18, hour: 9, minute: 0 }, time_limit_seconds: null, attempts_allowed: "1",
        expected_digest: updated.snapshot_digest,
      });
      assert.deepEqual([refused.ok, refused.sent, refused.error], [false, false, refusal.error], JSON.stringify(refusal.params));
    }
    const unavailableAttempts = await execute(overrideCreate, {
      course_id: 2, module_id: 9, group_id: 6,
      open_at: null, close_at: { year: 2026, month: 9, day: 19, hour: 9, minute: 0 }, time_limit_seconds: null, attempts_allowed: "99",
      expected_digest: updated.snapshot_digest,
    });
    assert.deepEqual([unavailableAttempts.ok, unavailableAttempts.sent, unavailableAttempts.error], [false, false, "moodle_quiz_override_setting_refused"]);
    const emptyOverride = await execute(overrideCreate, {
      course_id: 2, module_id: 9, group_id: 6,
      open_at: null, close_at: null, time_limit_seconds: null, attempts_allowed: "1",
      expected_digest: updated.snapshot_digest,
    });
    assert.deepEqual(emptyOverride, { ok: false, sent: false, error: "moodle_arguments_invalid" });
    const staleOverride = await execute(overrideCreate, {
      course_id: 2, module_id: 9, group_id: 6,
      open_at: null, close_at: { year: 2026, month: 9, day: 22, hour: 9, minute: 0 }, time_limit_seconds: null, attempts_allowed: "1",
      expected_digest: overrideList.snapshot_digest,
    });
    assert.deepEqual([staleOverride.ok, staleOverride.sent, staleOverride.error], [false, false, "moodle_expected_digest_mismatch"]);
    assert.equal(overridePosts.length, 2, "a refused override must not POST");

    for (let index = 0; index < 25; index += 1) {
      overrides.push({ id: 200 + index, scope: "group", groupId: "6", groupName: "Section B", openAt: null, closeAt: null, timeLimit: 600, attempts: "1" });
    }
    const crowded = await execute(overridesRead, { course_id: 2, module_id: 9 });
    assert.deepEqual([crowded.data.complete, crowded.data.overrides, crowded.data.user_override_count, crowded.data.group_override_count], [false, [], 2, 26]);
    const crowdedWrite = await execute(overrideCreate, {
      course_id: 2, module_id: 9, group_id: 6,
      open_at: null, close_at: { year: 2026, month: 10, day: 2, hour: 9, minute: 0 }, time_limit_seconds: null, attempts_allowed: "1",
      expected_digest: crowded.snapshot_digest,
    });
    assert.deepEqual([crowdedWrite.ok, crowdedWrite.sent, crowdedWrite.error], [false, false, "moodle_quiz_overrides_incomplete"]);
    assert.equal(overridePosts.length, 2);
    assert.equal(requests.some((entry) => entry.startsWith("GET /mod/quiz/view.php")), false, "no Quiz settings or override route may open the Quiz");
  } finally {
    await context?.close();
    await browser?.close();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

const resourceFileReplaceOperation = {
  key: "moodle.form.course.modedit.resource.file.replace.write.v1",
  toolName: "moodle_replace_resource_file",
  provider: "moodle",
  readOnly: false,
};
const resourceFileDeleteOperation = {
  key: "moodle.form.course.modedit.resource.file.delete.write.v1",
  toolName: "moodle_delete_resource_file",
  provider: "moodle",
  readOnly: false,
};
const folderFilesAddOperation = {
  key: "moodle.form.course.modedit.folder.files.add.write.v1",
  toolName: "moodle_add_folder_files",
  provider: "moodle",
  readOnly: false,
};
const folderSubfolderCreateOperation = {
  key: "moodle.form.course.modedit.folder.subfolder.create.write.v1",
  toolName: "moodle_create_folder_subfolder",
  provider: "moodle",
  readOnly: false,
};

function fileManifest(bytes, filename) {
  return { filename, size_bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function stagedAttachment(handle, bytes, filename) {
  return { schema: "morrow.private-file-attachment.v1", handle, manifest: fileManifest(bytes, filename), bytes_base64: bytes.toString("base64") };
}

// The upload plugin reads its destination from `savepath` and its stored name from `title`.
// https://github.com/moodle/moodle/blob/v5.2.2/public/repository/upload/lib.php
function multipartField(payload, name) {
  return payload.match(new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`))?.[1] || "";
}

async function withFixtureServer(prefix, handler, callback) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const key = join(directory, "key.pem");
  const certificate = join(directory, "certificate.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", certificate], { stdio: "ignore" });
  const state = { origin: "" };
  const server = createServer({ key: readFileSync(key), cert: readFileSync(certificate) }, (request, response) => handler(request, response, state));
  let browser;
  let context;
  try {
    await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture server did not bind a port");
    state.origin = `https://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await page.goto(`${state.origin}/course/view.php?id=2`);
    await page.evaluate((wwwroot) => { globalThis.M = { cfg: { wwwroot, sesskey: "synthetic-session", userId: 3, courseId: 2 } }; }, state.origin);
    await callback(page, state);
  } finally {
    await context?.close();
    await browser?.close();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
}

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

test("Moodle Resource file replacement and deletion verify saved bytes and hold an uncertain upload", async () => {
  const original = Buffer.from("Morrow syllabus v1\n", "utf8");
  const handout = Buffer.from("Morrow handout\n", "utf8");
  const replacement = Buffer.from("Morrow syllabus v2, revised\n", "utf8");
  const replacementManifest = fileManifest(replacement, "syllabus.txt");
  const requests = [];
  const posts = [];
  const drafts = new Map();
  let nextDraft = 700;
  let revision = 1;
  let corruptUpload = false;
  // Moodle rebuilds the private draft copy each time the settings form is opened, and
  // resource_set_mainfile promotes the file to sortorder 1 when exactly one is attached.
  // https://github.com/moodle/moodle/blob/v5.2.2/public/mod/resource/locallib.php
  let saved = [{ filename: "syllabus.txt", bytes: original, sortorder: 1 }, { filename: "handout.txt", bytes: handout, sortorder: 2 }];
  const managerConfig = (itemId) => ({ target: "id_files", itemid: itemId, context: { id: 77 }, mainfile: true, maxfiles: -1, maxbytes: -1, areamaxbytes: -1, accepted_types: "*", filepicker: { repositories: { 17: { id: "17", type: "upload" } } } });
  const resourceForm = (itemId) => `<!doctype html><html><body><form method="post" action="/course/modedit.php?update=99&amp;return=0">
    <input name="update" value="99"><input name="course" value="2"><input name="modulename" value="resource"><input name="name" value="Course syllabus"><input name="visible" value="1"><input name="revision" value="${revision}"><input name="coursecontentnotification" value="1"><textarea name="introeditor[text]"></textarea><input name="introeditor[format]" value="1"><input name="introeditor[itemid]" value="6000"><div data-fieldtype="filemanager"><input type="hidden" id="id_files" name="files" value="${itemId}"></div><input type="submit" name="submitbutton" value="Save and display"><input type="submit" name="submitbutton2" value="Save changes and return to course"><input name="sesskey" value="synthetic-session"></form><script>M.form_filemanager.init(Y, ${JSON.stringify(managerConfig(itemId))});</script></body></html>`;
  const listing = (files) => ({
    filecount: files.length,
    list: files.map((file) => ({ filename: file.filename, filepath: "/", type: "file", size: file.bytes.byteLength, sortorder: String(file.sortorder), mimetype: "text/plain" })),
    tree: { children: [] },
  });
  const courseState = () => JSON.stringify([{ data: JSON.stringify({
    course: { id: 2, fullname: "Evidence course" },
    section: [{ id: 7, number: 4, title: "Evidence section", component: "", visible: true, hasrestrictions: false }],
    cm: [{ id: 99, module: "resource", sectionid: 7, name: "Course syllabus", visible: true }],
  }) }]);

  await withFixtureServer("morrow-resource-file-edit-", async (request, response, state) => {
    const url = new URL(request.url || "/", state.origin || "https://127.0.0.1");
    requests.push(`${request.method} ${url.pathname}${url.search}`);
    if (url.pathname === "/course/view.php") { response.writeHead(200, { "content-type": "text/html" }); response.end('<!doctype html><body class="path-course course-2"></body>'); return; }
    if (url.pathname === "/lib/ajax/service.php") { await readBody(request); response.writeHead(200, { "content-type": "application/json" }); response.end(courseState()); return; }
    if (url.pathname === "/repository/draftfiles_ajax.php") {
      const values = new URLSearchParams((await readBody(request)).toString("utf8"));
      const itemId = values.get("itemid") || "";
      const files = drafts.get(itemId);
      if (!files) { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ filecount: 0, list: [], tree: { children: [] } })); return; }
      if (url.searchParams.get("action") === "delete") {
        const remaining = files.filter((file) => file.filename !== values.get("filename"));
        drafts.set(itemId, remaining);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ filepath: values.get("filepath") }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(listing(files)));
      return;
    }
    if (url.pathname === "/repository/repository_ajax.php") {
      const payload = (await readBody(request)).toString("latin1");
      const itemId = multipartField(payload, "itemid");
      const title = multipartField(payload, "title");
      if (!drafts.has(itemId)) { response.writeHead(400).end(); return; }
      drafts.get(itemId).push({ filename: title, bytes: corruptUpload ? Buffer.from("not the reviewed file", "utf8") : replacement, sortorder: 0 });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: Number(itemId), file: title, url: `${state.origin}/draftfile.php/3/user/draft/${itemId}/${title}` }));
      return;
    }
    if (url.pathname.startsWith("/draftfile.php/")) {
      const parts = url.pathname.split("/");
      const file = (drafts.get(parts[5]) || []).find((entry) => entry.filename === decodeURIComponent(parts[6] || ""));
      if (!file) { response.writeHead(404).end(); return; }
      response.writeHead(200, { "content-type": "application/octet-stream", "content-length": file.bytes.byteLength });
      response.end(file.bytes);
      return;
    }
    if (url.pathname.startsWith(`/pluginfile.php/77/mod_resource/content/${revision}/`)) {
      const file = saved.find((entry) => entry.filename === decodeURIComponent(url.pathname.split("/").pop() || ""));
      if (!file) { response.writeHead(404).end(); return; }
      response.writeHead(200, { "content-type": "application/octet-stream", "content-length": file.bytes.byteLength });
      response.end(file.bytes);
      return;
    }
    if (url.pathname === "/course/modedit.php" && request.method === "GET") {
      if (url.searchParams.get("update") !== "99") { response.writeHead(404).end(); return; }
      const itemId = String(++nextDraft);
      drafts.set(itemId, saved.map((file) => ({ ...file })));
      response.writeHead(200, { "content-type": "text/html" });
      response.end(resourceForm(itemId));
      return;
    }
    if (url.pathname === "/course/modedit.php" && request.method === "POST") {
      const values = new URLSearchParams((await readBody(request)).toString("utf8"));
      posts.push(values);
      const committed = drafts.get(values.get("files") || "") || [];
      saved = committed.map((file) => ({ ...file }));
      if (saved.length === 1) saved[0].sortorder = 1;
      revision += 1;
      response.writeHead(303, { location: "/course/view.php?id=2" }).end();
      return;
    }
    response.writeHead(404).end();
  }, async (page, state) => {
    const binding = { origin: state.origin, siteUrl: `${state.origin}/`, principalId: "3", courseId: "2" };
    const base = { mode: "execute", binding, expiresAt: Date.now() + 60_000 };
    const readFiles = () => executeInBrowser(page, { ...base, operation: resourceFilesReadOperation, arguments: { course_id: 2, module_id: 99 } });

    const listed = await readFiles();
    assert.equal(listed.ok, true, JSON.stringify(listed));
    assert.deepEqual(listed.data.files, [
      { filename: "handout.txt", relative_path: "handout.txt", size_bytes: handout.byteLength, media_type_label: "text/plain", main_file: false },
      { filename: "syllabus.txt", relative_path: "syllabus.txt", size_bytes: original.byteLength, media_type_label: "text/plain", main_file: true },
    ]);

    const attachment = stagedAttachment("file:resource-replacement-1", replacement, "syllabus.txt");
    const replaceWhileTwoFiles = await executeInBrowser(page, {
      ...base, operation: resourceFileReplaceOperation,
      arguments: { course_id: 2, module_id: 99, ...replacementManifest, expected_digest: listed.snapshot_digest },
      privateAttachment: attachment,
    });
    assert.equal(replaceWhileTwoFiles.error, "moodle_resource_file_replace_target_invalid");
    assert.equal(posts.length, 0);

    const deleteMain = await executeInBrowser(page, {
      ...base, operation: resourceFileDeleteOperation,
      arguments: { course_id: 2, module_id: 99, filename: "syllabus.txt", expected_digest: listed.snapshot_digest },
    });
    assert.equal(deleteMain.error, "moodle_resource_file_delete_target_invalid");
    assert.equal(posts.length, 0);

    const staleDigest = await executeInBrowser(page, {
      ...base, operation: resourceFileDeleteOperation,
      arguments: { course_id: 2, module_id: 99, filename: "handout.txt", expected_digest: "c".repeat(64) },
    });
    assert.deepEqual(staleDigest, { ok: false, sent: false, error: "moodle_expected_digest_mismatch" });
    assert.equal(posts.length, 0);

    const removed = await executeInBrowser(page, {
      ...base, operation: resourceFileDeleteOperation,
      arguments: { course_id: 2, module_id: 99, filename: "handout.txt", expected_digest: listed.snapshot_digest },
    });
    assert.equal(removed.ok, true, JSON.stringify(removed));
    assert.deepEqual(removed.verification, { schema: "morrow.browser-verification.v1", status: "verified" });
    assert.deepEqual(removed.data.files, [{ filename: "syllabus.txt", relative_path: "syllabus.txt", size_bytes: original.byteLength, media_type_label: "text/plain", main_file: true }]);
    assert.deepEqual(removed.targets, [
      { field: "course_id", label: "Course", name: "Evidence course" },
      { field: "module_id", label: "Resource", name: "Course syllabus" },
    ]);
    assert.equal(posts.length, 1);
    assert.equal(saved.length, 1);

    const beforeReplace = await readFiles();
    assert.equal(beforeReplace.ok, true, JSON.stringify(beforeReplace));

    corruptUpload = true;
    const uncertainUpload = await executeInBrowser(page, {
      ...base, operation: resourceFileReplaceOperation,
      arguments: { course_id: 2, module_id: 99, ...replacementManifest, expected_digest: beforeReplace.snapshot_digest },
      privateAttachment: attachment,
    });
    assert.deepEqual([uncertainUpload.ok, uncertainUpload.sent, uncertainUpload.error, uncertainUpload.verification], [
      false,
      true,
      "moodle_resource_upload_succeeded_save_not_sent",
      { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_resource_upload_succeeded_save_not_sent" },
    ]);
    assert.equal(posts.length, 1, "an uncertain upload must stop before the save");
    assert.deepEqual(saved.map((file) => file.filename), ["syllabus.txt"]);
    assert.equal(saved[0].bytes.equals(original), true, "the saved file must be untouched after a refused replacement");

    corruptUpload = false;
    const beforeClean = await readFiles();
    const uploadsBefore = requests.filter((entry) => entry.startsWith("POST /repository/repository_ajax.php")).length;
    const replaced = await executeInBrowser(page, {
      ...base, operation: resourceFileReplaceOperation,
      arguments: { course_id: 2, module_id: 99, ...replacementManifest, expected_digest: beforeClean.snapshot_digest },
      privateAttachment: attachment,
    });
    assert.equal(replaced.ok, true, JSON.stringify(replaced));
    assert.deepEqual(replaced.verification, { schema: "morrow.browser-verification.v1", status: "verified" });
    assert.deepEqual(replaced.data.files, [{ filename: "syllabus.txt", relative_path: "syllabus.txt", size_bytes: replacement.byteLength, media_type_label: "text/plain", main_file: true }]);
    assert.equal(posts.length, 2);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].bytes.equals(replacement), true);
    assert.equal(requests.filter((entry) => entry.startsWith("POST /repository/repository_ajax.php")).length, uploadsBefore + 1);

    const deleteIndex = requests.lastIndexOf("POST /repository/draftfiles_ajax.php?action=delete");
    const uploadIndex = requests.lastIndexOf("POST /repository/repository_ajax.php?action=upload");
    const saveIndex = requests.lastIndexOf("POST /course/modedit.php?update=99&return=0");
    const savedBytesIndex = requests.findIndex((entry, index) => index > saveIndex && entry.startsWith("GET /pluginfile.php/77/mod_resource/content/"));
    assert.ok(deleteIndex < uploadIndex, "the old file leaves the draft area before the reviewed file is staged");
    assert.ok(uploadIndex < saveIndex, "the reviewed file is staged and checked before the one save");
    assert.ok(savedBytesIndex > saveIndex, "the saved bytes are read back after the save");
    assert.equal(requests.some((entry) => entry.startsWith("GET /mod/resource/view.php")), false);
    assert.equal(JSON.stringify([replaceWhileTwoFiles, removed, uncertainUpload, replaced]).includes(attachment.bytes_base64), false);
  });
});

test("Moodle Folder adds ordered multiple files, nests a subfolder, and never repeats a lost save", async () => {
  const week = [Buffer.from("Morrow week one reading\n", "utf8"), Buffer.from("Morrow week one slides\n", "utf8"), Buffer.from("Morrow week one notes\n", "utf8")];
  const names = ["reading.txt", "slides.txt", "notes.txt"];
  const root = Buffer.from("Morrow folder overview\n", "utf8");
  const requests = [];
  const posts = [];
  const uploads = [];
  const drafts = new Map();
  let nextDraft = 800;
  let revision = 1;
  let corruptUploadAt = 0;
  let loseSave = false;
  let saved = { files: [{ filename: "overview.txt", filepath: "/", bytes: root }], dirs: ["/"] };
  const config = (itemId) => ({ target: "id_files", itemid: itemId, context: { id: 77 }, mainfile: "", subdirs: 1, maxfiles: -1, maxbytes: -1, areamaxbytes: -1, accepted_types: "*", filepicker: { repositories: { 17: { id: "17", type: "upload" } } } });
  const folderControls = '<select name="display"><option value="0" selected>Page</option><option value="1">Inline</option></select><input type="checkbox" name="showexpanded" value="1" checked><input type="checkbox" name="showdownloadfolder" value="1" checked><input type="checkbox" name="forcedownload" value="1" checked>';
  const folderForm = (itemId) => `<!doctype html><html><body><form method="post" action="/course/modedit.php?update=50&amp;return=0">
    <input name="update" value="50"><input name="course" value="2"><input name="modulename" value="folder"><input name="name" value="Course materials"><input name="visible" value="1"><input name="revision" value="${revision}"><input name="coursecontentnotification" value="1"><textarea name="introeditor[text]"></textarea><input name="introeditor[format]" value="1"><input name="introeditor[itemid]" value="6000">${folderControls}<div data-fieldtype="filemanager"><input type="hidden" id="id_files" name="files" value="${itemId}"></div><input type="submit" name="submitbutton" value="Save and display"><input type="submit" name="submitbutton2" value="Save changes and return to course"><input name="sesskey" value="synthetic-session"></form><script>M.form_filemanager.init(Y, ${JSON.stringify(config(itemId))});</script></body></html>`;
  const childrenOf = (dirs, parent) => dirs
    .filter((dir) => dir !== parent && dir.startsWith(parent) && dir.slice(parent.length).split("/").filter(Boolean).length === 1)
    .sort()
    .map((dir) => ({ filepath: dir, children: childrenOf(dirs, dir) }));
  const listing = (area, filepath) => ({
    filecount: area.files.length,
    list: [
      ...area.files.filter((file) => file.filepath === filepath).map((file) => ({ filename: file.filename, filepath, type: "file", size: file.bytes.byteLength, mimetype: "text/plain" })),
      ...childrenOf(area.dirs, filepath).map((child) => ({ filename: ".", filepath: child.filepath, type: "folder", size: null })),
    ],
    tree: { children: childrenOf(area.dirs, "/") },
  });
  const courseState = () => JSON.stringify([{ data: JSON.stringify({
    course: { id: 2, fullname: "Evidence course" },
    section: [{ id: 7, number: 4, title: "Evidence section", component: "", visible: true, hasrestrictions: false }],
    cm: [{ id: 50, module: "folder", sectionid: 7, name: "Course materials", visible: true }],
  }) }]);

  await withFixtureServer("morrow-folder-files-add-", async (request, response, state) => {
    const url = new URL(request.url || "/", state.origin || "https://127.0.0.1");
    requests.push(`${request.method} ${url.pathname}${url.search}`);
    if (url.pathname === "/course/view.php") { response.writeHead(200, { "content-type": "text/html" }); response.end('<!doctype html><body class="path-course course-2"></body>'); return; }
    if (url.pathname === "/lib/ajax/service.php") { await readBody(request); response.writeHead(200, { "content-type": "application/json" }); response.end(courseState()); return; }
    if (url.pathname === "/repository/draftfiles_ajax.php") {
      const values = new URLSearchParams((await readBody(request)).toString("utf8"));
      const area = drafts.get(values.get("itemid") || "");
      if (!area) { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ filecount: 0, list: [], tree: { children: [] } })); return; }
      const action = url.searchParams.get("action");
      if (action === "mkdir") {
        area.dirs.push(`${values.get("filepath")}${values.get("newdirname")}/`);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ filepath: values.get("filepath") }));
        return;
      }
      if (action === "delete") {
        area.files = area.files.filter((file) => !(file.filename === values.get("filename") && file.filepath === values.get("filepath")));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ filepath: values.get("filepath") }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(listing(area, values.get("filepath") || "/")));
      return;
    }
    if (url.pathname === "/repository/repository_ajax.php") {
      const payload = (await readBody(request)).toString("latin1");
      const itemId = multipartField(payload, "itemid");
      const title = multipartField(payload, "title");
      const savepath = multipartField(payload, "savepath");
      const area = drafts.get(itemId);
      if (!area) { response.writeHead(400).end(); return; }
      uploads.push({ filename: title, savepath });
      const source = week[names.indexOf(title)] || root;
      const corrupt = corruptUploadAt > 0 && uploads.length === corruptUploadAt;
      area.files.push({ filename: title, filepath: savepath, bytes: corrupt ? Buffer.from("not the reviewed file", "utf8") : source });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: Number(itemId), file: title, url: `${state.origin}/draftfile.php/3/user/draft/${itemId}${savepath}${title}` }));
      return;
    }
    if (url.pathname.startsWith("/draftfile.php/")) {
      const parts = url.pathname.split("/").slice(2);
      const area = drafts.get(parts[3]);
      const relative = `/${parts.slice(4).map((part) => decodeURIComponent(part)).join("/")}`;
      const file = (area?.files || []).find((entry) => `${entry.filepath}${entry.filename}` === relative);
      if (!file) { response.writeHead(404).end(); return; }
      response.writeHead(200, { "content-type": "application/octet-stream", "content-length": file.bytes.byteLength });
      response.end(file.bytes);
      return;
    }
    if (url.pathname.startsWith(`/pluginfile.php/77/mod_folder/content/${revision}/`)) {
      const relative = `/${url.pathname.slice(`/pluginfile.php/77/mod_folder/content/${revision}/`.length).split("/").map((part) => decodeURIComponent(part)).join("/")}`;
      const file = saved.files.find((entry) => `${entry.filepath}${entry.filename}` === relative);
      if (!file) { response.writeHead(404).end(); return; }
      response.writeHead(200, { "content-type": "application/octet-stream", "content-length": file.bytes.byteLength });
      response.end(file.bytes);
      return;
    }
    if (url.pathname === "/course/modedit.php" && request.method === "GET") {
      if (url.searchParams.get("update") !== "50") { response.writeHead(404).end(); return; }
      const itemId = String(++nextDraft);
      drafts.set(itemId, { files: saved.files.map((file) => ({ ...file })), dirs: [...saved.dirs] });
      response.writeHead(200, { "content-type": "text/html" });
      response.end(folderForm(itemId));
      return;
    }
    if (url.pathname === "/course/modedit.php" && request.method === "POST") {
      const values = new URLSearchParams((await readBody(request)).toString("utf8"));
      posts.push(values);
      if (loseSave) { response.writeHead(500).end(); return; }
      const area = drafts.get(values.get("files") || "");
      saved = { files: (area?.files || []).map((file) => ({ ...file })), dirs: [...(area?.dirs || ["/"])] };
      revision += 1;
      response.writeHead(303, { location: "/course/view.php?id=2" }).end();
      return;
    }
    response.writeHead(404).end();
  }, async (page, state) => {
    const binding = { origin: state.origin, siteUrl: `${state.origin}/`, principalId: "3", courseId: "2" };
    const base = { mode: "execute", binding, expiresAt: Date.now() + 60_000 };
    const readFiles = () => executeInBrowser(page, { ...base, operation: folderFilesReadOperation, arguments: { course_id: 2, module_id: 50 } });
    const attachments = week.map((bytes, index) => stagedAttachment(`file:folder-week-${index + 1}`, bytes, names[index]));
    const manifests = attachments.map((attachment) => attachment.manifest);

    const listed = await readFiles();
    assert.equal(listed.ok, true, JSON.stringify(listed));
    assert.deepEqual(listed.data.files, [{ filename: "overview.txt", relative_path: "overview.txt", size_bytes: root.byteLength, media_type_label: "text/plain" }]);

    const missingFolder = await executeInBrowser(page, {
      ...base, operation: folderFilesAddOperation,
      arguments: { course_id: 2, module_id: 50, folder_path: "/week-01/", files: manifests, expected_digest: listed.snapshot_digest },
      privateAttachments: attachments,
    });
    assert.equal(missingFolder.error, "moodle_folder_path_invalid");
    assert.equal(posts.length, 0);

    const nested = await executeInBrowser(page, {
      ...base, operation: folderSubfolderCreateOperation,
      arguments: { course_id: 2, module_id: 50, parent_path: "/", name: "week-01", expected_digest: listed.snapshot_digest },
    });
    assert.equal(nested.ok, true, JSON.stringify(nested));
    assert.deepEqual(nested.verification, { schema: "morrow.browser-verification.v1", status: "verified" });
    assert.equal(nested.data.folder_path, "/week-01/");
    assert.deepEqual(nested.data.files, listed.data.files);
    assert.deepEqual(saved.dirs, ["/", "/week-01/"]);
    assert.equal(posts.length, 1);

    const ready = await readFiles();
    assert.equal(ready.ok, true, JSON.stringify(ready));
    const added = await executeInBrowser(page, {
      ...base, operation: folderFilesAddOperation,
      arguments: { course_id: 2, module_id: 50, folder_path: "/week-01/", files: manifests, expected_digest: ready.snapshot_digest },
      privateAttachments: attachments,
    });
    assert.equal(added.ok, true, JSON.stringify(added));
    assert.deepEqual(added.verification, { schema: "morrow.browser-verification.v1", status: "verified" });
    assert.deepEqual(added.data.files, [
      { filename: "overview.txt", relative_path: "overview.txt", size_bytes: root.byteLength, media_type_label: "text/plain" },
      { filename: "notes.txt", relative_path: "week-01/notes.txt", size_bytes: week[2].byteLength, media_type_label: "text/plain" },
      { filename: "reading.txt", relative_path: "week-01/reading.txt", size_bytes: week[0].byteLength, media_type_label: "text/plain" },
      { filename: "slides.txt", relative_path: "week-01/slides.txt", size_bytes: week[1].byteLength, media_type_label: "text/plain" },
    ]);
    assert.deepEqual(uploads, names.map((filename) => ({ filename, savepath: "/week-01/" })), "the reviewed files are staged in the requested order");
    assert.equal(posts.length, 2, "several files reach Moodle through one native save");
    for (const [index, name] of names.entries()) {
      const savedFile = saved.files.find((file) => file.filename === name && file.filepath === "/week-01/");
      assert.ok(savedFile, name);
      assert.equal(savedFile.bytes.equals(week[index]), true, name);
      assert.ok(requests.includes(`GET /pluginfile.php/77/mod_folder/content/${revision}/week-01/${name}?forcedownload=1`), `saved bytes are read back for ${name}`);
    }

    const duplicate = await executeInBrowser(page, {
      ...base, operation: folderFilesAddOperation,
      arguments: { course_id: 2, module_id: 50, folder_path: "/week-01/", files: manifests, expected_digest: (await readFiles()).snapshot_digest },
      privateAttachments: attachments,
    });
    assert.equal(duplicate.error, "moodle_folder_file_exists");
    assert.equal(posts.length, 2);

    // One bridge message carries every reviewed file of one approval, so the whole set stays
    // inside the same 1 MiB raw-file limit that one file has.
    const oversized = await executeInBrowser(page, {
      ...base, operation: folderFilesAddOperation,
      arguments: {
        course_id: 2, module_id: 50, folder_path: "/",
        files: [
          { filename: "big-1.txt", size_bytes: 700_000, sha256: "a".repeat(64) },
          { filename: "big-2.txt", size_bytes: 700_000, sha256: "b".repeat(64) },
        ],
        expected_digest: (await readFiles()).snapshot_digest,
      },
      privateAttachments: [],
    });
    assert.deepEqual(oversized, { ok: false, sent: false, error: "moodle_arguments_invalid" });
    assert.equal(posts.length, 2);

    const second = [Buffer.from("Morrow week two reading\n", "utf8"), Buffer.from("Morrow week two slides\n", "utf8")];
    const secondAttachments = second.map((bytes, index) => stagedAttachment(`file:folder-second-${index + 1}`, bytes, `second-${index + 1}.txt`));
    week.push(...second);
    names.push("second-1.txt", "second-2.txt");
    corruptUploadAt = uploads.length + 2;
    const uncertain = await executeInBrowser(page, {
      ...base, operation: folderFilesAddOperation,
      arguments: { course_id: 2, module_id: 50, folder_path: "/", files: secondAttachments.map((attachment) => attachment.manifest), expected_digest: (await readFiles()).snapshot_digest },
      privateAttachments: secondAttachments,
    });
    assert.deepEqual([uncertain.ok, uncertain.sent, uncertain.error, uncertain.verification], [
      false,
      true,
      "moodle_folder_upload_succeeded_save_not_sent",
      { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_folder_upload_succeeded_save_not_sent" },
    ]);
    assert.equal(posts.length, 2, "one differing staged file stops the whole set before the save");
    assert.equal(saved.files.some((file) => file.filename.startsWith("second-")), false);

    corruptUploadAt = 0;
    loseSave = true;
    const lost = await executeInBrowser(page, {
      ...base, operation: folderFilesAddOperation,
      arguments: { course_id: 2, module_id: 50, folder_path: "/", files: secondAttachments.map((attachment) => attachment.manifest), expected_digest: (await readFiles()).snapshot_digest },
      privateAttachments: secondAttachments,
    });
    assert.deepEqual([lost.ok, lost.sent, lost.outcomeUnknown, lost.error, lost.verification], [
      false,
      true,
      true,
      "moodle_folder_save_unknown",
      { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_folder_save_unknown" },
    ]);
    assert.equal(posts.length, 3, "a lost save is never sent again");
    assert.equal(requests.some((entry) => entry.startsWith("GET /mod/folder/view.php")), false);
    assert.equal(JSON.stringify([nested, added, uncertain, lost]).includes(attachments[0].bytes_base64), false);
  });
});

test("the Moodle file-change catalog entries state their exact limits and match the executor", () => {
  const root = new URL("../..", import.meta.url);
  const catalog = JSON.parse(readFileSync(new URL("connector/extension/generated/moodle-browser-catalog.json", root), "utf8"));
  const operations = [resourceFileReplaceOperation, resourceFileDeleteOperation, folderFilesAddOperation, folderSubfolderCreateOperation];
  const executor = readFileSync(new URL("connector/extension/src/moodle-executor.js", root), "utf8");
  const entries = operations.map((operation) => {
    const matches = catalog.operations.filter((entry) => entry.toolName === operation.toolName);
    assert.equal(matches.length, 1, `${operation.toolName} needs exactly one catalog entry`);
    assert.equal(matches[0].key, operation.key);
    assert.equal(matches[0].readOnly, false);
    assert.equal(matches[0].description.includes("no signed-in Moodle site has run it"), true, `${operation.toolName} must keep the fixture-only label`);
    assert.equal(matches[0].description.includes("moodle/course:manageactivities"), true, `${operation.toolName} must state its required capability`);
    assert.equal(executor.includes(`"${operation.key}": { toolName: "${operation.toolName}"`), true, `${operation.toolName} must be routed by the executor`);
    return matches[0];
  });
  const [replace, remove, add, subfolder] = entries;

  assert.deepEqual([replace.reviewTool, remove.reviewTool], ["moodle_get_resource_files", "moodle_get_resource_files"]);
  assert.deepEqual([add.reviewTool, subfolder.reviewTool], ["moodle_get_folder_files", "moodle_get_folder_files"]);
  for (const entry of [replace, remove]) {
    assert.deepEqual([entry.destructive, entry.irreversible], [true, true], `${entry.toolName} removes saved content`);
    assert.equal(entry.description.includes("Learner links, bookmarks and embedded references"), true, `${entry.toolName} must state that learner links break`);
  }
  for (const entry of [add, subfolder]) assert.equal(entry.destructive, undefined, `${entry.toolName} adds content and is not destructive`);

  // The bridge carries one message of at most 2 MiB, so one reviewed file stays at 1 MiB and a
  // whole reviewed set stays at 1 MiB together. The catalog says so instead of implying general
  // file support. docs/implementation/MOODLE-FULL-FUNCTIONALITY.md records that transport limit.
  assert.equal(replace.inputSchema.properties.size_bytes.maximum, 1024 * 1024);
  assert.equal(add.inputSchema.properties.files.items.properties.size_bytes.maximum, 1024 * 1024);
  assert.equal(add.inputSchema.properties.files.maxItems, 8);
  assert.equal(replace.description.includes("at most 1 MiB"), true);
  assert.equal(replace.description.includes("this is not general file support"), true);
  assert.equal(add.description.includes("at most 1 MiB together"), true);
  assert.equal(add.description.includes("this is not general file support"), true);
  for (const entry of [replace, add]) {
    assert.equal(entry.description.includes("local file planner stages"), true, `${entry.toolName} must describe the reviewed file staging path`);
  }
  assert.equal(remove.inputSchema.properties.size_bytes, undefined, "a deletion carries no file bytes");
  assert.equal(subfolder.inputSchema.properties.files, undefined, "a subfolder carries no file bytes");

  const documentation = readFileSync(new URL("docs/implementation/MOODLE-FULL-FUNCTIONALITY.md", root), "utf8");
  for (const entry of entries) assert.equal(documentation.includes(entry.toolName), true, `the Files row must name ${entry.toolName}`);
  assert.equal(documentation.includes("The assistant file planners stage Resource replacement and multiple Folder files"), true);
});
