import { assertEquals } from "@std/assert";
import { getAvailablePort } from "@std/net";
import { createServer } from "./server.ts";

// Keep test output focused on assertions, not the instances' debug logging.
console.debug = () => {};

/** Polls `predicate` until it returns true or the timeout elapses. */
const waitFor = async (
  predicate: () => boolean | Promise<boolean>,
  { timeout = 5000, interval = 25 } = {},
): Promise<void> => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error("waitFor timed out");
};

/** Fetches the master's host listing as JSON. */
const listHosts = async (port: number): Promise<Record<string, unknown>> => {
  const res = await fetch(`http://localhost:${port}/`, {
    headers: { Accept: "application/json" },
  });
  return await res.json();
};

Deno.test("master: register, list and unregister a host", async () => {
  const port = getAvailablePort()!;
  const server = createServer({ port });
  try {
    await server.registerHost("app", { port: 4001, keepHostname: false });
    assertEquals(await listHosts(port), {
      app: { port: 4001, keepHostname: false },
    });

    await server.unregisterHost("app");
    assertEquals(await listHosts(port), {});
  } finally {
    await server.close();
  }
});

Deno.test("master: root negotiates HTML when preferred", async () => {
  const port = getAvailablePort()!;
  const server = createServer({ port });
  try {
    await server.registerHost("app", { port: 4002, keepHostname: false });
    const res = await fetch(`http://localhost:${port}/`, {
      headers: { Accept: "text/html" },
    });
    assertEquals(res.headers.get("Content-Type"), "text/html");
    const html = await res.text();
    assertEquals(html.includes("app.localhost"), true);
  } finally {
    await server.close();
  }
});

Deno.test("master: rejects invalid registrations", async () => {
  const port = getAvailablePort()!;
  const server = createServer({ port });
  const url = `http://localhost:${port}/hosts/app`;
  try {
    const wrongType = await fetch(url, {
      method: "POST",
      body: "{}",
    });
    assertEquals(wrongType.status, 400);
    await wrongType.body?.cancel();

    const badJson = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    assertEquals(badJson.status, 400);
    await badJson.body?.cancel();

    const badShape = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ port: "nope" }),
    });
    assertEquals(badShape.status, 400);
    await badShape.body?.cancel();
  } finally {
    await server.close();
  }
});

Deno.test("master: unsupported method and unknown route", async () => {
  const port = getAvailablePort()!;
  const server = createServer({ port });
  try {
    const method = await fetch(`http://localhost:${port}/hosts/app`, {
      method: "PUT",
    });
    assertEquals(method.status, 405);
    assertEquals(method.headers.get("Allow"), "POST, DELETE");
    await method.body?.cancel();

    const missing = await fetch(`http://localhost:${port}/nope`);
    assertEquals(missing.status, 404);
    await missing.body?.cancel();
  } finally {
    await server.close();
  }
});

Deno.test(
  "master: forwards proxied requests to the registered port",
  async () => {
    const port = getAvailablePort()!;
    const upstreamPort = getAvailablePort()!;
    const upstream = Deno.serve({
      port: upstreamPort,
      onListen: () => {},
      handler: (req) => Response.json({ seenUrl: req.url }),
    });
    const server = createServer({ port });
    try {
      await server.registerHost("svc", {
        port: upstreamPort,
        keepHostname: false,
      });
      const res = await fetch(`http://svc.localhost:${port}/hello`);
      assertEquals(res.status, 200);
      assertEquals(await res.json(), {
        seenUrl: `http://localhost:${upstreamPort}/hello`,
      });
    } finally {
      await server.close();
      await upstream.shutdown();
    }
  },
);

Deno.test("master: streams the request body to the upstream", async () => {
  const port = getAvailablePort()!;
  const upstreamPort = getAvailablePort()!;
  const upstream = Deno.serve({
    port: upstreamPort,
    onListen: () => {},
    handler: async (req) => new Response(await req.text()),
  });
  const server = createServer({ port });
  try {
    await server.registerHost("svc", {
      port: upstreamPort,
      keepHostname: false,
    });
    const res = await fetch(`http://svc.localhost:${port}/`, {
      method: "POST",
      body: "payload",
    });
    assertEquals(await res.text(), "payload");
  } finally {
    await server.close();
    await upstream.shutdown();
  }
});

