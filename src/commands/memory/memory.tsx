import { mkdir, writeFile } from 'fs/promises';
import * as React from 'react';
import type { CommandResultDisplay } from '../../commands.js';
import { Dialog } from '../../components/design-system/Dialog.js';
import { MemoryFileSelector } from '../../components/memory/MemoryFileSelector.js';
import { getRelativeMemoryPath } from '../../components/memory/MemoryUpdateNotification.js';
import { Box, Link, Text } from '../../ink.js';
import type { LocalJSXCommandCall } from '../../types/command.js';
import { clearMemoryFileCaches, getMemoryFiles } from '../../utils/claudemd.js';
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js';
import { getErrnoCode } from '../../utils/errors.js';
import { logError } from '../../utils/log.js';
import { editFileInEditor } from '../../utils/promptEditor.js';

type OpenMemoryFileDeps = {
  claudeConfigHomeDir?: string;
  editFileInEditorImpl?: typeof editFileInEditor;
  env?: NodeJS.ProcessEnv;
  mkdirImpl?: typeof mkdir;
  writeFileImpl?: typeof writeFile;
};

export function buildMemoryEditorHint(env: NodeJS.ProcessEnv = process.env): string {
  if (env.VISUAL) {
    return `> Using $VISUAL="${env.VISUAL}". To change editor, set $EDITOR or $VISUAL environment variable.`;
  }
  if (env.EDITOR) {
    return `> Using $EDITOR="${env.EDITOR}". To change editor, set $EDITOR or $VISUAL environment variable.`;
  }
  return '> To use a different editor, set the $EDITOR or $VISUAL environment variable.';
}

export async function openMemoryFile(
  memoryPath: string,
  deps: OpenMemoryFileDeps = {},
): Promise<string> {
  const claudeConfigHomeDir = deps.claudeConfigHomeDir ?? getClaudeConfigHomeDir();
  if (memoryPath.includes(claudeConfigHomeDir)) {
    await (deps.mkdirImpl ?? mkdir)(claudeConfigHomeDir, {
      recursive: true
    });
  }
  try {
    await (deps.writeFileImpl ?? writeFile)(memoryPath, '', {
      encoding: 'utf8',
      flag: 'wx'
    });
  } catch (e: unknown) {
    if (getErrnoCode(e) !== 'EEXIST') {
      throw e;
    }
  }
  await (deps.editFileInEditorImpl ?? editFileInEditor)(memoryPath);
  return `Opened memory file at ${getRelativeMemoryPath(memoryPath)}\n\n${buildMemoryEditorHint(deps.env ?? process.env)}`;
}
function MemoryCommand({
  onDone
}: {
  onDone: (result?: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
}): React.ReactNode {
  const handleSelectMemoryFile = async (memoryPath: string) => {
    try {
      const result = await openMemoryFile(memoryPath);
      onDone(result, {
        display: 'system'
      });
    } catch (error) {
      logError(error);
      onDone(`Error opening memory file: ${error}`);
    }
  };
  const handleCancel = () => {
    onDone('Cancelled memory editing', {
      display: 'system'
    });
  };
  return <Dialog title="Memory" onCancel={handleCancel} color="remember">
      <Box flexDirection="column">
        <React.Suspense fallback={null}>
          <MemoryFileSelector onSelect={handleSelectMemoryFile} onCancel={handleCancel} />
        </React.Suspense>

        <Box marginTop={1}>
          <Text dimColor>
            Learn more: <Link url="https://code.claude.com/docs/en/memory" />
          </Text>
        </Box>
      </Box>
    </Dialog>;
}
export const call: LocalJSXCommandCall = async onDone => {
  // Clear + prime before rendering — Suspense handles the unprimed case,
  // but awaiting here avoids a fallback flash on initial open.
  clearMemoryFileCaches();
  await getMemoryFiles();
  return <MemoryCommand onDone={onDone} />;
};
