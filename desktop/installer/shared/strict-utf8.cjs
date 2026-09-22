"use strict";

function decodeStrictUtf8(bytes, label) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError(`${label} bytes are required`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8`, { cause: error });
  }
}

function parseStrictJson(bytes, label) {
  return JSON.parse(decodeStrictUtf8(bytes, label));
}

module.exports = { decodeStrictUtf8, parseStrictJson };
