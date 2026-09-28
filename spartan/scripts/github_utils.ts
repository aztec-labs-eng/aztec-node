import { appendFileSync } from "node:fs";

export function writeGithubOutputs(outputs: Record<string, string>): void {
  if (process.env.GITHUB_OUTPUT) {
    const lines =
      Object.entries(outputs)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n") + "\n";
    appendFileSync(process.env.GITHUB_OUTPUT, lines);
  }
}
