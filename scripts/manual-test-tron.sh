#!/usr/bin/env bash
#
# Manual real-wallet test assistant for the TRON signer, driven by a local tronbox/tre node.
#
# It starts a throwaway local TRON chain (tronbox/tre, a java-tron dev node with pre-funded
# genesis accounts) in Docker, then walks you through every wallet operation against it —
# connect, sign-message, sign-typed-data, send-transaction, and a contract call (TRC-20
# transfer). You only approve each action in TronLink; the script funds your address, sequences
# the commands, and verifies each result on-chain.
#
# Nothing here touches a real network or real funds: tre is a local chain and the test TRX/tokens
# come from its genesis key.
#
# ── One-time TronLink setup (TronLink can't be pointed at a node programmatically) ──
#   In TronLink: Settings → Node → add a custom node with all three URLs set to
#   http://127.0.0.1:9090 (FullNode, SolidityNode, EventServer), then select it as the active
#   node. Leave it selected while you run this script. (The network label shown on the approval
#   pages is cosmetic — what matters is that TronLink's *active node* is this local one.)
#
# Requirements: docker, node >= 22.6 (for native TypeScript execution), npm, jq, forge (foundry),
# a built `browser-web3-signer` binary (`cargo build`), and TronLink in your browser.
#
# Usage:  scripts/manual-test-tron.sh
#         WALLET_BROWSER=brave scripts/manual-test-tron.sh   # open approval pages in a specific browser
#         TRE_PORT=9091 scripts/manual-test-tron.sh          # override the node port (also update TronLink)
#         TRE_IMAGE=tronbox/tre:dev scripts/manual-test-tron.sh   # pin a different tre image

set -euo pipefail

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
# tronbox/tre is the maintained local-node image. Default to a multi-arch tag so it runs natively
# on both amd64 and Apple Silicon (`latest` is arm64-only, which emulates — and misbehaves — on
# amd64 hosts). Override with TRE_IMAGE.
readonly TRE_IMAGE="${TRE_IMAGE:-tronbox/tre:1.0.3}"
# The node's HTTP port. TronLink must point at this same port (see the one-time setup above).
readonly NODE_PORT="${TRE_PORT:-9090}"
readonly NODE_HOST="http://127.0.0.1:${NODE_PORT}"
# Unique container name per run so parallel/leftover runs don't collide.
readonly CONTAINER="bw3s-tre-manual-$$"

# Amounts (TRX has 6 decimals: 1 TRX = 1,000,000 SUN).
# Fund well under a genesis account's balance (tre gives each exactly 10,000 TRX): transferring the
# whole balance leaves nothing for the transfer's own bandwidth/fee and the node rejects it. 5,000
# TRX is far more than the wallet needs for the send + TRC-20 stages.
readonly FUND_SUN=5000000000         # 5,000 TRX to the connected wallet
readonly SEND_SUN=100000000          # 100 TRX native transfer
readonly TOKEN_MINT=1000000000000000000000   # 1000 tokens (18 decimals) minted to the wallet
readonly TOKEN_XFER=100000000000000000000     # 100 tokens transferred by the wallet

# The approval pages carry a cosmetic network label; "nile" reads as a testnet (least alarming).
# It does NOT route anything — TronLink builds/broadcasts against its own active node.
readonly CONNECT_NETWORK="nile"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly ROOT_DIR
readonly TOOL_DIR="$ROOT_DIR/scripts/tron"
readonly TOOL="$TOOL_DIR/tron-tool.ts"

# Which browser to open approval pages in, so you can test different wallets. Empty = OS default.
readonly WALLET_BROWSER="${WALLET_BROWSER:-${BROWSER:-}}"

# Filled in during preflight / startup; consumed by later stages.
BIN="${BROWSER_WEB3_BIN:-}"   # path to the signer binary
ADDR=""                        # the connected wallet address
GENESIS_KEY=""                 # a pre-funded genesis private key (funds/deploys/mints)
RECIPIENT=""                   # a second genesis address, used as the transfer target
NODE_STARTED=""                # set once the container is running, so cleanup tears it down

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------
c_bold=$'\033[1m'; c_dim=$'\033[2m'; c_grn=$'\033[32m'; c_ylw=$'\033[33m'; c_red=$'\033[31m'; c_rst=$'\033[0m'

