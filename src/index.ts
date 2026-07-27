import { Plugin, Setting, showMessage } from 'siyuan'
import type { AcornySettings } from './types'
import { fetchFeedPage } from './apiClient'
import { createForwardProxyHttp } from './httpProxy'
import { createSiyuanClient, type Notebook } from './siyuanClient'
import { createSiyuanGateway, SyncIndexError, type SiyuanGateway } from './siyuanGateway'
import { migrateDocsToFolder, planDestinationChange, rememberFolders } from './folderMigration'
import { normalizeFolderPath } from './docPath'
import { SyncEngine } from './syncEngine'
import {
  isInteractiveTrigger, mayRunSync, nextAutoDelayMs, pickNotebookValue, readInitedFlag, type SyncTrigger,
} from './scheduler'

const STORAGE = 'acorny-sync.json'

const DEFAULT_SETTINGS: AcornySettings = {
  serverUrl: 'https://api.acorny.io',
  exportToken: '',
  notebookId: '',
  docFolderPath: '/Acorny',
  syncOnStartup: true,
  pollIntervalMinutes: 60,
}
interface PersistShape {
  settings?: Partial<AcornySettings>
  /** source→doc 映射。持久化后，重启不再单靠一次 SQL 全表扫来重建索引。 */
  sourceDocMap?: Record<string, string>
  /** 用过的历史文件夹（不含当前）。见 `knownFolders` 字段注释。 */
  knownFolders?: string[]
  /** 目标位置已变更、但迁移还没跑完。持久化以便中途退出思源后下次同步补做。 */
  migrationPending?: boolean
  /** 历史上见过的 source 数高水位。见 `knownSourceCount` 字段注释。 */
  knownSourceCount?: number
  /** 初始化是否完成。见 `inited` 字段注释。 */
  inited?: boolean
  /** @deprecated `inited` 的旧字段名，仅为读取老 data.json 保留。 */
  destinationConfirmed?: boolean
}

export default class AcornySyncPlugin extends Plugin {
  private settings: AcornySettings = { ...DEFAULT_SETTINGS }
  private engine!: SyncEngine
  private client = createSiyuanClient()
  private autoTimer: number | null = null
  private disposed = false
  private ready = false
  /** 插件级同步单飞门：在设置 activeGateway 之前就拦截并发触发，防止第二次运行覆盖目的地快照。 */
  private syncing = false
  private notebooks: Notebook[] = []
  /** 顶栏图标元素，用于同步中旋转动效。 */
  private topBarElement: HTMLElement | null = null
  /** 当前同步运行期的网关快照（notebook/folder 在 runSync 起点冻结）。 */
  private activeGateway: SiyuanGateway | null = null
  /**
   * source→doc 映射，**持久化**在 data.json 里。
   * 三个作用，缺一不可：
   *  1. 快速连点时命中上次刚建的文档，规避 attributes SQL ~1.5s 异步索引延迟；
   *  2. 重启后不必单靠一次 SQL 全表扫来重建索引（那条查询曾被内核静默截断到 64 行，
   *     直接导致 6850 篇重复文档）；
   *  3. 给熔断提供 baseline——"上次我知道有多少个 source"。
   * 它不是唯一真相：每次使用都经 getBlockKramdown 零延迟校验，指向已删/已改的条目会被丢弃。
   */
  private sourceDocMap: Record<string, string> = {}
  /**
   * 用过的历史文件夹（不含当前）。改文件夹后已有文档可能还留在旧处（迁移失败、用户手动挪过、
   * 迁移尚未跑），L3a 零延迟查找必须连旧文件夹一起找，否则它们不可见 → 重新打开重复建档的窗口。
   */
  private knownFolders: string[] = []
  /** 目标位置刚变更，下一次同步开始前要先把已有文档搬过去。 */
  private migrationPending = false
  /**
   * 历史上见过的 source 数（只增不减）。唯一作用是让熔断能区分「真·首次同步」（全量新建正常）
   * 与「索引因故全空」（最需要熔断的时刻）——只看当前 docMap 大小分不出这两种情况。
   */
  private knownSourceCount = 0
  /**
   * 初始化是否完成——用户亲自跑过一次同步即视为完成。装完插件默认 `false`。
   *
   * 它和 `settings.syncOnStartup` 是**两件事**：后者是用户偏好（"我想不想开机同步"，默认
   * `true`），前者是客观事实（"初始化完没完"）。只有初始化完成后 `syncOnStartup` 才谈得上
   * 生效——否则笔记本与文件夹都有默认值，「填个 token 点保存」就会用一套从没确认过的
   * 目的地往用户笔记里写。
   *
   * 一旦置位便不再复位：改笔记本/文件夹**不会**重新上锁（产品决定），此后自动同步照常。
   */
  private inited = false

