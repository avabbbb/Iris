// 用户审批：把“需要用户确认”的参数（capture.ui / run.archive 的 confirmed、run.start 的 budgetConfirmed）
// 从模型可填的布尔值变成执行端校验的一次性审批，绑定 run、命令与参数摘要。
//
// 为什么不用 SQLite 表：pipeline 表结构与 Rust Runtime 共用一份迁移，加表是独立的跨语言迁移；
// 审批是短命、单次消费的状态，落在 pipeline home 下的 JSON 文件即可被 agent 进程与 MCP 进程共同看到。
//
// 流程：
//   1. 不可信入口（内置 Agent、MCP）调用确认型命令 → 执行端忽略模型填的确认字段，
//      返回 CONFIRMATION_REQUIRED，details.approval 带 approvalId 与摘要（状态 pending）。
//   2. 用户在 UI 上同意 → 宿主调用 grant(approvalId)（HTTP POST /pipeline/approvals/:id/grant，不在任何 Agent 工具面上）。
//   3. 调用方用相同参数重试 → 执行端按 command + runId + argsDigest 找到 granted 审批并消费（一次性）。
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const APPROVAL_TTL_MS = 10 * 60 * 1000;

/** 命令 → 需要用户确认的参数名。 */
export const USER_CONFIRM_FIELDS = Object.freeze({
  'pipeline.run.start': 'budgetConfirmed',
  'capture.ui': 'confirmed',
  'run.archive': 'confirmed',
});

const ID_PATTERN = /^apr_[0-9a-f-]{36}$/;

export class ApprovalStore {
  constructor(home, { now = () => Date.now() } = {}) {
    this.dir = join(home, 'approvals');
    this.now = now;
    mkdirSync(this.dir, { recursive: true });
  }

  #path(id) {
    if (!ID_PATTERN.test(String(id))) return null;
    return join(this.dir, `${id}.json`);
  }

  #read(id) {
    const path = this.#path(id);
    if (!path) return null;
    try {
      const record = JSON.parse(readFileSync(path, 'utf8'));
      if (record.expiresAt <= this.now()) {
        rmSync(path, { force: true });
        return null;
      }
      return record;
    } catch {
      return null;
    }
  }

  #write(record) {
    const path = this.#path(record.id);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(record), 'utf8');
    renameSync(tmp, path);
  }

  #all() {
    let names = [];
    try { names = readdirSync(this.dir); } catch { return []; }
    return names.filter(name => name.endsWith('.json')).map(name => this.#read(name.slice(0, -5))).filter(Boolean);
  }

  /** 为同一 (command, runId, argsDigest) 复用仍在等待的请求，避免模型反复重试刷出一堆待审批卡片。 */
  request({ command, runId = null, argsDigest, summary, caller }) {
    const existing = this.#all().find(record => record.command === command && record.runId === runId && record.argsDigest === argsDigest && record.status === 'pending');
    if (existing) return existing;
    const createdAt = this.now();
    const record = { id: `apr_${randomUUID()}`, command, runId, argsDigest, summary, caller, status: 'pending', createdAt, expiresAt: createdAt + APPROVAL_TTL_MS };
    this.#write(record);
    return record;
  }

  get(id) { return this.#read(id); }

  listPending({ runId } = {}) {
    return this.#all().filter(record => record.status === 'pending' && (runId === undefined || record.runId === runId));
  }

  /** 只由用户界面调用。 */
  grant(id) {
    const record = this.#read(id);
    if (!record) return null;
    if (record.status !== 'pending') return record;
    const granted = { ...record, status: 'granted', grantedAt: this.now() };
    this.#write(granted);
    return granted;
  }

  deny(id) {
    const path = this.#path(id);
    const record = this.#read(id);
    if (!record || !path) return null;
    rmSync(path, { force: true });
    return { ...record, status: 'denied' };
  }

  /** 找到并消费一条已批准的审批；一次性，用完即删。 */
  consume({ command, runId = null, argsDigest }) {
    const record = this.#all().find(item => item.status === 'granted' && item.command === command && item.runId === runId && item.argsDigest === argsDigest);
    if (!record) return null;
    rmSync(this.#path(record.id), { force: true });
    return record;
  }
}
