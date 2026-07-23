import { runCommand } from "./command.ts";
import { createServer } from "./server.ts";

/** Result of parsing the localman CLI arguments. */
export type ParsedArgs = {
  /** Hostname to expose the service under (`<host>.localhost`). */
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

  let host = "";
  let keepHostname = false;
  let verbose = false;
  while (args.length && !host) {
    const arg = args.shift()!;
    if (arg === "--keep-hostname") keepHostname = true;
    else if (arg === "-v" || arg === "--verbose") verbose = true;
    else if (arg.startsWith("-")) throw new Error("Unknown flag name: " + arg);
    else host = arg;
  }

  if (!host) throw new Error("Missing host to bind to");

  const command = args.shift();
  if (!command) throw new Error("Missing command to run");

  return { host, keepHostname, verbose, command, args };
};

if (import.meta.main) {
  const { host, keepHostname, verbose, command, args } = parseArgs(Deno.args);
  if (!verbose) console.debug = () => {};
  else console.debug = console.debug.bind(console, "$ localman:");

  const server = createServer();
  const { process, port } = runCommand([command, ...args]);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      process.kill();
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

  await server.registerHost(host, { port, keepHostname });
  await process.output();
  await server.unregisterHost(host);
  await server.close();
}
