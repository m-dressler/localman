import { orange } from "./color.ts";

/** Routing entry for a registered host: the local port to forward to. */
export type HostConfig = {
  /** Local port the target service is listening on. */
  port: number;
  /**
   * When true the original `<host>.localhost` hostname is preserved when
   * forwarding; otherwise it is rewritten to `localhost`.
   */
  keepHostname: boolean;
};

/** Options for {@link createServer}. */
export type ServerOptions = {
  /**
   * Port the master binds to and clients connect through. Defaults to 80.
   * Overridable mainly so tests can run on an unprivileged port.
   */
  port?: number;
};

/** Handle returned by {@link createServer} for driving a single instance. */
export type LocalmanServer = {
  /** Registers (or updates) a host mapping, locally when master or over HTTP when a client. */
  registerHost: (host: string, config: HostConfig) => Promise<void>;
  /** Removes a host mapping, locally when master or over HTTP when a client. */
  unregisterHost: (host: string) => Promise<void>;
  /** Stops serving (master) or watching (client) and releases all resources. */
  close: () => Promise<void>;
  /** Whether this instance currently owns the port. Primarily for tests/introspection. */
  isMaster: () => boolean;
};

/**
 * Header identifying the instance behind a protocol request. Its open `/wait`
 * polls form the lease that keeps the hosts it registered alive.
 */
const INSTANCE_HEADER = "Localman-Instance";

/** A routing table entry: a host mapping and the instance that registered it. */
type Registration = {
  /** Id of the instance whose lease keeps this mapping alive. */
  owner: string;
  config: HostConfig;
};

/** Mutable routing state owned by the request {@link createHandler}. */
type HandlerState = {
  /** Full routing table. Authoritative only on the master. */
  hosts: Map<string, Registration>;
  /**
   * Open long-poll stream controllers and the instance each belongs to. Closed
   * on graceful shutdown to trigger failover.
   */
  waiters: Map<ReadableStreamDefaultController<Uint8Array>, string>;
};

/** Resolves after `ms` milliseconds. */
const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `fn`, retrying on rejection up to `attempts` times with a fixed delay.
 * Used to bridge the brief window during failover where a freshly elected
 * master may not yet be accepting connections.
 */
const withRetry = async <T>(
  fn: () => Promise<T>,
  attempts = 5,
  delayMs = 50,
): Promise<T> => {
  for (let attempt = 1;; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts) throw err;
      await delay(delayMs);
    }
  }
};

/** Concise, human-readable reason from a WebSocket error event. */
const errorReason = (event: Event): string =>
  event instanceof ErrorEvent ? event.message : event.type;

/**
 * Whether a socket opened with `new WebSocket` may close with `code`. The API
 * throws for protocol-reserved codes a peer may still report, such as 1001
 * (going away) or 1006 (dropped without a close frame).
 */
const isSendableCloseCode = (code: number): boolean =>
  code === 1000 || (code >= 3000 && code <= 4999);

/** A message relayed between the two sides of a proxied WebSocket. */
type WebsocketData = string | ArrayBufferLike | Blob | ArrayBufferView;

/**
 * Proxies a WebSocket upgrade to `url`, opening the upstream with `headers`.
 *
 * The client is upgraded only once the upstream has opened, so its handshake
 * carries the subprotocol the upstream selected — a browser fails a socket
 * whose handshake omits the subprotocol it asked for (Vite's HMR asks for
 * `vite-hmr`) — and an upstream that never opens is answered with a 502 rather
 * than an upgrade that closes at once.
 */
