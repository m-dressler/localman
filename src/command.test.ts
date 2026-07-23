import { assertEquals } from "@std/assert";
import { runCommand } from "./command.ts";

/** Deno script that dumps its argv and a fixed set of env vars to a JSON file given as argv[0]. */
const DUMP_SCRIPT = `
const [outFile] = Deno.args;
await Deno.writeTextFile(outFile, JSON.stringify({
  args: Deno.args.slice(1),
  env: { PORT: Deno.env.get("PORT") ?? null, HOST: Deno.env.get("HOST") ?? null },
}));
`;

const runAndDump = async (
  args: string[],
  env: Record<string, string>,
) => {
  const scriptFile = await Deno.makeTempFile({ suffix: ".ts" });
  const outFile = await Deno.makeTempFile();
  try {
    await Deno.writeTextFile(scriptFile, DUMP_SCRIPT);
    const process = runCommand(
      [
        Deno.execPath(),
        "run",
        "--allow-env",
        "--allow-write",
        scriptFile,
        outFile,
        ...args,
      ],
      { env },
    );
    const status = await process.status;
    assertEquals(status.success, true);
    return JSON.parse(await Deno.readTextFile(outFile));
  } finally {
    await Deno.remove(scriptFile);
    await Deno.remove(outFile);
  }
};

Deno.test("runCommand: substitutes $KEY args with the matching env value", async () => {
  const { args } = await runAndDump(["$PORT", "literal"], { PORT: "1234" });
  assertEquals(args, ["1234", "literal"]);
});

Deno.test("runCommand: leaves $KEY args untouched when no matching env value", async () => {
  const { args } = await runAndDump(["$MISSING"], { PORT: "1234" });
  assertEquals(args, ["$MISSING"]);
});

Deno.test("runCommand: passes env through to the child process", async () => {
  const { env } = await runAndDump([], { PORT: "1234", HOST: "app" });
  assertEquals(env, { PORT: "1234", HOST: "app" });
});
