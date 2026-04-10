package mcp

import (
	"net"
	"net/url"
	"os"
	"strings"
)

// ResolveMCPConnectURL rewrites localhost / 127.0.0.1 in the MCP URL when
// CHAYA_MCP_LOCALHOST_REWRITE is set (e.g. "host.docker.internal") so an engine
// running inside Docker can reach an MCP server on the host machine.
//
// Only intended for static (non-OAuth) clients in EnsureClient. OAuth flows
// store tokens keyed by URL; do not rewrite OAuth server URLs unless the same
// host is used consistently in DB and Redis.
func ResolveMCPConnectURL(raw string) string {
	rew := strings.TrimSpace(os.Getenv("CHAYA_MCP_LOCALHOST_REWRITE"))
	if rew == "" {
		return raw
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return raw
	}
	h := u.Hostname()
	if h != "localhost" && h != "127.0.0.1" {
		return raw
	}
	port := u.Port()
	if port != "" {
		u.Host = net.JoinHostPort(rew, port)
	} else {
		u.Host = rew
	}
	return u.String()
}
