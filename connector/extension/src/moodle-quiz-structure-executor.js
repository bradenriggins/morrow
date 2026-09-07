/**
 * Reads the complete slot layout of one exact Moodle Quiz and changes one slot
 * in it: its order, its maximum mark, the page break before it, or its removal
 * from the Quiz.
 *
 * None of these operations creates, updates or deletes a Question bank entry.
 * Removing a slot deletes the Quiz's own reference row and leaves the bank
 * entry itself in place, which is what
 * `structure::remove_slot` does: it deletes the `question_references` or
 * `question_set_references` row for that slot and the `quiz_slots` row, and it
 * touches no `question_bank_entries` or `question` record.
 * https://github.com/moodle/moodle/blob/v5.2.2/public/mod/quiz/classes/structure.php#L1047-L1110
 * The deterministic Question bank hold in
 * connector/extension/src/moodle-executor.js stays in force.
 *
 * The one native route these four changes use is the Quiz edit AJAX endpoint
 * `/mod/quiz/edit_rest.php`, which is the endpoint the Quiz edit page's own
 * controls post to. Every branch used here requires `mod/quiz:manage` at the
 * Quiz module context and runs inside one delegated transaction.
 * https://github.com/moodle/moodle/blob/v5.2.2/public/mod/quiz/edit_rest.php#L34-L217
 * The exact field names come from the native controls themselves: the move
 * from the drag-and-drop handler, the mark and the removal from the resource
 * toolbox, and the page break from its add/remove control.
 * https://github.com/moodle/moodle/blob/v5.2.2/public/mod/quiz/yui/src/dragdrop/js/resource.js#L117-L143
 * https://github.com/moodle/moodle/blob/v5.2.2/public/mod/quiz/yui/src/toolboxes/js/resource.js#L190-L195
 * https://github.com/moodle/moodle/blob/v5.2.2/public/mod/quiz/yui/src/toolboxes/js/resource.js#L409-L423
 * https://github.com/moodle/moodle/blob/v5.2.2/public/mod/quiz/yui/src/toolboxes/js/resource.js#L495-L508
 * The layout is read from the native Quiz edit page, whose renderer emits one
 * `li.page` per page and one `li.slot` per slot inside each section list.
 * https://github.com/moodle/moodle/blob/v5.2.2/public/mod/quiz/classes/output/edit_renderer.php#L525-L610
 *
 * Three facts keep these operations honest and are stated in every result.
 *
 * 1. The Quiz's own record ID, which `edit_rest.php` requires as `quizid`, is
 *    exposed to a browser only by the native page-break control, whose address
 *    carries it. Moodle renders that control between two questions of one
 *    section, and only while the Quiz can still be edited, which Moodle
 *    decides by whether the Quiz already has attempts.
 *    https://github.com/moodle/moodle/blob/v5.2.2/public/mod/quiz/classes/output/edit_renderer.php#L559-L565
 *    https://github.com/moodle/moodle/blob/v5.2.2/public/mod/quiz/classes/output/edit_renderer.php#L995-L1040
 *    A Quiz that has attempts, and a Quiz whose every section holds one
 *    question, therefore expose no such control, and every change here refuses
 *    before its first native request. Morrow does not read the attempt count
 *    itself, so it reports the absent controls and never states why they are
 *    absent.
 * 2. Each change is bound to the native control for that exact operation on
 *    that exact slot: the move handle, the mark editor, the page-break control
 *    on the preceding slot, and the removal control. Moodle renders each of
 *    them only where it accepts the change, so a slot without the control is
 *    refused rather than attempted.
 * 3. Moodle renumbers Quiz pages to consecutive numbers after every one of
 *    these changes, and it drops a page that becomes empty.
 *    https://github.com/moodle/moodle/blob/v5.2.2/public/mod/quiz/classes/structure.php#L996-L1039
 *    The readback therefore compares the whole page layout, not the page
 *    numbers a slot happened to carry before.
 *
 * Chrome serializes this function for a MAIN-world injection. Keep every
 * dependency inside the function body.
 */
