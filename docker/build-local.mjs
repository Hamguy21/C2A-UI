import { spawnSync } from "node:child_process";

const composeArgs = [
  "compose",
  "-f",
  "docker/docker-compose.yml",
  "-f",
  "docker/docker-compose.override.yml",
  "build",
];

const gitResult = spawnSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
});

const commitSha = gitResult.status === 0
  ? gitResult.stdout.trim()
  : "docker";

composeArgs.push("--build-arg", `VITE_COMMIT_SHA=${commitSha}`);

const dockerResult = spawnSync("docker", composeArgs, {
  stdio: "inherit",
});

if (dockerResult.error) {
  console.error(dockerResult.error.message);
  process.exit(1);
}

process.exit(dockerResult.status ?? 1);