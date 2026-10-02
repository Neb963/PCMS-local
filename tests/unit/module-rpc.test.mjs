import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_MODULE_RPC_LIMITS,
  MODULE_RPC_PROTOCOL_VERSION,
  ModuleRpcFrameDecoder,
  ModuleRpcProtocolError,
  encodeModuleRpcFrame,
  parseModuleRpcEnvelope
} from "../../dist/modules/rpc.js";

function request(overrides = {}) {
  return {
    kind: "request",
    protocolVersion: MODULE_RPC_PROTOCOL_VERSION,
    runtimeGeneration: 3,
    requestId: "core:1",
    source: "core",
    method: "echo",
    params: { value: 1 },
    ...overrides
  };
}

test("length-prefixed module RPC survives chunking and preserves typed envelopes", () => {
  const frame = encodeModuleRpcFrame(
    parseModuleRpcEnvelope(request()),
    DEFAULT_MODULE_RPC_LIMITS.maxFrameBytes
  );
  const decoder = new ModuleRpcFrameDecoder(
    DEFAULT_MODULE_RPC_LIMITS.maxFrameBytes
  );

  assert.deepEqual(decoder.push(frame.subarray(0, 2)), []);
  assert.deepEqual(decoder.push(frame.subarray(2, 11)), []);
  const decoded = decoder.push(frame.subarray(11));
  assert.equal(decoded.length, 1);
  assert.deepEqual(decoded[0], request());
});


test("frame decoder accepts multiple valid frames coalesced into one chunk", () => {
  const first = encodeModuleRpcFrame(
    parseModuleRpcEnvelope(request({ requestId: "core:1" })),
    DEFAULT_MODULE_RPC_LIMITS.maxFrameBytes
  );
  const second = encodeModuleRpcFrame(
    parseModuleRpcEnvelope(request({ requestId: "core:2", params: { value: 2 } })),
    DEFAULT_MODULE_RPC_LIMITS.maxFrameBytes
  );
  const decoder = new ModuleRpcFrameDecoder(
    DEFAULT_MODULE_RPC_LIMITS.maxFrameBytes
  );
  const decoded = decoder.push(Buffer.concat([first, second]));
  assert.equal(decoded.length, 2);
  assert.equal(decoded[0].requestId, "core:1");
  assert.equal(decoded[1].requestId, "core:2");
});

test("RPC validation rejects unknown fields, invalid generation and ambiguous response", () => {
  assert.throws(
    () => parseModuleRpcEnvelope({ ...request(), extra: true }),
    ModuleRpcProtocolError
  );
  assert.throws(
    () => parseModuleRpcEnvelope(request({ runtimeGeneration: 0 })),
    /positive safe integer/
  );
  assert.throws(
    () => parseModuleRpcEnvelope({
      kind: "response",
      protocolVersion: MODULE_RPC_PROTOCOL_VERSION,
      runtimeGeneration: 1,
      requestId: "core:1",
      result: null,
      error: {
        code: "FAILED",
        message: "no",
        retryable: false
      }
    }),
    /exactly one/
  );
});

test("frame decoder rejects declared oversize before JSON allocation", () => {
  const decoder = new ModuleRpcFrameDecoder(512);
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(513);
  assert.throws(
    () => decoder.push(prefix),
    /declared frame length 513 is invalid/
  );
});

test("frame encoder rejects payloads beyond the configured boundary", () => {
  assert.throws(
    () => encodeModuleRpcFrame(
      parseModuleRpcEnvelope(request({ params: "x".repeat(2_000) })),
      512
    ),
    /exceeds frame limit/
  );
});
