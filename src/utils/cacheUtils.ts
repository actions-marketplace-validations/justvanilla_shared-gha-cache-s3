import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as glob from "@actions/glob";
import * as io from "@actions/io";
import * as fs from "fs";
import * as path from "path";
import * as semver from "semver";
import { v4 as uuidV4 } from "uuid";

export enum CacheFilename {
    Gzip = "cache.tgz",
    Zstd = "cache.tzst"
}

export enum CompressionMethod {
    Gzip = "gzip",
    // Long range mode was added to zstd in v1.3.2.
    // This enum is for earlier version of zstd that does not have --long support
    ZstdWithoutLong = "zstd-without-long",
    Zstd = "zstd"
}

// The default number of retry attempts.
export const DefaultRetryAttempts = 2;

// The default delay in milliseconds between retry attempts.
export const DefaultRetryDelay = 5000;

// Socket timeout in milliseconds during download.  If no traffic is received
// over the socket during this period, the socket is destroyed and the download
// is aborted.
export const SocketTimeout = 5000;

async function getVersion(app: string): Promise<string> {
    core.debug(`Checking ${app} --version`);
    let versionOutput = "";
    try {
        await exec.exec(`${app} --version`, [], {
            ignoreReturnCode: true,
            silent: true,
            listeners: {
                stdout: (data: Buffer): string =>
                    (versionOutput += data.toString()),
                stderr: (data: Buffer): string =>
                    (versionOutput += data.toString())
            }
        });
    } catch (err: any) {
        core.debug(err.message);
    }

    versionOutput = versionOutput.trim();
    core.debug(versionOutput);
    return versionOutput;
}

export function getArchiveFileSizeInBytes(filePath: string): number {
    return fs.statSync(filePath).size;
}

export function getCacheFileName(compressionMethod: CompressionMethod): string {
    return compressionMethod === CompressionMethod.Gzip
        ? CacheFilename.Gzip
        : CacheFilename.Zstd;
}

export async function createTempDirectory(): Promise<string> {
    const IS_WINDOWS = process.platform === "win32";

    let tempDirectory: string = process.env["RUNNER_TEMP"] || "";

    if (!tempDirectory) {
        let baseLocation: string;
        if (IS_WINDOWS) {
            // On Windows use the USERPROFILE env variable
            baseLocation = process.env["USERPROFILE"] || "C:\\";
        } else {
            if (process.platform === "darwin") {
                baseLocation = "/Users";
            } else {
                baseLocation = "/home";
            }
        }
        tempDirectory = path.join(baseLocation, "actions", "temp");
    }

    const dest = path.join(tempDirectory, uuidV4());
    await io.mkdirP(dest);
    return dest;
}

export async function resolvePaths(patterns: string[]): Promise<string[]> {
    const paths: string[] = [];
    const workspace = process.env["GITHUB_WORKSPACE"] ?? process.cwd();
    const globber = await glob.create(patterns.join("\n"), {
        implicitDescendants: false
    });

    for await (const file of globber.globGenerator()) {
        const relativeFile = path
            .relative(workspace, file)
            .replace(new RegExp(`\\${path.sep}`, "g"), "/");
        core.debug(`Matched: ${relativeFile}`);
        // Paths are made relative so the tar entries are all relative to the root of the workspace.
        paths.push(`${relativeFile}`);
    }

    return paths;
}

export async function isZstdInstalled(): Promise<boolean> {
    try {
        await io.which("zstd", true);
        return true;
    } catch (error) {
        return false;
    }
}

export async function isGnuTarInstalled(): Promise<boolean> {
    const versionOutput = await getVersion("tar");
    return versionOutput.toLowerCase().includes("gnu tar");
}

export async function getCompressionMethod(): Promise<CompressionMethod> {
    if (
        (process.platform === "win32" && !(await isGnuTarInstalled())) ||
        !(await isZstdInstalled())
    ) {
        // Disable zstd due to bug https://github.com/actions/cache/issues/301
        return CompressionMethod.Gzip;
    }

    const versionOutput = await getVersion("zstd");
    const version = semver.clean(versionOutput);

    // zstd is installed but using a version earlier than v1.3.2
    // v1.3.2 is required to use the `--long` options in zstd
    return !version || semver.lt(version, "v1.3.2")
        ? CompressionMethod.ZstdWithoutLong
        : CompressionMethod.Zstd;
}

export async function unlinkFile(filePath: fs.PathLike): Promise<void> {
    return await fs.promises.unlink(filePath);
}

export function assertDefined<T>(name: string, value?: T): T {
    if (value === undefined) {
        throw Error(`Expected ${name} but value was undefiend`);
    }

    return value;
}