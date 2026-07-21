/*
 * Shared, chain-agnostic core for the browser approval UI.
 *
 * Owns everything that is identical between the EVM and TRON pages: the bridge protocol
 * (fetch pending / complete), the app state machine + view switching, the *error contract*
 * (a recoverable wallet error is shown IN-PAGE and never propagated — only an explicit
 * Reject/Cancel calls `completeError`), and the settled-result delivery that guarantees a
 * signed/broadcast result is never re-signed on a delivery retry.
 *
 * Each page supplies a thin chain *adapter* and calls `WalletSignerCore.init(adapter)`. The
 * adapter provides the wallet operations (`connect`/`sendTx`/`signMessage`/`signTypedData`),
 * wallet-presence/identity, address matching (case sensitivity differs per chain), and the
 * chain-specific bits of presentation (badge text, tx detail rows, button labels). The markup
 * and styles live in each page's HTML; this file never injects DOM, only reads/updates it by id.
 *
 * Adapter contract (see evm.html / tron.html for the concrete implementations):
 *
 *   logTag: string                         // console prefix, e.g. "browser-evm-signer"
 *
 *   setup(): Promise<void>                 // one-time wallet discovery / readiness wait
 *   hasWallet(): boolean
 *   walletName(): string
 *   walletIcon(): string | null           // data: URI, or null when unknown
 *   addressMatch(a, b): boolean
 *   currentAddress(): Promise<string>      // connected address without prompting ("" if none)
 *   requestAccounts(): Promise<string>     // prompt to connect; returns the primary address
 *   onAccountsChanged(cb): () => void      // subscribe; returns an unsubscribe fn (may be a noop)
 *   requestAccountChange?(expected): Promise<string | null>
 *                                          // optional: open the wallet's own account-change
 *                                          // prompt; resolves to the address to resume with
 *                                          // ("" when nothing changed), or null when the wallet
 *                                          // offers no working account-change UI at all
 *   walletHandlesMismatch?: boolean        // optional: the wallet safely handles an operation
 *                                          // for a non-selected account (native switch flow, or
 *                                          // a hard reject — true for EVM wallets); when absent
 *                                          // the core gates mismatched operations in-page
 *                                          // (TRON: tronWeb would sign an unbroadcastable tx)
 *
 *   badgeText(request): string | null      // connect/msg chain-or-network badge, null to hide
 *   confirmLabel: string                   // button text while the wallet prompt is open
 *   txHeading(request): string             // #tx-heading text (Send / Call / Deploy ...)
 *   txButtonLabel(request): string         // idle #tx-btn label ("Sign & Send" / "Deploy")
 *   renderTxDetails(request): void         // populate + show #tx-details for the idle state
 *   renderTxSuccessExtra?(request, { txHash, deployedAddress }): void  // optional extra success rows
 *
 *   onConnected?(request): Promise<void>   // optional post-match hook (e.g. EVM chain switch)
 *   sendTx(request, from): Promise<{ settled: string, txHash: string, contractAddress?: string }>
 *   signMessage(request, address): Promise<string>
 *   signTypedData(request, address): Promise<string>
 */