Deno.test("master: passes upstream redirects through to the client", async () => {
  const port = getAvailablePort()!;
  const upstreamPort = getAvailablePort()!;
  const upstream = Deno.serve({
    port: upstreamPort,
    onListen: () => {},
    handler: (req) =>
      new URL(req.url).pathname === "/login"
        ? new Response(null, {
          status: 302,
          headers: { Location: "/dashboard", "Set-Cookie": "session=1" },
        })
        : new Response("dashboard"),
  });
  const server = createServer({ port });
  try {
    await server.registerHost("svc", {
      port: upstreamPort,
      keepHostname: false,
    });
    // The browser must see the redirect itself, or it loses the cookie set
    // alongside it and ends up on the wrong URL.
    const res = await fetch(`http://svc.localhost:${port}/login`, {
      redirect: "manual",
    });
    await res.body?.cancel();
    assertEquals(res.status, 302);
    assertEquals(res.headers.get("Location"), "/dashboard");
    assertEquals(res.headers.get("Set-Cookie"), "session=1");
  } finally {
    await server.close();
    await upstream.shutdown();
  }
});

Deno.test(
  "master: a redirect to the upstream's own address points back at the proxy",
  async () => {
    for (const keepHostname of [false, true]) {
      const port = getAvailablePort()!;
      const upstreamPort = getAvailablePort()!;
      const upstream = Deno.serve({
        port: upstreamPort,
        onListen: () => {},
        // Frameworks often build absolute redirects from the Host they see.
        handler: (req) =>
          Response.redirect(new URL("/dashboard?tab=1#top", req.url), 302),
      });
      const server = createServer({ port });
      try {
        await server.registerHost("svc", { port: upstreamPort, keepHostname });
        const res = await fetch(`http://svc.localhost:${port}/login`, {
          redirect: "manual",
        });
        await res.body?.cancel();
        assertEquals(
          res.headers.get("Location"),
          `http://svc.localhost:${port}/dashboard?tab=1#top`,
        );
      } finally {
        await server.close();
        await upstream.shutdown();
      }
    }
  },
);

Deno.test("master: a redirect to a foreign host is left untouched", async () => {
  const port = getAvailablePort()!;
  const upstreamPort = getAvailablePort()!;
  const upstream = Deno.serve({
    port: upstreamPort,
    onListen: () => {},
    handler: () => Response.redirect("https://auth.example/authorize", 302),
  });
  const server = createServer({ port });
  try {
    await server.registerHost("svc", {
      port: upstreamPort,
      keepHostname: false,
    });
    const res = await fetch(`http://svc.localhost:${port}/login`, {
      redirect: "manual",
    });
    await res.body?.cancel();
    assertEquals(res.headers.get("Location"), "https://auth.example/authorize");
  } finally {
    await server.close();
    await upstream.shutdown();
  }
});

/** Headers relevant to origin checks, as seen by an upstream behind the proxy. */
type SeenHeaders = {
  host: string | null;
  origin: string | null;
  forwardedHost: string | null;
  forwardedProto: string | null;
};

/**
 * Registers `svc` on a fresh master, POSTs to it through the proxy with the
 * given `Origin`, and returns the headers the upstream received.
 */
