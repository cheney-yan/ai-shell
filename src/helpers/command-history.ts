// No imports needed

// Interface for command execution result
export interface CommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  timestamp: number;
}

// Maximum number of commands to keep in history
const MAX_HISTORY_SIZE = 5;

// Store command history
const commandHistory: CommandResult[] = [];

/**
 * Add a command result to the history
 * @param result The command execution result
 */
export function addToCommandHistory(result: CommandResult): void {
  // Add to the beginning of the array (most recent first)
  commandHistory.unshift(result);

  // Trim history to maximum size
  if (commandHistory.length > MAX_HISTORY_SIZE) {
    commandHistory.pop();
  }
}

/**
 * Get the command history
 * @returns Array of command results
 */
export function getCommandHistory(): CommandResult[] {
  return [...commandHistory];
}

/**
 * Clear the command history
 */
export function clearCommandHistory(): void {
  commandHistory.length = 0;
}

/**
 * Format command history as a string for AI context
 * @returns Formatted command history string
 */
export function formatCommandHistoryForAI(): string {
  if (commandHistory.length === 0) {
    return 'No command history available.';
  }

  // Create a more structured format with clear separation and numbering
  return commandHistory
    .map((result, index) => {
      const date = new Date(result.timestamp).toLocaleTimeString();
      const commandNumber = commandHistory.length - index; // Reverse numbering (most recent = highest number)
      const statusIndicator = result.exitCode === 0 ? '✓' : '✗';

      let output = `## Command ${commandNumber} [${date}] ${statusIndicator}\n`;
      output += `\`\`\`bash\n$ ${result.command}\n\`\`\`\n`;
      output += `Exit code: ${result.exitCode}\n`;

      if (result.stdout && result.stdout.trim()) {
        // Trim and limit stdout if it's too long
        const trimmedStdout = trimOutput(result.stdout, 15);
        output += `\nOutput:\n\`\`\`\n${trimmedStdout}\n\`\`\`\n`;
      }

      if (result.stderr && result.stderr.trim()) {
        // Trim and limit stderr if it's too long
        const trimmedStderr = trimOutput(result.stderr, 15);
        output += `\nError:\n\`\`\`\n${trimmedStderr}\n\`\`\`\n`;
      }

      return output;
    })
    .join('\n');
}

/**
 * Trim output to a maximum number of lines
 * @param output The command output to trim
 * @param maxLines Maximum number of lines to keep
 * @returns Trimmed output
 */
function trimOutput(output: string, maxLines: number): string {
  const lines = output.split('\n');
  if (lines.length <= maxLines) {
    return output;
  }

  // Keep first few lines and last few lines
  const halfMax = Math.floor(maxLines / 2);
  const firstHalf = lines.slice(0, halfMax);
  const secondHalf = lines.slice(-halfMax);

  return [...firstHalf, `... (${lines.length - maxLines} more lines) ...`, ...secondHalf].join('\n');
}
