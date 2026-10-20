import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { getAvailablePort } from "@std/net";
import { createServer, exposeHost, lanUrls } from "./server.ts";

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
    // Links must reach the host on whichever port the master listens on.
    assertEquals(html.includes(`href="http://app.localhost:${port}/"`), true);
    // Where hosts are exposed is only shown once one is.
    assertEquals(html.includes("Exposed"), false);
  } finally {
    await server.close();
  }
});

Deno.test("master: root links exposed hosts where the network reaches them", async () => {
  const port = getAvailablePort()!;
  const server = createServer({ port });
  try {
    await server.registerHost("app", {
      port: 4002,
      keepHostname: false,
      exposed: { port: 61234, hostname: "mymac.local" },
    });
    await server.registerHost("api", { port: 4003, keepHostname: false });
    const res = await fetch(`http://localhost:${port}/`, {
      headers: { Accept: "text/html" },
    });
    const html = await res.text();
    assertStringIncludes(html, `href="http://mymac.local:61234/"`);
    if (lanAddress) {
      assertStringIncludes(html, `href="http://${lanAddress}:61234/"`);
    }
  } finally {
    await server.close();
  }
});

Deno.test("master: rejects invalid registrations", async () => {
  const port = getAvailablePort()!;
  const server = createServer({ port });
  const url = `http://localhost:${port}/hosts/app`;
  const instance = { "Localman-Instance": "test" };
  try {
    const wrongType = await fetch(url, {
      method: "POST",
      headers: instance,
      body: "{}",
    });
    assertEquals(wrongType.status, 400);
    await wrongType.body?.cancel();

    const badJson = await fetch(url, {
      method: "POST",
      headers: { ...instance, "Content-Type": "application/json" },
      body: "not json",
    });
    assertEquals(badJson.status, 400);
    await badJson.body?.cancel();

    const badShape = await fetch(url, {
      method: "POST",
      headers: { ...instance, "Content-Type": "application/json" },
      body: JSON.stringify({ port: "nope" }),
    });
    assertEquals(badShape.status, 400);
    await badShape.body?.cancel();

    // Every registration needs an owner whose lease can expire.
    const noInstance = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ port: 4003 }),
    });
    assertEquals(noInstance.status, 400);
    await noInstance.body?.cancel();

    const unleasedWait = await fetch(`http://localhost:${port}/wait`);
    assertEquals(unleasedWait.status, 400);
    await unleasedWait.body?.cancel();
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

/** Upstream echoing the `Host` and `X-Forwarded-Host` each request reached it with. */
const serveHostEcho = (port: number) =>
  Deno.serve({
    port,
    onListen: () => {},
    handler: (req) =>
      Response.json({
        host: req.headers.get("Host"),
        forwardedHost: req.headers.get("X-Forwarded-Host"),
      }),
  });

Deno.test({
  name: "expose: serves the host to peers on the local network",
  ignore: !lanAddress,
  fn: async () => {
    const upstreamPort = getAvailablePort()!;
    const upstream = serveHostEcho(upstreamPort);
    const exposed = exposeHost("svc", {
      port: upstreamPort,
      keepHostname: false,
    });
    try {
      const res = await fetch(`http://${lanAddress}:${exposed.port}/hi`);
      assertEquals(await res.json(), {
        host: `localhost:${upstreamPort}`,
        forwardedHost: `${lanAddress}:${exposed.port}`,
      });
    } finally {
      await exposed.close();
      await upstream.shutdown();
    }
  },
});

Deno.test("expose: --keep-hostname forwards <host>.localhost, not the address", async () => {
  const upstreamPort = getAvailablePort()!;
  const upstream = serveHostEcho(upstreamPort);
  const exposed = exposeHost("svc", { port: upstreamPort, keepHostname: true });
  try {
    // Forwarding to the address used would bypass a service bound to loopback.
    const res = await fetch(`http://127.0.0.1:${exposed.port}/`);
    assertEquals((await res.json()).host, `svc.localhost:${upstreamPort}`);
  } finally {
    await exposed.close();
    await upstream.shutdown();
  }
});