const proxyPost = async (
  keepHostname: boolean,
  origin: (proxyPort: number) => string,
): Promise<{ seen: SeenHeaders; port: number; upstreamPort: number }> => {
  const port = getAvailablePort()!;
  const upstreamPort = getAvailablePort()!;
  const upstream = Deno.serve({
    port: upstreamPort,
    onListen: () => {},
    handler: (req) =>
      Response.json({
        host: req.headers.get("Host"),
        origin: req.headers.get("Origin"),
        forwardedHost: req.headers.get("X-Forwarded-Host"),
        forwardedProto: req.headers.get("X-Forwarded-Proto"),
      }),
  });
  const server = createServer({ port });
  try {
    await server.registerHost("svc", { port: upstreamPort, keepHostname });
    const res = await fetch(`http://svc.localhost:${port}/approve`, {
      method: "POST",
      headers: { Origin: origin(port) },
      body: "{}",
    });
    return { seen: await res.json(), port, upstreamPort };
  } finally {
    await server.close();
    await upstream.shutdown();
  }
};

Deno.test(
  "master: a same-origin request keeps Host and Origin consistent",
  async () => {
    const { seen, port, upstreamPort } = await proxyPost(
      false,
      (port) => `http://svc.localhost:${port}`,
    );
    assertEquals(seen, {
      host: `localhost:${upstreamPort}`,
      origin: `http://localhost:${upstreamPort}`,
      forwardedHost: `svc.localhost:${port}`,
      forwardedProto: "http",
    });
  },
);

Deno.test(
  "master: --keep-hostname keeps Host and Origin consistent",
  async () => {
    const { seen, port, upstreamPort } = await proxyPost(
      true,
      (port) => `http://svc.localhost:${port}`,
    );
    assertEquals(seen, {
      host: `svc.localhost:${upstreamPort}`,
      origin: `http://svc.localhost:${upstreamPort}`,
      forwardedHost: `svc.localhost:${port}`,
      forwardedProto: "http",
    });
  },
);

Deno.test("master: a cross-site Origin is forwarded untouched", async () => {
  for (const keepHostname of [false, true]) {
    const { seen } = await proxyPost(keepHostname, () => "http://evil.test");
    assertEquals(seen.origin, "http://evil.test");
  }
});

/** The reason a WebSocket error event carries, for an assertion message. */
const errorMessage = (event: Event): string =>
  event instanceof ErrorEvent ? event.message : event.type;

/**
 * Registers `svc` on a fresh master, opens a WebSocket to it through the proxy
 * with the given `Origin`, and returns the headers the upstream's upgrade saw.
 */
const proxyWebsocket = async (
  keepHostname: boolean,
  origin: (proxyPort: number) => string,
): Promise<{ seen: SeenHeaders; port: number; upstreamPort: number }> => {
  const port = getAvailablePort()!;
  const upstreamPort = getAvailablePort()!;
  let seen: SeenHeaders | undefined;
  const upstream = Deno.serve({
    port: upstreamPort,
    onListen: () => {},
    handler: (req) => {
      seen = {
        host: req.headers.get("Host"),
        origin: req.headers.get("Origin"),
        forwardedHost: req.headers.get("X-Forwarded-Host"),
        forwardedProto: req.headers.get("X-Forwarded-Proto"),
      };
      const { socket, response } = Deno.upgradeWebSocket(req);
      socket.onerror = () => {};
      return response;
    },
  });
  const server = createServer({ port });
  try {
    await server.registerHost("svc", { port: upstreamPort, keepHostname });
    const ws = new WebSocket(`ws://svc.localhost:${port}/`, {
      headers: { Origin: origin(port) },
    });
    ws.onerror = () => {};
    await waitFor(() => seen !== undefined);
    ws.close();
    return { seen: seen!, port, upstreamPort };
  } finally {
    await server.close();
    await upstream.shutdown();
  }
};

Deno.test(
  "websocket: a same-origin upgrade keeps Host and Origin consistent",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    for (const keepHostname of [false, true]) {
      const { seen, port, upstreamPort } = await proxyWebsocket(
        keepHostname,
        (port) => `http://svc.localhost:${port}`,
      );
      const upstreamHost = `${
        keepHostname ? "svc.localhost" : "localhost"
      }:${upstreamPort}`;
      assertEquals(seen, {
        host: upstreamHost,
        origin: `http://${upstreamHost}`,
        forwardedHost: `svc.localhost:${port}`,
        forwardedProto: "http",
      });
    }
  },
);

