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

Deno.test("master: forwards proxied requests to the registered port", async () => {
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
      assertEquals(
        Number(clientB.isMaster()) + Number(clientC.isMaster()),
        1,
      );

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
