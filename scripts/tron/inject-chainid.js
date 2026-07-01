// One-time TronLink chainId injection — enables TIP-712 signing against a local tre node.
//
// WHY THIS EXISTS
// TronLink resolves the chainId it needs for TIP-712 from a static `chainId` field stored on the
// selected node's config (background.js: Fc = {...builtinNodes, ...userNodeList}[selectedNode].chainId,
// then parseInt(chainId, 16)). Built-in networks ship with it; a user-added custom node never gets
// one, because TronLink's add-node flow only pings `GET /` and never queries the node's eth_chainId.
// So on a local node its TIP-712 check throws "Current chainId cannot be null or undefined".
// This snippet writes the missing hex `chainId` onto your local node's stored config, which is all
// TronLink needs. It's a fragile, version-specific hack on wallet internals — a demo/enabler for
// local testing, not something the signer does.
//
// HOW TO RUN
//   1. In TronLink, add + select a node with all URLs = http://127.0.0.1:9090 (see the manual-test
//      script's setup step).
//   2. brave://extensions → Developer mode → TronLink → "Inspect views: service worker" → Console.
//   3. Paste this whole file, press Enter. Confirm it logs a non-empty `updated keys:` list.
//   4. Reload TronLink (reload icon on its card) so it rehydrates the patched store; re-unlock and
//      re-select the local node.
// It's wiped whenever you re-add that node or TronLink updates — re-run it if TIP-712 breaks again.

(async () => {
  const NODE_URL_MATCH = "127.0.0.1:9090"; // your local node URL (change if you used TRE_PORT)
  const CHAIN_ID_HEX = "0xc845df2f";        // tre's eth_chainId (= 3360022319); change for a custom image

  // Walk any value (handling redux-persist's stringified slices at every depth) and set `chainId`
  // on every node-config object whose fullNode points at the local node.
  const walk = (v) => {
    if (typeof v === "string") {
      let p;
      try { p = JSON.parse(v); } catch { return [v, false]; }
      if (p && typeof p === "object") { const [np, c] = walk(p); return c ? [JSON.stringify(np), true] : [v, false]; }
      return [v, false];
    }
    if (Array.isArray(v)) {
      let c = false;
      const a = v.map((x) => { const [nx, cx] = walk(x); c ||= cx; return nx; });
      return [a, c];
    }
    if (v && typeof v === "object") {
      let c = false;
      if (typeof v.fullNode === "string" && v.fullNode.includes(NODE_URL_MATCH)) { v.chainId = CHAIN_ID_HEX; c = true; }
      for (const k of Object.keys(v)) { const [nv, cx] = walk(v[k]); if (cx) { v[k] = nv; c = true; } }
      return [v, c];
    }
    return [v, false];
  };

  const all = await chrome.storage.local.get(null);
  const out = {};
  for (const [k, val] of Object.entries(all)) { const [nv, c] = walk(val); if (c) out[k] = nv; }
  if (Object.keys(out).length) await chrome.storage.local.set(out);
  console.log(`[inject-chainid] set chainId=${CHAIN_ID_HEX} on nodes matching ${NODE_URL_MATCH}; updated keys:`, Object.keys(out));
})();
