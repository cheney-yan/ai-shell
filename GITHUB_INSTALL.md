# Installing ai-shell directly from GitHub

This fork of ai-shell has been configured to be installable directly from GitHub.

## Installation Options

### Option 1: Install globally using npm

```bash
npm install -g github:cheney-yan/ai-shell
```

This will install the CLI globally on your system, making the `ai` and `ai-shell` commands available everywhere.

### Option 2: Run directly with npx (without installing)

```bash
npx github:cheney-yan/ai-shell
```

Or with a prompt:

```bash
npx github:cheney-yan/ai-shell "list all log files"
```

## Configuration

After installation, you'll need to configure your OpenAI API key:

```bash
ai config set OPENAI_KEY=<your token>
```

This will create a `.ai-shell` file in your home directory.

## Usage

```bash
ai <prompt>
```

For example:

```bash
ai list all log files
```

## How This Fork Differs from the Original

This fork adds:

1. A `prepare` script that automatically builds the package during installation
2. A `postinstall` script that displays a helpful message after installation
3. Updated repository URL to point to this fork

These changes make it possible to install the package directly from GitHub without having to manually build it.

## Credits

All credit for the original ai-shell goes to the [Builder.io team](https://github.com/BuilderIO/ai-shell).
