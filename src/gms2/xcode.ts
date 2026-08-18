/**
 * Copyright 2026, Opera Norway AS
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at:
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { Context } from "~/context";
import { KnownError } from "~/error";
import type { Log } from "~/log";
import { getProjectName, type ProjectPath } from "~/project";
import { spawnProcess } from "~/spawn";

const DEFAULT_OUTPUT_DIR = "~/gamemakerstudio2";

const XCODE_TARGETS = {
  mac: {
    optionsFile: "options_mac.yy",
    optionsDir: "mac",
    generatedDir: "GM_MAC",
  },
  ios: {
    optionsFile: "options_ios.yy",
    optionsDir: "ios",
    generatedDir: "GM_IOS",
  },
} as const;

export type XcodeTarget = keyof typeof XCODE_TARGETS;

async function readOutputDir(
  ctx: Context,
  projectDir: string,
  target: XcodeTarget,
): Promise<string> {
  const { optionsDir, optionsFile } = XCODE_TARGETS[target];
  const file = ctx.path.join(projectDir, "options", optionsDir, optionsFile);
  const raw = await ctx.fs.readFile(file, "utf-8").catch(() => "");
  const pattern = new RegExp(`"option_${target}_output_dir"\\s*:\\s*"([^"]*)"`);
  const configured = pattern.exec(raw)?.[1];
  const dir =
    configured !== undefined && configured !== ""
      ? configured
      : DEFAULT_OUTPUT_DIR;
  return dir.startsWith("~")
    ? ctx.path.join(ctx.os.homedir(), dir.slice(1))
    : dir;
}

/**
 * A suppressed build leaves the generated Xcode project in
 * `<output dir>/<GM_MAC|GM_IOS>/<name>/<name>FromPC` (Igor CLI) or `<name>` (IDE).
 */
async function findGeneratedXcodeProject(
  ctx: Context,
  projectPath: ProjectPath,
  target: XcodeTarget,
): Promise<string> {
  const projectDir = ctx.path.dirname(projectPath);
  const projectName = getProjectName(ctx, projectPath);
  const baseDir = ctx.path.join(
    await readOutputDir(ctx, projectDir, target),
    XCODE_TARGETS[target].generatedDir,
    projectName,
  );

  for (const name of [`${projectName}FromPC`, projectName]) {
    const candidate = ctx.path.join(baseDir, name);
    const stats = await ctx.fs.stat(candidate).catch(() => undefined);
    if (stats?.isDirectory()) {
      return candidate;
    }
  }
  throw new KnownError(`Found no generated Xcode project in ${baseDir}`);
}

/** Zips the generated project when the target ends in .zip, copies it otherwise. */
export async function exportGeneratedXcodeProject(
  ctx: Context,
  log: Log,
  projectPath: ProjectPath,
  target: XcodeTarget,
  targetFile: string,
): Promise<void> {
  const generatedDir = await findGeneratedXcodeProject(
    ctx,
    projectPath,
    target,
  );
  await ctx.fs.rm(targetFile, { recursive: true, force: true });
  await ctx.fs.mkdir(ctx.path.dirname(targetFile), { recursive: true });
  if (targetFile.endsWith(".zip")) {
    await spawnProcess(ctx, log, {
      cmd: "zip",
      args: ["-q", "-r", "-y", targetFile, "."],
      cwd: generatedDir,
      errorLabel: "zip",
    });
  } else {
    await ctx.fs.cp(generatedDir, targetFile, { recursive: true });
  }
}
