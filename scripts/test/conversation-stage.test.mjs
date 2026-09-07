import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

/**
 * The gate on the homepage conversation stage. The site shows five conversations and releases the
 * messages of the selected one in order. That drip is decoration; the conversation is the page
 * content. These tests hold the rule that makes the decoration safe: the reader always ends with a
 * whole conversation, and no message is hidden unless the drip can actually run.
 *
 * The tests drive `website/conversation-stage.js` through plain objects and a clock they advance by
 * hand. They prove the state machine only. A real IntersectionObserver, a real `matchMedia`, and the
 * animation class `website/script.js` adds are browser behaviour and are not exercised here.
 *
 * `website/` is gitignored (.gitignore:23) and `pnpm scripts:test` globs `scripts/test/*.test.mjs`,
 * so this file also runs in checkouts that do not hold the site. It skips there instead of failing.
 */
const modulePath = new URL("../../website/conversation-stage.js", import.meta.url);
const present = existsSync(modulePath);
const skip = present ? false : "website/conversation-stage.js is not present in this checkout";
const { createConversationStage, GUARANTEED_REVEAL_MS, REVEAL_INTERVAL_MS } = present
  ? await import(modulePath.href)
  : {};

/** A clock the tests drive by hand. `advance` runs every timer that comes due, earliest first. */
function createClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout(run, delay) {
      const id = nextId++;
      timers.set(id, { run, at: now + Math.max(0, Number(delay) || 0) });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    get pending() {
      return timers.size;
    },
    advance(ms) {
      const until = now + ms;
      for (;;) {
        let dueId = null;
        let due = null;
        for (const [id, timer] of timers) {
          if (timer.at <= until && (due === null || timer.at < due.at)) {
            dueId = id;
            due = timer;
          }
        }
        if (dueId === null) break;
        timers.delete(dueId);
        now = due.at;
        due.run();
      }
      now = until;
    },
  };
}

/** The two fields the machine reads from a message element: it hides it, and it hands it back. */
const conversation = (name, count) =>
  Array.from({ length: count }, (_, index) => ({ label: `${name}-${index}`, hidden: false }));

const shown = (messages) => messages.filter((message) => !message.hidden).map((message) => message.label);
const notShown = (messages) => messages.filter((message) => message.hidden).map((message) => message.label);

function stageUnderTest({ stories = [conversation("a", 6), conversation("b", 6)], ...options } = {}) {
  const clock = createClock();
  const reveals = [];
  const selections = [];
  const stage = createConversationStage({
    stories,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onReveal: (message, animate) => reveals.push({ label: message.label, animate }),
    onSelect: (index, detail) => selections.push({ index, detail }),
    ...options,
  });
  return { stage, clock, stories, reveals, selections };
}

test("a stage that never becomes visible still shows the whole conversation", { skip }, () => {
  const { stage, clock, stories } = stageUnderTest();
  stage.start();

  // The old script hid every message while it wired the stage, so a deep link below the hero, or an
  // IntersectionObserver that had not answered yet, left a full-height card with nothing in it.
  // Nothing is hidden until a drip can run, so there is nothing to recover and no timer to wait on.
  assert.deepEqual(shown(stories[0]), ["a-0", "a-1", "a-2", "a-3", "a-4", "a-5"]);
  assert.equal(clock.pending, 0);

  clock.advance(GUARANTEED_REVEAL_MS * 5);
  assert.deepEqual(notShown(stories[0]), []);
  assert.equal(clock.pending, 0);
});

test("a page loaded in a hidden tab shows the whole conversation, then plays it on arrival", { skip }, () => {
  const { stage, clock, stories } = stageUnderTest({ pageHidden: true, stageVisible: true });
  stage.start();
  clock.advance(GUARANTEED_REVEAL_MS * 5);
  assert.deepEqual(notShown(stories[0]), []);
  assert.equal(clock.pending, 0);

  stage.setPageHidden(false);
  assert.deepEqual(shown(stories[0]), ["a-0"]);
  clock.advance(REVEAL_INTERVAL_MS * 5);
  assert.equal(shown(stories[0]).length, 6);
});

test("the conversation plays one message at a time once the stage is on screen", { skip }, () => {
  const { stage, clock, stories, reveals } = stageUnderTest();
  stage.start();
  stage.setStageVisible(true);

  assert.deepEqual(shown(stories[0]), ["a-0"]);
  clock.advance(REVEAL_INTERVAL_MS);
  assert.deepEqual(shown(stories[0]), ["a-0", "a-1"]);
  clock.advance(REVEAL_INTERVAL_MS * 4);
  assert.equal(shown(stories[0]).length, 6);

  // Each message the drip released is animated, and no timer is left behind: the bounded wait was
  // dropped when the drip started, so it can never cut a running conversation short.
  assert.deepEqual(reveals.map((reveal) => reveal.animate), [true, true, true, true, true, true]);
  assert.equal(clock.pending, 0);
});