  async onload(): Promise<void> {
    // 先「同步」注册 UI：siyuan 的 onload 是同步 void 生命周期，宿主不保证 await 完成；
    // 在首个 await 之后再 addTopBar/addCommand 会有卸载/布局竞态。this.i18n 已由框架加载。
    this.topBarElement = this.addTopBar({
      icon: 'iconRefresh',
      title: this.i18n.syncNow,
      position: 'right',
      callback: () => void this.runSync('manual'),
    })
    this.addCommand({ langKey: 'syncNow', hotkey: '', callback: () => void this.runSync('manual') })

    await this.loadPersisted()
    // 卸载竞态：插件可能在 loadPersisted 期间已被禁用/卸载，别再继续建 engine/设置面板/启动同步。
    if (this.disposed) return

    const http = createForwardProxyHttp(this.client.forwardProxy)
    this.engine = new SyncEngine({
      getSettings: () => this.settings,
      // 网关在每次同步开始时快照（notebook/folder），见 runSync。
      loadSyncedIndex: () => this.requireGateway().loadSyncedIndex(),
      fetchPage: ({ serverUrl, token, cursor }) => fetchFeedPage(http, { serverUrl, token, cursor }),
      writeSource: (source, highlights, index) => this.requireGateway().writeSource(source, highlights, index),
      // 状态展示由 runSync 直接驱动顶栏旋转，这里无需处理。
      onStatus: () => {},
      isAborted: () => this.disposed,
    })
    this.ready = true

    this.buildSettingPanel()

    if (this.settings.syncOnStartup) void this.runSync('startup')
    this.scheduleAuto(this.settings.pollIntervalMinutes > 0 ? this.settings.pollIntervalMinutes * 60_000 : null)
  }

  onunload(): void {
    this.disposed = true
    this.clearAuto()
  }

  /** SyncEngine 运行期取当前已冻结的网关；未冻结说明调用时序有误。 */
  private requireGateway(): SiyuanGateway {
    if (!this.activeGateway) throw new Error('gateway not initialized for this sync run')
    return this.activeGateway
  }

  private scheduleAuto(delayMs: number | null): void {
    this.clearAuto()
    if (this.disposed || delayMs === null || delayMs <= 0) return
    this.autoTimer = window.setTimeout(() => { void this.runSync('timer') }, delayMs)
  }

  private clearAuto(): void {
    if (this.autoTimer !== null) {
      window.clearTimeout(this.autoTimer)
      this.autoTimer = null
    }
  }

