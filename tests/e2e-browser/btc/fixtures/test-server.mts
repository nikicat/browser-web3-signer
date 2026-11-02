/**
 * Bitcoin test-server shim: binds the shared harness driver to the `btc-harness` binary and
 * re-exports its API as free functions, like the EVM and TRON shims.
 */

import { makeHarness } from "../../fixtures/harness.mts";

const harness = makeHarness("btc-harness");

export const startServer = harness.startServer;
export const stopServer = harness.stopServer;
export const getBaseUrl = harness.getBaseUrl;
export const createTestRequest = harness.createTestRequest;
export const getTestResult = harness.getTestResult;
