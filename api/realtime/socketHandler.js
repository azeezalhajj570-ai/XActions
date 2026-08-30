// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

// Payment routes archived - XActions is now 100% free and open-source
// All credit checks have been removed - unlimited operations for all users

const prisma = new PrismaClient();

// Store active sessions
const activeSessions = new Map(); // sessionId -> { agent, dashboard, user, status, operation, progress, account, config, createdAt }
const adminSockets = new Set(); // Admin sockets watching all sessions

// Pairing codes issued to dashboards, claimed by the extension agent.
// code -> { sessionId, userId, expiresAt }
const pendingSessions = new Map();
const PAIRING_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function generatePairingCode() {
  return randomBytes(4).toString('hex').toUpperCase(); // 8 chars, no ambiguous letters
}

export function initializeSocketIO(httpServer) {
  const io = new Server(httpServer, {
    cors: {
      // The MV3 extension (and dashboard) connects from a browser origin.
      // Extension origins are chrome-extension://<id> (Chrome/Brave) or
      // edge-extension://<id>, so allow any of those plus the known fronts.
      origin: (origin, cb) => {
        if (!origin) return cb(null, true); // non-browser clients (tests, CLI)
        if (/^(chrome|edge)-extension:\/\//.test(origin)) return cb(null, true);
        if (process.env.FRONTEND_URL) {
          const allowed = [process.env.FRONTEND_URL];
          return cb(null, allowed.includes(origin));
        }
        if (process.env.NODE_ENV === 'production') {
          return cb(null, ['https://xactions.app', 'https://xactions.azeez-tech.com'].includes(origin));
        }
        return cb(null, true); // dev
      },
      methods: ['GET', 'POST'],
      credentials: true
    }
  });

  // Middleware to authenticate socket connections
  io.use(async (socket, next) => {
    const token = socket.handshake.auth.token;
    const role = socket.handshake.auth.role; // 'agent', 'dashboard', or 'admin'

    if (!token && role !== 'agent') {
      return next(new Error('Authentication required'));
    }

    if (token) {
      let decoded;
      try {
        decoded = jwt.verify(token, process.env.JWT_SECRET);
      } catch (error) {
        // Distinguish an expired/malformed token from a server config problem.
        // A missing JWT_SECRET makes jwt.verify throw for every connection, so
        // it must not be masked as a client-side "Invalid token".
        const missingSecret = !process.env.JWT_SECRET;
        console.error(`❌ Socket auth: token rejected (${error.message})${missingSecret ? ' — JWT_SECRET is not set on the server' : ''}`);
        return next(new Error(missingSecret ? 'Server auth misconfigured' : 'Invalid token'));
      }

      let user;
      try {
        user = await prisma.user.findUnique({
          where: { id: decoded.userId }
        });
      } catch (error) {
        // The user lookup hits PostgreSQL; a DB outage must not be reported as
        // a bad token, or every dashboard/admin socket looks like a login bug.
        console.error(`❌ Socket auth: user lookup failed (${error.message})`);
        return next(new Error('Authentication service unavailable'));
      }

      if (!user) {
        return next(new Error('User not found'));
      }

      socket.user = user;
    }

    socket.role = role || 'dashboard';
    next();
  });

  io.on('connection', (socket) => {
    console.log(`🔌 Socket connected: ${socket.id} (${socket.role})`);

    // Handle different connection types
    if (socket.role === 'agent') {
      handleAgentConnection(io, socket);
    } else if (socket.role === 'dashboard') {
      handleDashboardConnection(io, socket);
    } else if (socket.role === 'admin') {
      handleAdminConnection(io, socket);
    }

    // ===== STREAM ROOMS =====
    // Clients can join/leave stream rooms to receive real-time events
    socket.on('stream:join', (streamId) => {
      socket.join(`stream:${streamId}`);
      socket.join('streams'); // global stream room
      console.log(`📡 Socket ${socket.id} joined stream room: ${streamId}`);
    });

    socket.on('stream:leave', (streamId) => {
      socket.leave(`stream:${streamId}`);
      console.log(`📡 Socket ${socket.id} left stream room: ${streamId}`);
    });

    // ===== JOB PROGRESS ROOMS =====
    // Subscribe to a specific job's lifecycle events (active, progress, completed, failed).
    // Usage: socket.emit('job:join', operationId)
    socket.on('job:join', (jobId) => {
      socket.join(`job:${jobId}`);
      console.log(`📡 Socket ${socket.id} joined job room: ${jobId}`);
    });

    socket.on('job:leave', (jobId) => {
      socket.leave(`job:${jobId}`);
    });

    // ===== GROUP AUTOMATION ROOMS =====
    // Dashboards join group:<groupId> to receive live group automation events.
    socket.on('group:join', (groupId) => {
      socket.join(`group:${groupId}`);
      console.log(`📡 Socket ${socket.id} joined group room: ${groupId}`);
    });

    socket.on('group:leave', (groupId) => {
      socket.leave(`group:${groupId}`);
    });

    socket.on('disconnect', () => {
      console.log(`🔌 Socket disconnected: ${socket.id}`);
      handleDisconnection(io, socket);
    });
  });

  // Wire up the streaming system with this Socket.IO instance
  initializeStreamIO(io);

  return io;
}

/**
 * Connect the real-time streaming engine to Socket.IO.
 * Lazy-loads src/streaming to avoid startup cost if not used.
 */
async function initializeStreamIO(io) {
  try {
    const { setIO } = await import('../../src/streaming/index.js');
    setIO(io);
    console.log('📡 Real-time stream engine connected to Socket.IO');
  } catch (err) {
    // Streaming module may not be available (e.g., missing Redis) — non-fatal
    console.warn('⚠️ Stream engine not loaded:', err.message);
  }
}

// ===== AGENT (X.com tab via extension, or legacy console script) =====
function handleAgentConnection(io, socket) {
  const auth = socket.handshake.auth || {};
  const sessionId = auth.sessionId;

  if (!sessionId && !auth.pairingCode) {
    socket.emit('error', { message: 'Session ID or pairing code required' });
    socket.disconnect();
    return;
  }

  let session;
  let boundSessionId = sessionId;

  if (!sessionId) {
    // Extension path. The agent authenticates with the pairing code the
    // dashboard issued: it is short-lived, single-use, and bound to a session,
    // so it doubles as the bearer credential for the socket handshake.
    const code = String(auth.pairingCode || '').trim().toUpperCase();
    const entry = pendingSessions.get(code);

    if (!entry || entry.expiresAt < Date.now()) {
      if (entry) pendingSessions.delete(code);
      socket.emit('error', { message: 'Invalid or expired pairing code' });
      socket.disconnect();
      return;
    }

    // The code may have been HTTP-claimed already (the extension's normal
    // first step). The socket connection is the final consumer: it consumes
    // the code and binds the session. A code that was never claimed also
    // works, so a socket-only pairing is possible.
    pendingSessions.delete(code);
    entry.claimed = true;

    boundSessionId = entry.sessionId;
    session = activeSessions.get(boundSessionId);
    if (!session) {
      socket.emit('error', { message: 'Session no longer active' });
      socket.disconnect();
      return;
    }

    // Reject agents that do not name the X account they are running as.
    const username = String(auth.username || '').trim().replace(/^@/, '');
    if (!username) {
      socket.emit('error', { message: 'X account username required' });
      socket.disconnect();
      return;
    }

    session.account = {
      username,
      displayName: auth.displayName || username,
      profileUrl: auth.profileUrl || '',
      avatar: auth.avatar || '',
    };
    session.claimedBy = 'extension';
    session.claimedAt = Date.now();
  } else if (auth.username && auth.agentType === 'extension') {
    // Extension reconnect: the session was claimed earlier; the agent binds
    // again with the sessionId + the same X account.
    session = activeSessions.get(sessionId);
    if (!session) {
      socket.emit('error', { message: 'Session not found' });
      socket.disconnect();
      return;
    }
    if (session.claimedBy !== 'extension') {
      socket.emit('error', { message: 'Session was not claimed by an extension agent' });
      socket.disconnect();
      return;
    }
    const username = String(auth.username || '').trim().replace(/^@/, '');
    if (session.account?.username && session.account.username !== username) {
      socket.emit('error', { message: 'X account does not match the claimed session' });
      socket.disconnect();
      return;
    }
  } else {
    // Legacy console-agent path: sessionId-only claim, unchanged.
    session = activeSessions.get(sessionId);
  }

  if (session) {
    // One live agent per session: a re-registered extension replaces a stale one.
    if (session.agent && session.agent !== socket) {
      try {
        session.agent.emit('agent:replaced');
      } catch { /* socket already gone */ }
      try {
        session.agent.disconnect();
      } catch { /* socket already gone */ }
    }

    session.agent = socket;
    session.status = 'connected';

    // Notify dashboard that agent connected
    if (session.dashboard) {
      session.dashboard.emit('agent:connected', {
        sessionId: boundSessionId,
        account: session.account,
      });
    }

    // Notify admins
    broadcastToAdmins(io, 'session:updated', getSessionInfo(boundSessionId));
  }

  // Extension reports that the X tab it was bound to closed while the socket
  // stayed up (the service worker keeps running).
  socket.on('agent:tab-closed', () => {
    const session = activeSessions.get(boundSessionId);
    if (session && session.agent === socket) {
      session.agent = null;
      session.status = 'agent_disconnected';

      if (session.dashboard) {
        session.dashboard.emit('agent:disconnected', { reason: 'tab_closed' });
      }

      broadcastToAdmins(io, 'session:updated', getSessionInfo(boundSessionId));
    }
  });

  // Agent reports progress
  socket.on('progress', (data) => {
    const session = activeSessions.get(boundSessionId);
    if (session) {
      session.progress = data;
      
      // Forward to dashboard
      if (session.dashboard) {
        session.dashboard.emit('progress', data);
      }
      
      // Forward to admins
      broadcastToAdmins(io, 'session:progress', {
        sessionId: boundSessionId,
        userId: session.user?.id,
        username: session.user?.username,
        ...data
      });
    }
  });

  // Agent reports action completed
  socket.on('action', (data) => {
    const session = activeSessions.get(boundSessionId);
    if (session) {
      // Forward to dashboard
      if (session.dashboard) {
        session.dashboard.emit('action', data);
      }
      
      // Forward to admins
      broadcastToAdmins(io, 'session:action', {
        sessionId: boundSessionId,
        userId: session.user?.id,
        username: session.user?.username,
        ...data
      });
    }
  });

  // Agent reports completion
  socket.on('complete', async (data) => {
    const session = activeSessions.get(boundSessionId);
    if (session) {
      session.status = 'completed';
      
      // Record operation (XActions is now free - no credit deduction)
      if (session.user && session.operation) {
        await prisma.operation.create({
          data: {
            userId: session.user.id,
            type: session.operation,
            status: 'completed',
            result: JSON.stringify(data)
          }
        });
      }
      
      // Notify dashboard
      if (session.dashboard) {
        session.dashboard.emit('complete', data);
      }
      
      // Notify admins
      broadcastToAdmins(io, 'session:complete', {
        sessionId: boundSessionId,
        userId: session.user?.id,
        username: session.user?.username,
        ...data
      });
    }
  });

  // Agent reports error
  socket.on('error', (data) => {
    const session = activeSessions.get(boundSessionId);
    if (session) {
      session.status = 'error';
      
      if (session.dashboard) {
        session.dashboard.emit('error', data);
      }
      
      broadcastToAdmins(io, 'session:error', {
        sessionId: boundSessionId,
        userId: session.user?.id,
        ...data
      });
    }
  });

  socket.emit('connected', { sessionId: boundSessionId, message: 'Agent connected to XActions' });
}

// ===== DASHBOARD (user's control panel) =====
function handleDashboardConnection(io, socket) {
  // Reuse the user's live session if one exists, so a page refresh does not
  // orphan the agent and force a re-pair: the new dashboard socket re-attaches
  // to the existing session (and its pairing code / connected agent).
  const existing = findLiveSessionForUser(socket.user.id);
  const existingSessionId = existing?.sessionId;
  const session = existing?.session;

  if (existing && existingSessionId && session) {
    // Re-attach: point the session at the new dashboard socket BEFORE the old
    // socket's disconnect fires, so handleDisconnection sees the session's
    // dashboard is already the new socket and does not tear the session down.
    const oldDashboard = session.dashboard;
    session.dashboard = socket;
    socket.sessionId = existingSessionId;
    if (oldDashboard && oldDashboard !== socket && oldDashboard.connected) {
      try { oldDashboard.disconnect(); } catch { /* already gone */ }
    }

    // The agent (if any) stays bound; surface current state to the dashboard.
    socket.emit('session:created', {
      sessionId: existingSessionId,
      pairingCode: findPairingCodeForSession(existingSessionId) || generatePairingCode(),
      hasAgent: !!session.agent,
    });

    // Re-notify with the current connection state.
    if (session.agent) {
      socket.emit('agent:connected', { sessionId: existingSessionId, account: session.account });
    } else {
      socket.emit('agent:disconnected');
    }

    broadcastToAdmins(io, 'session:updated', getSessionInfo(existingSessionId));
    attachDashboardListeners(io, socket, existingSessionId);
    return;
  }

  // No live session for this user — create a fresh one.
  const sessionId = `session_${socket.user.id}_${Date.now()}`;
  
  // Create session
  activeSessions.set(sessionId, {
    dashboard: socket,
    agent: null,
    user: socket.user,
    status: 'waiting', // waiting for agent to connect
    operation: null,
    progress: null,
    account: null,
    createdAt: new Date()
  });

  socket.sessionId = sessionId;

  // Issue a pairing code the extension can claim (replaces the old
  // console-paste agentScript mechanism).
  const pairingCode = generatePairingCode();
  pendingSessions.set(pairingCode, {
    sessionId,
    userId: socket.user.id,
    expiresAt: Date.now() + PAIRING_CODE_TTL_MS
  });

  // Send session ID and pairing code to dashboard
  socket.emit('session:created', {
    sessionId,
    pairingCode
  });

  // Notify admins of new session
  broadcastToAdmins(io, 'session:new', getSessionInfo(sessionId));

  attachDashboardListeners(io, socket, sessionId);
}

/** Find the user's live session (one with a connected dashboard or agent). */
function findLiveSessionForUser(userId) {
  for (const [sessionId, session] of activeSessions) {
    if (session.user?.id !== userId) continue;
    if (session.dashboard?.connected || session.agent?.connected) {
      return { sessionId, session };
    }
  }
  return null;
}

/** Find the pairing code currently pending for a session. */
function findPairingCodeForSession(sessionId) {
  for (const [code, entry] of pendingSessions) {
    if (entry.sessionId === sessionId) return code;
  }
  return null;
}

/** The dashboard -> server listeners shared by fresh and reused sessions. */
function attachDashboardListeners(io, socket, sessionId) {
  // Dashboard requests to start an operation
  socket.on('start:operation', async (data) => {
    const { operation, config } = data;
    const session = activeSessions.get(sessionId);
    
    if (!session) {
      socket.emit('error', { message: 'Session not found' });
      return;
    }

    // XActions is now 100% free - no credit checks required
    session.operation = operation;
    session.config = config;
    session.status = 'running';

    // Send command to agent
    if (session.agent) {
      session.agent.emit('execute', { operation, config });
      socket.emit('operation:started', { operation });
      
      broadcastToAdmins(io, 'session:started', {
        sessionId,
        userId: socket.user.id,
        username: socket.user.username,
        operation,
        config
      });
    } else {
      socket.emit('error', { 
        message: 'Agent not connected. Open the XActions extension on x.com and enter your pairing code.',
        agentDisconnected: true
      });
    }
  });

  // Dashboard requests to stop operation
  socket.on('stop:operation', () => {
    const session = activeSessions.get(sessionId);
    if (session?.agent) {
      session.agent.emit('stop');
      session.status = 'stopped';
    }
  });
}

// ===== ADMIN (monitoring all sessions) =====
function handleAdminConnection(io, socket) {
  // Verify admin status
  if (!socket.user?.isAdmin) {
    socket.emit('error', { message: 'Admin access required' });
    socket.disconnect();
    return;
  }

  adminSockets.add(socket);
  
  // Send current active sessions
  const sessions = Array.from(activeSessions.entries()).map(([id, session]) => ({
    sessionId: id,
    userId: session.user?.id,
    username: session.user?.username,
    status: session.status,
    operation: session.operation,
    progress: session.progress,
    createdAt: session.createdAt,
    hasAgent: !!session.agent,
    hasDashboard: !!session.dashboard
  }));

  socket.emit('sessions:list', sessions);
}

// ===== HELPERS =====
function handleDisconnection(io, socket) {
  // Remove from admin sockets
  adminSockets.delete(socket);

  // Handle agent disconnection
  for (const [sessionId, session] of activeSessions) {
    if (session.agent === socket) {
      session.agent = null;
      session.status = 'agent_disconnected';
      
      if (session.dashboard) {
        session.dashboard.emit('agent:disconnected');
      }
      
      broadcastToAdmins(io, 'session:updated', getSessionInfo(sessionId));
    }
    
    if (session.dashboard === socket) {
      session.dashboard = null;

      // The dashboard that created this session is gone. Tell the agent its
      // session is ending so the extension clears the stale pairing and shows
      // the re-pair prompt instead of holding a dead session.
      if (session.agent) {
        try {
          session.agent.emit('session:ended');
        } catch { /* agent socket already gone */ }
        session.agent = null;
        session.status = 'agent_disconnected';
        broadcastToAdmins(io, 'session:updated', getSessionInfo(sessionId));
      }

      // If both disconnected, clean up session after a delay
      if (!session.agent) {
        setTimeout(() => {
          if (!activeSessions.get(sessionId)?.dashboard && !activeSessions.get(sessionId)?.agent) {
            activeSessions.delete(sessionId);
            broadcastToAdmins(io, 'session:removed', { sessionId });
          }
        }, 30000); // Clean up after 30 seconds
      }
    }
  }
}

function broadcastToAdmins(io, event, data) {
  for (const socket of adminSockets) {
    socket.emit(event, data);
  }
}

function getSessionInfo(sessionId) {
  const session = activeSessions.get(sessionId);
  if (!session) return null;
  
  return {
    sessionId,
    userId: session.user?.id,
    username: session.user?.username,
    status: session.status,
    operation: session.operation,
    progress: session.progress,
    account: session.account,
    createdAt: session.createdAt,
    hasAgent: !!session.agent,
    hasDashboard: !!session.dashboard
  };
}

export { activeSessions, adminSockets, pendingSessions };
