# Project recipes. Run `just` to list, `just <recipe>` to invoke.
#
# Coverage uses cargo-llvm-cov (LLVM source-based coverage).
# Install once:  cargo install cargo-llvm-cov   (or: pacman -S cargo-llvm-cov)

# Drop CLI glue from the coverage report — main.rs / output.rs / flow.rs are
# thin presentation wrappers around the library crates.
ignore_regex := '(crates/browser-web3-signer/src/(main|output|flow)\.rs)'

# List available recipes.
default:
    @just --list

# Everything CI runs, in order. Use before pushing.
ci: fmt-check toml-check lint build test

# Run the test suite (matches CI).
test:
    cargo test --all-features --locked

# Build all targets (matches CI).
build:
    cargo build --all-targets --locked

# Format Rust + TOML in place.
fmt:
    cargo fmt --all
    taplo fmt

# Check formatting without writing (matches CI).
fmt-check:
    cargo fmt --all -- --check

# Check + lint TOML (matches CI).
toml-check:
    taplo fmt --check
    taplo lint

# Clippy with warnings denied (matches CI).
lint:
    cargo clippy --all-targets --all-features --locked -- -D warnings

# Coverage summary in the terminal.
coverage:
    cargo llvm-cov --all-features --ignore-filename-regex '{{ignore_regex}}'

# HTML report at target/llvm-cov/html/index.html.
coverage-html:
    cargo llvm-cov --all-features --html --ignore-filename-regex '{{ignore_regex}}'

# lcov.info for Codecov upload or external tools.
coverage-lcov:
    cargo llvm-cov --all-features --lcov --output-path lcov.info \
        --ignore-filename-regex '{{ignore_regex}}'

# Drop cached coverage artifacts.
coverage-clean:
    cargo llvm-cov clean --workspace

# Build the e2e harness binaries (debug is fast enough for tests).
e2e-build:
    cargo build --bin evm-harness --bin tron-harness --features e2e

# One-time e2e setup: install Node deps and download Chromium.
e2e-setup:
    cd tests/e2e-browser && npm install && npx playwright install chromium

# Run Playwright e2e tests (EVM + TRON) against the Rust bridge.
e2e: e2e-build
    cd tests/e2e-browser && npm test

# Vet + format-check + test the Go binding (needs a built binary + node; matches CI).
go-test: build
    cd go && test -z "$(gofmt -l .)" && go vet ./... && go test ./...

# Cut a release in one command (from a clean master): bump the lockstep version
# (Cargo.toml + ts/package.json + Cargo.lock), commit + push, wait for CI to pass, then
# push the vX.Y.Z tag (triggers the Release workflow: binaries -> GitHub release, npm
# packages) and the go/vX.Y.Z tag (versions the Go module). Level: major|minor|patch or
# an explicit X.Y.Z.
release level='minor':
    ./scripts/release.sh {{level}}

# Manual real-wallet test: drive your browser wallet against a local anvil chain.
# Requires foundry (anvil/cast/forge) + jq. You approve each step in your wallet.
manual-test-evm: build
    ./scripts/manual-test-evm.sh

# Manual real-wallet test: drive TronLink against a local tronbox/tre node (Docker).
# Requires docker, node >= 22.6, forge, jq. You approve each step in TronLink.
manual-test-tron: build
    ./scripts/manual-test-tron.sh
