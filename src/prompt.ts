import * as p from '@clack/prompts';
import { execaCommand } from 'execa';
import { cyan, dim, red, yellow } from 'kolorist';
import {
  getExplanation,
  getRevision,
  getScriptAndInfo,
  getCommandAnalysis,
} from './helpers/completion';
import { getConfig } from './helpers/config';
import { projectName } from './helpers/constants';
import { KnownError } from './helpers/error';
import clipboardy from 'clipboardy';
import i18n from './helpers/i18n';
import { appendToShellHistory } from './helpers/shell-history';
import {
  CommandResult,
  addToCommandHistory,
  formatCommandHistoryForAI
} from './helpers/command-history';

const init = async () => {
  try {
    const { LANGUAGE: language } = await getConfig();
    i18n.setLanguage(language);
  } catch {
    i18n.setLanguage('en');
  }
};

const examples: string[] = [];
const initPromise = init();
initPromise.then(() => {
  examples.push(i18n.t('delete all log files'));
  examples.push(i18n.t('list js files'));
  examples.push(i18n.t('fetch me a random joke'));
  examples.push(i18n.t('list all commits'));
});

const sample = <T>(arr: T[]): T | undefined => {
  const len = arr == null ? 0 : arr.length;
  return len ? arr[Math.floor(Math.random() * len)] : undefined;
};

async function runScript(script: string, key?: string, model?: string, apiEndpoint?: string, originalPrompt?: string) {
  p.outro(`${i18n.t('Running')}: ${script}`);
  console.log('');

  try {
    // Execute command with pipe instead of inherit to capture output
    const result = await execaCommand(script, {
      stdio: 'pipe',
      shell: process.env.SHELL || true,
      reject: false, // Don't throw on non-zero exit code
    });

    // Print the output to console
    if (result.stdout) {
      process.stdout.write(result.stdout);
      if (!result.stdout.endsWith('\n')) {
        console.log('');
      }
    }

    if (result.stderr) {
      process.stderr.write(result.stderr);
      if (!result.stderr.endsWith('\n')) {
        console.log('');
      }
    }

    // Store command in history
    const commandResult: CommandResult = {
      command: script,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timestamp: Date.now()
    };

    addToCommandHistory(commandResult);
    appendToShellHistory(script);

    // If command failed and we have API credentials, analyze the failure
    if (result.exitCode !== 0 && key && apiEndpoint) {
      await analyzeFailedCommand(commandResult, key, apiEndpoint, model, originalPrompt);
    }

    return result.exitCode;
  } catch (error: any) {
    // This should only happen for errors in executing the command itself, not command failures
    console.error(`\n${red('✖')} ${error.message}`);
    return 1;
  }
}

/**
 * Analyze a failed command using AI and provide suggestions
 */
async function analyzeFailedCommand(
  commandResult: CommandResult,
  key: string,
  apiEndpoint: string,
  model?: string,
  originalPrompt?: string
) {
  console.log('');
  console.log(yellow('Command failed with exit code ' + commandResult.exitCode));

  const spin = p.spinner();
  spin.start(i18n.t('Analyzing error...'));

  try {
    const commandHistory = formatCommandHistoryForAI();
    const { readAnalysis } = await getCommandAnalysis({
      commandResult,
      commandHistory,
      key,
      apiEndpoint,
      model,
      originalPrompt,
    });

    spin.stop(yellow(i18n.t('Error analysis:')));
    console.log('');
    await readAnalysis(process.stdout.write.bind(process.stdout));
    console.log('');
    console.log('');
  } catch (error: any) {
    spin.stop(red(i18n.t('Error analysis failed')));
    console.error(`\n${red('✖')} ${error.message}`);
  }
}

async function getPrompt(prompt?: string) {
  await initPromise;
  const group = p.group(
    {
      prompt: () =>
        p.text({
          message: i18n.t('What would you like me to do?'),
          placeholder: `${i18n.t('e.g.')} ${sample(examples)}`,
          initialValue: prompt,
          defaultValue: i18n.t('Say hello'),
          validate: (value) => {
            if (!value) return i18n.t('Please enter a prompt.');
          },
        }),
    },
    {
      onCancel: () => {
        p.cancel(i18n.t('Goodbye!'));
        process.exit(0);
      },
    }
  );
  return (await group).prompt;
}

async function promptForRevision() {
  const group = p.group(
    {
      prompt: () =>
        p.text({
          message: i18n.t('What would you like me to change in this script?'),
          placeholder: i18n.t('e.g. change the folder name'),
          validate: (value) => {
            if (!value) return i18n.t('Please enter a prompt.');
          },
        }),
    },
    {
      onCancel: () => {
        p.cancel(i18n.t('Goodbye!'));
        process.exit(0);
      },
    }
  );
  return (await group).prompt;
}

