import { assertEquals, assertThrows } from "@std/assert";
import { parseArgs } from "./mod.ts";

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
  assertThrows(() => parseArgs(["--nope", "app", "server"]), Error, "Unknown flag");
});

Deno.test("parseArgs: missing host throws", () => {
  assertThrows(() => parseArgs([]), Error, "Missing host");
  assertThrows(() => parseArgs(["-v"]), Error, "Missing host");
});

Deno.test("parseArgs: missing command throws", () => {
  assertThrows(() => parseArgs(["app"]), Error, "Missing command");
});
