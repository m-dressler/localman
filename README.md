# @md/localman

Run multiple services locally, each addressable at its own `<host>.localhost`.

Localman runs a tiny reverse proxy on port `80`. The first invocation binds the
port and becomes the **master**; every later invocation registers with it over
HTTP. Each service is started with a `PORT` environment variable pointing at a
free port, and requests to `<host>.localhost` are forwarded there.

## Install

```sh
deno i --global -A jsr:@md/localman
```

## Usage

```
localman [--keep-hostname] [-v|--verbose] <host> <command> [...args]
```

Run a service and expose it at `api.localhost`:

```sh
localman api deno run -A ./api.ts
```

In another terminal, add a second service at `web.localhost`; it registers with
the already-running master automatically:

```sh
localman web npm run dev --port \$PORT
```

Now `http://api.localhost/` and `http://web.localhost/` both reach their
services, and `http://localhost/` lists every registered host.

Pass `--keep-hostname` to forward the original `<host>.localhost` hostname to
your service instead of rewriting it to `localhost`.

Either way, a same-origin `Origin` header is rewritten to match the forwarded
`Host`, so origin checks (e.g. CSRF protection) pass. A foreign `Origin` is left
untouched. The address the client used is available in `X-Forwarded-Host` and
`X-Forwarded-Proto`.

> Binding port `80` typically requires elevated privileges.

Set `LOCALMAN_PORT` to run the proxy on another port, e.g. `LOCALMAN_PORT=8080`
serves `http://api.localhost:8080/`. Every instance that should share a routing
table needs the same value.

## Failover

There is no dedicated daemon: the master is just whichever instance currently
owns the port. Every other instance holds a long-poll open to it. When the
master exits, the poll drops and the survivors race to re-bind the port — one
becomes the new master and the rest re-register their hosts with it, so the
routing table is rebuilt automatically.

The long-poll doubles as a lease: when an instance exits without unregistering
(its terminal was closed, it was killed, it crashed), the master releases its
hosts, so they can be taken again right away.

Instances talk to the master over a versioned protocol, so every service on a
machine must run a compatible localman. An instance that finds its port (`80`,
or `LOCALMAN_PORT`) held by an incompatible localman, or by another program,
exits with an error before starting its command.