Deno.test(
  "websocket: a cross-site Origin is forwarded untouched",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const { seen } = await proxyWebsocket(false, () => "http://evil.test");
    assertEquals(seen.origin, "http://evil.test");
  },
);

Deno.test(
  "websocket: the subprotocol the upstream selects reaches the client",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const port = getAvailablePort()!;
    const upstreamPort = getAvailablePort()!;
    let requested: string | null = null;
    const upstream = Deno.serve({
      port: upstreamPort,
      onListen: () => {},
      handler: (req) => {
        requested = req.headers.get("Sec-WebSocket-Protocol");
        const { socket, response } = Deno.upgradeWebSocket(req, {
          protocol: "vite-hmr",
        });
        socket.onerror = () => {};
        return response;
      },
    });
    const server = createServer({ port });
    try {
      await server.registerHost("svc", {
        port: upstreamPort,
        keepHostname: false,
      });
      // Vite's HMR client asks for `vite-hmr`; a browser fails the socket when
      // the handshake answers without the subprotocol it asked for.
      const protocol = await new Promise<string>((resolve, reject) => {
        const ws = new WebSocket(`ws://svc.localhost:${port}/`, "vite-hmr");
        ws.onopen = () => {
          resolve(ws.protocol);
          ws.close();
        };
        ws.onerror = (e) => reject(new Error(errorMessage(e)));
      });
      assertEquals(requested, "vite-hmr");
      assertEquals(protocol, "vite-hmr");
    } finally {
      await server.close();
      await upstream.shutdown();
    }
  },
);

/** A non-loopback IPv4 address of this machine, if it has one. */
const lanAddress = Deno.networkInterfaces().find((iface) =>
  iface.family === "IPv4" && !iface.address.startsWith("127.")
)?.address;

Deno.test({
  name: "master: rejects requests from non-loopback peers",
  // Needs a second interface to connect from; CI runners and laptops have one.
  ignore: !lanAddress,
  fn: async () => {
    const port = getAvailablePort()!;
    const server = createServer({ port });
    try {
      // The Host header is client-controlled, so it must not grant access.
      // `fetch` overrides Host, hence the hand-written request.
      for (const host of ["localhost", "svc.localhost"]) {
        const conn = await Deno.connect({ hostname: lanAddress, port });
        await conn.write(
          new TextEncoder().encode(
            `GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`,
          ),
        );
        const buf = new Uint8Array(1024);
        const n = await conn.read(buf);
        conn.close();
        const statusLine = new TextDecoder().decode(buf.subarray(0, n ?? 0))
          .split("\r\n")[0];
        assertEquals(statusLine, "HTTP/1.1 403 Forbidden");
      }
    } finally {
      await server.close();
    }
  },
});

Deno.test("master: unknown proxy host returns 404", async () => {
  const port = getAvailablePort()!;
  const server = createServer({ port });
  try {
    const res = await fetch(`http://ghost.localhost:${port}/`);
    assertEquals(res.status, 404);
    await res.body?.cancel();
  } finally {
    await server.close();
  }
});

Deno.test("client: registers with the master over HTTP", async () => {
  const port = getAvailablePort()!;
  const master = createServer({ port });
  const client = createServer({ port });
  try {
    assertEquals(master.isMaster(), true);
    assertEquals(client.isMaster(), false);

    await client.registerHost("web", { port: 5001, keepHostname: false });
    assertEquals(await listHosts(port), {
      web: { port: 5001, keepHostname: false },
    });
  } finally {
    await client.close();
    await master.close();
  }
});

