import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite } from './store.js';
import { contentDigest } from './core/index.js';
/** Checksummed per-run snapshots; backup fallback is visibly interrupted. */
export class ExecutionJournal {
    root;
    constructor(root) { this.root = join(root, 'execution-journal'); }
    path(runId) { return join(this.root, createHash('sha256').update(runId).digest('hex') + '.json'); }
    decode(file) {
        const envelope = JSON.parse(readFileSync(file, 'utf8'));
        const d = envelope.data;
        const text = (v) => typeof v === 'string' && v.length > 0;
        if (!d || ![d.runId, d.workspaceId, d.workflowId, d.repoPath, d.ownerToken, d.startedAt].every(text) || !/^[a-f0-9]{64}$/.test(d.planHash) || !/^[a-f0-9]{40}$/.test(d.baseSha) || !Number.isSafeInteger(d.revision) || d.revision < 1 || !['running', 'validated', 'failed', 'cancelled', 'interrupted'].includes(d.state) || !Array.isArray(d.tasks) || d.tasks.some((t) => !text(t.nodeId) || !text(t.cwd) || !text(t.attemptId) || !Number.isSafeInteger(t.number) || t.number < 1 || typeof t.active !== 'boolean' || !['implementation', 'verification', 'review', 'validated', 'failed', 'cancelled', 'interrupted'].includes(t.phase)) || envelope.sha256 !== contentDigest(envelope.data) || envelope.data.schemaVersion !== 1 || !Array.isArray(envelope.data.tasks) || !Number.isSafeInteger(envelope.data.sequence))
            throw new Error('EXECUTION_JOURNAL_CORRUPT');
        return envelope.data;
    }
    read(runId) {
        const file = this.path(runId);
        if (!existsSync(file))
            return null;
        try {
            const record = this.decode(file);
            if (record.runId !== runId)
                throw new Error('EXECUTION_ID_MISMATCH');
            return record;
        }
        catch {
            if (!existsSync(file + '.previous'))
                throw new Error('EXECUTION_JOURNAL_CORRUPT: 执行记录校验失败，原文件保留');
            const record = this.decode(file + '.previous');
            if (record.runId !== runId)
                throw new Error('EXECUTION_ID_MISMATCH');
            return { ...record, state: 'interrupted', reason: '执行快照损坏；已读取上一个完整快照，需明确恢复', tasks: record.tasks.map(task => ({ ...task, active: false, phase: task.active ? 'interrupted' : task.phase })) };
        }
    }
    list() {
        if (!existsSync(this.root))
            return [];
        return readdirSync(this.root).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(name => {
            try {
                const record = this.decode(join(this.root, name));
                if (this.path(record.runId) !== join(this.root, name))
                    throw new Error('EXECUTION_ID_MISMATCH');
                return record;
            }
            catch {
                const backup = join(this.root, name + '.previous');
                if (!existsSync(backup))
                    throw new Error('EXECUTION_JOURNAL_CORRUPT: 执行记录校验失败，不能判为空记录');
                const record = this.decode(backup);
                if (this.path(record.runId) !== join(this.root, name))
                    throw new Error('EXECUTION_ID_MISMATCH');
                return this.read(record.runId);
            }
        });
    }
    write(record) {
        const file = this.path(record.runId);
        if (existsSync(file)) {
            try {
                this.decode(file);
                atomicWrite(file + '.previous', readFileSync(file, 'utf8'));
            }
            catch (error) {
                if (error.message.includes('EXECUTION_JOURNAL_CORRUPT') || error instanceof SyntaxError)
                    copyFileSync(file, file + '.corrupt-' + randomUUID());
                else
                    throw error;
            }
        }
        record.sequence++;
        atomicWrite(file, JSON.stringify({ data: record, sha256: contentDigest(record) }) + '\n');
    }
    assertAttempt(record, attempt) {
        const saved = this.read(record.runId);
        if (saved?.state !== 'running' || saved.ownerToken !== record.ownerToken || !saved.tasks.some(task => task.nodeId === attempt.nodeId && task.attemptId === attempt.attemptId && task.active))
            throw new Error('STALE_ATTEMPT: 已撤销的执行不能提交回执');
    }
    recover(ownerToken) {
        const recovered = [];
        for (const saved of this.list()) {
            if (saved.state !== 'running' && !(saved.state === 'interrupted' && (saved.tasks.some(task => task.active) || saved.reason?.startsWith('执行快照损坏'))))
                continue;
            if (saved.ownerToken === ownerToken)
                continue;
            const record = { ...saved, state: 'interrupted', reason: '原执行实例已退出；工作树保留，明确恢复后使用新的工作树', tasks: saved.tasks.map(task => ({ ...task, active: false, phase: task.active ? 'interrupted' : task.phase })) };
            this.write(record);
            recovered.push(record);
        }
        return recovered;
    }
    summary(workspaceId) { return this.list().filter(record => record.workspaceId === workspaceId).sort((a, b) => a.startedAt.localeCompare(b.startedAt)).slice(-100); }
}