/**
 * The raw response `port` gives a GET for `path` addressed to `host`, sent
 * from this machine's `address`. `fetch` overrides Host, hence the
 * hand-written request.
 */
const rawGet = async (
  address: string,
  port: number,
  host: string,
  path = "/",
): Promise<string> => {
  const conn = await Deno.connect({ hostname: address, port });
  try {
    await conn.write(
      new TextEncoder().encode(
        `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`,
      ),
    );
    const decoder = new TextDecoder();
    const buf = new Uint8Array(4096);
    let response = "";
    for (let n; (n = await conn.read(buf)) !== null;) {
      response += decoder.decode(buf.subarray(0, n), { stream: true });
    }
    return response;
  } finally {
    conn.close();
  }
};

/** The status line `port` on this machine answers a request for `host` with. */
const statusLineFor = async (port: number, host: string) =>
  (await rawGet("127.0.0.1", port, host)).split("\r\n")[0];

Deno.test("expose: refuses names, as a rebound DNS name could read the service", async () => {
  const upstreamPort = getAvailablePort()!;
  const upstream = serveHostEcho(upstreamPort);
  const exposed = exposeHost("svc", {
    port: upstreamPort,
    keepHostname: false,
  });
  try {
    for (
      const host of [
        "attacker.example",
        "localhost",
        "1.2.3.4.attacker.example",
      ]
    ) {
      assertEquals(
        await statusLineFor(exposed.port, `${host}:${exposed.port}`),
        "HTTP/1.1 403 Forbidden",
      );
    }
    for (const host of ["192.168.1.5", "[fe80::1]"]) {
      assertEquals(
        await statusLineFor(exposed.port, `${host}:${exposed.port}`),
        "HTTP/1.1 200 OK",
      );
    }
  } finally {
    await exposed.close();
    await upstream.shutdown();
  }
});

Deno.test("expose: serves the one name it allows", async () => {
  const upstreamPort = getAvailablePort()!;
  const upstream = serveHostEcho(upstreamPort);
  const exposed = exposeHost(
    "svc",
    { port: upstreamPort, keepHostname: false },
    "mymac.local",
  );
  try {
    for (const host of ["mymac.local", "MyMac.Local."]) {
      assertEquals(
        await statusLineFor(exposed.port, `${host}:${exposed.port}`),
        "HTTP/1.1 200 OK",
      );
    }
    assertEquals(
      await statusLineFor(exposed.port, `attacker.example:${exposed.port}`),
      "HTTP/1.1 403 Forbidden",
    );
  } finally {
    await exposed.close();
    await upstream.shutdown();
  }
});

Deno.test("expose: close stops serving", async () => {
  const exposed = exposeHost("svc", { port: 1, keepHostname: false });
  await exposed.close();
  await assertRejects(() => fetch(`http://127.0.0.1:${exposed.port}/`));
});

Deno.test({
  name:
    "master: lists exposed hosts to other devices, at the address they used",
  ignore: !lanAddress,
  fn: async () => {
    const port = getAvailablePort()!;
    const server = createServer({ port });
    try {
      await server.registerHost("web", {
        port: 5001,
        keepHostname: false,
        exposed: { port: 61234, hostname: "mymac.local" },
      });
      await server.registerHost("app", {
        port: 5002,
        keepHostname: false,
        exposed: { port: 61235 },
      });
      await server.registerHost("api", { port: 5003, keepHostname: false });

      const byAddress = await rawGet(
        lanAddress!,
        port,
        `${lanAddress}:${port}`,
      );
      assertEquals(byAddress.split("\r\n")[0], "HTTP/1.1 200 OK");
      assertStringIncludes(byAddress, `href="http://${lanAddress}:61234/"`);
      assertStringIncludes(byAddress, `href="http://${lanAddress}:61235/"`);
      // Hosts that aren't exposed stay private to this machine.
      assertEquals(byAddress.includes(">api<"), false);

      // A name reaches the listing only of the hosts that allow it.
      const byName = await rawGet(lanAddress!, port, `mymac.local:${port}`);
      assertEquals(byName.split("\r\n")[0], "HTTP/1.1 200 OK");
      assertStringIncludes(byName, `href="http://mymac.local:61234/"`);
      assertEquals(byName.includes(">app<"), false);
    } finally {
      await server.close();
    }
  },
});

