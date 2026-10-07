import {
  assertEquals,
  assertMatch,
  assertStringIncludes,
} from "@std/assert";
import { getAvailablePort } from "@std/net";

/** Echo service that reports the URL each request reached it with. */
const ECHO_SERVER = new URL("../fixtures/echo-server.ts", import.meta.url).href;

/**
 * Starts the real CLI, as `localman <args>`, with `LOCALMAN_PORT` set. Its
 * service gets a free `PORT` rather than whatever the calling shell exports.
 */
const spawnCli = (localmanPort: string, args: string[]) =>
  new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", new URL("./mod.ts", import.meta.url).href, ...args],
    env: { LOCALMAN_PORT: localmanPort, PORT: String(getAvailablePort()) },
    stdout: "piped",
    stderr: "piped",
  }).spawn();

/** Polls `url` until it answers 200, returning that response's body. */
const fetchWhenUp = async (url: string, timeout = 10_000): Promise<string> => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.text();
      await res.body?.cancel();
    } catch {
      // Master not listening yet.
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`${url} never came up`);
};

Deno.test("cli: serves its command on LOCALMAN_PORT", async () => {
  const port = getAvailablePort()!;
  const cli = spawnCli(String(port), [
    "svc",
    Deno.execPath(),
    "run",
    "-A",
    ECHO_SERVER,
  ]);
  try {
    // The echo service reports the URL the request reached it with.
    assertMatch(
      await fetchWhenUp(`http://svc.localhost:${port}/hi`),
      /^\{"url":"http:\/\/localhost:\d+\/hi"\}$/,
    );
  } finally {
    try {
      cli.kill("SIGTERM");
    } catch {
      // Already exited, e.g. having failed to start.
    }
    await cli.output();
  }
});

Deno.test("cli: an invalid LOCALMAN_PORT is refused", async () => {
  const { code, stderr } = await spawnCli("nope", ["svc", "true"]).output();
  assertEquals(code, 1);
  assertStringIncludes(new TextDecoder().decode(stderr), "LOCALMAN_PORT");
});

Deno.test("cli: exits with its command's exit code", async () => {
  const port = String(getAvailablePort()!);
  const failed = await spawnCli(port, ["svc", "sh", "-c", "exit 3"]).output();
  assertEquals(failed.code, 3);

  // A command killed by a signal reports 128 + its number, as shells do.
  const killed = await spawnCli(port, ["svc", "sh", "-c", "kill -TERM $$"])
    .output();
  assertEquals(killed.code, 143);
});

for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
  Deno.test(`cli: stopped by ${signal}, exits with ${code}`, async () => {
    const port = getAvailablePort()!;
    const cli = spawnCli(String(port), [
      "svc",
      Deno.execPath(),
      "run",
      "-A",
      ECHO_SERVER,
    ]);
    // Collected from the start, so it's there to await however the test ends.
    const output = cli.output();
    try {
      await fetchWhenUp(`http://svc.localhost:${port}/`);
      cli.kill(signal);
      // Scripts can tell an interrupted run from one that finished.
      assertEquals((await output).code, code);
    } finally {
      try {
        cli.kill("SIGKILL");
      } catch {
        // Already exited.
      }
      await output;
    }
  });
}

Deno.test(
  "cli: stopped by a signal, exits with its code even if the command dies first",
  async () => {
    const port = getAvailablePort()!;
    // A master that answers the first unregistration slowly. That one comes
    // from the signal's teardown; the command dying of it unregisters again.
    const leases = new Set<ReadableStreamDefaultController<Uint8Array>>();
    const headers = { "Localman-Protocol": "1" };
    let deletes = 0;
    const master = Deno.serve({
      port,
      onListen: () => {},
      handler: async (req) => {
        if (new URL(req.url).pathname === "/wait") {
          return new Response(
            new ReadableStream<Uint8Array>({ start: (c) => leases.add(c) }),
            { headers },
          );
        }
        if (req.method === "DELETE" && deletes++ === 0) {
          await new Promise((r) => setTimeout(r, 500));
        }
        return new Response(null, { status: 204, headers });
      },
    });
    // Signal handlers are in place once the command runs, which it marks. It
    // only runs once its host is registered.
    const started = await Deno.makeTempFile();
    await Deno.remove(started);
    const cli = spawnCli(String(port), [
      "svc",
      "sh",
      "-c",
      `touch ${started}; exec sleep 30`,
    ]);
    const output = cli.output();
    let exited = false;
    output.then(() => exited = true);
    try {
      const deadline = Date.now() + 10_000;
      while (!(await Deno.stat(started).then(() => true, () => false))) {
        if (exited || Date.now() > deadline) {
          throw new Error("The command never started");
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      cli.kill("SIGINT");
      assertEquals((await output).code, 130);
    } finally {
      try {
        cli.kill("SIGKILL");
      } catch {
        // Already exited.
      }
      await output;
      for (const lease of leases) {
        try {
          lease.close();
        } catch {
          // Already cancelled by the CLI going away.
        }
      }
      await master.shutdown();
      await Deno.remove(started).catch(() => {});
    }
  },
);

Deno.test("mod: the package is a CLI and exports no API", async () => {
  // Anything exported here would be covered by semver.
  assertEquals(Object.keys(await import("./mod.ts")), []);
});
