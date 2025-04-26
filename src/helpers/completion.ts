import {
  OpenAIApi,
  Configuration,
  ChatCompletionRequestMessage,
  Model,
} from 'openai';
import dedent from 'dedent';
import { IncomingMessage } from 'http';
import { KnownError } from './error';
import { streamToIterable } from './stream-to-iterable';
import { detectShell } from './os-detect';
import type { AxiosError } from 'axios';
import { streamToString } from './stream-to-string';
import './replace-all-polyfill';
import i18n from './i18n';
import { stripRegexPatterns } from './strip-regex-patterns';
import readline from 'readline';
import { CommandResult } from './command-history';
import { yellow } from 'kolorist';

const explainInSecondRequest = true;

function getOpenAi(key: string, apiEndpoint: string) {
  const openAi = new OpenAIApi(
    new Configuration({ apiKey: key, basePath: apiEndpoint })
  );
  return openAi;
}

// OpenAI outputs markdown format for code blocks. It often uses
// a github style like: "```bash"
const shellCodeExclusions = [/```[a-zA-Z]*\n/gi, /```[a-zA-Z]*/gi, '\n'];

export async function getScriptAndInfo({
  prompt,
  key,
  model,
  apiEndpoint,
  commandHistory,
}: {
  prompt: string;
  key: string;
  model?: string;
  apiEndpoint: string;
  commandHistory?: string;
}) {
  const fullPrompt = getFullPrompt(prompt, commandHistory);
  const stream = await generateCompletion({
    prompt: fullPrompt,
    number: 1,
    key,
    model,
    apiEndpoint,
  });
  const iterableStream = streamToIterable(stream);
  return {
    readScript: readData(iterableStream, ...shellCodeExclusions),
    readInfo: readData(iterableStream, ...shellCodeExclusions),
  };
}

export async function generateCompletion({
  prompt,
  number = 1,
  key,
  model,
  apiEndpoint,
}: {
  prompt: string | ChatCompletionRequestMessage[];
  number?: number;
  model?: string;
  key: string;
  apiEndpoint: string;
}) {
  const openAi = getOpenAi(key, apiEndpoint);
  try {
    const completion = await openAi.createChatCompletion(
      {
        model: model || 'gpt-4o-mini',
        messages: Array.isArray(prompt)
          ? prompt
          : [{ role: 'user', content: prompt }],
        n: Math.min(number, 10),
        stream: true,
      },
      { responseType: 'stream' }
    );

    return completion.data as unknown as IncomingMessage;
  } catch (err) {
    const error = err as AxiosError;

    if (error.code === 'ENOTFOUND') {
      throw new KnownError(
        `Error connecting to ${error.request.hostname} (${error.request.syscall}). Are you connected to the internet?`
      );
    }

    const response = error.response;
    let message = response?.data as string | object | IncomingMessage;
    if (response && message instanceof IncomingMessage) {
      message = await streamToString(
        response.data as unknown as IncomingMessage
      );
      try {
        // Handle if the message is JSON. It should be but occasionally will
        // be HTML, so lets handle both
        message = JSON.parse(message);
      } catch (e) {
        // Ignore
      }
    }

    const messageString = message && JSON.stringify(message, null, 2);
    if (response?.status === 429) {
      throw new KnownError(
        dedent`
        Request to OpenAI failed with status 429. This is due to incorrect billing setup or excessive quota usage. Please follow this guide to fix it: https://help.openai.com/en/articles/6891831-error-code-429-you-exceeded-your-current-quota-please-check-your-plan-and-billing-details

        You can activate billing here: https://platform.openai.com/account/billing/overview . Make sure to add a payment method if not under an active grant from OpenAI.

        Full message from OpenAI:
      ` +
          '\n\n' +
          messageString +
          '\n'
      );
    } else if (response && message) {
      throw new KnownError(
        dedent`
        Request to OpenAI failed with status ${response?.status}:
      ` +
          '\n\n' +
          messageString +
          '\n'
      );
    }

    throw error;
  }
}

export async function getExplanation({
  script,
  key,
  model,
  apiEndpoint,
}: {
  script: string;
  key: string;
  model?: string;
  apiEndpoint: string;
}) {
  const prompt = getExplanationPrompt(script);
  const stream = await generateCompletion({
    prompt,
    key,
    number: 1,
    model,
    apiEndpoint,
  });
  const iterableStream = streamToIterable(stream);
  return { readExplanation: readData(iterableStream) };
}

