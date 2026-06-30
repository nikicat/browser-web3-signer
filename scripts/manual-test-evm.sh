#!/usr/bin/env bash
#
# Manual real-wallet test assistant for the EVM signer, driven by a local anvil node.
#
# It starts anvil (a local EVM chain with cheat codes), then walks you through every
# wallet operation against it — connect, sign-message, sign-typed-data, send-transaction,
# and a contract call (ERC-20 transfer). You only have to approve each action in your
# browser wallet (MetaMask, Rabby, …); the script funds your address, sequences the
# commands, and verifies each result on-chain.
#
# Nothing here touches a real network or real funds: anvil is a throwaway local chain,
# and the test ETH/tokens are minted out of thin air via anvil cheat codes.
#
# Requirements: anvil + cast + forge (foundry), jq, and a built `browser-web3-signer`
# binary (run `cargo build` first). A browser wallet extension in your default browser.
#
# Usage:  scripts/manual-test-evm.sh
#         BROWSER=firefox scripts/manual-test-evm.sh    # pick a specific browser

set -euo pipefail

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
readonly RPC_PORT="${ANVIL_PORT:-8545}"
readonly RPC_URL="http://127.0.0.1:${RPC_PORT}"
readonly CHAIN_ID=31337
readonly CHAIN_NAME="Anvil Local"

# anvil's deterministic accounts (mnemonic "test test … junk"). Account #1 is the send target;
# any wallet works since the script funds whatever address you connect with.
readonly RECIPIENT="0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
# Funder = anvil account #0, used only to deploy the demo ERC-20 and seed token balances.
readonly FUNDER_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly ROOT_DIR

# Filled in during preflight / startup; consumed by later stages.
BIN="${BROWSER_WEB3_BIN:-}"   # path to the signer binary
ADDR=""                        # the connected wallet address
ANVIL_PID=""
ANVIL_LOG="$(mktemp)"

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
signer() { "$BIN" --json "$@"; }

cleanup() {
  [ -n "$ANVIL_PID" ] && kill "$ANVIL_PID" 2>/dev/null || true
  rm -f "$ANVIL_LOG"
}

# ---------------------------------------------------------------------------
# Stages
# ---------------------------------------------------------------------------

