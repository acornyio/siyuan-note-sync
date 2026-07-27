import { Plugin, Setting, showMessage } from 'siyuan'
import type { AcornySettings } from './types'
import { fetchFeedPage } from './apiClient'
import { createForwardProxyHttp } from './httpProxy'
import { createSiyuanClient, type Notebook } from './siyuanClient'
import { createSiyuanGateway, type SiyuanGateway } from './siyuanGateway'
import { migrateDocsToFolder, planDestinationChange } from './folderMigration'
import { normalizeFolderPath } from './docPath'
import { SyncEngine } from './syncEngine'
import { nextAutoDelayMs } from './scheduler'

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
   * 它不是唯一真相：每次使用都经 getBlockAttrs 无延迟校验，指向已删/已改的条目会被丢弃。
   */
  private sourceDocMap: Record<string, string> = {}
  /**
   * 用过的历史文件夹（不含当前）。改文件夹后已有文档可能还留在旧处（迁移失败、用户手动挪过、
   * 迁移尚未跑），L3a 零延迟查找必须连旧文件夹一起找，否则它们不可见 → 重新打开重复建档的窗口。
   */
  private knownFolders: string[] = []
  /** 目标位置刚变更，下一次同步开始前要先把已有文档搬过去。 */
  private migrationPending = false

  async onload(): Promise<void> {
    // 先「同步」注册 UI：siyuan 的 onload 是同步 void 生命周期，宿主不保证 await 完成；
    // 在首个 await 之后再 addTopBar/addCommand 会有卸载/布局竞态。this.i18n 已由框架加载。
    this.topBarElement = this.addTopBar({
      icon: 'iconRefresh',
      title: this.i18n.syncNow,
      position: 'right',
      callback: () => void this.runSync(true),
    })
    this.addCommand({ langKey: 'syncNow', hotkey: '', callback: () => void this.runSync(true) })

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

    if (this.settings.syncOnStartup) void this.runSync()
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
    this.autoTimer = window.setTimeout(() => { void this.runSync() }, delayMs)
  }

  private clearAuto(): void {
    if (this.autoTimer !== null) {
      window.clearTimeout(this.autoTimer)
      this.autoTimer = null
    }
  }

  private async runSync(manual = false): Promise<void> {
    if (this.disposed || !this.ready) return
    // 插件级单飞门：必须在设置 activeGateway 之前拦截并发触发（双击 / 启动同步与定时器重叠），
    // 否则第二次 runSync 会先把 activeGateway 改成新目的地，正在进行的第一次同步后续页面
    // 就会写到新目的地——重新引入「同步中途切换 notebook/folder」的问题。
    if (this.syncing) return
    if (!this.settings.exportToken) { showMessage(this.i18n.setTokenFirst); return }
    if (!this.settings.notebookId) { showMessage(this.i18n.selectNotebookFirst); return }
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
        if (manual) showMessage(this.i18n.backoff.replace('${seconds}', String(res.retryAfterSeconds)))
      }
      if (res.status !== 'skipped') {
        this.scheduleAuto(nextAutoDelayMs(res, this.settings.pollIntervalMinutes))
      }
    } finally {
      this.syncing = false
      this.setSyncingIndicator(false)
      this.activeGateway = null
      // 无条件落盘本次学到的 source→doc 映射——中止、异常、卸载路径同样要落。
      // 已经建出来的文档如果没被记住，下次同步就会认为它们不存在并再建一遍：
      // 这正是本次事故 6850 篇重复文档的放大路径。
      await this.persist().catch((e: unknown) => console.error('[Acorny] persist failed:', e))
    }
  }

  /** 记住一个用过的文件夹（去重、且不记当前文件夹）。 */
  private rememberFolder(folder: string): void {
    const norm = normalizeFolderPath(folder)
    if (norm === normalizeFolderPath(this.settings.docFolderPath)) return
    if (!this.knownFolders.includes(norm)) this.knownFolders.push(norm)
  }

  /**
   * 把已有 Acorny 文档搬到当前目标文件夹。迁移失败不应让整轮同步失败——
   * 旧文件夹已记进 knownFolders，L3a 照样找得到那些文档，不会重复建档，最多是位置没变。
   */
  private async migrateToCurrentFolder(notebookId: string, targetFolder: string): Promise<void> {
    try {
      const res = await migrateDocsToFolder(this.client, {
        notebookId,
        targetFolder,
        docIds: [...new Set(Object.values(this.sourceDocMap))],
      })
      this.migrationPending = false
      // 全部搬完才能忘掉旧文件夹；有跳过的（已删/非 Acorny）不影响，它们本就不该被找。
      this.knownFolders = []
      if (res.moved > 0) showMessage(this.i18n.movedDocs.replace('${count}', String(res.moved)))
    } catch (error) {
      // 保持 migrationPending=true，下次同步再试。
      console.error('[Acorny] Folder migration failed, will retry next sync:', error)
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

  private buildSettingPanel(): void {
    const draft: AcornySettings = { ...this.settings }
    this.setting = new Setting({
      confirmCallback: () => {
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
        // 只有目标位置变了才立刻同步，让新设置马上可见；改 token / 间隔不打扰。
        // 若此刻正有同步在跑，这次会被单飞门挡掉——migrationPending 已持久化，下一轮补做。
        if (plan.destinationChanged) void this.runSync(true)
      },
    })

    const textInput = (key: 'serverUrl' | 'docFolderPath') => () => {
      const el = document.createElement('input')
      el.className = 'b3-text-field fn__block'
      el.type = 'text'
      el.value = draft[key]
      el.addEventListener('input', () => { draft[key] = el.value })
      return el
    }

    this.setting.addItem({ title: this.i18n.settingServerUrl, createActionElement: textInput('serverUrl') })
    this.setting.addItem({
      title: this.i18n.settingExportToken,
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
      createActionElement: () => {
        const el = document.createElement('select')
        el.className = 'b3-select fn__block'
        const fill = (nbs: Notebook[]) => {
          el.replaceChildren()
          for (const nb of nbs) {
            const opt = document.createElement('option')
            opt.value = nb.id
            opt.textContent = nb.name
            el.append(opt)
          }
          // <select> 不改动就不触发 change，值不会写进 draft。填充后立即把「当前显示的值」
          // 写回 draft：已选过则显示该项，否则默认第一个（所见即所存），避免"显示了却没提交"。
          if (draft.notebookId) el.value = draft.notebookId
          if (nbs.length > 0) draft.notebookId = el.value
        }
        fill(this.notebooks) // 先用已有缓存填（可能为空）
        // 每次打开设置都现拉一次并回填，覆盖"插件刚加载就打开设置、列表还没到"的异步竞态。
        void this.client.lsNotebooks()
          .then((nbs) => { this.notebooks = nbs; fill(nbs) })
          .catch(() => {})
        el.addEventListener('change', () => { draft.notebookId = el.value })
        return el
      },
    })
    this.setting.addItem({ title: this.i18n.settingFolder, createActionElement: textInput('docFolderPath') })
    this.setting.addItem({
      title: this.i18n.settingSyncOnStartup,
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

  }

  private async loadPersisted(): Promise<void> {
    const data = ((await this.loadData(STORAGE)) as PersistShape | null) ?? {}
    this.settings = { ...DEFAULT_SETTINGS, ...(data.settings ?? {}) }
    // 就地 mutate：网关持有的是同一个对象引用，不能整体替换。
    Object.assign(this.sourceDocMap, data.sourceDocMap ?? {})
    this.knownFolders = (data.knownFolders ?? []).map(normalizeFolderPath)
    this.migrationPending = data.migrationPending ?? false
  }

  private async persist(): Promise<void> {
    const payload: PersistShape = {
      settings: this.settings,
      sourceDocMap: this.sourceDocMap,
      knownFolders: this.knownFolders,
      migrationPending: this.migrationPending,
    }
    await this.saveData(STORAGE, payload)
  }
}
