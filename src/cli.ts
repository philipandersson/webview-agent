import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { Agent } from "./agent";
import * as render from "./render";
import pc from "picocolors";

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    render.errorLine("OPENAI_API_KEY is not set. Add it to .env or the environment.");
    process.exit(1);
  }

  render.banner();
  render.info("  type your goal; Ctrl-D or `exit` to quit.\n");

  const rl = readline.createInterface({ input, output, terminal: true });
  const agent = new Agent();

  let ctrlCCount = 0;
  process.on("SIGINT", () => {
    ctrlCCount++;
    if (ctrlCCount >= 2) {
      console.log(pc.dim("\n  bye."));
      process.exit(0);
    }
    console.log(pc.dim("\n  (Ctrl-C again to exit)"));
  });

  while (true) {
    let goal: string;
    try {
      goal = (await rl.question(render.goalPromptString())).trim();
    } catch {
      break;
    }
    if (!goal) continue;
    if (goal === "exit" || goal === "quit") break;

    ctrlCCount = 0;
    try {
      await agent.run(goal);
    } catch (err) {
      render.errorLine(`  agent error: ${errorMessage(err)}`);
    }
    console.log("");
  }

  rl.close();
  console.log(pc.dim("  bye."));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

main().catch((err: unknown) => {
  render.errorLine(`fatal: ${errorMessage(err)}`);
  process.exit(1);
});