const forwardWebsocket = async (
  req: Request,
  url: URL,
  headers: Headers,
): Promise<Response> => {
  // `WebSocket` drops a subprotocol passed as a header; it takes them as `protocols`.
  const protocols = (req.headers.get("Sec-WebSocket-Protocol") ?? "")
    .split(",")
    .map((protocol) => protocol.trim())
    .filter(Boolean);
  headers.delete("Sec-WebSocket-Protocol");

  let upstream: WebSocket;
  try {
    upstream = new WebSocket(url, { protocols, headers });
  } catch (err) {
    console.error("WebSocket | Failed to connect upstream", err);
    return Response.json(
      { message: "Failed to proxy websocket" },
      { status: 500 },
    );
  }

  // Messages the upstream sends before the client's socket has opened.
  const upstreamQueue: WebsocketData[] = [];
  upstream.onmessage = ({ data }) => upstreamQueue.push(data);

  const opened = await new Promise<boolean>((resolve) => {
    upstream.onopen = () => resolve(true);
    upstream.onclose = () => resolve(false);
    upstream.onerror = (event) => {
      // A failure before it ever opened means the upstream refused or could
      // not complete the handshake — a genuine (often misconfigured-port)
      // problem worth surfacing.
      console.error(
        "WebSocket | Upstream connection failed",
        errorReason(event),
      );
      resolve(false);
    };
  });
  if (!opened) {
    return Response.json(
      { message: `Upstream WebSocket on port ${url.port} is not reachable` },
      { status: 502 },
    );
  }

  const { socket: client, response } = Deno.upgradeWebSocket(req, {
    protocol: upstream.protocol || undefined,
  });

  let closed = false;

  const isOpen = (ws: WebSocket) => ws.readyState === WebSocket.OPEN;

  const closeBoth = (code = 1000, reason?: string) => {
    if (closed) return;
    closed = true;

    for (const ws of [client, upstream]) {
      if (
        ws.readyState === WebSocket.OPEN ||
        ws.readyState === WebSocket.CONNECTING
      ) {
        try {
          // Rather than throw and leave the upstream open, close it without a
          // status. The client's socket relays any code, and drops the
          // connection for 1005/1006 so the browser sees an unclean close.
          if (ws === upstream && !isSendableCloseCode(code)) ws.close();
          else ws.close(code, reason);
        } catch {
          // Ignore
        }
      }
    }
  };

  client.onopen = () => {
    while (upstreamQueue.length && isOpen(client)) {
      client.send(upstreamQueue.shift()!);
    }
  };

  client.onmessage = ({ data }) => {
    if (!closed && isOpen(upstream)) upstream.send(data);
  };

  upstream.onmessage = ({ data }) => {
    if (closed) return;

    if (isOpen(client)) client.send(data);
    else if (client.readyState === WebSocket.CONNECTING) {
      upstreamQueue.push(data);
    }
  };

  client.onclose = ({ code, reason }) => {
    closeBoth(code, reason);
  };

  upstream.onclose = ({ code, reason }) => {
    closeBoth(code, reason);
  };

  client.onerror = (event) => {
    // Browsers and HMR sockets routinely drop without a close handshake, which
    // surfaces here as an error (e.g. "Unexpected EOF"). It needs no action —
    // the paired onclose tears the other side down — so keep it out of the way.
    console.debug("WebSocket | Client disconnected", errorReason(event));
  };

  upstream.onerror = (event) => {
    // A drop once the upstream has opened is an expected lifecycle event.
    console.debug("WebSocket | Upstream disconnected", errorReason(event));
  };

  return response;
};

/**
 * Maps an absolute `Location` pointing at the upstream's own `upstreamOrigin`
 * back onto the `proxyOrigin` the client used, so a redirect built from the
 * upstream's `Host` doesn't send the browser around the proxy. Relative and
 * foreign locations are returned as is.
 */
const rewriteLocation = (
  res: Response,
  upstreamOrigin: string,
  proxyOrigin: string,
): Response => {
  const location = URL.parse(res.headers.get("Location") ?? "");
  if (location?.origin !== upstreamOrigin) return res;

  // Responses from `fetch` have immutable headers, so rebuild around the body.
  const headers = new Headers(res.headers);
  headers.set(
    "Location",
    new URL(
      location.pathname + location.search + location.hash,
      proxyOrigin,
    ).href,
  );
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
};

/**
 * Re-streams `res`'s body so that aborting `signal` ends it. Deno serves a body
 * taken straight from `fetch` natively, out of reach of the request's abort, so
 * a long-lived response such as an event stream would hold `shutdown()` open.
 * On abort the upstream is cancelled and the client's stream closed cleanly;
 * an upstream failing on its own still fails the client's stream.
 */
const endOnAbort = (res: Response, signal: AbortSignal): Response => {
  if (!res.body) return res;
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  res.body
    .pipeTo(writable, { signal, preventAbort: true })
    // Also rejects once the client is gone, leaving nothing to end.
    .catch((err) =>
      (signal.aborted ? writable.close() : writable.abort(err)).catch(() => {})
    );
  return new Response(readable, res);
};

/**
 * Forwards a proxied request to the local port named by `config`.
 *
 * `fetch` and `WebSocket` derive `Host` from the upstream URL, so a same-origin `Origin` is
 * mapped to that same upstream origin to keep origin checks consistent, and a
 * redirect to that upstream origin is mapped back. The address the client
 * actually used is passed on as `X-Forwarded-Host`/`-Proto`.
 *
 * Aborting `signal` cuts off the upstream request, ending a response that is
 * still streaming so the server can shut down.
 */
