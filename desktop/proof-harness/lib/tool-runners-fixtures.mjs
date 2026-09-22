// Controls that need something to work on which the sandbox does not already hold: a page whose
// image has no description, a quiz whose questions can be reordered. The fixture is made here,
// proven against, and removed.
import { createHash } from "node:crypto";

export function fixtureRunners({ COURSE, SOURCE_BINDING, mark, state, callTool, read, change, plan }) {
  const sha256 = (text) => createHash("sha256").update(String(text)).digest("hex");
  const IMAGE = "https://chcp.instructure.com/courses/89585/files/12030079/preview";
  const BODY = `<p>Before the image.</p><p><img src="${IMAGE}"></p><p>After the image.</p>`;

  /** One page carrying an image with no description, made once and reused. */
  const pageWithAnUndescribedImage = async () => {
    if (state.altPageUrl) return state.altPageUrl;
    const title = `${mark} alt fixture`;
    const made = await change("fixture.page.create", "canvas_create_page_courses", {
      course_id: COURSE, wiki_page_title: title, wiki_page_body: BODY, wiki_page_published: false,
    });
    if (made.outcome !== "verified") return null;
    const pages = await read("canvas_list_pages_courses", { course_id: COURSE, search_term: title });
    const saved = (Array.isArray(pages.data) ? pages.data : [])[0];
    state.altPageUrl = saved ? String(saved.url) : null;
    return state.altPageUrl;
  };

  const pageBody = async (url) => {
    const shown = await read("canvas_show_page_courses", { course_id: COURSE, url_or_id: url });
    return String(shown.data?.body ?? "");
  };

  return {
    morrow_plan_page_image_alt_repair: async () => {
      const url = await pageWithAnUndescribedImage();
      if (!url) return { blocked: "This run could not create a page to repair." };
      const body = await pageBody(url);
      const src = /<img[^>]+src="([^"]+)"/.exec(body)?.[1];
      if (!src) return { blocked: "The page Canvas saved carries no image to describe." };
      const made = await plan("fixture.page.alt", "morrow_plan_page_image_alt_repair", {
        course_id: COURSE, page_url: url,
        expected_body_sha256: sha256(body), image_index: 0, image_src_sha256: sha256(src),
        alt_text: "A diagram of a plant cell", decorative: false,
      });
      // The proof is Canvas's own copy of the page carrying the description.
      const after = await pageBody(url);
      const described = /<img[^>]+alt="A diagram of a plant cell"/.test(after);
      return { ok: made.outcome === "verified" && described, detail: { outcome: made.outcome, canvasShowsTheDescription: described } };
    },
    morrow_plan_page_correction: async () => {
      const url = await pageWithAnUndescribedImage();
      if (!url) return { blocked: "This run could not create a page to correct." };
      const made = await plan("fixture.page.correct", "morrow_plan_page_correction", {
        course_id: COURSE, page_url: url, find_text: "After the image.", replace_text: "After the image, corrected.",
      });
      const after = await pageBody(url);
      const corrected = after.includes("After the image, corrected.");
      return { ok: made.outcome === "verified" && corrected, detail: { outcome: made.outcome, canvasShowsTheCorrection: corrected } };
    },
    morrow_plan_new_quiz_assignment_group_order: async () => {
      const quizId = state.quizId;
      if (!quizId) return { blocked: "This run has no quiz to order." };
      const made = await plan("fixture.quiz.group.order", "morrow_plan_new_quiz_assignment_group_order", {
        course_id: COURSE, quiz_id: quizId, position: 1,
      });
      return { ok: made.outcome === "verified", detail: { outcome: made.outcome } };
    },
    morrow_plan_new_quiz_item_order: async () => {
      const quizId = state.quizId;
      if (!quizId) return { blocked: "This run has no quiz whose questions can be ordered." };
      const items = await callTool("morrow_capability_read", { name: "canvas_list_quiz_items",
        arguments: { course_id: COURSE, assignment_id: quizId, _morrow: { source_binding_id: SOURCE_BINDING } } }, 300_000);
      const held = items?.structuredContent?.data ?? {};
      const rows = held?.result?.data ?? held?.data ?? [];
      if (!Array.isArray(rows) || rows.length < 2) return { blocked: "The quiz holds fewer than two questions, so there is no order to change." };
      const ordered = [...rows].reverse().map((row) => String(row.id));
      const made = await plan("fixture.quiz.item.order", "morrow_plan_new_quiz_item_order", {
        course_id: COURSE, quiz_id: quizId, ordered_item_ids: ordered,
      });
      return { ok: made.outcome === "verified", detail: { outcome: made.outcome, questions: ordered.length } };
    },
  };
}
