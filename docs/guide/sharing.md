# Sharing a stack over the network

`portler up --share` makes a running stack reachable from other machines: your phone, a laptop, a teammate. Tailscale is the first-class case, and it works the same on a tailnet run by [Headscale](https://headscale.net/).

```bash
portler up -d --share tailscale
```

```text
SERVICE   PORT   URL
--------  -----  -----------------------
backend   59147  http://100.64.0.4:59147
frontend  52329  http://100.64.0.4:52329
proxy     57615  http://100.64.0.4:57615
[portler] shared on tailscale (100.64.0.4, fd7a:115c:a1e0::4), reachable by every tailnet device your ACLs allow: backend 59147, frontend 52329, proxy 57615
[portler] project url: http://100.64.0.4:57615
```

Every URL Portler prints (the table, the project URL, [`portler ps`](/reference/cli/ps), [`portler ports`](/reference/cli/ports)) now works from any device on the tailnet.

## Targets

| `--share` | Listens on | URLs use |
| --- | --- | --- |
| `tailscale` | this machine's Tailscale addresses (IPv4 and IPv6) | the Tailscale IPv4 address |
| `tailscale-dns` | the same | the machine's existing MagicDNS name, e.g. `laptop.tail1234.ts.net` |
| `<ip>` | that one address of this machine, e.g. a LAN address | that address |
| `none` | nothing extra | `localhost` |

`PORTLER_SHARE` sets the default for `up` when nothing of the stack runs yet, so `PORTLER_SHARE=tailscale` in your shell shares every stack you start; `--share none` overrides it for one run. Next to a running stack, that stack's choice wins over `PORTLER_SHARE`.

Portler uses the Tailscale that is already installed and logged in. It only reads `tailscale status --json`: it never runs `tailscale up`, changes the node's settings, asks for certificates, or creates DNS records. On macOS it also finds the CLI inside `Tailscale.app`; set `PORTLER_TAILSCALE` to use another path.

`tailscale` uses the IP in URLs on purpose: it works on a device that does not use MagicDNS, and dev servers such as Vite accept IP addresses but refuse unknown host names (see [Limits](#limits)).

## How it works

```text
other device ──► 100.64.0.4:52329 ──► Portler forwarder ──► 127.0.0.1:52329 ──► frontend
                 (tailnet only)        (leads frontend's process group)
```

- Services keep listening on `127.0.0.1` as always. Portler cannot make an app bind somewhere else, so it does not try.
- For each shared port, a small Portler forwarder listens on the Tailscale address with the **same port number** and passes connections to the service. The forwarder leads the service's process group and runs the service's command as its child: it stops when the service exits, and `down`, `restart` and `Ctrl+C` stop both. A stopped service is never still reachable.
- The pid Portler prints for a shared service is the wrapper's. Stop a service by its group, as Portler does: `portler down <name>`, or `kill -TERM -<pid>`; a plain `kill <pid>` leaves it running.
- The forwarder starts listening only once the service accepts connections, so it never takes a port the service is about to bind.
- The forwarder connects to the service *from* the shared address, so the service does not mistake a remote visitor for a local one (`127.0.0.1`). Where the OS refuses that, the forwarder logs it and connects from loopback.
- The [proxy](/guide/proxy) listens on the Tailscale addresses itself, so it still sees the real visitor address for `X-Forwarded-For`, and it answers for the Tailscale IPs and the MagicDNS name.
- Ports are chosen so they are free on loopback **and** on the shared address.
- Each shared port has its own small forwarder process (a Node process, tens of MB of memory), so sharing a large stack costs some memory.
- `up` waits until each shared address answers before it starts the next service and returns, so the printed URLs work right away. If one does not answer, `up` warns and the service keeps running.

### Only the tailnet

With `tailscale` (or an `<ip>` inside the tailnet ranges), Portler listens only on the Tailscale addresses, never on `0.0.0.0`, and it also refuses every connection that does not come from a tailnet address (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`). The second check matters: Linux and macOS accept a packet for any local address on any interface, so a machine on your LAN could otherwise reach `100.64.0.4` by routing it through your LAN address.

Headscale's `prefixes` setting has to stay inside these two ranges too, since the Tailscale client only supports them.

Who on the tailnet can connect is decided by your tailnet's ACLs (in Headscale, its policy file). A tailnet with no policy lets every node reach every node.

## What is shared

Every service with a TCP `port`, and the proxy. To keep one on this machine, set `share: false`:

```yaml
services:
  postgres:
    use: postgres@18
    share: false     # only this machine reaches the database
```

Not shared:

- `share: false` services. A proxy route to one answers `403` on the shared address and still works on this machine;
- UDP ports: `transport: udp` services get a warning, a `tcp+udp` service is shared over TCP only;
- a service with `host: 0.0.0.0` (or `::`), or a proxy with `proxy.host: 0.0.0.0`: it already listens on every network, which Portler warns about, since that includes the LAN.

## References between services

While a stack is shared:

| Reference | Value | Use it for |
| --- | --- | --- |
| `${backend.url}`, `PORTLER_BACKEND_URL` | `http://100.64.0.4:59147` | what a browser on another device loads, e.g. `VITE_API_URL` |
| `${backend.local_url}`, `PORTLER_BACKEND_LOCAL_URL` | `http://localhost:59147` | calls from another service on this machine |
| `${backend.address}` | `localhost:59147` (containers: `backend:<port>`) | connection strings; unchanged by sharing |
| `${backend.url_host}` | `100.64.0.4` | |

`local_url` is the same as `url` when the stack is not shared, so it is always safe for server-to-server calls. `${backend.url}` also works on this machine, through the forwarder. Default `http` healthchecks probe the local URL. Database presets build their URLs from `address`, so they stay local.

The simplest browser setup is the proxy with relative URLs (`fetch('/api/…')`): one origin, no CORS, and only the project URL to open.

## Restart, `up` again, and `down`

Portler records the share with the running stack:

- `portler restart` keeps it.
- `portler up api` next to a shared stack shares `api` too; no flag needed.
- `portler env` and `portler run` show the shared URLs.
- Changing it needs a fresh start: `--share` on a stack running without it (or another target, or `none` on a shared one) is refused with "run `portler down` first". Running services already hold env with their URLs.
- After a full `portler down`, a plain `portler up` is private again.

`portler ps` adds a `SHARED` column: `yes` when the shared address answers on that port, `not reachable` when it does not (for example while Tailscale restarts).

## Docker and Kubernetes

The forwarder sits on the host port, so it works the same in every run mode:

- **Docker** (`up`, `up docker`): containers keep publishing on `127.0.0.1`; the forwarder listens on the Tailscale address. Containers still reach each other through the project network.
- **Kubernetes** (`up k8s --share tailscale`): the port-forward supervisor also listens on the Tailscale address and stops with the port-forward. Pods reach each other through cluster DNS, as before.

## When Tailscale is not ready

`up --share tailscale` checks before anything starts, and stops with a message when:

- the `tailscale` CLI is missing;
- Tailscale is not running or not logged in (`BackendState` is not `Running`);
- the node has no Tailscale address yet;
- no network interface here has the Tailscale address. This happens with tailscaled in userspace networking mode (containers, some CI) and in WSL2 when Tailscale runs on the Windows side.

If Tailscale stops while the stack runs, the forwarders keep their sockets, and sharing works again once the address is back. If the address has changed (for example after the node was registered again), run `portler down` and `portler up --share tailscale`.

## Limits

- **Plain HTTP.** No HTTPS: Headscale has no Tailscale certificates, and Portler creates no DNS names. A browser treats `http://100.64.0.4` as an insecure origin, unlike `http://localhost`, so service workers, `crypto.subtle`, the clipboard API, camera access, passkeys and `Secure` cookies do not work there. OAuth providers usually refuse `http` redirect URLs other than localhost. Put a TLS edge in front if you need these (see [Behind a TLS edge](/guide/proxy#behind-a-tls-edge)).
- **Host checks in dev servers.** Portler keeps the `Host` header, so an app that checks it may refuse the shared name, also through the proxy. Vite allows IP addresses; for `tailscale-dns`, add the name, e.g. `server: { allowedHosts: ['.ts.net'] }`. The same goes for webpack-dev-server `allowedHosts`, Next.js `allowedDevOrigins`, Django `ALLOWED_HOSTS` and Rails `config.hosts`. CORS lists built from `${frontend.url}` follow the shared URL automatically.
- **Not with `--prod`.** A production stack belongs behind its own edge; `--share` is refused with `--prod`, and `PORTLER_SHARE` is ignored there.
- **No authentication.** Sharing opens ports; it does not add logins. Anything on a shared port, a dev database included, is open to whoever the tailnet lets in.