const forwardRequest = async (
  req: Request,
  config: HostConfig,
  signal: AbortSignal,
): Promise<Response> => {
  const incoming = new URL(req.url);
  const url = new URL(req.url);
  url.port = String(config.port);
  if (!config.keepHostname) url.hostname = "localhost";
  const headers = new Headers(req.headers);
  headers.set("X-Forwarded-Host", incoming.host);
  headers.set("X-Forwarded-Proto", incoming.protocol.slice(0, -1));
  // Only a same-origin request is mapped to the upstream's origin; a foreign
  // Origin passes through untouched so cross-site requests stay detectable.
  if (req.headers.get("Origin") === incoming.origin) {
    headers.set("Origin", url.origin);
  }

  if (
    req.headers.get("connection")?.toLowerCase()?.includes("upgrade") &&
    req.headers.get("upgrade")?.toLowerCase() === "websocket"
  ) {
    return forwardWebsocket(req, url, headers);
  }

  try {
    const res = await fetch(url, {
      method: req.method,
      headers,
      body: req.body,
      // Redirects are the browser's to follow, along with any cookies they set.
      redirect: "manual",
      signal,
    });
    return rewriteLocation(
      endOnAbort(res, signal),
      url.origin,
      incoming.origin,
    );
  } catch (err) {
    // Cut off by our own shutdown rather than a failing upstream.
    if (signal.aborted) {
      return Response.json(
        { message: "Localman is shutting down" },
        { status: 503 },
      );
    }
    console.error("Failed to forward to port", config.port, err);
    return Response.json(
      { message: `Upstream on port ${config.port} is not reachable` },
      { status: 502 },
    );
  }
};

/**
 * Handles `POST /hosts/:host` — validates and records a host mapping for
 * `owner`. Registering a host the owner already holds updates it.
 */
