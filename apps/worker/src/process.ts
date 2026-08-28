import { type ChildProcess, execFile, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export interface ControlledProcessOptions {
  executable: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  maxOutputCharacters?: number;
  outputEncoding?: BufferEncoding;
}

export interface ControlledProcessResult {
  /** OS PID of the worker-owned process, captured at launch when available. */
  processId: number | null;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  timedOut: boolean;
  errorCode: "DCC_LAUNCH_FAILED" | "PROCESS_TIMEOUT" | "PROCESS_EXIT_NONZERO" | null;
}

export function runControlledProcess(
  options: ControlledProcessOptions,
): Promise<ControlledProcessResult> {
  const startedAtDate = new Date();
  const maxOutputCharacters = options.maxOutputCharacters ?? 1_000_000;

  return new Promise((resolveResult) => {
    let stdout = "";
    let stderr = "";
    let outputTruncated = false;
    let timedOut = false;
    let settled = false;
    let forcedCompletion: NodeJS.Timeout | undefined;
    let timeout: NodeJS.Timeout | undefined;
    const stdoutDecoder = new StringDecoder(options.outputEncoding ?? "utf8");
    const stderrDecoder = new StringDecoder(options.outputEncoding ?? "utf8");

    let child: ChildProcess;
    try {
      child = spawn(options.executable, [...options.args], {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const completedAt = new Date();
      resolveResult({
        processId: null,
        startedAt: startedAtDate.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs: completedAt.getTime() - startedAtDate.getTime(),
        exitCode: null,
        signal: null,
        stdout,
        stderr: error instanceof Error ? error.message : String(error),
        outputTruncated,
        timedOut,
        errorCode: "DCC_LAUNCH_FAILED",
      });
      return;
    }

    const append = (current: string, chunk: string): string => {
      if (current.length >= maxOutputCharacters) {
        outputTruncated = true;
        return current;
      }
      const combined = current + chunk;
      if (combined.length > maxOutputCharacters) {
        outputTruncated = true;
        return combined.slice(0, maxOutputCharacters);
      }
      return combined;
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = append(stdout, stdoutDecoder.write(chunk));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = append(stderr, stderrDecoder.write(chunk));
    });

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (forcedCompletion) clearTimeout(forcedCompletion);
      stdout = append(stdout, stdoutDecoder.end());
      stderr = append(stderr, stderrDecoder.end());
      const completedAt = new Date();
      resolveResult({
        processId: child.pid ?? null,
        startedAt: startedAtDate.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs: completedAt.getTime() - startedAtDate.getTime(),
        exitCode,
        signal,
        stdout,
        stderr,
        outputTruncated,
        timedOut,
        errorCode: timedOut ? "PROCESS_TIMEOUT" : exitCode === 0 ? null : "PROCESS_EXIT_NONZERO",
      });
    };

    child.once("error", (error) => {
      stderr = append(stderr, error.message);
      if (!timedOut) {
        const completedAt = new Date();
        if (!settled) {
          settled = true;
          if (timeout) clearTimeout(timeout);
          resolveResult({
            processId: child.pid ?? null,
            startedAt: startedAtDate.toISOString(),
            completedAt: completedAt.toISOString(),
            durationMs: completedAt.getTime() - startedAtDate.getTime(),
            exitCode: null,
            signal: null,
            stdout,
            stderr,
            outputTruncated,
            timedOut: false,
            errorCode: "DCC_LAUNCH_FAILED",
          });
        }
      }
    });
    child.once("close", finish);

    timeout = setTimeout(() => {
      timedOut = true;
      terminateOwnedProcess(child);
      forcedCompletion = setTimeout(() => finish(child.exitCode, child.signalCode), 5_000);
    }, options.timeoutMs);
  });
}

function terminateOwnedProcess(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    execFile(
      "taskkill.exe",
      ["/PID", String(child.pid), "/T", "/F"],
      { windowsHide: true, timeout: 5_000 },
      () => {
        if (child.exitCode === null) child.kill();
      },
    );
    return;
  }
  child.kill("SIGKILL");
}
