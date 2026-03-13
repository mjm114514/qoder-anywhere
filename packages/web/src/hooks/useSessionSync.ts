import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import type { SessionState, WSSyncMessage } from "@qoder-anywhere/shared";
import { fetchWsToken, buildWsUrl } from "../api";

interface UseSessionSyncReturn {
  stateMap: Map<string, SessionState>;
  getState: (sessionId: string) => SessionState | undefined;
  onSessionCreated: (
    callback: (sessionId: string, cwd: string) => void,
  ) => () => void;
  activeSessionCountByCwd: Map<string, number>;
  activeTerminalCountByCwd: Map<string, number>;
  /** True once the sync WS has connected and delivered its initial snapshot. */
  synced: boolean;
}

export function useSessionSync(): UseSessionSyncReturn {
  const [stateMap, setStateMap] = useState<Map<string, SessionState>>(
    new Map(),
  );
  // sessionId → cwd mapping, built from session_created events
  const [sessionCwdMap, setSessionCwdMap] = useState<Map<string, string>>(
    new Map(),
  );
  // terminalId → cwd mapping, built from terminal_created/closed events
  const [terminalCwdMap, setTerminalCwdMap] = useState<Map<string, string>>(
    new Map(),
  );
  const [synced, setSynced] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sessionCreatedListeners = useRef<
    Set<(sessionId: string, cwd: string) => void>
  >(new Set());

  const connectRef = useRef<(() => void) | undefined>(undefined);

  const connect = useCallback(() => {
    (async () => {
      const token = await fetchWsToken();
      const url = buildWsUrl("/ws/sync", token || undefined);
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        retryRef.current = 0;
        setSynced(true);
      };

      ws.onmessage = (ev) => {
        let msg: WSSyncMessage;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }

        if (msg.event === "session_state") {
          setStateMap((prev) => {
            const next = new Map(prev);
            next.set(msg.data.sessionId, msg.data.state);
            return next;
          });
        } else if (msg.event === "session_created") {
          setSessionCwdMap((prev) => {
            const next = new Map(prev);
            next.set(msg.data.sessionId, msg.data.cwd);
            return next;
          });
          for (const listener of sessionCreatedListeners.current) {
            listener(msg.data.sessionId, msg.data.cwd);
          }
        } else if (msg.event === "terminal_created") {
          setTerminalCwdMap((prev) => {
            const next = new Map(prev);
            next.set(msg.data.terminalId, msg.data.cwd);
            return next;
          });
        } else if (msg.event === "terminal_closed") {
          setTerminalCwdMap((prev) => {
            const next = new Map(prev);
            next.delete(msg.data.terminalId);
            return next;
          });
        }
      };

      ws.onclose = () => {
        wsRef.current = null;
        setSynced(false);
        // Exponential backoff: 1s, 2s, 4s, 8s, …, max 30s
        const delay = Math.min(1000 * 2 ** retryRef.current, 30_000);
        retryRef.current++;
        timerRef.current = setTimeout(() => connectRef.current?.(), delay);
      };

      ws.onerror = () => {
        // onclose will fire after onerror — reconnect handled there
      };
    })();
  }, []);

  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  useEffect(() => {
    connect();

    return () => {
      clearTimeout(timerRef.current);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [connect]);

  const getState = useCallback(
    (sessionId: string) => stateMap.get(sessionId),
    [stateMap],
  );

  const onSessionCreated = useCallback(
    (callback: (sessionId: string, cwd: string) => void) => {
      sessionCreatedListeners.current.add(callback);
      return () => {
        sessionCreatedListeners.current.delete(callback);
      };
    },
    [],
  );

  // Derive per-cwd active session counts from stateMap + sessionCwdMap
  const activeSessionCountByCwd = useMemo(() => {
    const counts = new Map<string, number>();
    for (const [sessionId, state] of stateMap) {
      if (state === "active" || state === "idle") {
        const cwd = sessionCwdMap.get(sessionId);
        if (cwd) {
          counts.set(cwd, (counts.get(cwd) ?? 0) + 1);
        }
      }
    }
    return counts;
  }, [stateMap, sessionCwdMap]);

  // Derive per-cwd active terminal counts from terminalCwdMap
  const activeTerminalCountByCwd = useMemo(() => {
    const counts = new Map<string, number>();
    for (const [, cwd] of terminalCwdMap) {
      counts.set(cwd, (counts.get(cwd) ?? 0) + 1);
    }
    return counts;
  }, [terminalCwdMap]);

  return {
    stateMap,
    getState,
    onSessionCreated,
    activeSessionCountByCwd,
    activeTerminalCountByCwd,
    synced,
  };
}
