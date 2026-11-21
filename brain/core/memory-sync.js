// 记忆同步：把她的记忆、人设、配置、聊天归档提交到私密 GitHub 仓库。
// 本地只留一个 git 工作目录（同步用），不放第二份备份副本。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function git(cwd, args, timeout = 120000) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe', timeout });
}

/**
 * @param {object} options
 * @param {string} options.workDir   本地 git 工作目录
 * @param {Array<[string,string]>} options.sources  [源文件, 仓库内文件名]
 * @param {string} options.remote    远端地址
 * @param {string} [options.branch]
 * @param {boolean} [options.ensureRemote]
 */
export function syncMemoryRepo({ workDir, sources = [], remote, branch = 'main', ensureRemote = true, log = () => {} }) {
  const result = { copied: 0, committed: false, pushed: false, error: '' };

  try {
    fs.mkdirSync(workDir, { recursive: true });

    for (const [source, name] of sources) {
      if (!source) continue;
      try {
        if (!fs.existsSync(source)) continue;
        fs.copyFileSync(source, path.join(workDir, name));
        result.copied += 1;
      } catch (error) {
        log(`memory sync copy failed ${path.basename(source)}: ${error?.message ?? error}`);
      }
    }

    if (!fs.existsSync(path.join(workDir, '.git'))) {
      git(workDir, ['init', '-b', branch]);
      log(`memory sync: git init ${workDir}`);
    }
    if (ensureRemote && remote) {
      try {
        git(workDir, ['remote', 'get-url', 'origin']);
      } catch {
        git(workDir, ['remote', 'add', 'origin', remote]);
        log('memory sync: remote added');
      }
    }

    git(workDir, ['add', '-A']);
    const status = git(workDir, ['status', '--porcelain']).trim();
    if (status) {
      const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
      git(workDir, [
        '-c', 'user.name=fish-memory',
        '-c', 'user.email=fish-memory@local',
        'commit', '-m', `记忆备份 ${stamp}`,
      ]);
      result.committed = true;
    }

    // 没有新提交时 push 会返回 Everything up-to-date，同样算成功
    git(workDir, ['push', 'origin', branch]);
    result.pushed = true;
    return result;
  } catch (error) {
    result.error = String(error?.stderr ?? error?.message ?? error).slice(0, 400);
    log(`memory sync failed: ${result.error}`);
    return result;
  }
}

/** 最近一次同步状态（给面板/脚本用）。 */
export function memoryRepoStatus(workDir) {
  try {
    const log = execFileSync('git', ['log', '-1', '--format=%h %ad %s', '--date=format:%Y-%m-%d %H:%M'], {
      cwd: workDir, encoding: 'utf8', stdio: 'pipe',
    }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: workDir, encoding: 'utf8', stdio: 'pipe' }).trim();
    return { ok: true, last: log, pending: dirty ? dirty.split('\n').length : 0 };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}