  private async runSync(trigger: SyncTrigger): Promise<void> {
    if (this.disposed || !this.ready) return
    const manual = isInteractiveTrigger(trigger)
    // 首次写入必须由用户显式发起。默认目的地（列表第一个笔记本 + /Acorny）不该被自动采用。
    if (!mayRunSync(trigger, this.inited)) {
      if (trigger === 'settings') showMessage(this.i18n.confirmDestinationFirst, 15000)
      return
    }
    // 插件级单飞门：必须在设置 activeGateway 之前拦截并发触发（双击 / 启动同步与定时器重叠），
    // 否则第二次 runSync 会先把 activeGateway 改成新目的地，正在进行的第一次同步后续页面
    // 就会写到新目的地——重新引入「同步中途切换 notebook/folder」的问题。
    if (this.syncing) return
    if (!this.settings.exportToken) { showMessage(this.i18n.setTokenFirst); return }
    if (!this.settings.notebookId) { showMessage(this.i18n.selectNotebookFirst); return }
    // 走到这里说明用户手动发起、且 token/笔记本都已就绪——初始化就此完成，之后自动同步放行。
    if (trigger === 'manual') this.inited = true
    this.syncing = true
    this.setSyncingIndicator(true)
    // 手动触发给即时反馈（自动同步静默，只靠顶栏旋转，避免定时 toast 打扰）。
    if (manual) showMessage(this.i18n.syncing)
    // 在本次运行起点冻结目的地（notebook/folder），避免 drain 期间用户改设置写错地方。
    const notebookId = this.settings.notebookId
    const docFolderPath = this.settings.docFolderPath
    this.activeGateway = createSiyuanGateway(this.client, {
      notebookId,
      docFolderPath,
      knownFolders: [...this.knownFolders],
      // 跨同步存活的 source→doc 映射：快速连点时，第二次靠它命中上次刚建的文档，
      // 不受 attributes SQL 1–2s 异步索引延迟影响 → 不重复建文档。
      docMap: this.sourceDocMap,
      knownSourceCount: this.knownSourceCount,
      // 卸载后停止 writeSource 内的后续块写入。
      isAborted: () => this.disposed,
    })
    try {
      // 先把已有文档搬到新目标文件夹，再同步——否则老文档留在旧处继续接收新高亮，
      // 而重建/新建的落到新文件夹，文档库被劈成两半。
      if (this.migrationPending) await this.migrateToCurrentFolder(notebookId, docFolderPath)
      if (this.disposed) return
      const res = await this.engine.sync()
      if (this.disposed) return
      if (res.status === 'completed') {
        // 自动同步无新增时不打扰；手动或有新增才提示。
        if (manual || res.added > 0) showMessage(this.i18n.syncedCount.replace('${count}', String(res.added)))
      } else if (res.status === 'auth_failed') {
        showMessage(this.i18n.authFailed)
      } else if (res.status === 'index_error') {
        // 手动/自动都要报，且停留久一点：这类错误会停掉自动同步，静默的话用户只会觉得"同步没反应"。
        showMessage(this.i18n.indexError.replace('${reason}', res.reason), 20000, 'error')
      } else if (res.status === 'backoff') {
        // 带上原因：不然用户只看到"延后 60 秒"，完全不知道发生了什么。
        if (manual) {
          showMessage(
            res.reason
              ? this.i18n.backoffWithReason
                .replace('${seconds}', String(res.retryAfterSeconds))
                .replace('${reason}', res.reason)
              : this.i18n.backoff.replace('${seconds}', String(res.retryAfterSeconds)),
            res.reason ? 20000 : undefined,
            res.reason ? 'error' : undefined,
          )
        }
      }
      if (res.status !== 'skipped') {
        this.scheduleAuto(nextAutoDelayMs(res, this.settings.pollIntervalMinutes))
      }
    } catch (error) {
      // 防御性兜底：所有调用点都是 `void this.runSync(...)`，任何漏网异常都会变成
      // unhandled rejection 并且悄无声息。engine.sync() 自己吞掉全部错误，正常到不了这里；
      // 到了就说明是 engine 之外的路径（迁移、网关构造等）出了预料外的问题。
      console.error('[Acorny] Sync failed unexpectedly:', error)
      if (manual) showMessage(this.i18n.unexpectedError, 20000, 'error')
      // 仍按常规节奏重排，避免一次意外把自动同步永久停掉。
      this.scheduleAuto(this.settings.pollIntervalMinutes > 0 ? this.settings.pollIntervalMinutes * 60_000 : null)
    } finally {
      this.syncing = false
      this.setSyncingIndicator(false)
      this.activeGateway = null
      // 抬高水位后再落盘：下次即便 docMap 为空，熔断也知道「我们以前是有东西的」。
      this.knownSourceCount = Math.max(this.knownSourceCount, Object.keys(this.sourceDocMap).length)
      // 无条件落盘本次学到的 source→doc 映射——中止、异常、卸载路径同样要落。
      // 已经建出来的文档如果没被记住，下次同步就会认为它们不存在并再建一遍：
      // 这正是本次事故 6850 篇重复文档的放大路径。
      await this.persist().catch((e: unknown) => console.error('[Acorny] persist failed:', e))
    }
  }

