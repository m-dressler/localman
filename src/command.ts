import { getAvailablePort } from "@std/net";

/**
 * Spawns `command` with a `PORT` environment variable set to an available port
 * (or `Deno.env.PORT` when provided), so the service knows where to listen.
 *
 * @returns The spawned child process and the port it was told to use.
 */
export const runCommand = (
  command: string,
  ...args: string[]
): { process: Deno.ChildProcess; port: number } => {
  const port = Number(Deno.env.get("PORT")) || getAvailablePort();
  const process = new Deno.Command(command, {
    args,
    env: { PORT: port + "" },
  }).spawn();
  return { process, port };
};