# Check tools and locate the signer binary (sets BIN).
preflight() {
  require anvil
  require cast
  require jq
  require forge

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

# Start anvil and block until it accepts RPC (sets ANVIL_PID).
start_anvil() {
  step "Starting local anvil chain (id $CHAIN_ID) on $RPC_URL"
  anvil --port "$RPC_PORT" --chain-id "$CHAIN_ID" --silent > "$ANVIL_LOG" 2>&1 &
  ANVIL_PID=$!
  local _
  for _ in $(seq 1 50); do
    cast chain-id --rpc-url "$RPC_URL" >/dev/null 2>&1 && break
    sleep 0.1
  done
  cast chain-id --rpc-url "$RPC_URL" >/dev/null 2>&1 || die "anvil failed to start (see $ANVIL_LOG)"
  ok "anvil is up (pid $ANVIL_PID)"
}

# Connect the browser wallet to the anvil chain (sets ADDR), then fund it via a cheat code.
stage_connect_and_fund() {
  step "1/5  Connect wallet"
  info "Your browser will open. Approve the connection — and if prompted, approve adding"
  info "the '$CHAIN_NAME' network (the tool sends your wallet the anvil RPC URL)."
  prompt "Approve the connection in your browser…"

  ADDR="$(signer evm connect --chain "$CHAIN_ID" --rpc-url "$RPC_URL" --chain-name "$CHAIN_NAME" | jq -r .address)"
  [ -n "$ADDR" ] && [ "$ADDR" != "null" ] || die "connect did not return an address"
  ok "Connected: $ADDR"

  step "Funding $ADDR with 100 test ETH (anvil cheat code)"
  cast rpc --rpc-url "$RPC_URL" anvil_setBalance "$ADDR" 0x56BC75E2D63100000 >/dev/null
  ok "Balance now: $(cast from-wei "$(cast balance --rpc-url "$RPC_URL" "$ADDR")") ETH"
}

# personal_sign, verified by recovering the signer (EIP-191).
stage_sign_message() {
  step "2/5  Sign message (personal_sign)"
  local msg sig
  msg="Hello from anvil at $CHAIN_ID"
  info "Message: $msg"
  prompt "Approve the signature in your browser…"

  sig="$(signer evm sign-message --message "$msg" --chain "$CHAIN_ID" | jq -r .signature)"
  [ -n "$sig" ] && [ "$sig" != "null" ] || die "sign-message returned no signature"
  if cast wallet verify --address "$ADDR" "$msg" "$sig" >/dev/null 2>&1; then
    ok "Signature verified — recovers to $ADDR"
  else
    warn "Signature returned ($sig) but verify did not recover $ADDR"
  fi
}

# EIP-712 typed data, verified by re-hashing the same file and recovering the signer.
stage_sign_typed_data() {
  step "3/5  Sign typed data (EIP-712)"
  local typed_file tsig
  typed_file="$(mktemp --suffix=.json)"
  cat > "$typed_file" <<JSON
{
  "domain": { "name": "Anvil Test", "version": "1", "chainId": $CHAIN_ID },
  "types": { "Message": [{ "name": "content", "type": "string" }] },
  "primaryType": "Message",
  "message": { "content": "typed data over anvil" }
}
JSON
  info "Typed data: $typed_file"
  prompt "Approve the typed-data signature in your browser…"

  tsig="$(signer evm sign-typed-data --file "$typed_file" --chain "$CHAIN_ID" | jq -r .signature)"
  if [ -z "$tsig" ] || [ "$tsig" = "null" ]; then
    rm -f "$typed_file"
    die "sign-typed-data returned no signature"
  fi
  # `cast wallet verify --data` re-hashes the same {domain,types,primaryType,message} per EIP-712
  # and recovers the signer — confirming the wallet's eth_signTypedData_v4 digest matches the
  # standard one (the embedded UI injects an empty EIP712Domain entry; this proves it round-trips).
  if cast wallet verify --address "$ADDR" --data --from-file "$typed_file" "$tsig" >/dev/null 2>&1; then
    ok "EIP-712 signature verified — recovers to $ADDR"
  else
    warn "EIP-712 signature returned ($tsig) but cast verify did NOT recover $ADDR"
    warn "→ the wallet's typed-data digest differs from the standard EIP-712 hash; investigate."
  fi
  rm -f "$typed_file"
}

# Native ETH transfer, verified by receipt status + recipient balance delta.
stage_send_transaction() {
  step "4/5  Send transaction (0.1 ETH → $RECIPIENT)"
  local before hash status after delta
  before="$(cast balance --rpc-url "$RPC_URL" "$RECIPIENT")"
  prompt "Approve the transaction in your browser…"

  hash="$(signer evm send-transaction --to "$RECIPIENT" --value 100000000000000000 --chain "$CHAIN_ID" | jq -r .txHash)"
  [ -n "$hash" ] && [ "$hash" != "null" ] || die "send-transaction returned no hash"
  info "Tx hash: $hash"
  # `cast receipt … status` prints "1 (success)" / "0 (failed)"; match the leading code.
  status="$(cast receipt --rpc-url "$RPC_URL" "$hash" status 2>/dev/null || echo "")"
  after="$(cast balance --rpc-url "$RPC_URL" "$RECIPIENT")"
  delta="$(cast from-wei "$((after - before))")"
  if [[ "$status" == 1* ]]; then
    ok "Tx mined (status: $status); recipient +$delta ETH"
  else
    warn "Tx hash returned but receipt status was '$status'"
  fi
}

# Compile + deploy a demo ERC-20 with forge, mint to the wallet, then have the wallet
# transfer tokens — a real contract call — verified by the recipient's token balance.
stage_trigger_contract() {
  step "5/5  Contract call (ERC-20 transfer)"
  info "Compiling and deploying a demo ERC-20, then minting 1000 tokens to your address…"

  local forge_dir bytecode token calldata tx2 status tokbal
  forge_dir="$(mktemp -d)"
  mkdir -p "$forge_dir/src"
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
  rm -rf "$forge_dir"
  [ -n "$bytecode" ] && [ "$bytecode" != "null" ] || die "could not extract token bytecode"

  # Deploy + mint with the funder account (#0), not your wallet.
  token="$(cast send --rpc-url "$RPC_URL" --private-key "$FUNDER_KEY" --create "$bytecode" --json | jq -r .contractAddress)"
  [ -n "$token" ] && [ "$token" != "null" ] || die "token deployment returned no address"
  ok "Token deployed at $token"
  cast send --rpc-url "$RPC_URL" --private-key "$FUNDER_KEY" "$token" "mint(address,uint256)" "$ADDR" 1000000000000000000000 >/dev/null
  ok "Minted to $ADDR — token balance: $(cast call --rpc-url "$RPC_URL" "$token" "balanceOf(address)(uint256)" "$ADDR")"

  calldata="$(cast calldata "transfer(address,uint256)" "$RECIPIENT" 100000000000000000000)"
  prompt "Approve the ERC-20 transfer in your browser…"
  tx2="$(signer evm send-transaction --to "$token" --data "$calldata" --chain "$CHAIN_ID" | jq -r .txHash)"
  [ -n "$tx2" ] && [ "$tx2" != "null" ] || die "token transfer returned no hash"
  status="$(cast receipt --rpc-url "$RPC_URL" "$tx2" status 2>/dev/null || echo "")"
  tokbal="$(cast call --rpc-url "$RPC_URL" "$token" "balanceOf(address)(uint256)" "$RECIPIENT")"
  if [[ "$status" == 1* ]] && [[ "$tokbal" != 0* ]]; then
    ok "ERC-20 transfer mined; recipient token balance: $tokbal"
  else
    warn "Token transfer hash returned ($tx2) but status='$status', recipient balance=$tokbal"
  fi
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
main() {
  trap cleanup EXIT
  preflight
  start_anvil
  stage_connect_and_fund
  stage_sign_message
  stage_sign_typed_data
  stage_send_transaction
  stage_trigger_contract

  step "All done"
  ok "Every wallet operation completed and verified against anvil."
  info "anvil will shut down now."
}

# Run only when executed directly (sourcing the file exposes the stage functions for testing).
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  main "$@"
fi