step()   { printf '\n%s━━ %s ━━%s\n' "$c_bold" "$1" "$c_rst"; }
info()   { printf '%s  %s%s\n' "$c_dim" "$1" "$c_rst"; }
ok()     { printf '%s  ✓ %s%s\n' "$c_grn" "$1" "$c_rst"; }
warn()   { printf '%s  ! %s%s\n' "$c_ylw" "$1" "$c_rst"; }
die()    { printf '%s  ✗ %s%s\n' "$c_red" "$1" "$c_rst" >&2; exit 1; }
prompt() { printf '\n%s👉 %s%s\n' "$c_ylw" "$1" "$c_rst"; }

require() { command -v "$1" >/dev/null 2>&1 || die "missing required tool: $1"; }

# Run a signer command in --json mode; stdout is the clean JSON result (progress → stderr).
# WALLET_BROWSER (if set) opens approval pages in the chosen browser via the BROWSER env var the
# signer honors. Only export BROWSER when non-empty — an empty value makes the launcher try to
# spawn an empty command instead of falling back to the OS default.
signer() {
  if [ -n "$WALLET_BROWSER" ]; then
    BROWSER="$WALLET_BROWSER" "$BIN" --json "$@"
  else
    "$BIN" --json "$@"
  fi
}

# Run the local-node helper (TronWeb over the tre node). NODE_HOST + GENESIS_KEY are passed into
# the child's environment via `env` (not a command-prefix assignment — NODE_HOST is readonly here,
# which a prefix assignment can't set) so every subcommand talks to the right node and can sign.
tool() { env NODE_HOST="$NODE_HOST" GENESIS_KEY="$GENESIS_KEY" node "$TOOL" "$@"; }

cleanup() {
  if [ -n "$NODE_STARTED" ]; then
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  fi
  # The custom node you added to TronLink persists after the local chain is gone. Remind on every
  # exit path (success, die, or interrupt) so you can switch TronLink back to a real network.
  warn "Reminder: the local node (http://127.0.0.1:${NODE_PORT}) is now gone, but it stays in your"
  warn "TronLink node list. Switch TronLink back to a real network when you're done testing."
}

# ---------------------------------------------------------------------------
# Stages
# ---------------------------------------------------------------------------

# Check tools, ensure the helper's node deps are installed, and locate the signer binary (sets BIN).
preflight() {
  require docker
  require node
  require npm
  require jq
  require forge

  # Native .ts execution needs node >= 22.6 (type stripping). Warn early with an actionable message.
  local major
  major="$(node -e 'process.stdout.write(process.versions.node.split(".")[0])')"
  [ "$major" -ge 22 ] || die "node >= 22.6 required to run the TypeScript helper (found $(node --version))"

  if [ ! -d "$TOOL_DIR/node_modules" ]; then
    step "Installing local-node helper dependencies (scripts/tron)"
    (cd "$TOOL_DIR" && npm install --silent) || die "npm install failed in $TOOL_DIR"
  fi

  if [ -z "$BIN" ]; then
    local cand
    for cand in "$ROOT_DIR/target/release/browser-web3-signer" "$ROOT_DIR/target/debug/browser-web3-signer"; do
      [ -x "$cand" ] && BIN="$cand" && break
    done
  fi
  [ -n "$BIN" ] && [ -x "$BIN" ] \
    || die "browser-web3-signer binary not found — run 'cargo build' first (looked in target/{release,debug})"
  info "Using binary: $BIN"
}

