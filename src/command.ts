import { orange } from "./color.ts";

/**
 * Spawns `command` with `opts.env` added to its environment. An argument that
 * is exactly `$NAME` is replaced by `opts.env[NAME]` when that is set, so a
 * service can be given e.g. its port as a flag.
 *
 * @returns The spawned child process.
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
