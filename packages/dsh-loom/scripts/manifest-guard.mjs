/**
 * 交付 manifest 的守卫：证据文件不许串版本。
 *
 * `.verification/` 会被 `write-manifest.mjs` 整个拷进 `evidence/<版本>/`，而它里面的
 * `installation-record.json` / `desktop-activation.json` 是**上一次交付留下的**。
 * 2026-10-06 实测事故：0.7.6 的证据目录里躺着 0.7.5 的安装记录 —— 因为那一版只
 * 覆盖了 manifest 自己，没重写这两份文件。这里 fail-closed：版本对不上直接不出 manifest。
 */
export function assertEvidenceVersion(packageVersion, name, value) {
  if (!value) return value
  if (value.version !== packageVersion) {
    throw new Error(`${name} 属于版本 ${value.version}，与本次 ${packageVersion} 不一致；请先重写 .verification/${name} 再出 manifest`)
  }
  return value
}