export async function getRevision({
  prompt,
  code,
  key,
  model,
  apiEndpoint,
}: {
  prompt: string;
  code: string;
  key: string;
  model?: string;
  apiEndpoint: string;
}) {
  const fullPrompt = getRevisionPrompt(prompt, code);
  const stream = await generateCompletion({
    prompt: fullPrompt,
    key,
    number: 1,
    model,
    apiEndpoint,
  });
  const iterableStream = streamToIterable(stream);
  return {
    readScript: readData(iterableStream, ...shellCodeExclusions),
  };
}

export interface ReadDataOptions {
  isAnalysis?: boolean;
}

export const readData =
  (
    iterableStream: AsyncGenerator<string, void>,
    ...excluded: (RegExp | string | undefined)[]
  ) =>
  (writer: (data: string) => void, options?: ReadDataOptions): Promise<string> =>
    new Promise(async (resolve) => {
      let stopTextStream = false;
      let stoppedByUser = false;
      let data = '';
      let content = '';
      let dataStart = false;
      let buffer = ''; // This buffer will temporarily hold incoming data only for detecting the start


      const [excludedPrefix] = excluded;
      const stopTextStreamKeys = ['q', 'escape']; //Group of keys that stop the text stream

      // Set up keyboard input handling to allow stopping the stream
      process.stdin.setRawMode(true);

      // Store original SIGINT handler
      let originalSigintHandler: NodeJS.SignalsListener | undefined;

      // Handle Ctrl+C (SIGINT) for analysis
      if (options?.isAnalysis) {
        // Save the original handler if it exists
        const sigintHandlers = process.listeners('SIGINT');
        if (sigintHandlers.length > 0) {
          originalSigintHandler = sigintHandlers.pop() as NodeJS.SignalsListener;
          process.removeAllListeners('SIGINT');
        }

        // Add our own SIGINT handler
        process.on('SIGINT', () => {
          stoppedByUser = true;
          stopTextStream = true;

          // Write a message that the analysis was stopped but is considered complete
          writer('\n\n' + yellow(i18n.t('Analysis stopped')) + '\n');

          // Resolve with what we have so far
          resolve(data);
        });
      }

      process.stdin.on('keypress', (_, data) => {
        if (stopTextStreamKeys.includes(data.name)) {
          stopTextStream = true;
        }
      });

      // Show a message that the user can press Ctrl+C to stop the analysis

      // Cleanup function to restore original handlers
      const cleanup = () => {
        if (options?.isAnalysis) {
          // Remove our SIGINT handler and restore the original one if it exists
          process.removeAllListeners('SIGINT');
          if (originalSigintHandler) {
            process.on('SIGINT', originalSigintHandler as NodeJS.SignalsListener);
          }
        }
      };

      for await (const chunk of iterableStream) {
        const payloads = chunk.toString().split('\n\n');
        for (const payload of payloads) {
          if (payload.includes('[DONE]') || stopTextStream) {
            dataStart = false;
            cleanup();

            // If stopped by user, we consider it complete
            if (stoppedByUser) {
              writer('\n' + yellow(i18n.t('Analysis complete')) + '\n');
            }

            resolve(data);
            return;
          }

          if (payload.startsWith('data:')) {
            content = parseContent(payload);
            // Use buffer only for start detection
            if (!dataStart) {
              // Append content to the buffer
              buffer += content;
              if (buffer.match(excludedPrefix ?? '')) {
                dataStart = true;
                // Clear the buffer once it has served its purpose
                buffer = '';
                if (excludedPrefix) break;
              }
            }

            if (dataStart && content) {
              const contentWithoutExcluded = stripRegexPatterns(
                content,
                excluded
              );

              data += contentWithoutExcluded;
              writer(contentWithoutExcluded);
            }
          }
        }
      }

      function parseContent(payload: string): string {
        const data = payload.replaceAll(/(\n)?^data:\s*/g, '');
        try {
          const delta = JSON.parse(data.trim());
          return delta.choices?.[0]?.delta?.content ?? '';
        } catch (error) {
          return `Error with JSON.parse and ${payload}.\n${error}`;
        }
      }

      // Make sure we clean up before resolving
      cleanup();
      resolve(data);
    });