Deno.test({
  name: "master: other devices get nothing but the listing of exposed hosts",
  ignore: !lanAddress,
  fn: async () => {
    const port = getAvailablePort()!;
    const server = createServer({ port });
    const statusFromLan = async (host: string, path = "/") =>
      (await rawGet(lanAddress!, port, host, path)).split("\r\n")[0];
    try {
      await server.registerHost("web", { port: 5001, keepHostname: false });
      assertEquals(
        await statusFromLan(`${lanAddress}:${port}`),
        "HTTP/1.1 403 Forbidden",
      );

      await server.registerHost("web", {
        port: 5001,
        keepHostname: false,
        exposed: { port: 61234, hostname: "mymac.local" },
      });
      const refused = [
        [`${lanAddress}:${port}`, "/hosts/web"],
        [`${lanAddress}:${port}`, "/wait"],
        [`localhost:${port}`, "/"],
        [`web.localhost:${port}`, "/"],
        // A rebound name could read the listing as its own origin.
        [`attacker.example:${port}`, "/"],
      ];
      for (const [host, path] of refused) {
        assertEquals(
          await statusFromLan(host, path),
          "HTTP/1.1 403 Forbidden",
          host + path,
        );
      }
    } finally {
      await server.close();
    }
  },
});

Deno.test("lanUrls: one URL per IPv4 network address", () => {
  /** An interface entry with only the fields that matter here. */
  const iface = (
    family: "IPv4" | "IPv6",
    address: string,
  ): Deno.NetworkInterfaceInfo => ({
    family,
    address,
    name: "en0",
    netmask: "",
    scopeid: null,
    cidr: "",
    mac: "",
  });
  assertEquals(
    lanUrls([
      iface("IPv4", "127.0.0.1"),
      iface("IPv6", "::1"),
      iface("IPv4", "192.168.1.5"),
      // IPv6 addresses on a LAN are commonly link-local, unusable in a URL.
      iface("IPv6", "fe80::1"),
      iface("IPv4", "10.0.0.2"),
    ], 61234),
    ["http://192.168.1.5:61234/", "http://10.0.0.2:61234/"],
  );
  assertEquals(
    lanUrls([iface("IPv4", "192.168.1.5")], 61234, "mymac.local"),
    ["http://mymac.local:61234/", "http://192.168.1.5:61234/"],
  );
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

/** Whether `promise` settles within `ms` milliseconds. */
const settlesWithin = async (
  promise: Promise<unknown>,
  ms: number,
): Promise<boolean> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([promise.then(() => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * An upstream that answers with an event stream which never ends on its own.
 * `close()` ends the streams and the server, so a test that fails while one is
 * open still tears down instead of hanging.
 */
const serveEndlessStream = (port: number) => {
  const cancelled = Promise.withResolvers<void>();
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const server = Deno.serve({
    port,
    onListen: () => {},
    handler: () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start: (c) => {
            streams.add(c);
            c.enqueue(new TextEncoder().encode("data: hi\n\n"));
          },
          cancel: () => cancelled.resolve(),
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      ),
  });
  const close = async () => {
    for (const c of streams) {
      try {
        c.close();
      } catch {
        // Already cancelled.
      }
    }
    await server.shutdown();
  };
  return { close, cancelled: cancelled.promise };
};

Deno.test(
  "master: close() doesn't wait for open proxied streams",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const port = getAvailablePort()!;
    const upstreamPort = getAvailablePort()!;
    const upstream = serveEndlessStream(upstreamPort);
    const server = createServer({ port });
    try {
      await server.registerHost("svc", {
        port: upstreamPort,
        keepHostname: false,
      });
      const res = await fetch(`http://svc.localhost:${port}/events`);
      const reader = res.body!.getReader();
      await reader.read();

      // A browser tab holding e.g. an event stream must not block shutdown.
      assertEquals(await settlesWithin(server.close(), 2000), true);
      await reader.cancel().catch(() => {});
    } finally {
      await upstream.close();
    }
  },
);

Deno.test(
  "master: close() doesn't wait for open proxied websockets",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const port = getAvailablePort()!;
    const upstreamPort = getAvailablePort()!;
    const upstream = Deno.serve({
      port: upstreamPort,
      onListen: () => {},
      handler: (req) => {
        const { socket, response } = Deno.upgradeWebSocket(req);
        socket.onerror = () => {};
        return response;
      },
    });
    const server = createServer({ port });
    let ws: WebSocket | undefined;
    try {
      await server.registerHost("svc", {
        port: upstreamPort,
        keepHostname: false,
      });
      ws = new WebSocket(`ws://svc.localhost:${port}/`);
      ws.onerror = () => {};
      await new Promise((resolve) => ws!.onopen = resolve);

      assertEquals(await settlesWithin(server.close(), 2000), true);
    } finally {
      ws?.close();
      await upstream.shutdown();
    }
  },
);

Deno.test(
  "master: a client disconnect cancels the upstream request",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const port = getAvailablePort()!;
    const upstreamPort = getAvailablePort()!;
    const upstream = serveEndlessStream(upstreamPort);
    const server = createServer({ port });
    try {
      await server.registerHost("svc", {
        port: upstreamPort,
        keepHostname: false,
      });
      const res = await fetch(`http://svc.localhost:${port}/events`);
      const reader = res.body!.getReader();
      await reader.read();
      await reader.cancel();

      assertEquals(await settlesWithin(upstream.cancelled, 2000), true);
    } finally {
      await server.close();
      await upstream.close();
    }
  },
);

Deno.test(
  "master: an upstream failing mid-response fails the client's response",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const port = getAvailablePort()!;
    const upstreamPort = getAvailablePort()!;
    const upstream = Deno.serve({
      port: upstreamPort,
      onListen: () => {},
      onError: () => new Response(null, { status: 500 }),
      handler: () =>
        new Response(
          new ReadableStream({
            start: (c) => {
              c.enqueue(new TextEncoder().encode("partial"));
              setTimeout(() => c.error(new Error("upstream broke")), 50);
            },
          }),
        ),
    });
    const server = createServer({ port });
    // The upstream's own failure gets logged; keep it out of the output.
    const originalError = console.error;
    console.error = () => {};
    try {
      await server.registerHost("svc", {
        port: upstreamPort,
        keepHostname: false,
      });
      const res = await fetch(`http://svc.localhost:${port}/`);
      // A cut-off body must not pass for a complete one.
      await assertRejects(() => res.text());
    } finally {
      console.error = originalError;
      await server.close();
      await upstream.shutdown();
    }
  },
);

