/**
 * Run multiple services locally, each addressable at its own
 * `<host>.localhost`. This module is the `localman` command line; see the
 * README for usage. It exports no API.
 *
 * @example Expose a service at `http://api.localhost/`
 * ```sh
 * localman api deno run -A ./api.ts
 * ```
 *
 * @module
 */

import { getAvailablePort } from "@std/net/get-available-port";
import {
  parseArgs,
  parseLocalmanPort,
  serviceEnv,
  unsupportedPlatform,
  USAGE,
} from "./cli.ts";
import { runCommand } from "./command.ts";
import { createServer } from "./server.ts";

/**
 * Exit codes for the signals that stop localman: 128 + the signal's number, as
 * shells report a process they interrupted.
 */
const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 } as const;

if (import.meta.main) {
  const parsed = (() => {
    try {
      return parseArgs(Deno.args);
    } catch (err) {
      // A usage error: the reason and where to look, not a stack trace.
      console.error(`localman: ${err instanceof Error ? err.message : err}`);
      console.error("Run `localman --help` for usage.");
      return Deno.exit(2);
    }
  })();
  if (parsed.action === "help") {
    console.log(USAGE);
    Deno.exit(0);
  }
  const { host, keepHostname, verbose, command, args } = parsed;
  if (!verbose) console.debug = () => {};
  else console.debug = console.debug.bind(console, "$ localman:");

  /** The service; only started once its host is registered. */
  // Not const: fail() reads it before the command is spawned, e.g. when
  // registration is refused, where a const would still be uninitialized.
  // deno-lint-ignore prefer-const
  let process: Deno.ChildProcess | undefined;

  /** Reports why the host can't be served, stops the service and exits. */
  const fail = (err: Error): never => {
    console.error(
      "localman:",
      err.message,
      ...(err.cause === undefined ? [] : [err.cause]),
    );
    try {
      process?.kill();
    } catch {
      // Already exited.
    }
    Deno.exit(1);
  };

  // Before anything is registered or started.
  const unsupported = unsupportedPlatform(Deno.build.os);
  if (unsupported) fail(new Error(unsupported));

  const localmanPort = (() => {
    try {
      return parseLocalmanPort(Deno.env.get("LOCALMAN_PORT"));
    } catch (err) {
      return fail(err instanceof Error ? err : new Error(String(err)));
    }
  })();

  const server = createServer({
    port: localmanPort,
    onIncompatibleMaster: fail,
  });

  const port = Number(Deno.env.get("PORT")) || getAvailablePort();
  // A host that can't be served, e.g. as it's taken or the master's port is
  // held by something else, doesn't start its service at all.
  await server.registerHost(host, { port, keepHostname }).catch(fail);
  process = runCommand([command, ...args], {
    env: serviceEnv(host, port, localmanPort),
  });

  let stopping = false;
  /**
   * Stops the command, unregisters and exits with `code`. A signal and the
   * command exiting may both get here; the first decides the code, as the
   * other's teardown could otherwise finish first and exit with its own.
   */
  const stop = async (code: number) => {
    if (stopping) return;
    stopping = true;
    try {
      process?.kill();
    } catch {
      // Already exited.
    }
    await server.unregisterHost(host);
    await server.close();
    Deno.exit(code);
  };

  // Register handlers before awaiting the process so a signal during its
  // lifetime tears the service down cleanly.
  Deno.addSignalListener("SIGTERM", () => stop(SIGNAL_EXIT_CODES.SIGTERM));
  Deno.addSignalListener("SIGINT", () => stop(SIGNAL_EXIT_CODES.SIGINT));

  // Deno reports a command killed by a signal as 128 + its number already.
  await stop((await process.status).code);
}
