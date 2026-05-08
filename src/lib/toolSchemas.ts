import type { FunctionDeclaration } from '@google/genai';
import { SERVER_COMMAND } from './constants';

export const READ_FILE_TOOL_NAME = 'read_file';
export const WRITE_FILE_TOOL_NAME = 'write_file';
export const EDIT_TOOL_NAME = 'replace';
export const LIST_DIRECTORY_TOOL_NAME = 'list_directory';
export const SHELL_TOOL_NAME = 'run_shell_command';

export const TOOL_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: READ_FILE_TOOL_NAME,
    description:
      "Reads and returns a file from /workspace/site. Use start_line and end_line for targeted reads instead of reading whole files.",
    parametersJsonSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description:
            'The path to read, relative to /workspace/site or rooted at /workspace/site.',
        },
        start_line: {
          type: 'number',
          description: 'Optional 1-based line number to start reading from.',
        },
        end_line: {
          type: 'number',
          description:
            'Optional 1-based line number to end reading at, inclusive.',
        },
      },
      required: ['file_path'],
    },
  },
  {
    name: WRITE_FILE_TOOL_NAME,
    description:
      "Writes complete file content under /workspace/site, creating missing parent directories. Use this for new or small static website files. The content must be complete and must not contain placeholders.",
    parametersJsonSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description:
            'The file path to write, relative to /workspace/site or rooted at /workspace/site.',
        },
        content: {
          type: 'string',
          description:
            'The complete file content. Do not use placeholders or omissions.',
        },
      },
      required: ['file_path', 'content'],
    },
  },
  {
    name: EDIT_TOOL_NAME,
    description:
      "Performs an exact string replacement in a file under /workspace/site. If old_string is empty and the file does not exist, creates a new file with new_string.",
    parametersJsonSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description:
            'The file path to edit, relative to /workspace/site or rooted at /workspace/site.',
        },
        old_string: {
          type: 'string',
          description:
            'The exact string to replace. Use an empty string only when creating a brand new file.',
        },
        new_string: {
          type: 'string',
          description:
            'The exact replacement text. Do not use placeholders or omissions.',
        },
        allow_multiple: {
          type: 'boolean',
          description:
            'If true, replace every occurrence. If false or omitted, exactly one occurrence must match.',
        },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
  {
    name: LIST_DIRECTORY_TOOL_NAME,
    description:
      'Lists files and directories under /workspace/site so the model can see what it has created.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        dir_path: {
          type: 'string',
          description:
            'Optional directory path relative to /workspace/site. Defaults to /workspace/site.',
        },
      },
    },
  },
  {
    name: SHELL_TOOL_NAME,
    description: `Runs an arbitrary shell command in the in-browser micro-VM (Debian, /workspace/site by default). Anything bash can run is fair game: pwd, ls, find, cat, grep, sed, awk, mkdir, mv, rm, chmod, ps, kill, python3, node, npm, etc. The static web server is started with "${SERVER_COMMAND}". Prefer list_directory / read_file / write_file / replace for routine file ops; use run_shell_command for anything else.`,
    parametersJsonSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The command to run.',
        },
        dir_path: {
          type: 'string',
          description:
            'Optional working directory relative to /workspace/site. Defaults to /workspace/site.',
        },
        is_background: {
          type: 'boolean',
          description:
            'Whether to run as a background command. The static web server is always run in the background.',
        },
      },
      required: ['command'],
    },
  },
];
