import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { executeMoodleForumPostInPage } from "../../connector/extension/src/moodle-forum-post-executor.js";

const PRIVATE_SESSION = "moodle-private-session";
const AUTHOR_NAME = "Jane Moodle";
const AUTHOR_EMAIL = "jane@example.edu";
const COURSE_ID = "2";
const MODULE_ID = "8";
const FORUM_ID = "71";
const PRINCIPAL_ID = "3";

const operations = Object.freeze({
  target: { key: "moodle.form.forum.post_target.read.v1", toolName: "moodle_get_forum_post_target", provider: "moodle", readOnly: true },
  create: { key: "moodle.form.forum.discussion.create.write.v1", toolName: "moodle_create_forum_discussion", provider: "moodle", readOnly: false },
  reply: { key: "moodle.form.forum.post.reply.write.v1", toolName: "moodle_reply_to_forum_post", provider: "moodle", readOnly: false },
  lock: { key: "moodle.form.forum.discussion.lock.write.v1", toolName: "moodle_lock_forum_discussion", provider: "moodle", readOnly: false },
  pin: { key: "moodle.form.forum.discussion.pin.write.v1", toolName: "moodle_pin_forum_discussion", provider: "moodle", readOnly: false },
  subscription: { key: "moodle.form.forum.discussion.subscription.write.v1", toolName: "moodle_set_forum_subscription", provider: "moodle", readOnly: false },
});

