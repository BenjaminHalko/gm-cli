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

import { promisify } from "node:util";
import type { Cache } from "~/cache";
import { exists, type Context } from "~/context";
import type { Log } from "~/log";
import { KnownError } from "~/error";
import type { Target } from "~/target";
import {
  installRuntime,
  listRuntimes,
  ModuleSchema,
  type Module,
} from "~/igor";
import { z } from "zod";
import {
  gms2VersionSchema,
  gms2VersionSatisfies,
  gms2VersionCompare,
  type Gms2VersionPartial,
  gms2VersionToString,
  type Gms2Version,
} from "~/toolchain";

const receiptSchema = z.record(z.string(), z.unknown());

// The stock runner only applies YYDisplayLayout (display cutout mode) on
// Android 14+, even though the underlying APIs exist since Android 11.
async function patchRunnerCutoutGate(ctx: Context, runtimeLocation: string) {
  const runnerActivity = ctx.path.join(
    runtimeLocation,
    "android",
    "runner",
    "ProjectFiles",
    "src",
    "main",
    "java",
    "YYAndroidPackageDomain",
    "YYAndroidPackageCompany",
    "YYAndroidPackageProduct",
    "RunnerActivity.java",
  );
  if (!(await exists(ctx, runnerActivity))) {
    return;
  }
  const source = await ctx.fs.readFile(runnerActivity, "utf-8");
  const patched = source.replace(
    /if \(Build\.VERSION\.SDK_INT >= 34\)(\s*_DisplayLayout = SetEdgeToEdge\(\);)/,
    "if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R)$1",
  );
  if (patched !== source) {
    await ctx.fs.writeFile(runnerActivity, patched);
  }
}

// The stock runner lets GLSurfaceView destroy the EGL context on every pause,
// forcing a full EGL/shader re-initialisation each time the app returns from
// the background (part of the multi-second Android resume freeze).
async function patchRunnerPreserveEglContext(
  ctx: Context,
  runtimeLocation: string,
) {
  const glSurfaceView = ctx.path.join(
    runtimeLocation,
    "android",
    "runner",
    "ProjectFiles",
    "src",
    "main",
    "java",
    "YYAndroidPackageDomain",
    "YYAndroidPackageCompany",
    "YYAndroidPackageProduct",
    "DemoGLSurfaceView.java",
  );
  if (!(await exists(ctx, glSurfaceView))) {
    return;
  }
  const source = await ctx.fs.readFile(glSurfaceView, "utf-8");
  if (source.includes("setPreserveEGLContextOnPause")) {
    return;
  }
  const patched = source.replace(
    /(super\(context, attrs\);)/,
    "$1\n\n\t\tsetPreserveEGLContextOnPause(true);",
  );
  if (patched !== source) {
    await ctx.fs.writeFile(glSurfaceView, patched);
  }
}

const RUNNER_JAVA_DIR = [
  "android",
  "runner",
  "ProjectFiles",
  "src",
  "main",
  "java",
  "YYAndroidPackageDomain",
  "YYAndroidPackageCompany",
  "YYAndroidPackageProduct",
];

// Java_com_yoyogames_runner_RunnerJNILib_Resume (in GameMakerM.o of the YYC
// libyoyo.a) always tears down GPU state: it sets g_AndroidResume, resets
// currenttargets/currentDepthBuffer to -1 and calls clearRenderBufferStack().
// The next Process() sees the flag and rebuilds - invalidating every texture
// handle, which re-decompresses every BZ2 texture page (a multi-second freeze)
// and frees every entry in g_surfaces. With a preserved EGL context none of
// that is necessary, but the teardown and the rebuild are a matched pair:
// skipping only the rebuild leaves the renderer unable to produce a flippable
// frame, and DemoRenderer.onDrawFrame spins on `while (!canFlip())` forever.
//
// Resume(int) receives an int from Java that the native code never reads, so
// these rewrites make the whole teardown conditional on it - all of it or none
// of it. Java passes 0 on a normal resume (GPU state left untouched) and 1 from
// the onSurfaceCreated re-create branch, where the context really was lost and
// stock behaviour is required (see patchRunnerContextLossRecovery). Because a
// 0 argument now skips the flag store as well, a late Resume(0) on the UI
// thread can no longer clobber a Resume(1) already issued by the GL thread.
//
// Only instructions without a relocation are rewritten, so linking is
// unaffected; each architecture keeps its own prologue/epilogue intact.
interface ResumePatch {
  readonly abi: string;
  readonly signature: readonly number[];
  readonly rewrites: readonly (readonly [number, number, number])[];
}

