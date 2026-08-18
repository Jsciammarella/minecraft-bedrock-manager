import { createContext, useContext, useEffect, useState, useRef, useCallback } from 'react';
import { io } from 'socket.io-client';

const SocketContext = createContext(null);
const MAX_CONSOLE_LINES = 200;
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]|\u009b[\d;]*[A-Za-z]|\[(?:\d{1,3}(?:;\d{1,3})*)?m/g;

function stripAnsi(text) {
  return String(text || '').replace(ANSI_RE, '').replace(/\r/g, '');
}

export function SocketProvider({ children }) {
  const socketRef = useRef(null);
  const activeServerRef = useRef(null);
  const [connected, setConnected] = useState(false);
  // Store output as arrays of lines per server for proper rendering
  const [serverOutputs, setServerOutputs] = useState({});

  useEffect(() => {
    const socket = io({
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: 10,
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      setConnected(true);
      if (activeServerRef.current != null) {
        socket.emit('join-server', activeServerRef.current);
      }
    });

    socket.on('disconnect', () => {
      setConnected(false);
    });

    socket.on('server-status', (data) => {
      // Trigger a refresh in parent components via custom event
      window.dispatchEvent(new CustomEvent('server-status-change', { detail: data }));
    });

    socket.on('server-output', (data) => {
      // Keep only the latest lines so every server console stays bounded
      setServerOutputs(prev => {
        const existing = prev[data.serverId] || [];
        const newLines = stripAnsi(data.data).split('\n').filter(line => line.trim().length > 0);
        return {
          ...prev,
          [data.serverId]: [...existing, ...newLines].slice(-MAX_CONSOLE_LINES),
        };
      });
    });

    socket.on('server-updated', (data) => {
      // Notify about auto-update events
      window.dispatchEvent(new CustomEvent('server-auto-updated', { detail: data }));
      // Also trigger a general status change to refresh data
      window.dispatchEvent(new CustomEvent('server-status-change', { detail: data }));
    });

    return () => {
      socket.close();
    };
  }, []);

  // Expose the latest output line per server for the component that needs it
  // This is a compatibility layer - the actual outputs are stored in serverOutputs
  const serverOutput = {};
  Object.entries(serverOutputs).forEach(([serverId, lines]) => {
    // The last line is what components poll for
    serverOutput[serverId] = lines[lines.length - 1] || '';
  });

  const sendCommand = useCallback((serverId, command) => {
    if (socketRef.current) {
      socketRef.current.emit('send-command', { serverId, command });
    }
  }, []);

  const startServer = useCallback((serverId) => {
    if (socketRef.current) {
      socketRef.current.emit('start-server', serverId);
    }
  }, []);

  const stopServer = useCallback((serverId) => {
    if (socketRef.current) {
      socketRef.current.emit('stop-server', serverId);
    }
  }, []);

  const joinServer = useCallback((serverId) => {
    if (socketRef.current) {
      if (activeServerRef.current != null && String(activeServerRef.current) !== String(serverId)) {
        socketRef.current.emit('leave-server', activeServerRef.current);
      }
      activeServerRef.current = serverId;
      socketRef.current.emit('join-server', serverId);
    }
  }, []);

  const addServerOutput = useCallback((serverId, line) => {
    setServerOutputs(prev => {
      const key = String(serverId);
      const existing = prev[key] || [];
      return {
        ...prev,
        [key]: [...existing, line].slice(-MAX_CONSOLE_LINES),
      };
    });
  }, []);

  // Clear output for a specific server (useful when switching servers)
  const clearOutput = useCallback((serverId) => {
    setServerOutputs(prev => ({
      ...prev,
      [serverId]: [],
    }));
  }, []);

  return (
    <SocketContext.Provider value={{
      socket: socketRef.current,
      connected,
      serverOutput,
      serverOutputs,
      sendCommand,
      startServer,
      stopServer,
      joinServer,
      addServerOutput,
      clearOutput,
    }}>
      {children}
    </SocketContext.Provider>
  );
}

export function useSocket() {
  const context = useContext(SocketContext);
  if (!context) throw new Error('useSocket must be used within SocketProvider');
  return context;
}