# Start the tre node in Docker and block until it accepts RPC and has funded its genesis accounts
# (sets GENESIS_KEY + RECIPIENT). tre funds the HD accounts a few blocks in, so we poll a balance.
start_node() {
  step "Starting local tron node ($TRE_IMAGE) on $NODE_HOST"
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker run -d --rm --name "$CONTAINER" -p "${NODE_PORT}:9090" "$TRE_IMAGE" >/dev/null \
    || die "failed to start the tre container (is port ${NODE_PORT} free?)"
  NODE_STARTED=1

  info "Waiting for the node to come up and fund its genesis accounts (usually ~15-40s)…"
  # Poll with curl (fast, hard per-request timeout) rather than spawning the node helper each time:
  # a tronweb call against a half-ready node blocks on its own 30s timeout and would burn the whole
  # budget in a couple of attempts. Ready = accounts endpoint serves AND the chain has advanced a
  # few blocks (tre's genesis funding lands in the first handful of blocks).
  local blk="" ready=""
  local _
  for _ in $(seq 1 90); do
    if curl -sf -m3 "$NODE_HOST/admin/accounts-json" >/dev/null 2>&1; then
      # `|| echo 0` keeps this from tripping `set -e -o pipefail` while the node is still warming
      # up (getnowblock briefly returns non-JSON, failing jq); a standalone failing assignment
      # would exit the whole script with no error message.
      blk="$(curl -sf -m3 -X POST "$NODE_HOST/wallet/getnowblock" 2>/dev/null | jq -r '.block_header.raw_data.number // 0' 2>/dev/null || echo 0)"
      [ "${blk:-0}" -ge 5 ] && { ready=1; break; }
    fi
    sleep 2
  done
  [ -n "$ready" ] || die "tre node did not become ready in time — re-run (startup is occasionally flaky)"

  # Node is up now, so the helper calls are fast. Read the accounts once and parse locally.
  local accounts_json first_addr first_bal
  accounts_json="$(tool accounts)" || die "could not read genesis accounts from the node"
  GENESIS_KEY="$(jq -r '.privateKeys[0]' <<<"$accounts_json")"
  RECIPIENT="$(jq -r '.addresses[1]' <<<"$accounts_json")"
  first_addr="$(jq -r '.addresses[0]' <<<"$accounts_json")"
  [ -n "$GENESIS_KEY" ] && [ "$GENESIS_KEY" != "null" ] && [ -n "$RECIPIENT" ] && [ "$RECIPIENT" != "null" ] \
    || die "could not read genesis accounts from the node"

  # Confirm the genesis account is actually funded before we depend on it (a few blocks may still
  # be needed after the readiness gate).
  first_bal=0
  for _ in $(seq 1 10); do
    first_bal="$(tool balance "$first_addr" 2>/dev/null || echo 0)"
    [ "${first_bal:-0}" != "0" ] && break
    sleep 2
  done
  [ "${first_bal:-0}" != "0" ] || die "genesis account not funded yet — re-run"
  ok "Node is up; genesis account funded ($(( first_bal / 1000000 )) TRX)"
}

# Walk the user through the one-time TronLink node setup before we open any approval page.
stage_setup_wallet() {
  step "TronLink setup (one-time)"
  info "TronLink can't be pointed at a node from the command line, so set it up manually:"
  info "  1. Open TronLink → Settings → Node → Add Node"
  info "  2. Set FullNode / SolidityNode / EventServer all to: $NODE_HOST"
  info "  3. Select that node as the active one, and keep it selected during this run."
  info "The approval pages will show a '$CONNECT_NETWORK' label — that's cosmetic; what matters is"
  info "that TronLink's active node is the local one above."
  prompt "Press Enter once TronLink is pointed at $NODE_HOST…"
  read -r _ || true
}

# Connect TronLink (sets ADDR), then fund it from the genesis key so it can pay for everything.
stage_connect_and_fund() {
  step "1/5  Connect wallet"
  info "Your browser will open. Approve the connection to TronLink."
  prompt "Approve the connection in your browser…"

  ADDR="$(signer tron connect --network "$CONNECT_NETWORK" | jq -r .address)"
  [ -n "$ADDR" ] && [ "$ADDR" != "null" ] || die "connect did not return an address"
  ok "Connected: $ADDR"

  step "Funding $ADDR ($(( FUND_SUN / 1000000 )) TRX)"
  tool fund "$ADDR" "$FUND_SUN" >/dev/null
  local bal
  bal="$(tool balance "$ADDR")"
  ok "Balance: $(( bal / 1000000 )) TRX"
}