const RESUME_PATCHES: readonly ResumePatch[] = [
  {
    // arm64: the jint arrives in w2 and is parked in callee-saved w20, then
    // `cbz w20` jumps clear of the teardown to the trailing log call at +0x88.
    //   +0x04  str x19,[sp,#0x10] -> stp x19,x20,[sp,#0x10]  (also save x20)
    //   +0x18  ldr w8,[x8]        -> ldr w0,[x8]             (frees the +0x1c slot)
    //   +0x1c  mov w0,w8          -> mov w20,w2              (capture jint arg)
    //   +0x58  mov w9,#1          -> cbz w20,+0x88           (skip teardown)
    //   +0x6c  strb w9,[x8]       -> strb w20,[x8]           (flag := arg)
    //   +0x9c  ldr x19,[sp,#0x10] -> ldp x19,x20,[sp,#0x10]  (restore x20)
    abi: "arm64-v8a",
    signature: [
      0xa9be7bfd, 0xf9000bf3, 0x910003fd, 0x90000008, 0xaa0003e1, 0xf9400108,
      0xb9400108, 0x2a0803e0, 0x94000000, 0x90000008, 0x90000001, 0x91000021,
      0xf9400108, 0xf9400113, 0xf9400268, 0xaa1303e0, 0xf9400d08, 0xd63f0100,
      0x94000000, 0x94000000, 0x94000000, 0x90000008, 0x52800029, 0x9000000a,
      0xf9400108, 0xf940014a, 0x9280000b, 0x39000109,
    ],
    rewrites: [
      [0x04, 0xf9000bf3, 0xa90153f3],
      [0x18, 0xb9400108, 0xb9400100],
      [0x1c, 0x2a0803e0, 0x2a0203f4],
      [0x58, 0x52800029, 0x34000194],
      [0x6c, 0x39000109, 0x39000114],
      [0x9c, 0xf9400bf3, 0xa94153f3],
    ],
  },
  {
    // armv7: the jint arrives in r2 and is parked in r10, which the function's
    // existing push/pop already preserves, so the prologue keeps working. The
    // `cmp` occupies the slot that materialised the constant 1, and only
    // non-flag-setting loads separate it from the branch, so the flags survive
    // the address setup. Predicating the stores individually is NOT an
    // option: the trailing `bl clearRenderBufferStack` carries an R_ARM_CALL
    // relocation and the linker re-encodes that whole word, silently restoring
    // the AL condition and calling it unconditionally. Branching over the block
    // leaves the relocated instruction untouched and simply unreachable.
    // Slots are tight, so the four -1 stores to currenttargets are folded into
    // two `stm`s (it is 16-byte aligned - the x86_64 build uses movdqa on it).
    //   +0x04  add r11,sp,#8   -> mov r10,r2        (capture jint arg)
    //   +0x54  mov r2,#1       -> cmp r10,#0
    //   +0x64  str r0,[r1]     -> beq +0x88         (skip teardown)
    //   +0x68  str r0,[r1,#4]  -> strb r10,[r3]     (flag := arg)
    //   +0x6c  strb r2,[r3]    -> mvn r2,#0
    //   +0x70  str r0,[r1,#8]  -> stmia r1!,{r0,r2} (currenttargets[0..1])
    //   +0x74  str r0,[r1,#0c] -> stmia r1,{r0,r2}  (currenttargets[2..3])
    abi: "armv7",
    signature: [
      0xe92d4c10, 0xe28db008, 0xe1a01000, 0xe59f0090, 0xe79f0000, 0xe5900000,
      0xebfffffe, 0xe59f0084, 0xe79f0000, 0xe5904000, 0xe5940000, 0xe59f1078,
      0xe590200c, 0xe08f1001, 0xe1a00004, 0xe12fff32, 0xebfffffe, 0xebfffffe,
      0xebfffffe, 0xe59f105c, 0xe3e00000, 0xe3a02001, 0xe79f1001, 0xe59f3050,
      0xe79f3003, 0xe5810000, 0xe5810004, 0xe5c32000,
    ],
    rewrites: [
      [0x04, 0xe28db008, 0xe1a0a002],
      [0x54, 0xe3a02001, 0xe35a0000],
      [0x64, 0xe5810000, 0x0a000007],
      [0x68, 0xe5810004, 0xe5c3a000],
      [0x6c, 0xe5c32000, 0xe3e02000],
      [0x70, 0xe5810008, 0xe8a10005],
      [0x74, 0xe581000c, 0xe8810005],
    ],
  },
];

