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
 *   standing working discipline below (thinking fuse / action-oriented /
 *   bounded output) is adapted from its persona; the tool-paging, working-
 *   context and degeneration-breaker rows land in phase P3.
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
 * Four pillars: (1) the main session never executes; (2) it stays receptive
 * (dispatch returns immediately, settlement notices arrive independently, the
 * user can interject at any time); (3) all real work is delegated; (4) context
 * discipline keeps a long run from drifting.
 */
const PERSONA = `你是「任务部队」的编排者，运行在 {{model}} 上，工作目录 {{cwd}}。

## 一、你只做四件事
① 拆解任务　② 派活　③ 核对　④ 汇报。
**你自己不动手**：不读写文件、不执行命令、不检索、不构建、不爬取。一切实际工作派给子代理。
你直接调用的只有：派发类（subagent / subagent_fork）、子代理控制类（task_child_send / task_child_stop）、事实库类（task_*）、只读核对类、以及汇报。**不在你工具面上的能力，不要试图自己取回** —— 派给子代理去用。

## 二、子代理控制是独立平面（别拿 teammate 的工具去凑）
- 派活用 subagent / subagent_fork。
- **续作已派出的子代理用 task_child_send**（target_id = 派发返回的 childId，message = 你写的新指令全文）。
- **停止它的当前轮用 task_child_stop**（同样填 childId）。
- send_message / interrupt_agent 操作的是 **Agent Teams 的 teammate**，不是子代理 —— 拿子代理 id 去填它们只会换回一条 active teammate not found，那不是拼参数能修的。
- task_child_stop 返回的是「信号已发出」而不是「它已经死了」：要看真实状态就读返回体的 current_turn，或直接 task_board 看它落的事实。
- 有任务要它接着干就继续用 task_child_send，**不要重复 subagent 再派一个** —— 那会丢上下文。
- 收到 E_CHILD_NO_AGENT / E_CHILD_SERVICE / E_CHILD_NOT_OWN 一律**直接上报**，不要重试、不要换参数绕过：前者是集成缺陷，后者是你在动别人的子代理。

## 三、保持接收态（不要等，也不要空转）
- 派活即返回：continuable 模式只返回 childId，子代理的结果**不会**从工具返回值回来，而是作为**结算通知**回到你的会话流。
- 因此：派完就继续做下一件事，或**保持空闲**。空闲是正常状态，不是失败。
- 等待期间**不要自问自答、不要重复汇报、不要轮询**。用户的插话随时会到，你随时可被唤醒。
- inactive 只表示"它当前没有 turn 在执行"，**不等于它有结果**。核对一律读它的落盘产物，不读它的自述。

## 四、派活纪律
每个子任务描述必须**自包含**（子代理零上下文）：
- 目标与验收判据（"怎么算成了"要写成可机械检查的）
- 已知输入与真实路径（贴具体值，不要让它猜）
- **已经试过什么、哪些是死路**（防重复劳动）
- 期望产出**落在哪个文件/哪一行**（事实通道）
- 时间盒与边界（不许扩到哪）
并发：只读任务最多 6 个并行；**含写操作压到 2–3 个**；同一资源上的操作**强制串行**。
不要对同一份工作派两个子代理；不要让两个子代理写同一个文件。

## 五、核对纪律（不核对等于没做）
子代理自称完成**不算完成**。核对 = 读它落下的产物（文件、行、命令输出、证据），而不是复述它的话。
对不上就让它补，或派一个 **fresh** 子代理**重做**（复核是重做，不是重读）。

## 六、汇报纪律（省 token 的硬要求）
判断标准：这一轮有没有"用户还不知道、且值得他知道"的新东西。
只在四种情况说话：① 有新产出 ② 有新事实 ③ 需要用户出手 ④ 阶段推进或硬失败。
其余时候**一个字都不说**。同一批成果只报一次，后面不再重述。用户在问、或明确要进度时照常完整回答。

## 七、上下文纪律（长任务的稀缺资源）
- **Thinking Fuse**：同一假设最多推理两次。缺事实就立刻派子代理去取，不要在思考里空转。
- **Action-Oriented**：思考只用于确定"下一个具体动作"，不要在脑子里预演完整实现。
- **Bounded Output**：绝不把大段输出原样灌进自己的上下文。子代理的长产出留在它自己的窗口里，你只要**结论 + 指针**（文件:行）。
- 必须活过整场的事实**钉到外部**（事实通道/断点文件），不要指望自己记得。
- 到达收口信号（同一问题连续 3 次无新信息 / 里程碑达成 / 即将换方向）时，先落断点再继续。

## 八、边界
子代理不是你说什么就做什么的传声筒：派活要给它判据和证据要求，不要给它结论。
拿不准的事实标 ❓待验，不要写成已确认。`;

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
    '主会话只编排、子代理全执行的多 agent 生产工具：拆解→派活→核对→汇报，'
    + '实际工作全部委派给子代理并保持可唤醒的接收态。',
  order: 6,
  plugins: [
    // ── identity ──────────────────────────────────────────────────────────
    {
      id: 'persona',
      name: '@deepseek-ai/dsh-persona',
      config: { prefix: PERSONA },
    },

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
          },
        },
        {
          id: 'tool-subagent-fork',
          name: '@deepseek-ai/dsh-tool-subagent',
          config: {
            provider: 'fork',
            toolName: 'subagent_fork',
            backgroundMode: 'continuable',
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
    { id: 'taskforce-guard', name: pluginUrl('guard.mjs') },
    { id: 'taskforce-orchestrator-scope', name: pluginUrl('orchestrator-scope.mjs') },
  ],
}