const handleRegister = async (
  req: Request,
  host: string,
  owner: string,
  state: HandlerState,
): Promise<Response> => {
  if (!req.headers.get("Content-Type")?.includes("application/json")) {
    return Response.json(
      { message: "Content-Type must be application/json" },
      { status: 400 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch (err) {
    console.error(req.method, req.url, err);
    return Response.json(
      { message: "Request body is invalid JSON" },
      { status: 400 },
    );
  }

  const { port, keepHostname = false } = body;
  if (typeof port !== "number" || typeof keepHostname !== "boolean") {
    return Response.json(
      {
        message:
          "Request body must be of type `{port:number,keepHostname?:boolean}`",
      },
      { status: 400 },
    );
  }

  const existing = state.hosts.get(host);
  if (existing && existing.owner !== owner) {
    return Response.json(
      { message: "Host is already bound`" },
      { status: 400 },
    );
  }

  state.hosts.set(host, { owner, config: { port, keepHostname } });
  console.debug(`Registered host   ${orange(host)} to port`, port);
  return new Response(null, { status: 204 });
};

/**
 * Handles `DELETE /hosts/:host` — removes a host mapping if `owner` holds it.
 * Idempotent, and a no-op for hosts held by another instance.
 */
const handleUnregister = (
  host: string,
  owner: string,
  state: HandlerState,
): Response => {
  if (state.hosts.get(host)?.owner === owner) {
    state.hosts.delete(host);
    console.debug(`Deregistered host ${orange(host)}`);
  }
  return new Response(null, { status: 204 });
};

/**
 * Drops every host held by `owner` once its last `/wait` poll is gone, i.e.
 * the instance exited without unregistering (SIGHUP, SIGKILL, a crash).
 */
const releaseLease = (owner: string, state: HandlerState): void => {
  if ([...state.waiters.values()].includes(owner)) return;
  for (const [host, registration] of state.hosts) {
    if (registration.owner !== owner) continue;
    state.hosts.delete(host);
    console.debug(`Released host     ${orange(host)}`);
  }
};

/**
 * Handles `GET /wait` — the failover long-poll and `owner`'s lease. Returns a
 * response whose body never emits and stays open until the master shuts down
 * (closing the stream) or its process exits (dropping the socket), signalling
 * clients to re-elect. Should the client drop it instead, its lease ends.
 */
const handleWait = (owner: string, state: HandlerState): Response => {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start: (c) => {
      controller = c;
      state.waiters.set(c, owner);
    },
    cancel: () => {
      state.waiters.delete(controller);
      releaseLease(owner, state);
    },
  });
  return new Response(body, { headers: { "Content-Type": "text/plain" } });
};

/** Handles `GET /` — lists registered hosts as HTML or JSON per `Accept`. */
const handleRoot = (req: Request, state: HandlerState): Response => {
  const acceptContent = (req.headers.get("Accept") || "")
    .split(/,\s*/)
    .map((v) => v.replace(/;.*$/, ""));
  const acceptPreference = (contentType: string) =>
    acceptContent.indexOf(contentType) + 1 || Number.MAX_SAFE_INTEGER;

  if (acceptPreference("text/html") < acceptPreference("application/json")) {
    return new Response(
      `<table><thead><tr><th>Host</th><th>Port</th></tr></thead><tbody>${
        Array.from(
          state.hosts.entries(),
        )
          .map(
            ([host, { config }]) =>
              `<tr><td><a href="http://${host}.localhost/">${host}</a></td><td>${config.port}</td></tr>`,
          )
          .join("")
      }</tbody></table>`,
      { headers: { "Content-Type": "text/html" } },
    );
  }
  return Response.json(
    Object.fromEntries(
      Array.from(state.hosts, ([host, { config }]) => [host, config]),
    ),
  );
};

/** Answers a protocol request that doesn't say which instance it's from. */
const missingInstance = (): Response =>
  Response.json(
    { message: `Missing ${INSTANCE_HEADER} header` },
    { status: 400 },
  );

/** Handles requests addressed to the master itself (`localhost`). */
const handleLocalmanRequest = (
  req: Request,
  url: URL,
  state: HandlerState,
): Response | Promise<Response> => {
  const owner = req.headers.get(INSTANCE_HEADER);
  const match = url.pathname.match(/^\/hosts\/([^/]+)\/?$/);
  if (match) {
    const host = match[1];
    if (req.method === "POST") {
      return owner
        ? handleRegister(req, host, owner, state)
        : missingInstance();
    }
    if (req.method === "DELETE") {
      return owner ? handleUnregister(host, owner, state) : missingInstance();
    }
    return Response.json(
      { message: "Method not allowed; use POST or DELETE" },
      { status: 405, headers: { Allow: "POST, DELETE" } },
    );
  }
  if (url.pathname === "/wait" && req.method === "GET") {
    return owner ? handleWait(owner, state) : missingInstance();
  }
  if (url.pathname === "/" && req.method === "GET") {
    return handleRoot(req, state);
  }

  return Response.json(
    { message: "The requested route doesn't exist" },
    { status: 404 },
  );
};

/** Whether `hostname` is an IPv4 (`127.0.0.0/8`) or IPv6 (`::1`) loopback address. */
const isLoopback = (hostname: string): boolean =>
  hostname.startsWith("127.") || hostname === "::1";

/**
 * Builds the master's request handler over the given routing `state`.
 *
 * The port is bound on all interfaces, since macOS only lets unprivileged users
 * bind port 80 that way, so peers other than this machine are refused here.
 * Aborting `closing` ends the requests it is still proxying.
 */
const createHandler = (
  state: HandlerState,
  closing: AbortSignal,
): Deno.ServeHandler<Deno.NetAddr> =>
(req, info) => {
  if (!isLoopback(info.remoteAddr.hostname)) {
    return Response.json(
      { message: "Localman only accepts connections from this machine" },
      { status: 403 },
    );
  }

  const url = new URL(req.url);
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
    return handleLocalmanRequest(req, url, state);
  }

  const config = state.hosts.get(url.hostname.replace(/\.localhost$/, ""))
    ?.config;
  if (config) return forwardRequest(req, config, closing);
  return Response.json(
    { message: "No host registered for " + url.hostname },
    { status: 404 },
  );
};

/**
 * Creates a localman instance that either owns the port (master) or connects to
 * the current master (client).
 *
 * The first instance to bind the port becomes master and holds the routing
 * table in memory. Every client keeps a long-poll open to the master; when the
 * master exits, the poll drops and all clients race to re-bind the port. One
 * wins and becomes the new master (seeding the table with its own hosts); the
 * rest re-register their hosts with the winner. Because each instance only
 * remembers the hosts it registered, the table is rebuilt collectively on
 * failover.
 *
 * @returns Handlers to register/unregister hosts and to close the instance.
 */