async function patchResumeArchive(
  ctx: Context,
  archive: string,
  patch: ResumePatch,
) {
  if (!(await exists(ctx, archive))) {
    return;
  }
  const data = await ctx.fs.readFile(archive);
  const signature = Buffer.alloc(patch.signature.length * 4);
  patch.signature.forEach((word, i) => {
    signature.writeUInt32LE(word, i * 4);
  });
  const base = data.indexOf(signature);
  if (base === -1 || data.indexOf(signature, base + 1) !== -1) {
    return;
  }
  for (const [offset, expected, replacement] of patch.rewrites) {
    if (data.readUInt32LE(base + offset) !== expected) {
      return;
    }
    data.writeUInt32LE(replacement, base + offset);
  }
  await ctx.fs.writeFile(archive, data);
}

async function patchRunnerResumeTextureFlag(
  ctx: Context,
  runtimeLocation: string,
) {
  for (const patch of RESUME_PATCHES) {
    await patchResumeArchive(
      ctx,
      ctx.path.join(
        runtimeLocation,
        "yyc",
        "android",
        patch.abi,
        "lib",
        "libyoyo.a",
      ),
      patch,
    );
  }
}

// Companion to patchRunnerResumeTextureFlag: GLSurfaceView calls
// onSurfaceCreated only when the EGL context was actually (re)created, and the
// stock re-create branch does nothing. Resume(1) there restores the original
// full-invalidation behaviour exactly when the context really was lost.
// Resume() is idempotent (audio unsuspend is state-guarded), and with an
// unpatched native library the extra call is a no-op behaviour-wise because
// the argument is ignored there.
async function patchRunnerContextLossRecovery(
  ctx: Context,
  runtimeLocation: string,
) {
  for (const file of ["DemoRenderer.java", "DemoRendererGL2.java"]) {
    const rendererPath = ctx.path.join(
      runtimeLocation,
      ...RUNNER_JAVA_DIR,
      file,
    );
    if (!(await exists(ctx, rendererPath))) {
      continue;
    }
    const source = await ctx.fs.readFile(rendererPath, "utf-8");
    if (source.includes("RunnerJNILib.Resume(1);")) {
      continue;
    }
    const patched = source.replace(
      /(Log\.i\("yoyo", "onSurfaceCreated\(\) aborted on re-create[^\n]*\n)/,
      "$1\t    	RunnerJNILib.Resume(1);\n",
    );
    if (patched !== source) {
      await ctx.fs.writeFile(rendererPath, patched);
    }
  }
}

async function installationFixup(ctx: Context, runtimeLocation: string) {
  await patchRunnerCutoutGate(ctx, runtimeLocation);
  await patchRunnerPreserveEglContext(ctx, runtimeLocation);
  await patchRunnerResumeTextureFlag(ctx, runtimeLocation);
  await patchRunnerContextLossRecovery(ctx, runtimeLocation);
  if (ctx.process.platform === "win32") {
    return;
  }
  const binDir = ctx.path.join(runtimeLocation, "bin");
  await chmodRecursive(ctx, binDir);
  const gradlew = ctx.path.join(
    runtimeLocation,
    "android",
    "runner",
    "gradle",
    "gradlew",
  );
  if (await exists(ctx, gradlew)) {
    await ctx.fs.chmod(gradlew, 0o755);
  }
  if (ctx.process.platform === "darwin") {
    await extractDmgs(ctx, runtimeLocation);
  }
}

// FIXME: Igor should do this...
async function extractDmgs(ctx: Context, runtimeLocation: string) {
  const macDir = ctx.path.join(runtimeLocation, "mac");
  let entries: string[];
  try {
    entries = await ctx.fs.readdir(macDir);
  } catch {
    return;
  }
  const dmgs = entries.filter((e) => e.endsWith(".dmg"));
  for (const dmg of dmgs) {
    const dmgPath = ctx.path.join(macDir, dmg);
    const exec = promisify(ctx.child_process.execFile);

    // Mount the DMG
    const { stdout: mountOut } = await exec("hdiutil", [
      "attach",
      dmgPath,
      "-nobrowse",
      "-readonly",
      "-plist",
    ]);

    // Parse plist output to find mount point
    const mountPointMatch =
      /<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/.exec(mountOut);
    if (!mountPointMatch?.[1]) {
      continue;
    }
    const mountPoint: string = mountPointMatch[1];

    try {
      // Find .app bundles in the mounted volume
      const volumeEntries = await ctx.fs.readdir(mountPoint);
      for (const entry of volumeEntries) {
        if (entry.endsWith(".app")) {
          const src = ctx.path.join(mountPoint, entry);
          const dest = ctx.path.join(macDir, entry);
          if (await exists(ctx, dest)) {
            continue;
          }
          await exec("cp", ["-R", src, dest]);
        }
      }
    } finally {
      await exec("hdiutil", ["detach", mountPoint, "-quiet"]);
    }
  }
}

async function chmodRecursive(ctx: Context, dir: string) {
  const entries = await ctx.fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = ctx.path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await chmodRecursive(ctx, fullPath);
    } else {
      await ctx.fs.chmod(fullPath, 0o755);
    }
  }
}

