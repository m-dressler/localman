import { getAvailablePort } from "@std/net";
import { orange } from "./color.ts";

/**
 * Spawns `command` with a `PORT` environment variable set to an available port
 * (or `Deno.env.PORT` when provided), so the service knows where to listen.
 *
 * @returns The spawned child process and the port it was told to use.
 */
export const runCommand = (
  command: [string, ...string[]],
): { process: Deno.ChildProcess; port: number } => {
  const [cmd, ...args] = command;
  const port = Number(Deno.env.get("PORT")) || getAvailablePort();

  const portIndex = args.indexOf("$PORT");
  if (portIndex !== -1) args.splice(portIndex, 1, port + "");

  console.debug("Running command", orange(cmd), args);

  const process = new Deno.Command(cmd, {
    args,
    env: { PORT: port + "" },
  }).spawn();
  return { process, port };
};