Deno.test(
  "master: close() answers requests awaiting the upstream with 503",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const port = getAvailablePort()!;
    const upstreamPort = getAvailablePort()!;
    const received = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    // Holds its response back, like a long-poll waiting for an event.
    const upstream = Deno.serve({
      port: upstreamPort,
      onListen: () => {},
      handler: async () => {
        received.resolve();
        await release.promise;
        return new Response("late");
      },
    });
    const server = createServer({ port });
    try {
      await server.registerHost("svc", {
        port: upstreamPort,
        keepHostname: false,
      });
      const pending = fetch(`http://svc.localhost:${port}/poll`);
      await received.promise;

      assertEquals(await settlesWithin(server.close(), 2000), true);
      const res = await pending;
      await res.body?.cancel();
      // The upstream is fine; it's localman that is going away.
      assertEquals(res.status, 503);
    } finally {
      release.resolve();
      await upstream.shutdown();
    }
  },
);

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
  "client: hosts of a client that went away without unregistering are freed",
  async () => {
    const port = getAvailablePort()!;
    const master = createServer({ port });
    const crashed = createServer({ port });
    try {
      await crashed.registerHost("web", { port: 5001, keepHostname: false });
      // Closing without unregistering drops the lease, as SIGHUP or a crash would.
      await crashed.close();
      await waitFor(async () => !("web" in await listHosts(port)));

      const restarted = createServer({ port });
      try {
        await restarted.registerHost("web", {
          port: 5002,
          keepHostname: false,
        });
        assertEquals(await listHosts(port), {
          web: { port: 5002, keepHostname: false },
        });
      } finally {
        await restarted.close();
      }
    } finally {
      await master.close();
    }
  },
);