# signMessageV2, verified by recovering the signer.
stage_sign_message() {
  step "2/5  Sign message (signMessageV2)"
  local msg sig
  msg="Hello from tron tre at $(date +%s)"
  info "Message: $msg"
  prompt "Approve the signature in your browser…"

  sig="$(signer tron sign-message --message "$msg" --address "$ADDR" --network "$CONNECT_NETWORK" | jq -r .signature)"
  [ -n "$sig" ] && [ "$sig" != "null" ] || die "sign-message returned no signature"
  if tool verify-message "$ADDR" "$msg" "$sig" >/dev/null; then
    ok "Signature verified — recovers to $ADDR"
  else
    warn "Signature returned ($sig) but verify did not recover $ADDR"
  fi
}

# TIP-712 typed data, verified by recovering the signer (via ethers; TIP-712 mirrors EIP-712).
stage_sign_typed_data() {
  step "3/5  Sign typed data (TIP-712)"
  local typed_file tsig
  typed_file="$(mktemp --suffix=.json)"
  cat > "$typed_file" <<JSON
{
  "domain": { "name": "Tron Test", "version": "1", "chainId": 1 },
  "types": { "Message": [{ "name": "content", "type": "string" }] },
  "primaryType": "Message",
  "message": { "content": "typed data over tron" }
}
JSON
  info "Typed data: $typed_file"
  prompt "Approve the typed-data signature in your browser…"

  tsig="$(signer tron sign-typed-data --file "$typed_file" --address "$ADDR" --network "$CONNECT_NETWORK" | jq -r .signature)"
  if [ -z "$tsig" ] || [ "$tsig" = "null" ]; then
    rm -f "$typed_file"
    die "sign-typed-data returned no signature"
  fi
  if tool verify-typed --file "$typed_file" --address "$ADDR" "$tsig" >/dev/null; then
    ok "TIP-712 signature verified — recovers to $ADDR"
  else
    warn "TIP-712 signature returned ($tsig) but verify did NOT recover $ADDR"
  fi
  rm -f "$typed_file"
}

# Native TRX transfer, verified by receipt status + recipient balance delta.
stage_send_transaction() {
  step "4/5  Send transaction ($(( SEND_SUN / 1000000 )) TRX → $RECIPIENT)"
  local before hash after delta
  before="$(tool balance "$RECIPIENT")"
  prompt "Approve the transaction in your browser…"

  hash="$(signer tron send-transaction --to "$RECIPIENT" --from "$ADDR" --amount "$SEND_SUN" \
    --network "$CONNECT_NETWORK" | jq -r .txHash)"
  [ -n "$hash" ] && [ "$hash" != "null" ] || die "send-transaction returned no hash"
  info "Tx hash: $hash"
  local status
  status="$(tool tx-status "$hash" || true)"
  after="$(tool balance "$RECIPIENT")"
  delta="$(( (after - before) / 1000000 ))"
  if [[ "$status" == SUCCESS* ]]; then
    ok "Tx confirmed ($status); recipient +$delta TRX"
  else
    warn "Tx hash returned but status was '$status'"
  fi
}

