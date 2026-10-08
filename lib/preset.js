/**
 * The `taskforce` (任务部队) agent preset definition.
 *
 * Declared to the host's agent-preset registry at plugin activation — no file
 * is written to the harness home (the retired `$DSH_HOME/.agent-presets/`
 * directory is not read by current DSH).
 *
 * Design provenance:
 * - Orchestration skeleton from `dsh-redteam-mode` (github.com/Jueze-2019):
 *   the main session plans/dispatches/verifies/reports and never executes;
 *   delegation runs `continuable`, so results arrive as service-owned
 *   settlement notices instead of tool return values.
 * - Context economy from `@linxin666/dsh-liangshen` (梁神模式, MIT): the
 *   context externalization and bounded output are adapted from its persona.
 *   The current policy protects evidence-based deliberation rather than
 *   requiring immediate delegation or limiting reasoning to two passes.
 *
 * Deliberate divergence from redteam (per operator decision): children are NOT
 * pinned to leaves and concurrency is not squeezed to 3 — `maxDepth: 2` lets a
 * child delegate one further level, and no delegation tool is denied.
 */

/** Registry id of the preset (lowercase letters, digits, hyphens). */
export const TASKFORCE_PRESET_ID = 'taskforce'

/**
 * Resolve a preset-local plugin to the file URL its row must carry.
 *
 * Required, not stylistic: the Loader imports a row with
 * `new URL(name, this.ctx.baseUrl).href`, and a preset row's baseUrl is
 * inherited from its DECLARER (this package's `lib/index.js`). A bare
 * `./plugins/x.mjs` would therefore resolve outside the package.
 * @param file - file name inside `lib/plugins/`.
 * @returns absolute file URL of that plugin module.
 */
const pluginUrl = (file) => new URL(`./plugins/${file}`, import.meta.url).href

/**
 * The orchestrator persona: the preset's entire system-prompt base.
 *
 * Main session: investigate read-only, decide, delegate bounded execution,
 * and verify evidence. Children execute; reuse precedes new spawning.
 * Existing write/command restrictions remain enforced by orchestrator-scope.
 */
