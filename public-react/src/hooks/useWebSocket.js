import { useState, useEffect, useRef, useCallback } from 'react';

// ---------------------------------------------------------------------------
// useWebSocket — connects to the backend WS and dispatches events
// ---------------------------------------------------------------------------

export default function useWebSocket() {
  const [connected, setConnected] = useState(false);
  const [typing, setTyping] = useState(null); // { sessionId } when Claude is actively outputting
  const listenersRef = useRef(new Map()); // type → Set<callback>
  const wsRef = useRef(null);
  const reconnectTimer = useRef(null);
  const typingTimer = useRef(null);

  const on = useCallback((type, callback) => {
    if (!listenersRef.current.has(type)) listenersRef.current.set(type, new Set());
    listenersRef.current.get(type).add(callback);
    return () => listenersRef.current.get(type)?.delete(callback);
  }, []);

  useEffect(() => {
    let unmounted = false;

    function connect() {
      if (unmounted) return;
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const prefix = window.location.pathname.startsWith('/sessions') ? '/sessions' : '';
      const wsUrl = `${proto}//${window.location.host}${prefix}/ws`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!unmounted) setConnected(true);
      };

      ws.onclose = () => {
        if (!unmounted) {
          setConnected(false);
          // Reconnect after 3s
          reconnectTimer.current = setTimeout(connect, 3000);
        }
      };

      ws.onerror = () => {
        ws.close();
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          const { type, ...payload } = msg;

          // Typing indicator: active when assistant_message arrives, cleared on result/session_end/session_error
          if (type === 'assistant_message') {
            setTyping({ sessionId: payload.sessionId });
            clearTimeout(typingTimer.current);
            // Auto-clear typing after 10s of no messages (safety net)
            typingTimer.current = setTimeout(() => setTyping(null), 10000);
          }
          if (type === 'result' || type === 'session_end' || type === 'session_error') {
            setTyping(null);
            clearTimeout(typingTimer.current);
          }

          // Dispatch to registered listeners
          const callbacks = listenersRef.current.get(type);
          if (callbacks) {
            for (const cb of callbacks) {
              try { cb(payload); } catch (e) { console.error('WS listener error:', e); }
            }
          }
          // Also dispatch to wildcard listeners
          const wildcardCallbacks = listenersRef.current.get('*');
          if (wildcardCallbacks) {
            for (const cb of wildcardCallbacks) {
              try { cb(type, payload); } catch (e) { console.error('WS wildcard listener error:', e); }
            }
          }
        } catch (e) {
          // ignore non-JSON messages
        }
      };
    }

    connect();

    return () => {
      unmounted = true;
      clearTimeout(reconnectTimer.current);
      clearTimeout(typingTimer.current);
      if (wsRef.current) {
        wsRef.current.onclose = null; // prevent reconnect on intentional close
        wsRef.current.close();
      }
    };
  }, []);

  return { connected, typing, on };
}
