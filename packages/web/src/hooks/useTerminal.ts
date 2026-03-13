import { useRef, useEffect, useState, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import type { WSTerminalServerMessage } from "@qoder-anywhere/shared";
import { fetchWsToken, buildWsUrl } from "../api";

export interface UseTerminalReturn {
  containerRef: React.RefObject<HTMLDivElement | null>;
  isConnected: boolean;
  exitCode: number | null;
  fit: () => void;
  focus: () => void;
}

export function useTerminal(
  terminalId: string | null,
  wsPathPrefix?: string,
): UseTerminalReturn {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);

  const [isConnected, setIsConnected] = useState(false);
  const [exitCode, setExitCode] = useState<number | null>(null);

  // Render-phase reset when terminalId changes (avoids setState in effect)
  const [prevTerminalId, setPrevTerminalId] = useState(terminalId);
  if (prevTerminalId !== terminalId) {
    setPrevTerminalId(terminalId);
    setExitCode(null);
    setIsConnected(false);
  }

  const fit = useCallback(() => {
    fitRef.current?.fit();
  }, []);

  const focus = useCallback(() => {
    termRef.current?.focus();
  }, []);

  // Single effect: create xterm + connect WS as one atomic unit.
  // This prevents Strict Mode from creating orphaned WS connections.
  useEffect(() => {
    if (!terminalId || !containerRef.current) return;

    // ── xterm setup ──
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'Menlo', 'Monaco', 'Courier New', monospace",
      theme: {
        background: "#ffffff",
        foreground: "#1a1a1a",
        cursor: "#1a1a1a",
        selectionBackground: "#b5d5ff",
        selectionForeground: "#1a1a1a",
        black: "#1a1a1a",
        red: "#d32f2f",
        green: "#388e3c",
        yellow: "#f9a825",
        blue: "#1976d2",
        magenta: "#7b1fa2",
        cyan: "#0097a7",
        white: "#d4d4d4",
        brightBlack: "#666666",
        brightRed: "#ef5350",
        brightGreen: "#66bb6a",
        brightYellow: "#ffee58",
        brightBlue: "#42a5f5",
        brightMagenta: "#ab47bc",
        brightCyan: "#26c6da",
        brightWhite: "#ffffff",
      },
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    fitRef.current = fitAddon;
    termRef.current = term;

    term.open(containerRef.current);
    requestAnimationFrame(() => fitAddon.fit());

    // ── WS connection ──
    let disposed = false;
    let retryCount = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let ws: WebSocket | null = null;

    const connect = () => {
      if (disposed) return;

      (async () => {
        const token = await fetchWsToken();
        if (disposed) return;

        const wsBase = wsPathPrefix ?? "/ws";
        const url = buildWsUrl(
          `${wsBase}/terminal/${terminalId}`,
          token || undefined,
        );
        ws = new WebSocket(url);

        ws.onopen = () => {
          retryCount = 0;
          setIsConnected(true);
          // Send initial size
          ws!.send(
            JSON.stringify({
              type: "resize",
              cols: term.cols,
              rows: term.rows,
            }),
          );
        };

        ws.onmessage = (ev) => {
          let msg: WSTerminalServerMessage;
          try {
            msg = JSON.parse(ev.data);
          } catch {
            return;
          }
          if (msg.type === "output") {
            term.write(msg.data);
          } else if (msg.type === "exit") {
            setExitCode(msg.exitCode);
            setIsConnected(false);
          }
        };

        ws.onclose = () => {
          ws = null;
          if (disposed) return;
          setIsConnected(false);
          const delay = Math.min(1000 * 2 ** retryCount, 30_000);
          retryCount++;
          retryTimer = setTimeout(connect, delay);
        };

        ws.onerror = () => {
          // onclose fires after onerror — reconnect handled there
        };
      })();
    };

    connect();

    // terminal input → WS
    const inputDisposable = term.onData((data) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "input", data }));
      }
    });

    // terminal resize → WS
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols, rows }));
      }
    });

    // ── cleanup ──
    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      inputDisposable.dispose();
      resizeDisposable.dispose();
      fitRef.current = null;
      termRef.current = null;
      term.dispose();
      if (ws) {
        ws.onclose = null; // prevent reconnect on intentional close
        ws.close();
        ws = null;
      }
    };
  }, [terminalId, wsPathPrefix]);

  return { containerRef, isConnected, exitCode, fit, focus };
}
