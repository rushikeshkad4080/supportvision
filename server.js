const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const jwt = require('jsonwebtoken');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = 5000;
const JWT_SECRET = 'sv-hackathon-quantum-secret-2026';

app.use(cors());
app.use(express.json());

// --- IN-MEMORY AGENT DATA MATRIX ---
const users = [
  { id: 'usr_admin', email: 'admin@supportvision.com', password: 'password123', name: 'Sarah Jenkins (Director)', role: 'ADMIN' },
  { id: 'usr_agent', email: 'agent@supportvision.com', password: 'password123', name: 'Alex Mercer (Tier 2 Tech)', role: 'AGENT' }
];
const sessions = new Map(); 
const chatHistories = new Map();
const disconnectTimers = new Map();

// --- SECURITY PROTOCOL MIDDLEWARE ---
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access token validation failed' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Token expired or corrupted signature' });
    req.user = user;
    next();
  });
}

// --- SECURE AUTHENTICATION ENDPOINT ---
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  const user = users.find(u => u.email === email && u.password === password);
  if (!user) return res.status(401).json({ error: 'Invalid terminal credentials' });
  
  const token = jwt.sign({ id: user.id, role: user.role, name: user.name }, JWT_SECRET, { expiresIn: '2h' });
  res.json({ token, user: { id: user.id, role: user.role, name: user.name } });
});

// --- SESSION PROVISIONING PIPELINES ---
app.post('/api/sessions', authenticateToken, (req, res) => {
  const sessionId = 'SV-' + Math.floor(100000 + Math.random() * 900000);
  const inviteToken = 'AUTH-' + Math.random().toString(36).substring(2, 12).toUpperCase();
  
  const newSession = {
    id: sessionId,
    inviteToken,
    status: 'WAITING',
    agentId: req.user.id,
    agentName: req.user.name,
    createdAt: new Date().toISOString(),
    duration: 0
  };
  
  sessions.set(sessionId, newSession);
  chatHistories.set(sessionId, []);
  res.status(201).json(newSession);
});

app.get('/api/sessions', (req, res) => {
  res.json(Array.from(sessions.values()));
});

app.post('/api/sessions/:id/end', (req, res) => {
  const session = sessions.get(req.params.id);
  if (session) {
    session.status = 'ENDED';
    session.duration = Math.floor((new Date() - new Date(session.createdAt)) / 1000);
    io.to(req.params.id).emit('session-ended');
  }
  res.json({ success: true });
});

app.get('/api/admin/metrics', (req, res) => {
  const list = Array.from(sessions.values());
  res.json({
    activeSessions: list.filter(s => s.status === 'ACTIVE').length,
    connectedParticipants: io.sockets.sockets.size,
    totalCalls: list.length,
    bandwidthUsage: (list.filter(s => s.status === 'ACTIVE').length * 1.4 + 0.2).toFixed(1) + ' Mbps',
    systemLoad: '12.4%'
  });
});

// --- WEBRTC SIGNALING & CHAT CORE ROUTER ---
io.on('connection', (socket) => {
  let activeRoom = null;
  let activeRole = null;

  socket.on('join-session', ({ sessionId, role, name }) => {
    activeRoom = sessionId;
    activeRole = role;
    
    const session = sessions.get(sessionId);
    if (session) {
      const timerKey = `${sessionId}_${role}`;
      if (disconnectTimers.has(timerKey)) {
        clearTimeout(disconnectTimers.get(timerKey));
        disconnectTimers.delete(timerKey);
      } else {
        session.status = 'ACTIVE';
      }
    }
    
    socket.join(sessionId);
    io.to(sessionId).emit('user-joined', { socketId: socket.id, role, name });
  });

  socket.on('send-message', ({ text, senderName, senderRole }) => {
    if (!activeRoom) return;
    const msg = { id: 'msg_' + Date.now(), text, senderName, senderRole, createdAt: new Date().toISOString() };
    const history = chatHistories.get(activeRoom) || [];
    history.push(msg);
    io.to(activeRoom).emit('message-received', msg);
  });

  socket.on('signal', (data) => {
    if (activeRoom) socket.to(activeRoom).emit('signal', data);
  });

  socket.on('disconnect', () => {
    if (!activeRoom || !activeRole) return;
    const timerKey = `${activeRoom}_${activeRole}`;
    
    // Explicit 60-Second Reconnection Grace Window rule integration
    const timeout = setTimeout(() => {
      disconnectTimers.delete(timerKey);
      io.to(activeRoom).emit('user-left', { role: activeRole });
      const session = sessions.get(activeRoom);
      if (session) {
        session.status = 'ENDED';
      }
    }, 60000); 
    disconnectTimers.set(timerKey, timeout);
  });
});

server.listen(PORT, () => console.log(`🚀 System Core Gateway executing on port ${PORT}`));