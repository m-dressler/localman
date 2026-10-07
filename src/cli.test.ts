import { assertEquals, assertThrows } from "@std/assert";
import { parseArgs, parseLocalmanPort, serviceEnv } from "./cli.ts";

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

Deno.test("serviceEnv: tells the command where it listens and is reached", () => {
  assertEquals(serviceEnv("api", 4001, 8080), {
    PORT: "4001",
    LOCALMAN_HOST: "api.localhost",
    LOCALMAN_URL: "http://api.localhost:8080",
  });
  // Browsers leave out the default port, so the URL does too.
  assertEquals(
    serviceEnv("api", 4001, 80).LOCALMAN_URL,
    "http://api.localhost",
  );
});
