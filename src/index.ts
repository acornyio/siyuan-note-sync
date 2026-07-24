import { confirm, Plugin, Setting, showMessage } from 'siyuan'
import type { AcornySettings, PluginState } from './types'
import { fetchFeedPage } from './apiClient'
import { createForwardProxyHttp } from './httpProxy'
import { createSiyuanClient, type Notebook } from './siyuanClient'
import { createSiyuanGateway, type SiyuanGateway } from './siyuanGateway'
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
const DEFAULT_STATE: PluginState = { lastCursor: null, connectionId: null }

interface PersistShape {
  settings?: Partial<AcornySettings>
  state?: PluginState
}

export default class AcornySyncPlugin extends Plugin {
  private settings: AcornySettings = { ...DEFAULT_SETTINGS }
  private state: PluginState = { ...DEFAULT_STATE }
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
    this.addCommand({ langKey: 'resyncAll', hotkey: '', callback: () => this.resyncAll() })

    await this.loadPersisted()
    // 卸载竞态：插件可能在 loadPersisted 期间已被禁用/卸载，别再继续建 engine/设置面板/启动同步。
    if (this.disposed) return

    const http = createForwardProxyHttp(this.client.forwardProxy)
    this.engine = new SyncEngine({
      getSettings: () => this.settings,
      loadState: async () => this.state,
      saveState: async (s) => { this.state = s; await this.persist() },
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
    this.activeGateway = createSiyuanGateway(this.client, {
      notebookId: this.settings.notebookId,
      docFolderPath: this.settings.docFolderPath,
    })
    try {
      const res = await this.engine.sync()
      if (this.disposed) return
      if (res.status === 'completed') {
        // 自动同步无新增时不打扰；手动或有新增才提示。
        if (manual || res.added > 0) showMessage(this.i18n.syncedCount.replace('${count}', String(res.added)))
      } else if (res.status === 'auth_failed') {
        showMessage(this.i18n.authFailed)
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
    }
  }

  /**
   * 忽略已保存游标、从头全量重新同步。用于：删文档后重建、或怀疑漏同步。
   * 已存在的块靠 SQL 去重跳过（不会重复）；被删的文档会重新拉全量并重建。
   */
  private resyncAll(): void {
    if (this.disposed || !this.ready || this.syncing) return
    confirm(this.i18n.resyncAll, this.i18n.resyncConfirm, () => {
      void (async () => {
        this.state = { ...this.state, lastCursor: null }
        await this.persist()
        await this.runSync(true)
      })()
    })
  }

  /** 同步中给顶栏图标加/去旋转动效（思源内置 `fn__rotate`）。 */
  private setSyncingIndicator(on: boolean): void {
    const svg = this.topBarElement?.querySelector('svg')
    if (svg) svg.classList.toggle('fn__rotate', on)
  }

  private buildSettingPanel(): void {
    const draft: AcornySettings = { ...this.settings }
    this.setting = new Setting({
      confirmCallback: () => {
        this.settings = { ...draft }
        void this.persist()
        // 保存后立即按新 interval 重排自动同步：0→正数要能启动，正数→0 要能停。
        this.scheduleAuto(this.settings.pollIntervalMinutes > 0 ? this.settings.pollIntervalMinutes * 60_000 : null)
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
        for (const nb of this.notebooks) {
          const opt = document.createElement('option')
          opt.value = nb.id
          opt.textContent = nb.name
          el.append(opt)
        }
        // <select> 不改动就不触发 change，值不会写进 draft。构建后立即把「当前显示的值」
        // 写回 draft：已选过则显示该项，否则默认第一个（所见即所存），避免"显示了却没提交"。
        if (draft.notebookId) el.value = draft.notebookId
        if (this.notebooks.length > 0) draft.notebookId = el.value
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

    // 后台加载笔记本列表填充下拉（打开设置面板时 createActionElement 读取 this.notebooks）。
    void this.client
      .lsNotebooks()
      .then((nbs) => { this.notebooks = nbs })
      .catch(() => { this.notebooks = [] })
  }

  private async loadPersisted(): Promise<void> {
    const data = ((await this.loadData(STORAGE)) as PersistShape | null) ?? {}
    this.settings = { ...DEFAULT_SETTINGS, ...(data.settings ?? {}) }
    this.state = { ...DEFAULT_STATE, ...(data.state ?? {}) }
  }

  private async persist(): Promise<void> {
    const payload: PersistShape = { settings: this.settings, state: this.state }
    await this.saveData(STORAGE, payload)
  }
}