  /** 记住一个用过的文件夹（去重、不记当前文件夹、有上限）。策略见 rememberFolders。 */
  private rememberFolder(folder: string): void {
    this.knownFolders = rememberFolders(this.knownFolders, folder, this.settings.docFolderPath)
  }

  /**
   * 把已有 Acorny 文档搬到当前目标文件夹。迁移失败不应让整轮同步失败——
   * 旧文件夹已记进 knownFolders，L3a 照样找得到那些文档，不会重复建档，最多是位置没变。
   */
  private async migrateToCurrentFolder(notebookId: string, targetFolder: string): Promise<void> {
    try {
      // **先补 SQL 种子再迁移。** 迁移只能搬它看得见的文档，而此刻 docMap 里只有持久化的那部分；
      // data.json 丢失/不全时（例如从数据历史恢复之后），仅靠 SQL 才能发现的文档会被漏搬，
      // 留在旧文件夹里。loadSyncedIndex 就地把种子补进同一个 docMap 对象。
      await this.requireGateway().loadSyncedIndex()
      const res = await migrateDocsToFolder(this.client, {
        notebookId,
        targetFolder,
        docIds: [...new Set(Object.values(this.sourceDocMap))],
      })
      this.migrationPending = false
      // 注意：**不清空 knownFolders**。迁移仍可能漏搬（种子也看不到的文档、跳过的、失败的），
      // 清空会让 L3a 不再查旧文件夹，只剩滞后 1–2s 的 L3b，重新打开重复建档窗口。
      // 保留的代价只是每个未命中 source 几次零延迟查找。
      if (res.moved > 0) showMessage(this.i18n.movedDocs.replace('${count}', String(res.moved)))
    } catch (error) {
      // 保持 migrationPending=true，下次同步再试。迁移失败不该让整轮同步失败：
      // 旧文件夹还在 knownFolders 里，L3a 照样找得到那些文档，不会重复建档，最多是位置没变。
      if (error instanceof SyncIndexError) {
        // 种子不可信 → 迁移无从谈起，但这不是"迁移坏了"，日志必须能区分，否则排查时因果颠倒。
        // **刻意不 re-throw**：runSync 只有 try/finally 且调用点都是 `void this.runSync(...)`，
        // 抛出会变成 unhandled rejection；而且会跳过下面 engine.sync() 对 index_error 的
        // UI 提示——紧接着的 sync 会再查一次索引并把 index_error 正常报给用户。
        console.error('[Acorny] Skipped folder migration: synced index not trustworthy:', error.message)
      } else {
        console.error('[Acorny] Folder migration failed, will retry next sync:', error)
      }
    }
  }

  /** 同步中给顶栏图标加/去旋转动效（思源内置 `fn__rotate`）。 */
  private setSyncingIndicator(on: boolean): void {
    const svg = this.topBarElement?.querySelector('svg')
    if (svg) svg.classList.toggle('fn__rotate', on)
  }

  /**
   * 每次打开设置都重建面板，让 draft 从当前已保存的 `this.settings` 重新初始化。
   * 否则 draft 只在 onload 建一次、长期存活：改了输入框但没点保存（如 ESC 关闭）时
   * 编辑残留在 draft 里，下次打开会被 `el.value = draft[key]` 读出来，表现为
   * “未保存的修改却被记住”，且下次直接点保存会把这些放弃的编辑一并写入。
   */
  openSetting(): void {
    this.buildSettingPanel()
    this.setting.open(this.name)
  }

  /**
   * 把 draft 提交为正式设置并落盘，返回目标位置变更计划。**不触发同步**——
   * 由调用方决定：思源自带的确认按钮走 'settings'（仅目标位置变了才同步），
   * 面板里的「保存并立即同步」走 'manual'（同时确认目的地）。
   */
  private applyDraft(draft: AcornySettings): ReturnType<typeof planDestinationChange> {
    const prev = { notebookId: this.settings.notebookId, docFolderPath: this.settings.docFolderPath }
    this.settings = { ...draft }
    const plan = planDestinationChange(prev, this.settings)
    // 记住旧文件夹：迁移跑完之前（或万一没跑成），L3a 仍要能在那里找到已有文档。
    if (plan.folderChanged) this.rememberFolder(prev.docFolderPath)
    // 换笔记本同样要迁移：docMap 里的文档是按 block id 校验的，与笔记本无关，
    // 不搬的话新高亮会继续写进旧笔记本，换笔记本形同无效。
    if (plan.needsMigration) this.migrationPending = true
    void this.persist()
    // 保存后立即按新 interval 重排自动同步：0→正数要能启动，正数→0 要能停。
    this.scheduleAuto(this.settings.pollIntervalMinutes > 0 ? this.settings.pollIntervalMinutes * 60_000 : null)
    return plan
  }

