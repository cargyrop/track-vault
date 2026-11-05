/**
 * The app's side of the AI drop box.
 *
 * The merge itself happens on the server (see `vite-plugin-library.ts`), so the
 * app only needs to find out *what happened*. That is two small reads:
 *
 * - `/api/library/revision` for polling. It returns the current revision, what
 *   is waiting in the drop box, and the last merge report, so the poll can
 *   answer both "did the library change?" and "did my batch land?" from one
 *   request instead of re-downloading the whole document every four seconds.
 * - `/api/agent/context` for a person who wants to paste the library summary
 *   into a chat window by hand.
 * - `/api/agent/inbox` for submitting a batch pasted out of a chat window, and
 *   `/api/agent/backups` + `/api/agent/restore` for the undo an unattended bulk
 *   write needs.
 *
 * All of them are used by the Agent panel. None is required for the app to run,
 * which is why the reads return null rather than throwing: with the in-memory
 * SQLite fallback there is no server to ask, and the panel simply explains that
 * the launcher has to be running.
 */

import type { AgentContext, MergeReport } from './agentInbox'

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

/**
 * The compact library summary, for handing to a model by hand.
 *
 * Null when unavailable, so the caller can fall back to telling the user where
 * the file is rather than showing an error.
 */
export async function fetchAgentContext(
  endpoint = '/api/agent/context',
): Promise<AgentContext | null> {
  try {
    const res = await fetch(endpoint, { cache: 'no-store' })
    if (!res.ok) return null
    return (await res.json()) as AgentContext
  } catch {
    return null
  }
}

/** One snapshot from `data/backups/`, newest first. */
export interface BackupEntry {
  name: string
  /** File timestamp, ISO. Empty when the filesystem would not say. */
  at: string
  /** How many tracks it holds, when it could be read. */
  tracks: number | null
}

/** The snapshots a merge can be undone from. Null when there is no server. */
export async function fetchBackups(
  endpoint = '/api/agent/backups',
): Promise<BackupEntry[] | null> {
  try {
    const res = await fetch(endpoint, { cache: 'no-store' })
    if (!res.ok) return null
    const data = (await res.json()) as { backups?: BackupEntry[] }
    return Array.isArray(data.backups) ? data.backups : []
  } catch {
    return null
  }
}

/**
 * Puts a snapshot back.
 *
 * Throws with the server's message on refusal rather than returning null: a
 * restore that did not happen has to be said out loud, and the difference
 * between "no server" and "that backup is gone" is exactly what the panel shows.
 */
export async function restoreBackup(
  name: string,
  endpoint = '/api/agent/restore',
): Promise<{ tracks: number }> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  const data = (await res.json().catch(() => ({}))) as {
    tracks?: number
    error?: string
  }
  if (!res.ok) throw new Error(data.error || 'Could not restore that backup.')
  return { tracks: Number(data.tracks ?? 0) }
}

/**
 * Submits a pasted batch.
 *
 * The server merges before answering and hands back the report it wrote, so the
 * panel shows the real outcome rather than an optimistic guess at one.
 */
export async function submitInbox(
  body: string,
  endpoint = '/api/agent/inbox',
): Promise<MergeReport | null> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  })
  const data = (await res.json().catch(() => ({}))) as {
    report?: MergeReport | null
    error?: string
  }
  if (!res.ok) throw new Error(data.error || 'Could not apply that batch.')
  return data.report ?? null
}