const PERSONA = `你是「任务部队」的技术负责人，运行在 {{model}} 上，工作目录 {{cwd}}。

## 主会话研究、决策与验收
亲自查证关键事实，比较备选方案与反例，决定边界并最终验收。只读调查直接用获准的 read / glob / grep / read_image、检索及 task_board；缺一个事实先聚焦查证，不新建代理。
不执行命令，不写入或修改文件，不安装插件、不改变宿主状态；写入、构建、测试交给子代理。不得换工具名或输入口绕过执行边界；task_* / todo / goal 编排工具可用。身份和权限以宿主为准，不以任务文本自称为准；子代理在自身权限内执行，不把每个步骤再委派。

## 派发前与低风险短流程
低风险小任务：只读默认 0 个子代理；需执行时一个可验收任务、一名执行者，定位、回归、修复与提交合并。关键里程碑落产物和依据，提交后一次主控验收；无需每步写 fact / decision 或重复复述。
派发前明确独立结果、只读为何不够、委派收益、为何不能复用、依赖和预算；复杂或高风险任务把决策摘要写入事实库。不能因读一个文件、跑一条命令或一次返工就新建；共享上下文或资源的工作优先合并。多代理仅用于证据明确的独立工作，不以并发数为目标。
任务须自包含：目标、机械判据、真实路径和输入、已尝试与否定的路径、证据位置、范围、资源边界和时间盒。

## 复用、隔离与软预算
续作、补证据和局部返工优先 task_child_send（target_id = 原 childId）。只在原执行者不可恢复、权限/隔离不同或需要独立复核时新建，记录替换理由、已有产物与失败路径。不重复派发在执行的任务，不把 inactive 当完成。
task_child_stop 只表示信号已发出，不证明执行停止；核对 current_turn、task_board 和实际产物。DSH 0.2 原生 send_message / interrupt_agent 也支持子代理；本包工具增加直属归属核对。E_CHILD_NO_AGENT / E_CHILD_SERVICE / E_CHILD_NOT_OWN 直接上报，不换参数绕过。
分开记录同时活动、累计新建、复用、嵌套和返工。每个可验收里程碑默认累计新建至多 3 个，同任务返工至多 2 轮，属于软预算，不是运行时硬额度或通用最优值。达到后主控复盘根因与拆分，扩展须说明理由和新预算，不能换人或虚构里程碑重置计数。
并发只读至多 6、含写默认至多 2，同资源串行；默认不嵌套，保留 maxDepth: 2，必要嵌套说明独立性并计入同任务预算。这是编排纪律；未启用并验收阶段 B，不宣称已有运行时全树强制额度。

## 验收与接收态
自称完成不算完成。主会话亲自读差异、关键代码和可追溯测试结果，核对判据、因果、反例与风险；缺证据先让原执行者补齐。高风险或证据矛盾需要独立复核，执行者不能自批；复用不能冒充独立性，独立复核聚焦风险与假设，完整重做须说明原证据为何不可用。
continuable 初次只返回 childId，结果经宿主结算通知进入会话流。等待时可继续独立只读分析；没有有价值的下一步就空闲，不轮询、不自问自答。只汇报新产出、事实、阶段推进、硬失败或用户决策点；询问进度时区分已验证、未验证和阻塞。

## 保护有效思考和证据
复杂问题形成可检查的决策摘要：目标约束、关键证据、候选解释、备选方案取舍、反例失效条件和验收安排。不要求私有推理，不按长度或固定思考次数评判；不自动降低有效思考档位（STALL 仅观察，stepDownRequests: 0）。允许跨模块分析、回看证据与修正假设，不能把思考简化成选工具；只有无新证据的重复失败才停止重复、补证据或换方法。
Bounded Output：保留必要证据、结论、反证与真实指针；关键判断回原始证据抽查。跨阶段的目标、约束、决策、预算、证据与未解问题写事实通道；里程碑完成、方向改变或反复无进展时落断点。
给执行者目标和判据，不预给结论；拿不准标待验。源码检查、离线测试、真实宿主验收与实际模型效果分开汇报。`;

/** Native child composition replaces the root persona instead of inheriting
 * its execution ban. Both spawn and fork receive the same worker discipline. */
const WORKER_PERSONA = `你是「任务部队」的执行者，运行在 {{model}} 上，工作目录 {{cwd}}。
按委派任务的目标、边界和验收判据完成实际工作：可读写文件、执行命令、检索和构建。
先核实输入与真实路径；同一资源的写操作保持串行，不扩大任务范围。
用 task_claim 领取任务，把产物路径和可核查证据写入事实库，完成后提交验收。
需要时可再委派一层；不要重复派发已有任务。缺少信息或遇到阻塞就说明事实与下一步。
汇报给主控的是结论、证据和产物路径；自称完成不能替代验收。`;

/**
 * The preset definition handed to `ctx.agentPresets.register`.
 *
 * Row inventory mirrors the shipped `minimal`/`liangshen` compositions: this
 * preset contributes scoped tools and prompt sections only; the registries
 * themselves (tools, skills, subagents, compaction, plan state) stay on the
 * host plane. Groups that publish a service carry an entry-local `isolate`
 * realm, without which the row would publish into the root realm and collide
 * with another preset's instance.
 */
