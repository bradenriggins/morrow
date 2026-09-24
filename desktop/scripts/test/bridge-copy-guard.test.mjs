import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { LoopbackApprovalServer } from "../../packages/mcp-server/dist/approval-server.js";
import { LoopbackBridgeServer } from "../../packages/bridge-loopback/dist/index.js";

const root = new URL("../../", import.meta.url);

/**
 * The only eyebrow labels Morrow is allowed to render. Every line on a Bridge surface has to
 * state a function, an action, a result, or a constraint, so a label that only decorates the
 * heading under it is refused. Keep this list short: add an entry only when the label carries
 * information that appears nowhere else on the page, and say here what that information is.
 *
 * - The question names say which kind of quiz question the approval preview shows. When the name
 *   is known the raw type is removed from the question settings list, so this is its only place.
 */
export const ALLOWED_EYEBROWS = new Set([
  "Question preview",
  "Multiple choice",
  "Multiple answer",
  "True or false",
  "Written response",
  "Matching",
  "Ordering",
  "Categorization",
  "File upload",
  "Formula",
  "Fill in the blank",
  "Hot spot",
  "Numeric answer",
]);

/** Extension pages a person opens directly. Each is checked as shipped, not as a source string. */
const EXTENSION_PAGES = [
  "connector/extension/popup/popup.html",
  "connector/extension/settings/settings.html",
  "connector/extension/onboarding/onboarding.html",
];

const CURRENT_SETUP_SURFACES = [
  ...EXTENSION_PAGES,
  "connector/extension/popup/popup-view.js",
  "connector/extension/popup/popup.js",
  "connector/extension/settings/settings.js",
  "connector/extension/onboarding/onboarding-state.js",
  "connector/extension/src/bridge-problem-copy.js",
  "connector/extension/src/service-worker.js",
  "installer/renderer/index.html",
  "installer/shared/setup-view.mjs",
  "packages/bridge-loopback/src/index.ts",
  "README.md",
  "docs/implementation/MCP-START-HERE.md",
];

/**
 * Reads the visible text of every element whose class list holds `eyebrow`. It walks the markup
 * to the element's own closing tag, so a label wrapped in a link or a `<strong>` is still read.
 */
function eyebrowLabels(html) {
  const labels = [];
  const opening = /<([a-z][a-z0-9-]*)\b[^>]*\bclass="([^"]*)"[^>]*>/gi;
  for (let match = opening.exec(html); match; match = opening.exec(html)) {
    if (!match[2].split(/\s+/).includes("eyebrow")) continue;
    const tag = match[1].toLowerCase();
    const close = html.toLowerCase().indexOf(`</${tag}>`, opening.lastIndex);
    assert.notEqual(close, -1, `an eyebrow <${tag}> element is never closed`);
    labels.push(html.slice(opening.lastIndex, close).replaceAll(/<[^>]*>/g, "").replaceAll(/\s+/g, " ").trim());
  }
  return labels;
}

function refuseDecorativeEyebrows(source, html) {
  for (const label of eyebrowLabels(html)) {
    assert.ok(
      ALLOWED_EYEBROWS.has(label),
      `${source} shows the eyebrow label "${label}". Remove it, or replace it with a line that states a function, an action, a result, or a constraint. Add it to ALLOWED_EYEBROWS only when it carries information the rest of the page does not.`,
    );
  }
}

function approvalController(snapshot) {
  return {
    operationGet: () => snapshot,
    operationList: () => ({ schema: "morrow.operations.list.v1", returned: 1, operations: [snapshot] }),
    approveOperation: () => snapshot,
    runApprovedOperation: async () => undefined,
    cancelOperation: () => snapshot,
    setApprovalBaseUrl: () => undefined,
  };
}

/** Runs one approval server against a fixed snapshot and returns the pages it renders. */
async function approvalPages(snapshot) {
  const server = new LoopbackApprovalServer(approvalController(snapshot));
  try {
    const baseUrl = await server.start();
    const operation = `${baseUrl}/operations/${encodeURIComponent(snapshot.operationId)}`;
    const html = { accept: "text/html" };
    return {
      review: await (await fetch(operation, { headers: html })).text(),
      notFound: await (await fetch(`${baseUrl}/not-a-review`, { headers: html })).text(),
      refused: await (await fetch(`${operation}/approve`, { method: "POST", headers: html })).text(),
    };
  } finally {
    await server.close();
  }
}

