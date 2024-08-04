import { execSync } from 'child_process';
import { existsSync, mkdirSync, unlinkSync } from 'fs';
import { dirname, resolve } from 'path';
import { dirSync } from 'tmp';

export function ensureQwikProject() {
  console.log(getTmpDirSync());
}

function getTmpDirSync() {
  const customPath = process.env.TMP_E2E_PATH && resolve(process.cwd(), process.env.TMP_E2E_PATH);
  if (!customPath) {
    return dirSync({ prefix: 'qwik_e2e' }).name;
  }
  if (existsSync(customPath)) {
    // we don't want to remove the folder implicitly because it can accidentally be set to a wrong location with unrelated stuff
    throw new Error(
      `Custom directory "${customPath}" already exists. Please remove it manually and rerun the process.`
    );
  }
  mkdirSync(customPath);
  return customPath;
}


function runCreateQwikCommand(localTmpDir: string, args?: string) {
    return execSync(
      `npm create qwik`,
      {
        cwd: localTmpDir,
      }
    );
  }