export async function executeMoodleQuizStructureInPage(rawInput) {
  const PROVIDER = "moodle";
  const SCHEMA = "morrow.moodle-quiz-structure.v1";
  const EDIT_PATH = "/mod/quiz/edit.php";
  const EDIT_REST_PATH = "/mod/quiz/edit_rest.php";
  const REPAGINATE_PATH = "/mod/quiz/repaginate.php";
  const EDIT_PAGE_BODY_ID = "page-mod-quiz-edit";
  const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
  const MAX_SLOTS = 100;
  const MAX_SECTIONS = 20;
  const MAX_NAME_LENGTH = 1_333;
  // repaginate::LINK removes the page break before a slot, repaginate::UNLINK adds one.
  // https://github.com/moodle/moodle/blob/v5.2.2/public/mod/quiz/classes/repaginate.php#L36-L38
  const PAGE_BREAK_LINK = "1";
  const PAGE_BREAK_UNLINK = "2";
  const ID = /^[1-9][0-9]{0,18}$/;
  const DIGEST = /^[a-f0-9]{64}$/;
  const QTYPE = /^[a-z][a-z0-9_]{0,63}$/;
  const MARK = /^(?:0|[1-9][0-9]{0,3})(?:\.([0-9]{1,3}))?$/;
  const NATIVE_MARK = /^(?:0|[1-9][0-9]{0,3})(?:[.,][0-9]{1,3})?$/;
  const definitions = Object.freeze({
    "moodle.form.mod.quiz.edit.structure.read.v1": { toolName: "moodle_get_quiz_structure", readOnly: true, kind: "read" },
    "moodle.form.mod.quiz.edit.slot.move.write.v1": { toolName: "moodle_reorder_quiz_slot", readOnly: false, kind: "move" },
    "moodle.form.mod.quiz.edit.slot.maxmark.write.v1": { toolName: "moodle_set_quiz_slot_mark", readOnly: false, kind: "mark" },
    "moodle.form.mod.quiz.edit.slot.pagebreak.write.v1": { toolName: "moodle_set_quiz_page_break", readOnly: false, kind: "pagebreak" },
    "moodle.form.mod.quiz.edit.slot.remove.write.v1": { toolName: "moodle_remove_quiz_slot", readOnly: false, kind: "remove" },
  });
  const proof = Object.freeze({
    method: "native_quiz_edit_action",
    read_route: EDIT_PATH,
    write_route: EDIT_REST_PATH,
    required_capability: "mod/quiz:manage",
    scope: "quiz_structure_only",
    question_bank_effect: "none",
  });
  const object = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const input = (() => { try { return typeof rawInput === "string" ? JSON.parse(rawInput) : rawInput; } catch { return null; } })();
  const failure = (error, status) => ({ ok: false, sent: false, ...(Number.isInteger(status) ? { status } : {}), error });
  const unconfirmedWrite = (error, status) => ({
    ok: false,
    sent: true,
    ...(Number.isInteger(status) ? { status } : {}),
    outcomeUnknown: true,
    verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: error },
    error,
  });
  const id = (value) => {
    const text = typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? String(value) : typeof value === "string" ? value : "";
    return ID.test(text) ? text : "";
  };
  const collapsed = (value, maximum = MAX_NAME_LENGTH) => {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    return text && text.length <= maximum && !/[\u0000-\u001f\u007f]/.test(text) ? text : "";
  };
  const stable = (value) => {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
    return JSON.stringify(value === undefined ? null : value);
  };
  const digest = async (value) => {
    if (!globalThis.crypto?.subtle || typeof globalThis.TextEncoder !== "function") throw new Error("moodle_quiz_structure_digest_unavailable");
    const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable(value)));
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
  };
  const currentContext = () => {
    const cfg = globalThis.M?.cfg;
    if (!object(cfg) || typeof cfg.wwwroot !== "string" || typeof cfg.sesskey !== "string" || !collapsed(cfg.sesskey, 1_024)) return null;
    const principalId = id(cfg.userId);
    if (!principalId) return null;
    let site;
    try { site = new URL(cfg.wwwroot); } catch { return null; }
    if (site.protocol !== "https:" || site.search || site.hash || site.username || site.password) return null;
    const currentOrigin = String(globalThis.location?.origin || "");
    const currentPath = String(globalThis.location?.pathname || "");
    const basePath = site.pathname.replace(/\/$/, "");
    if (site.origin !== currentOrigin || !(currentPath === basePath || currentPath.startsWith(`${basePath}/`))) return null;
    const configuredCourse = id(cfg.courseId);
    const bodyCourse = String(globalThis.document?.body?.className || "").match(/(?:^|\s)course-([1-9][0-9]*)(?:\s|$)/)?.[1] || "";
    if (configuredCourse && bodyCourse && bodyCourse !== configuredCourse) return null;
    const anchorCourseId = configuredCourse || bodyCourse;
    if (!anchorCourseId) return null;
    return { origin: site.origin, siteUrl: site.href, basePath, principalId, anchorCourseId, sesskey: cfg.sesskey };
  };
  const sameContext = (left, right) => left?.origin === right?.origin && left?.siteUrl === right?.siteUrl
    && left?.basePath === right?.basePath && left?.principalId === right?.principalId
    && left?.anchorCourseId === right?.anchorCourseId && left?.sesskey === right?.sesskey;
  const urlFor = (context, path, params) => {
    const url = new URL(context.siteUrl);
    url.pathname = `${context.basePath}${path}`;
    url.search = new URLSearchParams(params).toString();
    url.hash = "";
    return url;
  };
  const sameRoute = (value, expected) => {
    let received;
    try { received = new URL(value); } catch { return false; }
    return received.origin === expected.origin && received.pathname === expected.pathname && received.search === expected.search
      && !received.hash && !received.username && !received.password;
  };
  const boundedText = async (response, endpoint, context) => {
    const declared = response?.headers?.get?.("content-length");
    if (declared !== null && (!/^(?:0|[1-9][0-9]*)$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) return null;
    if (!response?.ok || !sameRoute(response.url, endpoint) || !sameContext(context, currentContext())
      || !response.body || typeof response.body.getReader !== "function" || typeof globalThis.TextDecoder !== "function") return null;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let result = "";
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        if (!(next.value instanceof Uint8Array) || (bytes += next.value.byteLength) > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          return null;
        }
        result += decoder.decode(next.value, { stream: true });
      }
      return result + decoder.decode();
    } catch {
      try { await reader.cancel(); } catch {}
      return null;
    }
  };
  const readEditPage = async (context, courseId, moduleId) => {
    if (!Number.isSafeInteger(input.expiresAt) || Date.now() >= input.expiresAt) return { error: "moodle_execution_expired" };
    const endpoint = urlFor(context, EDIT_PATH, { cmid: moduleId });
    let response;
    try {
      response = await fetch(endpoint, { method: "GET", credentials: "include", cache: "no-store", redirect: "error", headers: { Accept: "text/html" } });
    } catch { return { error: "moodle_quiz_structure_read_unavailable" }; }
    const html = await boundedText(response, endpoint, context);
    if (typeof html !== "string" || typeof globalThis.DOMParser !== "function") {
      return { error: "moodle_quiz_structure_read_unavailable", status: response.status };
    }
    let parsed;
    try { parsed = new DOMParser().parseFromString(html, "text/html"); } catch { return { error: "moodle_quiz_structure_read_unavailable", status: response.status }; }
    const body = parsed.body;
    const courseClass = String(body?.className || "").match(/(?:^|\s)course-([1-9][0-9]*)(?:\s|$)/)?.[1] || "";
    // The page names both the Quiz edit screen and the course it belongs to, so
    // an activity outside the approved course cannot be reached through cmid.
    if (String(body?.id || "") !== EDIT_PAGE_BODY_ID || courseClass !== courseId) {
      return { error: "moodle_quiz_structure_target_invalid", status: response.status };
    }
    return { document: parsed, status: response.status, endpoint };
  };
  const controlUrl = (node, endpoint, context, path) => {
    let url;
    try { url = new URL(node.getAttribute("href") || "", endpoint); } catch { return null; }
    return url.origin === context.origin && url.pathname === `${context.basePath}${path}` && !url.username && !url.password ? url : null;
  };
  const singleControl = (node, selector) => {
    const found = [...node.querySelectorAll(selector)];
    return found.length === 1 ? found[0] : null;
  };
  /**
   * Reads the whole native slot layout: every section, every page and every
   * slot in the order the Quiz edit page renders them, together with the native
   * control that governs each change on each slot.
   */
  const parseStructure = (documentValue, context, endpoint) => {
    const roots = [...documentValue.querySelectorAll('ul.slots[role="presentation"]')];
    if (roots.length !== 1) return { error: "moodle_quiz_structure_layout_invalid" };
    const sectionNodes = [...roots[0].children].filter((node) => node.matches?.('li.section.main[id^="section-"]'));
    if (!sectionNodes.length) return { error: "moodle_quiz_structure_layout_invalid" };
    const slotNodeCount = [...roots[0].querySelectorAll('li.slot[id^="slot-"]')].length;
    if (sectionNodes.length > MAX_SECTIONS || slotNodeCount > MAX_SLOTS) {
      return { truncated: true, sectionCount: sectionNodes.length, slotCount: slotNodeCount };
    }
    const sectionIds = [];
    const slots = [];
    const pages = [];
    const seenSlots = new Set();
    let quizId = "";
    for (const sectionNode of sectionNodes) {
      const sectionId = id(String(sectionNode.getAttribute("id") || "").slice("section-".length));
      if (!sectionId || sectionIds.includes(sectionId)) return { error: "moodle_quiz_structure_layout_invalid" };
      sectionIds.push(sectionId);
      const lists = [...sectionNode.querySelectorAll("ul.section.img-text")];
      if (lists.length !== 1) return { error: "moodle_quiz_structure_layout_invalid" };
      let pageIndex = -1;
      for (const node of lists[0].children) {
        if (node.matches?.('li.page[id^="page-"]')) {
          pages.push([]);
          pageIndex = pages.length - 1;
          continue;
        }
        if (!node.matches?.('li.slot[id^="slot-"]')) continue;
        // Moodle opens every page with its own list item, so a slot before one
        // means this is not the layout this reader was written for.
        if (pageIndex < 0) return { error: "moodle_quiz_structure_layout_invalid" };
        const slotId = id(String(node.getAttribute("id") || "").slice("slot-".length));
        const qtypeClass = [...node.classList].find((name) => name.startsWith("qtype_"));
        const questionType = qtypeClass && QTYPE.test(qtypeClass.slice("qtype_".length)) ? qtypeClass.slice("qtype_".length) : "";
        if (!slotId || !questionType || seenSlots.has(slotId)) return { error: "moodle_quiz_structure_layout_invalid" };
        seenSlots.add(slotId);
        const position = slots.length + 1;
        const markNodes = [...node.querySelectorAll(".instancemaxmark")];
        if (markNodes.length !== 1) return { error: "moodle_quiz_structure_layout_invalid" };
        const markText = collapsed(markNodes[0].textContent || "", 64);
        if (markText && !NATIVE_MARK.test(markText)) return { error: "moodle_quiz_structure_layout_invalid" };
        const decimalClass = [...markNodes[0].classList].find((name) => /^decimalplaces_[0-9]$/.test(name));
        const decimalPlaces = decimalClass ? Number(decimalClass.slice("decimalplaces_".length)) : null;
        const removeControl = singleControl(node, 'a.editing_delete[data-action="delete"]');
        const removeUrl = removeControl ? controlUrl(removeControl, endpoint, context, EDIT_PATH) : null;
        const breakControl = singleControl(node, "a.page_split_join[data-action]");
        const breakAction = breakControl ? String(breakControl.getAttribute("data-action") || "") : "";
        const breakUrl = breakControl ? controlUrl(breakControl, endpoint, context, REPAGINATE_PATH) : null;
        // The page-break control is the one place the native page names the
        // Quiz record, and it names the slot it sits on and the direction it
        // offers. All three must agree with the layout read here.
        let breakOffer = "";
        if (breakControl) {
          const expectedRepag = breakAction === "addpagebreak" ? PAGE_BREAK_UNLINK : breakAction === "removepagebreak" ? PAGE_BREAK_LINK : "";
          const controlQuizId = breakUrl ? id(breakUrl.searchParams.get("quizid")) : "";
          if (!breakUrl || !expectedRepag || !controlQuizId || breakUrl.searchParams.get("repag") !== expectedRepag
            || breakUrl.searchParams.get("slot") !== String(position) || (quizId && quizId !== controlQuizId)) {
            return { error: "moodle_quiz_structure_layout_invalid" };
          }
          quizId = controlQuizId;
          breakOffer = breakAction;
        }
        const name = collapsed(node.querySelector(".instancename")?.textContent || "");
        pages[pageIndex].push(slotId);
        slots.push({
          slot_id: Number(slotId),
          position,
          page: pageIndex + 1,
          section_id: Number(sectionId),
          question_type: questionType,
          ...(name ? { name } : {}),
          max_mark: markText || null,
          ...(decimalPlaces === null ? {} : { mark_decimal_places: decimalPlaces }),
          starts_new_page: pages[pageIndex].length === 1,
          can_reorder: Boolean(singleControl(node, 'a.editing_move[data-action="move"]')),
          can_set_mark: Boolean(singleControl(node, 'a.editing_maxmark[data-action="editmaxmark"]')),
          can_remove: Boolean(removeControl && removeUrl && removeUrl.searchParams.get("remove") === String(position)),
          _breakOffer: breakOffer,
        });
      }
    }
    if (pages.some((page) => page.length === 0)) return { error: "moodle_quiz_structure_layout_invalid" };
    for (let index = 0; index < slots.length; index += 1) {
      const previous = slots[index - 1];
      const offer = previous && previous.section_id === slots[index].section_id ? previous._breakOffer : "";
      // The control on the previous slot states the current page relationship.
      // A disagreement with the rendered page list means the two halves of the
      // page describe different layouts.
      if (offer && (offer === "addpagebreak") === slots[index].starts_new_page) return { error: "moodle_quiz_structure_layout_invalid" };
      slots[index].can_set_page_break = Boolean(offer);
    }
    for (const slot of slots) delete slot._breakOffer;
    return { sectionIds, slots, pages, quizId };
  };
  const markValue = (text) => (text === null ? null : Number(String(text).replace(",", ".")));
  const layoutOf = (structure) => ({
    pages: structure.pages,
    slots: structure.slots.map((slot) => ({
      slot_id: slot.slot_id,
      section_id: slot.section_id,
      question_type: slot.question_type,
      mark_value: markValue(slot.max_mark),
    })),
  });
  const outputFor = (courseId, moduleId, structure) => (structure.truncated
    ? {
      schema: SCHEMA,
      course_id: Number(courseId),
      module_id: Number(moduleId),
      complete: false,
      section_count: structure.sectionCount,
      slot_count: structure.slotCount,
      slot_changes_available: false,
      slot_changes_unavailable: "quiz_larger_than_supported_bound",
      proof,
    }
    : {
      schema: SCHEMA,
      course_id: Number(courseId),
      module_id: Number(moduleId),
      complete: true,
      ...(structure.quizId ? { quiz_id: Number(structure.quizId) } : {}),
      section_ids: structure.sectionIds.map(Number),
      section_count: structure.sectionIds.length,
      slot_count: structure.slots.length,
      page_count: structure.pages.length,
      slots: structure.slots,
      slot_changes_available: Boolean(structure.quizId),
      ...(structure.quizId ? {} : { slot_changes_unavailable: "quiz_edit_controls_absent" }),
      proof,
    });
  const readStructure = async (context, courseId, moduleId) => {
    const page = await readEditPage(context, courseId, moduleId);
    if (page.error) return { error: page.error, status: page.status };
    const structure = parseStructure(page.document, context, page.endpoint);
    if (structure.error) return { error: structure.error, status: page.status };
    const data = outputFor(courseId, moduleId, structure);
    // A result never carries the session key, whatever control it came from.
    if (stable(data).includes(context.sesskey)) return { error: "moodle_quiz_structure_layout_invalid", status: page.status };
    return { structure, data, status: page.status, snapshotDigest: await digest(data) };
  };
  const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
  const argumentsFor = (definition, args, binding) => {
    const courseId = id(binding?.courseId);
    if (!courseId) return null;
    const base = ["course_id", "module_id"];
    const fields = definition.kind === "read" ? base
      : definition.kind === "move" ? [...base, "slot_id", "after_slot_id", "expected_digest"]
        : definition.kind === "mark" ? [...base, "slot_id", "max_mark", "expected_digest"]
          : definition.kind === "pagebreak" ? [...base, "slot_id", "starts_new_page", "expected_digest"]
            : [...base, "slot_id", "expected_digest"];
    if (!exactKeys(args, fields) || id(args.course_id) !== courseId || !id(args.module_id)) return null;
    const bound = { courseId, moduleId: id(args.module_id) };
    if (definition.kind === "read") return bound;
    if (!id(args.slot_id) || !DIGEST.test(String(args.expected_digest || ""))) return null;
    const write = { ...bound, slotId: id(args.slot_id), expectedDigest: args.expected_digest };
    if (definition.kind === "move") {
      if (args.after_slot_id !== null && !id(args.after_slot_id)) return null;
      const afterSlotId = args.after_slot_id === null ? "" : id(args.after_slot_id);
      return afterSlotId === write.slotId ? null : { ...write, afterSlotId };
    }
    if (definition.kind === "mark") {
      const requested = typeof args.max_mark === "string" ? args.max_mark : "";
      const decimals = MARK.exec(requested);
      return decimals ? { ...write, maxMark: requested, maxMarkDecimals: decimals[1] ? decimals[1].length : 0 } : null;
    }
    if (definition.kind === "pagebreak") {
      return typeof args.starts_new_page === "boolean" ? { ...write, startsNewPage: args.starts_new_page } : null;
    }
    return write;
  };
  const withoutSlot = (pages, slotId) => pages.map((page) => page.filter((entry) => entry !== slotId)).filter((page) => page.length > 0);
  /**
   * The exact layout the approved change must produce, derived from the layout
   * that was just read. Every other slot, its section, its question type and
   * its mark stay as they are.
   */
  const plannedLayout = (definition, structure, args, slot) => {
    const before = layoutOf(structure);
    if (definition.kind === "mark") {
      return {
        pages: before.pages,
        slots: before.slots.map((entry) => (entry.slot_id === slot.slot_id ? { ...entry, mark_value: Number(args.maxMark) } : entry)),
      };
    }
    if (definition.kind === "remove") {
      return {
        pages: withoutSlot(before.pages, String(slot.slot_id)),
        slots: before.slots.filter((entry) => entry.slot_id !== slot.slot_id),
      };
    }
    if (definition.kind === "pagebreak") {
      const pageIndex = slot.page - 1;
      const withinPage = before.pages[pageIndex].indexOf(String(slot.slot_id));
      const pages = before.pages.map((page) => [...page]);
      if (args.startsNewPage) {
        const moved = pages[pageIndex].splice(withinPage);
        pages.splice(pageIndex + 1, 0, moved);
      } else {
        const moved = pages.splice(pageIndex, 1)[0];
        pages[pageIndex - 1].push(...moved);
      }
      return { pages, slots: before.slots };
    }
    const pages = withoutSlot(before.pages, String(slot.slot_id));
    const moved = before.slots.find((entry) => entry.slot_id === slot.slot_id);
    const rest = before.slots.filter((entry) => entry.slot_id !== slot.slot_id);
    if (!args.afterSlotId) {
      pages[0].unshift(String(slot.slot_id));
      return { pages, slots: [moved, ...rest] };
    }
    const pageIndex = pages.findIndex((page) => page.includes(args.afterSlotId));
    const withinPage = pages[pageIndex].indexOf(args.afterSlotId);
    pages[pageIndex].splice(withinPage + 1, 0, String(slot.slot_id));
    const afterIndex = rest.findIndex((entry) => String(entry.slot_id) === args.afterSlotId);
    return { pages, slots: [...rest.slice(0, afterIndex + 1), moved, ...rest.slice(afterIndex + 1)] };
  };
  /**
   * Binds the change to the native control for that operation on that slot, and
   * refuses a request the native page does not offer there.
   */
  const boundChange = (definition, structure, args) => {
    const slot = structure.slots.find((entry) => String(entry.slot_id) === args.slotId);
    if (!slot) return { error: "moodle_quiz_structure_slot_not_found" };
    if (definition.kind === "mark") {
      if (!slot.can_set_mark || slot.max_mark === null) return { error: "moodle_quiz_structure_operation_not_offered" };
      if (slot.mark_decimal_places === undefined || args.maxMarkDecimals > slot.mark_decimal_places) return { error: "moodle_quiz_structure_mark_precision_refused" };
      if (markValue(slot.max_mark) === Number(args.maxMark)) return { error: "moodle_quiz_structure_change_not_needed" };
      return { slot, fields: { field: "updatemaxmark", id: args.slotId, maxmark: args.maxMark } };
    }
    if (definition.kind === "remove") {
      if (!slot.can_remove) return { error: "moodle_quiz_structure_operation_not_offered" };
      const sectionSlots = structure.slots.filter((entry) => entry.section_id === slot.section_id);
      // structure::remove_slot refuses to empty a section while others remain.
      if (sectionSlots.length === 1 && structure.sectionIds.length > 1) return { error: "moodle_quiz_structure_section_would_be_empty" };
      return { slot, fields: { action: "DELETE", id: args.slotId } };
    }
    if (definition.kind === "pagebreak") {
      if (!slot.can_set_page_break) return { error: "moodle_quiz_structure_operation_not_offered" };
      if (slot.starts_new_page === args.startsNewPage) return { error: "moodle_quiz_structure_change_not_needed" };
      return { slot, fields: { field: "updatepagebreak", id: args.slotId, value: args.startsNewPage ? PAGE_BREAK_UNLINK : PAGE_BREAK_LINK } };
    }
    if (!slot.can_reorder) return { error: "moodle_quiz_structure_operation_not_offered" };
    const sectionSlots = structure.slots.filter((entry) => entry.section_id === slot.section_id);
    // structure::move_slot refuses to take the last slot out of a section.
    if (sectionSlots.length === 1) return { error: "moodle_quiz_structure_section_would_be_empty" };
    const after = args.afterSlotId ? structure.slots.find((entry) => String(entry.slot_id) === args.afterSlotId) : null;
    if (args.afterSlotId && !after) return { error: "moodle_quiz_structure_slot_not_found" };
    // A move across Quiz sections is not available: the native action then also
    // moves section boundaries, and this reader cannot state the exact result.
    const targetSectionId = after ? after.section_id : structure.slots[0].section_id;
    if (targetSectionId !== slot.section_id) return { error: "moodle_quiz_structure_move_across_sections_refused" };
    if (after ? after.position === slot.position - 1 : slot.position === 1) return { error: "moodle_quiz_structure_change_not_needed" };
    return {
      slot,
      fields: {
        field: "move",
        id: args.slotId,
        sectionId: String(slot.section_id),
        page: String(after ? after.page : 1),
        ...(after ? { previousid: args.afterSlotId } : {}),
      },
    };
  };
  const dispatched = { sent: false };
  const dispatch = async (context, courseId, quizId, fields) => {
    const preflight = currentContext();
    if (!sameContext(context, preflight)) return { error: "moodle_form_session_mismatch" };
    if (!Number.isSafeInteger(input.expiresAt) || Date.now() >= input.expiresAt) return { error: "moodle_execution_expired" };
    const endpoint = urlFor(context, EDIT_REST_PATH, {});
    const body = new URLSearchParams({ sesskey: context.sesskey, courseid: courseId, quizid: quizId, class: "resource", ...fields });
    let response;
    try {
      dispatched.sent = true;
      response = await fetch(endpoint, {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body,
      });
    } catch { return { unconfirmed: "moodle_quiz_structure_write_unconfirmed" }; }
    const raw = await boundedText(response, endpoint, context);
    if (typeof raw !== "string") return { unconfirmed: "moodle_quiz_structure_write_unconfirmed", status: response.status };
    let payload;
    try { payload = JSON.parse(raw); } catch { return { unconfirmed: "moodle_quiz_structure_write_unconfirmed", status: response.status }; }
    return { payload, status: response.status };
  };
  const acceptedResponse = (kind, payload) => {
    if (!object(payload) || payload.error !== undefined || payload.exception !== undefined) return false;
    if (kind === "move") return payload.visible === true;
    if (kind === "mark") return typeof payload.instancemaxmark === "string" && typeof payload.newsummarks === "string";
    if (kind === "pagebreak") return object(payload.slots);
    return payload.deleted === true;
  };

  try {
    const context = currentContext();
    if (input?.mode !== "execute" || !context) return failure("moodle_session_unavailable");
    if (!Number.isSafeInteger(input.expiresAt) || Date.now() >= input.expiresAt) return failure("moodle_execution_expired");
    const definition = object(input.operation) && typeof input.operation.key === "string" ? definitions[input.operation.key] : null;
    if (!definition || input.operation.provider !== PROVIDER || input.operation.toolName !== definition.toolName
      || input.operation.readOnly !== definition.readOnly) return failure("moodle_operation_refused");
    const binding = input.binding;
    if (!object(binding) || binding.origin !== context.origin || binding.siteUrl !== context.siteUrl
      || id(binding.principalId) !== context.principalId || id(binding.courseId) !== context.anchorCourseId) return failure("moodle_binding_mismatch");
    const args = argumentsFor(definition, input.arguments, binding);
    if (!args) return failure("moodle_quiz_structure_arguments_invalid");

    const before = await readStructure(context, args.courseId, args.moduleId);
    if (before.error) return failure(before.error, before.status);
    if (definition.readOnly) return { ok: true, sent: true, status: before.status, data: before.data, snapshot_digest: before.snapshotDigest };
    if (before.snapshotDigest !== args.expectedDigest) return failure("moodle_expected_digest_mismatch", before.status);
    if (before.structure.truncated) return failure("moodle_quiz_structure_incomplete", before.status);
    if (!before.structure.quizId) return failure("moodle_quiz_structure_edit_controls_absent", before.status);
    const planned = boundChange(definition, before.structure, args);
    if (planned.error) return failure(planned.error, before.status);

    // The layout is read once more immediately before the change is sent, and
    // the change is bound to that reading.
    const fresh = await readStructure(context, args.courseId, args.moduleId);
    if (fresh.error) return failure(fresh.error, fresh.status);
    if (fresh.snapshotDigest !== args.expectedDigest) return failure("moodle_expected_digest_mismatch", fresh.status);
    const confirmed = boundChange(definition, fresh.structure, args);
    if (confirmed.error) return failure(confirmed.error, fresh.status);
    const expected = plannedLayout(definition, fresh.structure, args, confirmed.slot);

    const result = await dispatch(context, args.courseId, fresh.structure.quizId, confirmed.fields);
    if (result.error) return failure(result.error, fresh.status);
    if (result.unconfirmed) return unconfirmedWrite(result.unconfirmed, result.status);
    if (!acceptedResponse(definition.kind, result.payload)) return unconfirmedWrite("moodle_quiz_structure_write_unconfirmed", result.status);

    const after = await readStructure(context, args.courseId, args.moduleId);
    if (after.error) return unconfirmedWrite("moodle_quiz_structure_readback_unconfirmed", result.status);
    if (after.structure.truncated || stable(layoutOf(after.structure)) !== stable(expected)) {
      return unconfirmedWrite("moodle_quiz_structure_write_not_verified", result.status);
    }
    return {
      ok: true,
      sent: true,
      status: result.status,
      data: after.data,
      snapshot_digest: after.snapshotDigest,
      verification: { schema: "morrow.browser-verification.v1", status: "verified" },
    };
  } catch (error) {
    if (dispatched.sent) return unconfirmedWrite("moodle_quiz_structure_write_unconfirmed");
    const message = String(error?.message || error);
    return failure(message.startsWith("moodle_") ? message : "moodle_quiz_structure_execution_failed");
  }
}