test("the eyebrow reader finds the labels a page really renders", () => {
  const guide = readFileSync(new URL("connector/extension/onboarding/onboarding.html", root), "utf8");
  assert.deepEqual(eyebrowLabels(guide), []);
  assert.match(guide, /<h2 id="next-title">/);
  assert.deepEqual(eyebrowLabels('<p class="lede eyebrow">Read <b>this</b>\n  line</p>'), ["Read this line"]);
  assert.deepEqual(eyebrowLabels('<p class="eyebrows">Not an eyebrow</p>'), []);
});

test("the popup, settings, and setup guide carry no decorative eyebrow label", () => {
  for (const page of EXTENSION_PAGES) {
    refuseDecorativeEyebrows(page, readFileSync(new URL(page, root), "utf8"));
  }
});

test("the settings page states its headings without a label above each one", () => {
  const settings = readFileSync(new URL("connector/extension/settings/settings.html", root), "utf8");
  assert.deepEqual(eyebrowLabels(settings), []);
  assert.match(settings, /<h1>Plan and Edit settings<\/h1>/);
  assert.match(settings, /<h2 id="courses-title">Your courses<\/h2>/);
  assert.doesNotMatch(settings, /id="site-discovery-title"/);
  assert.match(settings, /<h3 id="file-storage-title">Course file access<\/h3>/);
  assert.match(settings, /<h2 id="mode-title">Course access<\/h2>/);
  // The order between choosing courses and choosing access is stated as a constraint the reader
  // can act on, so no "Step 1" or "Step 2" label is needed to carry it.
  assert.match(settings, /Select courses, then choose Edit to review the available actions\./);
});

// The popup, the setup guide, and the error copy send the educator to "Plan and Edit settings", so the
// page they land on carries that exact name in its tab title and its heading.
test("the settings page carries the name every link to it uses", () => {
  const read = (path) => readFileSync(new URL(path, root), "utf8");
  const settings = read("connector/extension/settings/settings.html");
  const name = "Plan and Edit settings";
  assert.match(read("connector/extension/popup/popup.html"), new RegExp(`id="editing-settings"[^>]*>Open ${name}<`));
  assert.match(read("connector/extension/onboarding/onboarding.html"), new RegExp(`id="open-settings"[^>]*>Open ${name}<`));
  assert.match(read("connector/extension/src/bridge-problem-copy.js"), new RegExp(`Open ${name}`));
  assert.match(settings, new RegExp(`<title>Morrow Bridge: ${name}</title>`));
  assert.match(settings, new RegExp(`<h1>${name}</h1>`));
});

test("current setup surfaces use three stages and platform-specific course actions", () => {
  const retired = [];
  for (const path of CURRENT_SETUP_SURFACES) {
    const source = readFileSync(new URL(path, root), "utf8");
    if (/Connect course(?: site)?\b/i.test(source)) retired.push(`${path}: retired course action`);
    if (/\b(?:All steps|Six steps)\b/i.test(source)) retired.push(`${path}: retired setup count`);
  }
  assert.deepEqual(retired, []);
  const app = readFileSync(new URL("installer/shared/setup-view.mjs", root), "utf8");
  assert.match(app, /\["Assistant", "Morrow Bridge", "Course"\]/);
  const popup = readFileSync(new URL("connector/extension/popup/popup-view.js", root), "utf8");
  assert.match(popup, /"Connect this course"/);
  assert.match(popup, /"Open Canvas or Moodle"/);
  const popupPage = readFileSync(new URL("connector/extension/popup/popup.html", root), "utf8");
  const help = popupPage.match(/<summary>How to connect<\/summary>\s*<ol>([\s\S]*?)<\/ol>/)?.[1] || "";
  assert.equal((help.match(/<li>/g) || []).length, 3, "popup help must keep the same three setup stages as the app and website");
  assert.match(help, /Choose your assistant[\s\S]*Finish Morrow Bridge setup[\s\S]*Open and connect your course/);
});