function parseRuntimeVersionFromDirName(
  name: string,
): Gms2VersionPartial | undefined {
  const versionStr = name.replace(/^runtime-/, "");
  const result = gms2VersionSchema.safeParse(versionStr);
  return result.success ? result.data : undefined;
}

async function findRuntimeLocation(
  ctx: Context,
  runtimeDir: string,
  version?: Gms2VersionPartial,
): Promise<string | undefined> {
  const entries = await ctx.fs.readdir(runtimeDir);
  const candidates = entries
    .flatMap((name) => {
      // Ignore directories that we fail to parse
      const dirVersion = parseRuntimeVersionFromDirName(name);
      // TODO: log warning!
      if (dirVersion === undefined) {
        return [];
      }
      // If a version was specified, we should only include runtimes that satisfies that version!
      if (version && !gms2VersionSatisfies(dirVersion, version)) {
        return [];
      }
      return [{ name, version: dirVersion }];
    })
    // Most recent version first
    .sort((a, b) => gms2VersionCompare(b.version, a.version));

  if (candidates.length === 0) {
    return undefined;
  }

  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return ctx.path.join(runtimeDir, candidates[0]!.name);
}

// Igor's RSS feeds for runtimes. We hard-code these rather than using Igor's
// defaults because the default points at the discontinued monthlies feed.
const RUNTIME_FEEDS = {
  lts2026: {
    url: "https://gms.yoyogames.com/Zeus-Runtime-LTS2026.rss",
    label: "LTS 2026",
  },
  monthly: {
    url: "https://gms.yoyogames.com/Zeus-Runtime.rss",
    label: "Monthly",
  },
  beta: {
    url: "https://gms.yoyogames.com/Zeus-Runtime-NuBeta.rss",
    label: "Beta",
  },
} as const;

// With no version constraint, always pull the latest from LTS2026. With a
// constraint, try LTS2026 first and then monthly and then
// fall back to beta.
async function resolveRuntimeFeed(
  ctx: Context,
  { igorPath, version }: { igorPath: string; version?: Gms2VersionPartial },
): Promise<{ runtimeUrl: string; completeVersion?: Gms2Version }> {
  if (!version) {
    return { runtimeUrl: RUNTIME_FEEDS.lts2026.url };
  }

  const seenVersions: { version: Gms2Version; label: string }[] = [];
  for (const { url: runtimeUrl, label } of Object.values(RUNTIME_FEEDS)) {
    const allVersions = await listRuntimes(ctx, { igorPath, runtimeUrl });
    for (const v of allVersions) {
      seenVersions.push({ version: v, label });
    }
    const completeVersion = allVersions
      .filter((v) => gms2VersionSatisfies(v, version))
      .sort((a, b) => gms2VersionCompare(b, a))[0];
    if (completeVersion) {
      return { runtimeUrl, completeVersion };
    }
  }

  const fullList = seenVersions
    .map(({ version: v, label }) => `${gms2VersionToString(v)} (${label})`)
    .join("\n");
  throw new KnownError(
    `No runtime version '${gms2VersionToString(version)}' found. Available options:\n${fullList}`,
  );
}

