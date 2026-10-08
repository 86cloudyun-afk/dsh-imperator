/** Fixed workload and grader. The grader is never written into the model workspace. */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

export const STRICT_COMMAND = 'node --test money.test.mjs'
export const STRICT_FILES = ['money.mjs', 'money.test.mjs']
const boundary = '只在当前工作目录操作，不提交 Git，不修改目录外文件。使用任务事实库完成提交和主控验收；不使用人工豁免。'
export const MODEL_STAGES = Object.freeze([
  { name: 'readonly', prompt: '只读 README.md，回答发票总额是多少分。不要创建任务、子代理或修改文件。' },
  { name: 'repair', prompt: `修复 money.mjs 的 sumMoney 金额精度：空数组=0、[10,20]=30、[0.1,0.2]精确=0.3、[-1.1,0.2]精确=-0.9。保留导出，运行现有 money.test.mjs 并保留日志和产物依据。一个可验收任务、一名执行者。${boundary}` },
  { name: 'reuse', prompt: `追加要求：sumMoney 对 NaN、+Infinity、-Infinity 输入抛 TypeError，仍支持有限负数与小数。补充回归并运行全部测试、保留日志。新开一个任务，使用 task_child_send 复用上一轮执行者，不新建代理。${boundary}` },
  { name: 'strict', prompt: `新开一个 evidence_policy=execution 的严格验收任务；verification_files 精确为 ${JSON.stringify(STRICT_FILES)}，verification_command 精确为 ${JSON.stringify(STRICT_COMMAND)}。复用原执行者认领，用 task_verify 取得真实宿主回执，再提交，由主控核对 task_board 后 task_accept。保留所有金额和非有限数行为。主会话不得执行命令。${boundary}` },
])

export function writeModelFixture(workspace) {
  writeFileSync(join(workspace, 'README.md'), '# Invoice\nThe invoice total is 1.37 currency units (137 cents).\n')
  writeFileSync(join(workspace, 'money.mjs'), 'export function sumMoney(values) { return values.reduce((sum, value) => sum + value, 0) }\n')
  writeFileSync(join(workspace, 'money.test.mjs'), `import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { sumMoney } from './money.mjs'\ntest('empty', () => assert.equal(sumMoney([]), 0))\ntest('integers', () => assert.equal(sumMoney([10,20]), 30))\ntest('decimal', () => assert.equal(sumMoney([0.1,0.2]), 0.3))\ntest('negative', () => assert.equal(sumMoney([-1.1,0.2]), -0.9))\n`)
}

/** Exit alone cannot pass: an early process.exit(0) lacks the grader's completion token.
 * No model-written tests, logs or success messages enter this decision. */
export function gradeMoney(workspace, extended = false) {
  const token = randomUUID()
  const source = `import assert from 'node:assert/strict';
import { sumMoney } from ${JSON.stringify(pathToFileURL(join(workspace, 'money.mjs')).href)};
assert.equal(sumMoney([]),0);
assert.equal(sumMoney([10,20]),30);
assert.equal(sumMoney([0.1,0.2]),0.3);
assert.equal(sumMoney([-1.1,0.2]),-0.9);
${extended ? `for (const x of [NaN,Infinity,-Infinity]) assert.throws(() => sumMoney([1,x]),TypeError);
assert.equal(sumMoney([0,-2.25,1.25]),-1);` : ''}
process.stdout.write(${JSON.stringify(token)});`
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    cwd: workspace, encoding: 'utf8', timeout: 10000, maxBuffer: 65536,
    env: { PATH: process.env.PATH },
  })
  return { ok: result.status === 0 && !result.signal && !result.error && result.stdout === token,
    checks: extended ? 8 : 4 }
}