Deno.test("client: registering an owned host again updates it", async () => {
  const port = getAvailablePort()!;
  const master = createServer({ port });
  const client = createServer({ port });
  try {
    await client.registerHost("web", { port: 5001, keepHostname: false });
    await client.registerHost("web", { port: 5002, keepHostname: true });
    assertEquals(await listHosts(port), {
      web: { port: 5002, keepHostname: true },
    });
  } finally {
    await client.close();
    await master.close();
  }
});

Deno.test("client: registers where its host is exposed", async () => {
  const port = getAvailablePort()!;
  const master = createServer({ port });
  const client = createServer({ port });
  try {
    await client.registerHost("web", {
      port: 5001,
      keepHostname: false,
      exposed: { port: 61234, hostname: "mymac.local" },
    });
    await client.registerHost("api", {
      port: 5002,
      keepHostname: false,
      exposed: { port: 61235 },
    });
    assertEquals(await listHosts(port), {
      web: {
        port: 5001,
        keepHostname: false,
        exposed: { port: 61234, hostname: "mymac.local" },
      },
      api: { port: 5002, keepHostname: false, exposed: { port: 61235 } },
    });
  } finally {
    await client.close();
    await master.close();
  }
});

Deno.test("client: a host owned by a live client can't be taken", async () => {
  const port = getAvailablePort()!;
  const master = createServer({ port });
  const owner = createServer({ port });
  const other = createServer({ port });
  try {
    await owner.registerHost("web", { port: 5001, keepHostname: false });
    await assertRejects(() =>
      other.registerHost("web", { port: 5002, keepHostname: false })
    );

    // Nor removed by anyone but its owner.
    await other.unregisterHost("web");
    assertEquals(await listHosts(port), {
      web: { port: 5001, keepHostname: false },
    });
  } finally {
    await other.close();
    await owner.close();
    await master.close();
  }
});

