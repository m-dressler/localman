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

/** Mutable routing state owned by the request {@link createHandler}. */
type HandlerState = {
  /** Full routing table. Authoritative only on the master. */
  hosts: Map<string, HostConfig>;
  /** Open long-poll stream controllers, closed on graceful shutdown to trigger failover. */
  waiters: Set<ReadableStreamDefaultController<Uint8Array>>;
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
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts) throw err;
      await delay(delayMs);
    }
  }
};

/** Forwards a proxied request to the local port named by `config`. */
const forwardRequest = async (
  req: Request,
  config: HostConfig,
): Promise<Response> => {
  const url = new URL(req.url);
  url.port = String(config.port);
  const headers = new Headers(req.headers);
  if (!config.keepHostname) {
    url.hostname = "localhost";
    if (req.headers.has("Host")) headers.set("Host", "localhost");
    if (req.headers.has("Origin"))
      headers.set("Origin", url.protocol + "//localhost");
  }

  try {
    return await fetch(url, {
      method: req.method,
      headers,
      body: req.body,
      duplex: "half",
    });
  } catch (err) {
    console.error("Failed to forward to port", config.port, err);
    return Response.json(
      { message: `Upstream on port ${config.port} is not reachable` },
      { status: 502 },
    );
  }
};

/** Handles `POST /hosts/:host` — validates and records a host mapping. */
const handleRegister = async (
  req: Request,
  host: string,
  state: HandlerState,
): Promise<Response> => {
  if (!req.headers.get("Content-Type")?.includes("application/json"))
    return Response.json(
      { message: "Content-Type must be application/json" },
      { status: 400 },
    );

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
  if (typeof port !== "number" || typeof keepHostname !== "boolean")
    return Response.json(
      {
        message:
          "Request body must be of type `{port:number,keepHostname?:boolean}`",
      },
      { status: 400 },
    );

  if (state.hosts.get(host))
    return Response.json(
      { message: "Host is already bound`" },
      { status: 400 },
    );

  state.hosts.set(host, { port, keepHostname });
  console.debug(`Registered host   ${orange(host)} to port`, port);
  return new Response(null, { status: 204 });
};

/** Handles `DELETE /hosts/:host` — removes a host mapping (idempotent). */
const handleUnregister = (host: string, state: HandlerState): Response => {
  state.hosts.delete(host);
  console.debug(`Deregistered host ${orange(host)}`);
  return new Response(null, { status: 204 });
};

/**
 * Handles `GET /wait` — the failover long-poll. Returns a response whose body
 * never emits and stays open until the master shuts down (closing the stream)
 * or its process exits (dropping the socket), signalling clients to re-elect.
 */
const handleWait = (state: HandlerState): Response => {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start: (c) => {
      controller = c;
      state.waiters.add(c);
    },
    cancel: () => {
      state.waiters.delete(controller);
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

  if (acceptPreference("text/html") < acceptPreference("application/json"))
    return new Response(
      `<table><thead><tr><th>Host</th><th>Port</th></tr></thead><tbody>${Array.from(
        state.hosts.entries(),
      )
        .map(
          ([host, config]) =>
            `<tr><td><a href="http://${host}.localhost/">${host}</a></td><td>${config.port}</td></tr>`,
        )
        .join("")}</tbody></table>`,
      { headers: { "Content-Type": "text/html" } },
    );
  return Response.json(Object.fromEntries(state.hosts.entries()));
};

/** Handles requests addressed to the master itself (`localhost`). */
const handleLocalmanRequest = (
  req: Request,
  url: URL,
  state: HandlerState,
): Response | Promise<Response> => {
  const match = url.pathname.match(/^\/hosts\/([^/]+)\/?$/);
  if (match) {
    const host = match[1];
    if (req.method === "POST") return handleRegister(req, host, state);
    if (req.method === "DELETE") return handleUnregister(host, state);
    return Response.json(
      { message: "Method not allowed; use POST or DELETE" },
      { status: 405, headers: { Allow: "POST, DELETE" } },
    );
  }
  if (url.pathname === "/wait" && req.method === "GET")
    return handleWait(state);
  if (url.pathname === "/" && req.method === "GET")
    return handleRoot(req, state);

  return Response.json(
    { message: "The requested route doesn't exist" },
    { status: 404 },
  );
};

/** Builds the master's request handler over the given routing `state`. */
const createHandler =
  (state: HandlerState): Deno.ServeHandler<Deno.NetAddr> =>
  (req) => {
    const url = new URL(req.url);
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1")
      return handleLocalmanRequest(req, url, state);

    const config = state.hosts.get(url.hostname.replace(/\.localhost$/, ""));
    if (config) return forwardRequest(req, config);
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

  // Hosts this instance is responsible for, replayed to the master on failover.
  const ownHosts = new Map<string, HostConfig>();
  const state: HandlerState = { hosts: new Map(), waiters: new Set() };
  const handler = createHandler(state);

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
    for (const [host, config] of ownHosts) state.hosts.set(host, config);
    return true;
  };

  /** Registers a single host with the current master over HTTP. */
  const httpRegister = async (
    host: string,
    config: HostConfig,
  ): Promise<void> => {
    const res = await fetch(`${origin}/hosts/${host}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
    if (!res.ok)
      throw new Error(`Failed to register host (${res.status})`, {
        cause: await res.text(),
      });
  };

  /** Replays every owned host to the (new) master. */
  const reRegisterAll = (): Promise<void> =>
    withRetry(async () => {
      for (const [host, config] of ownHosts) await httpRegister(host, config);
    });

  /**
   * Client loop: holds a long-poll to the master and, whenever it drops,
   * contends for the port — becoming master on a win or re-registering on a
   * loss — then resumes watching the (new) master.
   */
  const watchMaster = async (): Promise<void> => {
    while (running && !master) {
      try {
        pollAbort = new AbortController();
        const res = await fetch(`${origin}/wait`, { signal: pollAbort.signal });
        const reader = res.body?.getReader();
        if (reader) while (!(await reader.read()).done);
      } catch {
        // Poll aborted (close) or connection dropped (master gone).
      }
      if (!running) return;

      if (tryBecomeMaster()) {
        console.debug("Promoted to master after previous master exited");
        return;
      }
      try {
        await reRegisterAll();
      } catch (err) {
        console.error("Failed to re-register with new master", err);
      }
    }
  };

  if (!tryBecomeMaster()) void watchMaster();

  return {
    registerHost: async (host, config) => {
      ownHosts.set(host, config);
      if (master) {
        state.hosts.set(host, config);
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
        });
        if (!res.ok)
          throw new Error(`Failed to unregister host (${res.status})`, {
            cause: await res.text(),
          });
      } catch (err) {
        // Best effort: if the master is mid-failover the mapping dies with it.
        console.error("Failed to unregister host", host, err);
      }
    },

    close: async () => {
      running = false;
      pollAbort?.abort();
      if (server) {
        // End the long-polls first so shutdown() isn't blocked on them, and so
        // clients fail over promptly instead of waiting for a socket timeout.
        for (const controller of state.waiters) {
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