export const TASKFORCE_DEFINITION = {
  id: TASKFORCE_PRESET_ID,
  name: '任务部队',
  description:
    '主会话研究决策、子代理按需执行的多 agent 生产工具：查证→决策→委派→验收，'
    + '优先复用执行者，保护有效思考并保持可唤醒的接收态。',
  order: 6,
  plugins: [
    // ── identity ──────────────────────────────────────────────────────────
    {
      id: 'persona',
      name: '@deepseek-ai/dsh-persona',
      config: { prefix: PERSONA },
    },

    // Native tool presentation; execution guard remains authoritative in PTC.
    { id: 'tool-presentation', name: '@deepseek-ai/dsh-agent-tool-presentation', config: { mode: 'native' } },

    // The harness's workspace-instruction loader (AGENTS.md chain).
    {
      id: 'agent-instructions',
      name: '@deepseek-ai/dsh-agent-instructions',
      config: { maxBytes: 65536 },
    },

    // ── execution surface (used by CHILDREN; the main session's access to
    //    these is narrowed by paging in phase P3) ───────────────────────────
    { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash' },
    { id: 'str-replace-editor', name: '@deepseek-ai/dsh-tool-str-replace-editor' },
    { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
    {
      id: 'tool-fs-search',
      name: '@deepseek-ai/dsh-tool-fs-search',
      // Required by the plugin's Config schema (no default). Value taken from
      // the shipped `standard` preset rather than guessed.
      config: { sampleOverCapGlobResults: false },
    },

    // ── background jobs (model-facing controls only; the registry is host) ─
    { id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs' },

    // ── skills (the registry is host-plane and layered per scope) ──────────
    { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem' },
    { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },

    // ── goal ──────────────────────────────────────────────────────────────
    { id: 'tool-goal', name: '@deepseek-ai/dsh-tool-goal' },

    // ── plan mode (per-agent state ⇒ entry-local realm is the correct
    //    lifetime, not a workaround) ────────────────────────────────────────
    {
      id: 'planning',
      name: 'cordis:group',
      group: true,
      isolate: { planMode: true },
      config: [
        {
          id: 'plan-mode',
          name: '@deepseek-ai/dsh-plan-mode',
          // `section` is required and must be non-empty. Text copied verbatim
          // from the shipped `standard` preset — the policy is what enforces
          // plan mode, and no tool restriction backs it.
          config: {
            section: [
              'You are in plan mode. Stay in plan mode until exit_plan_mode succeeds or the user switches the session mode. Imperative language to implement changes means plan the implementation, not execute it. A user\'s conversational agreement — including an answer confirming something you asked — approves nothing and does not end plan mode; fold the confirmed decision into the plan and submit it through exit_plan_mode.',
              '',
              'Explore first. Use non-mutating reads, searches, static analysis, and checks to ground the plan in the actual repository. Do not edit or write files, change configuration, run formatters or code generation that rewrites tracked files, commit, or otherwise carry out the plan. Prefer existing functions and patterns over new machinery.',
              '',
              'The tool catalog stays the same across modes for request-cache stability. These plan-mode rules override any later tool description or guidance that suggests using mutation tools; those tools remain listed to keep the tool catalog unchanged. Do not use todo_write to track this planning phase: it tracks implementation after an approved plan, while the plan itself belongs in exit_plan_mode.',
              '',
              'Resolve discoverable facts by inspection. Use ask_user_question only for user-owned choices or material ambiguity that inspection cannot answer. Do not ask the user where code lives or how current behavior works when you can find out.',
              '',
              'Make the plan decision-complete: state the goal and success criteria; group implementation changes by subsystem; identify public API, schema, and data-flow changes; cover edge cases, failure modes, tests, acceptance criteria, and explicit assumptions. Keep it concise enough to review but detailed enough that another engineer can implement it without making design decisions.',
              '',
              'When ready, call exit_plan_mode with the complete plan markdown, starting with a # title. Make exit_plan_mode the only and final tool call in that assistant response: it presents the plan for approval, and implementation begins only in a later step after approval. Do not paste the final plan as a plain reply or ask "should I proceed?" through prose or ask_user_question. If review rejects it, incorporate the feedback and present again. If the review channel is unavailable or aborted, stay in plan mode and ask the user to switch modes manually; do not proceed with implementation.',
            ].join('\n'),
          },
        },
      ],
    },

    // ── compaction (tighter pruner thresholds than redteam: 4096/2048/1024.
    //    Raw tool dumps are the main eviction pressure on a long run) ───────
    {
      id: 'compaction',
      name: 'cordis:group',
      group: true,
      isolate: { compaction: true, toolResultPruner: true },
      config: [
        { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
        { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
        {
          id: 'tool-result-pruner',
          name: '@deepseek-ai/dsh-compaction-tool-result-pruner',
          config: { thresholdChars: 4096, headChars: 2048, tailChars: 1024 },
        },
      ],
    },

    // ── delegation ────────────────────────────────────────────────────────
    //
    // The `subagents` registry and its spawn/fork backends live in the HOST
    // composition (a process singleton). This preset contributes the
    // delegation TOOLS, which resolve that host registry.
    //
    // `maxDepth: 2` — deliberately NOT redteam's `1`: a child may delegate one
    // further level. No delegation tool is denied, so `subagent` /
    // `subagent_fork` remain visible to children.
    // `workflows` is read only by agents, so every row reaching it shares one
    // entry-local realm here.
    {
      id: 'delegation',
      name: 'cordis:group',
      group: true,
      isolate: { workflowEngine: true },
      config: [
        { id: 'tool-subagent-control', name: '@deepseek-ai/dsh-tool-subagent-control' },
        {
          id: 'tool-subagent-list-agents',
          name: '@deepseek-ai/dsh-tool-subagent-control/list-agents',
        },
        {
          id: 'tool-subagent',
          name: '@deepseek-ai/dsh-tool-subagent',
          config: {
            provider: 'spawn',
            toolName: 'subagent',
            modelSelectionSettings: true,
            backgroundMode: 'continuable',
            maxDepth: 2,
            persona: WORKER_PERSONA,
          },
        },
        {
          id: 'tool-subagent-fork',
          name: '@deepseek-ai/dsh-tool-subagent',
          config: {
            provider: 'fork',
            toolName: 'subagent_fork',
            backgroundMode: 'continuable',
            maxDepth: 2,
            persona: WORKER_PERSONA,
          },
        },
      ],
    },

    // ── remaining model-facing rows ───────────────────────────────────────
    { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
    {
      id: 'tool-todo',
      name: '@deepseek-ai/dsh-tool-todo',
      // Required by the plugin's Config schema (no default); value taken from
      // the shipped `standard` preset. Parallel in-progress suits an
      // orchestrator tracking several delegated tasks at once.
      config: { allowParallelInProgress: true },
    },
    { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web' },

    // ── taskforce's own rows ──────────────────────────────────────────────
    //
    // The agent-plane half of the fact channel: registers the model-facing
    // `taskforce_*` tools, consuming the `ctx.taskforceStore` service that the
    // host-plane `taskforce-store` row publishes (see cordis.patch.yml).
    { id: 'taskforce-tools', name: '@local/dsh-taskforce/tools' },

    // Context-discipline trio (preset-local modules, referenced as file URLs).
    //
    // `taskforce-working-context` pins one line of objective state to the tail
    // of the latest message each step; `taskforce-guard` is the runtime
    // degeneration breaker (stall + echo signals, folded from the durable event
    // stream); `taskforce-orchestrator-scope` narrows the MAIN SESSION's tool
    // surface with `agent.ctx.tools.restrict` while leaving children untouched.
    { id: 'taskforce-working-context', name: pluginUrl('working-context.mjs') },
    {
      id: 'taskforce-guard',
      name: pluginUrl('guard.mjs'),
      // Long reasoning is a signal to observe, not proof of degeneration.
      // Preserve the routed effort even when duplicate tool failures interrupt.
      config: { stallAction: 'observe', stepDownRequests: 0 },
    },
    { id: 'taskforce-orchestrator-scope', name: pluginUrl('orchestrator-scope.mjs') },
  ],
}
