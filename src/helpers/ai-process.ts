/**
 * This file is used as a child process to handle AI API calls
 * so the main process can respond to Ctrl+C in real time.
 */
import { generateCompletion } from './completion';
import { streamToIterable } from './stream-to-iterable';
import { yellow } from 'kolorist';

console.log(yellow('DEBUG: AI process started'));

// Listen for messages from the parent process
process.on('message', async (message: {
  type: string;
  prompt: string;
  key: string;
  model?: string;
  apiEndpoint: string;
  number?: number;
}) => {
  if (!process.send) {
    console.error(yellow('DEBUG: No IPC channel available'));
    process.exit(1);
  }

  console.log(yellow(`DEBUG: AI process received message of type: ${message.type}`));

  if (message.type === 'generate') {
    try {
      console.log(yellow('DEBUG: AI process generating completion'));

      // Generate the completion
      const stream = await generateCompletion({
        prompt: message.prompt,
        number: message.number || 1,
        key: message.key,
        model: message.model,
        apiEndpoint: message.apiEndpoint,
      });

      console.log(yellow('DEBUG: AI process got stream, converting to iterable'));

      // Convert the stream to an iterable
      const iterableStream = streamToIterable(stream);

      console.log(yellow('DEBUG: AI process processing stream'));

      // Process the stream and send chunks back to the parent process
      for await (const chunk of iterableStream) {
        console.log(yellow('DEBUG: AI process sending chunk'));
        process.send({
          type: 'chunk',
          data: chunk.toString(),
        });
      }

      console.log(yellow('DEBUG: AI process done processing stream'));

      // Signal that we're done
      process.send({
        type: 'done',
      });
    } catch (error: any) {
      console.error(yellow('DEBUG: AI process error:'), error);

      // Send the error back to the parent process
      process.send({
        type: 'error',
        error: {
          message: error.message,
          stack: error.stack,
          name: error.name,
          code: error.code,
        },
      });
    }
  } else {
    console.error(yellow(`DEBUG: AI process received unknown message type: ${message.type}`));
  }
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error(yellow('DEBUG: AI process uncaught exception:'), error);

  if (process.send) {
    process.send({
      type: 'error',
      error: {
        message: error.message,
        stack: error.stack,
        name: error.name,
        code: error.code,
      },
    });
  }

  // Exit with error code
  process.exit(1);
});

// Signal that we're ready
if (process.send) {
  console.log(yellow('DEBUG: AI process sending ready message'));
  process.send({
    type: 'ready',
  });
}
