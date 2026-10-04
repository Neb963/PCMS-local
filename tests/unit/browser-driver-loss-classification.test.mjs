import assert from "node:assert/strict";
import test from "node:test";

import {
  isSessionDetachedProtocolError,
  isTargetClosedProtocolError
} from "../../dist/browser/browser-driver.js";

test("target-closed protocol errors are classified as target loss", () => {
  assert.equal(
    isTargetClosedProtocolError({ code: -32000, message: "Target closed" }),
    true
  );
  assert.equal(
    isTargetClosedProtocolError({
      code: -32000,
      message: "Inspected target has gone away"
    }),
    true
  );
});

test("session-scoped protocol errors are classified as session detached, not target loss", () => {
  const cases = [
    { code: -32602, message: "No session with given id" },
    { code: -32001, message: "Session with given id was not found" },
    { code: -32000, message: "Session closed" }
  ];
  for (const error of cases) {
    assert.equal(
      isSessionDetachedProtocolError(error),
      true,
      `expected session classification for ${error.message}`
    );
    assert.equal(
      isTargetClosedProtocolError(error),
      false,
      `session-scoped error must not claim target loss: ${error.message}`
    );
  }
});

test("unrelated protocol errors classify as neither target loss nor session detach", () => {
  const cases = [
    { code: -32601, message: "Method not found" },
    { code: -32000, message: "Target crashed" },
    { message: "Inspected target asynchronously disconnected" },
    "not an object",
    null
  ];
  for (const error of cases) {
    assert.equal(isTargetClosedProtocolError(error), false);
    assert.equal(isSessionDetachedProtocolError(error), false);
  }
});
