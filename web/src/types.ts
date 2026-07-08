export interface SessionInfo {
  sessionId: string
  summary: string
  directory: string
  projectId: string
  deviceName?: string
  serverUrl?: string
  registeredAt: number
  updatedAt: number
}

export interface ClientInfo {
  clientId: string
  ip: string
  lastSeen: number
  sessions: string[]
}

export interface PendingAskInfo {
  requestId: string
  callerClientId: string
  fromSessionId: string
  targetSessionId: string
  questionPreview?: string
  timeoutMs: number
  createdAt: number
}

export interface ActivityEntry {
  id: string
  type:
    | "session:registered"
    | "session:unregistered"
    | "client:connected"
    | "client:disconnected"
    | "ask:created"
    | "ask:replied"
    | "ask:error"
    | "ask:timeout"
  timestamp: number
  data: Record<string, unknown>
}

export interface ServerActivityEntry {
  at: number
  kind: string
  data: unknown
}

export interface Snapshot {
  sessions: SessionInfo[]
  clients: ClientInfo[]
  pendingAsks: PendingAskInfo[]
  activity: ServerActivityEntry[]
}

export type DashboardEvent =
  | { type: "snapshot"; data: Snapshot }
  | { type: "session:registered"; data: { sessionId: string; entry: SessionInfo; clientId: string } }
  | { type: "session:unregistered"; data: { sessionId: string; existed: boolean } }
  | { type: "client:connected"; data: { clientId: string; ip: string } }
  | { type: "client:disconnected"; data: { clientId: string; sessionCount: number } }
  | {
      type: "ask:created"
      data: {
        requestId: string
        fromSessionId: string
        toSessionId: string
        questionPreview: string
        timeoutMs: number
        createdAt: number
      }
    }
  | { type: "ask:replied"; data: { requestId: string; replyLen: number; error?: string; durationMs: number } }
  | { type: "ask:error"; data: { requestId: string; error: string } }
  | { type: "ask:timeout"; data: { requestId: string; targetSessionId: string } }
