"use strict";

const UPDATE_FEED = Object.freeze({
  id: "morrow-github-stable",
  provider: "github",
  owner: "bradenriggins",
  repo: "morrow-downloads",
  channel: "latest"
});

function desktopUpdateMetadata(enabled) {
  return Object.freeze({
    enabled: enabled === true,
    feedId: UPDATE_FEED.id,
    provider: UPDATE_FEED.provider,
    owner: UPDATE_FEED.owner,
    repo: UPDATE_FEED.repo,
    channel: UPDATE_FEED.channel
  });
}

function electronBuilderPublish() {
  return Object.freeze({
    provider: UPDATE_FEED.provider,
    owner: UPDATE_FEED.owner,
    repo: UPDATE_FEED.repo,
    channel: UPDATE_FEED.channel,
    releaseType: "release"
  });
}

module.exports = { UPDATE_FEED, desktopUpdateMetadata, electronBuilderPublish };
