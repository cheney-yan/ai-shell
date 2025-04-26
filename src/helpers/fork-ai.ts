/**
 * This file handles the forking of the AI process
 * and provides a function to generate completions using the child process.
 */
import { fork, ChildProcess } from 'child_process';
import path from 'path';
import { IncomingMessage } from 'http';
import { EventEmitter } from 'events';
import { yellow } from 'kolorist';

// Create a mock IncomingMessage that we can use to emulate the OpenAI API response
class MockIncomingMessage extends EventEmitter {
  constructor() {
    super();
  }

  destroy() {
    this.emit('close');
  }
}

let aiProcess: ChildProcess | null = null;

// Function to ensure the AI process is running
function ensureAiProcess(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    if (aiProcess && !aiProcess.killed) {
      resolve(aiProcess);
      return;
    }

    console.log(yellow('DEBUG: Starting AI process'));

    // Fork the AI process
    const aiProcessPath = path.join(__dirname, 'ai-process.ts');
    aiProcess = fork(aiProcessPath, [], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      execArgv: ['--require', 'jiti/register']
    });

    // Handle process exit
    aiProcess.on('exit', (code) => {
      console.log(yellow(`DEBUG: AI process exited with code ${code}`));
      aiProcess = null;
    });

    // Handle process error
    aiProcess.on('error', (err) => {
      console.error(`AI process error: ${err.message}`);
      aiProcess = null;
      reject(err);
    });

    // Capture stdout and stderr from the AI process
    if (aiProcess.stdout) {
      aiProcess.stdout.on('data', (data) => {
        console.log(yellow(`DEBUG: AI process stdout: ${data.toString().trim()}`));
      });
    }

    if (aiProcess.stderr) {
      aiProcess.stderr.on('data', (data) => {
        console.error(yellow(`DEBUG: AI process stderr: ${data.toString().trim()}`));
      });
    }

    // Wait for the ready message
    aiProcess.on('message', (message: any) => {
      if (message.type === 'ready') {
        console.log(yellow('DEBUG: AI process ready'));
        resolve(aiProcess!);
      } else if (message.type === 'error') {
        console.error(yellow('DEBUG: AI process error:'), message.error);
        reject(new Error(message.error.message));
      }
    });

    // Set a timeout in case the process doesn't start
    const timeout = setTimeout(() => {
      console.error(yellow('DEBUG: Timeout waiting for AI process to start'));
      if (aiProcess && !aiProcess.killed) {
        console.log(yellow('DEBUG: Killing AI process due to timeout'));
        aiProcess.kill('SIGKILL');
      }
      reject(new Error('Timeout waiting for AI process to start'));
    }, 10000); // Increase timeout to 10 seconds

    // Clear the timeout when the process is ready
    aiProcess.on('message', () => {
      clearTimeout(timeout);
    });
  });
}

// Function to kill the AI process
export function killAiProcess() {
  if (aiProcess && !aiProcess.killed) {
    console.log(yellow('DEBUG: Killing AI process'));
    aiProcess.kill('SIGKILL');
    aiProcess = null;
  }
}

// Set up a handler to kill the AI process when the main process exits
process.on('exit', () => {
  killAiProcess();
});

// Function to generate a completion using the AI process
export async function generateCompletionWithFork({
  prompt,
  number = 1,
  key,
  model,
  apiEndpoint,
}: {
  prompt: string | any[];
  number?: number;
  model?: string;
  key: string;
  apiEndpoint: string;
}): Promise<IncomingMessage> {
  try {
    // Ensure the AI process is running
    const process = await ensureAiProcess();

    // Create a mock IncomingMessage that we'll use to emulate the OpenAI API response
    const mockResponse = new MockIncomingMessage() as unknown as IncomingMessage;

    // Set up error handler for the AI process
    const errorHandler = (err: Error) => {
      console.error(yellow('DEBUG: AI process error in generateCompletionWithFork:'), err);
      mockResponse.emit('error', err);
    };

    process.on('error', errorHandler);

    // Send the generate message to the AI process
    console.log(yellow('DEBUG: Sending generate message to AI process'));
    process.send({
      type: 'generate',
      prompt,
      key,
      model,
      apiEndpoint,
      number,
    });

    // Handle messages from the AI process
    const messageHandler = (message: any) => {
      if (message.type === 'chunk') {
        // Emit the data event with the chunk
        mockResponse.emit('data', Buffer.from(message.data));
      } else if (message.type === 'done') {
        // Emit the end event
        mockResponse.emit('end');
        // Clean up listeners
        process.removeListener('message', messageHandler);
        process.removeListener('error', errorHandler);
      } else if (message.type === 'error') {
        // Emit the error event
        const error = new Error(message.error.message);
        error.name = message.error.name;
        (error as any).code = message.error.code;
        error.stack = message.error.stack;
        mockResponse.emit('error', error);
        // Clean up listeners
        process.removeListener('message', messageHandler);
        process.removeListener('error', errorHandler);
      }
    };

    process.on('message', messageHandler);

    // Handle process exit
    process.on('exit', (code) => {
      if (code !== 0) {
        mockResponse.emit('error', new Error(`AI process exited with code ${code}`));
      }
    });

    return mockResponse;
  } catch (error: any) {
    console.error(yellow('DEBUG: Error in generateCompletionWithFork:'), error);

    // Create a mock response that immediately emits an error
    const mockResponse = new MockIncomingMessage() as unknown as IncomingMessage;

    // Use setTimeout to ensure the error is emitted asynchronously
    setTimeout(() => {
      mockResponse.emit('error', error);
    }, 0);

    return mockResponse;
  }
}