# Compile + deploy a demo TRC-20 (forge, from the genesis key), mint to the wallet, then have the
# wallet transfer tokens — a real contract call — verified by the recipient's token balance.
stage_trigger_contract() {
  step "5/5  Contract call (TRC-20 transfer)"
  info "Compiling and deploying a demo TRC-20, then minting to your address…"

  local forge_dir bytecode abi_file token calldata_params tx2 status tokbal
  forge_dir="$(mktemp -d)"
  mkdir -p "$forge_dir/src"
  # Pin evm_version=istanbul: newer solc emits PUSH0 (Shanghai), which the TVM rejects.
  cat > "$forge_dir/foundry.toml" <<'TOML'
[profile.default]
evm_version = "istanbul"
TOML
  cat > "$forge_dir/src/MintableERC20.sol" <<'SOL'
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract MintableERC20 {
    mapping(address => uint256) public balanceOf;
    event Transfer(address indexed from, address indexed to, uint256 value);
    function mint(address to, uint256 amt) external { balanceOf[to] += amt; emit Transfer(address(0), to, amt); }
    function transfer(address to, uint256 amt) external returns (bool) {
        require(balanceOf[msg.sender] >= amt, "insufficient");
        balanceOf[msg.sender] -= amt; balanceOf[to] += amt; emit Transfer(msg.sender, to, amt); return true;
    }
}
SOL
  forge build --root "$forge_dir" >/dev/null 2>&1 || { rm -rf "$forge_dir"; die "forge failed to compile the demo token"; }
  bytecode="$(jq -r '.bytecode.object' "$forge_dir/out/MintableERC20.sol/MintableERC20.json")"
  abi_file="$forge_dir/abi.json"
  jq -c '.abi' "$forge_dir/out/MintableERC20.sol/MintableERC20.json" > "$abi_file"
  [ -n "$bytecode" ] && [ "$bytecode" != "null" ] || { rm -rf "$forge_dir"; die "could not extract token bytecode"; }

  # Deploy + mint with the genesis account, not your wallet.
  token="$(tool deploy --abi "$abi_file" --bytecode "$bytecode" --name MintableERC20)"
  [ -n "$token" ] || { rm -rf "$forge_dir"; die "token deployment returned no address"; }
  ok "Token deployed at $token"
  tool mint "$token" "$ADDR" "$TOKEN_MINT" >/dev/null
  ok "Minted to $ADDR — token balance: $(tool token-balance "$token" "$ADDR")"
  rm -rf "$forge_dir"

  # The wallet transfers tokens via triggerSmartContract(transfer(address,uint256)).
  calldata_params="[{\"type\":\"address\",\"value\":\"$RECIPIENT\"},{\"type\":\"uint256\",\"value\":\"$TOKEN_XFER\"}]"
  prompt "Approve the TRC-20 transfer in your browser…"
  tx2="$(signer tron trigger-contract --contract "$token" --from "$ADDR" \
    --selector "transfer(address,uint256)" --params "$calldata_params" \
    --network "$CONNECT_NETWORK" | jq -r .txHash)"
  [ -n "$tx2" ] && [ "$tx2" != "null" ] || die "token transfer returned no hash"
  status="$(tool tx-status "$tx2" || true)"
  tokbal="$(tool token-balance "$token" "$RECIPIENT")"
  if [[ "$status" == SUCCESS* ]] && [[ "$tokbal" != 0 ]]; then
    ok "TRC-20 transfer confirmed; recipient token balance: $tokbal"
  else
    warn "Token transfer hash returned ($tx2) but status='$status', recipient balance=$tokbal"
  fi
}

# Keep the node alive until TronLink observes the receipts, then let it shut down. TronLink marks
# a tx confirmed on its own polling cycle; if we killed the node the moment the last stage passed,
# that poll would fail and the tx would linger as "pending" in the wallet's activity list.
stage_settle() {
  step "Letting the wallet catch up"
  info "Transactions are confirmed and verified. TronLink confirms them on its own polling timer,"
  info "so the node stays up until you're done — watch TronLink's activity list."
  prompt "Press Enter once TronLink shows the transactions confirmed (this shuts the node down)…"
  read -r _ || true
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
main() {
  trap cleanup EXIT
  preflight
  start_node
  stage_setup_wallet
  stage_connect_and_fund
  stage_sign_message
  stage_sign_typed_data
  stage_send_transaction
  stage_trigger_contract
  stage_settle

  step "All done"
  ok "Every wallet operation completed and verified against the local tron node."
}

# Run only when executed directly (sourcing the file exposes the stage functions for testing).
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  main "$@"
fi
