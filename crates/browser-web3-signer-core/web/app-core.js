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
 *   onChainReady?(request, cb): void       // optional: call cb whenever the wallet becomes ready
 *                                          // for request's chain (EVM: chainChanged to it)
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

  // --- Async helpers ---
  /**
   * Returns a function sharing one `load()` promise among all its callers while that promise is
   * pending or fulfilled; a rejected one is dropped, so the next call retries.
   */
  function onceUntilFailure(load) {
    var pending = null;
    return function () {
      if (!pending) {
        pending = load();
        pending.catch(function () {
          pending = null;
        });
      }
      return pending;
    };
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
  // The account the user picked with "Change"; it signs instead of the request's pinned one.
  var pickedAddress = "";
  var unsubFollowSelected = null;
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
  // Returns the account the request names as its signer ("" when it leaves it to the wallet).
  function pinnedAddress() {
    return isTxType(request.type) ? request.from : request.address;
  }

  // Returns the account that must sign: the one the user picked with "Change", else the pinned
  // one, else "" (whichever account the wallet selects).
  function expectedAddress() {
    return pickedAddress || pinnedAddress();
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

  // Ends the request on an explicit Reject/Cancel: delivers the rejection, stops every account
  // listener so a late wallet event can't resume it, and closes the window.
  async function endRejected(defaultReason) {
    finished = true;
    cleanupAccountsListener();
    if (unsubFollowSelected) unsubFollowSelected();
    await rejectWith(defaultReason);
    window.close();
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
      await connectAs(newAddr);
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

  // Shows the wrong-address view and resumes the request once the wallet selects the expected
  // account.
  function enterWrongAddress() {
    viewStatus = "wrong_address";
    render();
    startListeningForAccountChange();
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
    enterWrongAddress();
    // 4001 = the user explicitly rejected wallet UI (e.g. denied a native switch-account
    // window); don't immediately open another prompt at them — the button stays available.
    if (!(err && err.code === 4001)) promptAccountChange();
    return true;
  }

  // True if the wallet may have an account-change prompt: the adapter implements one and the
  // wallet hasn't proven it unsupported.
  function accountChangeSupported() {
    return !!adapter.requestAccountChange && !accountChangeUnsupported;
  }

  // True if an account-change prompt may open now: supported, none already open, and no Reject
  // has ended the request.
  function canPromptAccountChange() {
    return accountChangeSupported() && !changingAccount && !finished;
  }

  // Returns the address the wallet's account-change prompt selected, "" when nothing changed or
  // the prompt failed (logged, never propagated), or null when the wallet has no such UI. A
  // wallet found lacking one (null, or EIP-1193 -32601) is never prompted again.
  async function runAccountChangePrompt(expected) {
    changingAccount = true;
    render();
    try {
      var addr = await adapter.requestAccountChange(expected);
      if (addr === null) accountChangeUnsupported = true;
      return addr;
    } catch (err) {
      console.warn("[" + adapter.logTag + "] account-change prompt failed:", err);
      if (err && err.code === -32601) accountChangeUnsupported = true;
      return "";
    } finally {
      changingAccount = false;
      render();
    }
  }

  // Opens the wallet's account-change prompt for the request's expected signer, so the user
  // confirms the switch there instead of digging through the wallet UI, and resumes the request
  // once the wallet switches. Fired without awaiting from the wrong-address branches.
  async function promptAccountChange() {
    if (!canPromptAccountChange()) return;
    var addr = await runAccountChangePrompt(expectedAddress());
    if (addr) await maybeResume(addr);
    else if (addr === null) await connectDespiteNoPrompt();
  }

  // Delivers a connect request's expected address although the wallet can't switch to it (Ambire
  // keeps the dapp pinned to the connected account), when the wallet arbitrates mismatched
  // signers itself (walletHandlesMismatch) and so prompts at signing time.
  async function connectDespiteNoPrompt() {
    if (!adapter.walletHandlesMismatch || request.type !== "connect" || viewStatus !== "wrong_address" || finished) {
      return;
    }
    cleanupAccountsListener();
    await connectAs(expectedAddress());
  }

  // Delivers `address` as the connect request's result; a failure stays in-page.
  async function connectAs(address) {
    viewStatus = "connecting";
    try {
      await finishConnect(address);
    } catch (err) {
      viewError = errMessage(err, "Connection failed");
      viewStatus = "error";
      render();
    }
  }

  // Lets the user pick the account in the wallet: a connect request delivers it at once, and a
  // sign request signs with it even when the request pinned another (the caller is not told).
  async function switchAccount() {
    if (!canPromptAccountChange()) return;
    var addr = await runAccountChangePrompt("");
    if (!addr || finished) return;
    connectedAddress = addr;
    if (request.type === "connect") {
      await connectAs(addr);
      return;
    }
    pickedAddress = addr;
    render();
  }

  // Keeps the shown account on the wallet's selected one while the page waits on the user; a
  // picked account follows a switch made in the wallet. The wrong-address flow listens for itself.
  function followSelectedAccount() {
    unsubFollowSelected = adapter.onAccountsChanged(function (addr) {
      if (finished || settledResult !== null || viewStatus === "wrong_address" || !addr) return;
      connectedAddress = addr;
      if (pickedAddress) pickedAddress = addr;
      render();
    });
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
  // The account-change buttons and the dynamic hint exist only in pages whose adapter implements
  // requestAccountChange (the TRON page shares these renderers without them), so every element
  // here is optional.
  function renderAccountChangeBtn(btnId, offered, label) {
    var btn = $(btnId);
    if (!btn) return;
    if (!offered) {
      hide(btn);
      return;
    }
    btn.disabled = changingAccount;
    btn.textContent = changingAccount ? "Check Wallet..." : label;
    show(btn);
  }

  function renderChangeAccountUi(btnId, hintId) {
    var supported = accountChangeSupported();
    var hint = $(hintId);
    if (hint) {
      hint.textContent = supported
        ? "Approve the account change in your wallet, or switch manually."
        : "Switch to the correct account in your wallet to continue.";
    }
    renderAccountChangeBtn(btnId, supported, "Change Account");
  }

  // True if the page offers "Change" while it waits on the user. It needs a selected account to
  // change from (otherwise the operation itself opens the wallet's picker), and a connect request
  // that pins its address has the wrong-address flow instead.
  function switchOffered() {
    return accountChangeSupported() && !!connectedAddress && !(request.type === "connect" && request.address) &&
      (viewStatus === "idle" || viewStatus === "error");
  }

  // Shows the wallet's selected account, truncated, in the optional badge `id`.
  function renderAccountBadge(id, label) {
    var badge = $(id);
    if (!badge) return;
    if (!connectedAddress) {
      hide(badge);
      return;
    }
    badge.textContent = label + truncAddr(connectedAddress);
    show(badge);
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
      renderAccountBadge("connect-connected", "Selected: ");
      renderAccountChangeBtn("connect-switch-btn", switchOffered(), "Change");
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

  // Renders the "tx" or "msg" sign view (element ids start with `prefix`) for the current status;
  // `view` supplies that view's own panels and sign-button label.
  function renderSignView(prefix, view) {
    function el(suffix) {
      return $(prefix + "-" + suffix);
    }
    var panels = ["success", "wrong", "err", "no-wallet", "footer"].map(el).concat(view.detailIds.map($));
    for (var i = 0; i < panels.length; i++) hide(panels[i]);

    var expected = expectedAddress();
    var pinned = pinnedAddress();
    if (pinned && viewStatus !== "success" && viewStatus !== "wrong_address") {
      el("required-text").textContent = pickedAddress && !adapter.addressMatch(pickedAddress, pinned)
        ? pinned + " (overridden by your choice)"
        : pinned;
      show(el("required"));
    } else hide(el("required"));

    if (viewStatus === "success") {
      view.showResult();
      show(el("success"));
    } else if (viewStatus === "wrong_address") {
      el("wrong-expected").textContent = expected;
      el("wrong-got").textContent = connectedAddress;
      renderChangeAccountUi(prefix + "-change-btn", prefix + "-wrong-hint");
      show(el("wrong"));
      return;
    } else if (viewStatus === "error") {
      el("err-msg").textContent = viewError;
      show(el("err"));
    } else {
      view.showDetails();
    }

    if (!adapter.hasWallet()) {
      show(el("no-wallet"));
    } else if (viewStatus !== "success") {
      renderAccountBadge(prefix + "-connected", "Connected: ");
      renderAccountChangeBtn(prefix + "-switch-btn", switchOffered(), "Change");
      var btn = el("btn");
      btn.disabled = viewStatus === "connecting" || viewStatus === "signing";
      btn.textContent = viewStatus === "connecting"
        ? "Connecting..."
        : viewStatus === "signing"
        ? adapter.confirmLabel
        : view.buttonLabel;
      show(el("footer"));
    }
  }

  function renderTx() {
    var heading = $("tx-heading");
    if (heading) heading.textContent = adapter.txHeading(request);
    renderSignView("tx", {
      detailIds: ["tx-details"],
      showDetails: function () {
        adapter.renderTxDetails(request);
        show($("tx-details"));
      },
      showResult: function () {
        $("tx-hash").textContent = txHash;
        if (adapter.renderTxSuccessExtra) adapter.renderTxSuccessExtra(request, { txHash: txHash, deployedAddress: deployedAddress });
      },
      buttonLabel: adapter.txButtonLabel(request),
    });
  }

  function renderMsg() {
    var isTypedData = request.type === "sign_typed_data";
    $("msg-heading").textContent = isTypedData ? "Sign Typed Data" : "Sign Message";
    renderSignView("msg", {
      detailIds: ["msg-content", "msg-chain"],
      showDetails: function () {
        showMsgContent(isTypedData);
        var badge = adapter.badgeText(request);
        if (badge) {
          $("msg-chain").textContent = badge;
          show($("msg-chain"));
        }
      },
      showResult: function () {
        $("msg-sig").textContent = signature;
      },
      buttonLabel: "Sign",
    });
  }

  function showMsgContent(isTypedData) {
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
      // A `{ raw }` message is bytes, not text: show its hex and say so.
      var raw = typeof request.message !== "string";
      $("msg-label").textContent = raw ? "Raw bytes (hex)" : "Message";
      $("msg-text").textContent = raw ? request.message.raw : request.message;
      show($("msg-plain"));
    }
    show($("msg-content"));
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
          enterWrongAddress();
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
      await endRejected("User cancelled");
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
        var from = expectedAddress();
        if (!adapter.walletHandlesMismatch && from && !adapter.addressMatch(connectedAddress, from)) {
          enterWrongAddress();
          promptAccountChange();
          return;
        }

        viewStatus = "signing";
        render();

        // Broadcast exactly once; record the result BEFORE attempting delivery so any delivery
        // failure can only retry the POST, not re-broadcast.
        var out = await adapter.sendTx(request, from || connectedAddress);
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
      await endRejected("User rejected transaction");
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
        var sigAddress = expectedAddress() || connectedAddress;
        if (!adapter.walletHandlesMismatch && !adapter.addressMatch(connectedAddress, sigAddress)) {
          enterWrongAddress();
          promptAccountChange();
          return;
        }

        viewStatus = "signing";
        render();

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
      await endRejected("User rejected signing");
    },

    switchAccount: switchAccount,

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

  /** Returns a failed view to the normal one, for an error the wallet has since resolved. */
  function clearStaleError() {
    if (viewStatus !== "error" || finished) return;
    viewStatus = "idle";
    viewError = "";
    render();
  }

  // Shows the bridge's build version in #version, so a bug report names the exact build. Best
  // effort: a page whose bridge doesn't answer just shows none.
  async function showVersion() {
    var el = $("version");
    if (!el) return;
    try {
      el.textContent = (await (await fetch("/api/health")).json()).version || "";
    } catch (_) {}
  }

  // --- Init ---
  async function init() {
    showVersion();
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
      // An error shown before the wallet reached the request's chain was likely the missing
      // network; the user retries from the normal view instead of a stale message.
      if (adapter.onChainReady) adapter.onChainReady(request, clearStaleError);
      followSelectedAccount();
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
    onceUntilFailure: onceUntilFailure,
  };
})();
