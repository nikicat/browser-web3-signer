package signer

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
)

// Chain selects which chain the spawned `serve` subprocess drives.
type Chain string

const (
	// ChainEVM drives an EVM wallet (`serve --chain evm`).
	ChainEVM Chain = "evm"
	// ChainTRON drives a TRON wallet (`serve --chain tron`).
	ChainTRON Chain = "tron"
)

// binEnvVar overrides binary resolution with an explicit path.
const binEnvVar = "BROWSER_WEB3_SIGNER_BIN"

// ServeOptions configures how the `serve` subprocess is spawned.
type ServeOptions struct {
	// BinPath is an explicit path to the `browser-web3-signer` binary. When empty, the
	// binary is resolved from the BROWSER_WEB3_SIGNER_BIN env var, then a workspace
	// debug/release build (only when running from the repo checkout), then
	// `browser-web3-signer` on PATH.
	BinPath string
	// Browser controls how the bridge opens the approval page: "" opens the OS default
	// browser; "print" opens nothing (the URL is printed for manual opening); any other
	// value is treated as a browser program name, passed to the subprocess via the
	// BROWSER env var (the signer honors $BROWSER; it has no --browser flag).
	Browser string
}

// ServeProcess spawns and supervises a `serve` subprocess for its lifetime, exposing the
// base URL of its `/api/v1` control API. One subprocess per ServeProcess; it dies when
// [ServeProcess.Stop] is called (or when this process exits).
type ServeProcess struct {
	chain   Chain
	binPath string
	browser string

	mu      sync.Mutex
	cmd     *exec.Cmd
	baseURL string
}

// NewServeProcess creates a supervisor for a `serve` subprocess driving the given chain.
// It does not spawn anything until [ServeProcess.Start] is called.
func NewServeProcess(chain Chain, opts ServeOptions) *ServeProcess {
	return &ServeProcess{
		chain:   chain,
		binPath: resolveBinary(opts.BinPath),
		browser: opts.Browser,
	}
}

// BaseURL returns the control-API base URL ("http://127.0.0.1:<port>"), or "" before Start.
func (s *ServeProcess) BaseURL() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.baseURL
}

// Start spawns the subprocess (if not already running) and resolves once it reports its
// bound port on stdout. It is idempotent: a second call returns the cached base URL.
func (s *ServeProcess) Start(ctx context.Context) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cmd != nil {
		return s.baseURL, nil
	}

	args := make([]string, 0, 4)
	env := os.Environ()
	switch s.browser {
	case "":
		// OS default browser.
	case "print":
		args = append(args, "--print")
	default:
		env = append(env, "BROWSER="+s.browser)
	}
	args = append(args, "serve", "--chain", string(s.chain))

	cmd := exec.CommandContext(ctx, s.binPath, args...)
	cmd.Env = env
	cmd.Stderr = os.Stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return "", fmt.Errorf("failed to pipe stdout of %s: %w", s.binPath, err)
	}
	if err := cmd.Start(); err != nil {
		return "", fmt.Errorf("failed to spawn %s: %w", s.binPath, err)
	}

	port, err := readPort(ctx, stdout, cmd)
	if err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return "", err
	}

	s.cmd = cmd
	s.baseURL = fmt.Sprintf("http://127.0.0.1:%d", port)
	return s.baseURL, nil
}

// Stop kills the subprocess and releases the port. It is idempotent.
func (s *ServeProcess) Stop() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cmd == nil {
		return nil
	}
	cmd := s.cmd
	s.cmd = nil
	s.baseURL = ""
	if err := cmd.Process.Kill(); err != nil {
		return err
	}
	_ = cmd.Wait()
	return nil
}

// readPort reads the first non-empty line of the subprocess stdout and parses it as the
// bound port. `serve` prints exactly one integer line, then blocks. If the process exits
// before printing a port, the exit status is surfaced instead. Honors ctx cancellation.
func readPort(ctx context.Context, stdout interface{ Read([]byte) (int, error) }, cmd *exec.Cmd) (int, error) {
	type result struct {
		port int
		err  error
	}
	ch := make(chan result, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "" {
				continue
			}
			port, err := strconv.Atoi(line)
			if err != nil {
				ch <- result{err: fmt.Errorf("%s printed a non-numeric port: %q", cmd.Path, line)}
				return
			}
			ch <- result{port: port}
			return
		}
		// EOF before any port line: the process died. Report its exit status.
		if err := cmd.Wait(); err != nil {
			ch <- result{err: fmt.Errorf("serve exited early: %w", err)}
			return
		}
		ch <- result{err: fmt.Errorf("serve exited before reporting a port")}
	}()

	select {
	case <-ctx.Done():
		return 0, ctx.Err()
	case r := <-ch:
		return r.port, r.err
	}
}

// resolveBinary picks the `browser-web3-signer` binary: an explicit path, then the
// BROWSER_WEB3_SIGNER_BIN env var, then a repo-relative debug/release build (best effort,
// only present when running from the repo checkout), then `browser-web3-signer` on PATH.
func resolveBinary(explicit string) string {
	if explicit != "" {
		return explicit
	}
	if env := os.Getenv(binEnvVar); env != "" {
		return env
	}
	// Best-effort repo build. runtime.Caller points at this source file's location, which
	// is <repo>/go/serve.go when built from a checkout; the workspace root is one level up.
	// From the module cache there is no target/ there, so this simply misses and we fall
	// through to PATH.
	if _, file, _, ok := runtime.Caller(0); ok {
		root := filepath.Dir(filepath.Dir(file))
		for _, rel := range []string{"target/release/browser-web3-signer", "target/debug/browser-web3-signer"} {
			candidate := filepath.Join(root, rel)
			if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
				return candidate
			}
		}
	}
	return "browser-web3-signer"
}
