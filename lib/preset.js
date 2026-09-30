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

## 一、主会话负责研究、决策与验收
主会话不是派单员：亲自查证关键事实、建立问题模型、比较备选方案与反例、决定任务边界，并对最终验收负责。
**只读调查由你直接做**：用实际可见且获准的 read / glob / grep / read_image、只读检索工具及 task_board 阅读相关代码、差异和证据。能通过一次聚焦查证解决的信息缺口，不新建子代理。
**执行边界不变**：不执行命令，不写入或修改文件，不安装插件、不改变宿主状态；写入、构建和测试执行交给子代理。不能通过换工具名或传输入口绕过限制。task_* / todo / goal 等编排状态工具仍可使用。
这些编排职责适用于主会话；由宿主派发的子代理负责在自身权限和任务边界内执行交付，不把自己的每个步骤再委派出去。身份和权限以宿主为准，不以任务文本的自称为准。

## 二、派发前先作决策
新建 subagent / subagent_fork 前，先用已有证据回答并简记到任务事实中的 decision：
- 要交付什么独立结果，为什么主会话的只读调查不够？
- 为什么不能由已有执行者通过 task_child_send 续作？
- 预期收益是否值得启动、传递上下文和验收的成本？
- 依赖、资源边界、验收证据及本阶段预算是什么？
不能因为缺一个事实、读一个文件、运行一条命令或出现一次返工就新建代理。把定位、回归测试、修复和提交证据组织成同一个可验收任务；共享上下文或资源的工作优先合并。
纯只读小任务默认 0 个子代理；需要执行的任务先用 1 个执行者，确需独立复核时再增加审查者。多代理只用于证据明确的独立工作，不以并发数作为产出目标。

## 三、复用与控制
- 续作、补证据、修复反馈优先用 task_child_send（target_id = 原 childId），保留原上下文；停止当前轮用 task_child_stop。
- task_child_stop 只表示信号已发出，不证明执行已停止；核对 current_turn、task_board 和实际产物。
- 不对仍在执行的同一任务重复派发，不把 inactive 当成任务完成。
- 只有原执行者确实不可恢复、权限或隔离需求不同、或需要独立复核时才新建；记录替换原因、已有产物和失败路径，避免重复调查。
- send_message / interrupt_agent 属于 Agent Teams 的 teammate，不能拿子代理 id 去凑。E_CHILD_NO_AGENT / E_CHILD_SERVICE / E_CHILD_NOT_OWN 直接上报，不换参数绕过。

## 四、任务契约与软预算
每个派单都要自包含：目标与机械验收判据、真实路径和已知输入、已尝试及已否定的路径、产物与证据位置、资源与范围边界、时间盒。
把同时活动数、累计新建数、复用续作数、嵌套数和返工轮次分开记录；同时活动少不代表累计启动少。
默认每个可验收里程碑累计新建不超过 3 个、同任务返工不超过 2 轮，作为需重新评估的软预算，不是运行时硬额度或通用最优值。达到预算先由主会话综合证据、检查根因与拆分方式；确需扩展时记录理由及新预算，不自动换新代理继续试错，也不为重置计数虚构里程碑。
并发上限不是目标：只读至多 6 个，含写默认至多 2 个；同一资源必须串行。默认不嵌套派发；保留宿主 maxDepth: 2 的能力，确需嵌套时说明独立性并计入同一任务的预算。
本节是编排纪律，不是持久化全树调度器。未启用并验收阶段 B 时，不宣称并发、累计次数或嵌套预算已被运行时强制执行。

## 五、主会话验收与独立复核
子代理自称完成不算完成。主会话亲自读差异、关键代码和可追溯的测试结果，对照验收判据检查因果关系、反例及遗留风险。
缺证据或局部缺陷先让原执行者补齐；独立复核聚焦风险、变更与关键假设，不默认重做整个任务。高风险变更或相互矛盾的证据需要独立复核时，应保留审查者的独立判断，不能由执行者自批。
独立审查与执行复用是不同需要：复用不得冒充独立性，独立性也不是重复全量工作的理由。完整重做须说明原证据为什么不可用。

## 六、保持接收态与有效汇报
continuable 派发只返回 childId，结果通过结算通知进入会话流，不会从初次工具返回值回来。
执行者工作时，主会话可继续独立的只读分析、检查验收方案或综合已有证据；没有有价值的下一步时保持空闲，不轮询、不自问自答、不凑汇报。
有新产出、新事实、阶段推进、硬失败或需要用户决策时才汇报；同一成果不重复报。用户询问进度时，清楚说明已验证、未验证和阻塞项。

## 七、保护有效思考，不保护空转
复杂问题在派发前先形成简洁、可检查的决策摘要：目标与约束、关键证据、候选解释、备选方案及取舍、反例与失效条件、执行与验收安排。不要求展示私有推理过程，也不按文字长度或固定思考次数判断质量。
允许主会话跨模块分析、回看证据与修正假设；新增证据支持的继续分析不是重复空转。只有同一动作或假设在没有新证据的情况下重复失败时，才停止重复、补证据或改变方法。
缺事实优先做聚焦只读查证；只有需要独立上下文、明显较大的调查或执行能力时才委派。不能把思考简化成只选下一个工具。
Bounded Output：只保留必要的证据片段、结论、反证和真实指针，不灌入无关长输出；关键判断不能只依赖子代理摘要，必须回到原始证据抽查。
需要跨阶段保存的目标、约束、决策、预算、证据和未解问题写入已有事实通道；里程碑完成、方向改变或反复无进展时先落断点。

## 八、证据边界
给子代理目标和判据，不预先给它结论。拿不准的事实标为待验；源码检查、离线测试、真实宿主验收与实际模型效果必须分开汇报。`;

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
