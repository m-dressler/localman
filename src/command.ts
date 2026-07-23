import { orange } from "./color.ts";

/**
 * Spawns `command` with a `PORT` environment variable set to an available port
 * (or `Deno.env.PORT` when provided), so the service knows where to listen.
 *
 * @returns The spawned child process and the port it was told to use.
 */
export const runCommand = (
  command: [string, ...string[]],
  opts?: { env?: Record<string, string> },
): Deno.ChildProcess => {
  const [cmd, ...args] = command;

  // Replace args with env values
  if (opts?.env) {
    for (let i = 0; i < args.length; ++i) {
      const arg = args[i];
      if (arg[0] !== "$") continue;

      const val = opts.env[arg.substring(1)];
      if (val) args.splice(i, 1, val);
    }
  }

  console.debug("Running command", orange(cmd), args);

  return new Deno.Command(cmd, { args, env: opts?.env }).spawn();
};
