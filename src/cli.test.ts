import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  parseArgs,
  parseLocalmanPort,
  serviceEnv,
  unsupportedPlatform,
} from "./cli.ts";

/** Parses `argv`, asserting it asks to run a service. */
const parseRun = (argv: string[]) => {
  const parsed = parseArgs(argv);
  assert(parsed.action === "run");
  return parsed;
};

Deno.test("parseArgs: host, command and command args", () => {
  assertEquals(parseArgs(["app", "deno", "run", "-A", "x.ts"]), {
    action: "run",
    host: "app",
    keepHostname: false,
    verbose: false,
    command: "deno",
    args: ["run", "-A", "x.ts"],
  });
});

Deno.test("parseArgs: flags before the host are consumed", () => {
  const parsed = parseRun(["--keep-hostname", "-v", "app", "server"]);
  assertEquals(parsed.keepHostname, true);
  assertEquals(parsed.verbose, true);
  assertEquals(parsed.host, "app");
  assertEquals(parsed.command, "server");
});

Deno.test("parseArgs: normalizes the host as a browser would address it", () => {
  assertEquals(parseRun(["API", "server"]).host, "api");
  assertEquals(parseRun(["api.localhost", "server"]).host, "api");
  assertEquals(parseRun(["Api.V2.LOCALHOST", "server"]).host, "api.v2");
  // Left for registration to reject, rather than taking the command as host.
  const empty = parseRun([".localhost", "server"]);
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
  assertEquals(parseRun(["--verbose", "app", "server"]).verbose, true);
});

Deno.test("parseArgs: flags after the host belong to the command", () => {
  const parsed = parseRun(["app", "server", "--keep-hostname", "-v"]);
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

Deno.test("unsupportedPlatform: refuses Windows up front", () => {
  assertEquals(unsupportedPlatform("darwin"), undefined);
  assertEquals(unsupportedPlatform("linux"), undefined);
  // Otherwise it registers and starts the command before failing obscurely.
  assertStringIncludes(unsupportedPlatform("windows") ?? "", "macOS and Linux");
});

Deno.test("parseArgs: -h and --help ask for usage", () => {
  assertEquals(parseArgs(["--help"]), { action: "help" });
  assertEquals(parseArgs(["-v", "-h", "app", "server"]), { action: "help" });
  // After the host they belong to the command, like every other flag.
  assertEquals(parseRun(["app", "server", "--help"]).args, ["--help"]);
});
