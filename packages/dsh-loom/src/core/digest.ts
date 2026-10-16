/**
 * 确定性摘要。
 *
 * 规则（来自 07 第 5 节）：同一内容 + 同一模板版本必须产生同一个 payloadHash；
 * 时间、requestId 这类信封元数据**不参与**内容 hash。
 * 所以 canonicalize 会把对象键排序、丢掉 undefined，数组顺序保持。
 */
import { createHash } from 'node:crypto'

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    const src = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(src).sort()) {
      const v = src[key]
      if (v === undefined) continue
      out[key] = canonicalize(v)
    }
    return out
  }
  return value
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 内容摘要：先规范化再 sha256。 */
export function contentDigest(value: unknown): string {
  return sha256Hex(canonicalJson(value))
}

export function shortDigest(value: unknown): string {
  return contentDigest(value).slice(0, 16)
}
