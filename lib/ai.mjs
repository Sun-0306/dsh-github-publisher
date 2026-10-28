/**
 * dsh-github-publisher — AI helpers for the publish form.
 *
 * The plugin can ask the DeepSeek model already configured in DSH (the same
 * credential the user signed into / configured for the assistant) to draft the
 * repository description, Chinese summary, topics and release notes from the
 * plugin's own package.json / README / files. This is the only place the plugin
 * spends model tokens, it never touches GitHub, and the result is always
 * editable in the form before publishing.
 *
 * Pure dependency injection: the caller passes the Host `llm` service and the
 * selected {provider, model}; this module owns the prompt, parsing and bounds.
 */

export const AI_TIMEOUT_MS = 45_000
export const AI_INPUT_MAX_CHARS = 16_000
export const AI_OUTPUT_MAX_CHARS = 8_000

export const AI_SYSTEM_PROMPT = [
  'You write GitHub repository metadata for a DeepSeek Harness (DSH) plugin.',
  'Use ONLY facts present in the provided package.json / README / file list; never invent features.',
  'Reply with STRICT JSON only — no code fences, no prose, no extra keys:',
  '{"description": "<English one-liner, <=350 characters>",',
  ' "descriptionZh": "<中文简介，<=120 字>",',
  ' "topics": ["<5-8 lowercase kebab-case GitHub topics, include dsh and dsh-plugin>"],',
  ' "releaseNotes": "<中文 Markdown，3-6 个以 - 开头的要点，概括这个版本/项目提供的能力>"}',
].join('\n')

/** Build the bounded user prompt from the inspected plugin context. */
export function buildAiUserPrompt({ plugin, manifestText = '', readmeText = '', fileList = [], form = {} }) {
  const parts = []
  parts.push(`Plugin name: ${plugin?.name || ''}`)
  if (plugin?.version) parts.push(`Version: ${plugin.version}`)
  if (plugin?.description) parts.push(`Existing package.json description: ${plugin.description}`)
  if (Array.isArray(plugin?.keywords) && plugin.keywords.length > 0) parts.push(`Existing keywords: ${plugin.keywords.join(', ')}`)
  if (Array.isArray(plugin?.exportsList) && plugin.exportsList.length > 0) parts.push(`Exports: ${plugin.exportsList.join(', ')}`)
  if (plugin?.hasClient) parts.push('Ships a DSH Web UI (dsh.client).')
  if (plugin?.hasHost) parts.push('Ships a Host half (index.js / API / agent tool).')
  if (Array.isArray(fileList) && fileList.length > 0) parts.push(`Files: ${fileList.join(', ')}`)
  const currentDescription = typeof form.description === 'string' ? form.description.trim() : ''
  const currentDescriptionZh = typeof form.descriptionZh === 'string' ? form.descriptionZh.trim() : ''
  if (currentDescription) parts.push(`Current English description to improve: ${currentDescription}`)
  if (currentDescriptionZh) parts.push(`Current Chinese summary to improve: ${currentDescriptionZh}`)
  if (manifestText) parts.push('package.json:', '```json', truncate(manifestText, AI_INPUT_MAX_CHARS * 0.4), '```')
  if (readmeText) parts.push('README (existing):', '```markdown', truncate(readmeText, AI_INPUT_MAX_CHARS * 0.5), '```')
  return truncate(parts.join('\n'), AI_INPUT_MAX_CHARS)
}

/** Strip Markdown fences and return the first balanced {...} object. */
export function extractJsonObject(text) {
  const source = String(text ?? '').replace(/```[A-Za-z0-9_-]*[ \t]*\r?\n?/g, '')
  const start = source.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  return null
}

/** Sanitize a topic list the same way the publish form and Host do. */
export function sanitizeAiTopics(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,\s]+/) : []
  return [...new Set(
    list
      .map((topic) => String(topic).toLowerCase().trim().replace(/[^a-z0-9._-]+/g, '-'))
      .filter((topic) => topic !== '' && topic.length <= 50),
  )].slice(0, 10)
}

/**
 * Parse and bound the model reply into a PublishForm-shaped suggestion.
 * Returns null when unusable. Every field is optional except one non-empty.
 */
export function parseAiSuggestion(rawText) {
  const candidate = extractJsonObject(rawText)
  if (!candidate) return null
  let payload = null
  try {
    payload = JSON.parse(candidate)
  } catch {
    return null
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const description = truncate(typeof payload.description === 'string' ? payload.description.trim() : '', 350)
  const descriptionZh = truncate(typeof payload.descriptionZh === 'string' ? payload.descriptionZh.trim() : '', 200)
  const topics = sanitizeAiTopics(payload.topics)
  const releaseNotes = truncate(typeof payload.releaseNotes === 'string' ? payload.releaseNotes.trim() : '', 2000)
  const suggestion = {}
  if (description) suggestion.description = description
  if (descriptionZh) suggestion.descriptionZh = descriptionZh
  if (topics.length > 0) suggestion.topics = topics
  if (releaseNotes) suggestion.releaseNotes = releaseNotes
  return Object.keys(suggestion).length > 0 ? suggestion : null
}

/** Read a reply to completion with a hard timeout, bounded output. */
export async function collectModelText(llm, route, { system, prompt, timeoutMs = AI_TIMEOUT_MS, signal = null, maxChars = AI_OUTPUT_MAX_CHARS } = {}) {
  const controller = new AbortController()
  const abortOnOuter = () => {
    try {
      controller.abort()
    } catch {
      /* ignore */
    }
  }
  if (signal) {
    if (signal.aborted) abortOnOuter()
    else signal.addEventListener('abort', abortOnOuter, { once: true })
  }
  let timedOut = false
  let timer = null
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      abortOnOuter()
      reject(Object.assign(new Error(`模型在 ${Math.round(timeoutMs / 1000)}s 内没有响应`), { code: 'llm-timeout' }))
    }, timeoutMs)
    timer.unref?.()
  })
  const collectPromise = (async () => {
    let text = ''
    const stream = llm.stream({
      provider: route.provider,
      model: route.model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      signal: controller.signal,
    })
    for await (const chunk of stream) {
      if (!chunk || typeof chunk !== 'object') continue
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        text += chunk.text
        if (text.length >= maxChars) {
          abortOnOuter()
          break
        }
        continue
      }
      if (chunk.type === 'finish') {
        const reason = chunk.reason && typeof chunk.reason === 'object' ? chunk.reason : null
        if (reason && reason.kind === 'error') {
          const failure = reason.failure && typeof reason.failure === 'object' ? reason.failure : null
          const message = failure && typeof failure.message === 'string' && failure.message !== '' ? failure.message : '模型请求失败'
          throw Object.assign(new Error(message), { code: failure && typeof failure.code === 'string' ? failure.code : 'LLM_FAILED' })
        }
        if (reason && reason.kind === 'aborted' && !timedOut) {
          throw Object.assign(new Error('模型请求被中止'), { code: 'llm-aborted' })
        }
      }
    }
    return text
  })()
  collectPromise.catch(() => {})
  try {
    return await Promise.race([collectPromise, timeoutPromise])
  } catch (error) {
    if (timedOut) throw Object.assign(new Error(`模型在 ${Math.round(timeoutMs / 1000)}s 内没有响应`), { code: 'llm-timeout' })
    throw error
  } finally {
    if (timer) clearTimeout(timer)
    if (signal) signal.removeEventListener?.('abort', abortOnOuter)
  }
}

function truncate(text, max) {
  const value = typeof text === 'string' ? text : ''
  return value.length <= max ? value : value.slice(0, max)
}
