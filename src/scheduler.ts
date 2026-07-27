import type { SyncResult } from './syncEngine'

/** 谁发起了这次同步。决定是否允许自动写入，以及是否给用户即时反馈。 */
export type SyncTrigger = 'manual' | 'startup' | 'timer' | 'settings'

/**
 * 是否允许这次同步真的跑起来。
 *
 * 目标笔记本、文件夹都有默认值（笔记本下拉曾默认选中列表第一个，文件夹默认 `/Acorny`），
 * 于是「填个 token 点保存」就足以让插件用一套用户从没确认过的目的地往笔记里写。
 * 因此：**首次写入必须由用户显式发起**——手动同步永远放行，并以此完成初始化；
 * 在那之前，启动同步 / 定时同步 / 保存后同步一律不跑。
 *
 * `inited` 与 `syncOnStartup` 是**两件事，不能合并成一个开关**：
 *  - `syncOnStartup` 是用户偏好「我想不想开机就同步」，装完默认 `true`；
 *  - `inited` 是客观事实「初始化完没完」，装完默认 `false`。
 * 只有初始化完成后，`syncOnStartup` 才谈得上生效。
 */
export function mayRunSync(trigger: SyncTrigger, inited: boolean): boolean {
  return trigger === 'manual' || inited
}

/**
 * 决定笔记本下拉「所见即所存」该回写什么值。
 *
 * `available` 为空 = **列表还没加载完**（设置面板会先用空缓存渲染一次，再等 `lsNotebooks`
 * 回来重渲染）。此刻 `<select>` 里只有占位项，任何回写都会把持久化的选择清成空——
 * 界面显示"未选择"，而用户一点保存就真的丢了配置。所以列表未加载时**原样保留**。
 *
 * 列表已加载时才做真正的对齐：选中的笔记本还在就保留，已被删除就清空（与界面一致）。
 */
export function pickNotebookValue(available: string[], current: string): string {
  if (available.length === 0) return current
  return available.includes(current) ? current : ''
}

/**
 * 从持久化数据里读「初始化是否完成」。
 * 兼容旧字段名 `destinationConfirmed`——否则升级后读不到，已经在正常同步的老用户会被
 * 重新上锁、自动同步静默停摆。
 */
export function readInitedFlag(
  data: { inited?: boolean; destinationConfirmed?: boolean } | null | undefined,
): boolean {
  return data?.inited ?? data?.destinationConfirmed ?? false
}

/** 用户此刻是否在看着结果——决定要不要弹提示（定时/启动同步保持安静，避免打扰）。 */
export function isInteractiveTrigger(trigger: SyncTrigger): boolean {
  return trigger === 'manual' || trigger === 'settings'
}

/**
 * 决定下次「自动」同步的延迟：
 * - auth_failed → null（暂停自动，直到一次手动同步重新启用）
 * - index_error → null（索引不可信，重试只会继续重复建档，必须停到人工介入）
 * - backoff     → retryAfterSeconds（近端重试；成功后恢复常规节奏）
 * - completed/skipped → 常规 interval（interval 关闭则 null）
 */
export function nextAutoDelayMs(result: SyncResult, pollIntervalMinutes: number): number | null {
  const interval = pollIntervalMinutes > 0 ? pollIntervalMinutes * 60_000 : null
  switch (result.status) {
    case 'auth_failed':
    case 'index_error':
      return null
    case 'backoff':
      // 自动同步关闭（0=关闭，interval 为 null）时不做任何后台重试，尊重设置语义；
      // 仅在自动同步开启时才安排 429/异常后的近端重试。
      return interval === null ? null : result.retryAfterSeconds * 1000
    case 'completed':
    case 'skipped':
      return interval
  }
}