Deno.test("master: only canonical host names and real ports register", async () => {
  const port = getAvailablePort()!;
  const server = createServer({ port });
  const register = (host: string, body: unknown) =>
    fetch(`http://localhost:${port}/hosts/${host}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Localman-Instance": "test",
      },
      body: JSON.stringify(body),
    });
  try {
    // Browsers lowercase hostnames, so anything else could never be reached.
    const badHosts = [
      "API",
      "-api",
      "api-",
      "api_v2",
      "a..b",
      ".api",
      "a".repeat(64),
      `${"a".repeat(60)}.`.repeat(4) + "a",
      "api%20v2",
    ];
    for (const host of badHosts) {
      const res = await register(host, { port: 5001 });
      await res.body?.cancel();
      assertEquals(res.status, 400, host);
    }
    for (const badPort of [0, 65536, 1.5, -1]) {
      const res = await register("api", { port: badPort });
      await res.body?.cancel();
      assertEquals(res.status, 400, String(badPort));
    }

    const dotted = await register("api.v2", { port: 5001 });
    assertEquals(dotted.status, 204);
    assertEquals(await listHosts(port), {
      "api.v2": { port: 5001, keepHostname: false },
    });
  } finally {
    await server.close();
  }
});

Deno.test("master: only a real port and host name expose a host", async () => {
  const port = getAvailablePort()!;
  const server = createServer({ port });
  try {
    const badExposures = [
      null,
      "yes",
      { port: 0 },
      { port: 65536 },
      { port: "61234" },
      { port: 61234, hostname: "My_Mac" },
      { port: 61234, hostname: 5 },
    ];
    for (const exposed of badExposures) {
      const res = await fetch(`http://localhost:${port}/hosts/api`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Localman-Instance": "test",
        },
        body: JSON.stringify({ port: 5001, exposed }),
      });
      await res.body?.cancel();
      assertEquals(res.status, 400, JSON.stringify(exposed));
    }
    await assertRejects(
      () =>
        server.registerHost("api", {
          port: 5001,
          keepHostname: false,
          exposed: { port: 61234, hostname: "my_mac" },
        }),
      Error,
      "Invalid",
    );
    assertEquals(await listHosts(port), {});
  } finally {
    await server.close();
  }
});

Deno.test("master: a service can't take the proxy's own port", async () => {
  const port = getAvailablePort()!;
  const master = createServer({ port });
  const client = createServer({ port });
  try {
    // Forwarding there would loop requests back into the proxy.
    const res = await fetch(`http://localhost:${port}/hosts/svc`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Localman-Instance": "test",
      },
      body: JSON.stringify({ port }),
    });
    await res.body?.cancel();
    assertEquals(res.status, 400);

    for (const instance of [master, client]) {
      await assertRejects(
        () => instance.registerHost("svc", { port, keepHostname: false }),
        Error,
        "own port",
      );
    }

    // The Host header is the client's to choose; one without a port must not
    // pass for a master on port 80.
    const body = JSON.stringify({ port });
    const conn = await Deno.connect({ hostname: "127.0.0.1", port });
    await conn.write(
      new TextEncoder().encode(
        `POST /hosts/svc HTTP/1.1\r\n` +
          `Host: localhost\r\n` +
          `Content-Type: application/json\r\n` +
          `Localman-Instance: test\r\n` +
          `Content-Length: ${body.length}\r\n` +
          `Connection: close\r\n\r\n${body}`,
      ),
    );
    const buf = new Uint8Array(1024);
    const n = await conn.read(buf);
    conn.close();
    assertEquals(
      new TextDecoder().decode(buf.subarray(0, n ?? 0)).split("\r\n")[0],
      "HTTP/1.1 400 Bad Request",
    );
  } finally {
    await client.close();
    await master.close();
  }
});

Deno.test("master: its own registrations follow the same rules", async () => {
  const port = getAvailablePort()!;
  const master = createServer({ port });
  const client = createServer({ port });
  try {
    await assertRejects(() =>
      master.registerHost("API", { port: 5001, keepHostname: false })
    );
    await assertRejects(() =>
      master.registerHost("api", { port: 0, keepHostname: false })
    );

    // Nor may the master take, or remove, another instance's host.
    await client.registerHost("web", { port: 5001, keepHostname: false });
    await assertRejects(
      () => master.registerHost("web", { port: 5002, keepHostname: false }),
      Error,
      "Host is already bound",
    );
    await master.unregisterHost("web");
    assertEquals(await listHosts(port), {
      web: { port: 5001, keepHostname: false },
    });
  } finally {
    await client.close();
    await master.close();
  }
});

