import {
  assertEquals,
  assertMatch,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { getAvailablePort } from "@std/net";
import { parseArgs, parseLocalmanPort } from "./mod.ts";

Deno.test("parseArgs: host, command and command args", () => {
  assertEquals(parseArgs(["app", "deno", "run", "-A", "x.ts"]), {
    host: "app",
    keepHostname: false,
    verbose: false,
    command: "deno",
    args: ["run", "-A", "x.ts"],
  });
});

Deno.test("parseArgs: flags before the host are consumed", () => {
  const parsed = parseArgs(["--keep-hostname", "-v", "app", "server"]);
  assertEquals(parsed.keepHostname, true);
  assertEquals(parsed.verbose, true);
  assertEquals(parsed.host, "app");
  assertEquals(parsed.command, "server");
});

Deno.test("parseArgs: normalizes the host as a browser would address it", () => {
  assertEquals(parseArgs(["API", "server"]).host, "api");
  assertEquals(parseArgs(["api.localhost", "server"]).host, "api");
  assertEquals(parseArgs(["Api.V2.LOCALHOST", "server"]).host, "api.v2");
  // Left for registration to reject, rather than taking the command as host.
  const empty = parseArgs([".localhost", "server"]);
  assertEquals([empty.host, empty.command], ["", "server"]);
});

Deno.test("parseLocalmanPort: defaults to 80 when unset or empty", () => {
  assertEquals(parseLocalmanPort(undefined), 80);
  // Scripts commonly clear a variable by setting it empty.
  assertEquals(parseLocalmanPort(""), 80);
});

Deno.test("parseLocalmanPort: accepts a port", () => {
  assertEquals(parseLocalmanPort("8080"), 8080);
});

Deno.test("parseLocalmanPort: refuses anything else", () => {
  // Only plain digits, though Number() would take hex, exponents and spaces.
  for (const value of ["nope", "0", "65536", "80.5", "0x1F90", "8e3", " 80 "]) {
    assertThrows(() => parseLocalmanPort(value), Error, "LOCALMAN_PORT");
  }
});

Deno.test("parseArgs: --verbose alias", () => {
  assertEquals(parseArgs(["--verbose", "app", "server"]).verbose, true);
});

Deno.test("parseArgs: flags after the host belong to the command", () => {
  const parsed = parseArgs(["app", "server", "--keep-hostname", "-v"]);
  assertEquals(parsed.command, "server");
  assertEquals(parsed.args, ["--keep-hostname", "-v"]);
  assertEquals(parsed.keepHostname, false);
  assertEquals(parsed.verbose, false);
});

Deno.test("parseArgs: unknown flag throws", () => {
  assertThrows(
    () => parseArgs(["--nope", "app", "server"]),
    Error,
    "Unknown flag",
  );
});

Deno.test("parseArgs: missing host throws", () => {
  assertThrows(() => parseArgs([]), Error, "Missing host");
  assertThrows(() => parseArgs(["-v"]), Error, "Missing host");
});

Deno.test("parseArgs: missing command throws", () => {
  assertThrows(() => parseArgs(["app"]), Error, "Missing command");
});

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