test("choosing another conversation shows all of it at once", { skip }, () => {
  const { stage, clock, stories, selections, reveals } = stageUnderTest();
  stage.start();
  stage.setStageVisible(true);
  clock.advance(REVEAL_INTERVAL_MS);
  assert.equal(shown(stories[0]).length, 2);

  stage.select(1);
  assert.equal(stage.selectedIndex, 1);
  assert.equal(shown(stories[1]).length, 6);
  assert.deepEqual(selections, [{ index: 1, detail: undefined }]);
  assert.equal(clock.pending, 0, "the conversation the reader left keeps no timer");

  // A choice is a request to read, so the conversation arrives whole and unanimated.
  const arrival = reveals.filter((reveal) => reveal.label.startsWith("b-"));
  assert.deepEqual(arrival.map((reveal) => reveal.animate), [false, false, false, false, false, false]);

  // Going back shows the part the drip had not reached, rather than restarting it.
  stage.select(0, { focus: true });
  assert.equal(shown(stories[0]).length, 6);
  assert.deepEqual(selections.at(-1), { index: 0, detail: { focus: true } });
  clock.advance(REVEAL_INTERVAL_MS * 10);
  assert.equal(shown(stories[0]).length, 6);
});

test("arrow-key selection wraps to the last conversation", { skip }, () => {
  const { stage, stories } = stageUnderTest();
  stage.start();
  stage.setStageVisible(true);

  stage.select(-1, { focus: true });
  assert.equal(stage.selectedIndex, 1);
  assert.equal(shown(stories[1]).length, 6);
});

test("focus inside the stage completes the conversation", { skip }, () => {
  const { stage, clock, stories } = stageUnderTest();
  stage.start();
  stage.setStageVisible(true);
  clock.advance(REVEAL_INTERVAL_MS * 2);
  assert.equal(shown(stories[0]).length, 3);

  // A keyboard or screen-reader user reaching the stage must not meet a truncated conversation.
  stage.revealSelected();
  assert.equal(shown(stories[0]).length, 6);
  assert.equal(clock.pending, 0);
  clock.advance(REVEAL_INTERVAL_MS * 10);
  assert.deepEqual(notShown(stories[0]), []);
});

test("reduced motion shows every conversation, and leaving it hides nothing", { skip }, () => {
  const { stage, clock, stories } = stageUnderTest({ reducedMotion: true });
  stage.start();
  stage.setStageVisible(true);
  clock.advance(GUARANTEED_REVEAL_MS + REVEAL_INTERVAL_MS * 10);
  assert.deepEqual(notShown(stories[0]), []);
  assert.deepEqual(notShown(stories[1]), []);

  // Reduced motion is a standing preference. Turning it off must not hide a conversation the
  // reader has been able to read since the page loaded.
  stage.setReducedMotion(false);
  assert.deepEqual(notShown(stories[0]), []);
  clock.advance(REVEAL_INTERVAL_MS * 10);
  assert.deepEqual(notShown(stories[0]), []);
  assert.deepEqual(notShown(stories[1]), []);
  assert.equal(clock.pending, 0);
});

test("turning reduced motion on shows the rest of the conversation at once", { skip }, () => {
  const { stage, clock, stories } = stageUnderTest();
  stage.start();
  stage.setStageVisible(true);
  clock.advance(REVEAL_INTERVAL_MS);
  assert.equal(shown(stories[0]).length, 2);

  stage.setReducedMotion(true);
  assert.equal(shown(stories[0]).length, 6);
  assert.equal(clock.pending, 0);
});

test("a hidden tab pauses the conversation, and a short pause resumes it", { skip }, () => {
  const { stage, clock, stories } = stageUnderTest();
  stage.start();
  stage.setStageVisible(true);
  clock.advance(REVEAL_INTERVAL_MS);

  stage.setPageHidden(true);
  clock.advance(REVEAL_INTERVAL_MS);
  assert.equal(shown(stories[0]).length, 2, "a conversation nobody is watching does not run on");

  stage.setPageHidden(false);
  clock.advance(REVEAL_INTERVAL_MS * 5);
  assert.equal(shown(stories[0]).length, 6);
});

test("a conversation that stops part-way is completed rather than left part-shown", { skip }, () => {
  const { stage, clock, stories } = stageUnderTest();
  stage.start();
  stage.setStageVisible(true);
  clock.advance(REVEAL_INTERVAL_MS);
  assert.equal(shown(stories[0]).length, 2);

  // Scrolling past the hero stops the drip. A reader who comes back to this part of the page, by
  // scroll or by screen reader, must not find three of six messages and no way to see the rest.
  stage.setStageVisible(false);
  clock.advance(GUARANTEED_REVEAL_MS);
  assert.deepEqual(notShown(stories[0]), []);
  assert.equal(clock.pending, 0);

  // Coming back never hides what the bounded wait has shown.
  stage.setStageVisible(true);
  clock.advance(REVEAL_INTERVAL_MS * 10);
  assert.deepEqual(notShown(stories[0]), []);
});

test("a hidden tab that stays hidden completes the conversation", { skip }, () => {
  const { stage, clock, stories } = stageUnderTest();
  stage.start();
  stage.setStageVisible(true);
  clock.advance(REVEAL_INTERVAL_MS);

  stage.setPageHidden(true);
  clock.advance(GUARANTEED_REVEAL_MS);
  assert.deepEqual(notShown(stories[0]), []);

  stage.setPageHidden(false);
  clock.advance(REVEAL_INTERVAL_MS * 10);
  assert.deepEqual(notShown(stories[0]), []);
});
