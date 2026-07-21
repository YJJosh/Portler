# Proxy: one project URL

Add a top-level `proxy:` block to put every service behind a single URL. Portler starts a local reverse proxy on a Portler-assigned port and prints one project URL — which also removes CORS pain, because the browser only ever talks to one origin.

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
- A fixed number like `port: 8080` is *preferred* when free — like a service's declared port, it is not a hard requirement.

## Headers and WebSockets

- The `Host` header is preserved, and `X-Forwarded-For`, `X-Forwarded-Proto`, and `X-Forwarded-Host` are set.
- WebSocket upgrades are proxied transparently, so dev-server HMR works through the project URL.
- When a routed service is down, the proxy answers `502 Bad Gateway` with a message naming the service.

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
