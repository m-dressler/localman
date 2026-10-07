/**
 * Parsing of the localman command line and environment. Internal to the CLI;
 * the package exports nothing.
 *
 * @module
 */

import { isValidPort } from "./server.ts";

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

/**
 * Parses the `LOCALMAN_PORT` environment variable: the port the master listens
 * on, 80 when unset or empty (as scripts commonly clear variables). Throws for
 * anything that isn't a valid port written in plain digits.
 */
export const parseLocalmanPort = (value: string | undefined): number => {
  const port = Number(value || 80);
  // Plain digits only; Number() would also take hex, exponents and spaces.
  if ((value && !/^\d+$/.test(value)) || !isValidPort(port)) {
    throw new Error(`LOCALMAN_PORT must be 1 to 65535, not "${value}"`);
  }
  return port;
};

/**
 * The environment a service is started with: `PORT` to listen on, and the
 * `LOCALMAN_HOST` and `LOCALMAN_URL` it is reached at through the master on
 * `localmanPort`. The URL has no trailing slash, and no port when that is 80.
 * `HOST` is deliberately not set, as servers that read it bind to it.
 */
export const serviceEnv = (
  host: string,
  port: number,
  localmanPort: number,
): Record<string, string> => ({
  PORT: String(port),
  LOCALMAN_HOST: `${host}.localhost`,
  LOCALMAN_URL: `http://${host}.localhost${
    localmanPort === 80 ? "" : `:${localmanPort}`
  }`,
});

/**
 * Why localman can't run on `os`, or `undefined` if it can. Only macOS and
 * Linux are supported: Windows lacks the signals, the command resolution and
 * the `*.localhost` resolution localman relies on.
 */
export const unsupportedPlatform = (
  os: typeof Deno.build.os,
): string | undefined =>
  os === "windows"
    ? "Localman supports macOS and Linux only, not Windows"
    : undefined;