Deno.test(
  "websocket: an unreachable upstream is reported as a concise error",
  // WebSocket teardown leaves background ops/connections in flight.
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const port = getAvailablePort()!;
    const upstreamPort = getAvailablePort()!;
    // The upstream answers 200 instead of upgrading, so the proxy's upstream
    // socket fails before it ever opens — a genuine misconfiguration.
    const upstream = Deno.serve({
      port: upstreamPort,
      onListen: () => {},
      handler: () => new Response(null, { status: 200 }),
    });
    const server = createServer({ port });

    const errors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    try {
      await server.registerHost("svc", {
        port: upstreamPort,
        keepHostname: false,
      });
      await new Promise<void>((resolve) => {
        const ws = new WebSocket(`ws://svc.localhost:${port}/`);
        ws.onerror = () => {};
        ws.onclose = () => resolve();
        setTimeout(resolve, 3000);
      });
      // Let the upstream error and close settle.
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      console.error = originalError;
      await server.close();
      await upstream.shutdown();
    }

    const upstreamErrors = errors.filter((args) =>
      String(args[0]).toLowerCase().includes("upstream"),
    );
    assertEquals(upstreamErrors.length, 1);
    // Concise: a reason string, not a dumped ErrorEvent object.
    assertEquals(typeof upstreamErrors[0][1], "string");
  },
);

Deno.test(
  "websocket: a client that drops abruptly is not logged as an error",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const port = getAvailablePort()!;
    const upstreamPort = getAvailablePort()!;
    const upstream = Deno.serve({
      port: upstreamPort,
      onListen: () => {},
      handler: (req) => {
        if (req.headers.get("upgrade") === "websocket") {
          const { socket, response } = Deno.upgradeWebSocket(req);
          socket.onmessage = (e) => socket.send(e.data);
          return response;
        }
        return new Response("no ws");
      },
    });
    const server = createServer({ port });

    const errors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    try {
      await server.registerHost("svc", {
        port: upstreamPort,
        keepHostname: false,
      });

      // Perform the WebSocket handshake by hand, then drop the TCP connection
      // without a close frame — exactly how a navigating browser vanishes.
      const conn = await Deno.connect({ hostname: "127.0.0.1", port });
      const key = btoa(
        String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))),
      );
      const handshake =
        `GET /?token=abc HTTP/1.1\r\n` +
        `Host: svc.localhost:${port}\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\n` +
        `Sec-WebSocket-Version: 13\r\n\r\n`;
      await conn.write(new TextEncoder().encode(handshake));
      await conn.read(new Uint8Array(1024)); // consume the 101 response
      conn.close(); // abrupt drop, no close frame

      // Give the proxy time to observe the EOF.
      await new Promise((r) => setTimeout(r, 300));
    } finally {
      console.error = originalError;
      await server.close();
      await upstream.shutdown();
    }

    const clientErrors = errors.filter((args) =>
      String(args[0]).toLowerCase().includes("client"),
    );
    assertEquals(clientErrors.length, 0);
  },
);

Deno.test(
  "failover: a client is promoted and the table is rebuilt when the master exits",
  // The failover path involves background watch loops and long-poll
  // connections whose teardown races with the test's own completion.
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const port = getAvailablePort()!;
    const master = createServer({ port });
    const clientB = createServer({ port });
    const clientC = createServer({ port });
    const clients = [clientB, clientC];

    try {
      await clientB.registerHost("b", { port: 6001, keepHostname: false });
      await clientC.registerHost("c", { port: 6002, keepHostname: false });

      // The master sees both clients' hosts.
      assertEquals(await listHosts(port), {
        b: { port: 6001, keepHostname: false },
        c: { port: 6002, keepHostname: false },
      });

      // The master leaves; the surviving clients must re-elect one master.
      await master.close();
      await waitFor(() => clientB.isMaster() !== clientC.isMaster());

      // Exactly one client took over.
      assertEquals(Number(clientB.isMaster()) + Number(clientC.isMaster()), 1);

      // Both hosts were collectively re-registered onto the new master: the
      // winner seeds its own, the loser replays its own over HTTP.
      await waitFor(async () => {
        const hosts = await listHosts(port);
        return "b" in hosts && "c" in hosts;
      });
      assertEquals(await listHosts(port), {
        b: { port: 6001, keepHostname: false },
        c: { port: 6002, keepHostname: false },
      });
    } finally {
      for (const client of clients) await client.close();
    }
  },
);
