/**
 * DCC execution is a two-party capability: trusted local worker configuration
 * must enable it and the owning call site must explicitly authorize it. Job
 * payloads and test-harness environment variables cannot substitute either.
 */
export function isDccExecutionAuthorized({
  allowDccExecution,
  authorizeDccExecution,
}: {
  allowDccExecution: boolean;
  authorizeDccExecution: boolean;
}): boolean {
  return allowDccExecution && authorizeDccExecution;
}