test("the Moodle Forum discussion lifecycle is cataloged and routed through the extension worker", () => {
  const root = new URL("../..", import.meta.url);
  const catalog = JSON.parse(readFileSync(new URL("connector/extension/generated/moodle-browser-catalog.json", root), "utf8"));
  const entryFor = (key) => {
    const matches = catalog.operations.filter((operation) => operation.key === key);
    assert.equal(matches.length, 1, `${key} is not in the Moodle catalog exactly once`);
    return matches[0];
  };
  for (const operation of Object.values(operations)) {
    const entry = entryFor(operation.key);
    assert.equal(entry.toolName, operation.toolName);
    assert.equal(entry.provider, "moodle");
    assert.equal(entry.readOnly, operation.readOnly);
    if (!operation.readOnly) assert.equal(entry.reviewTool, "moodle_get_forum_post_target");
  }
  const target = entryFor(operations.target.key);
  assert.equal(target.dataClass, "learner");
  assert.equal(target.family, "learner-data");
  assert.match(target.description, /mod\/forum:viewdiscussion/);
  assert.match(target.description, /never opens \/mod\/forum\/view\.php or \/mod\/forum\/discuss\.php/);

  // Each write states the capability its native route requires and that it sends one POST.
  const capabilities = {
    create: "mod/forum:startdiscussion",
    reply: "mod/forum:replypost",
    lock: "moodle\\/course:manageactivities",
    pin: "mod/forum:pindiscussions",
  };
  for (const [name, capability] of Object.entries(capabilities)) {
    assert.match(entryFor(operations[name].key).description, new RegExp(capability.replace(/\\/g, "")));
  }
  for (const name of ["create", "reply", "lock", "pin", "subscription"]) {
    assert.match(entryFor(operations[name].key).description, /sends exactly one POST/);
  }
  // A learner-visible post cannot be undone by Morrow, and both post writes say so.
  for (const name of ["create", "reply"]) {
    const entry = entryFor(operations[name].key);
    assert.equal(entry.irreversible, true);
    assert.equal(entry.inputSchema.properties.learner_visibility_confirmed.type, "boolean");
    assert.match(entry.inputSchema.properties.learner_visibility_confirmed.description, /visible to every learner/);
    assert.match(entry.inputSchema.properties.learner_visibility_confirmed.description, /Morrow cannot remove it/);
    assert.match(entry.description, /learner_visibility_confirmed must be true/);
  }
  for (const name of ["lock", "pin", "subscription"]) {
    assert.match(entryFor(operations[name].key).description, /no browser-callable read of a discussion's locked, pinned, or subscribed state/);
  }

  const worker = readFileSync(new URL("connector/extension/src/service-worker.js", root), "utf8");
  assert.match(worker, /import \{ executeMoodleForumPostInPage \} from "\.\/moodle-forum-post-executor\.js";/);
  assert.match(worker, /MOODLE_FORUM_POST_OPERATION_KEYS = new Set\(\[/);
  for (const operation of Object.values(operations)) assert.ok(worker.includes(`"${operation.key}"`), `${operation.key} is not routed`);
  assert.match(worker, /func: executeMoodleForumPostInPage/);

  // The Edit approval copy states the learner-visible effect before the action is granted.
  const policy = readFileSync(new URL("connector/extension/src/edit-policy.js", root), "utf8");
  assert.match(policy, /MOODLE_LEARNER_POST_NOTE = "What it posts is visible to every learner/);
  assert.match(policy, /moodle_create_forum_discussion/);
  assert.match(policy, /moodle_reply_to_forum_post/);
});

test("the Moodle Forum discussion lifecycle sends one native POST and requires the exact saved result", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-forum-post-"));
  const key = join(directory, "key.pem");
  const certificate = join(directory, "certificate.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", certificate], { stdio: "ignore" });

  const requests = [];
  let origin = "";
  let browser;
  let forumVisible = true;
  let attachmentFileCount = 0;
  let draftListingReadable = true;
  let postResponse = "redirect";
  let writeBehavior = "normal";
  let nextDiscussionId = 1_001;
  let nextPostId = 2_010;
  const discussions = new Map();
  const addDiscussion = (name, subject, message, ownPost) => {
    const discussionId = String(nextDiscussionId += 1);
    const postId = String(nextPostId += 1);
    discussions.set(discussionId, {
      id: discussionId,
      name,
      locked: false,
      pinned: false,
      subscribed: false,
      posts: [{ id: postId, parent: "", subject, message, own: ownPost }],
    });
    return discussionId;
  };
  const seedId = addDiscussion("Week 1 reading", "Week 1 reading", "<p>Please read chapter one.</p>", false);
  discussions.get(seedId).posts.push({
    id: String(nextPostId += 1), parent: discussions.get(seedId).posts[0].id,
    subject: "Re: Week 1 reading", message: "<p>Noted.</p>", own: true,
  });

  const postJson = (discussion, post) => ({
    id: Number(post.id),
    subject: post.subject,
    replysubject: post.subject,
    label: `post by ${AUTHOR_NAME}`,
    message: post.message,
    messageformat: 1,
    author: { id: 7, fullname: AUTHOR_NAME, email: AUTHOR_EMAIL, urls: { profile: "/user/view.php?id=7" } },
    discussionid: Number(discussion.id),
    hasparent: post.parent !== "",
    parentid: post.parent === "" ? null : Number(post.parent),
    timecreated: 1_700_000_000,
    timemodified: 1_700_000_000,
    unread: true,
    isdeleted: false,
    isprivatereply: false,
    attachments: [],
    tags: [],
    capabilities: { view: true, reply: true },
    urls: { view: `/mod/forum/discuss.php?d=${discussion.id}` },
  });
  const discussionExport = (discussion) => ({
    id: Number(discussion.id),
    forumid: Number(FORUM_ID),
    pinned: discussion.pinned,
    locked: discussion.locked,
    istimelocked: false,
    name: discussion.name,
    firstpostid: Number(discussion.posts[0].id),
    times: { modified: 1_700_000_000, start: 0, end: 0, locked: discussion.locked ? 1_700_000_100 : 0 },
    userstate: { subscribed: discussion.subscribed, favourited: false },
    capabilities: { subscribe: true, move: true, pin: true, post: true, manage: true, favourite: true },
    urls: { view: `/mod/forum/discuss.php?d=${discussion.id}`, markasread: "", subscribe: "" },
  });

  const modeditForm = () => `<!doctype html><html><body><form method="post" action="/course/modedit.php?update=8&amp;return=0">
    <input type="hidden" name="course" value="${COURSE_ID}"><input type="hidden" name="coursemodule" value="${MODULE_ID}">
    <input type="hidden" name="update" value="${MODULE_ID}"><input type="hidden" name="modulename" value="forum">
    <input type="hidden" name="instance" value="${FORUM_ID}"><input type="hidden" name="sesskey" value="${PRIVATE_SESSION}">
    <input type="text" name="name" value="Week 3 questions">
    <select name="visible"><option value="1"${forumVisible ? " selected" : ""}>Show</option><option value="0"${forumVisible ? "" : " selected"}>Hide</option></select>
  </form></body></html>`;
  // public/mod/forum/classes/post_form.php builds exactly these controls, and
  // moodleform renders the action as the relative "post.php".
  const postForm = (fields, subject) => `<!doctype html><html><body><form method="post" action="post.php" id="mformforum">
    <input type="hidden" name="sesskey" value="${PRIVATE_SESSION}">
    <input type="hidden" name="_qf__mod_forum_post_form" value="1">
    <input type="text" name="subject" value="${subject}">
    <textarea name="message[text]"></textarea>
    <input type="hidden" name="message[format]" value="1">
    <input type="hidden" name="message[itemid]" value="9001">
    <div data-fieldtype="filemanager"><input type="hidden" name="attachments" value="9002"></div>
    <input type="hidden" name="timestart" value="0"><input type="hidden" name="timeend" value="0">
    <input type="hidden" name="course" value="${COURSE_ID}"><input type="hidden" name="forum" value="${FORUM_ID}">
    <input type="hidden" name="discussion" value="${fields.discussion}"><input type="hidden" name="parent" value="${fields.parent}">
    <input type="hidden" name="groupid" value="0"><input type="hidden" name="edit" value="0">
    <input type="hidden" name="reply" value="${fields.reply}">
    <input type="submit" name="submitbutton" value="Post to forum"><input type="submit" name="cancel" value="Cancel">
  </form></body></html>`;

  const readBody = async (request) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8");
  };
  const json = (response, value) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  };
  const server = createServer({ key: readFileSync(key), cert: readFileSync(certificate) }, async (request, response) => {
    const target = new URL(request.url || "/", origin);
    const record = { method: request.method, pathname: target.pathname, search: target.search, info: target.searchParams.get("info") || "" };
    requests.push(record);
    if (target.pathname === "/course/view.php") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><body class="path-course course-2"><script>var M = { cfg: ${JSON.stringify({ wwwroot: origin, sesskey: PRIVATE_SESSION, userId: Number(PRINCIPAL_ID), courseId: Number(COURSE_ID) })} };</script></body>`);
      return;
    }
    if (request.method === "GET" && target.pathname === "/course/modedit.php" && target.search === "?update=8&return=0") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(modeditForm());
      return;
    }
    if (request.method === "GET" && target.pathname === "/mod/forum/post.php") {
      const forum = target.searchParams.get("forum");
      const reply = target.searchParams.get("reply");
      if (forum === FORUM_ID && !reply) {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(postForm({ discussion: "0", parent: "0", reply: "0" }, ""));
        return;
      }
      const parent = [...discussions.values()].flatMap((discussion) => discussion.posts.map((post) => ({ discussion, post })))
        .filter((entry) => entry.post.id === reply);
      if (parent.length === 1) {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(postForm({ discussion: parent[0].discussion.id, parent: reply, reply }, "Re: prefilled"));
        return;
      }
      response.writeHead(404).end();
      return;
    }
    if (request.method === "POST" && target.pathname === "/mod/forum/post.php") {
      const body = new URLSearchParams(await readBody(request));
      assert.equal(body.get("sesskey"), PRIVATE_SESSION);
      assert.equal(body.get("submitbutton"), "Post to forum");
      assert.equal(body.get("cancel"), null);
      assert.equal(body.get("course"), COURSE_ID);
      assert.equal(body.get("forum"), FORUM_ID);
      assert.equal(body.get("message[format]"), "1");
      const subject = body.get("subject") || "";
      const message = body.get("message[text]") || "";
      const reply = body.get("reply") || "0";
      let location = `/mod/forum/view.php?f=${FORUM_ID}`;
      if (reply === "0") {
        const created = addDiscussion(subject, subject, message, true);
        location = `/mod/forum/discuss.php?d=${created}`;
      } else {
        const discussion = discussions.get(body.get("discussion") || "");
        assert.ok(discussion, "reply names a known discussion");
        discussion.posts.push({ id: String(nextPostId += 1), parent: reply, subject, message, own: true });
        if (writeBehavior === "double-reply") {
          discussion.posts.push({ id: String(nextPostId += 1), parent: reply, subject: "Stray copy", message, own: true });
        }
        location = `/mod/forum/discuss.php?d=${discussion.id}`;
      }
      if (postResponse === "lost") {
        response.writeHead(500, { "content-type": "text/html" });
        response.end("<p>gateway problem</p>");
        return;
      }
      response.writeHead(303, { location });
      response.end();
      return;
    }
    if (request.method === "POST" && target.pathname === "/repository/draftfiles_ajax.php") {
      const body = new URLSearchParams(await readBody(request));
      assert.equal(body.get("sesskey"), PRIVATE_SESSION);
      assert.equal(body.get("filepath"), "/");
      if (!draftListingReadable) {
        json(response, { error: "cannot list this draft area" });
        return;
      }
      const list = Array.from({ length: attachmentFileCount }, (_, index) => ({ filename: `left-behind-${index}.pdf`, filepath: "/" }));
      json(response, { filecount: list.length, list, filepath: [{ path: "/" }] });
      return;
    }
    if (request.method === "POST" && target.pathname === "/lib/ajax/service.php") {
      const call = JSON.parse(await readBody(request))[0];
      assert.equal(target.search, `?sesskey=${PRIVATE_SESSION}&info=${call.methodname}`);
      assert.equal(call.index, 0);
      const answer = (data) => json(response, [{ index: 0, data }]);
      if (call.methodname === "mod_forum_get_discussion_posts") {
        const discussion = discussions.get(String(call.args.discussionid));
        if (!discussion) return json(response, [{ index: 0, error: "invalid discussion", exception: { message: "invalid" } }]);
        assert.deepEqual({ sortby: call.args.sortby, sortdirection: call.args.sortdirection }, { sortby: "id", sortdirection: "ASC" });
        return answer({
          posts: discussion.posts.map((post) => postJson(discussion, post)),
          forumid: Number(FORUM_ID),
          courseid: Number(COURSE_ID),
          ratinginfo: { contextid: 5 },
          warnings: [],
        });
      }
      if (call.methodname === "mod_forum_get_discussion_posts_by_userid") {
        assert.equal(call.args.userid, Number(PRINCIPAL_ID));
        assert.equal(call.args.cmid, Number(MODULE_ID));
        const own = [...discussions.values()].filter((discussion) => discussion.posts.some((post) => post.own));
        return answer({
          discussions: own.map((discussion) => ({
            name: discussion.name,
            id: Number(discussion.id),
            timecreated: 1_700_000_000,
            authorfullname: AUTHOR_NAME,
            posts: {
              userposts: discussion.posts.filter((post) => post.own).map((post) => postJson(discussion, post)),
              parentposts: [],
            },
          })),
          warnings: [],
        });
      }
      if (call.methodname === "mod_forum_set_lock_state") {
        const discussion = discussions.get(String(call.args.discussionid));
        assert.equal(call.args.forumid, Number(FORUM_ID));
        // public/mod/forum/externallib.php locks when targetstate is 0.
        if (writeBehavior !== "ignore-state") discussion.locked = call.args.targetstate === 0;
        const saved = discussionExport(discussion);
        return answer({ id: saved.id, locked: saved.locked, times: { locked: saved.times.locked } });
      }
      if (call.methodname === "mod_forum_set_pin_state") {
        const discussion = discussions.get(String(call.args.discussionid));
        discussion.pinned = call.args.targetstate === 1;
        return answer(discussionExport(discussion));
      }
      if (call.methodname === "mod_forum_set_subscription_state") {
        const discussion = discussions.get(String(call.args.discussionid));
        assert.equal(call.args.forumid, Number(FORUM_ID));
        discussion.subscribed = call.args.targetstate === true;
        return answer(discussionExport(discussion));
      }
      return json(response, [{ index: 0, error: "unknown method", exception: { message: "unknown" } }]);
    }
    response.writeHead(404).end();
  });

  try {
    await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", (error) => (error ? reject(error) : resolve())));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    origin = `https://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    const page = await browser.newPage({ ignoreHTTPSErrors: true });
    await page.goto(`${origin}/course/view.php?id=2`);
    const invoke = (operation, args) => page.evaluate(
      executeMoodleForumPostInPage,
      JSON.stringify({
        mode: "execute",
        operation,
        arguments: args,
        binding: { origin, siteUrl: `${origin}/`, principalId: PRINCIPAL_ID, courseId: COURSE_ID },
        expiresAt: Date.now() + 60_000,
      }),
    );
    const dispatches = () => requests.filter((entry) => (entry.method === "POST" && entry.pathname === "/mod/forum/post.php")
      || (entry.method === "POST" && entry.pathname === "/lib/ajax/service.php" && entry.info.startsWith("mod_forum_set_"))).length;
    const executorRoutes = ["/course/modedit.php", "/mod/forum/post.php", "/lib/ajax/service.php", "/repository/draftfiles_ajax.php"];
    const nativeRequests = () => requests.filter((entry) => executorRoutes.includes(entry.pathname)).length;

    // An argument the operation does not name reaches no native route.
    const beforeInvalid = nativeRequests();
    assert.deepEqual(
      await invoke(operations.target, { course_id: 2, module_id: 8, extra: true }),
      { ok: false, sent: false, error: "moodle_forum_post_arguments_invalid" },
    );
    assert.equal(nativeRequests(), beforeInvalid);

    // The Forum target read, with no discussion named.
    const forumTarget = await invoke(operations.target, { course_id: 2, module_id: 8 });
    assert.equal(forumTarget.ok, true, JSON.stringify(forumTarget));
    assert.deepEqual(forumTarget.data, {
      schema: "morrow.moodle-forum-post-target.v1",
      provider: "moodle",
      course_id: COURSE_ID,
      module_id: MODULE_ID,
      forum_id: FORUM_ID,
      forum_name: "Week 3 questions",
      visible: true,
      proof: {
        method: "course_modedit_form",
        exact_module_binding: "course_modedit_form",
        required_capability: "mod/forum:viewdiscussion",
        scope: "one_forum_module",
        learner_identity: "never_returned",
        post_body: "never_returned",
      },
    });
    assert.deepEqual(forumTarget.targets, [{ field: "module_id", label: "Forum", name: "Week 3 questions" }]);
    assert.match(forumTarget.snapshot_digest, /^[a-f0-9]{64}$/);

    // The discussion target read carries post structure and no author or body.
    const seed = discussions.get(seedId);
    const discussionTarget = await invoke(operations.target, { course_id: 2, module_id: 8, discussion_id: Number(seedId) });
    assert.equal(discussionTarget.ok, true, JSON.stringify(discussionTarget));
    assert.equal(discussionTarget.data.discussion_id, seedId);
    assert.equal(discussionTarget.data.discussion_subject, "Week 1 reading");
    assert.equal(discussionTarget.data.post_count, 2);
    assert.deepEqual(discussionTarget.data.posts, [
      { post_id: seed.posts[0].id, parent_post_id: "", subject: "Week 1 reading", deleted: false, private_reply: false, attachment_count: 0 },
      { post_id: seed.posts[1].id, parent_post_id: seed.posts[0].id, subject: "Re: Week 1 reading", deleted: false, private_reply: false, attachment_count: 0 },
    ]);
    assert.deepEqual(discussionTarget.targets, [
      { field: "module_id", label: "Forum", name: "Week 3 questions" },
      { field: "discussion_id", label: "Discussion", name: "Week 1 reading" },
    ]);
    for (const leak of [PRIVATE_SESSION, AUTHOR_NAME, AUTHOR_EMAIL, "Please read chapter one", "Noted.", '"userid":7']) {
      assert.equal(JSON.stringify(discussionTarget).includes(leak), false, `the target read leaked ${leak}`);
    }

    const forumDigest = forumTarget.snapshot_digest;
    const seedDigest = discussionTarget.snapshot_digest;
    const newDiscussion = {
      course_id: 2, module_id: 8, subject: "Week 3 office hours", message_html: "<p>Office hours move to Friday.</p>",
      learner_visibility_confirmed: true, expected_digest: forumDigest,
    };

    // A digest that does not match the exact bound Forum sends nothing.
    let mark = dispatches();
    assert.deepEqual(
      await invoke(operations.create, { ...newDiscussion, expected_digest: "0".repeat(64) }),
      { ok: false, sent: false, status: 200, error: "moodle_expected_digest_mismatch" },
    );
    assert.equal(dispatches(), mark);

    // A visible Forum refuses an unconfirmed learner-visible post before send.
    assert.deepEqual(
      await invoke(operations.create, { ...newDiscussion, learner_visibility_confirmed: false }),
      { ok: false, sent: false, status: 200, error: "moodle_forum_learner_visibility_unconfirmed" },
    );
    assert.equal(dispatches(), mark);

    // A message that names a Moodle file sends nothing.
    assert.deepEqual(
      await invoke(operations.create, { ...newDiscussion, message_html: '<img src="@@PLUGINFILE@@/chart.png">' }),
      { ok: false, sent: false, status: 200, error: "moodle_forum_post_message_refused" },
    );
    assert.equal(dispatches(), mark);

    // A draft file area that is not empty refuses after the form is read and before the POST.
    attachmentFileCount = 1;
    const refused = await invoke(operations.create, newDiscussion);
    assert.deepEqual(refused, { ok: false, sent: false, status: 200, error: "moodle_forum_post_attachment_area_refused" });
    assert.equal(dispatches(), mark);
    assert.ok(requests.some((entry) => entry.method === "GET" && entry.pathname === "/mod/forum/post.php"), "the native post form was read");
    attachmentFileCount = 0;

    // One POST starts exactly one discussion, and the readback requires the approved post.
    mark = dispatches();
    const created = await invoke(operations.create, newDiscussion);
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.equal(dispatches(), mark + 1);
    assert.deepEqual(created.verification, { schema: "morrow.browser-verification.v1", status: "verified" });
    const createdDiscussion = [...discussions.values()].find((discussion) => discussion.name === "Week 3 office hours");
    assert.ok(createdDiscussion, "the fixture saved the discussion");
    assert.equal(created.data.discussion_id, createdDiscussion.id);
    assert.equal(created.data.created_post_id, createdDiscussion.posts[0].id);
    assert.equal(created.data.post_count, 1);
    assert.deepEqual(created.data.posts, [
      { post_id: createdDiscussion.posts[0].id, parent_post_id: "", subject: "Week 3 office hours", deleted: false, private_reply: false, attachment_count: 0 },
    ]);
    assert.deepEqual(created.data.proof, {
      method: "mod_forum_post_form",
      native_route: "/mod/forum/post.php",
      exact_module_binding: "course_modedit_form",
      required_capability: "mod/forum:startdiscussion",
      dispatch_count: 1,
      readback: "mod_forum_get_discussion_posts_by_userid",
      saved_state_source: "native_readback",
      learner_visible: true,
      learner_identity: "never_returned",
    });
    assert.equal(createdDiscussion.posts[0].message, "<p>Office hours move to Friday.</p>");
    assert.equal(JSON.stringify(created).includes(PRIVATE_SESSION), false);
    // Chromium reports the native same-origin POST redirect as opaqueredirect
    // and does not follow it, so the reported status is the readback's.
    assert.equal(created.status, 200);

    // One POST adds exactly one reply, and every other post is required unchanged.
    mark = dispatches();
    const replied = await invoke(operations.reply, {
      course_id: 2, module_id: 8, discussion_id: Number(seedId), parent_post_id: Number(seed.posts[0].id),
      subject: "Re: Week 1 reading", message_html: "<p>Chapter two is optional.</p>",
      learner_visibility_confirmed: true, expected_digest: seedDigest,
    });
    assert.equal(replied.ok, true, JSON.stringify(replied));
    assert.equal(dispatches(), mark + 1);
    assert.equal(replied.data.post_count, 3);
    assert.equal(replied.data.created_post_id, seed.posts[2].id);
    assert.deepEqual(replied.data.posts[2], {
      post_id: seed.posts[2].id, parent_post_id: seed.posts[0].id, subject: "Re: Week 1 reading",
      deleted: false, private_reply: false, attachment_count: 0,
    });
    assert.equal(replied.data.proof.required_capability, "mod/forum:replypost");
    assert.equal(seed.posts[2].message, "<p>Chapter two is optional.</p>");

    // A parent post outside the approved discussion sends nothing.
    mark = dispatches();
    const foreignParent = await invoke(operations.reply, {
      course_id: 2, module_id: 8, discussion_id: Number(seedId), parent_post_id: Number(createdDiscussion.posts[0].id),
      subject: "Re: Week 1 reading", message_html: "<p>Wrong thread.</p>",
      learner_visibility_confirmed: true, expected_digest: seedDigest,
    });
    assert.deepEqual(foreignParent, { ok: false, sent: false, status: 200, error: "moodle_forum_post_parent_unavailable" });
    assert.equal(dispatches(), mark);

    // Lock, pin and subscription each send one POST to their own native service.
    const currentDigest = async () => (await invoke(operations.target, { course_id: 2, module_id: 8, discussion_id: Number(seedId) })).snapshot_digest;
    mark = dispatches();
    const locked = await invoke(operations.lock, { course_id: 2, module_id: 8, discussion_id: Number(seedId), locked: true, expected_digest: await currentDigest() });
    assert.equal(locked.ok, true, JSON.stringify(locked));
    assert.equal(dispatches(), mark + 1);
    assert.equal(locked.data.locked, true);
    assert.equal(seed.locked, true);
    assert.equal(locked.data.proof.saved_state_source, "native_set_state_response");
    assert.equal(locked.data.proof.required_capability, "moodle/course:manageactivities");

    mark = dispatches();
    const pinned = await invoke(operations.pin, { course_id: 2, module_id: 8, discussion_id: Number(seedId), pinned: true, expected_digest: await currentDigest() });
    assert.equal(pinned.ok, true, JSON.stringify(pinned));
    assert.equal(dispatches(), mark + 1);
    assert.equal(pinned.data.pinned, true);
    assert.equal(seed.pinned, true);

    mark = dispatches();
    const subscribed = await invoke(operations.subscription, { course_id: 2, module_id: 8, discussion_id: Number(seedId), subscribed: true, expected_digest: await currentDigest() });
    assert.equal(subscribed.ok, true, JSON.stringify(subscribed));
    assert.equal(dispatches(), mark + 1);
    assert.equal(subscribed.data.subscribed, true);
    assert.equal(seed.subscribed, true);

    // A hidden Forum is where Morrow accepts an unconfirmed post, because no
    // learner can see it yet.
    forumVisible = false;
    const hiddenTarget = await invoke(operations.target, { course_id: 2, module_id: 8 });
    assert.equal(hiddenTarget.data.visible, false);
    mark = dispatches();
    const hiddenPost = await invoke(operations.create, {
      course_id: 2, module_id: 8, subject: "Draft notice", message_html: "<p>Not published yet.</p>",
      learner_visibility_confirmed: false, expected_digest: hiddenTarget.snapshot_digest,
    });
    assert.equal(hiddenPost.ok, true, JSON.stringify(hiddenPost));
    assert.equal(dispatches(), mark + 1);
    forumVisible = true;

    // A draft area Morrow cannot read is refused as unverified, not assumed empty.
    draftListingReadable = false;
    mark = dispatches();
    const unverifiedTarget = await invoke(operations.target, { course_id: 2, module_id: 8 });
    assert.deepEqual(
      await invoke(operations.create, { ...newDiscussion, subject: "Unverified area", expected_digest: unverifiedTarget.snapshot_digest }),
      { ok: false, sent: false, status: 200, error: "moodle_forum_post_attachment_area_unverified" },
    );
    assert.equal(dispatches(), mark);
    draftListingReadable = true;

    // A readback that shows more than the approved change is a mismatch, not a success.
    writeBehavior = "double-reply";
    mark = dispatches();
    const strayReply = await invoke(operations.reply, {
      course_id: 2, module_id: 8, discussion_id: Number(seedId), parent_post_id: Number(seed.posts[0].id),
      subject: "Re: Week 1 reading", message_html: "<p>One reply only.</p>",
      learner_visibility_confirmed: true, expected_digest: await currentDigest(),
    });
    assert.equal(strayReply.ok, false);
    assert.equal(strayReply.sent, true);
    assert.equal(strayReply.error, "moodle_write_not_verified");
    assert.deepEqual(strayReply.verification, {
      schema: "morrow.browser-verification.v1", status: "mismatch", reason: "moodle_forum_post_readback_mismatch",
    });
    assert.equal(dispatches(), mark + 1);
    writeBehavior = "normal";

    // A native service that does not apply the approved state is a mismatch too.
    writeBehavior = "ignore-state";
    mark = dispatches();
    const notApplied = await invoke(operations.lock, {
      course_id: 2, module_id: 8, discussion_id: Number(seedId), locked: false, expected_digest: await currentDigest(),
    });
    assert.equal(notApplied.ok, false);
    assert.equal(notApplied.sent, true);
    assert.deepEqual(notApplied.verification, {
      schema: "morrow.browser-verification.v1", status: "mismatch", reason: "moodle_forum_post_state_not_applied",
    });
    assert.equal(dispatches(), mark + 1);
    assert.equal(seed.locked, true, "the fixture kept the state the service refused to change");
    writeBehavior = "normal";

    // A lost response after one dispatch is applied_or_unknown, and nothing is sent again.
    postResponse = "lost";
    const lostTarget = await invoke(operations.target, { course_id: 2, module_id: 8 });
    mark = dispatches();
    const lost = await invoke(operations.create, {
      course_id: 2, module_id: 8, subject: "Lost response", message_html: "<p>Sent once.</p>",
      learner_visibility_confirmed: true, expected_digest: lostTarget.snapshot_digest,
    });
    assert.deepEqual(lost, {
      ok: false,
      sent: true,
      status: 500,
      outcomeUnknown: true,
      verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_forum_post_write_unconfirmed" },
      error: "moodle_forum_post_write_unconfirmed",
    });
    assert.equal(dispatches(), mark + 1);
    assert.ok([...discussions.values()].some((discussion) => discussion.name === "Lost response"), "the fixture saved the discussion the response lost");
    postResponse = "redirect";

    // Morrow never opens a Forum view or discussion route.
    assert.equal(requests.some((entry) => entry.pathname === "/mod/forum/view.php" || entry.pathname === "/mod/forum/discuss.php"), false);
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});