test("the popup discloses course data use before its connection action", () => {
  const popup = readFileSync(new URL("connector/extension/popup/popup.html", root), "utf8");
  const disclosure = popup.indexOf('class="data-disclosure"');
  const consentAction = popup.indexOf('id="consent-action"');
  const connectionAction = popup.indexOf('id="primary"');
  assert.ok(disclosure >= 0 && disclosure < consentAction && consentAction < connectionAction,
    "the disclosure and its agreement action must appear before the connection action");
  assert.match(popup, /reads the Canvas or Moodle pages and course content needed for your requests/);
  assert.match(popup, /Course content can include names, email addresses, and messages/);
  assert.match(popup, /to the assistant you choose/);
  assert.match(popup, /Your Chrome password and cookies stay in Chrome/);
  assert.match(popup, /href="https:\/\/meetmorrow\.app\/privacy"/);
  assert.match(popup, /Agree and continue/);
  assert.match(popup, /will not connect to Morrow or read course data before you agree/);
});

test("the approval pages carry no decorative eyebrow label", async () => {
  const pages = await approvalPages({
    operationId: "op:copy-guard-review",
    state: "awaiting_approval",
    approvalExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    plan: {
      tool: "canvas_create_quiz_item",
      arguments: {
        item_entry_title: "Red blood cell function",
        item_entry_interaction_type_slug: "choice",
        item_entry_item_body: "<p>What do red blood cells carry?</p>",
        item_points_possible: 1,
      },
    },
  });
  for (const [name, html] of Object.entries(pages)) {
    refuseDecorativeEyebrows(`the approval ${name} page`, html);
  }
  // Proves the pages really rendered, so an empty read cannot pass the check above.
  assert.match(pages.review, /<header class="hero"><h1>Add question\?<\/h1>/);
  assert.deepEqual(eyebrowLabels(pages.review), ["Multiple choice"]);
  assert.match(pages.notFound, /<section class="outcome"><h1>Check this request<\/h1>/);
  assert.match(pages.refused, /<section class="outcome"><h1>Review unavailable<\/h1>/);
});

/**
 * Renders the pairing pages a person sees when Morrow asks for the Chrome connection: the page
 * that asks, the page after the answer, and the page a used or expired link opens.
 */
/**
 * What the Bridge server answers for a pairing a person would once have approved on a page. Pairing
 * now happens in the Morrow Bridge popup alone, so the server serves no page for it.
 */
async function pairingAnswers() {
  const extensionId = "a".repeat(32);
  const catalogDigest = "a".repeat(64);
  const runtimeRevision = "7".repeat(40);
  const server = new LoopbackBridgeServer({
    token: "secret-".repeat(8),
    expectedRuntimeRevision: runtimeRevision,
    expectedCatalogDigest: catalogDigest,
    port: 0,
    pairingEnabled: true,
    pairingSecret: () => ({ challengeId: "morrow-0123456789abcdef0123456789abcdef", nonce: "n".repeat(43), extensionId }),
  });
  try {
    const address = await server.start();
    const origin = `chrome-extension://${extensionId}`;
    const created = await fetch(`http://${address.host}:${address.port}${address.path}/pair`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ extensionId, catalogDigest, runtimeRevision }),
    });
    assert.equal(created.status, 201);
    const { pairingId } = await created.json();
    const page = await fetch(`http://${address.host}:${address.port}${address.path}/pair/${pairingId}`, { headers: { accept: "text/html" } });
    return { status: page.status, contentType: page.headers.get("content-type"), body: await page.text() };
  } finally {
    await server.close();
  }
}

test("pairing is a Morrow Bridge popup step with no page of its own", async () => {
  const answer = await pairingAnswers();
  assert.equal(answer.status, 404);
  assert.match(answer.contentType, /^application\/json/);
  assert.doesNotMatch(answer.body, /<html|Allow connection/i);
  const popup = readFileSync(new URL("../../connector/extension/popup/popup-view.js", import.meta.url), "utf8");
  assert.match(popup, /Select Connect Morrow to connect this extension to Morrow\. Connecting does not approve changes to your courses\./);
});

test("the approval result page states the result without a label above it", async () => {
  const pages = await approvalPages({
    operationId: "op:copy-guard-result",
    state: "verified",
    plan: { tool: "canvas_update_page", arguments: {} },
  });
  refuseDecorativeEyebrows("the approval result page", pages.review);
  assert.match(pages.review, /<section class="outcome outcome-success"><svg class="success-mark"[^>]*>.*?<\/svg><h1>Canvas saved the change\. Morrow checked the result\.<\/h1>/);
});