(function () {
  "use strict";

  var adapter = null;

  // --- DOM helpers ---
  function $(id) {
    return document.getElementById(id);
  }
  function show(el) {
    el.classList.remove("hidden");
  }
  function hide(el) {
    el.classList.add("hidden");
  }

  var ALL_VIEWS = ["view-loading", "view-error", "view-not-found", "view-connect", "view-tx", "view-msg"];
  function showView(id) {
    for (var i = 0; i < ALL_VIEWS.length; i++) hide($(ALL_VIEWS[i]));
    show($(id));
  }

  function truncAddr(addr) {
    if (!addr || String(addr).length < 10) return String(addr);
    addr = String(addr);
    return addr.slice(0, 6) + "..." + addr.slice(-4);
  }

  // Extract a human message from a thrown value. EIP-1193 provider errors are plain objects
  // ({ code, message, data }), not Error instances, so `err.message` must be read directly; fall
  // back to JSON so a cause is never swallowed into a generic string.
  function errMessage(err, fallback) {
    if (err instanceof Error && err.message) return err.message;
    if (err && typeof err.message === "string" && err.message) {
      return err.code !== undefined ? err.message + " (code " + err.code + ")" : err.message;
    }
    try {
      return fallback + ": " + JSON.stringify(err);
    } catch (_) {
      return fallback;
    }
  }

  // --- Bridge protocol ---
  async function fetchPendingRequest(id) {
    var res = await fetch("/api/pending/" + id);
    if (!res.ok) {
      var err = await res.json().catch(function () {
        return { error: "Unknown error" };
      });
      throw new Error(err.error || "HTTP " + res.status);
    }
    return (await res.json()).request;
  }

  async function completeSuccess(id, result) {
    var res;
    try {
      res = await fetch("/api/complete/" + id, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ success: true, result: result }),
      });
    } catch (netErr) {
      // A network-level failure (connection refused) means the signer process that served this
      // page has exited — usually because this is a stale tab from an earlier run. Terminal:
      // retrying can never reach a bridge that no longer exists.
      var ne = new Error("the signer process is no longer running (connection refused)");
      ne.terminal = true;
      throw ne;
    }
    if (!res.ok) {
      var err = await res.json().catch(function () {
        return { error: "Unknown error" };
      });
      // 404 = this bridge no longer knows the request (it timed out, or this tab belongs to an
      // exited process whose port was recycled). That's terminal — not worth retrying.
      var e = new Error(err.error || "HTTP " + res.status);
      e.terminal = res.status === 404;
      throw e;
    }
  }

  async function completeError(id, error, code) {
    await fetch("/api/complete/" + id, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ success: false, error: error, code: code }),
    }).catch(function () {});
  }

  // Keep in sync with `SignerErrorCode` in the reference.
  var ERROR_CODE_WRONG_WALLET_ADDRESS = "WRONG_WALLET_ADDRESS";

  // --- App state ---
  var request = null;
  var viewStatus = "idle";
  var viewError = "";
  var connectedAddress = "";
  var txHash = "";
  var deployedAddress = "";
  var signature = "";
  var unsubAccountsChanged = null;
  // Account-change prompt state: a prompt is in flight (disables the Change Account button and
  // suppresses stacked prompts) / the wallet reported the method as unsupported (hides the
  // button for good).
  var changingAccount = false;
  var accountChangeUnsupported = false;
  // Set on explicit Reject/Cancel. A pending wallet prompt cannot be cancelled, so a late
  // approval of it must find this flag and NOT resume a request whose error was already
  // delivered (that would sign/broadcast with nobody listening for the result).
  var finished = false;
  // Once the wallet returns a result (tx hash / signature / address) it is stored here so a
  // delivery failure (e.g. the bridge went away) NEVER causes a re-sign / re-broadcast. Retrying
  // only re-attempts delivery of this already-settled value.
  var settledResult = null;

  // Deliver the already-settled result to the bridge. Safe to call repeatedly: the wallet work is
  // done, so this only (re)tries the POST. On a delivery failure it shows a state whose action
  // retries DELIVERY, never the signing — so a tx can never be re-broadcast.
  async function deliverSettled() {
    try {
      await completeSuccess(request.id, settledResult);
      viewStatus = "success";
      render();
      setTimeout(function () {
        window.close();
      }, 2000);
    } catch (err) {
      console.error("[" + adapter.logTag + "] result delivery failed:", err);
      if (err && err.terminal) {
        // The signer is gone / the request expired — retrying delivery can't help. This is almost
        // always a STALE TAB left from an earlier run; close it and re-run the CLI.
        viewError = "This window is stale — the signer that opened it is no longer running " +
          "(it exited, or the request expired). Any wallet action here already completed; " +
          "close this window and re-run the command.";
      } else {
        viewError = errMessage(err, "Could not deliver the result to the signer") +
          " — the wallet action already succeeded; retry delivery (this will NOT re-sign).";
      }
      viewStatus = "error";
      render();
    }
  }

  // --- Address matching / rejection ---
  function expectedAddress() {
    return isTxType(request.type) ? request.from : request.address;
  }

  function wrongAddressMessage() {
    return "Wrong wallet address: expected " + expectedAddress() + ", got " + connectedAddress;
  }

  async function rejectWith(defaultReason) {
    if (viewStatus === "wrong_address") {
      await completeError(request.id, wrongAddressMessage(), ERROR_CODE_WRONG_WALLET_ADDRESS);
    } else {
      await completeError(request.id, defaultReason);
    }
  }

  function cleanupAccountsListener() {
    if (unsubAccountsChanged) {
      unsubAccountsChanged();
      unsubAccountsChanged = null;
    }
  }

  // Resume the pending action after the wallet's account changed — the single resume path,
  // shared by the accountsChanged listener and the requestAccountChange prompt. One user
  // approval can fire BOTH (a wallet emits the event and resolves the prompt), so the guard must
  // be race-free: whichever lands first synchronously moves `viewStatus` off "wrong_address"
  // before its first await, and the loser bails — the action can never run twice.
  async function maybeResume(newAddr) {
    if (!newAddr || finished || viewStatus !== "wrong_address") return;
    connectedAddress = newAddr;
    if (!adapter.addressMatch(newAddr, expectedAddress())) {
      render();
      return;
    }
    viewStatus = "connecting";
    cleanupAccountsListener();
    if (request.type === "connect") {
      try {
        await finishConnect(newAddr);
      } catch (err) {
        viewError = errMessage(err, "Connection failed");
        viewStatus = "error";
        render();
      }
    } else if (isTxType(request.type)) {
      await window.app.handleSignTx();
    } else {
      await window.app.handleSignMsg();
    }
  }

  // After a wrong-address state, listen for the wallet switching accounts; when it switches to the
  // expected address, auto-resume the pending action. TRON's adapter returns a noop unsubscribe
  // (TronLink has no equivalent event here), so this simply stays in the wrong-address view.
  function startListeningForAccountChange() {
    cleanupAccountsListener();
    if (!expectedAddress()) return;
    unsubAccountsChanged = adapter.onAccountsChanged(function (newAddr) {
      maybeResume(newAddr);
    });
  }

  // After a failed operation, decide whether the failure IS the account mismatch: if the
  // wallet's account still doesn't match the expected one, enter the wrong-address flow instead
  // of the generic error view. The current address is re-read first because the operation itself
  // may have moved it — a wallet-native switch flow (Ambire) that was confirmed, followed by the
  // user rejecting the operation itself, is a plain rejection, not a mismatch.
  async function enterWrongAddressAfterFailure(err) {
    var expected = expectedAddress();
    if (!expected) return false;
    try {
      connectedAddress = (await adapter.currentAddress()) || connectedAddress;
    } catch (_) {}
    if (adapter.addressMatch(connectedAddress, expected)) return false;
    viewStatus = "wrong_address";
    render();
    startListeningForAccountChange();
    // 4001 = the user explicitly rejected wallet UI (e.g. denied a native switch-account
    // window); don't immediately open another prompt at them — the button stays available.
    if (!(err && err.code === 4001)) promptAccountChange();
    return true;
  }

  // Proactively open the wallet's own account-change prompt (when the adapter supports one) so
  // the user confirms the switch there instead of digging through the wallet UI. Fired without
  // awaiting from the wrong-address branches; every failure stays IN-PAGE — a rejected or failed
  // prompt just leaves the wrong-address view and the accountsChanged listener alive (the error
  // contract: only an explicit Reject/Cancel propagates to the caller).
  async function promptAccountChange() {
    if (!adapter.requestAccountChange || accountChangeUnsupported || changingAccount || finished) {
      return;
    }
    changingAccount = true;
    render();
    try {
      var addr = await adapter.requestAccountChange(expectedAddress());
      if (addr === null) {
        // The adapter exhausted its options without the wallet ever showing UI — stop offering
        // the button and fall back to the manual-switch instructions.
        accountChangeUnsupported = true;
      } else if (addr) {
        await maybeResume(addr);
      }
    } catch (err) {
      console.warn("[" + adapter.logTag + "] account-change prompt failed:", err);
      // EIP-1193 -32601 = the wallet has no such method; stop offering the button.
      if (err && err.code === -32601) accountChangeUnsupported = true;
    } finally {
      changingAccount = false;
      render();
    }
  }

  async function finishConnect(address) {
    connectedAddress = address;
    // An adapter with a post-connect hook (EVM: switch to the requested chain) drives the
    // "switching" indicator; chains without one (TRON) skip straight to delivery.
    if (adapter.onConnected) {
      viewStatus = "switching";
      render();
      await adapter.onConnected(request);
    }
    cleanupAccountsListener();
    // Settle, then deliver — so a delivery failure here retries the POST, not the connect.
    settledResult = address;
    await deliverSettled();
  }

  // --- Request-type predicates ---
  function isTxType(type) {
    return type === "send_transaction" || type === "trigger_contract" || type === "deploy_contract";
  }
  function isMsgType(type) {
    return type === "sign_message" || type === "sign_typed_data";
  }

  // --- Renderers ---
  // The Change Account button and the dynamic hint exist only in pages whose adapter implements
  // requestAccountChange (the TRON page shares this renderer without them), so every element
  // here is optional.
  function renderChangeAccountUi(btnId, hintId) {
    var supported = !!adapter.requestAccountChange && !accountChangeUnsupported;
    var hint = $(hintId);
    if (hint) {
      hint.textContent = supported
        ? "Approve the account change in your wallet, or switch manually."
        : "Switch to the correct account in your wallet to continue.";
    }
    var btn = $(btnId);
    if (!btn) return;
    if (!supported) {
      hide(btn);
      return;
    }
    btn.disabled = changingAccount;
    btn.textContent = changingAccount ? "Check Wallet..." : "Change Account";
    show(btn);
  }

  var CONNECT_SECTIONS = ["connect-no-wallet", "connect-success", "connect-wrong", "connect-err", "connect-idle"];

  function renderConnect() {
    var badge = adapter.badgeText(request);
    if (badge) {
      $("connect-chain").textContent = badge;
      show($("connect-chain"));
    } else hide($("connect-chain"));

    if (request.address && viewStatus !== "success" && viewStatus !== "wrong_address") {
      $("connect-required-text").textContent = request.address;
      show($("connect-required"));
    } else hide($("connect-required"));

    for (var i = 0; i < CONNECT_SECTIONS.length; i++) hide($(CONNECT_SECTIONS[i]));

    if (!adapter.hasWallet()) {
      show($("connect-no-wallet"));
    } else if (viewStatus === "success") {
      $("connect-success-addr").textContent = connectedAddress;
      show($("connect-success"));
    } else if (viewStatus === "wrong_address") {
      $("connect-wrong-expected").textContent = request.address;
      $("connect-wrong-got").textContent = connectedAddress;
      show($("connect-wrong"));
    } else if (viewStatus === "error") {
      $("connect-err-msg").textContent = viewError;
      show($("connect-err"));
    } else {
      // idle / connecting / switching
      var nameEl = $("connect-wname");
      if (nameEl) nameEl.textContent = adapter.walletName();
      var iconEl = $("connect-wicon");
      if (iconEl) {
        var icon = adapter.walletIcon();
        if (icon) {
          iconEl.src = icon;
          iconEl.alt = adapter.walletName();
          show(iconEl);
        } else hide(iconEl);
      }
      var btn = $("connect-btn");
      btn.disabled = viewStatus === "connecting" || viewStatus === "switching";
      btn.textContent = viewStatus === "connecting"
        ? "Connecting..."
        : viewStatus === "switching"
        ? "Switching Chain..."
        : "Connect";
      show($("connect-idle"));
    }
  }

  function renderTx() {
    hide($("tx-success"));
    hide($("tx-wrong"));
    hide($("tx-err"));
    hide($("tx-details"));
    hide($("tx-no-wallet"));
    hide($("tx-footer"));

    var heading = $("tx-heading");
    if (heading) heading.textContent = adapter.txHeading(request);

    if (request.from && viewStatus !== "success" && viewStatus !== "wrong_address") {
      $("tx-required-text").textContent = request.from;
      show($("tx-required"));
    } else hide($("tx-required"));

    if (viewStatus === "success") {
      $("tx-hash").textContent = txHash;
      if (adapter.renderTxSuccessExtra) adapter.renderTxSuccessExtra(request, { txHash: txHash, deployedAddress: deployedAddress });
      show($("tx-success"));
    } else if (viewStatus === "wrong_address") {
      $("tx-wrong-expected").textContent = request.from;
      $("tx-wrong-got").textContent = connectedAddress;
      renderChangeAccountUi("tx-change-btn", "tx-wrong-hint");
      show($("tx-wrong"));
      return;
    } else if (viewStatus === "error") {
      $("tx-err-msg").textContent = viewError;
      show($("tx-err"));
    } else {
      adapter.renderTxDetails(request);
      show($("tx-details"));
    }

    if (!adapter.hasWallet()) {
      show($("tx-no-wallet"));
    } else if (viewStatus !== "success") {
      if (connectedAddress) {
        $("tx-connected").textContent = "Connected: " + truncAddr(connectedAddress);
        show($("tx-connected"));
      } else hide($("tx-connected"));
      var btn = $("tx-btn");
      btn.disabled = viewStatus === "connecting" || viewStatus === "signing";
      btn.textContent = viewStatus === "connecting"
        ? "Connecting..."
        : viewStatus === "signing"
        ? adapter.confirmLabel
        : adapter.txButtonLabel(request);
      show($("tx-footer"));
    }
  }

  function renderMsg() {
    var isTypedData = request.type === "sign_typed_data";
    $("msg-heading").textContent = isTypedData ? "Sign Typed Data" : "Sign Message";

    hide($("msg-success"));
    hide($("msg-wrong"));
    hide($("msg-err"));
    hide($("msg-content"));
    hide($("msg-chain"));
    hide($("msg-no-wallet"));
    hide($("msg-footer"));

    if (request.address && viewStatus !== "success" && viewStatus !== "wrong_address") {
      $("msg-required-text").textContent = request.address;
      show($("msg-required"));
    } else hide($("msg-required"));

    if (viewStatus === "success") {
      $("msg-sig").textContent = signature;
      show($("msg-success"));
    } else if (viewStatus === "wrong_address") {
      $("msg-wrong-expected").textContent = request.address;
      $("msg-wrong-got").textContent = connectedAddress;
      renderChangeAccountUi("msg-change-btn", "msg-wrong-hint");
      show($("msg-wrong"));
      return;
    } else if (viewStatus === "error") {
      $("msg-err-msg").textContent = viewError;
      show($("msg-err"));
    } else {
      if (isTypedData) {
        hide($("msg-plain"));
        $("msg-typed-data").textContent = JSON.stringify(
          { domain: request.domain, primaryType: request.primaryType, message: request.message },
          null,
          2,
        );
        show($("msg-typed"));
      } else {
        hide($("msg-typed"));
        $("msg-text").textContent = request.message;
        show($("msg-plain"));
      }
      show($("msg-content"));
      var badge = adapter.badgeText(request);
      if (badge) {
        $("msg-chain").textContent = badge;
        show($("msg-chain"));
      }
    }

    if (!adapter.hasWallet()) {
      show($("msg-no-wallet"));
    } else if (viewStatus !== "success") {
      if (connectedAddress) {
        $("msg-connected").textContent = "Connected: " + truncAddr(connectedAddress);
        show($("msg-connected"));
      } else hide($("msg-connected"));
      var btn = $("msg-btn");
      btn.disabled = viewStatus === "connecting" || viewStatus === "signing";
      btn.textContent = viewStatus === "connecting"
        ? "Connecting..."
        : viewStatus === "signing"
        ? adapter.confirmLabel
        : "Sign";
      show($("msg-footer"));
    }
  }

  function render() {
    if (request === null) return; // still loading or already showing a static view
    if (request.type === "connect") renderConnect();
    else if (isTxType(request.type)) renderTx();
    else if (isMsgType(request.type)) renderMsg();
  }

  // Acquire the connected account without a forced prompt, falling back to a prompt.
  async function acquireAccount() {
    var addr = await adapter.currentAddress();
    if (!addr) addr = await adapter.requestAccounts();
    return addr;
  }

  // --- Handlers (wired to onclick in the markup) ---
  window.app = {
    handleConnect: async function () {
      viewStatus = "connecting";
      viewError = "";
      render();
      try {
        var address = await adapter.requestAccounts();
        connectedAddress = address;
        if (request.address && !adapter.addressMatch(address, request.address)) {
          viewStatus = "wrong_address";
          render();
          startListeningForAccountChange();
          promptAccountChange();
          return;
        }
        await finishConnect(address);
      } catch (err) {
        console.error("[" + adapter.logTag + "] connect error:", err);
        if (err && err.code !== undefined) console.error("[" + adapter.logTag + "] code:", err.code, "data:", err.data);
        // Show the error IN-PAGE and stay open so the user can retry (Connect) or abort (Cancel).
        // We do NOT completeError here — the caller only hears back on an explicit Cancel, not on a
        // recoverable wallet rejection/error.
        viewError = errMessage(err, "Connection failed");
        viewStatus = "error";
        render();
      }
    },

    cancelConnect: async function () {
      finished = true;
      cleanupAccountsListener();
      await rejectWith("User cancelled");
      window.close();
    },

    handleSignTx: async function () {
      // If the tx was already broadcast, a click only retries DELIVERY — never re-sends.
      if (settledResult !== null) {
        await deliverSettled();
        return;
      }
      viewStatus = "connecting";
      viewError = "";
      render();
      try {
        connectedAddress = await acquireAccount();

        // When the wallet handles mismatches itself, the operation is submitted for the
        // requested `from` ANYWAY: wallets with a native switch flow (Ambire) open their own
        // switch-account confirmation and continue the request as that account, all in one
        // step; wallets without one reject immediately (MetaMask 4100, Rabby -32602) and the
        // catch below turns that into the wrong-address flow. Chains whose wallets do NOT
        // handle it (TRON) are gated here instead.
        if (!adapter.walletHandlesMismatch && request.from && !adapter.addressMatch(connectedAddress, request.from)) {
          viewStatus = "wrong_address";
          render();
          startListeningForAccountChange();
          promptAccountChange();
          return;
        }

        viewStatus = "signing";
        render();

        // Broadcast exactly once; record the result BEFORE attempting delivery so any delivery
        // failure can only retry the POST, not re-broadcast.
        var out = await adapter.sendTx(request, request.from || connectedAddress);
        txHash = out.txHash;
        if (out.contractAddress) deployedAddress = out.contractAddress;
        settledResult = out.settled;
        await deliverSettled();
      } catch (err) {
        console.error("[" + adapter.logTag + "] transaction error:", err);
        if (err && err.code !== undefined) console.error("[" + adapter.logTag + "] code:", err.code, "data:", err.data);
        if (await enterWrongAddressAfterFailure(err)) return;
        // In-page error only: keep the page open so the user can retry (Sign & Send) or abort
        // (Reject). A wallet rejection is NOT propagated to the caller — only the explicit Reject
        // button is (see rejectTx).
        viewError = errMessage(err, "Transaction failed");
        viewStatus = "error";
        render();
      }
    },

    rejectTx: async function () {
      finished = true;
      cleanupAccountsListener();
      await rejectWith("User rejected transaction");
      window.close();
    },

    handleSignMsg: async function () {
      // If already signed, a click only retries DELIVERY — never re-prompts the wallet.
      if (settledResult !== null) {
        await deliverSettled();
        return;
      }
      viewStatus = "connecting";
      viewError = "";
      render();
      try {
        connectedAddress = await acquireAccount();

        // As in handleSignTx: a mismatched request is submitted for the requested address anyway
        // so wallet-native switch flows can run (a rejection lands in the catch) — unless the
        // chain's wallets can't handle a mismatch, which is gated here.
        if (!adapter.walletHandlesMismatch && request.address && !adapter.addressMatch(connectedAddress, request.address)) {
          viewStatus = "wrong_address";
          render();
          startListeningForAccountChange();
          promptAccountChange();
          return;
        }

        viewStatus = "signing";
        render();

        var sigAddress = request.address || connectedAddress;
        var sig;
        if (request.type === "sign_typed_data" && request.domain && request.types && request.primaryType && request.message) {
          sig = await adapter.signTypedData(request, sigAddress);
        } else if (request.message) {
          sig = await adapter.signMessage(request, sigAddress);
        } else throw new Error("Invalid signing request");

        signature = sig;
        settledResult = sig;
        await deliverSettled();
      } catch (err) {
        console.error("[" + adapter.logTag + "] signing error:", err);
        if (err && err.code !== undefined) console.error("[" + adapter.logTag + "] code:", err.code, "data:", err.data);
        if (await enterWrongAddressAfterFailure(err)) return;
        // In-page error only: keep the page open so the user can retry (Sign) or abort (Reject).
        // Only the explicit Reject button propagates to the caller (see rejectSign).
        viewError = errMessage(err, "Signing failed");
        viewStatus = "error";
        render();
      }
    },

    rejectSign: async function () {
      finished = true;
      cleanupAccountsListener();
      await rejectWith("User rejected signing");
      window.close();
    },

    changeAccount: function () {
      // Re-attempting the operation is the most capable "change account" action: wallets with a
      // native switch flow (Ambire) open their switch-account window from the attempt itself,
      // and wallets that reject a mismatched request (MetaMask 4100, Rabby -32602) land back in
      // the wrong-address flow, which opens the adapter's account-change prompt.
      if (isTxType(request.type)) return window.app.handleSignTx();
      if (isMsgType(request.type)) return window.app.handleSignMsg();
      return promptAccountChange();
    },
  };

  // --- Init ---
  async function init() {
    await adapter.setup();
    connectedAddress = await adapter.currentAddress();

    var path = window.location.pathname;
    var match = path.match(/^\/(connect|sign)\/([a-f0-9-]+)$/);
    if (!match) {
      showView("view-not-found");
      return;
    }

    try {
      request = await fetchPendingRequest(match[2]);
      if (request.type === "connect") {
        showView("view-connect");
        renderConnect();
      } else if (isTxType(request.type)) {
        showView("view-tx");
        renderTx();
      } else if (isMsgType(request.type)) {
        showView("view-msg");
        renderMsg();
      } else {
        showView("view-error");
        $("error-msg").textContent = "Unknown request type";
      }
    } catch (err) {
      var msg = errMessage(err, "Failed to load request");
      if (msg.includes("not found") || msg.includes("404")) showView("view-not-found");
      else {
        $("error-msg").textContent = msg;
        showView("view-error");
      }
    }
  }

  // Expose the entry point plus the shared utilities the chain adapters reuse for rendering.
  window.WalletSignerCore = {
    init: function (a) {
      adapter = a;
      return init();
    },
    $: $,
    show: show,
    hide: hide,
    truncAddr: truncAddr,
    errMessage: errMessage,
  };
})();
