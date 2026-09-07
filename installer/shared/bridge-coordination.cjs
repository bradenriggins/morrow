"use strict";

async function completeBridgeUpdate({ acquire, readback, matchesChallenge, confirm, refresh, release }) {
  await acquire();
  let confirmed = false;
  try {
    const result = await readback();
    if (matchesChallenge(result) !== true) throw new Error("Morrow Bridge reload is not confirmed");
    await confirm(result);
    confirmed = true;
    const completed = await refresh();
    if (completed?.manualChromeReloadRequired === true) throw new Error("Morrow Bridge update confirmation is incomplete");
    await release();
    return completed;
  } catch (error) {
    if (confirmed) await release().catch(() => {});
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
    if (!quiesceAttempted || resumed) await release().catch(() => {});
    throw error;
  }
}

module.exports = { completeBridgeUpdate, stageBridgeSwap };
