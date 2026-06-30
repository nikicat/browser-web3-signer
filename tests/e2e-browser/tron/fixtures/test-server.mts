/**
 * TRON test-server shim: binds the shared harness driver to the `tron-harness` binary and
 * re-exports its API as free functions, so the spec's imports stay byte-compatible with the
 * upstream reference.
 */

import { makeHarness } from "../../fixtures/harness.mts";

const harness = makeHarness("tron-harness");

export const startServer = harness.startServer;
export const stopServer = harness.stopServer;
export const getBaseUrl = harness.getBaseUrl;
export const createTestRequest = harness.createTestRequest;
export const getTestResult = harness.getTestResult;
