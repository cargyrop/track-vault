/**
 * The app's side of the AI drop box.
 *
 * The merge itself happens on the server (see `vite-plugin-library.ts`), so the
 * app only needs to find out *what happened* via `/api/library/revision` for
 * polling. It returns the current revision, what is waiting in the drop box,
 * and the last merge report, so the poll can answer both "did the library
 * change?" and "did my batch land?" from one request instead of re-downloading
 * the whole document every four seconds.
 */

import type { MergeReport } from './agentInbox'

export interface InboxState {
  present: boolean
  valid: boolean
  body: string | null
}

export interface AgentStatus {
  revision: string
  inbox: InboxState
  report: MergeReport | null
}

/**
 * One cheap poll of the library's revision.
 *
 * Returns null when the agent API is not there — the app also runs against the
 * in-memory SQLite fallback, where none of this applies — so the caller can
 * simply skip the feature instead of treating it as an error.
 */
export async function fetchAgentStatus(
  endpoint = '/api/library/revision',
): Promise<AgentStatus | null> {
  try {
    const res = await fetch(endpoint, { cache: 'no-store' })
    if (!res.ok) return null
    const data = (await res.json()) as Partial<AgentStatus> & {
      inbox?: { present?: boolean; valid?: boolean; body?: string | null }
    }
    return {
      revision: String(data.revision ?? ''),
      inbox: {
        present: Boolean(data.inbox?.present),
        valid: data.inbox?.valid !== false,
        body: data.inbox?.body ?? null,
      },
      report: (data.report as MergeReport | null) ?? null,
    }
  } catch {
    return null
  }
}
