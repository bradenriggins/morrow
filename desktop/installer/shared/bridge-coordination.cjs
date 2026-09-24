"use strict";

async function completeBridgeUpdate({ acquire, readback, matchesChallenge, inspect, commit, confirm, refresh, release }) {
  await acquire();
  try {
    const result = await readback();
    if (matchesChallenge(result) !== true) {
      throw Object.assign(new Error("Morrow Bridge reload is not confirmed"), { code: "bridge_reload_unconfirmed" });
    }
    const pending = await inspect(result);
    await commit(pending);
    await confirm(result);
    const completed = await refresh();
    if (completed?.manualChromeReloadRequired === true) throw new Error("Morrow Bridge update confirmation is incomplete");
    await release();
    return completed;
  } catch (error) {
    throw error;
  }
}

async function stageBridgeSwap({ acquire, prepare, requestQuiescence, resumeQuiescence, refresh, release }) {
  await acquire();
  let quiesceAttempted = false;
  let resumed = false;
  try {
    await prepare({
      requestQuiescence: async (input) => {
        quiesceAttempted = true;
        return requestQuiescence(input);
      },
      resumeQuiescence: async (input) => {
        const result = await resumeQuiescence(input);
        resumed = result?.resumed === true;
        return result;
      }
    });
    const staged = await refresh();
    if (staged?.manualChromeReloadRequired !== true) throw new Error("Morrow Bridge update staging is incomplete");
    return staged;
  } catch (error) {
    const quiescenceDefinitelyRefused = error?.code === "bridge_quiesce_busy";
    if (!quiesceAttempted || resumed || quiescenceDefinitelyRefused) await release().catch(() => {});
    throw error;
  }
}

module.exports = { completeBridgeUpdate, stageBridgeSwap };