function getExplanationPrompt(script: string) {
  return dedent`
    ${explainScript} Please reply in ${i18n.getCurrentLanguagenName()}

    The script: ${script}
  `;
}

function getShellDetails() {
  const shellDetails = detectShell();

  return dedent`
      The target shell is ${shellDetails}
  `;
}
const shellDetails = getShellDetails();

const explainScript = dedent`
  Please provide a clear, concise description of the script, using minimal words. Outline the steps in a list format.
`;

function getOperationSystemDetails() {
  const os = require('@nexssp/os/legacy');
  return os.name();
}
const generationDetails = dedent`
    Only reply with the single line command surrounded by three backticks. It must be able to be directly run in the target shell. Do not include any other text.

    Make sure the command runs on ${getOperationSystemDetails()} operating system.
  `;

function getFullPrompt(prompt: string, commandHistory?: string) {
  return dedent`
    Create a single line command that one can enter in a terminal and run, based on what is specified in the prompt.

    ${shellDetails}

    ${generationDetails}

    ${explainInSecondRequest ? '' : explainScript}

    ${commandHistory ? `# Recent Command History\n${commandHistory}\n\nConsider the above command history when generating a command.\n` : ''}

    The prompt is: ${prompt}
  `;
}

function getRevisionPrompt(prompt: string, code: string) {
  return dedent`
    Update the following script based on what is asked in the following prompt.

    The script: ${code}

    The prompt: ${prompt}

    ${generationDetails}
  `;
}

export async function getModels(
  key: string,
  apiEndpoint: string
): Promise<Model[]> {
  const openAi = getOpenAi(key, apiEndpoint);
  const response = await openAi.listModels();

  return response.data.data.filter((model) => model.object === 'model');
}

/**
 * Generate an analysis of a failed command with suggestions for fixing it
 * @param commandResult The failed command result
 * @param key OpenAI API key
 * @param model OpenAI model to use
 * @param apiEndpoint OpenAI API endpoint
 * @returns Object with a function to read the analysis
 */
export async function getCommandAnalysis({
  commandResult,
  commandHistory,
  key,
  apiEndpoint,
  model,
  originalPrompt,
}: {
  commandResult: CommandResult;
  commandHistory: string;
  key: string;
  apiEndpoint: string;
  model?: string;
  originalPrompt?: string;
}) {
  const prompt = getCommandAnalysisPrompt(commandResult, commandHistory, originalPrompt);
  const stream = await generateCompletion({
    prompt,
    key,
    number: 1,
    model,
    apiEndpoint,
  });
  const iterableStream = streamToIterable(stream);
  return {
    readAnalysis: (writer: (data: string) => void) =>
      readData(iterableStream)(writer, { isAnalysis: true })
  };
}

/**
 * Create a prompt for analyzing a failed command
 * @param commandResult The failed command result
 * @param commandHistory String representation of command history
 * @param originalPrompt The original user prompt that generated the command (if available)
 * @returns Prompt for the AI
 */
function getCommandAnalysisPrompt(commandResult: CommandResult, commandHistory: string, originalPrompt?: string) {
  return dedent`
    I ran a shell command that failed. Please analyze the error and provide suggestions to fix it.

    ${originalPrompt ? `# Original Intent\nMy original request was: "${originalPrompt}"\n` : ''}

    # Current Failed Command
    Command: ${commandResult.command}
    Exit code: ${commandResult.exitCode}
    ${commandResult.stdout ? `\nSTDOUT:\n${commandResult.stdout}` : ''}
    ${commandResult.stderr ? `\nSTDERR:\n${commandResult.stderr}` : ''}

    # Recent Command History
    ${commandHistory}

    Based on my ${originalPrompt ? 'original intent, ' : ''}recent command history and the current failed command, please:

    1. Analyze what went wrong with the current command
    2. Consider the context of my previous commands to understand what I'm trying to accomplish
    3. Provide specific suggestions to fix the issue
    4. If appropriate, suggest an improved command that would work better
    5. If there are multiple possible solutions, explain the trade-offs

    Make your analysis contextual - use the information from my command history to provide more relevant suggestions.
    If you see a pattern of errors or attempts in my command history, address those specifically.

    Please reply in ${i18n.getCurrentLanguagenName()}
  `;
}
