import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** Project reviewed text changes into another frozen worktree, never the user's checkout. */
export function materializeInputs(cwd, snapshots) {
    const files = new Map();
    for (const snapshot of snapshots)
        for (const file of snapshot.data.files) {
            if (file.kind === 'symlink')
                throw new Error('INPUT_SYMLINK_UNSUPPORTED: 上游符号链接不能作为隐式输入');
            const prior = files.get(file.path);
            if (prior && (prior.kind !== file.kind || prior.sha256 !== file.sha256 || prior.mode !== file.mode))
                throw new Error(`INPUT_CONFLICT: 上游文件版本冲突 ${file.path}`);
            if (file.kind === 'file' && (typeof file.content !== 'string' || hash(Buffer.from(file.content)) !== file.sha256))
                throw new Error('INPUT_CONTENT_INVALID: 上游文本无法无损还原');
            files.set(file.path, file);
        }
    // Check every target before writing any. A baseline symlink must never redirect a write.
    const root = realpathSync(cwd);
    const targets = [...files].map(([path, file]) => {
        const target = resolve(root, path), rel = relative(root, target);
        if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel) || rel.split(sep).includes('.git'))
            throw new Error('INPUT_PATH_ESCAPE');
        let cursor = root;
        for (const part of rel.split(sep)) {
            cursor = resolve(cursor, part);
            try {
                if (lstatSync(cursor).isSymbolicLink())
                    throw new Error('INPUT_PATH_SYMLINK');
            }
            catch (error) {
                if (error.code !== 'ENOENT')
                    throw error;
            }
        }
        return { target, file };
    });
    for (const { target, file } of targets) {
        if (file.kind === 'deleted') {
            if (existsSync(target))
                unlinkSync(target);
            continue;
        }
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, file.content, { mode: file.mode & 0o777 });
        chmodSync(target, file.mode & 0o777);
    }
    return files;
}
/** An inherited input is exempt from ownership only while its bytes and mode are unchanged. */
export function unchangedInput(cwd, path, expected) {
    if (!expected)
        return false;
    const target = resolve(cwd, path);
    try {
        const stat = lstatSync(target);
        return expected.kind === 'file' && stat.isFile() && (stat.mode & 0o777) === (expected.mode & 0o777) && hash(readFileSync(target)) === expected.sha256;
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return expected.kind === 'deleted';
        throw error;
    }
}
