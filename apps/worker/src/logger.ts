export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEvent {
  level: LogLevel;
  component: string;
  event: string;
  jobId?: string;
  errorCode?: string;
  details?: Record<string, unknown>;
}

export function logStructured(event: LogEvent): void {
  const output: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level: event.level,
    component: event.component,
    event: event.event,
  };
  if (event.jobId !== undefined) output.jobId = event.jobId;
  if (event.errorCode !== undefined) output.errorCode = event.errorCode;
  if (event.details !== undefined) output.details = event.details;
  process.stderr.write(`${JSON.stringify(output)}\n`);
}