  private buildSettingPanel(): void {
    const draft: AcornySettings = { ...this.settings }
    /** 目的地实时预览（笔记本名 / 文件夹）。用户踩的坑正是"保存那刻不知道会写到哪"。 */
    let renderDestination: () => void = () => {}
    this.setting = new Setting({
      confirmCallback: () => {
        // 只有目标位置变了才立刻同步，让新设置马上可见；改 token / 间隔不打扰。
        // 若此刻正有同步在跑，这次会被单飞门挡掉——migrationPending 已持久化，下一轮补做。
        if (this.applyDraft(draft).destinationChanged) void this.runSync('settings')
      },
    })

    const textInput = (key: 'serverUrl' | 'docFolderPath') => () => {
      const el = document.createElement('input')
      el.className = 'b3-text-field fn__block'
      el.type = 'text'
      el.value = draft[key]
      el.addEventListener('input', () => { draft[key] = el.value; renderDestination() })
      return el
    }

    this.setting.addItem({
      title: this.i18n.settingServerUrl,
      description: this.i18n.settingServerUrlDesc,
      createActionElement: textInput('serverUrl'),
    })
    this.setting.addItem({
      title: this.i18n.settingExportToken,
      description: this.i18n.settingExportTokenDesc,
      createActionElement: () => {
        const el = document.createElement('input')
        el.className = 'b3-text-field fn__block'
        el.type = 'password'
        el.value = draft.exportToken
        el.addEventListener('input', () => { draft.exportToken = el.value })
        return el
      },
    })
    this.setting.addItem({
      title: this.i18n.settingNotebook,
      description: this.i18n.settingNotebookDesc,
      createActionElement: () => {
        const el = document.createElement('select')
        el.className = 'b3-select fn__block'
        const fill = (nbs: Notebook[]) => {
          el.replaceChildren()
          // 首项是空占位。没有它的话，<select> 会自动显示列表第一个笔记本，下面那句
          // 「所见即所存」就会把它静默写进 draft——用户从没碰过下拉，目标笔记本却已被定死，
          // 再叠加默认文件夹 /Acorny 与自动同步，等于用一套没人确认过的目的地往笔记里写。
          const placeholder = document.createElement('option')
          placeholder.value = ''
          placeholder.textContent = this.i18n.selectNotebookPlaceholder
          el.append(placeholder)
          for (const nb of nbs) {
            const opt = document.createElement('option')
            opt.value = nb.id
            opt.textContent = nb.name
            el.append(opt)
          }
          // <select> 不改动就不触发 change，值不会写进 draft，所以填充后要主动对齐一次。
          // 但**列表没加载完时绝不能回写**——那会把持久化的笔记本清成空（见 pickNotebookValue）。
          draft.notebookId = pickNotebookValue(nbs.map((nb) => nb.id), draft.notebookId)
          el.value = draft.notebookId
          renderDestination()
        }
        fill(this.notebooks) // 先用已有缓存填（可能为空）
        // 每次打开设置都现拉一次并回填，覆盖"插件刚加载就打开设置、列表还没到"的异步竞态。
        void this.client.lsNotebooks()
          .then((nbs) => { this.notebooks = nbs; fill(nbs) })
          .catch(() => {})
        el.addEventListener('change', () => { draft.notebookId = el.value; renderDestination() })
        return el
      },
    })
    this.setting.addItem({
      title: this.i18n.settingFolder,
      description: this.i18n.settingFolderDesc,
      createActionElement: textInput('docFolderPath'),
    })
    this.setting.addItem({
      title: this.i18n.settingSyncOnStartup,
      description: this.i18n.settingSyncOnStartupDesc,
      createActionElement: () => {
        const el = document.createElement('input')
        el.className = 'b3-switch fn__flex-center'
        el.type = 'checkbox'
        el.checked = draft.syncOnStartup
        el.addEventListener('change', () => { draft.syncOnStartup = el.checked })
        return el
      },
    })
    this.setting.addItem({
      title: this.i18n.settingPollInterval,
      description: this.i18n.settingPollIntervalDesc,
      createActionElement: () => {
        const el = document.createElement('input')
        el.className = 'b3-text-field fn__block'
        el.type = 'number'
        el.min = '0'
        el.value = String(draft.pollIntervalMinutes)
        el.addEventListener('input', () => { draft.pollIntervalMinutes = Number(el.value) || 0 })
        return el
      },
    })

    // 首次同步入口。顶栏那个刷新图标新用户根本发现不了，而"手动跑一次"又是启用自动同步的
    // 前提条件（见 inited），所以必须在配置现场给一个显眼的行动点。
    this.setting.addItem({
      title: this.i18n.settingSyncNow,
      description: this.inited
        ? this.i18n.settingSyncNowDescConfirmed
        : this.i18n.settingSyncNowDescUnconfirmed,
      direction: 'column',
      createActionElement: () => {
        const box = document.createElement('div')
        const preview = document.createElement('div')
        preview.className = 'ft__smaller ft__on-surface'
        const button = document.createElement('button')
        button.className = 'b3-button b3-button--outline'
        button.textContent = this.i18n.saveAndSyncNow
        button.addEventListener('click', () => {
          // 先提交 draft，再以 'manual' 跑——这一步同时完成初始化，
          // 之后启动同步/定时同步才会放行。
          this.applyDraft(draft)
          void this.runSync('manual')
        })
        // 重置入口。思源卸载插件**不会**删除 data/storage/petal 下的插件数据，所以
        // "删掉重装"并不会回到未初始化状态；没有这个按钮，用户只能去手动删文件。
        const reset = document.createElement('button')
        reset.className = 'b3-button b3-button--cancel'
        reset.style.marginInlineStart = '8px'
        reset.textContent = this.i18n.resetInited
        reset.disabled = !this.inited
        reset.addEventListener('click', () => {
          this.inited = false
          this.clearAuto() // 立刻停掉已排期的定时同步，不必等下一次重启
          void this.persist()
          reset.disabled = true
          showMessage(this.i18n.resetInitedDone, 15000)
        })
        // 实时显示"文档会写到哪"，未选笔记本时明确提示，避免默认值被静默采用。
        renderDestination = () => {
          const nb = this.notebooks.find((n) => n.id === draft.notebookId)
          preview.textContent = nb
            ? this.i18n.destinationPreview
              .replace('${notebook}', nb.name)
              .replace('${folder}', normalizeFolderPath(draft.docFolderPath))
            : this.i18n.destinationUnset
        }
        renderDestination()
        box.append(preview, button, reset)
        return box
      },
    })
  }

  private async loadPersisted(): Promise<void> {
    const data = ((await this.loadData(STORAGE)) as PersistShape | null) ?? {}
    this.settings = { ...DEFAULT_SETTINGS, ...(data.settings ?? {}) }
    // 就地 mutate：网关持有的是同一个对象引用，不能整体替换。
    Object.assign(this.sourceDocMap, data.sourceDocMap ?? {})
    this.knownFolders = (data.knownFolders ?? []).map(normalizeFolderPath)
    this.migrationPending = data.migrationPending ?? false
    // 高水位至少不低于已持久化的映射条目数（兼容此前没存该字段的 data.json）。
    this.knownSourceCount = Math.max(data.knownSourceCount ?? 0, Object.keys(this.sourceDocMap).length)
    this.inited = readInitedFlag(data)
  }

  private async persist(): Promise<void> {
    const payload: PersistShape = {
      settings: this.settings,
      sourceDocMap: this.sourceDocMap,
      knownFolders: this.knownFolders,
      migrationPending: this.migrationPending,
      knownSourceCount: this.knownSourceCount,
      inited: this.inited,
    }
    await this.saveData(STORAGE, payload)
  }
}