export const createServer = (options: ServerOptions = {}): LocalmanServer => {
  const port = options.port ?? 80;
  const origin = `http://localhost:${port}`;

  /** Identifies this instance to the master as the owner of its hosts. */
  const instance = crypto.randomUUID();
  // Hosts this instance is responsible for, replayed to the master on failover.
  const ownHosts = new Map<string, HostConfig>();
  const state: HandlerState = { hosts: new Map(), waiters: new Map() };
  /** Aborted on close to end requests still being proxied. */
  const closing = new AbortController();
  const handler = createHandler(state, closing.signal);

  let master = false;
  let running = true;
  let server: Deno.HttpServer<Deno.NetAddr> | undefined;
  let pollAbort: AbortController | undefined;

  /**
   * Attempts to bind the port and become master. Returns whether it succeeded;
   * on success it seeds the routing table with this instance's own hosts.
   */
  const tryBecomeMaster = (): boolean => {
    try {
      server = Deno.serve({
        port,
        handler,
        onListen: () => console.debug(`Localman master listening on ${origin}`),
      });
    } catch (err) {
      if (err instanceof Deno.errors.AddrInUse) return false;
      throw err;
    }
    master = true;
    for (const [host, config] of ownHosts) {
      state.hosts.set(host, { owner: instance, config });
    }
    return true;
  };

  /** Registers a single host with the current master over HTTP. */
  const httpRegister = async (
    host: string,
    config: HostConfig,
  ): Promise<void> => {
    const res = await fetch(`${origin}/hosts/${host}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [INSTANCE_HEADER]: instance,
      },
      body: JSON.stringify(config),
    });
    if (!res.ok) {
      throw new Error(`Failed to register host (${res.status})`, {
        cause: await res.text(),
      });
    }
  };

  /** Replays every owned host to the (new) master. */
  const reRegisterAll = (): Promise<void> =>
    withRetry(async () => {
      for (const [host, config] of ownHosts) await httpRegister(host, config);
    });

  /**
   * Client loop: holds a long-poll to the master as this instance's lease,
   * replaying its hosts each time the lease is taken out. Whenever the poll
   * drops it contends for the port — becoming master on a win — then resumes
   * watching the (new) master.
   */
  const watchMaster = async (): Promise<void> => {
    while (running && !master) {
      try {
        pollAbort = new AbortController();
        const res = await fetch(`${origin}/wait`, {
          signal: pollAbort.signal,
          headers: { [INSTANCE_HEADER]: instance },
        });
        // Only replay once the lease is held, so the hosts are released with
        // it should this instance go away.
        try {
          await reRegisterAll();
        } catch (err) {
          console.error("Failed to re-register with master", err);
        }
        const reader = res.body?.getReader();
        if (reader) { while (!(await reader.read()).done); }
      } catch {
        // Poll aborted (close) or connection dropped (master gone).
      }
      if (!running) return;

      if (tryBecomeMaster()) {
        console.debug("Promoted to master after previous master exited");
        return;
      }
    }
  };

  if (!tryBecomeMaster()) void watchMaster();

  return {
    registerHost: async (host, config) => {
      ownHosts.set(host, config);
      if (master) {
        state.hosts.set(host, { owner: instance, config });
        return;
      }
      await withRetry(() => httpRegister(host, config));
    },

    unregisterHost: async (host) => {
      ownHosts.delete(host);
      if (master) {
        state.hosts.delete(host);
        return;
      }
      try {
        const res = await fetch(`${origin}/hosts/${host}`, {
          method: "DELETE",
          headers: { [INSTANCE_HEADER]: instance },
        });
        if (!res.ok) {
          throw new Error(`Failed to unregister host (${res.status})`, {
            cause: await res.text(),
          });
        }
      } catch (err) {
        // Best effort: if the master is mid-failover the mapping dies with it.
        console.error("Failed to unregister host", host, err);
      }
    },

    close: async () => {
      running = false;
      pollAbort?.abort();
      if (server) {
        // Open proxied responses, such as event streams, would hold shutdown()
        // until the browser lets go of them.
        closing.abort();
        // End the long-polls first so shutdown() isn't blocked on them, and so
        // clients fail over promptly instead of waiting for a socket timeout.
        for (const controller of state.waiters.keys()) {
          try {
            controller.close();
          } catch {
            // Already closed.
          }
        }
        state.waiters.clear();
        await server.shutdown();
      }
    },

    isMaster: () => master,
  };
};