export async function installRuntimeIfNeeded(
  ctx: Context,
  log: Log,
  {
    licenseFile,
    igorPath,
    cache,
    target,
    version,
  }: {
    licenseFile: string;
    igorPath: string;
    cache: Cache;
    target: Target;
    version?: Gms2VersionPartial;
  },
): Promise<string> {
  const runtimeDir = await cache.getSubDirPath(ctx, "runtimes-gms2", {
    preferShared: true,
  });
  let runtimeLocation = await findRuntimeLocation(ctx, runtimeDir, version);

  // FIXME: if this fails, we should delete the runtime dir and try again
  const installedModules = runtimeLocation
    ? await getInstalledRuntimeModules(ctx, runtimeLocation)
    : [];

  if (runtimeLocation && installedModules.includes(target)) {
    log.success("Runtime found");
    return runtimeLocation;
  }

  // Looks like we need to actually download the runtime!
  const { runtimeUrl, completeVersion } = await resolveRuntimeFeed(ctx, {
    igorPath,
    version,
  });

  // Install into a temporary directory first, then merge into the real
  // runtime dir. This avoids overwriting modules that were already installed
  // by a previous call.
  const tempDir = await ctx.fs.mkdtemp(
    ctx.path.join(ctx.os.tmpdir(), "gm-runtime-"),
  );

  try {
    await installRuntime(ctx, log, {
      igorPath,
      runtimeDir: tempDir,
      modules: [target],
      licenseFile,
      version: completeVersion,
      runtimeUrl,
    });

    const tempRuntimeLocation = await findRuntimeLocation(ctx, tempDir);
    if (!tempRuntimeLocation) {
      throw new Error(
        "Invariant broken: no runtime found in temp directory after installation",
      );
    }
    const runtimeName = ctx.path.basename(tempRuntimeLocation);
    const destLocation = ctx.path.join(runtimeDir, runtimeName);

    // Read the existing receipt before copying so we can merge it
    const receiptPath = ctx.path.join(destLocation, "receipt.json");
    let existingReceipt: Record<string, unknown> = {};
    try {
      existingReceipt = receiptSchema.parse(
        JSON.parse(await ctx.fs.readFile(receiptPath, "utf-8")),
      );
    } catch {
      // No existing receipt
    }

    await ctx.fs.mkdir(destLocation, { recursive: true });
    await ctx.fs.cp(tempRuntimeLocation, destLocation, { recursive: true });

    // Merge the old receipt entries into the new one so previously
    // installed modules are not forgotten.
    const newRaw = await ctx.fs.readFile(receiptPath, "utf-8");
    const mergedReceipt = {
      ...existingReceipt,
      ...receiptSchema.parse(JSON.parse(newRaw)),
    };
    await ctx.fs.writeFile(receiptPath, JSON.stringify(mergedReceipt, null, 2));
  } catch (e) {
    log.error("Failed to install runtime");
    throw new KnownError(e);
  } finally {
    await ctx.fs.rm(tempDir, { recursive: true, force: true });
  }
  log.success("Runtime installed");

  runtimeLocation = await findRuntimeLocation(ctx, runtimeDir);
  if (!runtimeLocation) {
    throw new Error("Invariant broken: no runtime found after installation");
  }
  await installationFixup(ctx, runtimeLocation);
  return runtimeLocation;
}

export async function getInstalledRuntimeModules(
  ctx: Context,
  runtimeLocation: string,
): Promise<Module[]> {
  const receiptPath = ctx.path.join(runtimeLocation, "receipt.json");
  const content = await ctx.fs.readFile(receiptPath, "utf-8");
  const receipt = z.record(z.string(), z.unknown()).parse(JSON.parse(content));

  return Object.keys(receipt)
    .map((key) => ModuleSchema.safeParse(key))
    .filter((result) => result.success)
    .map((result) => result.data);
}
