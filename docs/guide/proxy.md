# Proxy: one project URL

Add a top-level `proxy:` block to put every service behind a single URL. Portler starts an HTTP reverse proxy on a Portler-assigned port and prints one project URL — which also removes CORS pain, because the browser only ever talks to one origin.

```yaml
proxy:
  port: auto
  routes:
    /api: backend
    /: frontend
```

```text
$ portler up
SERVICE   PORT   URL
...
[portler] project url: http://localhost:52000
```

Requests to `http://localhost:52000/api/...` go to `backend`; everything else goes to `frontend`.

## How routing works

- The **longest matching prefix wins**, and matching respects path segment boundaries: `/api` matches `/api` and `/api/users`, but not `/apifoo`.
- The prefix is **not stripped** before forwarding, like most dev proxies: a request for `/api/users` reaches the backend as `/api/users`. Mount your routes under the same path the proxy uses.
- Routes can target local, Docker, and Kubernetes services alike — in Kubernetes mode the host proxy forwards to Portler's localhost port-forwards. A route must target a service that declares a `port`.

## Port

- `port: auto` (or omitting `port`) lets Portler pick a free port.
- A fixed number like `port: 8080` is tried first and used when free; if it is taken, the proxy gets another free port. (A service's own `port:` is only tried first with [`prefer_declared_port: true`](/guide/ports#preferring-the-declared-port).)

## Bind address

`proxy.host` overrides the proxy's **bind address only**. It defaults to the root `host`, just as before. It does not change service bind addresses, `url_host`, `protocol`, or the URLs Portler generates. For example, root `host: 127.0.0.1` plus `proxy.host: 0.0.0.0` exposes only the proxy while backends keep their loopback assignments. Local applications must still honor their configured bind address; Portler cannot prevent an application from listening on all interfaces itself.

## Headers and WebSockets

- The transport `Host` header is preserved and checked against the allowed-host policy below. Forwarded headers never bypass this check.
- By default **no peer is trusted**, not even loopback: incoming forwarding metadata is stripped. Portler sets `X-Forwarded-For` to the socket peer's IP, `X-Forwarded-Proto` to `http` (Portler's listener is plain HTTP), and `X-Forwarded-Host` to the checked request `Host` when present.
- WebSocket upgrades are proxied transparently, so dev-server HMR works through the project URL.
- When a routed service is down, the proxy answers `502 Bad Gateway` with a message naming the service.

### Behind a TLS edge

Portler can be the app-level single endpoint behind a separate TLS-terminating edge. It does **not** terminate TLS, authenticate clients, or replace a firewall. Keep backend ports private, and restrict network access to the proxy to your edge where possible:

```yaml
host: 127.0.0.1                 # backend assignments stay private
proxy:
  host: 0.0.0.0                 # only the proxy listens on external interfaces
  port: 8080
  allowed_hosts: [app.example]
  trusted_proxies: [10.0.0.10]   # exact source IP Portler sees for your TLS edge
  routes:
    /api: backend
    /: frontend
services:
  backend:
    command: node api.js
    port: 4000
    port_env: PORT
  frontend:
    command: node web.js
    port: 3000
    port_env: PORT
```

Have the edge forward the public `Host: app.example`, and set `X-Forwarded-Proto: https`, `X-Forwarded-Host: app.example`, and a sanitized `X-Forwarded-For` IP chain. Configure applications to consume these headers **only from Portler**, not from arbitrary callers. For a same-machine edge, the proxy can stay bound to loopback; explicitly allowlist the edge's actual loopback source IP instead. A numeric proxy port is preferred, not guaranteed: if busy, Portler allocates another port. Check `portler ports` and point the edge at the assigned port.

**Trust boundary:** `proxy.trusted_proxies` is an array of exact IPv4/IPv6 addresses, default `[]`. There is no implicit loopback trust, hostname resolution, wildcard, subnet/CIDR, or hop-count trust. IPv6 spellings are normalized, and IPv4-mapped IPv6 socket peers (such as `::ffff:10.0.0.10`) match the corresponding IPv4 entry. Do not include clients, shared/uncontrolled proxies, or an address shared by untrusted callers through NAT. The allowlist trusts the immediate peer to report original metadata honestly; it does not authenticate that metadata itself.