Deno.test("master: a host held by another instance is a conflict", async () => {
  const port = getAvailablePort()!;
  const server = createServer({ port });
  const register = (instance: string) =>
    fetch(`http://localhost:${port}/hosts/web`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Localman-Instance": instance,
      },
      body: JSON.stringify({ port: 5001 }),
    });
  try {
    await (await register("a")).body?.cancel();
    const res = await register("b");
    assertEquals(res.status, 409);
    assertEquals(await res.json(), { message: "Host is already bound" });
  } finally {
    await server.close();
  }
});

/**
 * Occupies `port` with a stand-in master that answers every registration with
 * `status`, counting attempts, and announces `protocol` (none if undefined).
 * Its `/wait` grants a lease that lasts until `close()`.
 */
const serveStubMaster = (
  port: number,
  { status, protocol }: { status: number; protocol?: string },
) => {
  const headers: HeadersInit = protocol
    ? { "Localman-Protocol": protocol }
    : {};
  const leases = new Set<ReadableStreamDefaultController<Uint8Array>>();
  let attempts = 0;
  const server = Deno.serve({
    port,
    onListen: () => {},
    handler: (req) => {
      if (new URL(req.url).pathname === "/wait") {
        return new Response(
          new ReadableStream<Uint8Array>({ start: (c) => leases.add(c) }),
          { headers },
        );
      }
      attempts++;
      return new Response(null, { status, headers });
    },
  });
  return {
    attempts: () => attempts,
    close: async () => {
      for (const lease of leases) lease.close();
      await server.shutdown();
    },
  };
};

Deno.test(
  "client: a refused registration fails without retrying",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const port = getAvailablePort()!;
    const stub = serveStubMaster(port, { status: 409, protocol: "1" });
    const client = createServer({ port });
    try {
      await assertRejects(() =>
        client.registerHost("web", { port: 5001, keepHostname: false })
      );
      // Asking again can't change the master's answer.
      assertEquals(stub.attempts(), 1);
    } finally {
      await client.close();
      await stub.close();
    }
  },
);

Deno.test(
  "client: a failing master is retried",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const port = getAvailablePort()!;
    const stub = serveStubMaster(port, { status: 503, protocol: "1" });
    const client = createServer({ port });
    try {
      await assertRejects(() =>
        client.registerHost("web", { port: 5001, keepHostname: false })
      );
      assertEquals(stub.attempts(), 5);
    } finally {
      await client.close();
      await stub.close();
    }
  },
);

Deno.test("master: protocol responses announce the protocol version", async () => {
  const port = getAvailablePort()!;
  const server = createServer({ port });
  try {
    const listing = await fetch(`http://localhost:${port}/`);
    await listing.body?.cancel();
    assertEquals(listing.headers.get("Localman-Protocol"), "1");

    // Refusals too, so an instance can tell them from a foreign server's.
    const refused = await fetch(`http://localhost:${port}/hosts/web`, {
      method: "POST",
    });
    await refused.body?.cancel();
    assertEquals(refused.status, 400);
    assertEquals(refused.headers.get("Localman-Protocol"), "1");
  } finally {
    await server.close();
  }
});

Deno.test(
  "client: a port held by another program is refused before registering",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const port = getAvailablePort()!;
    const stub = serveStubMaster(port, { status: 204 });
    const client = createServer({ port });
    try {
      await assertRejects(
        () => client.registerHost("web", { port: 5001, keepHostname: false }),
        Error,
        `Port ${port} is in use by another program`,
      );
      // Nothing was left behind on a server that wouldn't release it.
      assertEquals(stub.attempts(), 0);
    } finally {
      await client.close();
      await stub.close();
    }
  },
);

Deno.test(
  "client: a master speaking another protocol is refused before registering",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const port = getAvailablePort()!;
    const stub = serveStubMaster(port, { status: 204, protocol: "2" });
    const client = createServer({ port });
    try {
      await assertRejects(
        () => client.registerHost("web", { port: 5001, keepHostname: false }),
        Error,
        "protocol 2",
      );
      assertEquals(stub.attempts(), 0);
    } finally {
      await client.close();
      await stub.close();
    }
  },
);

