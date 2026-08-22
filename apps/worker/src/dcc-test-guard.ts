const dccTestApprovalEnvironmentVariable = "AI_ARCHVIZ_ALLOW_DCC_TESTS";

/**
 * DCC integration suites can activate the locally installed DCC. Requiring a
 * deliberate environment opt-in prevents a normal test command from taking
 * focus or consuming a workstation license unexpectedly.
 */
export function requireDccTestApproval(environment = process.env): void {
  if (environment[dccTestApprovalEnvironmentVariable] !== "1") {
    throw new Error(
      `${dccTestApprovalEnvironmentVariable}=1 is required before running a DCC integration suite`,
    );
  }
}