::: warning Existing edge deployments
Incoming forwarding headers are no longer passed through by default. If an existing TLS edge relied on that behavior, sanitize its headers and explicitly configure `trusted_proxies` so applications continue seeing the original HTTPS scheme and hostname. Local development needs no trust entries.
:::

**The edge must remove or overwrite client-supplied forwarding headers before setting its own.** In a multi-edge deployment, each trusted hop must sanitize input from untrusted peers; never blindly append a caller-supplied chain. Portler validates syntax, not the truth of an IP, scheme, or hostname. A compromised or misconfigured allowlisted edge can still spoof valid metadata. Backends must not blindly treat the leftmost IP as authenticated, and should use a trust policy that matches the actual edge/Portler chain.

For both ordinary HTTP and WebSocket upgrades, Portler applies the same policy:

| Header | Policy for an allowlisted socket peer |
| --- | --- |
| `X-Forwarded-Proto` | Preserve exactly one lowercase `http` or `https`. A list, duplicate, or other value is ignored; fallback is `http`. This preserves the original HTTPS secure origin through the plain-HTTP edge-to-Portler hop. |
| `X-Forwarded-Host` | Preserve one valid hostname/IP authority, optionally with a port (IPv6 must be bracketed), only if it also passes `allowed_hosts` / the existing loopback and `url_host` policy. URLs, userinfo, lists, duplicates, invalid ports, and other malformed values are ignored; fallback is the checked transport `Host`. The actual request `Host` must independently pass the guard, even when forwarded host is valid. |
| `X-Forwarded-For` | Preserve a comma-separated chain only if **every** entry is a plain IPv4/IPv6 literal (no ports, brackets, scope identifiers, quotes, or `unknown`), then append the socket peer IP. Multiple header lines are treated as one chain. If any entry is invalid, discard the whole incoming chain and use only the socket peer. |
| `Forwarded`, `X-Real-IP`, other `X-Forwarded-*` | Always removed, even from trusted peers; only the three supported headers above are rebuilt. Portler does not parse RFC `Forwarded` or infer scheme from an unsupported header. |

Validation/fallback is independent for each supported header. Forwarding values named by a request's hop-by-hop `Connection` header are not trusted. Untrusted peers get socket/Host-derived metadata regardless of what they send; configuring `allowed_hosts` does **not** grant forwarding trust. Malformed transport `Host` authorities are refused with `403`, not forwarded.

## Lifecycle

The proxy follows the project lifecycle:

- `portler up` starts it (also with `--detach`),
- `portler down` stops it,
- `portler down proxy` stops just the proxy.

It shows up as `proxy` in `portler ports` and `portler ps`.

## Referencing the proxy

The proxy's address is available to services as `PORTLER_PROXY_URL` / `PORTLER_PROXY_PORT`, or via references like `proxy.url`:

```yaml
services:
  backend:
    command: npm run dev
    port: 4000
    port_env: PORT
    env:
      PUBLIC_ORIGIN: proxy.url
```

::: warning
With a `proxy:` block present, `proxy` is a reserved name and cannot be used as a service name.
:::

## Allowed hosts (DNS-rebinding protection)

The proxy answers only for **loopback** `Host` headers: `localhost`, any `*.localhost` name, `127.0.0.0/8`, and `::1`. Anything else gets a `403`.

This is not paperwork — it closes a real hole. The proxy listens on a loopback port with no authentication, which is fine as long as only local clients reach it. But any web page you visit can make *your browser* send requests to `http://127.0.0.1:<port>`, and with a **DNS rebind** (an attacker's domain briefly resolving to `127.0.0.1`) the browser treats those responses as same-origin and lets the page read them — every service behind your proxy, including whatever your dev API returns. Browsers cannot forge the `Host` header, so pinning it to the names the proxy is legitimately reachable under makes the rebound request arrive as `Host: attacker.com` and be refused.

If you reach your project under another hostname (a `/etc/hosts` alias, a local TLS terminator, a `.test` domain), list it:

```yaml
proxy:
  port: auto
  allowed_hosts:
    - myapp.test
    - dev.myapp.internal
  routes:
    /api: backend
    /: frontend
```

The project's own `url_host` is always allowed automatically. WebSocket upgrades are checked the same way — they are not covered by the same-origin policy, so an unchecked `Host` there would reopen the hole.