Deno.test(
  "client: an incompatible master found while watching is reported",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const port = getAvailablePort()!;
    const stub = serveStubMaster(port, { status: 204 });
    const reported = Promise.withResolvers<Error>();
    // E.g. another program grabbed the port after the previous master exited.
    const client = createServer({
      port,
      onIncompatibleMaster: reported.resolve,
    });
    try {
      assertEquals(await settlesWithin(reported.promise, 2000), true);
    } finally {
      await client.close();
      await stub.close();
    }
  },
);

Deno.test(
  "client: backs off while the port's holder doesn't answer",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const port = getAvailablePort()!;
    // Holds the port but hangs up on every connection, like a master that is
    // halfway through shutting down.
    const listener = Deno.listen({ port });
    let connections = 0;
    const accepting = (async () => {
      for await (const conn of listener) {
        connections++;
        conn.close();
      }
    })();
    const client = createServer({ port });
    try {
      await new Promise((r) => setTimeout(r, 500));
      // Without a pause between attempts this runs into the thousands.
      assertEquals(connections < 50, true, `${connections} connections`);
    } finally {
      await client.close();
      listener.close();
      await accepting.catch(() => {});
    }
  },
);

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
      String(args[0]).toLowerCase().includes("upstream")
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
      const handshake = `GET /?token=abc HTTP/1.1\r\n` +
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
      String(args[0]).toLowerCase().includes("client")
    );
    assertEquals(clientErrors.length, 0);
  },
);

/**
 * Ways a browser ends a socket, as raw frames to send after the handshake, or
 * `null` to drop the connection without a close frame.
 */
const browserCloses: [string, Uint8Array | null][] = [
  // Masked close frames; 0x03e9 = 1001 (going away, e.g. navigating away).
  ["1001 going away", new Uint8Array([0x88, 0x82, 0, 0, 0, 0, 0x03, 0xe9])],
  ["no status code (1005)", new Uint8Array([0x88, 0x80, 0, 0, 0, 0])],
  ["abrupt drop (1006)", null],
];

for (const [name, frame] of browserCloses) {
  Deno.test(
    `websocket: a browser closing with ${name} closes the upstream`,
    { sanitizeResources: false, sanitizeOps: false },
    async () => {
      const port = getAvailablePort()!;
      const upstreamPort = getAvailablePort()!;
      const upstreamClosed = Promise.withResolvers<void>();
      const upstream = Deno.serve({
        port: upstreamPort,
        onListen: () => {},
        handler: (req) => {
          const { socket, response } = Deno.upgradeWebSocket(req);
          socket.onerror = () => {};
          socket.onclose = () => upstreamClosed.resolve();
          return response;
        },
      });
      const server = createServer({ port });
      try {
        await server.registerHost("svc", {
          port: upstreamPort,
          keepHostname: false,
        });
        // By hand, since the WebSocket API can't send these codes or vanish.
        const conn = await Deno.connect({ hostname: "127.0.0.1", port });
        await conn.write(
          new TextEncoder().encode(
            `GET / HTTP/1.1\r\n` +
              `Host: svc.localhost:${port}\r\n` +
              `Upgrade: websocket\r\n` +
              `Connection: Upgrade\r\n` +
              `Sec-WebSocket-Key: ${btoa("0123456789abcdef")}\r\n` +
              `Sec-WebSocket-Version: 13\r\n\r\n`,
          ),
        );
        await conn.read(new Uint8Array(1024)); // consume the 101 response
        if (frame) await conn.write(frame);
        else conn.close();

        // Otherwise the dev server keeps a dead socket per page navigation.
        assertEquals(await settlesWithin(upstreamClosed.promise, 2000), true);
        if (frame) conn.close();
      } finally {
        await server.close();
        await upstream.shutdown();
      }
    },
  );
}

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