export async function prompt({
  usePrompt,
  silentMode,
}: { usePrompt?: string; silentMode?: boolean } = {}) {
  const {
    OPENAI_KEY: key,
    SILENT_MODE,
    OPENAI_API_ENDPOINT: apiEndpoint,
    MODEL: model,
  } = await getConfig();
  const skipCommandExplanation = silentMode || SILENT_MODE;

  console.log('');
  p.intro(`${cyan(`${projectName}`)}`);

  const thePrompt = usePrompt || (await getPrompt());
  const spin = p.spinner();
  spin.start(i18n.t(`Loading...`));
  const commandHistory = formatCommandHistoryForAI();
  const { readInfo, readScript } = await getScriptAndInfo({
    prompt: thePrompt,
    key,
    model,
    apiEndpoint,
    commandHistory,
  });
  spin.stop(`${i18n.t('Your script')}:`);
  console.log('');
  const script = await readScript(process.stdout.write.bind(process.stdout));
  console.log('');
  console.log('');
  console.log(dim('•'));
  if (!skipCommandExplanation) {
    spin.start(i18n.t(`Getting explanation...`));
    const info = await readInfo(process.stdout.write.bind(process.stdout));
    if (!info) {
      const { readExplanation } = await getExplanation({
        script,
        key,
        model,
        apiEndpoint,
      });
      spin.stop(`${i18n.t('Explanation')}:`);
      console.log('');
      await readExplanation(process.stdout.write.bind(process.stdout));
      console.log('');
      console.log('');
      console.log(dim('•'));
    }
  }

  await runOrReviseFlow(script, key, model, apiEndpoint, silentMode, thePrompt);
}

async function runOrReviseFlow(
  script: string,
  key: string,
  model: string,
  apiEndpoint: string,
  silentMode?: boolean,
  originalPrompt?: string
) {
  const emptyScript = script.trim() === '';

  const answer: symbol | (() => any) = await p.select({
    message: emptyScript
      ? i18n.t('Revise this script?')
      : i18n.t('Run this script?'),
    options: [
      ...(emptyScript
        ? []
        : [
            {
              label: '✅ ' + i18n.t('Yes'),
              hint: i18n.t('Lets go!'),
              value: async () => {
                await runScript(script, key, model, apiEndpoint, originalPrompt);
              },
            },
            {
              label: '📝 ' + i18n.t('Edit'),
              hint: i18n.t('Make some adjustments before running'),
              value: async () => {
                const newScript = await p.text({
                  message: i18n.t('you can edit script here:'),
                  initialValue: script,
                });
                if (!p.isCancel(newScript)) {
                  await runScript(newScript, key, model, apiEndpoint, originalPrompt);
                }
              },
            },
          ]),
      {
        label: '🔁 ' + i18n.t('Revise'),
        hint: i18n.t('Give feedback via prompt and get a new result'),
        value: async () => {
          await revisionFlow(script, key, model, apiEndpoint, silentMode, originalPrompt);
        },
      },
      {
        label: '📋 ' + i18n.t('Copy'),
        hint: i18n.t('Copy the generated script to your clipboard'),
        value: async () => {
          await clipboardy.write(script);
          p.outro(i18n.t('Copied to clipboard!'));
        },
      },
      {
        label: '❌ ' + i18n.t('Cancel'),
        hint: i18n.t('Exit the program'),
        value: () => {
          p.cancel(i18n.t('Goodbye!'));
          process.exit(0);
        },
      },
    ],
  });

  if (typeof answer === 'function') {
    await answer();
  }
}

async function revisionFlow(
  currentScript: string,
  key: string,
  model: string,
  apiEndpoint: string,
  silentMode?: boolean,
  originalPrompt?: string
) {
  const revision = await promptForRevision();
  const spin = p.spinner();
  spin.start(i18n.t(`Loading...`));
  const { readScript } = await getRevision({
    prompt: revision,
    code: currentScript,
    key,
    model,
    apiEndpoint,
  });
  spin.stop(`${i18n.t(`Your new script`)}:`);

  console.log('');
  const script = await readScript(process.stdout.write.bind(process.stdout));
  console.log('');
  console.log('');
  console.log(dim('•'));

  if (!silentMode) {
    const infoSpin = p.spinner();
    infoSpin.start(i18n.t(`Getting explanation...`));
    const { readExplanation } = await getExplanation({
      script,
      key,
      model,
      apiEndpoint,
    });

    infoSpin.stop(`${i18n.t('Explanation')}:`);
    console.log('');
    await readExplanation(process.stdout.write.bind(process.stdout));
    console.log('');
    console.log('');
    console.log(dim('•'));
  }

  await runOrReviseFlow(script, key, model, apiEndpoint, silentMode, originalPrompt);
}

export const parseAssert = (name: string, condition: any, message: string) => {
  if (!condition) {
    throw new KnownError(
      `${i18n.t('Invalid config property')} ${name}: ${message}`
    );
  }
};
