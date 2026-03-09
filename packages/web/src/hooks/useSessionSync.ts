import { useState, useEffect, useRef, useCallback } from "react";
import type { SessionState, WSSyncMessage } from "@lgtm-anywhere/shared";

interface UseSessionSyncReturn {
  stateMap: Map<string, SessionState>;
  getState: (sessionId: string) => SessionState | undefined;
}

export function useSessionSync(): UseSessionSyncReturn {
  const [stateMap, setStateMap] = useState<Map<string, SessionState>>(
    new Map()
  );
  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const connect = useCallback(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/sync`);
    wsRef.current = ws;

    ws.onopen = () => {
      retryRef.current = 0;
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
      }
    };

    ws.onclose = () => {
      wsRef.current = null;
      // Exponential backoff: 1s, 2s, 4s, 8s, …, max 30s
      const delay = Math.min(1000 * 2 ** retryRef.current, 30_000);
      retryRef.current++;
      timerRef.current = setTimeout(connect, delay);
    };

    ws.onerror = () => {
      // onclose will fire after onerror — reconnect handled there
    };
  }, []);

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
    [stateMap]
  );

  return { stateMap, getState };
}
