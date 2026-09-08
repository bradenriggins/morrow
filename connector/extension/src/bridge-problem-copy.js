/**
 * What a person reads when Morrow Bridge cannot finish a step.
 *
 * Every failure the Morrow Bridge pages receive carries a stable code: connector/extension/src/
 * service-worker.js answers `{ ok: false, code, error }` for both its settings requests and its
 * popup and setup-guide requests. Each code answers the same three questions here: what happened,
 * why, and what to do next. Nothing in this file reads storage, Chrome or the network, so a page
 * can render a state without another round trip.
 *
 * The first group is the codes the pages receive from the extension itself. The second group is the
 * codes Morrow Bridge returns for one course read or change; they reach a person through the
 * assistant today, and a page that is handed one renders the same words rather than a generic
 * sentence. A code no version of this file knows still reaches the page with its own state name in
 * it, so a support conversation starts from the word the person can see.
 */

const COPY = {
  // --- Connecting Morrow, Chrome and a learning platform ---------------------------------------------
  bridge_not_connected: {
    title: "Morrow is not running on this computer",
    detail: "Morrow Bridge asked the Morrow app on this computer to start a connection, and nothing answered.",
    action: "Open the Morrow app, then select Connect Morrow again.",
  },
  bridge_version_mismatch: {
    title: "Morrow and Morrow Bridge versions do not match",
    detail: "The Morrow app on this computer refused the connection because it expects a different Morrow Bridge.",
    action: "Update Morrow, then reload Morrow Bridge on the Chrome extensions page and select Connect Morrow again.",
  },
  bridge_port_in_use: {
    title: "Another Morrow is already using this connection",
    detail: "Chrome works with one Morrow at a time, and a second Morrow cannot take the connection from the first.",
    action: "Close the other Morrow, or use one Morrow for all your assistants.",
  },
  bridge_extension_unreachable: {
    title: "Morrow Bridge is not answering in Chrome",
    detail: "Chrome could not reach Morrow Bridge, so this page has no current state to show.",
    action: "Open the Chrome extensions page, turn Morrow Bridge on, then open this page again.",
  },
  bridge_extension_reloaded: {
    title: "Morrow Bridge was reloaded while this page was open",
    detail: "Morrow Bridge was reloaded or updated under this tab, so this page is out of date.",
    action: "Reload this page to read the current state.",
  },
  connector_catalog_invalid: {
    title: "Morrow Bridge cannot read its own list of course actions",
    detail: "This Chrome extension is damaged or only partly updated, so it cannot say which course actions it supports.",
    action: "Reload Morrow Bridge on the Chrome extensions page, then open this page again.",
  },
  bridge_request_failed: {
    title: "Morrow could not complete that step",
    detail: "Morrow Bridge reported no reason for this one.",
    action: "Try again. If it continues, check that the Morrow app is running on this computer.",
  },
  course_tab_missing: {
    title: "No signed-in course tab is open here",
    detail: "Morrow connects the signed-in Canvas or Moodle course that is open in front of you, and this Chrome window has none.",
    action: "Open the signed-in Canvas or Moodle course that Morrow should use. Morrow Bridge will identify the platform and show Connect Canvas or Connect Moodle.",
  },
  course_site_access_required: {
    title: "Chrome has not given Morrow access to this Canvas or Moodle address",
    detail: "Morrow reads and changes only the Canvas or Moodle addresses you allow in Chrome, and this one is not allowed yet.",
    action: "Select Connect Canvas or Connect Moodle, whichever Morrow Bridge shows, then choose Allow in Chrome.",
  },
  course_sign_in_required: {
    title: "This tab is not a signed-in course",
    detail: "Morrow could not find a signed-in Canvas or Moodle course in this tab.",
    action: "Open a Canvas or Moodle course and sign in. Morrow Bridge will identify the platform and show the matching Connect button.",
  },
  course_permission_denied: {
    title: "Chrome did not give Morrow access to this Canvas or Moodle address",
    detail: "The Chrome access request was answered with no, so nothing is connected.",
    action: "Select the Connect Canvas or Connect Moodle button again, then choose Allow in Chrome.",
  },
  course_permission_prompt_missing: {
    title: "Chrome did not show its access request",
    detail: "Chrome never displayed the access request, so Morrow received no answer.",
    action: "Close this popup and open it again on the signed-in course. Then select the Connect Canvas or Connect Moodle button it shows.",
  },
  blackboard_browser_unsupported: {
    title: "Morrow does not connect Blackboard through Chrome",
    detail: "Blackboard Learn uses the REST connection in the Morrow app. No live Blackboard site has been tested.",
    action: "Connect Blackboard in the Morrow app, and use Chrome for your Canvas and Moodle courses.",
  },

  // --- Choosing courses and Edit access in Plan and Edit settings -------------------------------
  edit_policy_failed: {
    title: "Morrow could not complete this permission action",
    detail: "Morrow Bridge reported no reason for this one.",
    action: "Refresh this page, then try the change again.",
  },
  edit_policy_status_unreadable: {
    title: "Morrow Bridge answered with a course state this page cannot read",
    detail: "The list of connected courses and Edit lengths did not arrive in the shape this page expects.",
    action: "Refresh this page. If it continues, reload Morrow Bridge on the Chrome extensions page.",
  },
  edit_policy_options_unreadable: {
    title: "Morrow Bridge answered with an action list this page cannot read",
    detail: "The individual actions for this course did not arrive in the shape this page expects, so none are shown.",
    action: "Refresh this page, then open the course again. If it continues, reload Morrow Bridge on the Chrome extensions page.",
  },
  edit_policy_save_unconfirmed: {
    title: "Morrow did not confirm Edit access for one selected course",
    detail: "Morrow Bridge answered without the saved Edit access, so this page cannot say that course has it.",
    action: "Refresh this page to see which courses have Edit access now, then save the rest again.",
  },
  edit_policy_revoke_unconfirmed: {
    title: "Morrow did not confirm that Edit access was removed",
    detail: "Morrow Bridge answered without confirming the removal for one selected course.",
    action: "Refresh this page to see which courses are back in Plan, then return the rest again.",
  },
  edit_policy_binding_missing: {
    title: "This course is no longer connected",
    detail: "The course this action names is not one of the courses connected in this Chrome session.",
    action: "Refresh this page, then reconnect Canvas or Moodle from the Morrow Bridge popup.",
  },
  edit_policy_binding_stale: {
    title: "This course connection needs a signed-in tab again",
    detail: "Edit access is saved only for a Canvas or Moodle connection Morrow can reach now, and this one is closed or signed out.",
    action: "Reconnect Canvas or Moodle from the Morrow Bridge popup, then try again.",
  },
  edit_policy_revision_stale: {
    title: "This course access changed before Morrow could save it",
    detail: "Someone or something changed this course's access while this page was open.",
    action: "Refresh this page, then review the selected courses again.",
  },
  edit_policy_category_unavailable: {
    title: "One selected change type is not available for every selected course",
    detail: "Canvas and Moodle offer different change types, so a mixed selection cannot share one Edit access.",
    action: "Select courses on one platform, then try again.",
  },
  edit_policy_categories_invalid: {
    title: "No change type is selected",
    detail: "Edit access names the exact change types Morrow may make, so it cannot be saved empty.",
    action: "Select at least one available change type before saving.",
  },
  edit_policy_expiration_invalid: {
    title: "That Edit access length is not one Morrow offers",
    detail: "Edit access ends by itself, so it is saved only with one of the listed lengths.",
    action: "Choose one of the listed lengths, then save again.",
  },
  edit_policy_sender_refused: {
    title: "This permission action was not started from Plan and Edit settings",
    detail: "Morrow accepts a permission change only from its own settings page, so nothing changed.",
    action: "Open Plan and Edit settings from the Morrow popup, then make the change there.",
  },
  course_discovery_sender_refused: {
    title: "This course search was not started from Plan and Edit settings",
    detail: "Morrow accepts a course search only from its own settings page, so nothing was read.",
    action: "Open Plan and Edit settings from the Morrow popup, then search there.",
  },
  course_discovery_anchor_missing: {
    title: "No connected learning platform is selected",
    detail: "Morrow lists available courses from one signed-in Canvas or Moodle connection, and none is selected here.",
    action: "Choose the current signed-in Canvas or Moodle connection, then find available courses again.",
  },
  course_discovery_anchor_stale: {
    title: "This learning platform needs a signed-in tab again",
    detail: "Morrow reads available courses through a signed-in tab from that site, and it is closed or signed out.",
    action: "Open one course from this site in Chrome and sign in, then find available courses again.",
  },
  course_discovery_failed: {
    title: "Morrow could not read the available courses",
    detail: "Canvas or Moodle did not return a list Morrow could read.",
    action: "Keep one signed-in course tab open, then try again.",
  },
  course_discovery_more_failed: {
    title: "Morrow could not load more available courses",
    detail: "The courses already listed remain available; only the next page failed.",
    action: "Select Load more available courses to try that page again.",
  },
  course_discovery_receipt_missing: {
    title: "This list of available courses is no longer available",
    detail: "Morrow connects courses only from a list it read in this session, and that list is gone.",
    action: "Find courses again, then connect the courses you want.",
  },
  course_discovery_receipt_stale: {
    title: "This list of available courses has expired",
    detail: "Morrow connects courses only from a current list, so an expired one is not used.",
    action: "Find courses again before connecting courses.",
  },
  course_discovery_complete: {
    title: "Every available course from this platform is already listed",
    detail: "There is no further page to load from this platform.",
    action: "Select the courses you want from the list, then connect them.",
  },
  course_selection_invalid: {
    title: "No available course is selected",
    detail: "Morrow connects the exact courses you select, so it cannot connect an empty selection.",
    action: "Select one or more available courses, then connect them.",
  },
  course_selection_unavailable: {
    title: "One selected course is no longer available from this site",
    detail: "The course list changed after it was read, so Morrow did not connect the selection.",
    action: "Find courses again, then select from the new list.",
  },
  course_selection_target_refused: {
    title: "Morrow could not confirm every selected course",
    detail: "Morrow connects a course only after Canvas or Moodle returns that exact course, and one did not match.",
    action: "Find courses again and select the courses the site returns.",
  },
  binding_limit_reached: {
    title: "Morrow has reached its 500-course limit",
    detail: "This Chrome session already holds the largest number of connected courses Morrow keeps, so it did not connect another.",
    action: "Work with the courses already connected, or select Disconnect Morrow in the Morrow popup and connect only the courses you need.",
  },
  course_file_access_change_failed: {
    title: "Morrow could not turn on course file access",
    detail: "Chrome did not complete the file access request, so course file content stays off.",
    action: "Try Enable course file access again, and choose Allow in Chrome.",
  },
  course_file_access_permission_remove_failed: {
    title: "Course file access is off, and Chrome kept its file permission",
    detail: "Morrow will not read course file content, but Chrome still holds the wider site permission it granted.",
    action: "Remove that permission on the Chrome extensions page under Morrow Bridge site access.",
  },

  // --- One course read or change Morrow Bridge could not complete -------------------------------
  canvas_binding_required: {
    title: "The Canvas or Moodle tab is not open and signed in",
    detail: "Morrow sent nothing. The signed-in Canvas or Moodle tab for this course is closed, signed out, or showing another page.",
    action: "Open the course in Canvas or Moodle and sign in. Morrow Bridge will identify the platform and show the matching Connect button.",
  },
  course_binding_mismatch: {
    title: "That request names a course you have not selected",
    detail: "Morrow sent nothing. Morrow reads and changes only the courses you selected in Plan and Edit settings.",
    action: "Select that course in Plan and Edit settings, or ask your assistant to work in a selected course.",
  },
  course_scope_required: {
    title: "That change does not name one selected course",
    detail: "Morrow sent nothing. A change is made only inside one course you selected, and this one named none.",
    action: "Ask your assistant to name one selected course, then review the change again.",
  },
  edit_policy_stale: {
    title: "Edit access changed before this change was sent",
    detail: "Morrow sent nothing. The Edit access for this course changed after the change was prepared.",
    action: "Ask your assistant to prepare the change again, then review it.",
  },
  edit_policy_rule_refused: {
    title: "That change is outside the Edit access you gave",
    detail: "Morrow sent nothing. The change is not one of the change types selected for this course.",
    action: "Open Plan and Edit settings to see the selected change types, or keep the change in Plan for your review.",
  },
  edit_policy_canvas_content_guard_required: {
    title: "That content repair needs the current page content",
    detail: "Morrow sent nothing. A Canvas content repair is sent only with the exact content it was prepared from.",
    action: "Ask your assistant to read the page again and prepare the repair from what it reads.",
  },
  write_outcome_unknown: {
    title: "Morrow could not confirm what this change saved",
    detail: "The change was sent, and Morrow could not read back whether the course saved it.",
    action: "Ask your assistant to check this change before you make it again. Do not repeat the change.",
  },
  effect_receipt_refused: {
    title: "Morrow will not send this change a second time",
    detail: "Morrow sends each reviewed change once. This one arrived with an approval that is missing, already used, or older than the changes Morrow still holds a record of.",
    action: "Ask your assistant to check the earlier result before it prepares a new change.",
  },
  provider_effect_target_conflict: {
    title: "An earlier change to the same course item is unresolved",
    detail: "Morrow sent nothing. An earlier change to this exact item has no confirmed result yet.",
    action: "Ask your assistant to check that earlier request. If Morrow cannot check it, open that item in your course and confirm it yourself.",
  },
  item_bank_dependency_review_required: {
    title: "Item bank changes need a complete review first",
    detail: "A change to an existing item bank can reach other courses, and Morrow cannot yet establish that evidence.",
    action: "Make this change directly in Canvas or Moodle, or ask your assistant for the focused question image text repair.",
  },
  bridge_maintenance_unavailable: {
    title: "Morrow could not run that upkeep step in Chrome",
    detail: "Morrow Bridge could not complete an upkeep request from Morrow, so nothing changed.",
    action: "Try again. If it continues, reload Morrow Bridge on the Chrome extensions page.",
  },
  canvas_file_storage_access_required: {
    title: "Course file access is off",
    detail: "Morrow reads course file content only while course file access is on, and it is off.",
    action: "Open Plan and Edit settings, then turn on course file access.",
  },
};

