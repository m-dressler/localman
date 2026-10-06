import { getAvailablePort } from "@std/net/get-available-port";
import { runCommand } from "./command.ts";
import { createServer } from "./server.ts";

/** Result of parsing the localman CLI arguments. */
export type ParsedArgs = {
  /**
   * Hostname to expose the service under (`<host>.localhost`), lowercased and
   * without a `.localhost` suffix, as browsers address it.
   */
  host: string;
  /** Preserve the original hostname when forwarding instead of rewriting to `localhost`. */
  keepHostname: boolean;
  /** Emit debug logging. */
  verbose: boolean;
  /** The command to run the service. */
  command: string;
  /** Arguments passed to the command. */
  args: string[];
};

/**
 * Parses localman CLI arguments of the form
 * `[flags] <host> <command> [...commandArgs]`. Flags are only recognised before
 * the host; everything after the command is passed through verbatim.
 */
export const parseArgs = (argv: string[]): ParsedArgs => {
  const args = [...argv];

  let host: string | undefined;
  let keepHostname = false;
  let verbose = false;
  while (args.length && host === undefined) {
    const arg = args.shift()!;
    if (arg === "--keep-hostname") keepHostname = true;
    else if (arg === "-v" || arg === "--verbose") verbose = true;
    else if (arg.startsWith("-")) throw new Error("Unknown flag name: " + arg);
    else host = arg.toLowerCase().replace(/\.localhost$/, "");
  }

  if (host === undefined) throw new Error("Missing host to bind to");

  const command = args.shift();
  if (!command) throw new Error("Missing command to run");

  return { host, keepHostname, verbose, command, args };
};

if (import.meta.main) {
  const { host, keepHostname, verbose, command, args } = parseArgs(Deno.args);
  if (!verbose) console.debug = () => {};
  else console.debug = console.debug.bind(console, "$ localman:");

  /** The service; only started once its host is registered. */
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

  const server = createServer({ onIncompatibleMaster: fail });

  const port = Number(Deno.env.get("PORT")) || getAvailablePort();
  // A host that can't be served, e.g. as it's taken or port 80 is held by
  // something else, doesn't start its service at all.
  await server.registerHost(host, { port, keepHostname }).catch(fail);
  process = runCommand([command, ...args], {
    env: { PORT: port + "", HOST: host + ".localhost" },
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      process?.kill();
    } catch {
      // Already exited.
    }
    await server.unregisterHost(host);
    await server.close();
    Deno.exit(0);
  };

  // Register handlers before awaiting the process so a signal during its
  // lifetime tears the service down cleanly.
  Deno.addSignalListener("SIGTERM", shutdown);
  Deno.addSignalListener("SIGINT", shutdown);

  await process.output();
  await server.unregisterHost(host);
  await server.close();
}