// Chrome raises these itself when it cannot deliver a request to the Morrow Bridge background
// worker, or when Morrow Bridge was reloaded under an open page. They arrive as Chrome runtime text
// rather than as a Morrow Bridge code, so they are named here before the copy is read.
const CHROME_RUNTIME_CODES = {
  "Could not establish connection. Receiving end does not exist.": "bridge_extension_unreachable",
  "The message port closed before a response was received.": "bridge_extension_unreachable",
  "Extension context invalidated.": "bridge_extension_reloaded",
};

const CODE_SHAPE = /^[a-z][a-z0-9_]{2,80}$/;

/** Every code this file explains. */
export const PROBLEM_CODES = Object.freeze(Object.keys(COPY));

/**
 * The code to read copy for, from whatever a failed request threw: the code a page raised itself,
 * the code the service worker answered with, or the text Chrome raised. Anything else is the one
 * failure Morrow Bridge cannot name, which has its own copy rather than an invented code.
 */
export function problemCode(cause) {
  const text = String(cause?.code || cause?.message || cause || "").trim();
  if (Object.hasOwn(CHROME_RUNTIME_CODES, text)) return CHROME_RUNTIME_CODES[text];
  return CODE_SHAPE.test(text) ? text : "bridge_request_failed";
}

/** One code as a title, an explanation and a next action. */
export function problemCopy(code) {
  const key = typeof code === "string" ? code.trim() : "";
  const known = Object.hasOwn(COPY, key) ? COPY[key] : null;
  return Object.freeze(known ? { code: key, known: true, ...known } : {
    code: key,
    known: false,
    title: "Morrow could not complete that step",
    detail: `Morrow Bridge reported a state this version does not explain: ${key || "no state name"}.`,
    action: "Try again. If it continues, open the setup guide and give that exact state name when you ask for help.",
  });
}

/** The same three parts as one line, for a page that shows a problem in one region. */
export function problemText(code) {
  const copy = problemCopy(code);
  return `${copy.title}. ${copy.detail} ${copy.action}`;
}
